const { app, BrowserWindow, ipcMain, Menu, net, session } = require('electron/main')

const path = require('node:path')
const fs = require('node:fs')

const CacheManager = require('./cache-manager')
const ConnectivityManager = require('./connectivity-manager')

// ── Config helpers ────────────────────────────────────────────────────────────

const getConfigPath = () => path.join(app.getPath('userData'), 'config.json')

const readConfig = () => {
    try {
        const data = fs.readFileSync(getConfigPath(), 'utf8')
        return JSON.parse(data)
    } catch {
        return {}
    }
}

const saveConfig = (config) => {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8')
}

// ── State ─────────────────────────────────────────────────────────────────────

let mainWindow = null
let cacheManager = null
let connectivity = null

/**
 * Tracks which UI the window is currently showing:
 *  'setup'   – local index.html (no service URL configured yet)
 *  'online'  – remote service URL
 *  'offline' – local offline.html
 */
let appMode = 'setup'

// URLs currently being downloaded in the background (prevents duplicates)
const activeDownloads = new Set()

// ── Audio download ────────────────────────────────────────────────────────────

async function downloadAudio(url, contentType) {
    const song = cacheManager.register(url, contentType)
    if (!song) {
        // Race condition: already registered by another intercept event
        activeDownloads.delete(url)
        return
    }

    const tmpPath = song.filePath + '.tmp'
    let writeStream = null

    try {
        await new Promise((resolve, reject) => {
            const req = net.request({ method: 'GET', url })

            // Abort and fail if we don't get a response within 2 minutes
            const overallTimer = setTimeout(() => {
                try { req.abort() } catch {}
                reject(new Error('download timeout'))
            }, 120_000)

            req.on('response', (res) => {
                clearTimeout(overallTimer)

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`))
                    return
                }

                let totalBytes = 0
                writeStream = fs.createWriteStream(tmpPath)

                res.on('data', (chunk) => {
                    totalBytes += chunk.length
                    writeStream.write(chunk)
                })

                res.on('end', () => {
                    writeStream.end()
                    writeStream.once('finish', () => {
                        try {
                            fs.renameSync(tmpPath, song.filePath)
                            cacheManager.markAvailable(url, totalBytes)
                            console.log(`[cache] Saved: "${song.title}" (${(totalBytes / 1024).toFixed(0)} KB)`)
                        } catch (e) {
                            reject(e)
                            return
                        }
                        resolve()
                    })
                    writeStream.once('error', reject)
                })

                res.on('error', reject)
            })

            req.on('error', (err) => { clearTimeout(overallTimer); reject(err) })
            req.end()
        })
    } catch (err) {
        console.error(`[cache] Download failed for ${url}:`, err.message)
        try { if (writeStream) writeStream.destroy() } catch {}
        try { fs.unlinkSync(tmpPath) } catch {}
        cacheManager.markFailed(url)
    } finally {
        activeDownloads.delete(url)
    }
}

// ── Audio interception ────────────────────────────────────────────────────────

function setupSessionHooks() {
    // 1. Observe response headers to detect and background-download audio.
    session.defaultSession.webRequest.onHeadersReceived(
        { urls: ['*://*/*'] },
        (details, callback) => {
            if (
                details.method === 'GET' &&
                details.resourceType !== 'mainFrame' &&
                cacheManager
            ) {
                const ct = ((details.responseHeaders['content-type'] || [])[0] || '')
                const url = details.url

                if (
                    cacheManager.isAudio(url, ct) &&
                    !cacheManager.isAvailable(url) &&
                    !activeDownloads.has(url)
                ) {
                    activeDownloads.add(url)
                    setImmediate(() => downloadAudio(url, ct))
                }
            }

            callback({ responseHeaders: details.responseHeaders })
        }
    )

    // 2. Detect audio stream failures immediately instead of waiting for the
    //    next periodic ping. This is what makes the offline switch feel instant.
    session.defaultSession.webRequest.onErrorOccurred(
        { urls: ['*://*/*'] },
        (details) => {
            if (appMode !== 'online' || !cacheManager) return
            if (!cacheManager.isAudio(details.url, '')) return

            if (!net.online) {
                // Network adapter is down → switch now
                console.log(`[connectivity] Audio stream lost (network down) → offline mode`)
                goOffline()
            } else {
                // Service may be down; let the connectivity manager decide
                connectivity.checkNow()
            }
        }
    )
}

// ── App mode transitions ──────────────────────────────────────────────────────

function goOnline(serviceUrl) {
    appMode = 'online'
    mainWindow.loadURL(serviceUrl + '/login')
}

function goOffline() {
    appMode = 'offline'
    mainWindow.loadFile('offline.html')
    // Accelerate reconnection checks while offline
    connectivity.checkNow()
}

function goSetup() {
    appMode = 'setup'
    mainWindow.loadFile('index.html')
}

// ── Status indicator ──────────────────────────────────────────────────────────

/**
 * Injects (or updates) a small floating badge in the bottom-right corner of
 * whatever page is currently loaded. The badge shows the connection state and
 * is invisible to pointer events so it never blocks the UI.
 * Not injected in offline.html which has its own dedicated status bar.
 */
function injectStatusIndicator(isOnline) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (appMode === 'offline') return  // offline.html has its own status bar

    const label = isOnline ? 'En línea' : 'Sin conexión'
    const dot   = isOnline ? '#66bb6a'  : '#ef5350'

    // Single-line script so we don't have to worry about multiline escaping
    const script =
        `(function(){` +
        `var id='__bmp_status__',el=document.getElementById(id);` +
        `if(!el){el=document.createElement('div');el.id=id;` +
        `el.style.cssText='position:fixed;bottom:14px;right:14px;z-index:2147483647;` +
        `background:rgba(20,20,20,.82);border-radius:16px;padding:5px 12px 5px 9px;` +
        `display:flex;align-items:center;gap:7px;font-family:Segoe UI,system-ui,sans-serif;` +
        `font-size:12px;color:#fff;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.5);` +
        `transition:opacity .3s;';document.body.appendChild(el);}` +
        `el.innerHTML='<span style="width:8px;height:8px;border-radius:50%;background:${dot};` +
        `display:inline-block;flex-shrink:0;"></span><span>${label}</span>';` +
        `})()`

    mainWindow.webContents.executeJavaScript(script).catch(() => {})
}

// ── Window ────────────────────────────────────────────────────────────────────

const createWindow = () => {
    mainWindow = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: path.join(__dirname, 'images/icon.ico'),
        backgroundColor: '#303030',
    })

    // If a service URL is already configured, go directly to it
    const config = readConfig()
    if (config.serviceUrl) {
        connectivity.setServiceUrl(config.serviceUrl)
        if (connectivity.isOnline) {
            goOnline(config.serviceUrl)
        } else {
            goOffline()
        }
    } else {
        mainWindow.loadFile('index.html')
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show()
    })

    // Switch to offline player when the remote service becomes unreachable
    mainWindow.webContents.on('did-fail-load', (_event, errorCode) => {
        // Ignore -3 (ABORTED) which fires when we intentionally navigate away,
        // and ignore failures that happen in sub-frames or while already offline/in setup.
        if (errorCode === -3) return
        if (appMode === 'online') {
            console.log(`[connectivity] did-fail-load (code ${errorCode}) → switching to offline mode`)
            goOffline()
        }
    })

    // Inject (or update) the status badge after every successful page load
    mainWindow.webContents.on('did-finish-load', () => {
        injectStatusIndicator(connectivity ? connectivity.isOnline : false)
    })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    // Initialise subsystems
    cacheManager = new CacheManager(app.getPath('userData'))
    connectivity = new ConnectivityManager()

    // Check connectivity once before creating the window so we know the initial state
    await connectivity.checkNow().catch(() => {})
    connectivity.start()

    // When the service comes back online while we're in offline mode, notify the
    // renderer so it can finish the current song before switching.
    connectivity.on('online', () => {
        if (appMode === 'offline') {
            const config = readConfig()
            if (config.serviceUrl) {
                console.log('[connectivity] Service reachable → notifying renderer to resume after song ends')
                mainWindow.webContents.send('connectivity-restored', { serviceUrl: config.serviceUrl })
            }
        } else {
            injectStatusIndicator(true)
        }
    })

    // ── IPC handlers ─────────────────────────────────────────────────────────

    ipcMain.handle('ping', () => 'pong')

    ipcMain.handle('get-service-url', () => {
        const config = readConfig()
        return config.serviceUrl || null
    })

    ipcMain.handle('set-service-url', (_event, baseUrl) => {
        const config = readConfig()
        config.serviceUrl = baseUrl
        saveConfig(config)
        connectivity.setServiceUrl(baseUrl)
        goOnline(baseUrl)
    })

    ipcMain.handle('get-cached-songs', () => {
        return cacheManager ? cacheManager.getAvailableSongs() : []
    })

    ipcMain.handle('get-offline-status', () => {
        return { isOnline: connectivity ? connectivity.isOnline : false, mode: appMode }
    })

    // Called by the offline renderer once the current song has finished.
    // Only then do we actually navigate to the online service.
    ipcMain.handle('resume-online-service', () => {
        const config = readConfig()
        if (config.serviceUrl) {
            console.log('[connectivity] Song ended — switching to online mode')
            goOnline(config.serviceUrl)
        }
    })

    // ── Window & menu ─────────────────────────────────────────────────────────

    setupSessionHooks()
    createWindow()

    const menu = Menu.buildFromTemplate([
        {
            label: 'Servicio',
            submenu: [
                {
                    label: 'Reconfigurar servicio',
                    click: () => { goSetup() },
                },
                { type: 'separator' },
                {
                    label: 'Salir',
                    role: 'quit',
                },
            ],
        },
    ])
    Menu.setApplicationMenu(menu)

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (connectivity) connectivity.stop()
    if (process.platform !== 'darwin') app.quit()
})