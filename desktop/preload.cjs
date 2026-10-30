const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('commentApp', {
    getBackendConfig: () => ipcRenderer.invoke('backend:local-config'),
    checkBackend: (request) => ipcRenderer.invoke('backend:check', request),
    prewarm: (request) => ipcRenderer.invoke('comment:prewarm', request),
    setSendDelay: (request) => ipcRenderer.invoke('tiktok:set-send-delay', request),
    loginTikTok: (request) => ipcRenderer.invoke('tiktok:login', request),
    saveSession: (request) => ipcRenderer.invoke('tiktok:saveSession', request)
});
