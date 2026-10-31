export type WorktreeInfo = {
  path: string;
  /** Short branch name checked out there, or null when detached / bare. */
  branch: string | null;
  /** The first entry `git worktree list` prints is the main working tree. */
  isMain: boolean;
};

/** Parse `git worktree list --porcelain`. */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, isMain: out.length === 0 };
      out.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return out;
}
