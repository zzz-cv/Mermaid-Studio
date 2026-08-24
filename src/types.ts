export type DiagramType = "flowchart" | "sequence" | "class" | "state" | "er" | "gantt";

export type FileTreeNode = {
  kind: "directory" | "file";
  name: string;
  path: string;
  relativePath: string;
  children?: FileTreeNode[];
};

export type RecognizedFile = {
  path: string;
  relativePath: string;
  name: string;
  rootPath: string;
  rootName: string;
  type: DiagramType;
  updatedAt: number;
};

export type WorkspaceFolderSnapshot = {
  rootPath: string;
  rootName: string;
  tree: FileTreeNode[];
  recognized: RecognizedFile[];
};

export type WorkspaceSnapshot = {
  folders: WorkspaceFolderSnapshot[];
  recognized: RecognizedFile[];
};

export type SavedDraft = {
  filePath: string;
  rootPath: string;
  snapshot: WorkspaceSnapshot;
};

export type ExportPayload = {
  suggestedName: string;
  data: string;
  encoding: "utf8" | "base64";
  type: "svg" | "png" | "md";
};

export type DesktopBridge = {
  openWorkspace: () => Promise<WorkspaceSnapshot | null>;
  refreshWorkspace: () => Promise<WorkspaceSnapshot>;
  removeWorkspace: (rootPath: string) => Promise<WorkspaceSnapshot>;
  onWorkspaceChanged: (callback: (snapshot: WorkspaceSnapshot) => void) => () => void;
  readFile: (filePath: string) => Promise<string>;
  saveFile: (filePath: string, content: string) => Promise<WorkspaceSnapshot>;
  renameFile: (filePath: string, newName: string) => Promise<{ filePath: string; snapshot: WorkspaceSnapshot }>;
  createFile: (rootPath: string, name: string, content: string) => Promise<{ filePath: string; snapshot: WorkspaceSnapshot }>;
  saveAs: (suggestedName: string, content: string, preferredRootPath: string | null) => Promise<SavedDraft | null>;
  deleteFile: (filePath: string) => Promise<WorkspaceSnapshot>;
  exportFile: (payload: ExportPayload) => Promise<boolean>;
  exportPng: (payload: { suggestedName: string; svg: string; width: number; height: number }) => Promise<boolean>;
  platform: string;
};

declare global {
  interface Window {
    mermaidStudio?: DesktopBridge;
  }
}
