# standalone-git-graph

A standalone, browser-based git graph viewer. No VS Code required.

Based on [neo-git-graph](https://github.com/asispts/neo-git-graph) by Asis Pattisahusiwa (MIT).
The graph UI is the original webview, unchanged; the VS Code extension layer is
replaced by a small Node HTTP + WebSocket server.

## Quick start

```bash
bun install && node esbuild.js && bun link   # once: build + put `gitgraph` on PATH

gitgraph ~/Codes     # every repo under ~/Codes; runs in the background, opens the browser
gitgraph .           # just this repo (or worktree), added to the running server
gitgraph status      # URL, RAM, repo count
gitgraph logs        # what auto-sync did
gitgraph stop        # stop it (it never auto-starts after a reboot)
gitgraph restart     # after pulling/rebuilding gitgraph itself
```

- Opens on http://127.0.0.1:1234 (next free port if taken).
- Skips `workspace/`, `workspaces/`, `worktrees/` and `node_modules/` while scanning.
- Every 5 min it fetches each repo and keeps `main` level with `origin/main`. It
  fast-forwards when behind and the checkout is clean, and pushes when only ahead.
  It never touches a diverged branch. `--no-auto-push` or `--sync-interval 0` to tone it down.

![demo](resources/demo.gif)

## Features

- **Graph view** — branches, tags, remotes, uncommitted changes, HEAD marker
- **Commit details** — click any commit → message, author, parents, file tree
  with add/delete counts
- **Diffs** — click a file in commit details → colored unified diff in a new tab
- **Branch actions** — create, checkout, rename, delete, merge
- **Tag actions** — add, delete, push
- **Commit actions** — checkout, cherry-pick, revert, reset (soft/mixed/hard)
- **Copy to clipboard** — commit hash, tag name, branch name
- **Background server** — `gitgraph ~/Codes` and forget; `gitgraph stop` to end it
- **Folder watch** — every repo under a folder, switch between them in the UI
- **Auto sync** — keeps `main` and `origin/main` level when it's safe to
- **Live refresh** — refs/HEAD/index changes push updates to the UI
- **Dark / light theme** — refined palettes with ≥4.5:1 contrast

## Install

### Prerequisites

- **Node.js** ≥ 18
- **git** on your PATH (or pass `--git-path /path/to/git`)

### Option A — npm (global, recommended)

```bash
cd standalone-git-graph
npm install
node esbuild.js
npm link          # puts `gitgraph` on your PATH
```

Verify:

```bash
gitgraph --help
```

### Option B — bun

```bash
cd standalone-git-graph
bun install
node esbuild.js
bun link
```

### Option C — run directly, no global install

```bash
cd standalone-git-graph
npm install
node esbuild.js

# then from any repo:
node /path/to/standalone-git-graph/out/cli.js
```

## Use

```bash
gitgraph ~/Codes        # start in the background, open the browser, return
gitgraph status         # URL, memory, repo count
gitgraph logs           # recent sync activity / errors
gitgraph stop           # stop it
gitgraph restart        # restart with the same folders/options (e.g. after a rebuild)
```

- **Background by default.** `gitgraph` starts a detached server and returns
  right away — close the terminal, it keeps running. Nothing is registered with
  launchd/systemd, so it does **not** come back after a reboot until you run
  `gitgraph` again. `--foreground` (`-f`) runs it in the terminal instead.
- **One server.** Running `gitgraph <path>` again while it's up adds that path
  to the running server and opens the browser on it.
- **Port 1234**, moving up (1235, 1236…) if taken. `--port 0` = any free port.

### Folders vs repos

- A path that is a repo (or a worktree) shows that repo: `gitgraph .`
- Any other folder is scanned for repos (default depth 3, `--max-depth`).
  Skipped while scanning: `workspace/`, `workspaces/`, `worktrees/`,
  `node_modules/`, hidden folders, and linked worktrees / submodules
  (folders whose `.git` is a file). Change the list with `--exclude <name>`
  (repeatable; a `a/b` value matches a root-relative path).
- The folder is rescanned every minute, so new clones appear on their own.
- Worktrees still show up as branches in their main repo's graph, and you
  can open one directly: `gitgraph ~/Codes/workspaces/app/feature`.

### Auto sync

Every 5 minutes (`--sync-interval <min>`, `0` = off), for each repo:

1. `git fetch --all --prune`
2. Keep the default branch (`main`, from `origin/HEAD`) level with `origin/main`:
   - **behind** → fast-forward. If `main` is checked out, only when that
     worktree has no uncommitted changes and no merge/rebase in progress;
     if it isn't checked out anywhere, the ref is moved directly.
   - **ahead** → plain `git push` (never forced). `--no-auto-push` turns this off.
   - **diverged** → left alone; the UI shows a warning next to the Sync button.

Opening a repo in the UI also syncs it if the last sync is over a minute old.
The **Sync** button does the same immediately, plus the current branch
(fast-forward/push its upstream, or publish it with `-u` if it has none), and
shows a dialog if anything needed your attention.

Git runs with prompts disabled (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode`), so a
missing credential fails fast instead of hanging.

### Lightweight

- ~55–60 MB RAM, ~0% CPU when idle; heap capped at 256 MB.
- Repo discovery is plain `readdir` — no git processes.
- `.git` is only watched for repos open in a browser tab, one shared watcher
  per repo, reacting only to refs/HEAD/index changes (debounced). Working-tree
  edits are picked up when you switch back to the tab — no polling.
- Background git reads use `GIT_OPTIONAL_LOCKS=0`, so they never hold the
  index lock while you're running git yourself.

### Scripted use (Orca etc.) — print URL only

```bash
URL=$(gitgraph --repo /path/to/worktree --no-open --print-url)
```

Prints only the URL on stdout and returns; the server keeps running in the background.

## All flags

```
gitgraph — standalone (neo) Git Graph

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
  --sync-interval <min>   Background sync every N minutes (default 5, 0 = off)
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
```

## Rebuild after changing source

```bash
node esbuild.js              # one-shot build
node esbuild.js --watch      # rebuild on save
node esbuild.js --production # minified build
```

## How it works

```
Browser tab                    Node server (cli.ts)
┌─────────────┐                ┌──────────────────┐
│  web.min.js  │  WebSocket    │  server.ts       │
│  (graph UI)  │ ←──────────→  │  ↓               │
│              │   /ws         │  messageHandler  │
│  shim.js     │               │  ↓               │
│  (postMessage│               │  simple-git      │
│   → WS)      │               │  ↓               │
│              │  HTTP         │  git CLI         │
│  media/*.css │ ←──────────→  │  /media, /diff   │
└─────────────┘                └──────────────────┘
```

- `out/web.min.js` — the original webview, compiled untouched
- `out/shim.js` — replaces `acquireVsCodeApi()` with a WebSocket client
- `out/cli.js` — the server + CLI entry point
- `src/standalone/*` — the replacement layer (config, state, repo manager,
  message handler, diff viewer, HTML generator with theme shim)

## Credits

- [neo-git-graph](https://github.com/asispts/neo-git-graph) by Asis Pattisahusiwa
- [Git Graph](https://github.com/mhutchie/vscode-git-graph) by mhutchie (original)

## License

MIT — same as the upstream [neo-git-graph](https://github.com/asispts/neo-git-graph).
