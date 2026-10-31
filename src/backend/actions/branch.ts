import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";
import { parseWorktreeList } from "@/backend/utils/worktrees";

export async function createBranch(
  git: SimpleGit,
  input: ActionPayload<"createBranch">
): Promise<void> {
  await git.raw(["branch", input.branchName, input.commitHash]);
}

/**
 * Delete a local branch. With `deleteWorktree`, first remove the linked
 * worktree that has the branch checked out (git refuses to delete it otherwise).
 *
 * Without `forceDelete` nothing is touched unless both steps are safe: the
 * worktree must have no uncommitted or untracked files, and the branch must be
 * merged (same rule as `git branch -d`). With `forceDelete` both are forced.
 */
export async function deleteBranch(
  git: SimpleGit,
  input: ActionPayload<"deleteBranch">
): Promise<void> {
  const { branchName, forceDelete } = input;
  if (input.deleteWorktree) {
    // Forget worktrees whose folder was already deleted by hand.
    await git.raw(["worktree", "prune"]);
    const worktree = parseWorktreeList(await git.raw(["worktree", "list", "--porcelain"])).find(
      (w) => w.branch === branchName
    );
    if (worktree) {
      if (worktree.isMain) {
        throw new Error(
          `'${branchName}' is checked out in the main working tree (${worktree.path}), which can't be removed.`
        );
      }
      if (!forceDelete) {
        const status = await git.raw(["-C", worktree.path, "status", "--porcelain"]);
        if (status.trim() !== "") {
          throw new Error(
            `The worktree ${worktree.path} has uncommitted or untracked files. Nothing was deleted. Tick Force Delete to discard them.`
          );
        }
        await assertMerged(git, branchName);
      }
      await git.raw(["worktree", "remove", ...(forceDelete ? ["--force"] : []), worktree.path]);
    }
  }
  await git.deleteLocalBranch(branchName, forceDelete);
}

/** Same check `git branch -d` makes: merged into its upstream, or into HEAD if it has none. */
async function assertMerged(git: SimpleGit, branchName: string): Promise<void> {
  const ref = `refs/heads/${branchName}`;
  const upstream = (await git.raw(["for-each-ref", "--format=%(upstream)", ref])).trim();
  // Count commits rather than use `merge-base --is-ancestor`: simple-git doesn't
  // reject on a non-zero exit code when git prints nothing to stderr.
  const unmerged = (await git.raw(["rev-list", "--count", `${upstream || "HEAD"}..${ref}`])).trim();
  if (unmerged !== "0") {
    throw new Error(
      `The branch '${branchName}' is not fully merged. Nothing was deleted. Tick Force Delete to delete it anyway.`
    );
  }
}

export async function renameBranch(
  git: SimpleGit,
  input: ActionPayload<"renameBranch">
): Promise<void> {
  await git.raw(["branch", "-m", input.oldName, input.newName]);
}

export async function checkoutBranch(
  git: SimpleGit,
  input: ActionPayload<"checkoutBranch">
): Promise<void> {
  if (input.remoteBranch === null) {
    await git.checkout(input.branchName);
  } else {
    await git.checkoutBranch(input.branchName, input.remoteBranch);
  }
}

export async function deleteRemoteBranch(
  git: SimpleGit,
  input: ActionPayload<"deleteRemoteBranch">
): Promise<void> {
  await git.raw(["push", input.remoteName, "--delete", input.branchName]);
}
