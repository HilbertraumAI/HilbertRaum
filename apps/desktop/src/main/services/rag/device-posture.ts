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
 * `manifestsDir`, so the two can never disagree about the posture — closing the gap the scoped
 * Opus review of step 4-5 found (finding C1): `resolveAskCandidateScope`'s own doc comment
 * already promised "the SAME hardware-profile rule the reranker sidecar's device posture uses"
 * and nothing enforced it; each call site independently re-derived the answer.
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
