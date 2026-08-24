const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const fsNative = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DEVELOPMENT_URL = "http://127.0.0.1:5173";
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "release", ".next", ".vinext", ".wrangler"]);
const workspaceRoots = [];
const allowedDetachedFiles = new Set();
const workspaceWatchers = new Map();
let workspaceRefreshTimer = null;
let workspaceRefreshRunning = false;
let workspaceRefreshQueued = false;

function isInsideRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isAllowedFile(targetPath) {
  return allowedDetachedFiles.has(path.resolve(targetPath)) || workspaceRoots.some((rootPath) => isInsideRoot(rootPath, targetPath));
}

function diagramTypeFromFirstLine(content) {
  const firstLine = content.split(/\r?\n/, 1)[0].trim().toLowerCase();
  const tagged = firstLine.match(/^%%\s*type\s*:\s*(flowchart|sequence|class|state|er|gantt)\s*$/)?.[1];
  if (tagged) return tagged;
  if (/^(flowchart|graph)(\s|$)/.test(firstLine)) return "flowchart";
  if (/^sequencediagram(\s|$)/.test(firstLine)) return "sequence";
  if (/^classdiagram(\s|$)/.test(firstLine)) return "class";
  if (/^statediagram(?:-v2)?(\s|$)/.test(firstLine)) return "state";
  if (/^erdiagram(\s|$)/.test(firstLine)) return "er";
  if (/^gantt(\s|$)/.test(firstLine)) return "gantt";
  return null;
}

async function scanDirectory(directoryPath, rootPath, rootName, relativePath = "", counter = { value: 0 }) {
  if (counter.value > 3000) return { tree: [], recognized: [] };
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const tree = [];
  const recognized = [];

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
  });

  for (const entry of entries) {
    if (counter.value++ > 3000) break;
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;

    const absolutePath = path.join(directoryPath, entry.name);
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      const result = await scanDirectory(absolutePath, rootPath, rootName, childRelativePath, counter);
      if (result.tree.length === 0) continue;
      tree.push({ kind: "directory", name: entry.name, path: absolutePath, relativePath: childRelativePath, children: result.tree });
      recognized.push(...result.recognized);
      continue;
    }

    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    tree.push({ kind: "file", name: entry.name, path: absolutePath, relativePath: childRelativePath });
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const type = diagramTypeFromFirstLine(content);
      if (type) {
        const stat = await fs.stat(absolutePath);
        recognized.push({ path: absolutePath, relativePath: childRelativePath, name: entry.name, rootPath, rootName, type, updatedAt: stat.mtimeMs });
      }
    } catch {
      // Files that cannot be read are still visible in the tree but not classified.
    }
  }
  return { tree, recognized };
}

async function broadcastWorkspaceSnapshot() {
  if (workspaceRefreshRunning) {
    workspaceRefreshQueued = true;
    return;
  }
  workspaceRefreshRunning = true;
  try {
    const snapshot = await workspaceSnapshot();
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send("workspace:changed", snapshot);
    });
  } catch {
    // A follow-up filesystem event will retry when a directory is being moved.
  } finally {
    workspaceRefreshRunning = false;
    if (workspaceRefreshQueued) {
      workspaceRefreshQueued = false;
      scheduleWorkspaceRefresh();
    }
  }
}

function scheduleWorkspaceRefresh() {
  if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer);
  workspaceRefreshTimer = setTimeout(() => {
    workspaceRefreshTimer = null;
    void broadcastWorkspaceSnapshot();
  }, 120);
}

function syncWorkspaceWatchers() {
  const desired = new Set(workspaceRoots);
  for (const [rootPath, watcher] of workspaceWatchers) {
    if (desired.has(rootPath)) continue;
    watcher.close();
    workspaceWatchers.delete(rootPath);
  }
  for (const rootPath of desired) {
    if (workspaceWatchers.has(rootPath)) continue;
    try {
      const watcher = fsNative.watch(rootPath, { recursive: true }, scheduleWorkspaceRefresh);
      watcher.on("error", () => {
        watcher.close();
        workspaceWatchers.delete(rootPath);
      });
      workspaceWatchers.set(rootPath, watcher);
    } catch {
      // The explicit save/create/delete handlers still return fresh snapshots.
    }
  }
}

