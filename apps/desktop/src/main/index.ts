import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePaths, ensureWorkspaceDirs, findPreparedDriveRoot } from './services/workspace'
import { applyUiLanguageSetting, initMainI18n } from './services/i18n'
import { installPermissionRequestHandler, installPermissionCheckHandler } from './services/permissions'
import { installNavigationGuard } from './services/navigation-guard'
import {
  SECURE_WINDOW_WEB_PREFERENCES,
  buildCsp,
  createWindowOpenPolicy
} from './window-security'
import { getSettings, updateSettings } from './services/settings'
import { effectiveContextWindow } from './services/chat'
import { loadPolicy, buildPolicyStatus } from './services/policy'
import { vaultPathsFrom, WorkspaceController } from './services/workspace-vault'
import { assertOfflinePosture } from './services/offlineGuard'
import { initLogging, log, usesPlaintextLog, detachVaultKey } from './services/logging'
import { registerCoreIpc } from './ipc/registerCoreIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { maybeAutoStartActiveModel, registerModelIpc } from './ipc/registerModelIpc'
import { registerChatIpc } from './ipc/registerChatIpc'
import { registerDocsIpc } from './ipc/registerDocsIpc'
import { registerCollectionsIpc } from './ipc/registerCollectionsIpc'
import { registerSkillsIpc } from './ipc/registerSkillsIpc'
import { registerBuiltinSkillAnalysisHandlers } from './services/skills/analysis'
import { registerDocTasksIpc } from './ipc/registerDocTasksIpc'
import { DocTaskManager } from './services/doctasks'
import { documentsDir } from './services/ingestion'
import { inFlightStreams } from './ipc/inflight'
import { registerDictationIpc } from './ipc/registerDictationIpc'
import { registerImagesIpc } from './ipc/registerImagesIpc'
import {
  createVisionRuntimeFromContext,
  getVisionStatus,
  VisionService
} from './services/vision'
import { registerTranslateIpc } from './ipc/registerTranslateIpc'
import { TranslateJobService } from './services/translation/jobs'
import { registerDownloadIpc } from './ipc/registerDownloadIpc'
import { registerEngineIpc } from './ipc/registerEngineIpc'
import { registerRagIpc } from './ipc/registerRagIpc'
import { registerBenchmarkIpc, maybeRunFirstBenchmark } from './ipc/registerBenchmarkIpc'
import { registerAuditIpc } from './ipc/registerAuditIpc'
import { createAuditRecorder } from './services/audit'
import { RuntimeManager } from './services/runtime'
import { createGpuCrashAutoFallback, createSelectingRuntimeFactory } from './services/runtime/factory'
import { killRegisteredSidecarChildren } from './services/runtime/sidecar'
import { createCachedGpuProbe } from './services/runtime/gpu'
import { EVENTS } from '../shared/ipc'
import { rasterizePdfWithHiddenWindow } from './services/ocr/rasterizer'
import { findManifestById, launchContextTokens, resolveManifestsDir } from './services/models'
import { resolveAppSkillsDir, resolveUserSkillsDir } from './services/drive'
import { createSkillRegistry } from './services/skills/registry'
import { composeServices, composeTranslator, shouldReplaceTranslator } from './services/compose-services'
import { initBinaryVerification } from './services/binary-verifier'
import { performShutdown } from './shutdown'
import type { AppContext } from './services/context'

// HilbertRaum — Electron main process (the "backend").
// Security posture (spec §3.5): context isolation on, node integration off,
// sandboxed renderer, and NO network code in the core path.

// The main bundle is ESM (out/main/index.mjs) — `__dirname` doesn't exist. Reconstruct it
// from import.meta.url (the fileURLToPath idiom already used across the test suite).
const __dirname = dirname(fileURLToPath(import.meta.url))

const isDev = !app.isPackaged

