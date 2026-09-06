import { guardedHandleFor } from './guarded-handle'
import { statSync } from 'node:fs'
import { EVENTS, IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  AppSettings,
  EffectiveReadSample,
  LiveRecommendation,
  ModelInfo,
  ModelState,
  RuntimeInstallInfo,
  RuntimeStatus
} from '../../shared/types'
import type { ModelManifest } from '../../shared/manifest'
import { readRuntimeMarker } from '../services/assets'
import { llamaServerDir } from '../services/runtime/sidecar'
import {
  buildModelList,
  checksumCacheStats,
  computeInstallState,
  createSettingsHashStore,
  discoverManifests,
  graphicsBudgetMib,
  invalidateChecksum,
  launchContextTokens,
  machineRamGb,
  manifestFiles,
  recommendChatModelId,
  selectModel,
  weightPath,
  type BuildModelListOptions,
  type PickerSpeedSignal
} from '../services/models'
import { getSettings, updateSettings } from '../services/settings'
import { nextStartMemoryFor } from '../services/performance'
import { notifyPerformanceChanged } from './performance-notify'
import {
  latestEffectiveRead,
  preferCandidate,
  setEffectiveReadObserver,
  suppressNextModelLoadSample
} from '../services/read-speed'
import { detectSystem } from '../services/benchmark'
import { machineKey } from '../services/performance'
import { effectiveReadPatch, eligiblePersistedSample } from '../services/benchmark-persistence'
import type { Db } from '../services/db'
import { loadPolicy } from '../services/policy'
import { tMain } from '../services/i18n'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import { log } from '../services/logging'
import { perfMark, perfMs } from '../services/perf'

// IPC for model discovery/selection + runtime start/stop (spec §9.1).
// The hardware profile comes from the persisted benchmark (`lastBenchmark`),
// falling back to UNKNOWN until the user runs the benchmark for the first time.

/**
 * Effective checksum leniency: "developer" is the user toggle OR a dev build —
 * but the drive POLICY is authoritative and can only restrict. On a commercial drive
 * (`require_sha256_match: true` / `allow_unverified_models: false`) unverified weights
 * are rejected no matter what the toggle says; this also disables the mock fallback.
 */
/**
 * The memory inputs the chat ★ pick goes by (§6.6; PR #308 audit decisions 6 and 9): the class
 * and the BUDGET device for the NEXT start, read through `nextStartMemoryFor` from the
 * ELIGIBLE persisted probe (`eligibleGpuProbe`, PR #303 audit M8.3: a probe stamped with
 * another machine's key supplies nothing, an unstamped legacy one stays eligible) and the two
 * GPU flags — the same call `probeAndPersistGpu` and the Performance screen make, so the
 * Models ★ and the benchmark can never name different cards. `hereKey` defaults to this
 * machine's identity; the seam tests pass it to pin the foreign-probe case. Exported so the
 * seam test can pin what the `listModels` handler feeds `buildModelList`.
 */
export function pickerMemoryFor(
  s: AppSettings,
  hereKey: string | null = machineKey(detectSystem())
): Pick<BuildModelListOptions, 'memoryClass' | 'graphicsBudgetMb'> {
  const next = nextStartMemoryFor(s, hereKey)
  // The budget is the device's FREE figure (else total − 1024), raw MiB — decision 10; the same
  // `graphicsBudgetMib` call `probeAndPersistGpu` makes for the benchmark.
  return { memoryClass: next.memoryClass, graphicsBudgetMb: graphicsBudgetMib(next.device) }
}

/**
 * The §6.5 speed signal the chat ★ goes by (issue #95): the persisted Diagnostics pairing
 * (tok/s + the model that produced it, issue #52), derived fresh from `lastBenchmark` on every
 * call — stateless, never compounds. Shared by the `listModels` handler and the Performance
 * snapshot's live recommendation so both surfaces read one signal.
 */
export function speedSignalFor(s: AppSettings): PickerSpeedSignal | null {
  return s.lastBenchmark
    ? {
        tokensPerSecond: s.lastBenchmark.tokensPerSecond,
        measuredModelId: s.lastBenchmark.measuredModelId ?? null
      }
    : null
}

