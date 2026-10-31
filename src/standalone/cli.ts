#!/usr/bin/env node
/**
 * gitgraph — standalone (neo) Git Graph.
 *
 *   gitgraph [path...]      start in the background (or reuse the running one), open the browser
 *   gitgraph stop           stop the background server
 *   gitgraph restart        restart it with the same folders/options
 *   gitgraph status         is it running? URL, memory, repo count
 *   gitgraph logs           recent sync activity / errors
 *
 * A path that is a repo (or worktree) is shown as-is; any other folder is
 * scanned for repos (`gitgraph ~/Codes`). No path = current directory.
 * `--foreground` runs in this terminal instead (Ctrl-C to stop).
 *
 * Scripted use (Orca etc.):
 *   gitgraph --repo /path/to/worktree --no-open --print-url
 * prints only `http://127.0.0.1:PORT` on stdout, then returns; the server keeps running.
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { createConfig, defaultOptions, type StandaloneOptions } from "@/standalone/config";
import {
  findRunning,
  logFile,
  removeDaemonFile,
  request,
  spawnDaemon,
  stopDaemon,
  tailLog,
  writeDaemonFile,
  type Health
} from "@/standalone/daemon";
import { scanForRepos } from "@/standalone/repoManager";
import { startServer } from "@/standalone/server";

const COMMANDS = ["start", "stop", "restart", "status", "logs"] as const;
type Command = (typeof COMMANDS)[number];

const HELP = `gitgraph — standalone (neo) Git Graph

USAGE
  gitgraph [path...] [OPTIONS]   Start in the background and open the browser.
                                 A repo path shows that repo; any other folder is
                                 scanned for repos. Default: current directory.
                                 If already running, adds the path and opens it.
  gitgraph stop                  Stop the background server
  gitgraph restart               Restart with the same folders and options
  gitgraph status                Show URL, memory use and repo count
  gitgraph logs [-n <lines>]     Show recent sync activity and errors

OPTIONS
  --repo <path>           Add a single repo (repeatable)
  --exclude <name>        Folder name (or root-relative path) to skip while
                          scanning; repeatable. Replaces the default list:
                          workspace, workspaces, worktrees, node_modules
  --max-depth <n>         How deep to scan folders for repos (default 3)
  --no-auto-push          Background sync only pulls; never pushes
  --port <n>              Port (default 1234; moves up if taken; 0 = any)
  --host <addr>           Bind address (default 127.0.0.1)
  --foreground, -f        Run in this terminal instead of the background
  --no-open               Don't open a browser tab
  --print-url             Print only the URL on stdout (for scripts)
  --theme dark|light      UI theme (default dark)
  --git-path <path>       git binary (default git)
  --state-file <path>     Persisted UI state (default ~/.gitgraph/state.json)
  --date-format <fmt>     Date & Time | Date Only | Relative
  --date-type <t>         Author Date | Commit Date
  --graph-style <s>       rounded | angular
  --graph-colours <csv>   Comma-separated hex colours
  --initial-load <n>      Commits to load on open (default 300)
  --load-more <n>         Commits per load-more (default 100)
  --show-current-branch   Show only current branch on open
  --show-uncommitted      Show uncommitted changes node (default on)
  --fetch-avatars         Fetch avatars from GitHub/GitLab/Gravatar
  --help                  Show this help

AUTO SYNC
  Every few minutes each repo is fetched, then its default branch (main) is
  kept level with origin/main: fast-forwarded when behind (only if that
  worktree has no uncommitted changes and no merge/rebase in progress),
  pushed when only ahead. Diverged branches are never touched — the UI shows
  a warning instead. The Sync button does the same now, plus the current branch.
`;

function openBrowser(url: string): void {
  // VS Code / Cursor / Windsurf integrated terminal: open in Simple Browser
  if (process.env.TERM_PROGRAM === "vscode" || process.env.VSCODE_IPC_HOOK_CLI) {
    try {
      child_process.spawn("code", ["--open-url", url], { detached: true, stdio: "ignore" }).unref();
      return;
    } catch {
      /* fall through to system browser */
    }
  }
  // Orca: open in integrated browser panel
  if (process.env.ORCA_WORKSPACE !== undefined) {
    try {
      child_process.spawn("orca", ["open", url], { detached: true, stdio: "ignore" }).unref();
      return;
    } catch {
      /* fall through to system browser */
    }
  }
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    child_process.spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* non-fatal — user can open the URL manually */
  }
}

function describeSync(s: Health["sync"]): string {
  if (!s) return "?";
  const focused =
    s.focusedSec <= 0
      ? "off"
      : s.focusedSec % 60 === 0
        ? `every ${s.focusedSec / 60} min`
        : `every ${s.focusedSec} s`;
  const others = s.othersMin <= 0 ? "off" : `every ${s.othersMin} min`;
  return `repo on screen ${focused}, other repos ${others} (change in the UI)`;
}

