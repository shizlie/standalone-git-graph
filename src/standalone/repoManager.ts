/**
 * Standalone replacement for `src/extension/repoManager.ts`. No VS Code
 * workspace API — repo discovery comes from CLI `--repo` arguments and an
 * optional shallow subdirectory search from CWD. Keeps the method surface the
 * message handler expects (`getRepos`, `setRepoState`, `checkReposExist`,
 * `sendRepos`, `registerViewCallback`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { isGitRepository } from "@/backend/utils/git";
import { evalPromises } from "@/backend/utils/promise";
import type { Config } from "@/standalone/config";
import type { StandaloneState } from "@/standalone/state";
import type { GitRepoSet, GitRepoState } from "@/types";

function sortRepos(repos: GitRepoSet): GitRepoSet {
  const sorted: GitRepoSet = {};
  for (const p of Object.keys(repos).sort()) sorted[p] = repos[p];
  return sorted;
}

function resolveRepoArg(arg: string): string {
  return path.resolve(arg);
}

/** Recursively scan `root` up to `maxDepth` for `.git` directories. */
function discoverRepos(root: string, maxDepth: number, found: string[]): void {
  if (maxDepth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === ".git")) {
    found.push(root);
    return; // don't descend into a repo's own subdirs
  }
  if (maxDepth === 0) return;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name === ".git") continue;
    discoverRepos(path.join(root, e.name), maxDepth - 1, found);
  }
}

export type RepoManager = {
  registerViewCallback: (cb: (repos: GitRepoSet, numRepos: number) => void) => void;
  deregisterViewCallback: () => void;
  getRepos: () => GitRepoSet;
  isDirectoryWithinRepos: (p: string) => boolean;
  sendRepos: () => void;
  addRepo: (repo: string) => void;
  removeRepo: (repo: string) => void;
  removeReposWithinFolder: (p: string) => boolean;
  setRepoState: (repo: string, state: GitRepoState) => void;
  removeReposNotInWorkspace: () => void;
  checkReposExist: () => Promise<boolean>;
};

export function createRepoManager(
  state: StandaloneState,
  config: Config,
  options: { repoArgs: string[]; cwd: string }
): RepoManager {
  let repos = state.getRepos();
  let viewCallback: ((repos: GitRepoSet, numRepos: number) => void) | null = null;

  function save() {
    state.saveRepos(repos);
  }

  function removeRepo(repo: string) {
    delete repos[repo];
    save();
  }

  function addRepo(repo: string) {
    repos[repo] = { columnWidths: null };
    save();
  }

  function sendRepos() {
    const sorted = sortRepos(repos);
    viewCallback?.(sorted, Object.keys(sorted).length);
  }

  function isDirectoryWithinRepos(p: string) {
    for (const rp of Object.keys(repos)) {
      if (p === rp || p.startsWith(rp + "/")) return true;
    }
    return false;
  }

  function removeReposWithinFolder(p: string) {
    const folder = p + "/";
    let changed = false;
    for (const rp of Object.keys(repos)) {
      if (rp === p || rp.startsWith(folder)) {
        removeRepo(rp);
        changed = true;
      }
    }
    return changed;
  }

  function setRepoState(repo: string, st: GitRepoState) {
    repos[repo] = st;
    save();
  }

  function removeReposNotInWorkspace() {
    // Standalone: "workspace" = the explicit --repo args + CWD (if it's a repo).
    // Any previously-saved repo outside those roots is dropped.
    const roots = new Set<string>();
    for (const arg of options.repoArgs) roots.add(resolveRepoArg(arg));
    roots.add(resolveRepoArg(options.cwd));
    for (const rp of Object.keys(repos)) {
      let keep = false;
      for (const root of roots) {
        if (rp === root || rp.startsWith(root + "/")) {
          keep = true;
          break;
        }
      }
      if (!keep) removeRepo(rp);
    }
  }

  async function checkReposExist() {
    const paths = Object.keys(repos);
    const results = await evalPromises(paths, 3, (p) => isGitRepository(p, config.gitPath()));
    let changed = false;
    for (let i = 0; i < paths.length; i++) {
      if (!results[i]) {
        removeRepo(paths[i]);
        changed = true;
      }
    }
    if (changed) sendRepos();
    return changed;
  }

  // Seed: explicit --repo args, plus shallow discovery from CWD.
  void (async () => {
    removeReposNotInWorkspace();
    const candidates: string[] = [];
    for (const arg of options.repoArgs) candidates.push(resolveRepoArg(arg));
    if (options.repoArgs.length === 0) {
      candidates.push(resolveRepoArg(options.cwd));
    }
    // Optional shallow discovery from CWD when no explicit repos given.
    if (options.repoArgs.length === 0 && config.maxDepthOfRepoSearch() > 0) {
      discoverRepos(resolveRepoArg(options.cwd), config.maxDepthOfRepoSearch(), candidates);
    }
    const results = await evalPromises(candidates, 3, (p) => isGitRepository(p, config.gitPath()));
    for (let i = 0; i < candidates.length; i++) {
      if (results[i] && !repos[candidates[i]]) addRepo(candidates[i]);
    }
    if (!(await checkReposExist())) sendRepos();
  })();

  return {
    registerViewCallback: (cb) => {
      viewCallback = cb;
    },
    deregisterViewCallback: () => {
      viewCallback = null;
    },
    getRepos: () => sortRepos(repos),
    isDirectoryWithinRepos,
    sendRepos,
    addRepo,
    removeRepo,
    removeReposWithinFolder,
    setRepoState,
    removeReposNotInWorkspace,
    checkReposExist
  };
}
