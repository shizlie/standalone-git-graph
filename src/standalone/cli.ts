#!/usr/bin/env node
/**
 * gitgraph — standalone (neo) Git Graph.
 *
 *   gitgraph [--repo <path>...] [--port <n>] [--host <addr>]
 *            [--no-open] [--print-url] [--theme dark|light]
 *            [--max-depth <n>] [--git-path <path>] [--state-file <path>]
 *
 * Run with no args in a git repo → serves the graph UI for the current repo on
 * a free port and opens a browser tab.
 *
 * Orca / scripted use:
 *   gitgraph --repo /path/to/worktree --no-open --print-url
 * prints `http://127.0.0.1:PORT` to stdout (and nothing else) and keeps running
 * until killed. The caller captures the URL and drives the browser itself.
 */
import { parseArgs } from "node:util";
import * as child_process from "node:child_process";
import * as path from "node:path";

import { createConfig, defaultOptions, type StandaloneOptions } from "@/standalone/config";
import { startServer } from "@/standalone/server";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    child_process.spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* non-fatal — user can open the URL manually */
  }
}

function parseColourList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCli(): StandaloneOptions {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", multiple: true },
      port: { type: "string" },
      host: { type: "string" },
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
      help: { type: "boolean" }
    },
    strict: true
  });

  if (values.help) {
    process.stdout.write(
      [
        "gitgraph — standalone (neo) Git Graph",
        "",
        "USAGE",
        "  gitgraph [OPTIONS]",
        "",
        "OPTIONS",
        "  --repo <path>           Repository to show (repeatable; default: CWD)",
        "  --port <n>              Port (0 = free port; default 0)",
        "  --host <addr>           Bind address (default 127.0.0.1)",
        "  --no-open               Don't auto-open a browser tab",
        "  --print-url             Print the URL to stdout (for orca/scripts)",
        "  --theme dark|light      UI theme (default dark)",
        "  --max-depth <n>         Subdir search depth from CWD (default 0)",
        "  --git-path <path>       git binary (default git)",
        "  --state-file <path>     Persisted state file",
        "  --date-format <fmt>     Date & Time | Date Only | Relative",
        "  --date-type <t>         Author Date | Commit Date",
        "  --graph-style <s>       rounded | angular",
        "  --graph-colours <csv>   Comma-separated hex colours",
        "  --initial-load <n>      Commits to load on open (default 300)",
        "  --load-more <n>         Commits per load-more (default 100)",
        "  --show-current-branch   Show only current branch on open",
        "  --show-uncommitted      Show uncommitted changes node",
        "  --fetch-avatars         Fetch avatars from GitHub/GitLab/Gravatar",
        "  --help                  Show this help",
        ""
      ].join("\n")
    );
    process.exit(0);
  }

  const opts = defaultOptions();
  if (values.repo) opts.repo = values.repo;
  if (values.port) opts.port = parseInt(values.port, 10) || 0;
  if (values.host) opts.host = values.host;
  if (values["no-open"]) opts.open = false;
  if (values["print-url"]) opts.printUrl = true;
  if (values.theme === "light" || values.theme === "dark") opts.theme = values.theme;
  if (values["max-depth"]) opts.maxDepthOfRepoSearch = parseInt(values["max-depth"], 10) || 0;
  if (values["git-path"]) opts.gitPath = values["git-path"];
  if (values["state-file"]) opts.stateFile = values["state-file"];
  if (values["auto-center"] !== undefined) opts.autoCenterCommitDetailsView = values["auto-center"];
  if (values["date-format"]) opts.dateFormat = values["date-format"] as StandaloneOptions["dateFormat"];
  if (values["date-type"]) opts.dateType = values["date-type"] as StandaloneOptions["dateType"];
  if (values["fetch-avatars"]) opts.fetchAvatars = true;
  if (values["graph-colours"]) opts.graphColours = parseColourList(values["graph-colours"]);
  if (values["graph-style"]) opts.graphStyle = values["graph-style"] as StandaloneOptions["graphStyle"];
  if (values["initial-load"]) opts.initialLoadCommits = parseInt(values["initial-load"], 10) || 300;
  if (values["load-more"]) opts.loadMoreCommits = parseInt(values["load-more"], 10) || 100;
  if (values["show-current-branch"]) opts.showCurrentBranchByDefault = true;
  if (values["show-uncommitted"] !== undefined)
    opts.showUncommittedChanges = values["show-uncommitted"];
  return opts;
}

async function main() {
  const options = parseCli();
  const config = createConfig(options);
  // assetRoot = directory containing media/ and out/ = the installed package root.
  const assetRoot = path.resolve(__dirname, "..");

  const server = await startServer(config, options, assetRoot);

  if (options.printUrl) {
    // ONLY the URL on stdout — scripts capture this line.
    process.stdout.write(`${server.url}\n`);
  } else {
    process.stderr.write(`gitgraph serving on ${server.url}\n`);
  }
  if (options.open) openBrowser(server.url);

  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
}

void main();
