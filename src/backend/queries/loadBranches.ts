import type { SimpleGit } from "simple-git";

import type { QueryResult } from "@/backend/types";
import { isGitRepository } from "@/backend/utils/git";
import { parseWorktreeList } from "@/backend/utils/worktrees";

type LoadBranchesInput = {
  showRemoteBranches: boolean;
  hard: boolean;
  currentRepo: string;
  gitPath: string;
};

export async function loadBranches(
  git: SimpleGit,
  input: LoadBranchesInput
): Promise<QueryResult<"loadBranches">> {
  const { showRemoteBranches, hard, currentRepo, gitPath } = input;

  let branches: string[];
  let head: string | null;
  let error: boolean;

  try {
    const summary = await (showRemoteBranches ? git.branch() : git.branchLocal());
    head = summary.detached ? null : summary.current || null;
    branches = head ? [head, ...summary.all.filter((b) => b !== head)] : [...summary.all];
    error = false;
  } catch {
    branches = [];
    head = null;
    error = true;
  }

  const isRepo = error ? await isGitRepository(currentRepo, gitPath) : true;
  const worktrees = error ? {} : await linkedWorktrees(git, head);

  return { branches, head, hard, isRepo, worktrees };
}

/** Branches checked out in a linked worktree (not the main one, not the current HEAD). */
async function linkedWorktrees(
  git: SimpleGit,
  head: string | null
): Promise<{ [branch: string]: string }> {
  const out: { [branch: string]: string } = {};
  try {
    const list = parseWorktreeList(await git.raw(["worktree", "list", "--porcelain"]));
    for (const w of list) {
      if (!w.isMain && w.branch && w.branch !== head) out[w.branch] = w.path;
    }
  } catch {
    // Old git or unreadable worktree list: just don't offer worktree removal.
  }
  return out;
}
