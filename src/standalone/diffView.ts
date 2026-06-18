/**
 * Standalone diff viewer. The browser shim opens `/diff?…` in a new tab when
 * the user clicks a file in a commit's details. This module renders that page:
 * runs `git diff <commit>^ <commit> -- <path>` (or the add/delete equivalent)
 * and returns themed HTML with the unified diff coloured by line kind.
 */
import type { SimpleGit } from "simple-git";

import type { GitClient } from "@/backend/gitClient";

type DiffParams = {
  repo: string;
  commit: string;
  oldFilePath: string;
  newFilePath: string;
  type: string; // "A" | "M" | "D" | "R"
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colourizeDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return `<span class="dhead">${escapeHtml(line)}</span>`;
  }
  if (line.startsWith("@@")) {
    return `<span class="dhunk">${escapeHtml(line)}</span>`;
  }
  if (line.startsWith("+")) {
    return `<span class="dadd">${escapeHtml(line)}</span>`;
  }
  if (line.startsWith("-")) {
    return `<span class="ddel">${escapeHtml(line)}</span>`;
  }
  return `<span class="dctx">${escapeHtml(line)}</span>`;
}

export async function renderDiffHtml(gitClient: GitClient, params: DiffParams): Promise<string> {
  const git: SimpleGit = gitClient.getInstance().cwd(params.repo);
  let diff: string;
  try {
    if (params.type === "A") {
      // Added: diff against empty tree.
      diff = await git.raw([
        "diff",
        "--no-color",
        "--no-index",
        "--",
        "/dev/null",
        params.newFilePath
      ]);
    } else if (params.type === "D") {
      diff = await git.raw([
        "diff",
        "--no-color",
        `${params.commit}^`,
        params.commit,
        "--",
        params.oldFilePath
      ]);
    } else {
      diff = await git.raw([
        "diff",
        "--no-color",
        `${params.commit}^`,
        params.commit,
        "--",
        params.newFilePath
      ]);
    }
  } catch (e) {
    // git diff exits non-zero on some edge cases; stderr may still have content.
    diff = e instanceof Error ? e.message : String(e);
  }

  const title = `${params.newFilePath} (${params.commit.slice(0, 8)})`;
  const body = diff
    .split("\n")
    .map(colourizeDiffLine)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #16181d; --fg: #d8dce4; --add: #5cc76e; --del: #f0656a;
    --ctx: #6a6f7a; --head: #6fa3e0; --hunk: #4ec9b0;
    --border: #2e323b;
  }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 10px 14px; border-bottom: 1px solid var(--border);
           font-size: 13px; color: var(--ctx); }
  pre { margin: 0; padding: 14px; white-space: pre-wrap; word-break: break-word; }
  .dhead { color: var(--head); }
  .dhunk { color: var(--hunk); }
  .dadd  { color: var(--add); }
  .ddel  { color: var(--del); }
  .dctx  { color: var(--ctx); }
</style>
</head>
<body>
<header>${escapeHtml(title)}</header>
<pre>${body}</pre>
</body>
</html>`;
}
