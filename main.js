if (require('electron-squirrel-startup')) app.quit()

const { app, BrowserWindow, ipcMain, Menu, dialog, net, session, Tray, globalShortcut, nativeImage } = require('electron/main')

const path = require('node:path')
const fs = require('node:fs')

const { parseFile, selectCover } = require('music-metadata')
const CacheManager = require('./cache-manager')
const ConnectivityManager = require('./connectivity-manager')

// Allow audio to autoplay without a prior user gesture (needed for seamless
// offline playback that starts immediately when the page loads).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

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
let tray = null
let isQuitting = false

/**
 * Tracks which UI the window is currently showing:
 *  'setup'   – local index.html (no service URL configured yet)
 *  'online'  – remote service URL
 *  'offline' – local offline.html
 */
let appMode = 'setup'

// When true, the next did-finish-load on the online service will auto-click play
let shouldAutoPlay = false

// URLs currently being downloaded in the background (prevents duplicates)
const activeDownloads = new Set()

// ── Metadata extraction ───────────────────────────────────────────────────────

async function readAndStoreMetadata(url, song) {
    try {
        const metadata = await parseFile(song.filePath, { duration: false, skipCovers: false })
        const common   = metadata.common
        const meta     = {}

        if (common.title)  meta.title  = common.title
        if (common.artist) meta.artist = common.artist
        if (common.album)  meta.album  = common.album
        if (common.year)   meta.year   = String(common.year)

        // Extract and persist cover art as a sibling file in the cache directory
        const cover = selectCover(common.picture)
        if (cover && cover.data && cover.data.length > 0) {
            const ext = (cover.format || 'image/jpeg').split('/').pop().replace('jpeg', 'jpg')
            const coverPath = song.filePath.replace(/\.[^.]+$/, '.cover.' + ext)
            fs.writeFileSync(coverPath, cover.data)
            meta.coverPath = coverPath
        }

        cacheManager.updateMetadata(url, meta)
        console.log(`[cache] Metadata: "${meta.title || song.title}" — ${meta.artist || 'desconocido'}`)
    } catch (err) {
        console.warn(`[cache] Could not read metadata for ${song.id}:`, err.message)
    }
}

// ── Media key handler ─────────────────────────────────────────────────────────

function handleMediaKey(key) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (appMode === 'offline') {
        // Offline renderer listens for this IPC event
        mainWindow.webContents.send('media-key', key)
    } else if (appMode === 'online') {
        // Simulate the media key inside the remote service page
        const keyCode = { playpause: 'MediaPlayPause', next: 'MediaNextTrack', prev: 'MediaPreviousTrack', stop: 'MediaStop' }[key]
        if (keyCode) {
            mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode })
            mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode })
        }
    }
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'images/icon.png'))
    tray = new Tray(icon)
    tray.setToolTip('Rockplayer')

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Mostrar ventana', click: () => { if (mainWindow) mainWindow.show() } },
        { type: 'separator' },
        {
            label: 'Salir',
            click: () => {
                isQuitting = true
                if (connectivity) connectivity.stop()
                app.quit()
            },
        },
    ])
    tray.setContextMenu(contextMenu)
    tray.on('click', () => {
        if (mainWindow) mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show()
    })
}

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
                        // Read ID3 / Vorbis / AAC tags asynchronously after the file is safe
                        setImmediate(() => readAndStoreMetadata(url, song))
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
 * whatever page is currently loaded. Reflects the *app* mode (not raw network
 * state) so the badge is accurate in all modes, including offline.html.
 *
 * @param {boolean} isOnline - whether the service is reachable
 * @param {string} [overrideLabel] - optional label (e.g. "Reconectando…")
 * @param {string} [overrideDot]   - optional hex colour for the dot
 */
