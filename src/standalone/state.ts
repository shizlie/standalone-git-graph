/**
 * Standalone replacement for `ExtensionState`. Persists the small amount of
 * UI state the webview expects (last active repo, per-repo column widths) to a
 * JSON file on disk. Avatar storage is reported as unavailable — avatars are
 * disabled by default in standalone and the avatar code path is never reached.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { Avatar, AvatarCache, GitRepoSet } from "@/types";

type PersistedState = {
  lastActiveRepo: string | null;
  repoStates: GitRepoSet;
  avatarCache: AvatarCache;
};

export class StandaloneState {
  private file: string;
  private state: PersistedState;

  constructor(file: string) {
    this.file = file;
    this.state = { lastActiveRepo: null, repoStates: {}, avatarCache: {} };
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedState>;
        this.state = {
          lastActiveRepo: parsed.lastActiveRepo ?? null,
          repoStates: parsed.repoStates ?? {},
          avatarCache: parsed.avatarCache ?? {}
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
