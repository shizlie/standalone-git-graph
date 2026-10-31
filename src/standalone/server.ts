/**
 * Standalone HTTP + WebSocket server. Serves the webview assets and a `/ws`
 * endpoint that pairs each browser tab with a `Bridge` + `registerMessageHandlers`.
 *
 * Shared across tabs: one repo list, one `.git` watcher per open repo, one
 * background sync loop. Small JSON API for the CLI:
 *   GET  /api/health  → { app: "gitgraph", pid }
 *   POST /api/open    → add roots/repos to a running server (needs `X-Gitgraph: 1`,
 *                       which browsers can't send cross-origin without a preflight)
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { WebSocketServer } from "ws";

import { gitClientFactory } from "@/backend/gitClient";
import { createAutoSync } from "@/standalone/autoSync";
import type { Config, StandaloneOptions } from "@/standalone/config";
import { createBridge } from "@/standalone/bridge";
import { renderDiffHtml } from "@/standalone/diffView";
import { registerMessageHandlers } from "@/standalone/messageHandler";
import { createRepoManager } from "@/standalone/repoManager";
import { createRepoWatchHub } from "@/standalone/repoWatcher";
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

export type ServerHooks = {
  log?: (line: string) => void;
};

/** Listen on `port`, moving up one at a time while it's taken. Port 0 = any free port. */
async function listenWithFallback(
  server: http.Server,
  port: number,
  host: string,
  maxAttempts = 50
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const p = port === 0 ? 0 : port + attempt;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one at a time on purpose
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : p;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (port === 0 || code !== "EADDRINUSE" || attempt + 1 >= maxAttempts) throw e;
    }
  }
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export async function startServer(
  config: Config,
  options: StandaloneOptions,
  assetRoot: string,
  hooks: ServerHooks = {}
): Promise<Server> {
  const log = hooks.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  // Background reads (status, rev-list) must never take the index lock or
  // rewrite .git/index — that would race the user's commands and wake our watcher.
  process.env.GIT_OPTIONAL_LOCKS = "0";

  const state = new StandaloneState(
    options.stateFile || path.join(process.env.HOME ?? process.cwd(), ".gitgraph", "state.json")
  );
  initL10n(path.join(assetRoot, "l10n"));
  const repoManager = await createRepoManager(state, {
    roots: options.roots,
    repos: options.repo,
    scan: { maxDepth: config.maxDepthOfRepoSearch(), exclude: options.exclude },
    gitPath: config.gitPath(),
    rescanMs: 60_000
  });
  const watchHub = createRepoWatchHub(config.gitPath());
  const autoSync = createAutoSync({
    getRepos: repoManager.getRepoPaths,
    gitPath: config.gitPath(),
    getIntervalMs: () => state.getSyncSettings().othersMin * 60_000,
    push: options.autoPush,
    log
  });
  state.onSyncSettings(() => autoSync.reschedule());

  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    try {
      if (pathname === "/api/health") {
        sendJson(res, 200, {
          app: "gitgraph",
          pid: process.pid,
          rss: process.memoryUsage().rss,
          repos: repoManager.getRepoPaths().length,
          uptimeSec: Math.round(process.uptime()),
          sync: state.getSyncSettings()
        });
        return;
      }
      if (pathname === "/api/open" && req.method === "POST") {
        if (req.headers["x-gitgraph"] !== "1") {
          sendJson(res, 403, { error: "forbidden" });
          return;
        }
        const spec = JSON.parse(await readBody(req)) as { roots?: string[]; repos?: string[] };
        await repoManager.add({ roots: spec.roots, repos: spec.repos });
        sendJson(res, 200, { ok: true, repos: repoManager.getRepoPaths().length });
        return;
      }
      if (pathname === "/" || pathname === "/index.html") {
        // `/?repo=<path>` opens the graph on that repo (used by `gitgraph <repo>`).
        const wanted = parseQuery(url).repo;
        if (wanted && repoManager.getRepos()[wanted]) state.setLastActiveRepo(wanted);
        const { html } = buildWebviewHtml({
          config,
          state,
          repoManager,
          theme: options.theme
        });
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(html);
        return;
      }
      if (pathname === "/diff") {
        const q = parseQuery(url);
        if (!repoManager.getRepos()[q.repo]) {
          res.writeHead(404);
          res.end("unknown repo");
          return;
        }
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
      if (pathname === "/shim.js") {
        filePath = path.join(assetRoot, "out", "shim.js");
      } else if (pathname === "/web.min.js") {
        filePath = path.join(assetRoot, "out", "web.min.js");
      } else if (pathname.startsWith("/media/")) {
        const mediaRoot = path.join(assetRoot, "media");
        const candidate = path.join(mediaRoot, pathname.slice("/media/".length));
        if (candidate.startsWith(mediaRoot + path.sep)) filePath = candidate;
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

  // Bind first: a WebSocketServer attached earlier would re-emit EADDRINUSE as an unhandled error.
  const port = await listenWithFallback(httpServer, options.port, options.host);

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    // Only our own page may drive git: reject WebSocket connections opened by other sites.
    verifyClient: ({ origin, req }: { origin: string; req: http.IncomingMessage }) =>
      !origin || origin === `http://${req.headers.host}`
  });
  wss.on("error", (e) => log(`websocket error: ${e.message}`));
  const handlers = new Set<ReturnType<typeof registerMessageHandlers>>();

  wss.on("connection", (ws) => {
    // The persisted active repo may have been deleted; loadRepos selects a valid repo before queries.
    const gitClient = gitClientFactory(process.cwd(), config.gitPath());
    const bridge = createBridge(ws);
    const h = registerMessageHandlers(bridge, {
      config,
      gitClient,
      repoManager,
      state,
      watchHub,
      autoSync
    });
    handlers.add(h);
    ws.on("close", () => {
      h.dispose();
      handlers.delete(h);
    });
  });

  return {
    url: `http://${options.host}:${port}`,
    port,
    close: () => {
      autoSync.stop();
      for (const h of handlers) h.dispose();
      watchHub.closeAll();
      repoManager.dispose();
      for (const c of wss.clients) c.terminate();
      wss.close();
      httpServer.close();
    }
  };
}
