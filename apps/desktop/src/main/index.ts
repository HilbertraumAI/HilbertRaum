import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { dirname, join } from 'node:path'
import { resolvePaths, ensureWorkspaceDirs, findPreparedDriveRoot } from './services/workspace'
import { applyUiLanguageSetting, initMainI18n } from './services/i18n'
import { installPermissionRequestHandler } from './services/permissions'
import { getSettings, updateSettings } from './services/settings'
import { loadPolicy, buildPolicyStatus } from './services/policy'
import { vaultPathsFrom, WorkspaceController } from './services/workspace-vault'
import { assertOfflinePosture } from './services/offlineGuard'
import { initLogging, log, usesPlaintextLog, detachVaultKey } from './services/logging'
import { registerCoreIpc } from './ipc/registerCoreIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { maybeAutoStartActiveModel, registerModelIpc } from './ipc/registerModelIpc'
import { registerChatIpc } from './ipc/registerChatIpc'
import { registerDocsIpc } from './ipc/registerDocsIpc'
import { registerDocTasksIpc } from './ipc/registerDocTasksIpc'
import { DocTaskManager } from './services/doctasks'
import { documentsDir } from './services/ingestion'
import { inFlightStreams } from './ipc/inflight'
import { registerDictationIpc } from './ipc/registerDictationIpc'
import { registerDownloadIpc } from './ipc/registerDownloadIpc'
import { registerRagIpc } from './ipc/registerRagIpc'
import { registerBenchmarkIpc, maybeRunFirstBenchmark } from './ipc/registerBenchmarkIpc'
import { registerAuditIpc } from './ipc/registerAuditIpc'
import { createAuditRecorder } from './services/audit'
import { RuntimeManager } from './services/runtime'
import { createGpuCrashAutoFallback, createSelectingRuntimeFactory } from './services/runtime/factory'
import { createCachedGpuProbe } from './services/runtime/gpu'
import { EVENTS } from '../shared/ipc'
import { rasterizePdfWithHiddenWindow } from './services/ocr/rasterizer'
import { resolveManifestsDir } from './services/models'
import { composeServices } from './services/compose-services'
import type { AppContext } from './services/context'

// HilbertRaum — Electron main process (the "backend").
// Security posture (spec §3.5): context isolation on, node integration off,
// sandboxed renderer, and NO network code in the core path.

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let ctx: AppContext | null = null

// The three model resolvers + the four availability-driven service selectors that used to
// live inline here were extracted (M-A3): `resolveModelByRole` (services/resolve-model.ts)
// collapses the embeddings/reranker/transcriber resolvers; `composeServices`
// (services/compose-services.ts) builds the embedder/reranker/transcriber/OCR bundle.