/**
 * The LIVE chat recommendation for the next start (PR #308 audit decision 8, finding R4), from
 * the SAME inputs the `listModels` handler feeds `buildModelList`: `pickerMemoryFor(s)` (class +
 * budget), `machineRamGb()` (whole GB — `buildModelList` reads `opts.machineRamGb` as is) and
 * `speedSignalFor(s)`; the two `??` defaults mirror `buildModelList`'s own. `buildPerformanceSnapshot`
 * returns it as `PerformanceSnapshot.recommendation`, so the Performance verdict and its "Start …
 * and measure" target can never diverge from the Models ★ — the saved
 * `lastBenchmark.recommendedModelId` is what the check said at the time and is left untouched.
 */
export function liveChatRecommendation(s: AppSettings, manifests: ModelManifest[]): LiveRecommendation {
  const memory = pickerMemoryFor(s)
  const basis = memory.memoryClass ?? 'cpu'
  const modelId = recommendChatModelId(
    manifests,
    { memoryClass: basis, ramGb: machineRamGb(), budgetMb: memory.graphicsBudgetMb ?? null },
    speedSignalFor(s)
  )
  return { modelId, basis }
}

function developerLeniency(ctx: AppContext, s: AppSettings): boolean {
  const { policy } = loadPolicy(ctx.paths.configPath, undefined, { isDev: ctx.isDev })
  const developer = s.developerMode || ctx.isDev
  return developer && policy.models.allowUnverifiedModels && !policy.models.requireSha256Match
}

/**
 * Start the runtime for a chat model, enforcing the spec §7.4 install gate (shared by
 * the `startRuntime` IPC handler and the startup auto-start). Throws on any refusal.
 */
