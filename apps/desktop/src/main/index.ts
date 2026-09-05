import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerMonitor, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePaths, ensureWorkspaceDirs, findPreparedDriveRoot } from './services/workspace'
import { applyUiLanguageSetting, initMainI18n, tMain } from './services/i18n'
import { createExternalOpener } from './external-open'
import { installPermissionRequestHandler, installPermissionCheckHandler } from './services/permissions'
import { installNavigationGuard } from './services/navigation-guard'
import {
  SECURE_WINDOW_WEB_PREFERENCES,
  buildCsp,
  createWindowOpenPolicy
} from './window-security'
import { getSettings, updateSettings } from './services/settings'
import { effectiveContextWindow } from './services/chat'
import { loadPolicy, buildPolicyStatus, isCommercialPolicy } from './services/policy'
import { vaultPathsFrom, workspaceAdmitsWork, WorkspaceController } from './services/workspace-vault'
import { assertOfflinePosture } from './services/offlineGuard'
import { initLogging, log, usesPlaintextLog } from './services/logging'
import { initPerf, perfMark, perfMs } from './services/perf'
import { createTrustedSenders } from './ipc/guarded-handle'
import { registerCoreIpc } from './ipc/registerCoreIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { maybeAutoStartActiveModel, registerModelIpc } from './ipc/registerModelIpc'
import { registerChatIpc } from './ipc/registerChatIpc'
import { registerDocsIpc } from './ipc/registerDocsIpc'
import { registerCollectionsIpc } from './ipc/registerCollectionsIpc'
import { registerZimIpc } from './ipc/registerZimIpc'
import { ZimService } from './services/zim'
import { cleanupZimTransients, zimTransientDir } from './services/zim/transients'
import { startKnowledgePackSession } from './services/zim/session'
import { registerEvidenceReviewsIpc } from './ipc/registerEvidenceReviewsIpc'
import { registerSkillsIpc } from './ipc/registerSkillsIpc'
import { registerBuiltinSkillAnalysisHandlers } from './services/skills/analysis'
import { registerDocTasksIpc } from './ipc/registerDocTasksIpc'
import { DocTaskManager } from './services/doctasks'
import { documentsDir } from './services/ingestion'
import { createPlaintextOps } from './services/ingestion/plaintext-ops'
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
import { createLocalApiServer, maybeStartLocalApi } from './services/local-api/lifecycle'
import { registerDownloadIpc } from './ipc/registerDownloadIpc'
import { registerEngineIpc } from './ipc/registerEngineIpc'
import { registerRagIpc } from './ipc/registerRagIpc'
import { registerBenchmarkIpc, maybeRunFirstBenchmark } from './ipc/registerBenchmarkIpc'
import { registerAuditIpc } from './ipc/registerAuditIpc'
import { registerLocalApiIpc } from './ipc/registerLocalApiIpc'
import { createAuditRecorder } from './services/audit'
import { RuntimeManager } from './services/runtime'
import {
  createGpuCrashAutoFallback,
  createSelectingRuntimeFactory,
  createSpeculativeCrashAutoFallback
} from './services/runtime/factory'
import { killRegisteredSidecarChildren } from './services/runtime/sidecar'
import { createCachedGpuProbe } from './services/runtime/gpu'
import { EVENTS, IPC } from '../shared/ipc'
import { rasterizePdfWithHiddenWindow } from './services/ocr/rasterizer'
import { findManifestById, launchContextTokens, resolveManifestsDir } from './services/models'
import { resolveAppSkillsDir, resolveUserSkillsDir } from './services/drive'
import { createSkillRegistry } from './services/skills/registry'
import { composeServices, composeTranslator, shouldReplaceTranslator } from './services/compose-services'
import {
  initBinaryVerification,
  setBinaryVerificationPosture,
  REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES
} from './services/binary-verifier'
import { createAppLifecycleHandlers, emergencyLock, performShutdown } from './shutdown'
import type { AppContext } from './services/context'

// HilbertRaum — Electron main process (the "backend").
// Security posture (spec §3.5): context isolation on, node integration off,
// sandboxed renderer, and NO network code in the core path.

// The main bundle is ESM (out/main/index.mjs) — `__dirname` doesn't exist. Reconstruct it
// from import.meta.url (the fileURLToPath idiom already used across the test suite).
const __dirname = dirname(fileURLToPath(import.meta.url))

