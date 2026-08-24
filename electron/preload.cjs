const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mermaidStudio", {
  openWorkspace: () => ipcRenderer.invoke("workspace:open"),
  refreshWorkspace: () => ipcRenderer.invoke("workspace:refresh"),
  removeWorkspace: (rootPath) => ipcRenderer.invoke("workspace:remove", rootPath),
  onWorkspaceChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  saveFile: (filePath, content) => ipcRenderer.invoke("file:save", { filePath, content }),
  renameFile: (filePath, newName) => ipcRenderer.invoke("file:rename", { filePath, newName }),
  createFile: (rootPath, name, content) => ipcRenderer.invoke("file:create", { rootPath, name, content }),
  saveAs: (suggestedName, content, preferredRootPath) => ipcRenderer.invoke("file:saveAs", { suggestedName, content, preferredRootPath }),
  deleteFile: (filePath) => ipcRenderer.invoke("file:delete", filePath),
  exportFile: (payload) => ipcRenderer.invoke("file:export", payload),
  exportPng: (payload) => ipcRenderer.invoke("file:exportPng", payload),
  platform: process.platform,
});