export async function startModelRuntime(ctx: AppContext, modelId: string): Promise<RuntimeStatus> {
  // AUD-03 — snapshot WHICH unlocked session this start belongs to, before the long pre-start
  // window below. `computeInstallState` hashes a multi-GB GGUF, which takes minutes on a cold
  // checksum cache (the first unlock of a prepared or freshly-copied drive — a copy changes mtime
  // and invalidates the size+mtime cache). A lock, or a lock AND a re-unlock, can complete inside
  // that window; the epoch is the only thing that can tell the resulting stale start apart from a
  // legitimate one, because after a re-unlock `isUnlocked()` is true and `isLocking()` false
  // again. Undefined for a stand-in workspace without the counter ⇒ the epoch check is skipped
  // and the unlocked/locking re-check below still applies.
  const startEpoch = ctx.workspace.unlockEpoch?.()
  if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
  const { manifests } = discoverManifests(ctx.manifestsDir)
  const found = manifests.find((m) => m.manifest.id === modelId)
  if (!found) throw new Error(`Unknown model id: ${modelId}`)
  // The chat runtime loads chat models only; an embeddings model here would start
  // llama-server in chat mode over a 384-dim embedder and produce garbage.
  if (found.manifest.role !== 'chat') {
    throw new Error(`Model "${modelId}" is a ${found.manifest.role} model, not a chat model.`)
  }

  const s = getSettings(ctx.db)
  // Enforce the spec §7.4 gate in the MAIN process (not just a disabled button): only
  // an installed (verified) model may start. One exception keeps the zero-weights
  // first-run journey alive — for a developer (toggle or dev build, when the drive
  // policy permits unverified models) a MISSING model may start, because the selecting
  // runtime factory then falls back to the built-in mock runtime.
  const lenient = developerLeniency(ctx, s)
  // The multi-GB weight hash below is the dominant cold-start cost on slow media and is
  // otherwise invisible in the logs; `computed` moving distinguishes a real hash from a
  // (size+mtime) cache hit.
  const installT0 = performance.now()
  const computedBefore = checksumCacheStats.computed
  const state = await computeInstallState(found.manifest, ctx.paths.rootPath, {
    developerMode: lenient,
    hashStore: createSettingsHashStore(() => ctx.db, ctx.paths.rootPath)
  })
  const cacheHit = checksumCacheStats.computed === computedBefore
  perfMark('install_state_done', {
    modelId,
    state,
    ms: perfMs(installT0),
    cacheHit
  })
  // #108/F-35: a real hash just pulled the weight through the page cache, so the load
  // window below would read RAM on a big-RAM machine — its sample would be the exact
  // inflated-figure class this wave retires. Suppress it; the next un-hashed start
  // samples honestly.
  if (!cacheHit) suppressNextModelLoadSample()
  const mockFallback = state === 'missing' && lenient
  if (state !== 'installed' && !mockFallback) {
    // §7 voice: the problem and the next step; the raw state code stays in Diagnostics/logs.
    throw new Error(
      state === 'checksum_failed'
        ? `"${found.manifest.displayName}" can't be started — we couldn't verify its file. ` +
          'It may be incomplete; try downloading it again.'
        : `"${found.manifest.displayName}" can't be started — its model file isn't installed ` +
          'on this drive yet.'
    )
  }

  // RAM gate: loading real weights that exceed this machine's memory would
  // thrash or OOM mid-chat — refuse with a friendly, spec §11.4-toned message. Only
  // real weights are gated; the zero-weights mock fallback uses no real memory.
  if (state === 'installed' && found.manifest.recommendedMinRamGb > machineRamGb()) {
    throw new Error(
      `"${found.manifest.displayName}" needs at least ${found.manifest.recommendedMinRamGb} GB RAM; ` +
        `this computer has about ${machineRamGb()} GB. Pick a smaller model — quality stays great.`
    )
  }

  // CODE-3 (full-audit 2026-07-11): the multi-GB weight hash above (`computeInstallState`)
  // is the long pre-start window a quit can begin inside — re-check the manager's shutdown
  // latch before touching the runtime, so a background auto-start racing `performShutdown`
  // never enqueues a fresh start after the teardown's stop. `RuntimeManager.start()`
  // re-checks too; this earlier check just fails the auto-start cheaply and clearly.
  // Optional call: bare boundary-fake runtimes in tests omit it (the `warmedUp?.()` idiom).
  if (ctx.runtime.isShutdown?.()) {
    throw new Error('The app is quitting — the model start was abandoned')
  }
  // AUD-03: the same re-check for the LOCK path, which had no equivalent of the quit latch. The
  // lock handler's `runtime.stop()` finds `startingRuntime === null` (that is only set once
  // `runtime.start()` is invoked, i.e. after this hash), the shutdown latch above is quit-only,
  // and nothing else fails the pipeline: the hash store deliberately swallows its write against a
  // closed DB to keep the session served, the RAM gate is OS-only, and the GPU-settings reads
  // degrade to safe defaults while locked. So without this the hash would resolve after the lock
  // completed and spawn a full llama-server while the app sits at the unlock gate.
  if (!workspaceAdmitsWork(ctx.workspace)) {
    throw new Error('The workspace is locked — the model start was abandoned')
  }
  // …and the residual micro-window: a lock AND a subsequent unlock both completing inside the
  // hash leave the two flags above looking exactly like "still unlocked". The session epoch does
  // not — this start was admitted into a session that no longer exists.
  if (startEpoch !== undefined && ctx.workspace.unlockEpoch?.() !== startEpoch) {
    throw new Error('The workspace was locked and re-opened — the stale model start was abandoned')
  }

  log.info('Start runtime', { modelId, state })
  const runtimeT0 = performance.now()
  const status = await ctx.runtime.start({
    modelId,
    modelPath: weightPath(ctx.paths.rootPath, found.manifest),
    // The user's context-size pick (AI Model screen) wins; automatic (null) = the model's
    // recommended window, falling back to the legacy setting for a manifest without one.
    // The precedence lives in launchContextTokens (shared with the no-runtime doc-task
    // budget fallback — full-audit 2026-07-10 BE-5). Every downstream budget follows the
    // LAUNCHED window via ModelRuntime.contextWindow() (§L0).
    contextTokens: launchContextTokens(s, found.manifest),
    // #107/#108: everything the load window reads (a vision model reads its mmproj
    // projector too) — the progress denominator and the read-sample byte count.
    weightBytes: manifestReadBytes(ctx.paths.rootPath, found.manifest),
    // #114: the same file set as paths, in load order — the concurrent prefetch
    // reads them sequentially alongside the first rung's load.
    weightPaths: manifestFiles(ctx.paths.rootPath, found.manifest).map((f) => f.path),
    // #182: the manifest's opt-in, not a decision. The ladder gates it on the hardware it
    // actually finds and silently drops it when the machine cannot benefit.
    speculativeDecoding: found.manifest.speculativeDecoding ?? null
  })
  perfMark('runtime_ready', {
    modelId,
    backend: status.backend ?? null,
    ms: perfMs(runtimeT0)
  })
  ctx.audit?.('runtime_started', `Model runtime started: ${modelId}`, {
    modelId,
    backend: status.backend ?? null
  })
  // #108: the load window (and/or the hash above) may have produced a fresh honest
  // read sample — fold it into the persisted benchmark result.
  persistEffectiveRead(ctx)
  return status
}

