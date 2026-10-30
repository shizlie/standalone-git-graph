import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createGitRunner, getDefaultBranch, syncBranch } from "@/backend/actions/branchSync";
import { createAutoSync } from "@/standalone/autoSync";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return cp.execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function configure(dir: string) {
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "T"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
}

function commit(dir: string, file: string, msg: string) {
  fs.writeFileSync(path.join(dir, file), msg);
  git(["add", file], dir);
  git(["commit", "-q", "-m", msg], dir);
}

/** A bare origin with one commit on main, plus two clones: `local` (under test) and `other`. */
function setup() {
  const origin = tmp("ngg-origin-");
  git(["init", "-q", "--bare", "-b", "main"], origin);
  const local = tmp("ngg-local-");
  git(["clone", "-q", origin, local], local);
  configure(local);
  commit(local, "a", "first");
  git(["push", "-q", "-u", "origin", "main"], local);
  git(["remote", "set-head", "origin", "main"], local);
  const other = tmp("ngg-other-");
  git(["clone", "-q", origin, other], other);
  configure(other);
  return { origin, local, other };
}

async function run(local: string, opts = { push: true }) {
  const runner = createGitRunner(local, "git");
  await runner(["fetch", "-q", "origin"]);
  const def = await getDefaultBranch(runner);
  if (!def) throw new Error("no default branch");
  return syncBranch(runner, def.branch, def.upstream, opts);
}

describe("syncBranch", () => {
  test("fast-forwards a clean checked-out main that is behind origin/main", async () => {
    const { local, other } = setup();
    commit(other, "b", "remote work");
    git(["push", "-q"], other);

    expect(await run(local)).toEqual({ kind: "fast-forwarded", count: 1 });
    expect(git(["rev-parse", "main"], local)).toBe(git(["rev-parse", "main"], other));
    expect(fs.existsSync(path.join(local, "b"))).toBe(true);
  });

  test("skips the fast-forward when the worktree has uncommitted changes", async () => {
    const { local, other } = setup();
    commit(other, "b", "remote work");
    git(["push", "-q"], other);
    fs.writeFileSync(path.join(local, "a"), "dirty");
    const before = git(["rev-parse", "main"], local);

    const outcome = await run(local);
    expect(outcome.kind).toBe("skipped");
    expect(git(["rev-parse", "main"], local)).toBe(before);
    expect(fs.readFileSync(path.join(local, "a"), "utf8")).toBe("dirty");
  });

  test("moves main directly when it isn't checked out anywhere", async () => {
    const { local, other } = setup();
    git(["checkout", "-q", "-b", "feature"], local);
    fs.writeFileSync(path.join(local, "a"), "dirty on feature");
    commit(other, "b", "remote work");
    git(["push", "-q"], other);

    expect(await run(local)).toEqual({ kind: "fast-forwarded", count: 1 });
    expect(git(["rev-parse", "main"], local)).toBe(git(["rev-parse", "main"], other));
    expect(git(["branch", "--show-current"], local)).toBe("feature");
  });

  test("fast-forwards main checked out in a linked worktree", async () => {
    const { local, other } = setup();
    git(["checkout", "-q", "-b", "feature"], local);
    const wt = path.join(tmp("ngg-wt-"), "main-wt");
    git(["worktree", "add", "-q", wt, "main"], local);
    commit(other, "b", "remote work");
    git(["push", "-q"], other);

    expect(await run(local)).toEqual({ kind: "fast-forwarded", count: 1 });
    expect(fs.existsSync(path.join(wt, "b"))).toBe(true);
  });

  test("pushes main when it is only ahead", async () => {
    const { local, origin } = setup();
    commit(local, "c", "local work");

    expect(await run(local)).toEqual({ kind: "pushed", count: 1 });
    expect(git(["rev-parse", "main"], origin)).toBe(git(["rev-parse", "main"], local));
  });

  test("does not push when auto-push is off", async () => {
    const { local, origin } = setup();
    commit(local, "c", "local work");
    const remoteBefore = git(["rev-parse", "main"], origin);

    expect((await run(local, { push: false })).kind).toBe("skipped");
    expect(git(["rev-parse", "main"], origin)).toBe(remoteBefore);
  });

  test("leaves a diverged main alone", async () => {
    const { local, other, origin } = setup();
    commit(other, "b", "remote work");
    git(["push", "-q"], other);
    commit(local, "c", "local work");
    const localBefore = git(["rev-parse", "main"], local);
    const remoteBefore = git(["rev-parse", "main"], origin);

    expect(await run(local)).toEqual({ kind: "diverged", ahead: 1, behind: 1 });
    expect(git(["rev-parse", "main"], local)).toBe(localBefore);
    expect(git(["rev-parse", "main"], origin)).toBe(remoteBefore);
  });
});

describe("autoSync.syncNow", () => {
  test("pulls and reports ok", async () => {
    const { local, other } = setup();
    commit(other, "b", "remote work");
    git(["push", "-q"], other);
    const sync = createAutoSync({
      getRepos: () => [local],
      gitPath: "git",
      intervalMs: 0,
      push: true,
      log: () => {}
    });

    await sync.syncNow(local);
    expect(sync.getStatus(local)?.level).toBe("ok");
    expect(sync.getStatus(local)?.text).toContain("pulled 1");
    sync.stop();
  });

  test("rejects with a readable reason when main has diverged", async () => {
    const { local, other } = setup();
    commit(other, "b", "remote work");
    git(["push", "-q"], other);
    commit(local, "c", "local work");
    const sync = createAutoSync({
      getRepos: () => [local],
      gitPath: "git",
      intervalMs: 0,
      push: true,
      log: () => {}
    });

    await expect(sync.syncNow(local)).rejects.toThrow(/diverged/);
    expect(sync.getStatus(local)?.level).toBe("warn");
    sync.stop();
  });

  test("publishes a current branch that has no upstream yet", async () => {
    const { local, origin } = setup();
    git(["checkout", "-q", "-b", "feature"], local);
    commit(local, "f", "feature work");
    const sync = createAutoSync({
      getRepos: () => [local],
      gitPath: "git",
      intervalMs: 0,
      push: true,
      log: () => {}
    });

    await sync.syncNow(local);
    expect(git(["rev-parse", "feature"], origin)).toBe(git(["rev-parse", "feature"], local));
    sync.stop();
  });
});
