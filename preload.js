const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('versions', {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron,
    ping: () => ipcRenderer.invoke('ping'),
    getServiceUrl: () => ipcRenderer.invoke('get-service-url'),
    setServiceUrl: (url) => ipcRenderer.invoke('set-service-url', url)
})