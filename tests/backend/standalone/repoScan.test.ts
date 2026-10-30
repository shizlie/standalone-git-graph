import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, test } from "vitest";

import { DEFAULT_EXCLUDES, scanForRepos } from "@/standalone/repoManager";
import { isRelevantGitPath } from "@/standalone/repoWatcher";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tree(paths: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-scan-"));
  dirs.push(root);
  for (const p of paths) {
    const full = path.join(root, p);
    if (p.endsWith("/.git-file")) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(full), ".git"), "gitdir: /elsewhere");
    } else {
      fs.mkdirSync(full, { recursive: true });
    }
  }
  return root;
}

const rel = (root: string, found: string[]) => found.map((f) => path.relative(root, f)).sort();

test("finds repos, skipping excluded folders, worktrees, hidden dirs and nested repos", () => {
  const root = tree([
    "app/.git",
    "app/packages/inner/.git", // nested inside a repo: not descended
    "group/lib/.git",
    "workspaces/app/feature/.git-file", // worktree inside excluded folder
    "workspace/x/.git",
    "loose-worktree/.git-file", // linked worktree outside excludes: still skipped
    ".cache/hidden/.git",
    "node_modules/pkg/.git",
    "empty"
  ]);
  expect(rel(root, scanForRepos(root, { maxDepth: 3, exclude: DEFAULT_EXCLUDES }))).toEqual([
    "app",
    path.join("group", "lib")
  ]);
});

test("respects max depth", () => {
  const root = tree(["a/.git", "b/c/d/.git"]);
  expect(rel(root, scanForRepos(root, { maxDepth: 1, exclude: [] }))).toEqual(["a"]);
  expect(rel(root, scanForRepos(root, { maxDepth: 3, exclude: [] }))).toEqual([
    "a",
    path.join("b", "c", "d")
  ]);
});

test("excludes by root-relative path", () => {
  const root = tree(["clients/old/.git", "clients/new/.git", "old/.git"]);
  expect(rel(root, scanForRepos(root, { maxDepth: 3, exclude: ["clients/old"] }))).toEqual([
    path.join("clients", "new"),
    "old"
  ]);
});

test("treats the root itself as a repo", () => {
  const root = tree([".git", "sub/.git"]);
  expect(scanForRepos(root, { maxDepth: 3, exclude: [] })).toEqual([root]);
});

test("watcher reacts to refs/HEAD/index only", () => {
  for (const p of [
    "HEAD",
    "index",
    "packed-refs",
    "refs/heads/main",
    "refs/heads/feat/x",
    "refs/remotes/origin/main",
    "refs/tags/v1",
    "refs/stash",
    "worktrees/feature/HEAD"
  ]) {
    expect(isRelevantGitPath(p), p).toBe(true);
  }
  for (const p of [
    "objects/ab/cdef",
    "objects/pack/pack-1.pack",
    "refs/heads/main.lock",
    "index.lock",
    "FETCH_HEAD",
    "ORIG_HEAD",
    "logs/HEAD",
    "logs/refs/heads/main"
  ]) {
    expect(isRelevantGitPath(p), p).toBe(false);
  }
});