function parseColourList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type Parsed = {
  command: Command;
  options: StandaloneOptions;
  paths: string[];
  foreground: boolean;
  daemonChild: boolean;
  logLines: number;
  /** Flags that only take effect when a server starts (ignored if one is running). */
  serverFlagsGiven: boolean;
};

function parseCli(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      "no-auto-push": { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      foreground: { type: "boolean", short: "f" },
      "daemon-child": { type: "boolean" },
      "no-open": { type: "boolean" },
      "print-url": { type: "boolean" },
      theme: { type: "string" },
      "max-depth": { type: "string" },
      "git-path": { type: "string" },
      "state-file": { type: "string" },
      "auto-center": { type: "boolean" },
      "date-format": { type: "string" },
      "date-type": { type: "string" },
      "fetch-avatars": { type: "boolean" },
      "graph-colours": { type: "string" },
      "graph-style": { type: "string" },
      "initial-load": { type: "string" },
      "load-more": { type: "string" },
      "show-current-branch": { type: "boolean" },
      "show-uncommitted": { type: "boolean" },
      n: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  let command: Command = "start";
  let paths = positionals;
  if (paths.length > 0 && (COMMANDS as readonly string[]).includes(paths[0])) {
    command = paths[0] as Command;
    paths = paths.slice(1);
  }

  const opts = defaultOptions();
  let serverFlagsGiven = false;
  const set = <K extends keyof StandaloneOptions>(k: K, v: StandaloneOptions[K]) => {
    opts[k] = v;
    serverFlagsGiven = true;
  };
  if (values.exclude) set("exclude", values.exclude);
  if (values["no-auto-push"]) set("autoPush", false);
  if (values.port !== undefined) set("port", parseInt(values.port, 10) || 0);
  if (values.host) set("host", values.host);
  if (values["no-open"]) opts.open = false;
  if (values["print-url"]) opts.printUrl = true;
  if (values.theme === "light" || values.theme === "dark") set("theme", values.theme);
  if (values["max-depth"] !== undefined)
    set("maxDepthOfRepoSearch", parseInt(values["max-depth"], 10) || 0);
  if (values["git-path"]) set("gitPath", values["git-path"]);
  if (values["state-file"]) set("stateFile", path.resolve(values["state-file"]));
  if (values["auto-center"] !== undefined)
    set("autoCenterCommitDetailsView", values["auto-center"]);
  if (values["date-format"])
    set("dateFormat", values["date-format"] as StandaloneOptions["dateFormat"]);
  if (values["date-type"]) set("dateType", values["date-type"] as StandaloneOptions["dateType"]);
  if (values["fetch-avatars"]) set("fetchAvatars", true);
  if (values["graph-colours"]) set("graphColours", parseColourList(values["graph-colours"]));
  if (values["graph-style"])
    set("graphStyle", values["graph-style"] as StandaloneOptions["graphStyle"]);
  if (values["initial-load"])
    set("initialLoadCommits", parseInt(values["initial-load"], 10) || 300);
  if (values["load-more"]) set("loadMoreCommits", parseInt(values["load-more"], 10) || 100);
  if (values["show-current-branch"]) set("showCurrentBranchByDefault", true);
  if (values["show-uncommitted"] !== undefined)
    set("showUncommittedChanges", values["show-uncommitted"]);
  opts.repo = (values.repo ?? []).map((r) => path.resolve(r));

  return {
    command,
    options: opts,
    paths,
    foreground: values.foreground === true,
    daemonChild: values["daemon-child"] === true,
    logLines: parseInt(values.n ?? "40", 10) || 40,
    serverFlagsGiven
  };
}

function gitToplevel(dir: string, gitPath: string): string | null {
  try {
    return child_process
      .execFileSync(gitPath, ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"]
      })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Split CLI paths into repos (shown as-is) and roots (scanned for repos). */
function classifyPaths(
  paths: string[],
  opts: StandaloneOptions
): { roots: string[]; repos: string[] } {
  const roots: string[] = [];
  const repos: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`not a directory: ${p}`);
    }
    if (fs.existsSync(path.join(abs, ".git"))) {
      repos.push(abs);
      continue;
    }
    const scan = { maxDepth: opts.maxDepthOfRepoSearch, exclude: opts.exclude };
    if (scanForRepos(abs, scan).length > 0) {
      roots.push(abs);
      continue;
    }
    // A subfolder of a repo → that repo; otherwise watch it anyway (repos may appear later).
    const top = gitToplevel(abs, opts.gitPath);
    if (top) repos.push(top);
    else roots.push(abs);
  }
  return { roots, repos };
}

function openUrl(base: string, repos: string[], roots: string[]): string {
  // A single repo → open the graph on it.
  return repos.length === 1 && roots.length === 0
    ? `${base}/?repo=${encodeURIComponent(repos[0])}`
    : base;
}

