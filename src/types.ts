import {
  ActionRequest,
  ActionResponse,
  GitFileChangeType,
  QueryRequest,
  QueryResponse
} from "@/backend/types";

export type GitRepoSet = { [repo: string]: GitRepoState };
export type GitRepoState = {
  columnWidths: number[] | null;
};

export type GitGraphViewState = {
  autoCenterCommitDetailsView: boolean;
  dateFormat: DateFormat;
  fetchAvatars: boolean;
  graphColours: string[];
  graphStyle: GraphStyle;
  initialLoadCommits: number;
  lastActiveRepo: string | null;
  loadMoreCommits: number;
  repos: GitRepoSet;
  showCurrentBranchByDefault: boolean;
};

export type Avatar = {
  image: string;
  timestamp: number;
  identicon: boolean;
};
export type AvatarCache = { [email: string]: Avatar };

export type DateFormat = "Date & Time" | "Date Only" | "Relative";
export type GraphStyle = "rounded" | "angular";

/* Infrastructure Request / Response Messages */

export type RequestFetchAvatar = {
  command: "fetchAvatar";
  repo: string;
  email: string;
  commits: string[];
};
export type ResponseFetchAvatar = {
  command: "fetchAvatar";
  email: string;
  image: string;
};

/** Standalone only: how often auto-sync runs. 0 = off. */
export type SyncSettings = {
  /** Seconds between syncs of the repo shown in a visible browser tab. */
  focusedSec: number;
  /** Minutes between syncs of every other repo. */
  othersMin: number;
};

/** Standalone only: the browser tab was shown or hidden. */
export type RequestTabVisibility = {
  command: "tabVisibility";
  visible: boolean;
};

/** Standalone only: change the auto-sync settings (saved, applied to every tab). */
export type RequestSetSyncSettings = {
  command: "setSyncSettings";
} & SyncSettings;

export type ResponseSyncSettings = {
  command: "syncSettings";
} & SyncSettings;

export type RequestSelectRepo = {
  command: "selectRepo";
  repo: string;
};

export type RequestLoadRepos = {
  command: "loadRepos";
  check: boolean;
};
export type ResponseLoadRepos = {
  command: "loadRepos";
  repos: GitRepoSet;
  lastActiveRepo: string | null;
};

export type RequestSaveRepoState = {
  command: "saveRepoState";
  repo: string;
  state: GitRepoState;
};

export type RequestCopyToClipboard = {
  command: "copyToClipboard";
  type: string;
  data: string;
};
export type ResponseCopyToClipboard = {
  command: "copyToClipboard";
  type: string;
  success: boolean;
};

export type RequestViewDiff = {
  command: "viewDiff";
  repo: string;
  commitHash: string;
  oldFilePath: string;
  newFilePath: string;
  type: GitFileChangeType;
};
export type ResponseViewDiff = {
  command: "viewDiff";
  success: boolean;
};

export type ResponseRefresh = {
  command: "refresh";
};

/** Standalone only: background/manual sync state of a repo. */
export type ResponseSyncStatus = {
  command: "syncStatus";
  repo: string;
  level: "ok" | "busy" | "warn" | "error";
  text: string;
  at: number;
};

export type RequestMessage =
  | ActionRequest
  | QueryRequest
  | RequestFetchAvatar
  | RequestSelectRepo
  | RequestTabVisibility
  | RequestSetSyncSettings
  | RequestLoadRepos
  | RequestSaveRepoState
  | RequestCopyToClipboard
  | RequestViewDiff;

export type ResponseMessage =
  | ActionResponse
  | QueryResponse
  | ResponseFetchAvatar
  | ResponseLoadRepos
  | ResponseCopyToClipboard
  | ResponseViewDiff
  | ResponseRefresh
  | ResponseSyncStatus
  | ResponseSyncSettings;
