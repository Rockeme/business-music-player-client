const { app, BrowserWindow, ipcMain, Menu, dialog, net, session, Tray, globalShortcut, nativeImage, autoUpdater, protocol } = require('electron/main')

if (require('electron-squirrel-startup')) app.quit()

const path = require('node:path')
const fs = require('node:fs')
const { Readable } = require('node:stream')

const { parseFile, selectCover } = require('music-metadata')
const CacheManager = require('./cache-manager')
const ConnectivityManager = require('./connectivity-manager')

// Allow audio to autoplay without a prior user gesture (needed for seamless
// offline playback that starts immediately when the page loads).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// ── Config helpers ────────────────────────────────────────────────────────────

const getConfigPath = () => path.join(app.getPath('userData'), 'config.json')

const readConfig = () => {
    if (_config) return _config
    try {
        const data = fs.readFileSync(getConfigPath(), 'utf8')
        _config = JSON.parse(data)
    } catch {
        _config = {}
    }
    return _config
}

const saveConfig = (config) => {
    _config = config
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8')
}

// ── State ─────────────────────────────────────────────────────────────────────

let mainWindow = null
let cacheManager = null
let connectivity = null
let tray = null
let isQuitting = false
let _config = null          // in-memory config cache
let _volumeSaveTimer = null // debounce handle for volume disk writes

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

// ── Auto-updater ──────────────────────────────────────────────────────────────

/**
 * Configures Squirrel's autoUpdater against update.electronjs.org (a free
 * GitHub-Releases–backed update server maintained by the Electron team).
 *
 * Flow:
 *   1. setFeedURL  – tells Squirrel where to look for updates.
 *   2. checkForUpdates – Squirrel sends a HEAD/GET to the feed URL.
 *   3. The server compares the requested version with the latest GitHub Release.
 *      • If up-to-date  → HTTP 204 → 'update-not-available'.
 *      • If newer exists → HTTP 200 + JSON manifest → Squirrel starts download.
 *   4. Once the .nupkg is fully downloaded → 'update-downloaded'.
 *   5. quitAndInstall() → Squirrel silently installs in the background and
 *      relaunches the app with the new version.
 *
 * Requirements for this to work in production:
 *   • The GitHub repository must be PUBLIC.
 *   • Each release must be published (not draft) and contain the Squirrel
 *     artifacts produced by `npm run make`:
 *       - RELEASES  (index file Squirrel reads first)
 *       - *.nupkg   (the delta/full package)
 *       - *Setup.exe (optional, only needed for fresh installs)
 *   • The version in package.json must be bumped before each release so the
 *     server can detect that a newer version exists.
 *
 * In development (`npm start`) app.isPackaged is false, so this function
 * returns early and nothing is registered.
 */
function setupAutoUpdater() {
    if (!app.isPackaged) {
        console.log('[updater] Modo desarrollo — auto-updater desactivado.')
        return
    }

    const feedURL = `https://update.electronjs.org/Rockeme/business-music-player-client/${process.platform}-${process.arch}/${app.getVersion()}`

    try {
        autoUpdater.setFeedURL({ url: feedURL })
    } catch (err) {
        console.error('[updater] No se pudo configurar el feed URL:', err.message)
        return
    }

    autoUpdater.on('checking-for-update', () => {
        console.log('[updater] Buscando actualizaciones…')
    })

    autoUpdater.on('update-available', () => {
        console.log('[updater] Actualización encontrada — descargando en segundo plano…')
    })

    autoUpdater.on('update-not-available', () => {
        console.log('[updater] La aplicación está al día.')
    })

    autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
        console.log(`[updater] Actualización descargada: ${releaseName}`)
        if (!mainWindow || mainWindow.isDestroyed()) return
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Actualización lista',
            message: `Rockplayer ${releaseName} está listo para instalarse.`,
            detail: 'La nueva versión se instalará al reiniciar.\n¿Deseas reiniciar ahora?',
            buttons: ['Reiniciar ahora', 'Más tarde'],
            defaultId: 0,
            cancelId: 1,
            icon: path.join(__dirname, 'images/icon.png'),
        }).then(({ response }) => {
            if (response === 0) {
                isQuitting = true
                autoUpdater.quitAndInstall()
            }
        })
    })

    autoUpdater.on('error', (err) => {
        console.error('[updater] Error al buscar actualizaciones:', err.message)
    })

    // First check 10 s after startup (gives the app time to fully load)
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000)

    // Then check every hour automatically
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000)
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'images/icon.ico'))
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

// ── Audio protocol interception (Cache-First + Single-Stream Caching) ───────────

