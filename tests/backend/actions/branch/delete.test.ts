import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteBranch } from "@/backend/actions/branch";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("deleteBranch", () => {
  it("deletes an existing branch", async () => {
    git(["branch", "to-delete"], repo);

    await deleteBranch(simpleGit(repo), {
      branchName: "to-delete",
      forceDelete: false
    });

    const listed = cp
      .execFileSync("git", ["branch", "--list", "to-delete"], { cwd: repo })
      .toString()
      .trim();
    expect(listed).toBe("");
  });

  it("throws when deleting a branch with unmerged changes without force", async () => {
    git(["checkout", "-b", "unmerged"], repo);
    fs.writeFileSync(path.join(repo, "g"), "y");
    git(["add", "."], repo);
    git(["commit", "-m", "unmerged commit"], repo);
    git(["checkout", "main"], repo);

    await expect(
      deleteBranch(simpleGit(repo), {
        branchName: "unmerged",
        forceDelete: false
      })
    ).rejects.toThrow();
  });

  it("force-deletes a branch with unmerged changes", async () => {
    await deleteBranch(simpleGit(repo), {
      branchName: "unmerged",
      forceDelete: true
    });

    const listed = cp
      .execFileSync("git", ["branch", "--list", "unmerged"], { cwd: repo })
      .toString()
      .trim();
    expect(listed).toBe("");
  });

  it("throws when the branch does not exist", async () => {
    await expect(
      deleteBranch(simpleGit(repo), {
        branchName: "nonexistent",
        forceDelete: false
      })
    ).rejects.toThrow();
  });
});

describe("deleteBranch with deleteWorktree", () => {
  let base: string;
  let wtRoot: string;

  beforeAll(() => {
    base = makeRepo();
    wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-wt-"));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  const branchExists = (name: string) =>
    cp.execFileSync("git", ["branch", "--list", name], { cwd: base }).toString().trim() !== "";

  it("removes a clean, merged worktree and its branch", async () => {
    const wt = path.join(wtRoot, "clean");
    git(["worktree", "add", "-b", "feat-clean", wt], base);

    await deleteBranch(simpleGit(base), {
      branchName: "feat-clean",
      forceDelete: false,
      deleteWorktree: true
    });

    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists("feat-clean")).toBe(false);
  });

  it("refuses (and touches nothing) when the worktree has uncommitted files", async () => {
    const wt = path.join(wtRoot, "dirty");
    git(["worktree", "add", "-b", "feat-dirty", wt], base);
    fs.writeFileSync(path.join(wt, "new.txt"), "wip");

    await expect(
      deleteBranch(simpleGit(base), {
        branchName: "feat-dirty",
        forceDelete: false,
        deleteWorktree: true
      })
    ).rejects.toThrow(/uncommitted/);
    expect(fs.existsSync(path.join(wt, "new.txt"))).toBe(true);
    expect(branchExists("feat-dirty")).toBe(true);

    await deleteBranch(simpleGit(base), {
      branchName: "feat-dirty",
      forceDelete: true,
      deleteWorktree: true
    });
    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists("feat-dirty")).toBe(false);
  });

  it("refuses (and touches nothing) when the branch is not merged", async () => {
    const wt = path.join(wtRoot, "unmerged");
    git(["worktree", "add", "-b", "feat-unmerged", wt], base);
    fs.writeFileSync(path.join(wt, "h"), "z");
    git(["add", "."], wt);
    git(["-c", "user.email=t@t.com", "-c", "user.name=T", "commit", "-m", "wt commit"], wt);

    await expect(
      deleteBranch(simpleGit(base), {
        branchName: "feat-unmerged",
        forceDelete: false,
        deleteWorktree: true
      })
    ).rejects.toThrow(/not fully merged/);
    expect(fs.existsSync(wt)).toBe(true);
    expect(branchExists("feat-unmerged")).toBe(true);
  });

  it("still deletes the branch when its worktree folder was already removed by hand", async () => {
    const wt = path.join(wtRoot, "gone");
    git(["worktree", "add", "-b", "feat-gone", wt], base);
    fs.rmSync(wt, { recursive: true, force: true });

    await deleteBranch(simpleGit(base), {
      branchName: "feat-gone",
      forceDelete: false,
      deleteWorktree: true
    });
    expect(branchExists("feat-gone")).toBe(false);
  });
});
