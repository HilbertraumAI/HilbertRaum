import type { AppSettings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { primaryUsefulDevice } from '../../../shared/gpu-rules'
import { eligibleDevicesFor, machineKey } from '../performance'
import { detectSystem } from '../benchmark'
import { estimateGraphicsNeedMib, findManifestById, graphicsBudgetMib } from '../models'
import { defaultThreadCount } from '../runtime/sidecar'
import { totalCandidateCapFor } from '../zim/arm'
import type { RuntimeManager } from '../runtime'
import type { Translator } from '../translation'
import {
  rerankerDeviceFor,
  resolveRerankProfile,
  rerankScopeFor,
  type RerankerDevice,
  type RerankProfileInput
} from './rerank-profile'

/**
 * Wave 6 ruling (c) — the ONE shared posture helper (`programme-state/steps/G1-bundle-selection/
 * rulings-wave6.md`). `main/index.ts`'s `rerankerDevicePosture` (the sidecar's own lazy-start
 * posture) and `registerRagIpc.ts`'s `resolveAskCandidateScope` (the per-ask candidate-scope
 * coupling, Wave 6 ruling (a)) both call THIS, with the SAME settings snapshot and the SAME
 * occupancy inputs, so the two cannot disagree — closing the gap the scoped Opus review of step
 * 4-5 found (finding C1): `resolveAskCandidateScope`'s own doc comment already promised "the SAME
 * hardware-profile rule the reranker sidecar's device posture uses" and nothing enforced it; each
 * call site independently re-derived the answer.
 *
 * Step 4-7 (Wave 7 ruling (a)) found a second gap (finding C2, scoped Opus review of step 4-6):
 * this helper alone guarantees the SAME function on the SAME inputs, not the SAME moment — the
 * sidecar held its posture for the whole session and only a `gpuMode`/`gpuAutoDisabled` flip
 * suspended it, so an `activeModelId` change (feeding this helper through `chatModelNeedMib`)
 * could move the posture without suspending anything. Step 4-7 added an event-time suspend on
 * every settings-writing channel that touches `activeModelId` — early release, not a guarantee.
 *
 * **Wave 8 ruling (a) (step 4-8) resolved a THIRD gap, finding C3 (scoped Opus review of step
 * 4-7):** `settings.activeModelId` is a PROXY for "the chat model that will be loaded" — a proxy
 * this helper trusted at the one moment it is guaranteed false, the whole `models:use` hash +
 * load window, during which the OLD model is still resident while the setting already names the
 * NEW one. This helper's chat-model input is now the RUNTIME's COMMITTED model
 * (`RuntimeManager.activeModelId()`, `occupancy.committedModelId` below) — never the setting, and
 * never a fallback to it. A null committed model, or ANY absent occupancy input, means `cpu`:
 * headroom is not provable while a chat-model start is in flight or pending
 * (`occupancy.chatStartBusy`) or while a GPU-posture translation sidecar occupies the card
 * (`occupancy.translationOccupied`, ruling (b)(T) — `Translator.gpuOccupied()`,
 * `translation/index.ts`). The use-time re-check that makes this correct at every MOMENT, not
 * only at cold-start, is Q (`reranker/llama.ts`'s `resolveServer`) — this helper is consulted
 * fresh on every `rerank()` call, not once per sidecar lifetime. Wave 7's three event-time
 * suspends (`gpuMode`/`gpuAutoDisabled`/`activeModelId` via `settings:update`/`models:select`/
 * `models:use`) stay as early release — a head start before the next `rerank()` would have
 * resolved the new posture on its own — not what makes the posture correct; Q is.
 *
 * Impure (reads `settings.gpuProbe`, resolves a manifest off disk, reads the runtime manager and
 * the live translator) — lives here, outside `rag/rerank-profile.ts`, which must stay free of
 * `node:`/`electron` imports for the renderer boundary (see that module's `CPU_HI_MIN_THREADS`
 * doc comment). Both callers are already main-process/Electron modules.
 *
 * `settings: null` (a locked workspace) and a `null`/unresolvable `manifestsDir` both mean
 * `'cpu'` — the existing "not provable ⇒ CPU" semantics, unchanged.
 */
export function resolveRerankerDevicePosture(
  settings: AppSettings | null,
  manifestsDir: string | null,
  occupancy: RerankerOccupancySnapshot
): RerankerDevice {
  const here = machineKey(detectSystem())
  const gpuAllowed = settings != null && settings.gpuMode === 'auto' && !settings.gpuAutoDisabled
  const probeDevices = gpuAllowed ? eligibleDevicesFor(settings, here) : null
  const budgetDevice = Array.isArray(probeDevices) ? primaryUsefulDevice(probeDevices) : null
  const budgetMib = graphicsBudgetMib(budgetDevice)
  // Wave 8 ruling (a): a chat start in flight/pending, or a GPU-posture translation occupant,
  // makes headroom not provable regardless of what the committed model's own placement would
  // say — checked BEFORE resolving the manifest, so neither occupancy input needs a manifest
  // lookup to short-circuit to `cpu`. #495 follow-up: a reranker already demoted this session
  // (the sidecar's own `gpuFellBack` latch) forces `cpu` here too, so the ask-site candidate
  // scope (`registerRagIpc.ts`'s `resolveAskCandidateScope`, the one caller that can see this
  // field) agrees with the sidecar instead of asking for a GPU-sized scope G would refuse.
  if (occupancy.chatStartBusy || occupancy.translationOccupied || occupancy.rerankerDemoted) return 'cpu'
  const activeManifest = findManifestById(manifestsDir, occupancy.committedModelId)
  const chatModelNeedMib = activeManifest ? estimateGraphicsNeedMib(activeManifest) : null
  return rerankerDeviceFor({ probeDevices, budgetMib, chatModelNeedMib })
}

/**
 * Wave 8 ruling (a) — the occupancy inputs `resolveRerankerDevicePosture` reads instead of
 * `settings.activeModelId`. Every field is REQUIRED: an omitted field is a compile error, not a
 * silent "no occupancy" default — the analysis's own finding (F16) is that an optional wire is
 * how a posture input silently goes missing.
 */
export interface RerankerOccupancySnapshot {
  /**
   * `RuntimeManager.activeModelId()` — the chat model actually committed right now, or null (no
   * runtime, a stop, a failed load, or the kill half of a switch still in progress). NEVER
   * `settings.activeModelId`, and never a fallback to it.
   */
  committedModelId: string | null
  /**
   * True while a chat-model start is in flight (`RuntimeManager.status().startingModelId`) or
   * PENDING in `startModelRuntime` (the per-call counter Wave 8 ruling (a) adds, covering the
   * window `startModelRuntime` spends awaiting the reranker's own single-flight suspend after
   * committing to a real model switch — see `registerModelIpc.ts`).
   */
  chatStartBusy: boolean
  /**
   * True while a GPU-posture translation sidecar is loading, resident, or still being torn down
   * (Wave 8 ruling (b)(T) — `Translator.gpuOccupied()`, `translation/index.ts`).
   */
  translationOccupied: boolean
  /**
   * #495 follow-up: true once the reranker's own session
   * GPU-fallback latch is armed (`Reranker.gpuDemoted()` — a pure field read, never
   * `devicePosture()`, which would recurse for the sidecar's own posture callback below).
   * OPTIONAL, unlike the other two fields: `snapshotRerankerOccupancy`'s existing 3-argument
   * call sites (predating this field, several inside frozen test fixtures) must keep resolving
   * an omitted field to "not known to be demoted" rather than a compile error. The one
   * production reader that can actually see the latch is `registerRagIpc.ts`'s ask site, which
   * sets it explicitly from `ctx.reranker?.gpuDemoted?.()`.
   */
  rerankerDemoted?: boolean
}

/**
 * Wave 8 ruling (a) — a per-call counter of `startModelRuntime` calls presently awaiting the
 * reranker's single-flight suspend after committing to a REAL model switch. A COUNTER, never a
 * boolean: the unlock auto-start and a Use click can overlap (`registerModelIpc.ts`'s
 * `maybeAutoStartActiveModel` and `useModel`/`startRuntime` IPC handlers can both be mid-flight
 * at once), so a boolean cleared by the first call to settle would silently stop covering the
 * second. `decrement()` is called from a `finally` whose `try` begins immediately after
 * `increment()` — never a function-wide `finally`, which would also decrement for a start
 * refused BEFORE the increment (the unknown-id/role guard, the install gate, the RAM gate) and
 * drive the count negative.
 */
export interface PendingModelSwitchCounter {
  readonly count: number
  increment(): void
  decrement(): void
}

/** A fresh, zeroed `PendingModelSwitchCounter` — one instance per app session, held on
 *  `AppContext` and shared between `registerModelIpc.ts` and the posture-callback factory below. */
export function createPendingModelSwitchCounter(): PendingModelSwitchCounter {
  let count = 0
  return {
    get count() {
      return count
    },
    increment() {
      count++
    },
    decrement() {
      count--
    }
  }
}

/**
 * Wave 8 ruling (b)(G) — the CPU posture's per-call request ceiling:
 * `2 × ragTopKInitial + totalCandidateCapFor(rerankScopeFor(profile, input, 'cpu'))`, computed
 * from settings with the EXISTING pure functions (`resolveRerankProfile`, `rerankScopeFor`,
 * `totalCandidateCapFor`) — never a literal 48/72. The profile classification still matters on
 * the `cpu` posture: a `gpu`-profile machine whose headroom gate landed on `cpu` gets the
 * `capped` cap (48), while a `cpu-hi` machine with the wide-scope opt-in gets `top48`'s cap (72).
 * A null `settings` snapshot (a momentarily locked workspace, mirroring the posture resolver's
 * own defensive degrade) falls back to `DEFAULT_SETTINGS`'s values.
 */
export function cpuRequestCeilingFor(settings: AppSettings | null): number {
  const s = settings ?? DEFAULT_SETTINGS
  const here = machineKey(detectSystem())
  const input: RerankProfileInput = {
    gpuMode: s.gpuMode,
    gpuAutoDisabled: s.gpuAutoDisabled,
    probeDevices: eligibleDevicesFor(s, here),
    threads: defaultThreadCount(),
    rerankerAvailable: true,
    wideScopeOptIn: s.ragRerankWideScope
  }
  const profile = resolveRerankProfile(input)
  const scope = rerankScopeFor(profile, input, 'cpu')
  return 2 * s.ragTopKInitial + totalCandidateCapFor(scope)
}

/**
 * Wave 8 ruling (a)/(b)/NF-1 — the exported closure FACTORY the posture and G callbacks are
 * built from. Every dependency is REQUIRED (no optional field): a composition test targets this
 * factory with `// @ts-expect-error` cases proving so, because a composition test that only
 * reaches `compose-services.ts` → `reranker/factory.ts` cannot see an omission at `main/index.ts`
 * or at the ask site (`registerRagIpc.ts:262`) — the analysis's finding NF-1. `main/index.ts`
 * calls this ONCE and threads both returned callbacks into `composeServices`.
 */
export interface RerankerCallbackDeps {
  /** The chat runtime manager — only the two read-only methods the posture needs. */
  runtimeManager: Pick<RuntimeManager, 'activeModelId' | 'status'>
  /** Wave 8 ruling (a)'s pending-switch counter — shared with `registerModelIpc.ts`. */
  pendingModelSwitches: PendingModelSwitchCounter
  /**
   * Read live, never captured: `ctx.translator` is REASSIGNED by `onModelInstalled` when a
   * mid-session download makes translation available (`main/index.ts`), so a closure that
   * captured the startup value would consult a permanently-null or stale instance.
   */
  getTranslator: () => Translator | null
  /** Settings getter — the locked-workspace fallback (→ null) stays at the call site. */
  getSettings: () => AppSettings | null
  manifestsDir: string | null
}

/**
 * Build the reranker's device-posture and CPU-request-ceiling callbacks from ONE set of
 * dependencies (Wave 8 rulings (a), (b)(G), (b)(T)). Threaded into `composeServices` as its two
 * now-required reranker options.
 */
export function createRerankerCallbacks(deps: RerankerCallbackDeps): {
  devicePosture: () => RerankerDevice
  requestCeiling: () => number
} {
  const occupancy = (): RerankerOccupancySnapshot =>
    snapshotRerankerOccupancy(deps.runtimeManager, deps.pendingModelSwitches, deps.getTranslator)
  return {
    devicePosture: () => resolveRerankerDevicePosture(deps.getSettings(), deps.manifestsDir, occupancy()),
    requestCeiling: () => cpuRequestCeilingFor(deps.getSettings())
  }
}

/**
 * Wave 8 ruling (a)/(b)(T) — build one `RerankerOccupancySnapshot` from the runtime manager, the
 * pending-switch counter and a live translator getter. Exported so `createRerankerCallbacks`
 * (the sidecar's own posture seam) and `registerRagIpc.ts`'s ask-site call to
 * `resolveAskCandidateScope` (`:262`-area) build the occupancy snapshot the SAME way — never two
 * independent re-derivations that could drift.
 *
 * `status` is read defensively (`?.()`): the real `RuntimeManager` always has it, but many
 * pre-existing test fixtures across the suite build a minimal fake runtime (just
 * `activeModelId`/`active`/`start`) that predates this occupancy read — those fixtures test
 * behaviour this step does not touch, and requiring every one of them to grow a `status()` stub
 * would be churn with no behavioural point. A fake without it reads as "no chat start in
 * flight", the same as today's behaviour for those tests.
 */
export function snapshotRerankerOccupancy(
  runtimeManager: Pick<RuntimeManager, 'activeModelId'> & Partial<Pick<RuntimeManager, 'status'>>,
  pendingModelSwitches: PendingModelSwitchCounter,
  getTranslator: () => Translator | null
): RerankerOccupancySnapshot {
  const startingModelId = runtimeManager.status?.().startingModelId ?? null
  return {
    committedModelId: runtimeManager.activeModelId(),
    chatStartBusy: startingModelId != null || pendingModelSwitches.count > 0,
    translationOccupied: getTranslator()?.gpuOccupied?.() ?? false
  }
}

/**
 * Wave 7 ruling (a) (step 4-7, resolving the scoped Opus review of step 4-6's finding C2) — the
 * settings keys the EVENT-TIME suspend trigger below watches: the `gpuMode`/`gpuAutoDisabled`
 * gate and `activeModelId`. Since Wave 8 ruling (a), `activeModelId` here is early release only
 * — a head start before the very next `rerank()` would have resolved the new posture on its own
 * via Q (`reranker/llama.ts`) — not what makes the posture correct. This is NOT the complete
 * list of everything the posture resolver reads: it also reads `settings.gpuProbe` (a known,
 * pre-existing, out-of-scope residual — `channels.json` id 4) and, since Wave 8, the runtime
 * manager's committed model and in-flight/pending state and the translator's occupancy — none of
 * which are settings keys a `settings:update` patch could carry, so they have no place in this
 * list. `activeEmbeddingModelId` is deliberately absent — it is not a posture input (the
 * embedder is a separate slot the reranker's placement estimate never contends with) and must
 * never trigger a suspend.
 */
export const RERANKER_POSTURE_SETTINGS_KEYS: ReadonlyArray<keyof AppSettings> = [
  'gpuMode',
  'gpuAutoDisabled',
  'activeModelId'
]

/** The posture's settings inputs, snapshotted before or after a write (Wave 7 ruling (c)). */
export interface RerankerPostureSnapshot {
  gpuMode: AppSettings['gpuMode']
  gpuAutoDisabled: boolean
  activeModelId: string | null
}

/**
 * Wave 7 ruling (c) — the ONE shared predicate answering "does this settings change invalidate
 * the resident reranker sidecar's EARLY-RELEASE posture?" (Wave 8: Q, not this event-time check,
 * is what makes the posture correct at every moment — see `resolveRerankerDevicePosture`'s own
 * doc comment), called from `registerCoreIpc.ts`'s `settings:update` handler and from both of
 * `registerModelIpc.ts`'s `selectModel` call sites (`models:select`, `models:use`) — never three
 * independent copies of the same comparison.
 *
 * REAL-flip only: a caller must snapshot `before` off `getSettings` BEFORE the write and pass the
 * POST-write result as `after` — this function compares actual values, never patch key presence,
 * so a patch that merely repeats today's value (or touches an unrelated key) never suspends.
 */
export function rerankerPostureInputsChanged(
  before: RerankerPostureSnapshot,
  after: RerankerPostureSnapshot
): boolean {
  return (
    before.gpuMode !== after.gpuMode ||
    before.gpuAutoDisabled !== after.gpuAutoDisabled ||
    before.activeModelId !== after.activeModelId
  )
}
