import { describe, it, expect, vi } from 'vitest'

// registerRagIpc.ts type-imports `IpcMainInvokeEvent` only (erased at compile time), but several
// of its OTHER imports are exercised at module-evaluation time by other test files that already
// import it (`rag-classify-offer.test.ts` and siblings) with this same minimal stub — matched
// here rather than re-derived.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (): void => {},
    removeHandler: (): void => {}
  }
}))

import { join } from 'node:path'
import { resolveAskCandidateScope } from '../../src/main/ipc/registerRagIpc'
import { resolveRerankerDevicePosture, type RerankerOccupancySnapshot } from '../../src/main/services/rag/device-posture'
import { GPU_RERANK_SCOPE } from '../../src/main/services/rag/rerank-profile'
import { DEFAULT_SETTINGS, type AppSettings, type GpuDevice } from '../../src/shared/types'

// B12 (scoped Opus review, step 4-4): `resolveAskCandidateScope` and its one production call
// site (this ask's `externalArm` wiring) had no test in the diff — a dropped `candidateScope`
// property or an inverted `ctx.reranker != null` would have stayed green everywhere else. This
// file exercises the function directly (its own logic, not the renderer/IPC plumbing around it),
// closing that specific gap: `rerankerAvailable` genuinely controls the outcome, in the direction
// that matters (never a wide, uncross-encoded pool with no reranker).

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

// Wave 8 ruling (a) (step 4-8): `occupancy` is now a REQUIRED 4th parameter — this fixture is
// "nothing pending, nothing occupying the card", the neutral case every test below that does not
// itself exercise B′/T passes explicitly (an omitted/optional parameter would silently readmit
// the pre-Wave-8 "trust the setting" behaviour — NF-1, the Wave 8 analysis).
function noOccupancy(committedModelId: string | null = null): RerankerOccupancySnapshot {
  return { committedModelId, chatStartBusy: false, translationOccupied: false }
}

const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')
const COMMITTED_4B = 'qwen3.5-4b-ud-q4kxl'
/** The measurement machine's card (RTX 3080 Ti): provable headroom beside the 4B, so the wide scope resolves. */
function bigCard(overrides: Partial<AppSettings> = {}): AppSettings {
  return settings({
    gpuMode: 'auto',
    gpuAutoDisabled: false,
    gpuProbe: {
      devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }],
      probedAt: new Date().toISOString()
    },
    ...overrides
  })
}

describe('resolveAskCandidateScope (registerRagIpc.ts)', () => {
  it('rerankerAvailable: false -> "capped" even where the same settings resolve the wide scope with a reranker (the B7/B12 danger: a dropped or inverted rerankerAvailable must never widen the pool with no cross-encoder)', () => {
    const occupancy = noOccupancy(COMMITTED_4B)
    // Positive control: with a reranker the measurement machine resolves the wide scope.
    expect(resolveAskCandidateScope(bigCard(), true, MANIFESTS_DIR, occupancy)).toBe(GPU_RERANK_SCOPE)
    for (const s of [bigCard(), bigCard({ ragRerankWideScope: true })]) {
      expect(resolveAskCandidateScope(s, false, MANIFESTS_DIR, occupancy)).toBe('capped')
    }
  })

  // Wave 8 ruling (a) + #495 follow-up: a chat start in flight/pending, a translation occupant, or a reranker the
  // session already demoted to the processor (`rerankerDemoted`, `LlamaReranker.gpuDemoted()`) each force the scope
  // down to "capped" on the fixture that otherwise resolves the wide scope.
  it('a chat start in flight/pending, a translation occupant, or a demoted reranker (#495) forces the scope down to "capped" even on the measurement machine\'s own GPU fixture', () => {
    const neutral = noOccupancy(COMMITTED_4B)
    expect(resolveAskCandidateScope(bigCard(), true, MANIFESTS_DIR, neutral)).toBe(GPU_RERANK_SCOPE) // sanity
    const overrides: Array<[string, Partial<RerankerOccupancySnapshot>]> = [
      ['chatStartBusy', { chatStartBusy: true }],
      ['translationOccupied', { translationOccupied: true }],
      ['rerankerDemoted', { rerankerDemoted: true }]
    ]
    for (const [label, o] of overrides) {
      expect(resolveAskCandidateScope(bigCard(), true, MANIFESTS_DIR, { ...neutral, ...o }), label).toBe('capped')
    }
  })
})