// Resolve the workspace/drive layout, open the database, and register IPC.
// Runs once at startup, before the window loads.
function initBackend(): void {
  // A buyer who double-clicks the portable .exe / .app DIRECTLY (bypassing the
  // launcher) gets no HILBERTRAUM_DRIVE_ROOT — detect the drive from the app's own location so
  // they still land on the drive's (possibly encrypted) workspace, not a silent fresh
  // app-data one. PORTABLE_EXECUTABLE_DIR is set by the electron-builder portable target
  // (the exe extracts itself to a temp dir, so execPath alone would miss the drive).
  const exeDriveRoot =
    findPreparedDriveRoot(process.env.PORTABLE_EXECUTABLE_DIR) ??
    findPreparedDriveRoot(dirname(app.getPath('exe')))
  const paths = resolvePaths({
    envRoot: process.env.HILBERTRAUM_DRIVE_ROOT ?? exeDriveRoot ?? undefined,
    fallbackRoot: app.getPath('userData')
  })
  ensureWorkspaceDirs(paths)
  initLogging(paths.logsPath)
  log.info('Workspace resolved', {
    root: paths.rootPath,
    preparedDrive: paths.isPreparedDrive,
    detectedFromAppLocation: !process.env.HILBERTRAUM_DRIVE_ROOT && exeDriveRoot != null
  })

  // The workspace controller owns the DB lifecycle. In plaintext_dev mode the DB
  // opens immediately (current dev behavior); in encrypted mode it stays locked until the
  // unlock gate provides a password (the DB + key live only in memory while unlocked).
  const policyWarnings: string[] = []
  const { policy } = loadPolicy(
    paths.configPath,
    (m) => {
      log.warn(m)
      policyWarnings.push(m)
    },
    // M-4: a packaged build fails CLOSED (STRICT_POLICY) on a missing/malformed policy.json.
    { isDev }
  )
  const workspace = new WorkspaceController(
    vaultPathsFrom({ configPath: paths.configPath, dbPath: paths.dbPath }),
    policy,
    isDev
  )
  workspace.init()
  log.info('Workspace state', workspace.getState())

  // Settings are readable right away on a plaintext workspace — resolve the UI language
  // for main-side emissions (tMain) now. Encrypted workspaces stay on the OS-locale
  // guess until unlock/create (registerWorkspaceIpc re-resolves there).
  if (workspace.isUnlocked()) {
    try {
      applyUiLanguageSetting(getSettings(workspace.requireDb()).uiLanguage)
    } catch {
      /* keep the OS-locale default */
    }
    // A workspace open at startup is plaintext_dev (encrypted ones stay locked until the
    // unlock gate). Flush the pre-unlock log buffer to a plain `app.log` and keep it
    // plaintext — matching the unencrypted dev DB. Encrypted workspaces instead adopt the
    // vault key in registerWorkspaceIpc's unlock/create handlers (`attachVaultKey`); until
    // then the log stays in memory, and a session spent entirely at the unlock gate is
    // discarded on quit (the pre-auth "no sensitive bytes on disk" trade — see logging.ts).
    usesPlaintextLog()
  }

  // The app-wide audit recorder (services/audit.ts). Backed by the workspace
  // DB getter — while the vault is locked, events buffer in memory and flush after the
  // next unlock (which is how `workspace_unlock_failed` survives at all). Startup policy
  // warnings are the first thing on the record.
  const audit = createAuditRecorder(() => workspace.requireDb())
  for (const warning of policyWarnings) audit('policy_warning', warning)

  const manifestsDir = resolveManifestsDir(app.getAppPath(), process.env.HILBERTRAUM_MANIFESTS_DIR)
  log.info('Model manifests directory', { manifestsDir })

  // Real llama.cpp runtime + real E5 embedder, behind the SAME interfaces.
  // Both are opt-in by availability — the selectors return the real backend only when
  // the platform `llama-server` binary AND the GGUF weights are present, else the mock,
  // so the app launches + tests pass with zero model files (graceful-fallback rule).
  // The runtime backend is picked per `start()` (when the model path is known); the
  // embedder is picked here from the embeddings manifest (settings are unreadable until
  // the workspace unlocks, so we use the manifest's default E5 model).
  //
  // GPU: the factory walks the start ladder (architecture.md GPU record §5.2). GPU
  // settings live inside the (possibly encrypted) DB — sidecars only ever start
  // post-unlock, but every read is still guarded (locked DB → safe defaults). A rung-1
  // failure or a mid-session GPU crash persists `gpuAutoDisabled` + `gpuLastError`;
  // the crash path additionally restarts the same model once at CPU and broadcasts the
  // friendly compatibility-mode notice to the renderer.
  const gpuProbe = createCachedGpuProbe()
  const persistGpuFailure = (reason: string): void => {
    try {
      updateSettings(workspace.requireDb(), {
        gpuAutoDisabled: true,
        gpuLastError: `${new Date().toISOString()} — ${reason}`.slice(0, 2000)
      })
    } catch (err) {
      log.warn('Could not persist GPU fallback state', { error: String(err) })
    }
    log.warn('GPU start/run failed — continuing in compatibility (CPU) mode', { reason })
    // Audit: the reason is sidecar stderr/health output, never user content.
    audit('runtime_fallback', 'Switched to compatibility (CPU) mode', {
      reason: reason.slice(0, 500)
    })
  }
  const notifyRenderer = (message: string): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EVENTS.runtimeNotice, message)
    }
    log.info('Runtime notice', { message })
  }
  // The crash handler needs the manager and the manager's factory needs the handler —
  // late-bind through a ref.
  let runtimeRef: RuntimeManager | null = null
  const gpuCrashFallback = createGpuCrashAutoFallback({
    restart: (opts) => runtimeRef?.start(opts) ?? Promise.resolve(),
    persistFailure: (reason) => {
      // A mid-session crash is its own audit event; persistGpuFailure then records the
      // compatibility-mode fallback it triggers.
      audit('runtime_crashed', 'Model runtime stopped unexpectedly', {
        reason: reason.slice(0, 500)
      })
      persistGpuFailure(reason)
    },
    notify: notifyRenderer
  })
  const readGpuSetting = <T>(pick: (s: ReturnType<typeof getSettings>) => T, fallback: T): T => {
    try {
      return pick(getSettings(workspace.requireDb()))
    } catch {
      return fallback // locked workspace → safe default (sidecars start post-unlock)
    }
  }
  const runtime = new RuntimeManager(
    createSelectingRuntimeFactory({
      rootPath: paths.rootPath,
      // M-5: the dev-only HILBERTRAUM_LLAMA_BIN override is honoured only in a dev build.
      isDev,
      onSelect: (kind, opts, reason) =>
        log.info('Runtime backend selected', { kind, modelId: opts.modelId, reason }),
      gpu: {
        getGpuMode: () => readGpuSetting((s) => s.gpuMode, 'auto'),
        getGpuAutoDisabled: () => readGpuSetting((s) => s.gpuAutoDisabled, false),
        onGpuFailure: persistGpuFailure,
        probeDevices: gpuProbe,
        onGpuCrash: (opts, info) => gpuCrashFallback(opts, info)
      }
    })
  )
  runtimeRef = runtime
  // The availability-driven services (embedder + reranker/transcriber/OCR) — built from
  // the drive layout in one place (M-A3, services/compose-services.ts). The runtime/GPU
  // wiring above stays inline because of its late-bound crash handler.
  const { embedder, reranker, transcriber, ocrEngine } = composeServices({
    rootPath: paths.rootPath,
    manifestsDir,
    // M-5: dev-only binary env overrides are honoured only in a dev build.
    isDev
  })

  // Document task engine: one-at-a-time summary/translation/compare jobs. The
  // chat-streaming guard reads the shared in-flight registry — tasks never put
  // entries INTO that map; they own their AbortControllers. The ingestion deps +
  // vault lease serve the translation materialize step: the new document goes
  // through the normal import path (embedded + `.enc`-encrypted) while holding
  // `beginDocumentWork()` for exactly that step.
  const docTasks = new DocTaskManager({
    getDb: () => workspace.requireDb(),
    getRuntime: () => runtime.active(),
    isChatStreaming: () => inFlightStreams.size > 0,
    getContextTokens: () => getSettings(workspace.requireDb()).contextTokens,
    getStoreDir: () => documentsDir(paths.workspacePath),
    getIngestionDeps: () => ({ embedder, cipher: workspace.documentCipher(), ocrEngine }),
    beginDocumentWork: () => workspace.beginDocumentWork(),
    // The OCR task's engine + the hidden-window PDF rasterizer.
    getOcrEngine: () => ocrEngine,
    rasterizePdf: rasterizePdfWithHiddenWindow,
    audit
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
    reranker,
    transcriber,
    ocrEngine,
    manifestsDir,
    probeGpu: gpuProbe,
    isDev,
    audit,
    docTasks
  }
  registerCoreIpc(ctx)
  registerWorkspaceIpc(ctx)
  registerModelIpc(ctx)
  registerChatIpc(ctx)
  registerDocsIpc(ctx)
  registerDocTasksIpc(ctx)
  registerDictationIpc(ctx)
  registerDownloadIpc(ctx)
  registerRagIpc(ctx)
  registerBenchmarkIpc(ctx)
  registerAuditIpc(ctx)

  // Spec §2.1 first-run benchmark: a plaintext-dev workspace is already open at
  // startup — benchmark it in the background if it never was. Encrypted workspaces get
  // the same treatment after unlock/create (registerWorkspaceIpc).
  maybeRunFirstBenchmark(ctx)
  // Bring the selected model's runtime back up in the background so a
  // restarted app matches what the Home screen shows. Encrypted workspaces do this
  // after unlock/create (registerWorkspaceIpc) — settings are unreadable until then.
  maybeAutoStartActiveModel(ctx)

  // Log the offline posture and install a defensive tripwire that flags any
  // attempt to reach a REMOTE host while offline (loopback is exempt — dev renderer +
  // llama.cpp sidecar bind 127.0.0.1). The guard only logs; it never blocks. It is
  // installed in ALL builds when offline (not just dev) so a production regression that
  // tried to phone home would still be recorded in the local log.
  // When the workspace is locked the allowNetwork setting is unreadable → treat as off.
  const unlocked = workspace.isUnlocked()
  const status = buildPolicyStatus(
    paths.configPath,
    unlocked ? getSettings(ctx.db).allowNetwork : false,
    (m) => log.warn(m),
    { isDev }
  )
  assertOfflinePosture({
    posture: { offline: status.offlineMode, networkAllowed: status.networkAllowed },
    installGuard: true,
    log: (m, meta) => log.info(m, meta),
    warn: (m, meta) => log.warn(m, meta),
    // A tripped offline guard goes on the user's local audit record too.
    onViolation: (host) =>
      audit('offline_guard_violation', 'A remote connection attempt was detected while offline', {
        host
      })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'HilbertRaum',
    // Pre-paint window color: follow the OS theme (the renderer applies the real
    // theme tokens — --bg light/dark — before first paint; this only avoids a
    // mismatched flash while the window comes up).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f7f8fa',
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

  // Deny-by-default permission handler. Electron GRANTS permission requests when no
  // handler is installed; this renderer needs exactly one: audio-only `media` from
  // OUR OWN window for voice dictation. Everything else — video, other permissions,
  // other WebContents — is refused.
  installPermissionRequestHandler(mainWindow.webContents.session, {
    allowMicrophoneFor: mainWindow.webContents,
    onDeny: (permission) => log.warn('Renderer permission request denied', { permission })
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
  // `app.getLocale()` is only meaningful after whenReady (R-L1: verified on Windows —
  // it returns a BCP-47 tag like "en-US"/"de"). Best guess until settings are readable.
  initMainI18n(app.getLocale())
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
 * Graceful shutdown: stop the runtime + embedder sidecars and AWAIT their exit so no
 * orphaned `llama-server` process survives, then
 * re-encrypt + shred the plaintext working DB (encrypted vault only). `runtime.stop()`
 * waits up to a couple of seconds for the child to die, so this MUST be awaited — a
 * fire-and-forget would let Electron tear down mid-kill and orphan the children.
 */
async function shutdown(): Promise<void> {
  try {
    await Promise.allSettled([
      ctx?.runtime.stop() ?? Promise.resolve(),
      ctx?.embedder.stop?.() ?? Promise.resolve(),
      ctx?.reranker?.stop?.() ?? Promise.resolve(),
      ctx?.transcriber?.stop?.() ?? Promise.resolve(),
      ctx?.ocrEngine?.stop?.() ?? Promise.resolve()
    ])
  } catch (err) {
    log.error('Error stopping sidecars on quit', String(err))
  }
  // Flush the encrypted diagnostics log to disk while the vault key is still live (lock()
  // zeroes it). No-op for plaintext_dev (that log is appended in real time).
  detachVaultKey()
  // Lock (re-encrypt + shred) the plaintext working DB. No-op for plaintext_dev.
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
    detachVaultKey() // flush the encrypted log before lock() zeroes the key
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
