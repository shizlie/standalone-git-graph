/**
 * Auto-sync for watched repos, plus the manual "Sync" button. Two rates:
 * the repo shown on screen (driven per tab by `messageHandler.ts` through
 * `syncIfStale`), and a background loop over every repo (`getIntervalMs`,
 * off by default; re-read after each run and on `reschedule()`). Each run: `git fetch --all --prune`, then keep the default branch
 * (e.g. `main`) level with its upstream using the safe rules in
 * `backend/actions/branchSync.ts`. The manual button also syncs the
 * currently checked-out branch.
 *
 * Runs are sequential per repo (never overlapping) and at most two repos at a
 * time, chained with setTimeout so a slow network can't pile runs up.
 */
import {
  createGitRunner,
  describeOutcome,
  errorMessage,
  fetchAll,
  getDefaultBranch,
  getUpstream,
  listRemotes,
  syncBranch,
  type BranchSyncResult
} from "@/backend/actions/branchSync";
import { evalPromises } from "@/backend/utils/promise";

export type SyncLevel = "ok" | "busy" | "warn" | "error";
export type RepoSyncStatus = { repo: string; level: SyncLevel; text: string; at: number };

export type AutoSyncOptions = {
  getRepos: () => string[];
  gitPath: string;
  /** Background loop over all repos; 0 = off (manual and on-screen sync still work). */
  getIntervalMs: () => number;
  push: boolean;
  log: (line: string) => void;
};

export type AutoSync = {
  /** Manual sync of one repo; rejects with a readable message if anything needs attention. */
  syncNow: (repo: string) => Promise<void>;
  /** Sync `repo` in the background if its last sync is older than `maxAgeMs`. */
  syncIfStale: (repo: string, maxAgeMs: number) => void;
  /** Apply a changed `getIntervalMs()` now instead of after the current wait. */
  reschedule: () => void;
  getStatus: (repo: string) => RepoSyncStatus | null;
  onStatus: (cb: (s: RepoSyncStatus) => void) => () => void;
  stop: () => void;
};

const MAX_PARALLEL_REPOS = 2;
const FIRST_RUN_DELAY_MS = 5_000;

