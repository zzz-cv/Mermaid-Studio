import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Code2,
  Download,
  FileCode2,
  FileDown,
  FilePlus2,
  Folder,
  FolderOpen,
  ImageDown,
  Maximize2,
  PanelLeftOpen,
  Save,
  SearchCode,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { lazy, Suspense, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiagramType, FileTreeNode, RecognizedFile, WorkspaceFolderSnapshot, WorkspaceSnapshot } from "./types";

const TEMPLATES: Record<DiagramType, { label: string; short: string; description: string; code: string }> = {
  flowchart: {
    label: "流程图",
    short: "Flowchart",
    description: "业务与系统流程",
    code: `%% type: flowchart\nflowchart LR\n  A[用户请求] --> B[API 网关]\n  B --> C{身份校验}\n  C -- 通过 --> D[业务服务]\n  C -- 失败 --> E[登录页]\n  D --> F[(数据库)]`,
  },
  sequence: {
    label: "时序图",
    short: "Sequence",
    description: "服务调用与时序",
    code: `%% type: sequence\nsequenceDiagram\n  actor User as 用户\n  participant Web as Web 应用\n  participant API as API 服务\n  participant DB as 数据库\n  User->>Web: 提交订单\n  Web->>API: POST /orders\n  API->>DB: 创建订单\n  DB-->>API: 订单 ID\n  API-->>Web: 201 Created\n  Web-->>User: 显示成功页`,
  },
  class: {
    label: "类图",
    short: "Class",
    description: "领域模型与类关系",
    code: `%% type: class\nclassDiagram\n  class User {\n    +String id\n    +String email\n    +login()\n  }\n  class Order {\n    +String id\n    +Decimal total\n    +submit()\n  }\n  User "1" --> "*" Order : creates`,
  },
  state: {
    label: "状态图",
    short: "State",
    description: "对象生命周期",
    code: `%% type: state\nstateDiagram-v2\n  [*] --> WAITING: 创建商单批次\n  WAITING --> PASS: 审核通过\n  WAITING --> NOPASS: 审核未通过\n  PASS --> [*]\n  NOPASS --> [*]`,
  },
  er: {
    label: "ER 图",
    short: "ER Diagram",
    description: "数据模型与关联",
    code: `%% type: er\nerDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ ORDER_ITEM : contains\n  PRODUCT ||--o{ ORDER_ITEM : includes\n  USER {\n    string id PK\n    string email UK\n  }\n  ORDER {\n    string id PK\n    string user_id FK\n    decimal total\n  }`,
  },
  gantt: {
    label: "甘特图",
    short: "Gantt",
    description: "迭代计划与里程碑",
    code: `%% type: gantt\ngantt\n  title 软件迭代计划\n  dateFormat YYYY-MM-DD\n  section 设计\n  需求分析 :done, a1, 2026-08-01, 5d\n  架构设计 :active, a2, after a1, 6d\n  section 交付\n  核心开发 :a3, after a2, 12d\n  测试发布 :a4, after a3, 5d`,
  },
};

const TYPE_ORDER = Object.keys(TEMPLATES) as DiagramType[];
const MermaidCodeEditor = lazy(() => import("./MermaidCodeEditor"));

type ActiveFile = {
  path: string | null;
  name: string;
  content: string;
  dirty: boolean;
  savedType: DiagramType | null;
  rootPath: string | null;
  typeLocked: boolean;
};

type ToastState = { message: string; kind: "success" | "error" };
type UnsavedSwitchState = { fileName: string };

function humanizeError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const message = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:Error:\s*)+/i, "")
    .trim();
  return message || fallback;
}

function getSvgMetrics(svg: string) {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const element = document.documentElement;
  const viewBox = element.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const width = viewBox?.length === 4 && viewBox[2] > 0 ? viewBox[2] : Number.parseFloat(element.getAttribute("width") ?? "") || 900;
  const height = viewBox?.length === 4 && viewBox[3] > 0 ? viewBox[3] : Number.parseFloat(element.getAttribute("height") ?? "") || 600;
  return { width, height };
}

function normalizeSvg(svg: string, width: number, height: number) {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const element = document.documentElement;
  element.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  element.setAttribute("width", String(width));
  element.setAttribute("height", String(height));
  if (!element.hasAttribute("viewBox")) element.setAttribute("viewBox", `0 0 ${width} ${height}`);
  element.style.removeProperty("max-width");
  return new XMLSerializer().serializeToString(element);
}

function detectTypeFromFirstLine(content: string): DiagramType | null {
  const firstLine = content.split(/\r?\n/, 1)[0].trim().toLowerCase();
  const tagged = firstLine.match(/^%%\s*type\s*:\s*(flowchart|sequence|class|state|er|gantt)\s*$/)?.[1] as DiagramType | undefined;
  if (tagged) return tagged;
  if (/^(flowchart|graph)(\s|$)/.test(firstLine)) return "flowchart";
  if (/^sequencediagram(\s|$)/.test(firstLine)) return "sequence";
  if (/^classdiagram(\s|$)/.test(firstLine)) return "class";
  if (/^statediagram(?:-v2)?(\s|$)/.test(firstLine)) return "state";
  if (/^erdiagram(\s|$)/.test(firstLine)) return "er";
  if (/^gantt(\s|$)/.test(firstLine)) return "gantt";
  return null;
}