// Re-hash sidecar binaries before spawn (vuln-scan B): enforce in packaged builds, skip in
// dev. Set once here so every spawn seam (chat/embedder/reranker/vision sidecars, the GPU
// probe, whisper-cli) shares one decision.
initBinaryVerification(isDev)

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
    // REL-1: a mid-session GPU crash must FORCE a real stop-then-start. `start()` would hit
    // the same-model idempotency guard (the crashed runtime is still `current`) and no-op, so
    // the restart is silently swallowed and `status()` keeps reporting the dead server healthy.
    // `forceRestart` bypasses that guard atomically; `persistGpuFailure` (below) runs first, so
    // the rebuilt ladder lands on CPU and the fallback can fire at most once (no restart loop).
    restart: (opts) => runtimeRef?.forceRestart(opts) ?? Promise.resolve(),
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
  // The Settings-driven GPU intent, shared verbatim between the chat ladder and the translation
  // sidecar's device ladder (issue #42) so the two can never read the flags differently.
  const gpuSignals = {
    getGpuMode: () => readGpuSetting((s) => s.gpuMode, 'auto' as const),
    getGpuAutoDisabled: () => readGpuSetting((s) => s.gpuAutoDisabled, false)
  }
  const runtime = new RuntimeManager(
    createSelectingRuntimeFactory({
      rootPath: paths.rootPath,
      // M-5: the dev-only HILBERTRAUM_LLAMA_BIN override is honoured only in a dev build.
      isDev,
      onSelect: (kind, opts, reason) =>
        log.info('Runtime backend selected', { kind, modelId: opts.modelId, reason }),
      gpu: {
        ...gpuSignals,
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
  const { embedder, reranker, transcriber, ocrEngine, translator } = composeServices({
    rootPath: paths.rootPath,
    manifestsDir,
    // M-5: dev-only binary env overrides are honoured only in a dev build.
    isDev,
    // Issue #42: the translation sidecar honours the same gpuMode/gpuAutoDisabled the chat
    // ladder reads (read per cold start — a Settings flip needs no restart).
    gpu: gpuSignals
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
    // TG-3: the translation kind runs on the TranslateGemma sidecar — availability-driven;
    // null → the friendly install path, never the chat runtime. Read LIVE off ctx (issue #40):
    // a mid-session model download re-assigns `ctx.translator`, and capturing the startup const
    // here was exactly the staleness that forced a restart. `ctx` is assigned below, before any
    // task can run.
    getTranslator: () => ctx?.translator ?? null,
    isChatStreaming: () => inFlightStreams.size > 0,
    // Doc-task window budgets follow the REAL launched context window (§L0 — the same source
    // chat/RAG assembly budgets against), not bare `settings.contextTokens`: the runtime is
    // launched with the user's override ?? the manifest's recommended size, which can diverge
    // from the setting — "different context sizes in different areas" was exactly the 2026-07-04
    // user-report confusion. With no runtime up (tasks then refuse anyway) fall back to the
    // SAME value the next start would launch with — launchContextTokens over the ACTIVE
    // model's manifest, the one precedence startModelRuntime uses. The old fallback skipped
    // the manifest's recommended window, so maybeEnqueueTreeBuild's size gate planned against
    // the legacy 4096 default instead of the real 32k+ window and over-marked documents
    // tree_status='pending' (full-audit 2026-07-10 BE-5).
    getContextTokens: () => {
      const s = getSettings(workspace.requireDb())
      const active = runtime.active()
      if (active) return effectiveContextWindow(active, s)
      return launchContextTokens(s, findManifestById(manifestsDir, s.activeModelId))
    },
    getStoreDir: () => documentsDir(paths.workspacePath),
    getIngestionDeps: () => ({ embedder, cipher: workspace.documentCipher(), ocrEngine }),
    beginDocumentWork: () => workspace.beginDocumentWork(),
    // The OCR task's engine + the hidden-window PDF rasterizer.
    getOcrEngine: () => ocrEngine,
    rasterizePdf: rasterizePdfWithHiddenWindow,
    audit
  })

  // Skill registry (skills plan §8): the uniform disk-reconcile over the plain app-skills/ +
  // user-skills/ folders (outside the encrypted workspace). app-skills/ falls back to the repo
  // source dir in a dev build (resolveAppSkillsDir, the manifests precedent). Reconcile needs an
  // unlocked DB, so it is best-effort here (works in plaintext_dev; a locked encrypted DB defers
  // to a later phase that re-runs it post-unlock — S3 has no skill-reading surface yet).
  const skills = createSkillRegistry({
    getDb: () => workspace.requireDb(),
    appSkillsDir: resolveAppSkillsDir(paths.rootPath, app.getAppPath()),
    userSkillsDir: resolveUserSkillsDir(paths.rootPath),
    appVersion: app.getVersion()
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
    // The TranslateGemma sidecar (TG wave). Held on ctx so the lock/quit teardowns reach it
    // (suspend/stop below); the translation doc-task consumes it via `getTranslator` above
    // (TG-3). Lazy — it spawns nothing until the first translate() of an available model.
    translator,
    manifestsDir,
    probeGpu: gpuProbe,
    isDev,
    audit,
    docTasks,
    skills
  }
  // The vision sidecar orchestrator (image-understanding plan §10). Built here — not inside
  // registerImagesIpc — so the workspace-lock + quit teardown paths can reach it via `ctx.vision`.
  // Lazy: it spawns nothing until the first analyze of an available model.
  ctx.vision = new VisionService({
    getStatus: () => getVisionStatus(ctx as AppContext),
    createRuntime: (status) => createVisionRuntimeFromContext(ctx as AppContext, status)
  })
  // The Translate-view job orchestrator (TG-4). Built here — not inside registerTranslateIpc — so
  // the lock/quit teardown paths can reach it via `ctx.translateJobs` and abort an in-flight text
  // translation before `translator.suspend()`/`stop()` kills the shared sidecar. Reads the composed
  // `translator` (null ⇒ friendly no-model refusal) and the doc-task lane state (D9) live.
  ctx.translateJobs = new TranslateJobService({
    getTranslator: () => (ctx as AppContext).translator ?? null,
    hasActiveDocTask: () => (ctx as AppContext).docTasks?.hasActiveTask() ?? false
  })
  // Issue #40: a completed in-app model download re-runs the translation selector, so the
  // Translate screen stops claiming the model is missing the moment the GGUF lands — no restart.
  // Only a NULL slot or a `startFailed`-latched instance is ever re-composed (BE-7, full-audit
  // 2026-07-10: a latched instance is lazy/dead, so the delete-and-re-download repair flips it
  // to a working translator; `shouldReplaceTranslator` holds the rule) — never a LIVE sidecar:
  // a running instance means the role was already available, and construction of the lazy
  // runtime spawns nothing. All translator consumers read `ctx.translator` live
  // (translateJobs/docTasks/IPC/lock/quit), so one re-assignment flips them together. The
  // transcriber/reranker/embedder keep the documented restart requirement for now — their
  // handles are captured at wiring time in registerDocsIpc / ingestion deps, so a ctx
  // re-assignment alone would activate them inconsistently.
  ctx.onModelInstalled = () => {
    if (!ctx || !shouldReplaceTranslator(ctx.translator)) return
    ctx.translator = composeTranslator({
      rootPath: paths.rootPath,
      manifestsDir,
      isDev,
      gpu: gpuSignals
    })
  }
  // Best-effort first reconcile (skills plan §8). In plaintext_dev the DB is already open; in
  // encrypted mode `requireDb()` throws while locked, so swallow it — a later phase reconciles on
  // unlock, and S3 ships no surface that reads skills yet.
  try {
    const result = skills.reconcile()
    log.info('Skill registry reconciled', {
      present: result.present,
      inserted: result.inserted,
      updated: result.updated,
      markedUnavailable: result.markedUnavailable,
      errorCount: result.errors.length
    })
    // SKA-32 (skills audit 2026-07-03, U7): discovery errors used to be silently dropped here.
    // COUNT + structural reason codes ONLY — never the human-readable lines, which can carry a
    // (validated) folder path, and never arbitrary folder names/content (§22-M1).
    if (result.errors.length > 0) {
      log.warn('Some skill folders could not be read', {
        count: result.errors.length,
        codes: [...new Set(result.errorCodes)]
      })
    }
  } catch {
    /* workspace locked — reconcile deferred to a post-unlock pass in a later phase */
  }
  // Full-doc-skills Phase 3 (§3.2/D49): populate the analysis-handler registry once, BEFORE any IPC
  // (so `askDocuments` can consult it on the very first chat turn). No import-time side effects — the
  // registry is opt-in per skill; an unregistered skill keeps the relevance path verbatim (R5).
  registerBuiltinSkillAnalysisHandlers()
  registerCoreIpc(ctx)
  registerWorkspaceIpc(ctx)
  registerModelIpc(ctx)
  registerChatIpc(ctx)
  registerDocsIpc(ctx)
  registerCollectionsIpc(ctx)
  registerSkillsIpc(ctx)
  registerDocTasksIpc(ctx)
  registerDictationIpc(ctx)
  registerImagesIpc(ctx, ctx.vision)
  registerTranslateIpc(ctx, ctx.translateJobs)
  registerDownloadIpc(ctx)
  registerEngineIpc(ctx)
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
  // The brand-mark window/taskbar icon. On a packaged Windows build the .exe already
  // carries build/icon.ico (electron-builder embeds it), so build/ is not inside the
  // asar — this path only resolves in dev and on Linux, where the explicit icon matters.
  const iconPath = join(app.getAppPath(), 'build', 'icon.png')
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'HilbertRaum',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    // Pre-paint window color: follow the OS theme (the renderer applies the real
    // theme tokens — --bg light/dark — before first paint; this only avoids a
    // mismatched flash while the window comes up).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      ...SECURE_WINDOW_WEB_PREFERENCES
    }
  })

  // Content-Security-Policy as a response header (defence in depth on top of the
  // index.html meta tag, spec §3.5). The strings live in window-security.ts (TS-2),
  // pinned by tests/unit/window-security.test.ts — edit them THERE.
  const csp = buildCsp(isDev)
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  // Deny-by-default permission handlers. Electron GRANTS permissions when no handler is
  // installed; this renderer needs exactly one: audio-only `media` from OUR OWN window for
  // voice dictation. Everything else — video, other permissions, other WebContents — is
  // refused. SEC-2 (backend-audit-2026-06-27): install BOTH the async *request* handler
  // AND the synchronous *check* handler (`navigator.permissions.query` / the internal
  // pre-getUserMedia check), which otherwise falls back to Electron's default-grant. Both
  // share one grant predicate (permissions.ts), so they can never disagree.
  installPermissionRequestHandler(mainWindow.webContents.session, {
    allowMicrophoneFor: mainWindow.webContents,
    onDeny: (permission) => log.warn('Renderer permission request denied', { permission })
  })
  installPermissionCheckHandler(mainWindow.webContents.session, {
    allowMicrophoneFor: mainWindow.webContents
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Open external links in the OS browser, never inside the app window — policy in
  // window-security.ts (only http(s) reaches the OS handler; the in-app open is always
  // denied), pinned by tests/unit/window-security.test.ts.
  mainWindow.webContents.setWindowOpenHandler(
    createWindowOpenPolicy((url) => void shell.openExternal(url))
  )

  // Block in-app navigation to remote origins (defence in depth). SEC-3
  // (backend-audit-2026-06-27): the guard covers BOTH `will-navigate` and `will-redirect`
  // (a server/<meta> redirect reaches a remote origin via `will-redirect` without firing
  // `will-navigate`). Only the app's own shell may navigate — Vite's localhost in dev, the
  // bundled `file://` page in prod.
  installNavigationGuard(mainWindow.webContents, (url) =>
    isDev ? url.startsWith('http://localhost') : url.startsWith('file://')
  )

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

app.on('will-quit', (event) => {
  if (isShuttingDown) return // cleanup already ran → let the real quit proceed
  event.preventDefault()
  isShuttingDown = true
  // Graceful quit teardown lives in `./shutdown` so its ORDERING is unit-testable (REL-4: abort
  // in-flight streams BEFORE runtime.stop so a partial reply persists, mirroring the lock path).
  void performShutdown(ctx).finally(() => app.exit(0))
})

// Last-resort crash safety: a hard `uncaughtException` skips `will-quit`, so try to lock the
// vault (re-encrypt + shred the plaintext working DB) before the process dies. Best-effort
// and synchronous; the startup crash-recovery shred is the robust backstop on next launch.
// shutdown() additionally closes a plaintext_dev DB so no -wal/-shm outlive the process (#51).
process.on('uncaughtException', (err) => {
  try {
    log.error('Uncaught exception', String(err))
    detachVaultKey() // flush the encrypted log before lock() zeroes the key
    ctx?.workspace.shutdown()
  } catch {
    /* best-effort */
  }
  // CODE-11 (full-audit 2026-07-11): a crash exit skips will-quit's awaited sidecar stops,
  // and on Windows the children survive the parent — reap every registered sidecar child
  // (best-effort, synchronous, throw-safe per PID) so no llama-server/whisper-cli orphans
  // holding GBs of RAM + loopback ports outlive the crash. After the vault lock: the lock
  // is the data-safety half, the reap is hygiene. Own try so a lock throw can't skip it.
  try {
    killRegisteredSidecarChildren()
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
