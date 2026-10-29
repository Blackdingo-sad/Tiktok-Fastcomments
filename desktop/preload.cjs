const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('commentApp', {
    checkBackend: (request) => ipcRenderer.invoke('backend:check', request),
    prewarm: (request) => ipcRenderer.invoke('comment:prewarm', request),
    sendComment: (request) => ipcRenderer.invoke('comment:send', request),
    loginTikTok: (request) => ipcRenderer.invoke('tiktok:login', request),
    saveSession: (request) => ipcRenderer.invoke('tiktok:saveSession', request),
    onEcho: (handler) => {
        if (typeof handler !== 'function') return () => {};
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('comment:echo', listener);
        return () => ipcRenderer.removeListener('comment:echo', listener);
    }
});
