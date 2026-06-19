/**
 * Standalone HTTP + WebSocket server. Serves the webview assets and a `/ws`
 * endpoint that pairs each browser tab with a `Bridge` + `registerMessageHandlers`.
 *
 * One server per process. The CLI (`cli.ts`) owns lifecycle and port binding.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { WebSocketServer } from "ws";

import { gitClientFactory } from "@/backend/gitClient";
import type { Config, StandaloneOptions } from "@/standalone/config";
import { createBridge } from "@/standalone/bridge";
import { renderDiffHtml } from "@/standalone/diffView";
import { registerMessageHandlers } from "@/standalone/messageHandler";
import { createRepoManager } from "@/standalone/repoManager";
import { StandaloneState } from "@/standalone/state";
import { buildWebviewHtml } from "@/standalone/webviewHtml";
import { initL10n } from "@/standalone/l10n";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function parseQuery(url: string): Record<string, string> {
  const q = url.split("?")[1];
  if (!q) return {};
  const out: Record<string, string> = {};
  for (const pair of q.split("&")) {
    const [k, v] = pair.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return out;
}

export type Server = {
  url: string;
  port: number;
  close: () => void;
};

/** Probe ports starting from `start` until one is free, up to `maxAttempts`. */
function findAvailablePort(start: number, host: string, maxAttempts = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p: number) => {
      const probe = http.createServer();
      probe.once("error", () => {
        if (++attempt < maxAttempts) {
          tryPort(p + 1);
        } else {
          reject(new Error(`No available port in range ${start}–${start + maxAttempts - 1}`));
        }
      });
      probe.listen(p, host, () => probe.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

export async function startServer(
  config: Config,
  options: StandaloneOptions,
  assetRoot: string
): Promise<Server> {
  const state = new StandaloneState(
    options.stateFile ||
      path.join(process.env.HOME ?? process.cwd(), ".gitgraph", "state.json")
  );
  initL10n(path.join(assetRoot, "l10n"));
  const repoManager = createRepoManager(state, config, {
    repoArgs: options.repo,
    cwd: process.cwd()
  });

  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    try {
      // /diff?repo=...&commit=...&old=...&new=...&type=...
      if (url === "/" || url === "/index.html") {
        const { html } = buildWebviewHtml({
          config,
          state,
          repoManager,
          theme: options.theme
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (url.startsWith("/diff")) {
        const q = parseQuery(url);
        const gitClient = gitClientFactory(q.repo, config.gitPath());
        const html = await renderDiffHtml(gitClient, {
          repo: q.repo,
          commit: q.commit,
          oldFilePath: q.old,
          newFilePath: q.new,
          type: q.type
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      // Static assets: /media/* → media/, /shim.js → out/shim.js, /web.min.js → out/web.min.js
      let filePath: string | null = null;
      if (url === "/shim.js") {
        filePath = path.join(assetRoot, "out", "shim.js");
      } else if (url === "/web.min.js") {
        filePath = path.join(assetRoot, "out", "web.min.js");
      } else if (url.startsWith("/media/")) {
        filePath = path.join(assetRoot, "media", url.slice("/media/".length));
      }
      if (filePath && fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      res.writeHead(500);
      res.end(e instanceof Error ? e.message : String(e));
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const handlers: Array<ReturnType<typeof registerMessageHandlers>> = [];

  wss.on("connection", (ws) => {
    const gitClient = gitClientFactory(state.getLastActiveRepo() ?? "", config.gitPath());
    const bridge = createBridge(ws);
    const h = registerMessageHandlers(bridge, { config, gitClient, repoManager, state });
    handlers.push(h);
    ws.on("close", () => h.dispose());
  });

  const port = await findAvailablePort(options.port, options.host);

  return new Promise<Server>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, options.host, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://${options.host}:${actualPort}`,
        port: actualPort,
        close: () => {
          for (const h of handlers) h.dispose();
          wss.close();
          httpServer.close();
        }
      });
    });
  });
}
