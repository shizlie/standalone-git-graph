/**
 * Standalone replacement for `src/extension/webviewHtml.ts`. Produces the same
 * HTML the upstream webview expects — same `viewState` / `l10n` globals, same
 * CSS files, same `web.min.js` bundle — plus:
 *
 *   - A theme shim `<style>` block defining the 13 `--vscode-*` CSS variables
 *     the UI references, with dark/light palettes selected by `--theme`.
 *   - A `<script src="/shim.js">` tag loaded before `web.min.js` that provides
 *     `acquireVsCodeApi()` backed by a WebSocket (see `shim.ts`).
 *
 * No VS Code CSP / nonce / webview URI machinery.
 */
import type { Config } from "@/standalone/config";
import type { RepoManager } from "@/standalone/repoManager";
import type { StandaloneState } from "@/standalone/state";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type { GitGraphViewState } from "@/types";

function escapeJsonForHtml(obj: object): string {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * Refined dark palette (impeccable: restrained strategy, tinted neutral + accent).
 * Deep blue-gray base, high-contrast foreground (≥4.5:1), deliberate git colors.
 * OKLCH-approximated: bg ~L0.16 C0.01 H250, fg ~L0.88, accent H250.
 */
const THEME_DARK: Record<string, string> = {
  "--vscode-editor-background": "#16181d",
  "--vscode-editor-foreground": "#d8dce4",
  "--vscode-editor-font-family":
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif",
  "--vscode-gitDecoration-addedResourceForeground": "#5cc76e",
  "--vscode-gitDecoration-deletedResourceForeground": "#f0656a",
  "--vscode-gitDecoration-modifiedResourceForeground": "#e8a838",
  "--vscode-menu-background": "#1c1f26",
  "--vscode-menu-foreground": "#c8ccd4",
  "--vscode-menu-selectionBackground": "#3b6fd4",
  "--vscode-menu-selectionForeground": "#ffffff",
  "--vscode-menu-separatorBackground": "#2e323b",
  "--vscode-scrollbar-shadow": "#0b0c0f",
  "--vscode-widget-shadow": "#00000055"
};

/**
 * Refined light palette (impeccable: true off-white, not cream; dark ink;
 * darker git colors for ≥4.5:1 contrast on light bg).
 */
const THEME_LIGHT: Record<string, string> = {
  "--vscode-editor-background": "#f7f8fa",
  "--vscode-editor-foreground": "#2a2d34",
  "--vscode-editor-font-family":
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif",
  "--vscode-gitDecoration-addedResourceForeground": "#2d8c43",
  "--vscode-gitDecoration-deletedResourceForeground": "#c93535",
  "--vscode-gitDecoration-modifiedResourceForeground": "#b87820",
  "--vscode-menu-background": "#ffffff",
  "--vscode-menu-foreground": "#2a2d34",
  "--vscode-menu-selectionBackground": "#2563eb",
  "--vscode-menu-selectionForeground": "#ffffff",
  "--vscode-menu-separatorBackground": "#e0e2e8",
  "--vscode-scrollbar-shadow": "#d1d4db",
  "--vscode-widget-shadow": "#0000000d"
};

export function buildWebviewHtml(opts: {
  config: Config;
  state: StandaloneState;
  repoManager: RepoManager;
  theme: "dark" | "light";
}): { html: string; isGraphLoaded: boolean } {
  const { config, state, repoManager, theme } = opts;
  const l10nStrings = getWebviewLocalizedStrings();

  const viewState: GitGraphViewState = {
    autoCenterCommitDetailsView: config.autoCenterCommitDetailsView(),
    dateFormat: config.dateFormat(),
    fetchAvatars: config.fetchAvatars() && state.isAvatarStorageAvailable(),
    graphColours: config.graphColours(),
    graphStyle: config.graphStyle(),
    initialLoadCommits: config.initialLoadCommits(),
    lastActiveRepo: state.getLastActiveRepo(),
    loadMoreCommits: config.loadMoreCommits(),
    repos: repoManager.getRepos(),
    showCurrentBranchByDefault: config.showCurrentBranchByDefault()
  };

  const numRepos = Object.keys(viewState.repos).length;
  const palette = theme === "light" ? THEME_LIGHT : THEME_DARK;
  let colorVars = "";
  for (const [k, v] of Object.entries(palette)) colorVars += `${k}:${v};`;
  for (let i = 0; i < viewState.graphColours.length; i++) {
    colorVars += `--git-graph-color${i}:${viewState.graphColours[i]};`;
  }
  let colorParams = "";
  for (let i = 0; i < viewState.graphColours.length; i++) {
    colorParams += `[data-color="${i}"]{--git-graph-color:var(--git-graph-color${i});}`;
  }

  let body: string;
  if (numRepos > 0) {
    body = `<body style="${colorVars}">
		<div id="controls">
			<span id="repoControl"><span class="unselectable">${l10nStrings.repo}: </span><div id="repoSelect" class="dropdown"></div></span>
			<span id="branchControl"><span class="unselectable">${l10nStrings.branch}: </span><div id="branchSelect" class="dropdown"></div></span>
			<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" value="1" checked>${l10nStrings.showRemoteBranches}</label>
      <div id="syncBtn" class="roundedBtn">${l10nStrings.sync}</div>
      <div id="refreshBtn" class="roundedBtn">${l10nStrings.refresh}</div>
      <div id="blinkHeadBtn" class="roundedBtn">${l10nStrings.locateHead}</div>
		</div>
		<div id="content">
			<div id="commitGraph"></div>
			<div id="commitTable"></div>
		</div>
		<div id="footer"></div>
		<ul id="contextMenu"></ul>
		<div id="dialogBacking"></div>
		<div id="dialog"></div>
		<div id="scrollShadow"></div>
		<script src="/shim.js"></script>
		<script>var viewState = ${escapeJsonForHtml(viewState)};</script>
		<script>var l10n = ${escapeJsonForHtml(l10nStrings)};</script>
		<script src="/web.min.js"></script>
		</body>`;
  } else {
    body = `<body class="unableToLoad" style="${colorVars}">
		<h2>${l10nStrings.unableToLoadGitGraph}</h2>
		<p>${l10nStrings.noGitRepository}</p>
		<p>${l10nStrings.noGit}</p>
		</body>`;
  }

  const html = `<!DOCTYPE html>
	<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<link rel="stylesheet" type="text/css" href="/media/main.css">
			<link rel="stylesheet" type="text/css" href="/media/dropdown.css">
			<title>(neo) Git Graph</title>
			<style>${colorParams}</style>
		</head>
		${body}
	</html>`;

  return { html, isGraphLoaded: numRepos > 0 };
}
