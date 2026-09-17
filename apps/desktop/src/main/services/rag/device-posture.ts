import type { AppSettings } from '../../../shared/types'
import { primaryUsefulDevice } from '../../../shared/gpu-rules'
import { eligibleDevicesFor, machineKey } from '../performance'
import { detectSystem } from '../benchmark'
import { estimateGraphicsNeedMib, findManifestById, graphicsBudgetMib } from '../models'
import { rerankerDeviceFor, type RerankerDevice } from './rerank-profile'

/**
 * Wave 6 ruling (c) — the ONE shared posture helper (`programme-state/steps/G1-bundle-selection/
 * rulings-wave6.md`). `main/index.ts`'s `rerankerDevicePosture` (the sidecar's own lazy-start
 * posture) and `registerRagIpc.ts`'s `resolveAskCandidateScope` (the per-ask candidate-scope
 * coupling, Wave 6 ruling (a)) both call THIS, with the SAME settings snapshot and the SAME
 * `manifestsDir`, so the two cannot disagree about the posture FOR A GIVEN SETTINGS SNAPSHOT —
 * closing the gap the scoped Opus review of step 4-5 found (finding C1): `resolveAskCandidateScope`'s
 * own doc comment already promised "the SAME hardware-profile rule the reranker sidecar's device
 * posture uses" and nothing enforced it; each call site independently re-derived the answer.
 *
 * The scoped Opus review of step 4-6 found a second gap (finding C2): this helper alone
 * guarantees the SAME function on the SAME inputs, not the SAME moment — the sidecar held its
 * posture for the whole session and only a `gpuMode`/`gpuAutoDisabled` flip suspended it, so an
 * `activeModelId` change (which also feeds this helper, through `chatModelNeedMib`) could move
 * the posture without suspending anything. Resolved by step 4-7 (Wave 7 ruling (a)):
 * `rerankerPostureInputsChanged` below suspends the sidecar on a REAL change to `gpuMode`,
 * `gpuAutoDisabled` or `activeModelId`, when the change arrives through the three
 * settings-writing channels that carry `activeModelId` (`settings:update`, `models:select`,
 * `models:use`), so the NEXT `rerank()` re-resolves instead of holding a stale posture.
 * `gpuAutoDisabled` also moves through two further seams this fix does NOT cover (`tryGpuAgain`,
 * `main/index.ts`'s `persistGpuFailure`) — reported, not fixed, for a separate owner ruling; see
 * `channels.json`. The one residual window in the covered case is the fire-and-forget teardown
 * itself: an ask landing mid-suspend hits the sidecar's `tearingDown` guard, its `rerank()` call
 * fails, and Wave 5 ruling (e)(i)'s `cappedCandidates` fallback returns the capped selection —
 * the window resolves toward the safe, bounded scope, never the wide one.
 *
 * Impure (reads `settings.gpuProbe`/`activeModelId`, resolves a manifest off disk) — lives here,
 * outside `rag/rerank-profile.ts`, which must stay free of `node:`/`electron` imports for the
 * renderer boundary (see that module's `CPU_HI_MIN_THREADS` doc comment). Both callers are
 * already main-process/Electron modules, so this file importing `../performance`/`../models`
 * (which reach into `node:fs` et al.) is no new boundary violation — it is the SAME impure seam
 * `main/index.ts`'s `rerankerDevicePosture` already was, extracted so a second caller can share
 * it instead of re-deriving it.
 *
 * Replicates step 4-5's `main/index.ts` seam EXACTLY (ruling (d)'s headroom gate itself is
 * otherwise unchanged by this step): the same `gpuMode === 'auto' && !gpuAutoDisabled` gate, the
 * same `eligibleDevicesFor` → `primaryUsefulDevice` → `graphicsBudgetMib` chain, the same
 * `findManifestById` → `estimateGraphicsNeedMib` chat-model placement, delegating the decision to
 * the unchanged PURE `rerankerDeviceFor`. `settings: null` (a locked workspace — the caller's own
 * DB-fetch try/catch) and a `null`/unresolvable `manifestsDir` (`AppContext.manifestsDir`, or an
 * unresolvable active model id) both mean `'cpu'` — the existing "not provable ⇒ CPU" semantics,
 * unchanged.
 */
export function resolveRerankerDevicePosture(
  settings: AppSettings | null,
  manifestsDir: string | null
): RerankerDevice {
  const here = machineKey(detectSystem())
  const gpuAllowed = settings != null && settings.gpuMode === 'auto' && !settings.gpuAutoDisabled
  const probeDevices = gpuAllowed ? eligibleDevicesFor(settings, here) : null
  const budgetDevice = Array.isArray(probeDevices) ? primaryUsefulDevice(probeDevices) : null
  const budgetMib = graphicsBudgetMib(budgetDevice)
  const activeManifest = findManifestById(manifestsDir, settings?.activeModelId ?? null)
  const chatModelNeedMib = activeManifest ? estimateGraphicsNeedMib(activeManifest) : null
  return rerankerDeviceFor({ probeDevices, budgetMib, chatModelNeedMib })
}

/**
 * Wave 7 ruling (a) (step 4-7, resolving the scoped Opus review of step 4-6's finding C2) — the
 * settings keys the suspend trigger below WATCHES, per ruling (a)'s own two-input formulation:
 * the `gpuMode`/`gpuAutoDisabled` gate and `activeModelId` (through `chatModelNeedMib`). This is
 * NOT the complete list of everything `resolveRerankerDevicePosture` above reads — that function
 * also reads `settings.gpuProbe` (via `eligibleDevicesFor` → `primaryUsefulDevice` →
 * `graphicsBudgetMib`, feeding `budgetMib`), a real posture input this list deliberately omits:
 * ruling (a) scopes option (A) to `gpuMode`/`gpuAutoDisabled`/`activeModelId` only, and `gpuProbe`
 * is a known, pre-existing, out-of-scope residual (see `channels.json` id 4 — a re-probe recording
 * a different `freeMb` can move the resolved posture without suspending anything, undisturbed by
 * this step). Exported so every settings-writing seam this step covers can decide, from ONE list,
 * whether reading a "before" snapshot is worth it (the REAL-flip discipline needs it only when a
 * write might touch one of these three). `activeEmbeddingModelId` is deliberately absent — it is
 * not a posture input (the embedder is a separate slot the reranker's placement estimate never
 * contends with) and must never trigger a suspend.
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
 * the resident reranker sidecar's posture?", called from `registerCoreIpc.ts`'s `settings:update`
 * handler and from both of `registerModelIpc.ts`'s `selectModel` call sites (`models:select`,
 * `models:use`) — never three independent copies of the same comparison, which is how finding C2
 * (the scoped Opus review of step 4-6) reached the owner: the sidecar and the per-ask scope
 * already shared `resolveRerankerDevicePosture` above so they could never disagree given the SAME
 * settings snapshot, but nothing suspended the resident sidecar when `activeModelId` (never just
 * `gpuMode`/`gpuAutoDisabled`) moved the posture to a DIFFERENT snapshot mid-session.
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
