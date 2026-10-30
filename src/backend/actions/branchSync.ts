/**
 * Safe branch sync: keep a local branch and its upstream (e.g. `main` and
 * `origin/main`) pointing at the same commit, but only when that can be done
 * without merging, rebasing, forcing, or touching uncommitted work.
 *
 *   local behind upstream, clean worktree  → fast-forward local
 *   local ahead of upstream                → push (plain, never forced)
 *   both ahead and behind                  → leave alone, report "diverged"
 *
 * Uses `execFile` directly (not simple-git) so every call has a timeout and
 * runs with prompts disabled — a background sync must never hang waiting for
 * a password.
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type SyncOutcome =
  | { kind: "in-sync" }
  | { kind: "fast-forwarded"; count: number }
  | { kind: "pushed"; count: number }
  | { kind: "diverged"; ahead: number; behind: number }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

export type BranchSyncResult = {
  branch: string;
  upstream: string;
  outcome: SyncOutcome;
};

export type GitRunner = (
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
) => Promise<string>;

const LOCAL_TIMEOUT_MS = 15_000;
const NETWORK_TIMEOUT_MS = 90_000;

export function createGitRunner(repo: string, gitPath: string): GitRunner {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // Don't take the index lock for read-only commands (status), so we never
    // block the user's own git commands or trigger our own .git watcher.
    GIT_OPTIONAL_LOCKS: "0"
  };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      child_process.execFile(
        gitPath,
        args,
        {
          cwd: opts.cwd ?? repo,
          env,
          timeout: opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true
        },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || err.message).toString().trim();
            reject(new Error(msg || `git ${args[0]} failed`));
          } else {
            resolve(stdout.toString());
          }
        }
      );
    });
}

async function tryGit(git: GitRunner, args: string[], cwd?: string): Promise<string | null> {
  try {
    return (await git(args, { cwd })).trim();
  } catch {
    return null;
  }
}

export async function listRemotes(git: GitRunner): Promise<string[]> {
  const out = await tryGit(git, ["remote"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

export async function fetchAll(git: GitRunner): Promise<void> {
  await git(["fetch", "--all", "--prune", "--quiet", "--no-write-fetch-head"], {
    timeoutMs: NETWORK_TIMEOUT_MS
  });
}

type Upstream = { short: string; remote: string; remoteBranch: string };

/** The configured upstream of a local branch, or null. */
export async function getUpstream(git: GitRunner, branch: string): Promise<Upstream | null> {
  const out = await tryGit(git, [
    "for-each-ref",
    "--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
    `refs/heads/${branch}`
  ]);
  if (!out) return null;
  const [short, remote, remoteRef] = out.split("\0");
  if (!short || !remote || !remoteRef?.startsWith("refs/heads/")) return null;
  return { short, remote, remoteBranch: remoteRef.slice("refs/heads/".length) };
}

/**
 * The repo's default branch and its upstream. Prefers `origin/HEAD`, falls back
 * to `origin/main` / `origin/master`. Returns null when there's no local branch
 * of that name (nothing to keep in sync).
 */
export async function getDefaultBranch(
  git: GitRunner
): Promise<{ branch: string; upstream: Upstream } | null> {
  const remotes = await listRemotes(git);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) return null;

  let remoteBranch: string | null = null;
  const head = await tryGit(git, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (head?.startsWith(`refs/remotes/${remote}/`)) {
    remoteBranch = head.slice(`refs/remotes/${remote}/`.length);
  } else {
    for (const candidate of ["main", "master"]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time on purpose
      if (
        await tryGit(git, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${remote}/${candidate}`
        ])
      ) {
        remoteBranch = candidate;
        break;
      }
    }
  }
  if (!remoteBranch) return null;
  if (!(await tryGit(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${remoteBranch}`]))) {
    return null;
  }
  return {
    branch: remoteBranch,
    upstream: { short: `${remote}/${remoteBranch}`, remote, remoteBranch }
  };
}

/** Path of the worktree that has `branch` checked out, or null. */
export async function worktreeForBranch(git: GitRunner, branch: string): Promise<string | null> {
  const out = await tryGit(git, ["worktree", "list", "--porcelain"]);
  if (!out) return null;
  let current: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
}

const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG"
];

