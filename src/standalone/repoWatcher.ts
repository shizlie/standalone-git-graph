/**
 * One shared `.git` watcher per repo, reference-counted across browser tabs.
 *
 * Only ref/HEAD/index changes count — object writes, lock files, FETCH_HEAD and
 * reflogs are ignored — and bursts are debounced, so a `git fetch` or `git gc`
 * produces at most one refresh instead of hundreds. Nothing is watched while no
 * tab has the repo open.
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";

const RELEVANT =
  /^(HEAD|index|packed-refs|config|refs\/stash|refs\/(heads|remotes|tags)\/.+|worktrees\/[^/]+\/(HEAD|index))$/;
const DEBOUNCE_MS = 400;

export function isRelevantGitPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  return !p.endsWith(".lock") && RELEVANT.test(p);
}

type Entry = {
  subs: Set<() => void>;
  watchers: fs.FSWatcher[];
  timer: NodeJS.Timeout | null;
  closed: boolean;
};

export type RepoWatchHub = {
  subscribe: (repo: string, onChange: () => void) => () => void;
  closeAll: () => void;
};

function gitCommonDir(repo: string, gitPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    child_process.execFile(
      gitPath,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repo, timeout: 10_000 },
      (err, stdout) => resolve(err ? null : stdout.toString().trim() || null)
    );
  });
}

export function createRepoWatchHub(gitPath: string): RepoWatchHub {
  const entries = new Map<string, Entry>();

  function fire(e: Entry) {
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = null;
      for (const cb of e.subs) cb();
    }, DEBOUNCE_MS);
  }

  async function start(repo: string, e: Entry) {
    // Common dir covers both a normal repo and a linked worktree (its HEAD lives in worktrees/<name>/).
    const dir = await gitCommonDir(repo, gitPath);
    if (!dir || e.closed) return;
    const onEvent = (_ev: string, filename: string | Buffer | null) => {
      if (filename === null || isRelevantGitPath(filename.toString())) fire(e);
    };
    try {
      e.watchers.push(fs.watch(dir, { recursive: true, persistent: false }, onEvent));
    } catch {
      // Recursive watch unsupported (older Node on Linux): watch the top level
      // (HEAD, index, packed-refs) plus refs/heads.
      for (const [sub, prefix] of [
        ["", ""],
        ["/refs/heads", "refs/heads/"]
      ] as const) {
        try {
          e.watchers.push(
            fs.watch(dir + sub, { persistent: false }, (ev, f) =>
              onEvent(ev, f === null ? null : prefix + f.toString())
            )
          );
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }

  function close(repo: string, e: Entry) {
    e.closed = true;
    if (e.timer) clearTimeout(e.timer);
    for (const w of e.watchers) w.close();
    e.watchers = [];
    entries.delete(repo);
  }

  return {
    subscribe(repo, onChange) {
      let e = entries.get(repo);
      if (!e) {
        e = { subs: new Set(), watchers: [], timer: null, closed: false };
        entries.set(repo, e);
        void start(repo, e);
      }
      const entry = e;
      entry.subs.add(onChange);
      return () => {
        entry.subs.delete(onChange);
        if (entry.subs.size === 0 && !entry.closed) close(repo, entry);
      };
    },
    closeAll() {
      for (const [repo, e] of entries) close(repo, e);
    }
  };
}
