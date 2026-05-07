const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('versions', {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron,
    ping: () => ipcRenderer.invoke('ping'),
    getServiceUrl: () => ipcRenderer.invoke('get-service-url'),
    setServiceUrl: (url) => ipcRenderer.invoke('set-service-url', url),
    getCachedSongs: () => ipcRenderer.invoke('get-cached-songs'),
    getOfflineStatus: () => ipcRenderer.invoke('get-offline-status'),
    // Tells the main process to navigate to the online service immediately.
    resumeOnlineService: () => ipcRenderer.invoke('resume-online-service'),
    // Registers a callback that fires when connectivity is restored while offline.
    onConnectivityRestored: (callback) => ipcRenderer.on('connectivity-restored', (_event, data) => callback(data)),
})