function injectStatusIndicator(isOnline, overrideLabel, overrideDot) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (appMode === 'setup') return  // setup screen has no need for the badge

    const label = overrideLabel || (isOnline ? 'En línea'    : 'Sin conexión')
    const dot   = overrideDot   || (isOnline ? '#66bb6a'     : '#ef5350')

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

    // Hide to tray instead of closing
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault()
            mainWindow.hide()
        }
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

    // Inject (or update) the status badge after every successful page load.
    // In offline mode we always show "Sin conexión" until we switch back online.
    mainWindow.webContents.on('did-finish-load', () => {
        if (appMode === 'offline') {
            injectStatusIndicator(false)
        } else {
            injectStatusIndicator(connectivity ? connectivity.isOnline : false)
        }

        // After an offline→online transition, auto-click the play button once the
        // service page finishes loading (small delay so the page JS is fully ready).
        if (shouldAutoPlay && appMode === 'online') {
            shouldAutoPlay = false
            mainWindow.webContents.executeJavaScript(
                `setTimeout(function(){` +
                `  var btn = document.getElementById('play-button') ||` +
                `            document.querySelector('[id*="play"]') ||` +
                `            document.querySelector('button[class*="play"]');` +
                `  if(btn) btn.click();` +
                `}, 1200);`
            ).catch(() => {})
        }
    })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    // Initialise subsystems
    cacheManager = new CacheManager(app.getPath('userData'))
    connectivity = new ConnectivityManager()

    createTray()

    // Register media key global shortcuts
    globalShortcut.register('MediaPlayPause', () => handleMediaKey('playpause'))
    globalShortcut.register('MediaNextTrack',  () => handleMediaKey('next'))
    globalShortcut.register('MediaPreviousTrack', () => handleMediaKey('prev'))
    globalShortcut.register('MediaStop', () => handleMediaKey('stop'))

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
                // Show an orange "Reconectando…" badge while waiting for song end
                injectStatusIndicator(false, 'Reconectando…', '#ffa726')
                mainWindow.webContents.send('connectivity-restored', { serviceUrl: config.serviceUrl })
            }
        } else {
            injectStatusIndicator(true)
        }
    })

    // In online mode, show a yellow badge when the service URL becomes unreachable
    // so the user sees a warning before the page fails to load and we go offline.
    connectivity.on('offline', () => {
        if (appMode === 'online') {
            console.log('[connectivity] Service unreachable — showing warning badge')
            injectStatusIndicator(false, 'Conexión inestable…', '#fdd835')
        }
    })

    // ── IPC handlers ─────────────────────────────────────────────────────────

    ipcMain.handle('ping', () => 'pong')

    ipcMain.handle('get-volume', () => {
        const config = readConfig()
        return config.volume !== undefined ? config.volume : 90
    })

    ipcMain.handle('set-volume', (_event, value) => {
        const config = readConfig()
        config.volume = value
        saveConfig(config)
    })

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
            shouldAutoPlay = true   // trigger auto-play once the service page loads
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
                    label: 'Borrar canciones en caché',
                    click: async () => {
                        if (!cacheManager) return
                        const count = cacheManager.getAvailableSongs().length
                        const { response } = await dialog.showMessageBox(mainWindow, {
                            type: 'warning',
                            buttons: ['Borrar', 'Cancelar'],
                            defaultId: 1,
                            cancelId: 1,
                            title: 'Borrar caché de audio',
                            message: `¿Borrar ${count} canción${count !== 1 ? 'es' : ''} descargada${count !== 1 ? 's' : ''}?`,
                            detail: 'Los archivos de audio guardados localmente serán eliminados. Se volverán a descargar cuando se reproduzcan en línea.',
                        })
                        if (response === 0) {
                            cacheManager.clearAll()
                            dialog.showMessageBox(mainWindow, {
                                type: 'info',
                                buttons: ['Aceptar'],
                                title: 'Caché eliminada',
                                message: 'Las canciones en caché han sido eliminadas correctamente.',
                            })
                        }
                    },
                },
                { type: 'separator' },
                {
                    label: 'Acerca de Rockplayer',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'Acerca de Rockplayer',
                            message: 'Rockplayer',
                            detail: `Versión ${app.getVersion()}\n\nReproductor de música para negocios.\n\n© 2026 Rockeme S.A.S.\nhttps://rockeme.com`,
                            buttons: ['Cerrar'],
                            icon: path.join(__dirname, 'images/icon.png'),
                        })
                    },
                },
                { type: 'separator' },
                {
                    label: 'Salir',
                    click: () => {
                        isQuitting = true
                        if (connectivity) connectivity.stop()
                        app.quit()
                    },
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
    // App lives in the tray; actual quit is handled via the menu's Salir option.
    if (process.platform === 'darwin') app.quit()
})

app.on('will-quit', () => {
    globalShortcut.unregisterAll()
})