function setupAudioProtocolInterception() {
    const handleAudioRequest = async (request) => {
        const url = request.url

        // Pass non-audio requests straight through to the network
        if (!cacheManager || !cacheManager.isAudio(url, '')) {
            return net.fetch(request, { bypassCustomProtocolHandlers: true })
        }

        // 1. CACHE HIT: Serve directly from local disk (0 KB downloaded!)
        if (cacheManager.isAvailable(url)) {
            const song = cacheManager.getByUrl(url)
            if (song && fs.existsSync(song.filePath)) {
                const fileUrl = 'file:///' + song.filePath.replace(/\\/g, '/')
                console.log(`[cache] Cache HIT (0 KB downloaded): Serving "${song.title || song.id}" from local cache`)
                try {
                    return await net.fetch(fileUrl, {
                        headers: request.headers,
                    })
                } catch (err) {
                    console.warn(`[cache] Failed to fetch local file ${fileUrl}, falling back to network:`, err.message)
                }
            }
        }

        // 2. CACHE MISS: Single stream from network, tee to client and cache simultaneously
        const rangeHeader = request.headers.get('range') || ''
        const isFullStream = !rangeHeader || rangeHeader === 'bytes=0-' || rangeHeader.startsWith('bytes=0-')

        // If it's a partial range request (seeking without starting from 0) or already downloading
        if (!isFullStream || activeDownloads.has(url)) {
            return net.fetch(request, { bypassCustomProtocolHandlers: true })
        }

        const song = cacheManager.register(url, '')
        if (!song) {
            return net.fetch(request, { bypassCustomProtocolHandlers: true })
        }

        activeDownloads.add(url)

        let response
        try {
            response = await net.fetch(request, { bypassCustomProtocolHandlers: true })
        } catch (fetchErr) {
            activeDownloads.delete(url)
            cacheManager.markFailed(url)
            throw fetchErr
        }

        const isOkStatus = response.status === 200 || response.status === 206
        const contentType = response.headers.get('content-type') || ''

        // Ensure response is valid audio stream before caching
        if (!isOkStatus || (contentType && !cacheManager.isAudio(url, contentType)) || !response.body) {
            activeDownloads.delete(url)
            if (!isOkStatus) cacheManager.markFailed(url)
            return response
        }

        // Split the single network stream:
        // - clientStream feeds the <audio> player in real time
        // - cacheStream writes simultaneously to disk
        const [clientStream, cacheStream] = response.body.tee()

        const tmpPath = song.filePath + '.tmp'
        const fileStream = fs.createWriteStream(tmpPath)
        let totalBytes = 0

        const nodeReadable = Readable.fromWeb(cacheStream)
        nodeReadable.on('data', (chunk) => {
            totalBytes += chunk.length
        })

        nodeReadable.pipe(fileStream)

        fileStream.on('finish', () => {
            activeDownloads.delete(url)
            try {
                fs.renameSync(tmpPath, song.filePath)
                cacheManager.markAvailable(url, totalBytes)
                console.log(`[cache] Stream-saved: "${song.title}" (${(totalBytes / 1024).toFixed(0)} KB)`)
                setImmediate(() => readAndStoreMetadata(url, song))
            } catch (err) {
                console.error(`[cache] Failed to finalize stream-cache for ${url}:`, err.message)
                try { fs.unlinkSync(tmpPath) } catch {}
                cacheManager.markFailed(url)
            }
        })

        fileStream.on('error', (err) => {
            activeDownloads.delete(url)
            console.error(`[cache] Error writing stream-cache for ${url}:`, err.message)
            try { fs.unlinkSync(tmpPath) } catch {}
            cacheManager.markFailed(url)
        })

        nodeReadable.on('error', (err) => {
            activeDownloads.delete(url)
            console.error(`[cache] Network stream error for ${url}:`, err.message)
            try { fileStream.destroy() } catch {}
            try { fs.unlinkSync(tmpPath) } catch {}
            cacheManager.markFailed(url)
        })

        return new Response(clientStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        })
    }

    protocol.handle('http', handleAudioRequest)
    protocol.handle('https', handleAudioRequest)
    console.log('[cache] Audio protocol interception active (Cache-First + Single-Stream)')
}

// ── Audio interception ────────────────────────────────────────────────────────

