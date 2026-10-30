/**
 * Standalone repo list. Two sources:
 *
 *   - roots: folders scanned for repos (`gitgraph ~/Codes`). Pure fs, no git
 *     processes: a directory containing a `.git` *directory* is a repo.
 *     Directories with a `.git` *file* (linked worktrees, submodules), hidden
 *     dirs, symlinks and excluded names (default: workspace, workspaces,
 *     worktrees, node_modules) are skipped. Rescanned periodically so new
 *     clones show up without a restart.
 *   - explicit repos: `--repo <path>` or a positional path that is itself a
 *     repo/worktree. Always shown, even inside an excluded folder.
 *
 * Per-repo UI state (column widths) persists in the state file.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { isGitRepository } from "@/backend/utils/git";
import type { StandaloneState } from "@/standalone/state";
import type { GitRepoSet, GitRepoState } from "@/types";

export const DEFAULT_EXCLUDES = ["workspace", "workspaces", "worktrees", "node_modules"];

export type ScanOptions = { maxDepth: number; exclude: string[] };

function isExcluded(root: string, dir: string, name: string, exclude: string[]): boolean {
  if (name.startsWith(".")) return true;
  const rel = path.relative(root, dir).split(path.sep).join("/");
  return exclude.some((x) => (x.includes("/") ? rel === x.replace(/\/+$/, "") : name === x));
}

/** Find repos under `root` (depth-limited, fs only). `root` itself counts if it is a repo. */
export function scanForRepos(root: string, opts: ScanOptions): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dotGit = entries.find((e) => e.name === ".git");
    if (dotGit) {
      if (dotGit.isDirectory()) found.push(dir);
      return; // a repo (or worktree/submodule): don't descend
    }
    if (depth >= opts.maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (isExcluded(root, child, e.name, opts.exclude)) continue;
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

export type RepoManager = {
  getRepos: () => GitRepoSet;
  getRepoPaths: () => string[];
  setRepoState: (repo: string, state: GitRepoState) => void;
  /** Rescan roots and re-check explicit repos; returns true if the list changed. */
  refresh: () => Promise<boolean>;
  checkReposExist: () => Promise<boolean>;
  /** Add roots / explicit repos at runtime (`gitgraph <path>` against a running server). */
  add: (spec: { roots?: string[]; repos?: string[] }) => Promise<void>;
  onChange: (cb: (repos: GitRepoSet) => void) => () => void;
  dispose: () => void;
};

export type RepoManagerOptions = {
  roots: string[];
  repos: string[];
  scan: ScanOptions;
  gitPath: string;
  /** Rescan interval; 0 disables. */
  rescanMs: number;
};

function sortRepos(repos: GitRepoSet): GitRepoSet {
  const sorted: GitRepoSet = {};
  for (const p of Object.keys(repos).sort()) sorted[p] = repos[p];
  return sorted;
}

export async function createRepoManager(
  state: StandaloneState,
  options: RepoManagerOptions
): Promise<RepoManager> {
  const roots = new Set(options.roots.map((r) => path.resolve(r)));
  const explicit = new Set(options.repos.map((r) => path.resolve(r)));
  const saved = state.getRepos();
  let repos: GitRepoSet = {};
  const listeners = new Set<(repos: GitRepoSet) => void>();

  async function discover(): Promise<string[]> {
    const out = new Set<string>();
    for (const root of roots) for (const r of scanForRepos(root, options.scan)) out.add(r);
    for (const r of explicit) {
      if (out.has(r)) continue;
      // oxlint-disable-next-line no-await-in-loop -- one at a time on purpose
      if (await isGitRepository(r, options.gitPath)) out.add(r);
    }
    return Array.from(out).sort(); // oxlint-disable-line no-array-sort -- fresh array
  }

  async function refresh(): Promise<boolean> {
    const next = await discover();
    const prev = Object.keys(repos).sort(); // oxlint-disable-line no-array-sort -- fresh array
    if (next.length === prev.length && next.every((p, i) => p === prev[i])) return false;
    const updated: GitRepoSet = {};
    for (const p of next) updated[p] = repos[p] ?? saved[p] ?? { columnWidths: null };
    repos = updated;
    state.saveRepos(repos);
    const sorted = sortRepos(repos);
    for (const l of listeners) l(sorted);
    return true;
  }

  await refresh();
  const timer = options.rescanMs > 0 ? setInterval(() => void refresh(), options.rescanMs) : null;
  timer?.unref();

  return {
    getRepos: () => sortRepos(repos),
    getRepoPaths: () => Object.keys(repos).sort(),
    setRepoState(repo, st) {
      if (!repos[repo]) return;
      repos[repo] = st;
      state.saveRepos(repos);
    },
    refresh,
    checkReposExist: refresh,
    async add(spec) {
      for (const r of spec.roots ?? []) roots.add(path.resolve(r));
      for (const r of spec.repos ?? []) explicit.add(path.resolve(r));
      await refresh();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      if (timer) clearInterval(timer);
      listeners.clear();
    }
  };
}