function fileNameFromPath(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function normalizeMarkdownName(value: string) {
  const candidate = value.trim();
  if (!candidate || candidate === ".md") throw new Error("文件名不能为空");
  if (/[<>:"/\\|?*]/.test(candidate) || candidate === "." || candidate === "..") throw new Error("文件名包含 Windows 不允许的字符");
  const fileName = candidate.toLowerCase().endsWith(".md") ? candidate : `${candidate}.md`;
  if (fileName.length > 180) throw new Error("文件名过长，请缩短后再试");
  return fileName;
}

function relativeDirectory(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : ".";
}

function fileBelongsToRoot(filePath: string, rootPath: string) {
  const file = filePath.replace(/\\/g, "/").toLowerCase();
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return file === root || file.startsWith(`${root}/`);
}

function folderPaths(nodes: FileTreeNode[]): Set<string> {
  const result = new Set<string>();
  const visit = (items: FileTreeNode[]) => items.forEach((item) => {
    if (item.kind === "directory") {
      result.add(item.path);
      visit(item.children ?? []);
    }
  });
  visit(nodes);
  return result;
}

function treeContainsFile(nodes: FileTreeNode[], filePath: string): boolean {
  return nodes.some((node) => node.kind === "file"
    ? node.path === filePath
    : treeContainsFile(node.children ?? [], filePath));
}

function availableDraftRoot(workspace: WorkspaceSnapshot | null, preferredRootPath: string | null) {
  if (preferredRootPath && workspace?.folders.some((folder) => folder.rootPath === preferredRootPath)) return preferredRootPath;
  return workspace?.folders.at(-1)?.rootPath ?? null;
}

function TreeItem({ node, depth, collapsed, onToggle, onOpen, onDeleteRequest, onDeleteConfirm, activePath, deleteTargetPath }: {
  node: FileTreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (node: FileTreeNode) => void;
  onDeleteRequest: (path: string | null) => void;
  onDeleteConfirm: (node: FileTreeNode) => void;
  activePath: string | null;
  deleteTargetPath: string | null;
}) {
  const isDirectory = node.kind === "directory";
  const isCollapsed = collapsed.has(node.path);
  return <>
    <div className={`tree-entry ${activePath === node.path ? "active" : ""}`}>
      <button
        className={`tree-item ${activePath === node.path ? "active" : ""}`}
        style={{ paddingLeft: `${10 + depth * 15}px` }}
        onClick={() => isDirectory ? onToggle(node.path) : onOpen(node)}
        title={node.relativePath}
      >
        <span className={`tree-chevron ${isDirectory && !isCollapsed ? "expanded" : ""}`}>{isDirectory ? <ChevronRight size={14} /> : null}</span>
        {isDirectory ? <Folder size={15} fill="currentColor" /> : <FileCode2 size={15} />}
        <span>{node.name}</span>
      </button>
      {!isDirectory && <button
        className="delete-file"
        aria-label={`删除 ${node.name}`}
        title={`删除 ${node.name}`}
        onClick={() => onDeleteRequest(deleteTargetPath === node.path ? null : node.path)}
      ><Trash2 size={14} /></button>}
    </div>
    {!isDirectory && deleteTargetPath === node.path && <button
      className="delete-file-confirm"
      style={{ paddingLeft: `${28 + depth * 15}px` }}
      onClick={() => onDeleteConfirm(node)}
      title={`确认删除 ${node.name}`}
    ><Trash2 size={14} /><span>确认删除“{node.name}”</span></button>}
    {isDirectory && <div className={`tree-children ${isCollapsed ? "collapsed" : "expanded"}`} aria-hidden={isCollapsed}>
      <div className="tree-children-inner">{node.children?.map((child) => <TreeItem key={child.path} node={child} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} onDeleteRequest={onDeleteRequest} onDeleteConfirm={onDeleteConfirm} activePath={activePath} deleteTargetPath={deleteTargetPath} />)}</div>
    </div>}
  </>;
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [active, setActive] = useState<ActiveFile | null>(null);
  const [draftRootPath, setDraftRootPath] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState(0);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [collapsedTypes, setCollapsedTypes] = useState<Set<DiagramType>>(new Set());
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [svg, setSvg] = useState("");
  const [renderError, setRenderError] = useState("");
  const [rendering, setRendering] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("new-diagram.md");
  const [newFileType, setNewFileType] = useState<DiagramType | "none">("none");
  const [createRootPath, setCreateRootPath] = useState("");
  const [unsavedSwitch, setUnsavedSwitch] = useState<UnsavedSwitchState | null>(null);
  const [saveFolderDialogOpen, setSaveFolderDialogOpen] = useState(false);
  const [saveFolderPath, setSaveFolderPath] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [removeTarget, setRemoveTarget] = useState<WorkspaceFolderSnapshot | null>(null);
  const [deleteTargetPath, setDeleteTargetPath] = useState<string | null>(null);
  const [editorFontSize, setEditorFontSize] = useState(14);
  const [fitScale, setFitScale] = useState(1);
  const [diagramSize, setDiagramSize] = useState({ width: 900, height: 600 });
  const [toast, setToast] = useState<ToastState | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const renderCounter = useRef(0);
  const lastSidebarWidth = useRef(270);
  const lastPreviewWidth = useRef(540);
  const saveActiveRef = useRef<() => Promise<boolean>>(async () => false);
  const pendingSwitchRef = useRef<(() => Promise<void>) | null>(null);
  const saveFolderResolverRef = useRef<((rootPath: string | null) => void) | null>(null);
  const renameCommitRef = useRef<Promise<boolean> | null>(null);
  const fitNextRender = useRef(true);
  const activeType = active ? detectTypeFromFirstLine(active.content) : null;
  const bridge = window.mermaidStudio;

  const grouped = useMemo(() => {
    const result = {} as Record<DiagramType, RecognizedFile[]>;
    TYPE_ORDER.forEach((type) => { result[type] = workspace?.recognized.filter((file) => file.type === type) ?? []; });
    return result;
  }, [workspace]);

  const showToast = useCallback((message: string, kind: ToastState["kind"] = "success") => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), kind === "error" ? 4200 : 2400);
  }, []);

  const requestSwitch = useCallback((action: () => Promise<void>) => {
    if (active?.dirty) {
      pendingSwitchRef.current = action;
      setUnsavedSwitch({ fileName: active.name });
      return;
    }
    void action();
  }, [active]);

  const chooseSaveFolder = useCallback((folders: WorkspaceFolderSnapshot[], preferredRootPath: string | null) => {
    return new Promise<string | null>((resolve) => {
      saveFolderResolverRef.current?.(null);
      saveFolderResolverRef.current = resolve;
      const preferred = preferredRootPath && folders.some((folder) => folder.rootPath === preferredRootPath)
        ? preferredRootPath
        : folders[0]?.rootPath ?? "";
      setSaveFolderPath(preferred);
      setSaveFolderDialogOpen(true);
    });
  }, []);

  const finishSaveFolderSelection = useCallback((rootPath: string | null) => {
    const resolve = saveFolderResolverRef.current;
    saveFolderResolverRef.current = null;
    setSaveFolderDialogOpen(false);
    resolve?.(rootPath);
  }, []);

  const fitDiagram = useCallback((metrics: { width: number; height: number }) => {
    const canvas = previewRef.current;
    if (!canvas || metrics.width <= 0 || metrics.height <= 0) return;
    const availableWidth = Math.max(120, canvas.clientWidth - 38);
    const availableHeight = Math.max(120, canvas.clientHeight - 38);
    setFitScale(Math.min(availableWidth / metrics.width, availableHeight / metrics.height));
    setZoom(100);
    canvas.scrollTo({ left: 0, top: 0 });
  }, []);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const wheel = (event: globalThis.WheelEvent) => {
      if (!svg || renderError) return;
      event.preventDefault();
      event.stopPropagation();
      setZoom((current) => Math.max(25, Math.min(1600, current + (event.deltaY > 0 ? -10 : 10))));
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [svg, renderError]);

  useEffect(() => {
    if (!active?.content) {
      setSvg("");
      setRenderError("");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setRendering(true);
      try {
        const module = await import("mermaid");
        module.default.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "base",
          fontFamily: "Inter, 'Microsoft YaHei', system-ui, sans-serif",
          themeVariables: {
            primaryColor: "#eef5f0",
            primaryBorderColor: "#6f927f",
            primaryTextColor: "#1f2d26",
            lineColor: "#718c7d",
            secondaryColor: "#f7f3e9",
            tertiaryColor: "#f7f9f7",
            clusterBkg: "#f7f9f7",
            clusterBorder: "#dfe6e1",
          },
          flowchart: { curve: "basis", htmlLabels: true },
        });
        const result = await module.default.render(`mermaid-studio-${renderCounter.current++}`, active.content);
        if (!cancelled) {
          const metrics = getSvgMetrics(result.svg);
          setSvg(result.svg);
          setDiagramSize(metrics);
          setRenderError("");
          if (fitNextRender.current) {
            fitNextRender.current = false;
            window.requestAnimationFrame(() => fitDiagram(metrics));
          }
        }
      } catch (error) {
        if (!cancelled) setRenderError(error instanceof Error ? error.message.split("\n").slice(0, 4).join("\n") : "Mermaid 语法无法解析");
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 220);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [active?.content, active?.path, fitDiagram]);

  const performOpenWorkspace = useCallback(async () => {
    if (!bridge) return showToast("请在 Mermaid Studio 桌面应用中打开文件夹");
    try {
      const next = await bridge.openWorkspace();
      if (!next) return;
      setWorkspace(next);
      setActive(null);
      setDraftRootPath(next.folders.at(-1)?.rootPath ?? null);
      setViewVersion((value) => value + 1);
      setDeleteTargetPath(null);
      fitNextRender.current = true;
      setCollapsedFolders((current) => {
        const result = new Set(current);
        next.folders.forEach((folder) => folderPaths(folder.tree).forEach((item) => result.add(item)));
        return result;
      });
      setSidebarHidden(false);
      workspaceRef.current?.style.setProperty("--sidebar-width", `${Math.max(lastSidebarWidth.current, 250)}px`);
      showToast(`已打开 ${next.folders.length} 个项目文件夹，识别到 ${next.recognized.length} 个图表文件`);
    } catch (error) {
      showToast(humanizeError(error, "打开文件夹失败"), "error");
    }
  }, [bridge, showToast]);

  const openWorkspace = useCallback(() => {
    requestSwitch(performOpenWorkspace);
  }, [performOpenWorkspace, requestSwitch]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onWorkspaceChanged((next) => {
      setWorkspace(next);
      setDeleteTargetPath((current) => current && next.folders.some((folder) => fileBelongsToRoot(current, folder.rootPath)) ? current : null);
      setDraftRootPath((current) => availableDraftRoot(next, current));
      if (active?.path) {
        const root = next.folders.find((folder) => fileBelongsToRoot(active.path!, folder.rootPath));
        if (!root || !treeContainsFile(root.tree, active.path)) {
          setDraftRootPath(availableDraftRoot(next, active.rootPath));
          setActive((current) => current?.path === active.path ? null : current);
          setViewVersion((value) => value + 1);
        }
      }
    });
  }, [active?.path, active?.rootPath, bridge]);

  const confirmRemoveWorkspace = async () => {
    if (!bridge || !removeTarget) return;
    try {
      const next = await bridge.removeWorkspace(removeTarget.rootPath);
      setWorkspace(next);
      setDraftRootPath((current) => availableDraftRoot(next, current === removeTarget.rootPath ? null : current));
      if (active?.rootPath === removeTarget.rootPath) {
        setActive(null);
        setViewVersion((value) => value + 1);
      }
      setCollapsedFolders((current) => {
        const result = new Set(current);
        result.delete(removeTarget.rootPath);
        return result;
      });
      showToast(`已从工作区移除 ${removeTarget.rootName}`, "error");
      setRemoveTarget(null);
    } catch (error) {
      showToast(humanizeError(error, "移除文件夹失败"), "error");
    }
  };

  const commitRename = useCallback((): Promise<boolean> => {
    if (renameCommitRef.current) return renameCommitRef.current;
    if (!active || !renaming) return Promise.resolve(true);
    const task = (async () => {
      try {
        const newName = normalizeMarkdownName(renameValue);
        if (newName === active.name) {
          setRenaming(false);
          return true;
        }
        if (active.path) {
          if (!bridge) return false;
          const result = await bridge.renameFile(active.path, newName);
          setWorkspace(result.snapshot);
          setActive((current) => current?.path === active.path
            ? { ...current, path: result.filePath, name: fileNameFromPath(result.filePath) }
            : current);
          showToast(`已重命名为 ${fileNameFromPath(result.filePath)}`);
        } else {
          setActive((current) => current ? { ...current, name: newName, dirty: true } : current);
        }
        setRenameValue(newName);
        setRenaming(false);
        return true;
      } catch (error) {
        showToast(humanizeError(error, "修改文件名失败"), "error");
        return false;
      }
    })();
    renameCommitRef.current = task;
    void task.finally(() => { renameCommitRef.current = null; });
    return task;
  }, [active, bridge, renameValue, renaming, showToast]);

  const beginRename = useCallback(() => {
    if (!active) return;
    setRenameValue(active.name);
    setRenaming(true);
  }, [active]);

  const performOpenFile = useCallback(async (node: Pick<FileTreeNode, "path" | "name">) => {
    if (!bridge) return;
    try {
      const content = await bridge.readFile(node.path);
      const rootPath = workspace?.folders.find((folder) => fileBelongsToRoot(node.path, folder.rootPath))?.rootPath ?? null;
      const savedType = detectTypeFromFirstLine(content);
      fitNextRender.current = true;
      setDraftRootPath(rootPath);
      setActive({ path: node.path, name: node.name, content, dirty: false, savedType, rootPath, typeLocked: Boolean(savedType) });
      setViewVersion((value) => value + 1);
      setZoom(100);
    } catch (error) {
      showToast(humanizeError(error, "读取文件失败"), "error");
    }
  }, [bridge, showToast, workspace]);

  const openFile = useCallback(async (node: Pick<FileTreeNode, "path" | "name">) => {
    if (active?.path === node.path && !renaming) return;
    if (!(await commitRename())) return;
    requestSwitch(() => performOpenFile(node));
  }, [active?.path, commitRename, performOpenFile, renaming, requestSwitch]);

  const saveActive = useCallback(async (): Promise<boolean> => {
    if (!active || !bridge || renaming) return false;
    try {
      if (active.path) {
        const next = await bridge.saveFile(active.path, active.content);
        setWorkspace(next);
        setActive((current) => { const savedType = current ? detectTypeFromFirstLine(current.content) : null; return current ? { ...current, dirty: false, savedType, typeLocked: Boolean(savedType) } : current; });
        showToast(`已保存 ${active.name}`);
      } else {
        const folders = workspace?.folders ?? [];
        let preferredRootPath = availableDraftRoot(workspace, active.rootPath ?? draftRootPath);
        if (folders.length > 1) {
          preferredRootPath = await chooseSaveFolder(folders, preferredRootPath);
          if (!preferredRootPath) return false;
        }
        const result = await bridge.saveAs(active.name, active.content, preferredRootPath);
        if (!result) return false;
        setWorkspace(result.snapshot);
        setCollapsedFolders((current) => {
          const next = new Set(current);
          next.delete(result.rootPath);
          result.snapshot.folders.forEach((folder) => folderPaths(folder.tree).forEach((item) => next.add(item)));
          return next;
        });
        setSidebarHidden(false);
        setDraftRootPath(result.rootPath);
        workspaceRef.current?.style.setProperty("--sidebar-width", `${Math.max(lastSidebarWidth.current, 250)}px`);
        setActive((current) => { const savedType = current ? detectTypeFromFirstLine(current.content) : null; return current ? { ...current, path: result.filePath, name: fileNameFromPath(result.filePath), dirty: false, savedType, rootPath: result.rootPath, typeLocked: Boolean(savedType) } : current; });
        showToast(`已保存 ${fileNameFromPath(result.filePath)}`);
      }
      return true;
    } catch (error) {
      showToast(humanizeError(error, "保存失败"), "error");
      return false;
    }
  }, [active, bridge, chooseSaveFolder, draftRootPath, renaming, showToast, workspace]);

  useEffect(() => {
    saveActiveRef.current = saveActive;
  }, [saveActive]);

  const cancelPendingSwitch = useCallback(() => {
    pendingSwitchRef.current = null;
    setUnsavedSwitch(null);
  }, []);

  const discardAndSwitch = useCallback(async () => {
    const action = pendingSwitchRef.current;
    pendingSwitchRef.current = null;
    setUnsavedSwitch(null);
    if (action) await action();
  }, []);

  const saveAndSwitch = useCallback(async () => {
    const action = pendingSwitchRef.current;
    setUnsavedSwitch(null);
    const saved = await saveActive();
    if (!saved) {
      setUnsavedSwitch({ fileName: active?.name ?? "当前文件" });
      return;
    }
    pendingSwitchRef.current = null;
    if (action) await action();
  }, [active?.name, saveActive]);

  useEffect(() => () => {
    saveFolderResolverRef.current?.(null);
    saveFolderResolverRef.current = null;
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActive();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveActive]);

  const createFile = () => {
    if (!bridge || !workspace?.folders.length) return showToast("请先打开一个项目文件夹", "error");
    setNewFileName("new-diagram.md");
    setNewFileType("none");
    setCreateRootPath(availableDraftRoot(workspace, active?.rootPath ?? draftRootPath) ?? "");
    setCreateDialogOpen(true);
  };

  const performCreateFile = useCallback(async () => {
    if (!bridge || !workspace || !createRootPath || !newFileName.trim()) return;
    try {
      const selectedType = newFileType === "none" ? null : newFileType;
      const result = await bridge.createFile(createRootPath, newFileName.trim(), selectedType ? TEMPLATES[selectedType].code : "");
      setWorkspace(result.snapshot);
      await performOpenFile({ path: result.filePath, name: fileNameFromPath(result.filePath) });
      setActive((current) => current ? { ...current, savedType: selectedType, typeLocked: Boolean(selectedType) } : current);
      setCreateDialogOpen(false);
      showToast(`已创建 ${fileNameFromPath(result.filePath)}`);
    } catch (error) {
      const message = humanizeError(error, "创建文件失败");
      showToast(message, "error");
    }
  }, [bridge, createRootPath, newFileName, newFileType, performOpenFile, showToast, workspace]);

  const confirmCreateFile = useCallback(() => {
    if (active?.dirty) {
      setCreateDialogOpen(false);
      requestSwitch(performCreateFile);
      return;
    }
    void performCreateFile();
  }, [active?.dirty, performCreateFile, requestSwitch]);

  const deleteFile = async (node: Pick<FileTreeNode, "path" | "name">) => {
    if (!bridge) return;
    try {
      const next = await bridge.deleteFile(node.path);
      setWorkspace(next);
      setDeleteTargetPath(null);
      if (active?.path === node.path) {
        setDraftRootPath(active.rootPath);
        setActive(null);
        setViewVersion((value) => value + 1);
      }
      showToast(`已删除 ${node.name}`);
    } catch (error) {
      showToast(humanizeError(error, "删除文件失败"), "error");
    }
  };

  const selectTemplate = (type: DiagramType) => {
    if (active?.typeLocked) return;
    fitNextRender.current = true;
    if (active) {
      const name = !active.path && /^untitled-(flowchart|sequence|class|state|er|gantt)\.md$/i.test(active.name)
        ? `untitled-${type}.md`
        : active.name;
      setActive({ ...active, name, content: TEMPLATES[type].code, dirty: true });
    }
    else setActive({ path: null, name: `untitled-${type}.md`, content: TEMPLATES[type].code, dirty: true, savedType: null, rootPath: availableDraftRoot(workspace, draftRootPath), typeLocked: false });
    setViewVersion((value) => value + 1);
    setZoom(100);
  };

  const exportContent = async (type: "svg" | "png" | "md") => {
    if (!active || !bridge) return;
    const baseName = active.name.replace(/\.md$/i, "");
    try {
      const exportWidth = Math.max(1, Math.ceil(diagramSize.width));
      const exportHeight = Math.max(1, Math.ceil(diagramSize.height));
      const completeSvg = normalizeSvg(svg, exportWidth, exportHeight);
      if (type === "svg") {
        await bridge.exportFile({ suggestedName: `${baseName}.svg`, data: completeSvg, encoding: "utf8", type });
      } else if (type === "md") {
        await bridge.exportFile({ suggestedName: `${baseName}.md`, data: active.content, encoding: "utf8", type });
      } else {
        await bridge.exportPng({ suggestedName: `${baseName}.png`, svg: completeSvg, width: exportWidth, height: exportHeight });
      }
      setExportOpen(false);
    } catch (error) {
      showToast(humanizeError(error, "导出失败"), "error");
    }
  };

  const copySvg = async () => {
    if (!svg) return;
    await navigator.clipboard.writeText(svg);
    setExportOpen(false);
    showToast("SVG 代码已复制");
  };

  const startColumnResize = (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const workspaceElement = workspaceRef.current;
    if (!workspaceElement) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = workspaceElement.getBoundingClientRect();
    const styles = getComputedStyle(workspaceElement);
    const leftStart = Number.parseFloat(styles.getPropertyValue("--sidebar-width")) || 0;
    const rightStart = Number.parseFloat(styles.getPropertyValue("--preview-width")) || workspaceElement.querySelector<HTMLElement>(".preview-panel")?.getBoundingClientRect().width || 0;
    const startX = event.clientX;
    let frame = 0;
    let latest = side === "left" ? leftStart : rightStart;
    document.body.classList.add("is-resizing");

    const apply = () => {
      workspaceElement.style.setProperty(side === "left" ? "--sidebar-width" : "--preview-width", `${latest}px`);
      frame = 0;
    };
    const move = (pointer: PointerEvent) => {
      const delta = pointer.clientX - startX;
      if (side === "left") latest = Math.max(0, Math.min(rect.width - rightStart - 12, leftStart + delta));
      else latest = Math.max(0, Math.min(rect.width - leftStart - 12, rightStart - delta));
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const stop = () => {
      if (frame) { cancelAnimationFrame(frame); apply(); }
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      if (side === "left") {
        if (latest > 24) lastSidebarWidth.current = latest;
        setSidebarHidden(latest <= 24);
      } else if (latest > 24) lastPreviewWidth.current = latest;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const startRowResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = panel.getBoundingClientRect();
    let frame = 0;
    const resizerHeight = event.currentTarget.getBoundingClientRect().height;
    const minTreeHeight = 46;
    const minClassificationHeight = 42;
    const minPercent = (minTreeHeight / rect.height) * 100;
    const maxPercent = ((rect.height - resizerHeight - minClassificationHeight) / rect.height) * 100;
    let latest = Number.parseFloat(getComputedStyle(panel).getPropertyValue("--tree-height")) || 58;
    document.body.classList.add("is-resizing");
    const apply = () => { panel.style.setProperty("--tree-height", `${latest}%`); frame = 0; };
    const move = (pointer: PointerEvent) => {
      latest = Math.max(minPercent, Math.min(maxPercent, ((pointer.clientY - rect.top) / rect.height) * 100));
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const stop = () => {
      if (frame) { cancelAnimationFrame(frame); apply(); }
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const toggleSidebar = () => {
    const element = workspaceRef.current;
    if (!element) return;
    const current = Number.parseFloat(getComputedStyle(element).getPropertyValue("--sidebar-width")) || 0;
    if (current > 24) {
      lastSidebarWidth.current = current;
      element.style.setProperty("--sidebar-width", "0px");
      setSidebarHidden(true);
    } else {
      element.style.setProperty("--sidebar-width", `${Math.max(230, lastSidebarWidth.current)}px`);
      setSidebarHidden(false);
    }
  };

  const startPreviewPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !svg) return;
    const canvas = event.currentTarget;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = canvas.scrollLeft;
    const startTop = canvas.scrollTop;
    canvas.classList.add("is-panning");
    const move = (pointer: PointerEvent) => {
      canvas.scrollLeft = startLeft - (pointer.clientX - startX);
      canvas.scrollTop = startTop - (pointer.clientY - startY);
    };
    const stop = () => {
      canvas.classList.remove("is-panning");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const typeLocked = Boolean(active?.typeLocked && active.savedType);
  const displayedType = typeLocked ? active?.savedType : activeType;
  const renderedWidth = Math.max(1, diagramSize.width * fitScale * (zoom / 100));
  const renderedHeight = Math.max(1, diagramSize.height * fitScale * (zoom / 100));

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><Braces size={22} strokeWidth={2.4} /></div>
      <div className="brand-copy"><strong>Mermaid Studio</strong><span>本地软件工程绘图</span></div>
      <nav className="diagram-tabs" aria-label="图表类型">
        {TYPE_ORDER.map((type) => <button key={type} disabled={typeLocked} className={`${displayedType === type ? "active" : ""} ${typeLocked && displayedType === type ? "locked" : ""}`} onClick={() => selectTemplate(type)} title={typeLocked ? `已按保存内容固定为${TEMPLATES[active!.savedType!].label}，修改首行并保存后会自动更新` : TEMPLATES[type].description}>{TEMPLATES[type].label}</button>)}
      </nav>
      <div className="header-actions">
        <button className="save-button" onClick={() => void saveActive()} disabled={!active || renaming}><Save size={17} />保存</button>
        <div className="export-wrap">
          <button className="primary-button" onClick={() => setExportOpen((value) => !value)} disabled={!active || !!renderError}><Download size={17} />导出<ChevronDown size={15} /></button>
          {exportOpen && <div className="export-menu">
            <button onClick={() => void exportContent("svg")}><FileDown size={18} /><span><b>导出 SVG</b><small>矢量图，适合文档与二次编辑</small></span></button>
            <button onClick={() => void exportContent("png")}><ImageDown size={18} /><span><b>导出 PNG</b><small>2× 高清图片</small></span></button>
            <button onClick={() => void exportContent("md")}><FileCode2 size={18} /><span><b>导出 Markdown</b><small>保留 Mermaid 源码</small></span></button>
            <button onClick={() => void copySvg()}><Clipboard size={18} /><span><b>复制 SVG 代码</b><small>用于其他项目</small></span></button>
          </div>}
        </div>
      </div>
    </header>

    <section ref={workspaceRef} className="workspace">
      <aside className="file-panel">
        <section className="tree-section">
          <div className="panel-heading">
            <span>项目文件</span>
            <div>
              <button onClick={() => void openWorkspace()} title="添加文件夹"><FolderOpen size={16} /></button>
              <button onClick={createFile} title="新建 MD 文件" disabled={!workspace?.folders.length}><FilePlus2 size={16} /></button>
            </div>
          </div>
          {workspace && workspace.folders.length > 0 ? <div className="tree-list workspace-tree-list">
            {workspace.folders.map((folder) => <div className="root-group" key={folder.rootPath}>
              <div className="root-folder-row"><button className="root-folder" onClick={() => setCollapsedFolders((current) => {
                const next = new Set(current);
                if (next.has(folder.rootPath)) next.delete(folder.rootPath);
                else next.add(folder.rootPath);
                return next;
              })} title={folder.rootPath}>
                <span className={`root-chevron ${collapsedFolders.has(folder.rootPath) ? "" : "expanded"}`}><ChevronRight size={15} /></span><Folder size={16} fill="currentColor" /><span>{folder.rootName}</span>
              </button><button className="remove-root" onClick={() => setRemoveTarget(folder)} title={`从工作区移除 ${folder.rootName}`}><Trash2 size={15} /></button></div>
              <div className={`tree-children root-tree-children ${collapsedFolders.has(folder.rootPath) ? "collapsed" : "expanded"}`} aria-hidden={collapsedFolders.has(folder.rootPath)}><div className="tree-children-inner">{folder.tree.map((node) => <TreeItem key={node.path} node={node} depth={0} collapsed={collapsedFolders} onToggle={(path) => setCollapsedFolders((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })} onOpen={(file) => void openFile(file)} onDeleteRequest={setDeleteTargetPath} onDeleteConfirm={(file) => void deleteFile(file)} activePath={active?.path ?? null} deleteTargetPath={deleteTargetPath} />)}</div></div>
            </div>)}
          </div> : <div className="folder-empty"><FolderOpen size={31} /><p>尚未打开项目文件夹</p><button onClick={() => void openWorkspace()}>选择文件夹</button></div>}
        </section>

        <div className="row-resizer" onPointerDown={startRowResize} title="拖动调整上下区域"><span /></div>

        <section className="classification-section">
          <div className="classification-title"><span>图表分类</span>{workspace && workspace.folders.length > 0 && <small>{workspace.recognized.length} 个已识别</small>}</div>
          {!workspace?.folders.length ? <div className="classification-empty"><SearchCode size={24} /><span>打开文件夹后自动识别</span></div> : workspace.recognized.length === 0 ? <div className="classification-empty"><SearchCode size={24} /><span>未识别到带类型首行的 MD 文件</span></div> : <div className="classification-list">
            {TYPE_ORDER.map((type) => grouped[type].length > 0 && <div className="classification-group" key={type}>
              <button className="classification-row" onClick={() => setCollapsedTypes((current) => { const next = new Set(current); if (next.has(type)) next.delete(type); else next.add(type); return next; })}>
                {collapsedTypes.has(type) ? <ChevronRight size={15} /> : <ChevronDown size={15} />}<span>{TEMPLATES[type].label}</span><b>{grouped[type].length}</b>
              </button>
              {!collapsedTypes.has(type) && grouped[type].map((file) => <button key={file.path} className={`classified-file ${active?.path === file.path ? "active" : ""}`} onClick={() => void openFile({ path: file.path, name: file.name })} title={`${file.rootName} / ${file.relativePath}`}><FileCode2 size={14} /><span className="classified-name">{file.name}</span><span className="classified-path">{file.rootName} / {relativeDirectory(file.relativePath)}</span></button>)}
            </div>)}
          </div>}
        </section>
      </aside>

      <button className={`sidebar-restore ${sidebarHidden ? "visible" : ""}`} onClick={toggleSidebar} title="展开文件区"><PanelLeftOpen size={17} /></button>
      <div className="column-resizer" onPointerDown={(event) => startColumnResize("left", event)} onDoubleClick={toggleSidebar}><span /></div>

      <section className="editor-panel">
        <div className="pane-title">
          <div className="file-title"><FileCode2 size={17} />{renaming && active
            ? <input className="file-name-input" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onFocus={(event) => event.currentTarget.select()} onBlur={() => void commitRename()} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === "Escape") { event.preventDefault(); setRenameValue(active.name); setRenaming(false); }
            }} aria-label="修改文件名" />
            : <span className={active ? "renamable-file-name" : ""} onDoubleClick={beginRename} title={active ? "双击修改文件名" : undefined}>{active?.name ?? "未打开文件"}</span>}{active?.dirty && <em>未保存</em>}</div>
          <div className="editor-meta"><Code2 size={15} /><span>代码字号</span><select aria-label="代码字号" value={editorFontSize} onChange={(event) => setEditorFontSize(Number(event.target.value))}>{[12, 14, 16, 18, 20, 22, 24].map((size) => <option key={size} value={size}>{size}px</option>)}</select></div>
        </div>
        {active ? <>
          <div className="monaco-wrap" key={`editor-${viewVersion}`}><Suspense fallback={<div className="editor-loading">正在载入离线代码编辑器…</div>}><MermaidCodeEditor value={active.content} fontSize={editorFontSize} onSave={() => void saveActiveRef.current()} onChange={(value) => setActive((current) => current ? { ...current, content: value, dirty: true } : current)} /></Suspense></div>
          <footer className="statusbar"><span><span className={`status-dot ${renderError ? "error" : ""}`} />{renderError ? "语法错误" : rendering ? "正在编译" : "图表已同步"}</span><span>UTF-8 · {activeType ? TEMPLATES[activeType].short : "未识别类型"}</span></footer>
        </> : <div className="empty-editor"><Code2 size={33} /><h2>选择一个 Markdown 文件</h2><p>从左侧目录树打开文件，或点击顶部图表类型创建一份临时草稿。</p></div>}
      </section>

      <div className="column-resizer" onPointerDown={(event) => startColumnResize("right", event)}><span /></div>

      <section className="preview-panel">
        <div className="pane-title">
          <div className="preview-title"><span>实时预览</span>{active && !renderError && <small><Check size={13} />已同步</small>}</div>
          <div className="preview-hint">{rendering ? "编译中…" : activeType ? TEMPLATES[activeType].description : "滚轮缩放 · 按住拖动画布"}</div>
        </div>
        <div ref={previewRef} className="preview-canvas" onPointerDown={startPreviewPan}>
          <div className="preview-view" key={`preview-${viewVersion}`}>
            {!active ? <div className="render-placeholder"><Braces size={31} /><span>打开或创建文件后在此预览</span></div> : renderError ? <div className="error-card"><CircleAlert size={25} /><div><b>Mermaid 语法需要修正</b><pre>{renderError}</pre></div></div> : svg ? <div className="diagram-scroll-space"><div className="diagram-stage" style={{ width: `${renderedWidth}px`, height: `${renderedHeight}px` }} dangerouslySetInnerHTML={{ __html: svg }} /></div> : <div className="render-placeholder"><Braces size={31} /><span>正在准备预览…</span></div>}
          </div>
        </div>
        <div className="zoom-controls">
          <button onClick={() => setZoom((value) => Math.max(25, value - 10))} title="缩小"><ZoomOut size={17} /></button>
          <button className="zoom-value" onClick={() => fitDiagram(diagramSize)} title="按窗口完整显示">{zoom}%</button>
          <button onClick={() => setZoom((value) => Math.min(1600, value + 10))} title="放大"><ZoomIn size={17} /></button>
          <i />
          <button onClick={() => fitDiagram(diagramSize)} title="完整显示整张图"><Maximize2 size={16} /></button>
        </div>
      </section>
    </section>
    {unsavedSwitch && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelPendingSwitch(); }}>
      <div className="create-dialog unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-switch-title">
        <div className="create-dialog-icon"><Save size={20} /></div>
        <div><h2 id="unsaved-switch-title">保存“{unsavedSwitch.fileName}”吗？</h2><p>切换后，未保存的修改将无法恢复。</p></div>
        <div className="dialog-actions three-actions"><button type="button" onClick={cancelPendingSwitch}>取消</button><button type="button" className="discard-action" onClick={() => void discardAndSwitch()}>不保存并切换</button><button type="button" className="primary-action" onClick={() => void saveAndSwitch()}>保存并切换</button></div>
      </div>
    </div>}
    {saveFolderDialogOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) finishSaveFolderSelection(null); }}>
      <div className="create-dialog save-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="save-folder-title">
        <div className="create-dialog-icon"><FolderOpen size={20} /></div>
        <div><h2 id="save-folder-title">选择保存文件夹</h2><p>当前打开了多个项目，请明确选择草稿要保存到哪里。</p></div>
        <label htmlFor="draft-save-folder">目标项目文件夹</label>
        <select id="draft-save-folder" autoFocus value={saveFolderPath} onChange={(event) => setSaveFolderPath(event.target.value)}>{workspace?.folders.map((folder) => <option key={folder.rootPath} value={folder.rootPath}>{folder.rootName} — {folder.rootPath}</option>)}</select>
        <div className="dialog-actions"><button type="button" onClick={() => finishSaveFolderSelection(null)}>取消</button><button type="button" className="primary-action" disabled={!saveFolderPath} onClick={() => finishSaveFolderSelection(saveFolderPath)}>保存到这里</button></div>
      </div>
    </div>}
    {removeTarget && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRemoveTarget(null); }}>
      <div className="create-dialog remove-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-folder-title">
        <div className="create-dialog-icon danger"><Trash2 size={20} /></div>
        <div><h2 id="remove-folder-title">移除“{removeTarget.rootName}”吗？</h2></div>
        {active?.rootPath === removeTarget.rootPath && active.dirty && <div className="remove-warning"><CircleAlert size={17} />当前文件尚未保存，移除后编辑区将关闭。</div>}
        <div className="dialog-actions"><button type="button" onClick={() => setRemoveTarget(null)}>取消</button><button type="button" className="danger-action" onClick={() => void confirmRemoveWorkspace()}>确认移除</button></div>
      </div>
    </div>}
    {createDialogOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateDialogOpen(false); }}>
      <form className="create-dialog" onSubmit={(event) => { event.preventDefault(); void confirmCreateFile(); }}>
        <div className="create-dialog-icon"><FilePlus2 size={20} /></div>
        <div><h2>新建 Mermaid 文件</h2><p>文件将创建在所选项目的根目录。</p></div>
        {(workspace?.folders.length ?? 0) > 1 && <><label htmlFor="new-file-folder">目标文件夹</label><select id="new-file-folder" value={createRootPath} onChange={(event) => setCreateRootPath(event.target.value)}>{workspace?.folders.map((folder) => <option key={folder.rootPath} value={folder.rootPath}>{folder.rootName} — {folder.rootPath}</option>)}</select></>}
        <label htmlFor="new-file-type">图表类型</label>
        <select id="new-file-type" value={newFileType} onChange={(event) => setNewFileType(event.target.value as DiagramType | "none")}>
          <option value="none">无 · 创建后再选择</option>
          {TYPE_ORDER.map((type) => <option key={type} value={type}>{TEMPLATES[type].label} · {TEMPLATES[type].short}</option>)}
        </select>
        <label htmlFor="new-file-name">文件名</label>
        <input id="new-file-name" autoFocus value={newFileName} onChange={(event) => setNewFileName(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
        <div className="dialog-actions"><button type="button" onClick={() => setCreateDialogOpen(false)}>取消</button><button type="submit" disabled={!newFileName.trim()}>创建文件</button></div>
      </form>
    </div>}
    {toast && <div className={`toast ${toast.kind}`} role="alert">{toast.kind === "error" ? <CircleAlert size={18} /> : <Check size={17} />}{toast.message}</div>}
  </main>;
}