function setupSessionHooks() {

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

function trackLastUrl(url) {
    if (!url || appMode !== 'online') return
    const config = readConfig()
    if (!config.serviceUrl) return

    if (url.startsWith(config.serviceUrl)) {
        try {
            const parsedUrl = new URL(url)
            const pathname = parsedUrl.pathname.toLowerCase()
            if (!pathname.endsWith('/login') && !pathname.endsWith('/logout') && !pathname.includes('/auth/')) {
                if (config.lastUrl !== url) {
                    config.lastUrl = url
                    saveConfig(config)
                    console.log('[config] Guardada última URL:', url)
                }
            }
        } catch {}
    }
}

function goOnline(serviceUrl, targetUrl = null) {
    appMode = 'online'
    const config = readConfig()
    const destination = targetUrl || config.lastUrl || (serviceUrl.endsWith('/') ? serviceUrl + 'login' : serviceUrl + '/login')
    console.log('[navigation] Cargando URL:', destination)
    mainWindow.loadURL(destination)
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
        width: 1280,
        height: 720,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            // Prevent Chromium from pausing audio/timers when the window is
            // hidden to the system tray. Without this, hiding the window sets
            // document.visibilityState = "hidden" and Chromium throttles/pauses
            // media playback automatically.
            backgroundThrottling: false,
        },
        icon: path.join(__dirname, 'images/icon.ico'),
        backgroundColor: '#303030',
    })

    // Listen to navigation events to persist last visited URL
    mainWindow.webContents.on('did-navigate', (_event, url) => {
        trackLastUrl(url)
    })
    mainWindow.webContents.on('did-navigate-in-page', (_event, url) => {
        trackLastUrl(url)
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

        if (appMode === 'online') {
            const currentUrl = mainWindow.webContents.getURL()
            const isLoginPage = currentUrl.includes('/login') || currentUrl.includes('/auth/')

            if (!isLoginPage) {
                shouldAutoPlay = false
                mainWindow.webContents.executeJavaScript(
                    `(function autoPlay() {` +
                    `  var attempts = 0;` +
                    `  var interval = setInterval(function() {` +
                    `    attempts++;` +
                    `    var btn = document.getElementById('play-button') ||` +
                    `              document.querySelector('[id*="play"]') ||` +
                    `              document.querySelector('button[class*="play"]');` +
                    `    if (btn) {` +
                    `      if (!btn.classList.contains('w3-disabled')) {` +
                    `        btn.click();` +
                    `        console.log('[Rockplayer] Reproducción iniciada automáticamente');` +
                    `      }` +
                    `      clearInterval(interval);` +
                    `    } else if (attempts >= 10) {` +
                    `      clearInterval(interval);` +
                    `    }` +
                    `  }, 500);` +
                    `})()`
                ).catch(() => {})
            }
        }
    })
}

// ── Single instance lock ──────────────────────────────────────────────────────

// Prevent multiple instances from running simultaneously. Only the first
// instance acquires the lock and continues. Any subsequent launch focuses the
// existing window and exits immediately (matching the official Electron pattern).
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    app.quit()
} else {

app.on('second-instance', () => {
    if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show()
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
    }
})

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    // Initialise subsystems
    cacheManager = new CacheManager(app.getPath('userData'))
    connectivity = new ConnectivityManager()

    setupAudioProtocolInterception()

    createTray()
    setupAutoUpdater()

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
        if (_volumeSaveTimer) clearTimeout(_volumeSaveTimer)
        _volumeSaveTimer = setTimeout(() => {
            _volumeSaveTimer = null
            saveConfig(config)
        }, 500)
    })

    ipcMain.handle('get-service-url', () => {
        const config = readConfig()
        return config.serviceUrl || null
    })

    ipcMain.handle('set-service-url', (_event, baseUrl) => {
        const config = readConfig()
        config.serviceUrl = baseUrl
        delete config.lastUrl
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
                    label: 'Buscar actualizaciones…',
                    click: () => {
                        if (!app.isPackaged) {
                            dialog.showMessageBox(mainWindow, {
                                type: 'info',
                                title: 'Modo desarrollo',
                                message: 'Las actualizaciones automáticas solo están disponibles en la versión instalada.',
                                buttons: ['Entendido'],
                            })
                            return
                        }
                        autoUpdater.checkForUpdates().catch((err) => {
                            dialog.showMessageBox(mainWindow, {
                                type: 'error',
                                title: 'Error al buscar actualizaciones',
                                message: 'No se pudo contactar el servidor de actualizaciones.',
                                detail: err.message,
                                buttons: ['Cerrar'],
                            })
                        })
                    },
                },
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
                {
                    label: 'Iniciar con Windows',
                    type: 'checkbox',
                    checked: app.getLoginItemSettings().openAtLogin,
                    click: (menuItem) => {
                        if (!app.isPackaged) {
                            menuItem.checked = !menuItem.checked
                            dialog.showMessageBox(mainWindow, {
                                type: 'info',
                                title: 'Modo desarrollo',
                                message: 'Esta opción solo funciona en la versión instalada.',
                                buttons: ['Entendido'],
                            })
                            return
                        }
                        const exeName = path.basename(process.execPath)
                        const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe')
                        app.setLoginItemSettings({
                            openAtLogin: menuItem.checked,
                            path: updateExe,
                            args: ['--processStart', `"${exeName}"`],
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
    // Flush any pending debounced volume write so the setting is not lost on exit
    if (_volumeSaveTimer) {
        clearTimeout(_volumeSaveTimer)
        _volumeSaveTimer = null
        if (_config) saveConfig(_config)
    }
})

} // end of gotTheLock else block