/**
 * Total bytes a start of this manifest will read (GGUF + a vision model's mmproj), or
 * null when any file is un-stattable — the #107 progress denominator and the #108
 * read-sample byte count. Never throws (an escaping mmproj path or vanished file just
 * degrades to the manager's bare modelPath stat).
 */
function manifestReadBytes(rootPath: string, manifest: ModelManifest): number | null {
  try {
    let total = 0
    for (const f of manifestFiles(rootPath, manifest)) total += statSync(f.path).size
    return total
  } catch {
    return null
  }
}

/**
 * The sample most recently written to EVERY eligible destination — lets the persist helper
 * no-op without a settings read on every poll/list call once a sample is stored. Scoped to
 * the workspace DB handle and this machine's key: a lock/unlock (a new `Db`) or a drive on
 * another computer re-evaluates rather than trusting a memo made against other settings.
 * Set only after a successful write to all eligible destinations, so a failed or deferred
 * write (a locked workspace, a closed DB) leaves it unset and the next call retries.
 */
let persistedSampleMemo: { at: string; db: Db; key: string | null } | null = null

/** #107: the effective-read sample resolved once per "Starting…" window (keyed on the
 *  starting model), so the 2.5 s status poll never re-reads settings mid-window. A
 *  sample landing MID-window (rare: a concurrent cold hash) is picked up next window. */
let startingSampleMemo: { forModelId: string; sample: EffectiveReadSample | null } | null = null

/**
 * Fold the session's latest honest effective-read sample (services/read-speed.ts) into
 * the persisted benchmark result for THIS machine (#108) — `settings.lastBenchmark` when
 * that result is this machine's (or unkeyed on either side, G3) AND this machine's
 * `benchmarkHistory` entry when one exists (L2: a restore after a round trip used to bring
 * back the stale copy) — re-keying the one warning that tracks the sample (#110,
 * `upsertSlowReadWarning`): the only automatic benchmark runs before any model exists, so
 * without this the primary slow-read warning would never appear on the default journey,
 * and a stale one could contradict the freshly updated Diagnostics row beside it. A
 * foreign `lastBenchmark` is never touched (a local sample never rides another computer's
 * result); with no eligible destination at all the sample stays un-handled — a benchmark
 * is never fabricated just to store it. Registered as the read-speed OBSERVER (fires on
 * every recorded sample, including a background download path with no model IPC
 * afterwards) and also invoked after start/list/verify as cheap retries for samples whose
 * observer-time persist hit a locked workspace. The cross-session source ranking is
 * enforced per destination (`effectiveReadPatch` → `preferCandidate`): a fresh session's
 * checksum sample never overwrites last session's persisted model-load sample. Never
 * throws (persistGpuFailure precedent). Exported as the explicit retry seam (and for the
 * persistence tests); production callers are this module's handlers and the observer
 * registered in `registerModelIpc`.
 *
 * The `performance:changed` push (P3): a retry call pushes only when it actually WROTE (the
 * Drive tile's persisted figure moved); the observer wiring pushes on every accepted sample
 * regardless (the observed rows read the per-source latches, which moved even when the
 * persist was a ranked no-op) — see `persistPendingEffectiveRead`.
 */