const isDev = !app.isPackaged

// #208: dev runs used to share the packaged app's PRODUCTION workspace — `npm run dev`
// resolved the same userData fallback as every portable exe, so a dev build and a release
// operated on one real vault (mixed-version access is exactly the window the destroyed
// vault of issue #208 sat in). Give dev its own suffix BEFORE anything derives paths from
// userData. Prepared drives (HILBERTRAUM_DRIVE_ROOT / exe-adjacent drive detection) are
// unaffected — this only moves the no-drive fallback. Existing dev workspaces stay on
// disk under the unsuffixed path (CHANGELOG notes the move).
if (isDev) app.setPath('userData', `${app.getPath('userData')}-dev`)

// #208: refuse to run a second instance on the same userData. Two live instances destroy
// an encrypted vault: the second one's startup crash-sweep random-overwrites the first
// one's plaintext working DB in place (on Windows the overwrite passes SQLite's share
// modes while the unlink fails, so the noise keeps the file's name), the first instance
// notices nothing, and its lock-on-quit encrypts the noise over the good `.enc`. The lock
// is scoped to userData, so every portable release build AND dev (with its own suffix)
// contend correctly; it must be taken BEFORE app-ready, ahead of initBackend()'s
// workspace.init() sweep. The primary instance surfaces the attempt by focusing its
// window (the standard single-instance UX).
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// Re-hash sidecar binaries before spawn (vuln-scan B): enforce in packaged builds, skip in
// dev. Set once here so every spawn seam (chat/embedder/reranker/vision sidecars, the GPU
// probe, whisper-cli) shares one decision.
initBinaryVerification(isDev)

