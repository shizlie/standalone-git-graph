/**
 * Standalone replacement for `src/config.ts`. Same method surface as the
 * original `Config` so the message handler and webview HTML generator can be
 * reused verbatim. Values come from CLI flags (parsed in `cli.ts`) instead of
 * VS Code workspace configuration.
 */
import { DateType } from "@/backend/types";
import { DateFormat, GraphStyle } from "@/types";

export type StandaloneOptions = {
  repo: string[];
  port: number;
  host: string;
  open: boolean;
  printUrl: boolean;
  theme: "dark" | "light";
  maxDepthOfRepoSearch: number;
  autoCenterCommitDetailsView: boolean;
  dateFormat: DateFormat;
  dateType: DateType;
  fetchAvatars: boolean;
  graphColours: string[];
  graphStyle: GraphStyle;
  initialLoadCommits: number;
  loadMoreCommits: number;
  showCurrentBranchByDefault: boolean;
  showUncommittedChanges: boolean;
  gitPath: string;
  stateFile: string;
};

export type Config = {
  autoCenterCommitDetailsView: () => boolean;
  dateFormat: () => DateFormat;
  dateType: () => DateType;
  fetchAvatars: () => boolean;
  graphColours: () => string[];
  graphStyle: () => GraphStyle;
  initialLoadCommits: () => number;
  loadMoreCommits: () => number;
  maxDepthOfRepoSearch: () => number;
  showCurrentBranchByDefault: () => boolean;
  showUncommittedChanges: () => boolean;
  gitPath: () => string;
};

const DEFAULT_GRAPH_COLOURS = [
  "#0085d9",
  "#d9008f",
  "#00d90a",
  "#d98500",
  "#a300d9",
  "#ff0000",
  "#00d9cc",
  "#e138e8",
  "#85d900",
  "#dc5b23",
  "#6f24d6",
  "#ffcc00"
];

export function defaultOptions(): StandaloneOptions {
  return {
    repo: [],
    port: 8765,
    host: "127.0.0.1",
    open: true,
    printUrl: false,
    theme: "dark",
    maxDepthOfRepoSearch: 0,
    autoCenterCommitDetailsView: true,
    dateFormat: "Date & Time",
    dateType: "Author Date",
    fetchAvatars: false,
    graphColours: DEFAULT_GRAPH_COLOURS,
    graphStyle: "rounded",
    initialLoadCommits: 300,
    loadMoreCommits: 100,
    showCurrentBranchByDefault: false,
    showUncommittedChanges: true,
    gitPath: "git",
    stateFile: ""
  };
}

export function createConfig(opts: StandaloneOptions): Config {
  return {
    autoCenterCommitDetailsView: () => opts.autoCenterCommitDetailsView,
    dateFormat: () => opts.dateFormat,
    dateType: () => opts.dateType,
    fetchAvatars: () => opts.fetchAvatars,
    graphColours: () => opts.graphColours,
    graphStyle: () => opts.graphStyle,
    initialLoadCommits: () => opts.initialLoadCommits,
    loadMoreCommits: () => opts.loadMoreCommits,
    maxDepthOfRepoSearch: () => opts.maxDepthOfRepoSearch,
    showCurrentBranchByDefault: () => opts.showCurrentBranchByDefault,
    showUncommittedChanges: () => opts.showUncommittedChanges,
    gitPath: () => opts.gitPath
  };
}

export { DEFAULT_GRAPH_COLOURS };
