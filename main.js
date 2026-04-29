const { app, BrowserWindow, ipcMain, Menu } = require('electron/main')

const path = require('node:path')
const fs = require('node:fs')

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

let mainWindow = null

const createWindow = () => {
    mainWindow = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'images/icon.png'),
        backgroundColor: '#303030',
    })

    mainWindow.loadFile('index.html')

    mainWindow.once('ready-to-show', () => {
        mainWindow.show()
    })
}

app.whenReady().then(() => {
    ipcMain.handle('ping', () => 'pong')

    ipcMain.handle('get-service-url', () => {
        const config = readConfig()
        return config.serviceUrl || null
    })

    ipcMain.handle('set-service-url', (_event, baseUrl) => {
        const config = readConfig()
        config.serviceUrl = baseUrl
        saveConfig(config)
        mainWindow.loadURL(baseUrl + '/public/login')
    })

    createWindow()

    const menu = Menu.buildFromTemplate([
        {
            label: 'Servicio',
            submenu: [
                {
                    label: 'Reconfigurar servicio',
                    click: () => {
                        mainWindow.loadFile('index.html')
                    }
                },
                { type: 'separator' },
                {
                    label: 'Salir',
                    role: 'quit'
                }
            ]
        }
    ])
    Menu.setApplicationMenu(menu)

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})