# standalone-git-graph

A standalone, browser-based git graph viewer. No VS Code required.

Based on [neo-git-graph](https://github.com/asispts/neo-git-graph) by Asis Pattisahusiwa (MIT).
The graph UI is the original webview, unchanged; the VS Code extension layer is
replaced by a small Node HTTP + WebSocket server.

```
gitgraph          # in any repo → opens browser tab with the graph
```

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
- **Live refresh** — watches `.git/` and pushes updates to the UI
- **Multi-repo** — pass multiple `--repo` flags, switch between them in the UI
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

### Basic — current repo

```bash
cd ~/my-project
gitgraph
```

The server runs until `Ctrl-C`. Reload the browser tab to reconnect.

### Explicit repo

```bash
gitgraph --repo ~/my-project
gitgraph --repo ~/repoA --repo ~/repoB    # multiple repos, switch in UI
```

### Specific port / host

```bash
gitgraph --port 3000
gitgraph --host 0.0.0.0 --port 8080       # share on LAN
```

Default: `--host 127.0.0.1 --port 0` (0 = free port).

### Don't auto-open a browser

```bash
gitgraph --no-open
```

### Scripted use — print URL only

```bash
gitgraph --repo /path/to/worktree --no-open --print-url
```

Outputs **only** the URL on stdout, so scripts can capture it:

```bash
URL=$(gitgraph --repo ~/my-project --no-open --print-url)
echo "Graph at: $URL"
```

### Light theme

```bash
gitgraph --theme light
```

Default: `dark`.

### Discover repos in subdirectories

```bash
cd ~/projects
gitgraph --max-depth 2
```

## All flags

```
gitgraph [OPTIONS]

OPTIONS
  --repo <path>           Repository to show (repeatable; default: CWD)
  --port <n>              Port (0 = free port; default 0)
  --host <addr>           Bind address (default 127.0.0.1)
  --no-open               Don't auto-open a browser tab
  --print-url             Print the URL to stdout (for scripts)
  --theme dark|light      UI theme (default dark)
  --max-depth <n>         Subdir search depth from CWD (default 0)
  --git-path <path>       git binary (default git)
  --state-file <path>     Persisted state file (default ~/.gitgraph/state.json)
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
