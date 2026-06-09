import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { resolvePaths, ensureWorkspaceDirs } from './services/workspace'
import { openDatabase } from './services/db'
import { seedSettings, getSettings } from './services/settings'
import { buildPolicyStatus } from './services/policy'
import { assertOfflinePosture } from './services/offlineGuard'
import { initLogging, log } from './services/logging'
import { registerCoreIpc } from './ipc/registerCoreIpc'
import { registerModelIpc } from './ipc/registerModelIpc'
import { registerChatIpc } from './ipc/registerChatIpc'
import { registerDocsIpc } from './ipc/registerDocsIpc'
import { registerRagIpc } from './ipc/registerRagIpc'
import { registerBenchmarkIpc } from './ipc/registerBenchmarkIpc'
import { RuntimeManager } from './services/runtime'
import { createMockRuntime } from './services/runtime/mock'
import { createMockEmbedder } from './services/embeddings'
import { resolveManifestsDir } from './services/models'
import type { AppContext } from './services/context'

// Private AI Drive Lite — Electron main process (the "backend").
// Security posture (spec §3.5): context isolation on, node integration off,
// sandboxed renderer, and NO network code in the core path.

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let ctx: AppContext | null = null

// Resolve the workspace/drive layout, open the database, and register IPC.
// Runs once at startup, before the window loads.
function initBackend(): void {
  const paths = resolvePaths({
    envRoot: process.env.PAID_DRIVE_ROOT,
    fallbackRoot: app.getPath('userData')
  })
  ensureWorkspaceDirs(paths)
  initLogging(paths.logsPath)
  log.info('Workspace resolved', { root: paths.rootPath, preparedDrive: paths.isPreparedDrive })

  const db = openDatabase(paths.dbPath)
  seedSettings(db)
  log.info('Database ready', { path: paths.dbPath })

  // Mock runtime + mock embedder for now; swapped for the real llama.cpp / E5 backends
  // in Phase 10, behind the same interfaces.
  const runtime = new RuntimeManager(createMockRuntime)
  const embedder = createMockEmbedder()
  const manifestsDir = resolveManifestsDir(app.getAppPath(), process.env.PAID_MANIFESTS_DIR)
  log.info('Model manifests directory', { manifestsDir })

  ctx = { paths, db, runtime, embedder, manifestsDir }
  registerCoreIpc(ctx)
  registerModelIpc(ctx)
  registerChatIpc(ctx)
  registerDocsIpc(ctx)
  registerRagIpc(ctx)
  registerBenchmarkIpc(ctx)

  // Phase 8: log the offline posture and install a defensive tripwire that flags any
  // attempt to reach a REMOTE host while offline (loopback is exempt — dev renderer +
  // future llama.cpp sidecar bind 127.0.0.1). The guard only logs; it never blocks.
  const policy = buildPolicyStatus(paths.configPath, getSettings(db).allowNetwork, (m) => log.warn(m))
  assertOfflinePosture({
    posture: { offline: policy.offlineMode, networkAllowed: policy.networkAllowed },
    installGuard: isDev || getSettings(db).developerMode,
    log: (m, meta) => log.info(m, meta),
    warn: (m, meta) => log.warn(m, meta)
  })
}

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

  // Content-Security-Policy as a response header (defence in depth on top of the
  // index.html meta tag, spec §3.5). Production is strict: same-origin only, no remote
  // connect/img/script — the renderer cannot reach any cloud service. Dev relaxes
  // connect-src for Vite HMR over ws://localhost (otherwise `npm run dev` breaks).
  const csp = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*; " +
      "img-src 'self' data:; font-src 'self'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; " +
      "base-uri 'none'; frame-ancestors 'none'"
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
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
  try {
    initBackend()
  } catch (err) {
    log.error('Backend initialization failed', String(err))
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  // Stop the active runtime (real llama.cpp sidecar in Phase 10) before quitting.
  void ctx?.runtime.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
