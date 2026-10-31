/**
 * Standalone replacement for `src/extension/messageHandler.ts`. Binds the same
 * message protocol to the pure-git action/query handlers (reused verbatim from
 * `src/backend/*`), minus the two commands the browser shim fulfils client-side
 * (`copyToClipboard`, `viewDiff`). One instance per browser tab.
 *
 * Live updates: subscribes to the shared `.git` watcher for the selected repo
 * (→ `refresh`), to repo-list changes (→ `loadRepos`), and to sync status
 * (→ `syncStatus`). The "Sync" button runs the safe sync in `autoSync.ts`.
 *
 * Auto-sync of the repo on screen: while this tab is visible, its repo is
 * synced every `focusedSec` (saved settings, changed from the UI via
 * `setSyncSettings` and pushed to every tab as `syncSettings`).
 */
import {
  checkoutBranch,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
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
import type { AutoSync, RepoSyncStatus } from "@/standalone/autoSync";
import type { Config } from "@/standalone/config";
import type { Bridge } from "@/standalone/bridge";
import type { RepoManager } from "@/standalone/repoManager";
import type { RepoWatchHub } from "@/standalone/repoWatcher";
import type { StandaloneState } from "@/standalone/state";
import type { RequestMessage, ResponseMessage } from "@/types";

export type MessageHandlerDeps = {
  config: Config;
  gitClient: GitClient;
  repoManager: RepoManager;
  state: StandaloneState;
  watchHub: RepoWatchHub;
  autoSync: AutoSync;
};

/** How often each tab checks whether its on-screen repo is due a sync. */
const FOCUSED_CHECK_MS = 5_000;

export function registerMessageHandlers(bridge: Bridge, deps: MessageHandlerDeps) {
  const { config, gitClient, repoManager, state, watchHub, autoSync } = deps;
  let currentRepo: string | null = null;
  let unwatch: (() => void) | null = null;
  let visible = true;

  // Sync the repo on screen once its last sync is `focusedSec` old. The small
  // slack keeps the 5 s check from slipping a whole extra tick each round.
  const syncFocusedRepo = () => {
    const ms = state.getSyncSettings().focusedSec * 1000;
    if (visible && currentRepo && ms > 0) {
      autoSync.syncIfStale(currentRepo, ms - FOCUSED_CHECK_MS / 2);
    }
  };
  const focusedTimer = setInterval(syncFocusedRepo, FOCUSED_CHECK_MS);
  const postSettings = () =>
    bridge.post({ command: "syncSettings", ...state.getSyncSettings() } as ResponseMessage);
  const offSettings = state.onSyncSettings(postSettings);
  // Sent in reply to the tab's first request, when its message listener is surely ready.
  let settingsSent = false;
  const sendSettingsOnce = () => {
    if (settingsSent) return;
    settingsSent = true;
    postSettings();
  };

  const postStatus = (s: RepoSyncStatus) =>
    bridge.post({ command: "syncStatus", ...s } as ResponseMessage);
  const offStatus = autoSync.onStatus((s) => {
    if (s.repo === currentRepo) postStatus(s);
  });
  const offRepos = repoManager.onChange((repos) => {
    bridge.post({
      command: "loadRepos",
      repos,
      lastActiveRepo: state.getLastActiveRepo()
    } as ResponseMessage);
  });

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
  registerAction("deleteRemoteBranch", (msg) => deleteRemoteBranch(gitClient.getInstance(), msg));
  registerAction("renameBranch", (msg) => renameBranch(gitClient.getInstance(), msg));
  registerAction("checkoutBranch", (msg) => checkoutBranch(gitClient.getInstance(), msg));
  registerAction("checkoutCommit", (msg) => checkoutCommit(gitClient.getInstance(), msg));
  registerAction("cherrypickCommit", (msg) => cherrypickCommit(gitClient.getInstance(), msg));
  registerAction("revertCommit", (msg) => revertCommit(gitClient.getInstance(), msg));
  registerAction("resetToCommit", (msg) => resetToCommit(gitClient.getInstance(), msg));
  registerAction("mergeBranch", (msg) => mergeBranch(gitClient.getInstance(), msg));
  registerAction("mergeCommit", (msg) => mergeCommit(gitClient.getInstance(), msg));
  registerAction("sync", (msg) => autoSync.syncNow(msg.repo));

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
    sendSettingsOnce();
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
  function activate(repo: string) {
    currentRepo = repo;
    gitClient.setRepo(repo);
    state.setLastActiveRepo(repo);
    unwatch?.();
    unwatch = watchHub.subscribe(repo, () =>
      bridge.post({ command: "refresh" } as ResponseMessage)
    );
    const status = autoSync.getStatus(repo);
    if (status) postStatus(status);
    syncFocusedRepo();
  }

  bridge.onMessage("tabVisibility", (msg) => {
    visible = msg.visible;
    if (visible) syncFocusedRepo();
  });

  bridge.onMessage("setSyncSettings", (msg) => {
    // Broadcast to every tab (this one included) via onSyncSettings.
    state.setSyncSettings({ focusedSec: msg.focusedSec, othersMin: msg.othersMin });
  });

  bridge.onMessage("selectRepo", (msg) => {
    if (msg.repo === currentRepo || !repoManager.getRepos()[msg.repo]) return;
    activate(msg.repo);
  });

  bridge.onMessage("loadRepos", async (msg) => {
    if (!msg.check || !(await repoManager.checkReposExist())) {
      const repos = repoManager.getRepos();
      const lastActive = state.getLastActiveRepo();
      // Mirror the webview's loadRepos logic: pick lastActiveRepo if still
      // present, else the first repo. The webview never sends selectRepo on
      // initial load, so the server must sync the gitClient here.
      const repoPaths = Object.keys(repos);
      const pick = lastActive && repos[lastActive] ? lastActive : (repoPaths[0] ?? null);
      if (pick && pick !== currentRepo) activate(pick);
      bridge.post({
        command: "loadRepos",
        repos,
        lastActiveRepo: lastActive
      } as ResponseMessage);
    }
    sendSettingsOnce();
  });

  bridge.onMessage("saveRepoState", (msg) => {
    repoManager.setRepoState(msg.repo, msg.state);
  });

  return {
    dispose: () => {
      clearInterval(focusedTimer);
      offSettings();
      unwatch?.();
      unwatch = null;
      offStatus();
      offRepos();
    }
  };
}
