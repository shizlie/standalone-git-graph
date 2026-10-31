/**
 * Standalone replacement for `ExtensionState`. Persists the small amount of
 * UI state the webview expects (last active repo, per-repo column widths) to a
 * JSON file on disk. Avatar storage is reported as unavailable — avatars are
 * disabled by default in standalone and the avatar code path is never reached.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { Avatar, AvatarCache, GitRepoSet, SyncSettings } from "@/types";

type PersistedState = {
  lastActiveRepo: string | null;
  repoStates: GitRepoSet;
  avatarCache: AvatarCache;
  syncSettings: SyncSettings;
};

/** Repo on screen every minute; other repos never (until changed in the UI). */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = { focusedSec: 60, othersMin: 0 };

/** Clamp to sane values: 0 (off), or at least 15 s / 1 min so the remote isn't hammered. */
function clampInterval(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return n <= 0 ? 0 : Math.min(max, Math.max(min, n));
}

export function sanitizeSyncSettings(s: Partial<SyncSettings> | undefined): SyncSettings {
  return {
    focusedSec: clampInterval(s?.focusedSec, 15, 3600, DEFAULT_SYNC_SETTINGS.focusedSec),
    othersMin: clampInterval(s?.othersMin, 1, 1440, DEFAULT_SYNC_SETTINGS.othersMin)
  };
}

export class StandaloneState {
  private file: string;
  private state: PersistedState;
  private syncListeners = new Set<(s: SyncSettings) => void>();

  constructor(file: string) {
    this.file = file;
    this.state = {
      lastActiveRepo: null,
      repoStates: {},
      avatarCache: {},
      syncSettings: { ...DEFAULT_SYNC_SETTINGS }
    };
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedState>;
        this.state = {
          lastActiveRepo: parsed.lastActiveRepo ?? null,
          repoStates: parsed.repoStates ?? {},
          avatarCache: parsed.avatarCache ?? {},
          syncSettings: sanitizeSyncSettings(parsed.syncSettings)
        };
      }
    } catch {
      /* corrupt state file — start fresh */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state));
    } catch {
      /* best-effort persistence */
    }
  }

  /* Discovered Repos */
  public getRepos(): GitRepoSet {
    return this.state.repoStates;
  }
  public saveRepos(gitRepoSet: GitRepoSet): void {
    this.state.repoStates = gitRepoSet;
    this.save();
  }

  /* Last Active Repo */
  public getLastActiveRepo(): string | null {
    return this.state.lastActiveRepo;
  }
  public setLastActiveRepo(repo: string | null): void {
    this.state.lastActiveRepo = repo;
    this.save();
  }

  /* Auto-sync settings (edited from the UI) */
  public getSyncSettings(): SyncSettings {
    return this.state.syncSettings;
  }
  public setSyncSettings(settings: Partial<SyncSettings>): SyncSettings {
    this.state.syncSettings = sanitizeSyncSettings(settings);
    this.save();
    for (const l of this.syncListeners) l(this.state.syncSettings);
    return this.state.syncSettings;
  }
  public onSyncSettings(cb: (s: SyncSettings) => void): () => void {
    this.syncListeners.add(cb);
    return () => this.syncListeners.delete(cb);
  }

  /* Avatars — disabled in standalone v1 */
  public isAvatarStorageAvailable(): boolean {
    return false;
  }
  public getAvatarStoragePath(): string {
    return "";
  }
  public getAvatarCache(): AvatarCache {
    return this.state.avatarCache;
  }
  public saveAvatar(_email: string, _avatar: Avatar): void {
    /* no-op */
  }
  public removeAvatarFromCache(_email: string): void {
    /* no-op */
  }
  public clearAvatarCache(): void {
    this.state.avatarCache = {};
    this.save();
  }
}