export function persistEffectiveRead(ctx: AppContext): void {
  if (persistPendingEffectiveRead(ctx)) notifyPerformanceChanged()
}

/** The persist itself; true when a settings write happened, false on a no-op or a deferral. */
function persistPendingEffectiveRead(ctx: AppContext): boolean {
  try {
    const sample = latestEffectiveRead()
    if (!sample) return false
    const here = machineKey(detectSystem())
    const db = ctx.db // throws while locked → the catch below, memo untouched, retried later
    const memo = persistedSampleMemo
    if (memo && memo.at === sample.at && memo.db === db && memo.key === here) return false
    const patch = effectiveReadPatch(getSettings(db), sample, here)
    if (patch === null) return false // no eligible destination yet — not handled, retry next call
    // Ordering (no multi-key transaction in the settings store): history first, then
    // lastBenchmark — a crash between the two loses at most the headline copy, never a machine.
    let wrote = false
    if (patch.benchmarkHistory || patch.lastBenchmark) {
      updateSettings(db, { benchmarkHistory: patch.benchmarkHistory, lastBenchmark: patch.lastBenchmark })
      wrote = true
    }
    persistedSampleMemo = { at: sample.at, db, key: here }
    return wrote
  } catch (err) {
    log.warn('Could not persist the effective-read sample', { error: String(err) })
    return false
  }
}

/**
 * The current effective-read sample for consumers OUTSIDE the recording path (#108):
 * this session's latch (always this machine's) vs the persisted sample THIS machine may
 * carry (`eligiblePersistedSample`: identity before ranking — a foreign `lastBenchmark`'s
 * sample is never a candidate, this machine's own history entry is), under the SAME
 * source ranking the latch itself uses (`preferCandidate`) — so a session checksum sample
 * never shadows last session's persisted model-load sample here either (it would bake the
 * worse figure into a fresh benchmark's warnings, or a wrong #107 estimate), while a local
 * checksum sample does beat a foreign persisted model-load one. The single definition of
 * this fallback, shared by the benchmark injection (before AND after the run, M6) and the
 * progress estimate; a settings error (locked workspace) reads as latch-only. Detection
 * (`detectSystem`) is a handful of `node:os` calls — computed per call, never memoized for
 * the process (the #107 poll memoizes the whole result per "Starting…" window itself).
 */
export function effectiveReadOrPersisted(ctx: AppContext): EffectiveReadSample | null {
  const latched = latestEffectiveRead()
  let persisted: EffectiveReadSample | null = null
  try {
    persisted = eligiblePersistedSample(getSettings(ctx.db), machineKey(detectSystem()))
  } catch {
    persisted = null
  }
  if (!latched) return persisted
  return preferCandidate(latched, persisted) ? latched : persisted
}

/**
 * Auto-start the selected (active) chat model in the background once the workspace is
 * usable (app launch for plaintext_dev; unlock/create for encrypted) — a restarted app
 * used to show an "active" model whose runtime silently was not running until the user
 * visited Models and pressed Start. Mirrors `maybeRunFirstBenchmark`: never throws,
 * never blocks; a failure is logged and the manual start path still works.
 */
export function maybeAutoStartActiveModel(ctx: AppContext): void {
  let modelId: string | null = null
  try {
    // AUD-02/AUD-03: `workspaceAdmitsWork` — never begin an auto-start while a lock teardown is
    // running; `startModelRuntime` re-checks after its multi-GB weight hash as well.
    if (!workspaceAdmitsWork(ctx.workspace)) return
    const s = getSettings(ctx.db)
    if (!s.autoStartActiveModel) return
    modelId = s.activeModelId
    if (!modelId) return
    if (ctx.runtime.activeModelId()) return // something is already running — keep it
  } catch {
    return // settings unreadable (e.g. just locked again) — manual start still works
  }
  if (!modelId) return
  log.info('Auto-starting the active model runtime in the background', { modelId })
  void startModelRuntime(ctx, modelId).catch((err) =>
    log.warn('Auto-start of the active model failed (start it from the AI Model screen)', {
      modelId,
      error: String(err)
    })
  )
}

