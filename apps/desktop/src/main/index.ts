import { app, BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { resolvePaths, ensureWorkspaceDirs, findPreparedDriveRoot } from './services/workspace'
import { getSettings } from './services/settings'
import { loadPolicy, buildPolicyStatus } from './services/policy'
import { vaultPathsFrom, WorkspaceController } from './services/workspace-vault'
import { assertOfflinePosture } from './services/offlineGuard'
import { initLogging, log } from './services/logging'
import { registerCoreIpc } from './ipc/registerCoreIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { registerModelIpc } from './ipc/registerModelIpc'
import { registerChatIpc } from './ipc/registerChatIpc'
import { registerDocsIpc } from './ipc/registerDocsIpc'
import { registerRagIpc } from './ipc/registerRagIpc'
import { registerBenchmarkIpc, maybeRunFirstBenchmark } from './ipc/registerBenchmarkIpc'
import { RuntimeManager } from './services/runtime'
import { createSelectingRuntimeFactory } from './services/runtime/factory'
import { createSelectedEmbedder, type EmbeddingModelInfo } from './services/embeddings/factory'
import { discoverManifests, resolveManifestsDir, weightPath } from './services/models'
import type { AppContext } from './services/context'

// Private AI Drive Lite — Electron main process (the "backend").
// Security posture (spec §3.5): context isolation on, node integration off,
// sandboxed renderer, and NO network code in the core path.

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let ctx: AppContext | null = null

/**
 * Resolve the embeddings model (id + GGUF weight path) from the manifests so the real
 * E5 embedder can be selected when its weights are present. Settings live inside the
 * (possibly encrypted) DB and are unreadable before unlock, so we use the manifest's
 * default embeddings model rather than `activeEmbeddingModelId`. Returns null when no
 * embeddings manifest is found (→ the selector falls back to the mock embedder).
 */
function resolveEmbeddingModel(manifestsDir: string | null, rootPath: string): EmbeddingModelInfo | null {
  if (!manifestsDir) return null
  try {
    const { manifests } = discoverManifests(manifestsDir)
    const found = manifests.find((m) => m.manifest.role === 'embeddings')
    if (!found) return null
    return {
      id: found.manifest.id,
      modelPath: weightPath(rootPath, found.manifest),
      contextTokens: found.manifest.recommendedContextTokens
    }
  } catch {
    return null
  }
}

// Resolve the workspace/drive layout, open the database, and register IPC.
// Runs once at startup, before the window loads.
function initBackend(): void {
  // M16: a buyer who double-clicks the portable .exe / .app DIRECTLY (bypassing the
  // launcher) gets no PAID_DRIVE_ROOT — detect the drive from the app's own location so
  // they still land on the drive's (possibly encrypted) workspace, not a silent fresh
  // app-data one. PORTABLE_EXECUTABLE_DIR is set by the electron-builder portable target
  // (the exe extracts itself to a temp dir, so execPath alone would miss the drive).
  const exeDriveRoot =
    findPreparedDriveRoot(process.env.PORTABLE_EXECUTABLE_DIR) ??
    findPreparedDriveRoot(dirname(app.getPath('exe')))
  const paths = resolvePaths({
    envRoot: process.env.PAID_DRIVE_ROOT ?? exeDriveRoot ?? undefined,
    fallbackRoot: app.getPath('userData')
  })
  ensureWorkspaceDirs(paths)
  initLogging(paths.logsPath)
  log.info('Workspace resolved', {
    root: paths.rootPath,
    preparedDrive: paths.isPreparedDrive,
    detectedFromAppLocation: !process.env.PAID_DRIVE_ROOT && exeDriveRoot != null
  })

  // Phase 9: the workspace controller owns the DB lifecycle. In plaintext_dev mode the DB
  // opens immediately (current dev behavior); in encrypted mode it stays locked until the
  // unlock gate provides a password (the DB + key live only in memory while unlocked).
  const { policy } = loadPolicy(paths.configPath, (m) => log.warn(m))
  const workspace = new WorkspaceController(
    vaultPathsFrom({ configPath: paths.configPath, dbPath: paths.dbPath }),
    policy,
    isDev
  )
  workspace.init()
  log.info('Workspace state', workspace.getState())

  const manifestsDir = resolveManifestsDir(app.getAppPath(), process.env.PAID_MANIFESTS_DIR)
  log.info('Model manifests directory', { manifestsDir })

  // Phase 10: real llama.cpp runtime + real E5 embedder, behind the SAME interfaces.
  // Both are opt-in by availability — the selectors return the real backend only when
  // the platform `llama-server` binary AND the GGUF weights are present, else the mock,
  // so the app launches + tests pass with zero model files (graceful-fallback rule).
  // The runtime backend is picked per `start()` (when the model path is known); the
  // embedder is picked here from the embeddings manifest (settings are unreadable until
  // the workspace unlocks, so we use the manifest's default E5 model).
  const runtime = new RuntimeManager(
    createSelectingRuntimeFactory({
      rootPath: paths.rootPath,
      onSelect: (kind, opts, reason) =>
        log.info('Runtime backend selected', { kind, modelId: opts.modelId, reason })
    })
  )
  const embeddingModel = resolveEmbeddingModel(manifestsDir, paths.rootPath)
  const embedder = createSelectedEmbedder({
    rootPath: paths.rootPath,
    model: embeddingModel,
    onSelect: (kind, reason) => log.info('Embedder backend selected', { kind, reason })
  })

  // `db` is a getter over the controller: it throws while locked. DB-backed IPC is only
  // reachable after the renderer's unlock gate reports the workspace ready.
  ctx = {
    paths,
    get db() {
      return workspace.requireDb()
    },
    workspace,
    runtime,
    embedder,
    manifestsDir,
    isDev
  }
  registerCoreIpc(ctx)
  registerWorkspaceIpc(ctx)
  registerModelIpc(ctx)
  registerChatIpc(ctx)
  registerDocsIpc(ctx)
  registerRagIpc(ctx)
  registerBenchmarkIpc(ctx)

  // Spec §2.1 first-run benchmark (M12): a plaintext-dev workspace is already open at
  // startup — benchmark it in the background if it never was. Encrypted workspaces get
  // the same treatment after unlock/create (registerWorkspaceIpc).
  maybeRunFirstBenchmark(ctx)

  // Phase 8: log the offline posture and install a defensive tripwire that flags any
  // attempt to reach a REMOTE host while offline (loopback is exempt — dev renderer +
  // llama.cpp sidecar bind 127.0.0.1). The guard only logs; it never blocks. It is
  // installed in ALL builds when offline (not just dev) so a production regression that
  // tried to phone home would still be recorded in the local log.
  // When the workspace is locked the allowNetwork setting is unreadable → treat as off.
  const unlocked = workspace.isUnlocked()
  const status = buildPolicyStatus(
    paths.configPath,
    unlocked ? getSettings(ctx.db).allowNetwork : false,
    (m) => log.warn(m)
  )
  assertOfflinePosture({
    posture: { offline: status.offlineMode, networkAllowed: status.networkAllowed },
    installGuard: true,
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

  // Open external links in the OS browser, never inside the app window — but only safe
  // web schemes. Handing an arbitrary renderer-supplied URL (e.g. file://, smb://) to the
  // OS handler is a known Electron pitfall, so anything other than http(s) is dropped.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
    } catch {
      /* malformed URL → ignore */
    }
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

let isShuttingDown = false

/**
 * Graceful shutdown: stop the runtime + embedder sidecars (real llama.cpp servers in
 * Phase 10) and AWAIT their exit so no orphaned `llama-server` process survives, then
 * re-encrypt + shred the plaintext working DB (encrypted vault only). `runtime.stop()`
 * waits up to a couple of seconds for the child to die, so this MUST be awaited — a
 * fire-and-forget would let Electron tear down mid-kill and orphan the children.
 */
async function shutdown(): Promise<void> {
  try {
    await Promise.allSettled([
      ctx?.runtime.stop() ?? Promise.resolve(),
      ctx?.embedder.stop?.() ?? Promise.resolve()
    ])
  } catch (err) {
    log.error('Error stopping sidecars on quit', String(err))
  }
  // Phase 9: lock (re-encrypt + shred) the plaintext working DB. No-op for plaintext_dev.
  try {
    ctx?.workspace.lock()
  } catch (err) {
    log.error('Failed to lock workspace on quit', String(err))
  }
}

app.on('will-quit', (event) => {
  if (isShuttingDown) return // cleanup already ran → let the real quit proceed
  event.preventDefault()
  isShuttingDown = true
  void shutdown().finally(() => app.exit(0))
})

// Last-resort crash safety: a hard `uncaughtException` skips `will-quit`, so try to lock the
// vault (re-encrypt + shred the plaintext working DB) before the process dies. Best-effort
// and synchronous; the startup crash-recovery shred is the robust backstop on next launch.
process.on('uncaughtException', (err) => {
  try {
    log.error('Uncaught exception', String(err))
    ctx?.workspace.lock()
  } catch {
    /* best-effort */
  }
  process.exit(1)
})
// An unhandled rejection is usually NOT fatal (e.g. a stray `void promise()`), so only log
// it — force-exiting here would turn a benign rejection into an app crash.
process.on('unhandledRejection', (reason) => {
  log.warn('Unhandled rejection', { reason: String(reason) })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