/** Why this worktree can't be fast-forwarded right now, or null if it can. */
export async function worktreeBlocker(git: GitRunner, worktree: string): Promise<string | null> {
  const gitDir = await tryGit(git, ["rev-parse", "--absolute-git-dir"], worktree);
  if (!gitDir) return "cannot read worktree";
  for (const marker of IN_PROGRESS_MARKERS) {
    if (fs.existsSync(path.join(gitDir, marker))) return "merge/rebase in progress";
  }
  // Untracked files are fine: a fast-forward refuses on its own if it would overwrite one.
  const status = await tryGit(git, ["status", "--porcelain", "--untracked-files=no"], worktree);
  if (status === null) return "cannot read worktree status";
  if (status !== "") return "uncommitted changes";
  return null;
}

async function aheadBehind(
  git: GitRunner,
  branch: string,
  upstream: string
): Promise<{ ahead: number; behind: number }> {
  const out = await git([
    "rev-list",
    "--left-right",
    "--count",
    `refs/heads/${branch}...refs/remotes/${upstream}`
  ]);
  const [ahead, behind] = out
    .trim()
    .split(/\s+/)
    .map((n) => parseInt(n, 10));
  return { ahead: ahead || 0, behind: behind || 0 };
}

export type SyncBranchOptions = {
  /** Push when local is strictly ahead. */
  push: boolean;
  /** Skip the push if local is at this sha (a push of it already failed). */
  skipPushOf?: string | null;
};

export async function syncBranch(
  git: GitRunner,
  branch: string,
  upstream: Upstream,
  opts: SyncBranchOptions
): Promise<SyncOutcome> {
  let counts: { ahead: number; behind: number };
  try {
    counts = await aheadBehind(git, branch, upstream.short);
  } catch (e) {
    return { kind: "error", message: errorMessage(e) };
  }
  const { ahead, behind } = counts;
  if (ahead === 0 && behind === 0) return { kind: "in-sync" };
  if (ahead > 0 && behind > 0) return { kind: "diverged", ahead, behind };

  if (behind > 0) {
    const worktree = await worktreeForBranch(git, branch);
    try {
      if (worktree) {
        const blocker = await worktreeBlocker(git, worktree);
        if (blocker) return { kind: "skipped", reason: `${blocker} in ${worktree}` };
        await git(["merge", "--ff-only", "--quiet", `refs/remotes/${upstream.short}`], {
          cwd: worktree
        });
      } else {
        // Not checked out anywhere: move the ref directly. Passing the old sha
        // makes this a compare-and-swap, so a concurrent change wins.
        const oldSha = (await git(["rev-parse", `refs/heads/${branch}`])).trim();
        const newSha = (await git(["rev-parse", `refs/remotes/${upstream.short}`])).trim();
        await git([
          "update-ref",
          "-m",
          `gitgraph: fast-forward to ${upstream.short}`,
          `refs/heads/${branch}`,
          newSha,
          oldSha
        ]);
      }
    } catch (e) {
      return { kind: "error", message: errorMessage(e) };
    }
    return { kind: "fast-forwarded", count: behind };
  }

  // ahead > 0, behind === 0
  if (!opts.push)
    return { kind: "skipped", reason: `${ahead} local commit(s) not pushed (auto-push off)` };
  const sha = (await tryGit(git, ["rev-parse", `refs/heads/${branch}`])) ?? "";
  if (opts.skipPushOf && sha === opts.skipPushOf) {
    return { kind: "skipped", reason: `${ahead} local commit(s); last push was rejected` };
  }
  try {
    await git(
      [
        "push",
        "--quiet",
        upstream.remote,
        `refs/heads/${branch}:refs/heads/${upstream.remoteBranch}`
      ],
      { timeoutMs: NETWORK_TIMEOUT_MS }
    );
  } catch (e) {
    return { kind: "error", message: `push failed: ${errorMessage(e)}` };
  }
  return { kind: "pushed", count: ahead };
}

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Keep the first meaningful line; git errors can be long.
  return (
    msg
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? msg
  );
}

export function describeOutcome(r: BranchSyncResult): string {
  const o = r.outcome;
  switch (o.kind) {
    case "in-sync":
      return `${r.branch} in sync with ${r.upstream}`;
    case "fast-forwarded":
      return `${r.branch} ← ${r.upstream} (pulled ${o.count})`;
    case "pushed":
      return `${r.branch} → ${r.upstream} (pushed ${o.count})`;
    case "diverged":
      return `${r.branch} diverged from ${r.upstream} (${o.ahead} ahead, ${o.behind} behind)`;
    case "skipped":
      return `${r.branch} not synced: ${o.reason}`;
    case "error":
      return `${r.branch}: ${o.message}`;
  }
}