async function workspaceSnapshot() {
  const folders = [];
  for (const rootPath of workspaceRoots) {
    const rootName = path.basename(rootPath);
    const result = await scanDirectory(rootPath, rootPath, rootName);
    folders.push({ rootPath, rootName, tree: result.tree, recognized: result.recognized });
  }
  return { folders, recognized: folders.flatMap((folder) => folder.recognized).sort((a, b) => b.updatedAt - a.updatedAt) };
}

function createWindow() {
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(workArea.width, Math.max(880, Math.round(workArea.width * 0.8)));
  const height = Math.min(workArea.height, Math.max(600, Math.round(workArea.height * 0.8)));
  const window = new BrowserWindow({
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: "#edf1ee",
    title: "Mermaid Studio",
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (app.isPackaged) window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  else window.loadURL(DEVELOPMENT_URL);
}

ipcMain.handle("workspace:open", async () => {
  const result = await dialog.showOpenDialog({ title: "添加 Mermaid 项目文件夹", properties: ["openDirectory", "multiSelections"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  for (const selectedPath of result.filePaths) {
    const normalized = path.resolve(selectedPath);
    if (!workspaceRoots.some((rootPath) => rootPath.toLowerCase() === normalized.toLowerCase())) workspaceRoots.push(normalized);
  }
  syncWorkspaceWatchers();
  return workspaceSnapshot();
});

ipcMain.handle("workspace:refresh", () => workspaceSnapshot());

ipcMain.handle("workspace:remove", async (_event, rootPath) => {
  const resolved = path.resolve(rootPath);
  const index = workspaceRoots.findIndex((item) => item.toLowerCase() === resolved.toLowerCase());
  if (index >= 0) workspaceRoots.splice(index, 1);
  syncWorkspaceWatchers();
  return workspaceSnapshot();
});

ipcMain.handle("file:read", async (_event, filePath) => {
  if (!isAllowedFile(filePath)) throw new Error("该文件不在已打开的项目中");
  return fs.readFile(filePath, "utf8");
});

ipcMain.handle("file:save", async (_event, { filePath, content }) => {
  if (!isAllowedFile(filePath)) throw new Error("无法保存到已打开的项目之外");
  await fs.writeFile(filePath, content, "utf8");
  return workspaceSnapshot();
});

ipcMain.handle("file:rename", async (_event, { filePath, newName }) => {
  if (!isAllowedFile(filePath)) throw new Error("该文件不在已打开的项目中");
  const candidate = String(newName || "").trim();
  if (!candidate || candidate === ".md") throw new Error("文件名不能为空");
  if (path.basename(candidate) !== candidate || /[<>:\"/\\|?*]/.test(candidate)) throw new Error("文件名包含 Windows 不允许的字符");
  const fileName = candidate.toLowerCase().endsWith(".md") ? candidate : `${candidate}.md`;
  if (fileName.length > 180) throw new Error("文件名过长，请缩短后再试");
  const destinationPath = path.join(path.dirname(filePath), fileName);
  if (path.resolve(filePath) === path.resolve(destinationPath)) return { filePath, snapshot: await workspaceSnapshot() };
  try {
    await fs.access(destinationPath);
    throw new Error(`已存在同名文件“${fileName}”，请换一个名字`);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  await fs.rename(filePath, destinationPath);
  return { filePath: destinationPath, snapshot: await workspaceSnapshot() };
});

ipcMain.handle("file:create", async (_event, { rootPath, name, content }) => {
  if (!workspaceRoots.some((item) => item.toLowerCase() === path.resolve(rootPath).toLowerCase())) throw new Error("请选择一个已打开的项目文件夹");
  const safeName = path.basename(name).replace(/[<>:\"/\\|?*]/g, "-");
  if (!safeName || safeName === ".md") throw new Error("文件名不能为空");
  const fileName = safeName.toLowerCase().endsWith(".md") ? safeName : `${safeName}.md`;
  const filePath = path.join(rootPath, fileName);
  try {
    await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && error.code === "EEXIST") throw new Error("已存在同名文件");
    throw error;
  }
  return { filePath, snapshot: await workspaceSnapshot() };
});

ipcMain.handle("file:delete", async (_event, filePath) => {
  if (!isAllowedFile(filePath)) throw new Error("该文件不在已打开的项目中");
  if (!filePath.toLowerCase().endsWith(".md")) throw new Error("只能删除 Markdown 文件");
  await fs.unlink(filePath);
  allowedDetachedFiles.delete(path.resolve(filePath));
  return workspaceSnapshot();
});

ipcMain.handle("file:saveAs", async (_event, { suggestedName, content, preferredRootPath }) => {
  let rootPath = preferredRootPath ? path.resolve(preferredRootPath) : null;
  if (!rootPath || !workspaceRoots.some((item) => item.toLowerCase() === rootPath.toLowerCase())) {
    const result = await dialog.showOpenDialog({ title: "选择保存 Mermaid 文件的文件夹", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    rootPath = path.resolve(result.filePaths[0]);
    if (!workspaceRoots.some((item) => item.toLowerCase() === rootPath.toLowerCase())) workspaceRoots.push(rootPath);
    syncWorkspaceWatchers();
  }

  const safeBaseName = path.basename(suggestedName).replace(/[<>:\"/\\|?*]/g, "-");
  const fileName = (safeBaseName || "untitled.md").toLowerCase().endsWith(".md") ? (safeBaseName || "untitled.md") : `${safeBaseName}.md`;
  const filePath = path.join(rootPath, fileName);
  try {
    await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    const snapshot = await workspaceSnapshot();
    return { filePath, rootPath, snapshot };
  } catch (error) {
    if (error && error.code === "EEXIST") throw new Error(`已存在同名文件“${fileName}”，请修改文件名后再保存`);
    throw error;
  }
});

ipcMain.handle("file:export", async (_event, { suggestedName, data, encoding, type }) => {
  const extensions = type === "png" ? ["png"] : type === "svg" ? ["svg"] : ["md"];
  const result = await dialog.showSaveDialog({ title: "导出图表", defaultPath: suggestedName, filters: [{ name: type.toUpperCase(), extensions }] });
  if (result.canceled || !result.filePath) return false;
  if (encoding === "base64") await fs.writeFile(result.filePath, Buffer.from(data, "base64"));
  else await fs.writeFile(result.filePath, data, "utf8");
  return true;
});

ipcMain.handle("file:exportPng", async (_event, { suggestedName, svg, width, height }) => {
  const result = await dialog.showSaveDialog({ title: "导出完整 PNG", defaultPath: suggestedName, filters: [{ name: "PNG", extensions: ["png"] }] });
  if (result.canceled || !result.filePath) return false;

  const sourceWidth = Math.max(1, Number(width) || 1);
  const sourceHeight = Math.max(1, Number(height) || 1);
  const scale = Math.max(0.1, Math.min(3, 8192 / sourceWidth, 8192 / sourceHeight));
  const pixelWidth = Math.max(1, Math.round(sourceWidth * scale));
  const pixelHeight = Math.max(1, Math.round(sourceHeight * scale));
  const tempFile = path.join(app.getPath("temp"), `mermaid-studio-export-${randomUUID()}.html`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{width:${pixelWidth}px;height:${pixelHeight}px;margin:0;overflow:hidden;background:#fff}svg{display:block;width:${pixelWidth}px!important;height:${pixelHeight}px!important;max-width:none!important}</style></head><body>${svg}</body></html>`;
  let renderWindow;
  try {
    await fs.writeFile(tempFile, html, "utf8");
    renderWindow = new BrowserWindow({
      show: false,
      frame: false,
      useContentSize: true,
      width: pixelWidth,
      height: pixelHeight,
      backgroundColor: "#ffffff",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    await renderWindow.loadFile(tempFile);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const image = await renderWindow.webContents.capturePage({ x: 0, y: 0, width: pixelWidth, height: pixelHeight });
    if (image.isEmpty()) throw new Error("PNG 渲染结果为空，请重试");
    await fs.writeFile(result.filePath, image.toPNG());
    return true;
  } finally {
    if (renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy();
    await fs.unlink(tempFile).catch(() => undefined);
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer);
  workspaceWatchers.forEach((watcher) => watcher.close());
  workspaceWatchers.clear();
});