let mainWindow: BrowserWindow | null = null
// WebContents ids allowed to invoke `handle` channels (#252): the main window's, added in
// createWindow. The OCR rasterizer window only `send`s and the print window has no preload.
const trustedSenders = createTrustedSenders()
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
  // Perf marks (opt-in, HILBERTRAUM_PERF_LOG=1) land beside app.log; buffered marks
  // (app_ready) flush here. See services/perf.ts for the content rules.
  initPerf(paths.logsPath)
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
  // Drive posture for the pre-spawn binary verifier (#234): a commercial drive may refuse
  // hashless install markers — behind the shipped-OFF constant until the owner rules.
  setBinaryVerificationPosture({
    commercial: isCommercialPolicy(policy),
    refuseHashlessMarkers: REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES
  })
  const workspace = new WorkspaceController(
    vaultPathsFrom({ configPath: paths.configPath, dbPath: paths.dbPath, logsPath: paths.logsPath }),
    policy,
    isDev
  )
  workspace.init()
  // Knowledge packs (#301, findings L3/M4, residual R-7): the CRASH sweep of this workspace's
  // `zim-transient/` — the plaintext `library.<n>.xml` / `meta-<n>/library.xml` a hard exit,
  // a power loss or a killed process left behind. Runs in BOTH workspace modes (the directory
  // exists in plaintext_dev too) and with an EMPTY keep set (no child of THIS process can own
  // anything yet). It deliberately runs even when `isRecoveryBlocked()`: the directory never
  // holds user data, its removal cannot interfere with the `.recovery` salvage of the last
  // session's newest data, and leaving pack titles + absolute paths lying in plaintext until
  // the block clears would be the worse outcome. Contained and link-refusing (transients.ts).
  {
    const report = cleanupZimTransients(zimTransientDir(paths.workspacePath), paths.workspacePath, {
      keep: new Set<string>()
    })
    if (report.confirmed) {
      if (report.removed > 0) log.info('Startup: ZIM transients swept', { removed: report.removed })
    } else {
      // Counts only — never a pack title, never a path (the sentinel rule).
      log.warn('Startup: ZIM transient sweep NOT confirmed', {
        removed: report.removed,
        unknownEntries: report.unknownEntries
      })
    }
  }
  log.info('Workspace state', workspace.getState())
  if (workspace.isRecoveryBlocked()) {
    // #242: the salvage of the last session's newest data is blocked by a held recovery
    // file; the crash sweep was skipped and the unlock IPC refuses until a retry lands it.
    log.warn('Workspace recovery blocked: a recovery file is held by another program')
  }
  if (workspace.isNewerWorkspace()) {
    // #247: the plaintext database on disk was written by a newer build — left closed and
    // untouched; the gate reports `workspace_newer` (update the app).
    log.warn('Workspace not opened: its database was written by a newer build (update the app)')
  }

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
    restart: (opts) => {
      // AUD-02: `forceRestart` re-checks only the QUIT latch, so a GPU crash landing during or
      // after a workspace lock would respawn a CPU llama-server past the lock — an unwanted
      // multi-GB child while the app sits at the unlock gate (resource/orphan, not a content
      // leak: the crashed child's KV cache died with it, and the CPU replacement starts empty).
      // The manager holds no workspace reference, so the admission check goes here, at the
      // composition seam that does. Nothing is lost: the unlock auto-start brings the model
      // back up, and `persistGpuFailure` above already recorded the fallback intent.
      if (!workspaceAdmitsWork(workspace)) {
        log.info('GPU crash restart skipped — the workspace is locked or locking')
        return Promise.resolve()
      }
      return runtimeRef?.forceRestart(opts) ?? Promise.resolve()
    },
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
  // #182: the same force-restart discipline for a crash of the SPECULATIVE rung — but the
  // GPU flags stay untouched, so the model comes back ON the GPU with MTP latched off for
  // the session (the ladder set that latch before calling this).
  const speculativeCrashFallback = createSpeculativeCrashAutoFallback({
    restart: (opts) => {
      // Same AUD-02 admission check as the GPU sibling above: never respawn past a lock.
      if (!workspaceAdmitsWork(workspace)) {
        log.info('Speculative crash restart skipped — the workspace is locked or locking')
        return Promise.resolve()
      }
      return runtimeRef?.forceRestart(opts) ?? Promise.resolve()
    },
    onCrash: (reason) => {
      audit('runtime_crashed', 'Model runtime stopped unexpectedly', {
        reason: reason.slice(0, 500)
      })
      log.warn('Speculative decoding crashed mid-session — restarting without it', { reason })
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
      onSelect: (kind, opts, reason) => {
        log.info('Runtime backend selected', { kind, modelId: opts.modelId, reason })
        // The reason string names the winning ladder rung and backend (gpu/cpu/mock).
        perfMark('runtime_selected', { kind, modelId: opts.modelId, reason })
      },
      // #109: the hidden warm-up generation inside the "Starting…" window. A non-done
      // outcome never fails the start (the server is healthy) — it just means the first
      // prompt may still be cold, which the #39 warm-up hint then covers.
      onWarmup: (opts, event, detail) =>
        event === 'done'
          ? log.info('Model warm-up generation done', { modelId: opts.modelId })
          : log.warn('Model warm-up generation did not complete — proceeding to ready', {
              modelId: opts.modelId,
              event,
              detail
            }),
      // #114: the concurrent sequential prefetch riding the load window. Only a read
      // failure warns — 'aborted' is the normal outcome (the load finished first), and
      // none of the events affects the start. The mark pair (started → settle) lets a
      // HILBERTRAUM_PERF_LOG run time the window offline.
      // #182: whether the MTP rung ran, was skipped, or was latched off — the ONLY place
      // that decision is visible, and the answer to "is the speed-up actually on?".
      onSpeculative: (opts, event, detail) => {
        perfMark('runtime_speculative', { modelId: opts.modelId, event })
        const fields = { modelId: opts.modelId, ...(detail ? { detail } : {}) }
        if (event === 'enabled') log.info('Speculative decoding enabled (MTP draft head)', fields)
        else if (event === 'skipped') log.info('Speculative decoding not used', fields)
        else log.warn(`Speculative decoding ${event} — continuing without it`, fields)
      },
      onPrefetch: (opts, event, detail) => {
        perfMark('model_prefetch', { modelId: opts.modelId, event })
        if (event === 'failed') {
          log.warn('Model prefetch failed — the load proceeds unassisted', {
            modelId: opts.modelId,
            detail
          })
        } else {
          log.info(`Model prefetch ${event}`, { modelId: opts.modelId, ...(detail ? { detail } : {}) })
        }
      },
      gpu: {
        ...gpuSignals,
        onGpuFailure: persistGpuFailure,
        probeDevices: gpuProbe,
        onGpuCrash: (opts, info) => gpuCrashFallback(opts, info),
        onSpeculativeCrash: (opts, info) => speculativeCrashFallback(opts, info)
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
  // Packaged-mode OCR execution probe (#232): one bounded worker start, released on success.
  // Fire-and-forget — startup never waits on it; a failure only latches the engine unavailable.
  // Content-free log: outcome + duration.
  if (ocrEngine?.probe) {
    const probeT0 = performance.now()
    void ocrEngine.probe().then(
      (ok) =>
        log.info('OCR execution probe', {
          ok,
          ms: Math.round(performance.now() - probeT0),
          engine: ocrEngine.id
        }),
      (err: unknown) =>
        log.warn('OCR execution probe threw', {
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
        })
    )
  }

  // Document task engine: one-at-a-time summary/translation/compare jobs. The
  // chat-streaming guard reads the shared in-flight registry — tasks never put
  // entries INTO that map; they own their AbortControllers. The ingestion deps +
  // vault lease serve the translation materialize step: the new document goes
  // through the normal import path (embedded + `.enc`-encrypted) while holding
  // `beginDocumentWork()` for exactly that step.
  // #237: the registry of plaintext-materialising operations; the lock/quit teardowns abort,
  // settle and sweep it (see `shutdown.ts` / `registerWorkspaceIpc.ts`).
  const plaintextOps = createPlaintextOps()
  // #301 (H4): a SECOND instance of the same registry, dedicated to the knowledge-pack
  // operations (an ask's arm, an article read, a registration incl. the native picker wait, the
  // reconciliation). Separate so the lock/quit ZIM settle is its own bounded step and the paths
  // it tracks are only `zim-transient/` files, never a document transient.
  const zimOps = createPlaintextOps()
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
    getIngestionDeps: () => ({ embedder, cipher: workspace.documentCipher(), ocrEngine, plaintextOps }),
    beginDocumentWork: () => workspace.beginDocumentWork(),
    // The OCR task's engine + the hidden-window PDF rasterizer.
    getOcrEngine: () => ocrEngine,
    rasterizePdf: rasterizePdfWithHiddenWindow,
    // BE-1 (ocr-audit 2026-07-18): the ingestion `processing` probe — the mirror of the docs
    // IPC `requireNoActiveTask` guard. Assigned by registerDocsIpc at registration time
    // (after this constructor runs), so read LIVE off ctx like getTranslator; unwired ⇒
    // never busy.
    isDocumentProcessing: (documentId) => ctx?.docIngestionActive?.(documentId) ?? false,
    // AUD-02: the workspace-lock admission signal. The lock arms this as its FIRST act and only
    // closes the DB at the very end of its multi-second teardown, so without it a task admitted
    // mid-teardown would pump immediately and lazily respawn the just-suspended sidecar.
    isWorkspaceLocking: () => workspace.isLocking(),
    // #185/#186: the other half of the chat exclusion. `isChatStreaming` above sees only the
    // lanes that register in `inFlightStreams`; a skill run's LLM locate pass and the hardware
    // benchmark's speed probe reach `chatStream` without ever appearing there. Scoped to the
    // OTHER lanes — a doc task must never refuse on the doc-task span it holds itself (the #38
    // tree→extract chain enqueues from inside `run()`, span still held).
    occupiedLane: () => {
      const lane = runtime.occupancy.heldLane(['doc-task'])
      // `heldLane` already filtered it out; the re-test is what narrows the type to the two
      // lanes the manager's dep accepts, so the exclusion above cannot be widened by accident.
      return lane === 'doc-task' ? null : lane
    },
    // …and the span the RUNNING task holds, so a skill run, the benchmark, and external
    // local-API admission see a multi-step task as continuously busy rather than idle in the
    // gaps between its model calls.
    beginOccupancy: () => runtime.occupancy.begin('doc-task'),
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
    trustedSenders,
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
    plaintextOps,
    zimOps,
    skills
  }
  // Knowledge packs (ZIM wave): registry + lazy kiwix-serve sidecar. Built here — not inside
  // registerZimIpc — so the quit teardown reaches it via `ctx.zim`. Spawns nothing until the
  // first ask with packs in scope (or a registration runs kiwix-manage briefly).
  ctx.zim = new ZimService({
    rootPath: paths.rootPath,
    isDev,
    // #301 (H4): the real admission pair. Every operation captures `unlockEpoch()` when it
    // begins and re-checks both after every await — so a lock refuses in-flight pack work, and
    // a lock + unlock (a NEW session with a NEW database) refuses it too, even though
    // `workspaceAdmitsWork` is true again by then.
    admission: {
      admitsWork: () => workspaceAdmitsWork(workspace),
      epoch: () => workspace.unlockEpoch()
    },
    ops: zimOps,
    // #301 (L3/M4): the transient library builds live inside the workspace, not in the host's
    // temp directory, so lock / quit / session start own them.
    transientDir: zimTransientDir(paths.workspacePath)
  })
  // The vision sidecar orchestrator (image-understanding plan §10). Built here — not inside
  // registerImagesIpc — so the workspace-lock + quit teardown paths can reach it via `ctx.vision`.
  // Lazy: it spawns nothing until the first analyze of an available model.
  ctx.vision = new VisionService({
    getStatus: () => getVisionStatus(ctx as AppContext),
    createRuntime: (status) => createVisionRuntimeFromContext(ctx as AppContext, status),
    // AUD-02: refuse for the whole lock teardown, not just this service's own stop() window —
    // an analyze admitted after that window would build a fresh vision sidecar that outlives it.
    isWorkspaceLocking: () => workspace.isLocking()
  })
  // The Translate-view job orchestrator (TG-4). Built here — not inside registerTranslateIpc — so
  // the lock/quit teardown paths can reach it via `ctx.translateJobs` and abort an in-flight text
  // translation before `translator.suspend()`/`stop()` kills the shared sidecar. Reads the composed
  // `translator` (null ⇒ friendly no-model refusal) and the doc-task lane state (D9) live.
  ctx.translateJobs = new TranslateJobService({
    getTranslator: () => (ctx as AppContext).translator ?? null,
    hasActiveDocTask: () => (ctx as AppContext).docTasks?.hasActiveTask() ?? false,
    // AUD-02: `stop()` aborts the in-flight job but takes no latch, so a start landing later in
    // the same lock teardown would get a fresh controller and respawn the suspended sidecar.
    isWorkspaceLocking: () => workspace.isLocking()
  })
  // The opt-in local API endpoint (local-api wave). Built here — not inside an IPC
  // registrar — so the lock/quit teardowns reach it via `ctx.localApi`. It binds nothing
  // until a post-unlock seam runs `maybeStartLocalApi` AND policy ∧ setting permit (D3/D7).
  ctx.localApi = createLocalApiServer(ctx as AppContext, app.getVersion())
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
  registerZimIpc(ctx)
  registerEvidenceReviewsIpc(ctx)
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
  registerLocalApiIpc(ctx)

  // Spec §2.1 first-run benchmark: a plaintext-dev workspace is already open at
  // startup — benchmark it in the background if it never was. Encrypted workspaces get
  // the same treatment after unlock/create (registerWorkspaceIpc).
  maybeRunFirstBenchmark(ctx)
  // Bring the selected model's runtime back up in the background so a
  // restarted app matches what the Home screen shows. Encrypted workspaces do this
  // after unlock/create (registerWorkspaceIpc) — settings are unreadable until then.
  maybeAutoStartActiveModel(ctx)
  // Plaintext-dev post-unlock seam for the local API (encrypted workspaces start it
  // after unlock/create in registerWorkspaceIpc); no-op unless policy ∧ setting permit.
  maybeStartLocalApi(ctx as AppContext)
  // Plaintext-dev knowledge-pack session seam (#301, L7 / D3): the workspace is already open at
  // startup here, so this is its session start — clean the transients, then reconcile the drive
  // folder once, both AFTER this function returns (never on the startup path).
  startKnowledgePackSession(ctx as AppContext)

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
  trustedSenders.add(mainWindow.webContents.id)
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

  mainWindow.once('ready-to-show', () => {
    perfMark('window_ready_to_show')
    mainWindow?.show()
  })

  // #248: a Windows shutdown, restart or log-off with the app open never emits `will-quit`
  // (Electron's `app` docs) — it is a WINDOW event, `session-end`, after which the process is
  // killed. Lock the workspace synchronously in the handler (the crash path's `emergencyLock`,
  // shared closure with the quit handlers so it can never run beside a quit teardown). The
  // window exists for the whole unlocked session on Windows (`window-all-closed` quits).
  if (process.platform === 'win32') mainWindow.on('session-end', lifecycle.onSessionEnd)

  // Open external links in the OS browser, never inside the app window — policy in
  // window-security.ts (only http(s) reaches the OS handler; the in-app open is always
  // denied), pinned by tests/unit/window-security.test.ts. #236: the OS handler is the
  // consenting opener (external-open.ts) — a native dialog names the site and the full URL
  // before anything reaches the browser, Cancel is the default, and further opens are dropped
  // while a dialog is up; pinned by tests/unit/external-open.test.ts.
  const openExternalWithConsent = createExternalOpener({
    dialog,
    shell,
    getWindow: () => mainWindow,
    t: tMain
  })
  mainWindow.webContents.setWindowOpenHandler(createWindowOpenPolicy(openExternalWithConsent))

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

// The `will-quit` / `activate` handlers live in `./shutdown` over ONE shared `isShuttingDown`
// closure (#238): a second quit during the teardown is prevented
// (the exit comes only from the teardown's finally), a Dock click during it opens no window, and
// the teardown's awaited middle is bounded by `SHUTDOWN_OVERALL_DEADLINE_MS`. Its ORDERING is
// unit-testable there (REL-4: abort in-flight streams BEFORE runtime.stop so a partial reply
// persists, mirroring the lock path). `ctx` is read at call time, not here.
const lifecycle = createAppLifecycleHandlers({
  performShutdown: () => performShutdown(ctx),
  emergencyLock: () => emergencyLock(ctx),
  exit: (code) => app.exit(code),
  createWindow,
  windowCount: () => BrowserWindow.getAllWindows().length,
  killSidecarChildren: killRegisteredSidecarChildren,
  log
})

app.whenReady().then(() => {
  // #208 belt: `app.exit` above is immediate, but if ready ever races it, a secondary
  // instance must not reach initBackend() — its workspace.init() crash-sweep is the very
  // thing that shreds the primary's live working DB.
  if (!isPrimaryInstance) return
  perfMark('app_ready')
  // `app.getLocale()` is only meaningful after whenReady (R-L1: verified on Windows —
  // it returns a BCP-47 tag like "en-US"/"de"). Best guess until settings are readable.
  initMainI18n(app.getLocale())
  const backendT0 = performance.now()
  try {
    initBackend()
  } catch (err) {
    log.error('Backend initialization failed', String(err))
  }
  perfMark('backend_init_done', { ms: perfMs(backendT0) })
  // The renderer's one allowed timing mark: the WorkspaceGate (password prompt) became
  // visible. Hard allowlist, since the renderer is the untrusted boundary (M-S2); any
  // other payload is dropped. No-op unless HILBERTRAUM_PERF_LOG=1.
  ipcMain.on(IPC.perfMark, (_e, event: unknown) => {
    if (event === 'gate_visible') perfMark('gate_visible')
  })
  createWindow()

  app.on('activate', lifecycle.onActivate)

  // #248: the macOS leg — a system shutdown/restart is a `powerMonitor` event there (usable only
  // after `ready`). UNVERIFIED on a Mac — owner live check pending (#226): whether the event
  // fires before or after `will-quit` on a macOS shutdown, and whether the app is given the
  // time. Either ordering is safe by the shared closure (see `createAppLifecycleHandlers`).
  if (process.platform === 'darwin') powerMonitor.on('shutdown', () => lifecycle.onSessionEnd())
})

app.on('will-quit', lifecycle.onWillQuit)

// Last-resort crash safety: a hard `uncaughtException` skips `will-quit`, so lock the vault
// (re-encrypt + shred the plaintext working DB) and reap the sidecar children before the process
// dies — `emergencyLock` (`./shutdown`, shared with the OS session-end handler, #248): best-effort
// and synchronous; the startup crash-recovery shred is the robust backstop on next launch.
process.on('uncaughtException', (err) => {
  try {
    log.error('Uncaught exception', String(err))
    emergencyLock(ctx)
  } catch {
    /* best-effort — the lock is throw-safe inside; this keeps exit(1) the exit code regardless */
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
