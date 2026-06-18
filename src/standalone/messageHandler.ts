/**
 * Standalone replacement for `src/extension/messageHandler.ts`. Binds the same
 * message protocol to the pure-git action/query handlers (reused verbatim from
 * `src/backend/*`), minus the two commands the browser shim fulfils client-side
 * (`copyToClipboard`, `viewDiff`). Also watches the repo's `.git` directory for
 * external changes and pushes a `refresh` message so the UI stays live.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  checkoutBranch,
  createBranch,
  deleteBranch,
  renameBranch
} from "@/backend/actions/branch";
import {
  checkoutCommit,
  cherrypickCommit,
  resetToCommit,
  revertCommit
} from "@/backend/actions/commit";
import { mergeBranch, mergeCommit } from "@/backend/actions/merge";
import { addTag, deleteTag, pushTag } from "@/backend/actions/tag";
import { commitDetails } from "@/backend/queries/commitDetails";
import { loadBranches } from "@/backend/queries/loadBranches";
import { loadCommits } from "@/backend/queries/loadCommits";
import type { GitClient } from "@/backend/gitClient";
import type { Config } from "@/standalone/config";
import type { Bridge } from "@/standalone/bridge";
import type { RepoManager } from "@/standalone/repoManager";
import type { StandaloneState } from "@/standalone/state";
import type { RequestMessage, ResponseMessage } from "@/types";

export type MessageHandlerDeps = {
  config: Config;
  gitClient: GitClient;
  repoManager: RepoManager;
  state: StandaloneState;
};

export function registerMessageHandlers(bridge: Bridge, deps: MessageHandlerDeps) {
  const { config, gitClient, repoManager, state } = deps;
  let currentRepo: string | null = null;
  let watcher: fs.FSWatcher | null = null;

  function registerAction<T extends RequestMessage["command"]>(
    command: T,
    handler: (msg: Extract<RequestMessage, { command: T }>) => Promise<void>
  ) {
    bridge.onMessage(command, async (msg) => {
      let status: string | null = null;
      try {
        await handler(msg);
      } catch (e: unknown) {
        status = e instanceof Error ? e.message : String(e);
      }
      bridge.post({ command, status } as unknown as ResponseMessage);
    });
  }

  // --- Action handlers ---
  registerAction("addTag", (msg) => addTag(gitClient.getInstance(), msg));
  registerAction("deleteTag", (msg) => deleteTag(gitClient.getInstance(), msg));
  registerAction("pushTag", (msg) => pushTag(gitClient.getInstance(), msg));
  registerAction("createBranch", (msg) => createBranch(gitClient.getInstance(), msg));
  registerAction("deleteBranch", (msg) => deleteBranch(gitClient.getInstance(), msg));
  registerAction("renameBranch", (msg) => renameBranch(gitClient.getInstance(), msg));
  registerAction("checkoutBranch", (msg) => checkoutBranch(gitClient.getInstance(), msg));
  registerAction("checkoutCommit", (msg) => checkoutCommit(gitClient.getInstance(), msg));
  registerAction("cherrypickCommit", (msg) => cherrypickCommit(gitClient.getInstance(), msg));
  registerAction("revertCommit", (msg) => revertCommit(gitClient.getInstance(), msg));
  registerAction("resetToCommit", (msg) => resetToCommit(gitClient.getInstance(), msg));
  registerAction("mergeBranch", (msg) => mergeBranch(gitClient.getInstance(), msg));
  registerAction("mergeCommit", (msg) => mergeCommit(gitClient.getInstance(), msg));

  // --- Query handlers ---
  bridge.onMessage("loadCommits", async (msg) => {
    bridge.post({
      command: "loadCommits",
      ...(await loadCommits(gitClient.getInstance(), {
        branchName: msg.branchName,
        maxCommits: msg.maxCommits,
        showRemoteBranches: msg.showRemoteBranches,
        hard: msg.hard,
        dateType: config.dateType(),
        showUncommittedChanges: config.showUncommittedChanges()
      }))
    } as ResponseMessage);
  });

  bridge.onMessage("loadBranches", async (msg) => {
    bridge.post({
      command: "loadBranches",
      ...(await loadBranches(gitClient.getInstance(), {
        showRemoteBranches: msg.showRemoteBranches,
        hard: msg.hard,
        currentRepo: currentRepo ?? "",
        gitPath: config.gitPath()
      }))
    } as ResponseMessage);
  });

  bridge.onMessage("commitDetails", async (msg) => {
    bridge.post({
      command: "commitDetails",
      ...(await commitDetails(gitClient.getInstance(), {
        commitHash: msg.commitHash,
        dateType: config.dateType()
      }))
    } as ResponseMessage);
  });

  // --- Infrastructure handlers ---
  bridge.onMessage("selectRepo", (msg) => {
    if (msg.repo === currentRepo) return;
    currentRepo = msg.repo;
    gitClient.setRepo(msg.repo);
    state.setLastActiveRepo(msg.repo);
    startWatcher(msg.repo);
  });

  bridge.onMessage("loadRepos", async (msg) => {
    if (!msg.check || !(await repoManager.checkReposExist())) {
      const repos = repoManager.getRepos();
      const lastActive = state.getLastActiveRepo();
      // Mirror the webview's loadRepos logic: pick lastActiveRepo if still
      // present, else the first repo. The webview never sends selectRepo on
      // initial load, so the server must sync the gitClient here.
      const repoPaths = Object.keys(repos);
      const pick = lastActive && repos[lastActive] ? lastActive : repoPaths[0] ?? null;
      if (pick && pick !== currentRepo) {
        currentRepo = pick;
        gitClient.setRepo(pick);
        state.setLastActiveRepo(pick);
        startWatcher(pick);
      }
      bridge.post({
        command: "loadRepos",
        repos,
        lastActiveRepo: lastActive
      } as ResponseMessage);
    }
  });

  bridge.onMessage("saveRepoState", (msg) => {
    repoManager.setRepoState(msg.repo, msg.state);
  });

  function startWatcher(repo: string) {
    watcher?.close();
    const gitDir = path.join(repo, ".git");
    try {
      watcher = fs.watch(gitDir, { recursive: true }, () => {
        bridge.post({ command: "refresh" } as ResponseMessage);
      });
    } catch {
      /* .git may be a file (worktree) or unreadable — skip watching */
    }
  }

  return {
    onPanelShown: () => {
      currentRepo = null;
    },
    dispose: () => {
      watcher?.close();
      watcher = null;
    }
  };
}