// Wave 6 ruling (c) (scoped Opus review of step 4-5, finding C1): ONE shared posture helper must
// feed BOTH `main/index.ts`'s `rerankerDevicePosture` seam and this function, so the two cannot
// disagree for a given settings AND occupancy snapshot (step 4-7, Wave 7 ruling (a), closed the
// remaining drift window across settings snapshots; Wave 8 ruling (a), step 4-8, re-sourced the
// chat-model input onto the RUNTIME's committed model and added the occupancy inputs -- see
// `rag/device-posture.ts`'s own doc comment for the full history). `main/index.ts`'s seam is,
// after Wave 8, `createRerankerCallbacks`'s `devicePosture` closure, built over
// `resolveRerankerDevicePosture(settings, manifestsDir, occupancy)` (see that factory's own
// comment) — so calling the shared helper directly here stands in for that seam, and driving
// `resolveAskCandidateScope` from the EXACT SAME (settings, manifestsDir, occupancy) fixture
// proves the two call sites agree, not just that each one is independently plausible. Real model
// manifests, the same ones `rerank-profile.test.ts`'s headroom-gate fixtures use — never a
// hand-duplicated MiB figure — so a manifest edit that silently moves the threshold is caught
// here too.
describe('resolveAskCandidateScope and the shared posture helper resolve the same posture (Wave 6 ruling (c), Wave 8 ruling (a))', () => {
  it('the two call sites resolve the SAME posture from the SAME settings AND occupancy snapshot -- a future divergence fails here', () => {
    // Fixture (i): the measurement machine's own device (RTX 3080 Ti, provable headroom) ->
    // posture 'gpu' (see rerank-profile.test.ts's identical fixture (i)). `committedModelId`
    // stands in for the OLD `activeModelId` fixture value -- since Wave 8 ruling (a) the setting
    // itself is never read for this decision.
    // Fixture (ii): the #318 RTX 3060 Laptop -- usable for the PROFILE bump (>= USABLE_VRAM_MB)
    // but, with no freeMb reported, insufficient headroom for the POSTURE gate -> posture 'cpu'.
    // Exactly C1's failure combination: profile 'gpu', posture 'cpu'.
    const smallCard = settings({
      gpuMode: 'auto',
      gpuAutoDisabled: false,
      gpuProbe: {
        devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994 } as GpuDevice],
        probedAt: new Date().toISOString()
      }
    })
    const occupancy = noOccupancy(COMMITTED_4B)

    // "Drive main/index.ts's seam" -- the shared helper IS that seam's core logic post-fix.
    const posture1 = resolveRerankerDevicePosture(bigCard(), MANIFESTS_DIR, occupancy)
    const posture2 = resolveRerankerDevicePosture(smallCard, MANIFESTS_DIR, occupancy)
    expect(posture1).toBe('gpu')
    expect(posture2).toBe('cpu')

    // resolveAskCandidateScope, called with the EXACT SAME (settings, manifestsDir, occupancy),
    // must reflect the SAME posture computed above -- both fixtures resolve profile 'gpu' (both
    // cards clear USABLE_VRAM_MB for the profile bump), so the resulting scope is the observable
    // witness of which posture resolveAskCandidateScope used. A future edit that re-derives
    // posture inline instead of delegating to the shared helper (or forgets to wire
    // manifestsDir/occupancy through) would make one of these two assertions disagree with the
    // posture computed above.
    expect(resolveAskCandidateScope(bigCard(), true, MANIFESTS_DIR, occupancy)).toBe(GPU_RERANK_SCOPE)
    expect(resolveAskCandidateScope(smallCard, true, MANIFESTS_DIR, occupancy)).toBe('capped')
  })
})