function announce(url: string, opts: StandaloneOptions, note: string) {
  if (opts.printUrl) process.stdout.write(`${url}\n`);
  else process.stderr.write(`${note}\n`);
}

const timestamp = () => {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

/** Run the server in this process (foreground mode and the background child). */
async function runServer(options: StandaloneOptions, isDaemonChild: boolean) {
  process.title = "gitgraph";
  const config = createConfig(options);
  const assetRoot = path.resolve(__dirname, "..");
  const log = (line: string) => process.stdout.write(`[${timestamp()}] ${line}\n`);
  const server = await startServer(config, options, assetRoot, { log });

  writeDaemonFile({
    pid: process.pid,
    url: server.url,
    port: server.port,
    startedAt: Date.now(),
    options
  });
  log(`serving on ${server.url} (pid ${process.pid})`);

  const shutdown = () => {
    server.close();
    removeDaemonFile(process.pid);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (isDaemonChild) process.on("SIGHUP", () => {});
  return server;
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

async function start(p: Parsed) {
  const spec = classifyPaths(
    p.paths.length > 0 || p.options.repo.length > 0 ? p.paths : [process.cwd()],
    p.options
  );
  const opts: StandaloneOptions = {
    ...p.options,
    roots: spec.roots,
    repo: [...p.options.repo, ...spec.repos]
  };

  if (p.foreground) {
    const server = await runServer(opts, false);
    const url = openUrl(server.url, opts.repo, opts.roots);
    announce(url, opts, `gitgraph serving on ${server.url} — Ctrl-C to stop`);
    if (opts.open) openBrowser(url);
    return;
  }

  const running = await findRunning();
  if (running) {
    await request(`${running.info.url}/api/open`, {
      method: "POST",
      body: { roots: opts.roots, repos: opts.repo },
      timeoutMs: 15_000
    });
    // Remember the added paths so `gitgraph restart` keeps them.
    const o = running.info.options;
    writeDaemonFile({
      ...running.info,
      options: {
        ...o,
        roots: [...new Set([...o.roots, ...opts.roots])],
        repo: [...new Set([...o.repo, ...opts.repo])]
      }
    });
    const url = openUrl(running.info.url, opts.repo, opts.roots);
    const hint = p.serverFlagsGiven
      ? " (options ignored — `gitgraph restart` or `stop` first to change them)"
      : "";
    announce(url, opts, `gitgraph already running on ${running.info.url}${hint}`);
    if (opts.open) openBrowser(url);
    return;
  }

  const info = await spawnDaemon(__filename, { ...opts, open: false, printUrl: false });
  const url = openUrl(info.url, opts.repo, opts.roots);
  announce(
    url,
    opts,
    `gitgraph running in the background on ${info.url}\n  stop with: gitgraph stop`
  );
  if (opts.open) openBrowser(url);
}

async function main() {
  const p = parseCli(process.argv.slice(2));

  if (p.daemonChild) {
    const raw = process.env.GITGRAPH_OPTIONS;
    if (!raw) throw new Error("--daemon-child needs GITGRAPH_OPTIONS");
    await runServer(JSON.parse(raw) as StandaloneOptions, true);
    return;
  }

  switch (p.command) {
    case "start":
      await start(p);
      return;
    case "stop": {
      const running = await findRunning();
      if (!running) {
        process.stderr.write("gitgraph is not running\n");
        return;
      }
      await stopDaemon(running.info);
      process.stderr.write(`gitgraph stopped (was ${running.info.url})\n`);
      return;
    }
    case "restart": {
      const running = await findRunning();
      if (!running) {
        process.stderr.write("gitgraph is not running — start it with: gitgraph <folder>\n");
        process.exitCode = 1;
        return;
      }
      await stopDaemon(running.info);
      const info = await spawnDaemon(__filename, running.info.options);
      process.stderr.write(`gitgraph restarted on ${info.url}\n`);
      return;
    }
    case "status": {
      const running = await findRunning();
      if (!running) {
        process.stdout.write("gitgraph is not running\n");
        process.exitCode = 1;
        return;
      }
      const { info, health } = running;
      const mb = health.rss ? `${Math.round(health.rss / 1024 / 1024)} MB` : "?";
      const o = info.options;
      process.stdout.write(
        [
          `gitgraph running on ${info.url}`,
          `  pid ${info.pid}, ${mb} RAM, up ${formatUptime(health.uptimeSec ?? 0)}, ${health.repos ?? "?"} repos`,
          ...o.roots.map((r) => `  folder: ${r}`),
          ...o.repo.map((r) => `  repo:   ${r}`),
          `  sync: ${describeSync(health.sync)}${o.autoPush ? "" : " (no push)"}`,
          `  log:  ${logFile()}`,
          ""
        ].join("\n")
      );
      return;
    }
    case "logs":
      process.stdout.write(tailLog(p.logLines) || `(no log yet at ${logFile()})\n`);
      return;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`gitgraph: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
