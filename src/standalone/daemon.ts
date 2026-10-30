/**
 * Background-process bookkeeping for `gitgraph`.
 *
 * The CLI spawns itself detached (own session, stdio → log file) and exits; the
 * child writes `~/.gitgraph/daemon.json` once it's listening. Nothing is
 * registered with launchd/systemd, so the server does not come back after a
 * reboot until you run `gitgraph` again.
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import type { StandaloneOptions } from "@/standalone/config";

export type DaemonInfo = {
  pid: number;
  url: string;
  port: number;
  startedAt: number;
  options: StandaloneOptions;
};

export type Health = {
  app: string;
  pid: number;
  rss?: number;
  repos?: number;
  uptimeSec?: number;
};

const HEAP_LIMIT_MB = 256;
const MAX_LOG_BYTES = 1024 * 1024;

export function gitgraphHome(): string {
  return process.env.GITGRAPH_HOME || path.join(process.env.HOME ?? process.cwd(), ".gitgraph");
}
export const daemonFile = () => path.join(gitgraphHome(), "daemon.json");
export const logFile = () => path.join(gitgraphHome(), "gitgraph.log");

export function readDaemonFile(): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(daemonFile(), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function writeDaemonFile(info: DaemonInfo): void {
  fs.mkdirSync(gitgraphHome(), { recursive: true });
  const tmp = `${daemonFile()}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  fs.renameSync(tmp, daemonFile());
}

/** Remove the daemon file, but only if it still describes `pid`. */
export function removeDaemonFile(pid: number): void {
  const info = readDaemonFile();
  if (info && info.pid === pid) fs.rmSync(daemonFile(), { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function request(
  url: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      url,
      {
        method: opts.method ?? "GET",
        timeout: opts.timeoutMs ?? 1500,
        headers: body
          ? {
              "Content-Type": "application/json",
              "X-Gitgraph": "1",
              "Content-Length": Buffer.byteLength(body)
            }
          : {}
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: null });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** The running server described by daemon.json, verified alive; cleans up a stale file. */
export async function findRunning(): Promise<{ info: DaemonInfo; health: Health } | null> {
  const info = readDaemonFile();
  if (!info) return null;
  if (isAlive(info.pid)) {
    try {
      const { json } = await request(`${info.url}/api/health`);
      const health = json as Health | null;
      if (health?.app === "gitgraph" && health.pid === info.pid) return { info, health };
    } catch {
      /* not answering — treat as stale */
    }
  }
  fs.rmSync(daemonFile(), { force: true });
  return null;
}

function rotateLog(): void {
  try {
    if (fs.statSync(logFile()).size > MAX_LOG_BYTES) fs.renameSync(logFile(), `${logFile()}.1`);
  } catch {
    /* no log yet */
  }
}

/**
 * Start the server as a detached background process and wait until it's
 * listening. Options travel via env so paths/flags don't need re-quoting.
 */
export async function spawnDaemon(
  cliPath: string,
  options: StandaloneOptions
): Promise<DaemonInfo> {
  fs.mkdirSync(gitgraphHome(), { recursive: true });
  rotateLog();
  const out = fs.openSync(logFile(), "a");
  const child = child_process.spawn(
    process.execPath,
    [`--max-old-space-size=${HEAP_LIMIT_MB}`, cliPath, "--daemon-child"],
    {
      detached: true,
      stdio: ["ignore", out, out],
      cwd: gitgraphHome(),
      env: { ...process.env, GITGRAPH_OPTIONS: JSON.stringify(options) }
    }
  );
  fs.closeSync(out);
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? 1));
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to start background process");

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const info = readDaemonFile();
    if (info && info.pid === pid) {
      child.unref();
      return info;
    }
    if (exited !== null) break;
    // oxlint-disable-next-line no-await-in-loop -- one at a time on purpose
    await new Promise((r) => setTimeout(r, 100));
  }
  child.unref();
  throw new Error(
    exited !== null
      ? `background server exited (code ${exited}); see ${logFile()}`
      : `background server did not start in time; see ${logFile()}`
  );
}

export async function stopDaemon(info: DaemonInfo): Promise<void> {
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 3000;
  while (isAlive(info.pid) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time on purpose
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  removeDaemonFile(info.pid);
}

export function tailLog(lines: number): string {
  try {
    const all = fs.readFileSync(logFile(), "utf8").split("\n");
    return all.slice(-lines - 1).join("\n");
  } catch {
    return "";
  }
}
