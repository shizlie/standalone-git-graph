/**
 * Browser shim injected into the webview HTML before `web.min.js` loads.
 *
 * Replaces the single VS Code API the webview uses:
 *   - `acquireVsCodeApi().postMessage(msg)` → send `msg` over a WebSocket.
 *   - `acquireVsCodeApi().getState/setState` → persist webview state in
 *     `localStorage` under `gitgraph.webviewState`.
 *
 * Inbound WebSocket messages are re-dispatched via `window.postMessage` so the
 * webview's existing `window.addEventListener("message", …)` listener fires
 * unchanged. The webview source (`src/webview/*`) is compiled untouched.
 *
 * `/?repo=<path>` (opened by `gitgraph <repo>`) drops the saved view state when
 * it belongs to another repo, so the server's choice of repo wins, then strips
 * the parameter from the address bar.
 *
 * When the tab becomes visible again it asks the webview for a soft refresh —
 * this picks up working-tree edits, which the server's `.git` watcher can't see,
 * without any polling. It also tells the server whether the tab is visible:
 * only the repo in a visible tab gets the frequent "on screen" auto-sync.
 *
 * Two commands are intercepted client-side and never forwarded to the server,
 * because only the browser can fulfil them:
 *   - `copyToClipboard` → `navigator.clipboard.writeText`
 *   - `viewDiff` → open `/diff?…` in a new tab
 */
declare global {
  function acquireVsCodeApi(): VsCodeApiShim;
}

type VsCodeApiShim = {
  getState: () => WebViewStateish | null;
  postMessage: (msg: unknown) => void;
  setState: (state: WebViewStateish) => WebViewStateish;
};

type WebViewStateish = Record<string, unknown>;

type RequestLike = {
  command: string;
  [k: string]: unknown;
};

function isRequestLike(msg: unknown): msg is RequestLike {
  return typeof msg === "object" && msg !== null && "command" in msg;
}

const STATE_KEY = "gitgraph.webviewState";

const requestedRepo = new URLSearchParams(window.location.search).get("repo");
if (requestedRepo !== null) {
  window.history.replaceState(null, "", window.location.pathname);
}

function acquireVsCodeApi(): VsCodeApiShim {
  return {
    getState(): WebViewStateish | null {
      try {
        const raw = localStorage.getItem(STATE_KEY);
        const state = raw ? (JSON.parse(raw) as WebViewStateish) : null;
        if (state && requestedRepo !== null && state.currentRepo !== requestedRepo) return null;
        return state;
      } catch {
        return null;
      }
    },
    postMessage(msg: unknown) {
      GitGraphBridge.send(msg);
    },
    setState(state: WebViewStateish) {
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
      } catch {
        /* quota / private mode — non-fatal */
      }
      return state;
    }
  };
}

// Expose globally before web.min.js runs.
window.acquireVsCodeApi = acquireVsCodeApi;

/** Dispatch a response back into the webview's own message listener. */
function dispatch(msg: unknown) {
  window.postMessage(msg, "*");
}

const GitGraphBridge = (() => {
  let ws: WebSocket | null = null;
  const queue: unknown[] = [];
  const listeners: Array<(msg: unknown) => void> = [];

  function flush() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queue.length > 0) {
      ws.send(JSON.stringify(queue.shift()));
    }
  }

  function connect() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.addEventListener("open", () => {
      // Each (re)connection gets a fresh server-side handler; tell it our visibility first.
      queue.unshift(visibilityMessage());
      flush();
    });
    ws.addEventListener("message", (event) => {
      let msg: unknown;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      // Re-dispatch so the webview's window "message" listener receives it.
      dispatch(msg);
      for (const l of listeners) l(msg);
    });
    ws.addEventListener("close", () => {
      ws = null;
      // Reconnect after a short delay so a server restart doesn't kill the tab.
      setTimeout(connect, 1500);
    });
  }

  return {
    send(msg: unknown) {
      if (isRequestLike(msg) && msg.command === "copyToClipboard") {
        const data = String(msg.data);
        navigator.clipboard
          .writeText(data)
          .then(() => dispatch({ command: "copyToClipboard", type: msg.type, success: true }))
          .catch(() => dispatch({ command: "copyToClipboard", type: msg.type, success: false }));
        return;
      }
      if (isRequestLike(msg) && msg.command === "viewDiff") {
        const url =
          `/diff?repo=${encodeURIComponent(String(msg.repo))}` +
          `&commit=${encodeURIComponent(String(msg.commitHash))}` +
          `&old=${encodeURIComponent(String(msg.oldFilePath))}` +
          `&new=${encodeURIComponent(String(msg.newFilePath))}` +
          `&type=${encodeURIComponent(String(msg.type))}`;
        window.open(url, "_blank");
        dispatch({ command: "viewDiff", success: true });
        return;
      }
      queue.push(msg);
      if (ws && ws.readyState === WebSocket.OPEN) flush();
    },
    connect,
    onMessage(l: (msg: unknown) => void) {
      listeners.push(l);
    }
  };
})();

GitGraphBridge.connect();

function visibilityMessage() {
  return { command: "tabVisibility", visible: document.visibilityState === "visible" };
}

document.addEventListener("visibilitychange", () => {
  GitGraphBridge.send(visibilityMessage());
  if (document.visibilityState === "visible") dispatch({ command: "refresh" });
});