export function registerModelIpc(ctx: AppContext): void {
  const ipcHandle = guardedHandleFor(ctx)
  // #108: persistence is a property of RECORDING — the observer fires on every sample
  // (including one from a background download's cold-file hash, which has no model IPC
  // afterwards to piggyback on). The explicit persistEffectiveRead calls after
  // start/list/verify remain as cheap retries for observer-time persists that hit a
  // locked workspace. The SINGLE observer wiring for the process: persist first, then the
  // Performance push — on EVERY accepted sample (P3), including a checksum that lost the
  // ranked slot to an earlier model load, whose per-source latch the observed rows show.
  setEffectiveReadObserver(() => {
    persistPendingEffectiveRead(ctx)
    notifyPerformanceChanged()
  })
  // F16 (audit-postmerge-2026-06-29): the DB-touching model handlers (list/select/verify/start all
  // read ctx.db via getSettings/selectModel/computeInstallState) fail-close when locked but throw
  // the raw English vault string; gate them with the localized copy (parity). stopRuntime + the two
  // read-only runtime channels (status/install) touch the in-memory runtime / disk marker, never
  // ctx.db, and must stay usable at the gate, so they are intentionally NOT gated.
  const requireUnlocked = (): void => {
    // AUD-02: `workspaceAdmitsWork`, never a bare `isUnlocked()` — the workspace DB stays
    // OPEN for the whole multi-second lock teardown, so a bare check admits work that then
    // lazily respawns the sidecars that teardown just killed. This module's copy is unchanged.
    if (!workspaceAdmitsWork(ctx.workspace)) throw new Error(tMain('main.models.locked'))
  }

  ipcHandle(IPC.listModels, async (event, lazyVerify?: boolean): Promise<ModelInfo[]> => {
    requireUnlocked()
    if (!ctx.manifestsDir) {
      log.warn('No model-manifests directory found; returning empty model list')
      return []
    }
    const s = getSettings(ctx.db)
    const { models, manifestErrors } = await buildModelList({
      manifestsDir: ctx.manifestsDir,
      rootPath: ctx.paths.rootPath,
      profile: s.lastBenchmark?.profile ?? 'UNKNOWN',
      developerMode: developerLeniency(ctx, s),
      runningModelId: ctx.runtime.activeModelId(),
      hashStore: createSettingsHashStore(() => ctx.db, ctx.paths.rootPath),
      machineRamGb: machineRamGb(),
      // §6.6: the ★ pick goes by graphics memory on a discrete card, the SAME rule
      // runBenchmark applies, so the Performance screen and the Models screen agree.
      ...pickerMemoryFor(s),
      // §6.5 signal-aware step-down (issue #95): feed the persisted Diagnostics pairing
      // (tok/s + the model that produced it, issue #52) into the chat recommendation.
      // Derived fresh from lastBenchmark on every call — stateless, never compounds; the same
      // function feeds the Performance snapshot's live recommendation (`liveChatRecommendation`).
      speedSignal: speedSignalFor(s),
      // RT-3: the chat path (the workspace gate into Chat) passes lazyVerify so only the
      // active model is hashed on a cold cache — the full corpus of multi-GB GGUFs is
      // hashed only on an explicit Models-screen visit. Display-only; the start gate
      // (startModelRuntime) re-verifies the model it actually launches.
      ...(lazyVerify ? { onlyVerifyModelId: s.activeModelId } : {}),
      // First-run weight hashing can take a while on a fresh drive — stream progress back
      // to the calling renderer so the gate + Models screen show a determinate bar. Guard
      // against a closed/destroyed window (navigation away mid-hash).
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send(EVENTS.modelVerifyProgress, p)
      }
    })
    if (manifestErrors.length > 0) {
      log.warn('Invalid model manifests skipped', manifestErrors)
    }
    // #108: a cold-cache visit just hashed real multi-GB files — persist any fresh sample.
    persistEffectiveRead(ctx)
    return models
  })

  ipcHandle(IPC.selectModel, (_e, modelId: string) => {
    requireUnlocked()
    if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
    log.info('Select model', { modelId })
    const result = selectModel(ctx.db, ctx.manifestsDir, modelId)
    ctx.audit?.('model_selected', `Model selected: ${modelId}`, { modelId })
    // The Performance snapshot keys its "Your model" block on the active slots.
    notifyPerformanceChanged()
    return result
  })

  // Forced re-verify (the "Verify checksum" button): drop the cached hash for this
  // model's weight file and re-hash it for real. `listModels` alone would read the
  // cache back and confirm nothing.
  ipcHandle(IPC.verifyModel, async (_e, modelId: string): Promise<ModelState> => {
    requireUnlocked()
    if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
    const { manifests } = discoverManifests(ctx.manifestsDir)
    const found = manifests.find((m) => m.manifest.id === modelId)
    if (!found) throw new Error(`Unknown model id: ${modelId}`)
    const store = createSettingsHashStore(() => ctx.db, ctx.paths.rootPath)
    // Invalidate EVERY file the manifest carries (#106 adjacent fix): this used to drop
    // only the GGUF's cache entry, so "Verify checksum" on a vision model re-hashed the
    // weight but silently served the mmproj projector from cache.
    for (const f of manifestFiles(ctx.paths.rootPath, found.manifest)) {
      invalidateChecksum(f.path, store)
    }
    const state = await computeInstallState(found.manifest, ctx.paths.rootPath, {
      developerMode: developerLeniency(ctx, getSettings(ctx.db)),
      hashStore: store
    })
    log.info('Model re-verified', { modelId, state })
    ctx.audit?.('model_verified', `Model checksum re-verified: ${modelId}`, { modelId, state })
    // #108: the forced re-hash is a real full-file read — persist any fresh sample.
    persistEffectiveRead(ctx)
    return state
  })

  ipcHandle(IPC.startRuntime, (_e, modelId: string): Promise<RuntimeStatus> => {
    requireUnlocked()
    // Starting/switching the runtime tears down the current llama-server. A yielding
    // deep-index build holds that slot and is pinned to the current model (M12) — abort it
    // first so it doesn't keep calling a stopped/replaced runtime, and a parked build (waiting
    // on a chat handoff) doesn't hang. No-op when no build is running; the build is left
    // resumable (it rebuilds from the warm cache under the new model).
    ctx.docTasks?.abortActiveBuild()
    return startModelRuntime(ctx, modelId)
  })

  // The Models screen's one primary action per installed chat card (beta #27, D70): select the
  // model (persist the active chat slot + emit `model_selected`) AND start its runtime, both here
  // so the §7.4 install gate + RAM gate run once and the audit trail is a single event chain. A
  // first-time user had a "Select" AND a "Start runtime" button and couldn't tell which led to
  // chatting; collapsing them removes the ambiguity. Selected models already auto-start at launch,
  // and chat-send never auto-starts (registerChatIpc contract), so the merged action MUST start the
  // runtime — a select alone would still leave the runtime down mid-session.
  ipcHandle(IPC.useModel, async (_e, modelId: string): Promise<RuntimeStatus> => {
    requireUnlocked()
    if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
    // Reject a non-chat role BEFORE any persist (mirrors startModelRuntime's guard): an automatic
    // role (embeddings/reranker/transcriber/vision/translation) has no chat slot to claim, and
    // selecting an embeddings model here would silently touch its separate slot. The UI never
    // reaches this for those roles, but the handler stays honest for non-UI callers.
    const { manifests } = discoverManifests(ctx.manifestsDir)
    const found = manifests.find((m) => m.manifest.id === modelId)
    if (!found) throw new Error(`Unknown model id: ${modelId}`)
    if (found.manifest.role !== 'chat') {
      throw new Error(`Model "${modelId}" is a ${found.manifest.role} model, not a chat model.`)
    }
    // Select first so a refresh mid-load reflects the choice on the Active badge; selectModel
    // persists the active slot + emits its own `model_selected` audit event.
    log.info('Use model (select + start)', { modelId })
    selectModel(ctx.db, ctx.manifestsDir, modelId)
    ctx.audit?.('model_selected', `Model selected: ${modelId}`, { modelId })
    notifyPerformanceChanged()

    // Mirror startRuntime: free the runtime slot from any yielding deep-index build before the
    // start tears down / replaces llama-server.
    ctx.docTasks?.abortActiveBuild()
    // No rollback on a start failure: selecting persisted (matching the old Select button, which
    // always persisted regardless of a later Start), and the freshly-selected model auto-starts at
    // the next launch + can be retried — so a transient start failure keeps the user's choice
    // rather than silently reverting it. The install/RAM gates inside startModelRuntime still throw
    // and DON'T start (the UI already disables the button for those, so this is the non-UI guard).
    return startModelRuntime(ctx, modelId)
  })

  ipcHandle(IPC.stopRuntime, async (): Promise<void> => {
    log.info('Stop runtime')
    const modelId = ctx.runtime.activeModelId()
    ctx.docTasks?.abortActiveBuild()
    await ctx.runtime.stop()
    if (modelId) {
      ctx.audit?.('runtime_stopped', `Model runtime stopped: ${modelId}`, { modelId })
    }
  })

  // Read-only runtime state for the Diagnostics screen (spec §7.11),
  // enriched with the active model's `supports_thinking_mode` manifest flag
  // so the Chat composer knows whether to offer the Deep answer mode. Manifest reads
  // happen only while a runtime is actually running (the ChatScreen's not-running
  // poll stays I/O-free), and a read failure just leaves the flag absent.
  ipcHandle(IPC.getRuntimeStatus, (): RuntimeStatus => {
    const status = ctx.runtime.status()
    if (status.running && status.modelId && ctx.manifestsDir) {
      try {
        const { manifests } = discoverManifests(ctx.manifestsDir)
        const found = manifests.find((m) => m.manifest.id === status.modelId)
        if (found) status.supportsThinkingMode = found.manifest.supportsThinkingMode
      } catch {
        /* Diagnostics/Chat still get the plain status */
      }
    }
    // #36: whether CPU is the crash-fallback latch ("compatibility mode") — the Chat header
    // hint says so instead of a bare "CPU". Best-effort like the manifest read above.
    if (status.running) {
      try {
        status.gpuAutoDisabled = getSettings(ctx.db).gpuAutoDisabled
      } catch {
        /* settings unreadable (e.g. just locked) — the plain status still serves */
      }
    }
    // #107: enrich the "Starting…" window with an expected load duration from the
    // honest effective-read sample (#108). `bytesTotal` already rides the status (the
    // manager resolves it once per window); the sample is memoized per window too, so a
    // poll tick costs no settings read and no I/O — the pre-review shape re-scanned the
    // manifests dir + statted the weight on every 2.5 s tick, against the same drive
    // the load was saturating. Best-effort: no sample (fresh install) → expectedMs stays
    // absent → the indeterminate line.
    if (status.startingModelId && status.starting) {
      if (startingSampleMemo?.forModelId !== status.startingModelId) {
        startingSampleMemo = {
          forModelId: status.startingModelId,
          sample: effectiveReadOrPersisted(ctx)
        }
      }
      const sample = startingSampleMemo.sample
      const bytesTotal = status.starting.bytesTotal
      if (sample && sample.mbps > 0 && bytesTotal != null) {
        status.starting.expectedMs = Math.round((bytesTotal / 1e6 / sample.mbps) * 1000)
      }
    } else {
      startingSampleMemo = null
    }
    return status
  })

  // Which sidecar build the drive carries (the .hilbertraum-runtime.json install marker) —
  // the Diagnostics "runtime build" line. Null on unmarked/DIY drives.
  ipcHandle(
    IPC.getRuntimeInstall,
    (): RuntimeInstallInfo | null => readRuntimeMarker(llamaServerDir(ctx.paths.rootPath))
  )
}
