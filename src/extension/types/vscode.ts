import * as vscode from "vscode";

export type VscodeWorkspace = Pick<
  typeof vscode.workspace,
  | "createFileSystemWatcher"
  | "onDidChangeWorkspaceFolders"
  | "onDidChangeConfiguration"
  | "workspaceFolders"
>;
