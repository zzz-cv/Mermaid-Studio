(() => {
  let nextRequestId = 1;
  const pending = new Map();
  const workspaceListeners = new Set();

  chrome.webview.addEventListener("message", (event) => {
    let message;
    try {
      message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (message?.kind === "workspace:changed") {
      workspaceListeners.forEach((listener) => listener(message.snapshot));
      return;
    }
    if (message?.kind !== "response") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error || "桌面操作失败"));
  });

  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`桌面操作超时：${method}`));
    }, 120000);
    pending.set(id, { resolve, reject, timer });
    try {
      chrome.webview.postMessage({ kind: "request", id, method, args });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });

  window.mermaidStudio = {
    openWorkspace: () => call("workspace:open"),
    refreshWorkspace: () => call("workspace:refresh"),
    removeWorkspace: (rootPath) => call("workspace:remove", rootPath),
    onWorkspaceChanged: (callback) => {
      workspaceListeners.add(callback);
      return () => workspaceListeners.delete(callback);
    },
    readFile: (filePath) => call("file:read", filePath),
    saveFile: (filePath, content) => call("file:save", filePath, content),
    renameFile: (filePath, newName) => call("file:rename", filePath, newName),
    createFile: (rootPath, name, content) => call("file:create", rootPath, name, content),
    saveAs: (suggestedName, content, preferredRootPath) => call("file:saveAs", suggestedName, content, preferredRootPath),
    deleteFile: (filePath) => call("file:delete", filePath),
    exportFile: (payload) => call("file:export", payload),
    exportPng: (payload) => call("file:exportPng", payload),
    platform: "win32",
  };
})();