export function createAutoSync(opts: AutoSyncOptions): AutoSync {
  const statuses = new Map<string, RepoSyncStatus>();
  const listeners = new Set<(s: RepoSyncStatus) => void>();
  const running = new Map<string, Promise<RepoSyncStatus>>();
  // repo\0branch → sha whose push was rejected; don't retry until the branch moves.
  const rejectedPush = new Map<string, string>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function setStatus(s: RepoSyncStatus) {
    statuses.set(s.repo, s);
    for (const l of listeners) l(s);
  }

  async function runRepo(repo: string, manual: boolean): Promise<RepoSyncStatus> {
    const git = createGitRunner(repo, opts.gitPath);
    const prev = statuses.get(repo);
    const finish = (level: SyncLevel, text: string) => {
      const s = { repo, level, text, at: Date.now() };
      // Log only state changes, so a repo that keeps failing doesn't flood the log.
      if (level !== "ok" || text.includes("pulled") || text.includes("pushed")) {
        if (!prev || prev.text !== text) opts.log(`${repo}: ${text}`);
      }
      setStatus(s);
      return s;
    };

    if ((await listRemotes(git)).length === 0) return finish("ok", "no remote");
    setStatus({ repo, level: "busy", text: "syncing…", at: Date.now() });

    try {
      await fetchAll(git);
    } catch (e) {
      return finish("error", `fetch failed: ${errorMessage(e)}`);
    }

    const results: BranchSyncResult[] = [];
    const def = await getDefaultBranch(git);
    if (def) {
      const key = `${repo}\0${def.branch}`;
      const outcome = await syncBranch(git, def.branch, def.upstream, {
        push: opts.push || manual,
        skipPushOf: manual ? null : (rejectedPush.get(key) ?? null)
      });
      if (outcome.kind === "error" && outcome.message.startsWith("push failed")) {
        const sha = await git(["rev-parse", `refs/heads/${def.branch}`]).catch(() => "");
        rejectedPush.set(key, sha.trim());
      } else if (outcome.kind === "pushed" || outcome.kind === "in-sync") {
        rejectedPush.delete(key);
      }
      results.push({ branch: def.branch, upstream: def.upstream.short, outcome });
    }

    if (manual) {
      const current = await git(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .then((s) => s.trim())
        .catch(() => "");
      if (current && current !== def?.branch) {
        results.push(await syncCurrentBranch(git, current));
      }
    }

    if (results.length === 0) return finish("ok", "fetched");
    const level: SyncLevel = results.some((r) => r.outcome.kind === "error")
      ? "error"
      : results.some((r) => r.outcome.kind === "diverged" || r.outcome.kind === "skipped")
        ? "warn"
        : "ok";
    return finish(level, results.map(describeOutcome).join(" · "));
  }

  function syncRepo(repo: string, manual: boolean): Promise<RepoSyncStatus> {
    const existing = running.get(repo);
    if (existing) return existing;
    const p = runRepo(repo, manual)
      .catch((e) => {
        const s = { repo, level: "error" as const, text: errorMessage(e), at: Date.now() };
        setStatus(s);
        return s;
      })
      .finally(() => running.delete(repo));
    running.set(repo, p);
    return p;
  }

  let ticking = false;
  function schedule(delayMs: number) {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!stopped && !ticking && opts.getIntervalMs() > 0) {
      timer = setTimeout(() => void tick(), delayMs);
    }
  }

  async function tick() {
    timer = null;
    ticking = true;
    // Skip repos synced recently (e.g. the one on screen), so they aren't hit twice.
    const maxAge = opts.getIntervalMs() / 2;
    const repos = opts.getRepos().filter((r) => {
      const s = statuses.get(r);
      return !s || Date.now() - s.at > maxAge;
    });
    await evalPromises(repos, MAX_PARALLEL_REPOS, (r) => syncRepo(r, false)).catch(() => {});
    ticking = false;
    schedule(opts.getIntervalMs());
  }

  schedule(FIRST_RUN_DELAY_MS);

  return {
    async syncNow(repo) {
      // If a background run is in flight, wait for it, then run the manual one.
      await running.get(repo);
      const s = await syncRepo(repo, true);
      if (s.level === "error" || s.level === "warn") throw new Error(s.text);
    },
    syncIfStale(repo, maxAgeMs) {
      const s = statuses.get(repo);
      if (running.has(repo)) return;
      if (!s || Date.now() - s.at > maxAgeMs) void syncRepo(repo, false);
    },
    reschedule() {
      const ms = opts.getIntervalMs();
      schedule(Math.min(ms, FIRST_RUN_DELAY_MS));
    },
    getStatus: (repo) => statuses.get(repo) ?? null,
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/** Manual sync of a non-default branch: same safe rules; publishes it if it has no upstream yet. */
async function syncCurrentBranch(
  git: ReturnType<typeof createGitRunner>,
  branch: string
): Promise<BranchSyncResult> {
  const upstream = await getUpstream(git, branch);
  if (upstream) {
    return {
      branch,
      upstream: upstream.short,
      outcome: await syncBranch(git, branch, upstream, { push: true })
    };
  }
  const remotes = await listRemotes(git);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  try {
    await git(
      ["push", "--quiet", "--set-upstream", remote, `refs/heads/${branch}:refs/heads/${branch}`],
      {
        timeoutMs: 90_000
      }
    );
    return { branch, upstream: `${remote}/${branch}`, outcome: { kind: "pushed", count: 0 } };
  } catch (e) {
    return {
      branch,
      upstream: `${remote}/${branch}`,
      outcome: { kind: "error", message: `push failed: ${errorMessage(e)}` }
    };
  }
}
