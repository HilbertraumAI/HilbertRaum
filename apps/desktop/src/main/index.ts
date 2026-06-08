import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

// Private AI Drive Lite — Electron main process (the "backend").
// Security posture (spec §3.5): context isolation on, node integration off,
// sandboxed renderer, and NO network code in the core path.

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'Private AI Drive Lite',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Open external links in the OS browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block in-app navigation to remote origins (defence in depth).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith('http://localhost') : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // IPC handlers are registered here as phases land.
  // Phase 1 will call registerCoreIpc() etc.
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Phase 10: stop the llama.cpp sidecar here before quitting.
  if (process.platform !== 'darwin') app.quit()
})
