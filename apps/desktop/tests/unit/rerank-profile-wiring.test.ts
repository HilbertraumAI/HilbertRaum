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

describe('resolveAskCandidateScope (registerRagIpc.ts)', () => {
  it('rerankerAvailable: false -> always "capped", regardless of gpuMode/probe/opt-in (the B7/B12 danger: a dropped or inverted rerankerAvailable must never widen the pool with no cross-encoder)', () => {
    const cases: Array<Partial<AppSettings>> = [
      {},
      { gpuMode: 'off' },
      { gpuAutoDisabled: true },
      { ragRerankWideScope: true },
      {
        gpuProbe: {
          devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }],
          probedAt: new Date().toISOString()
        }
      }
    ]
    for (const overrides of cases) {
      // manifestsDir is irrelevant here: rerankerAvailable: false short-circuits before either
      // the profile or the posture is consulted.
      expect(resolveAskCandidateScope(settings(overrides), false, null, noOccupancy())).toBe('capped')
    }
  })

  it('rerankerAvailable: true with no usable probe on record and the opt-in off -> "capped" (the default profile\'s scope, unchanged)', () => {
    const s = settings({ gpuProbe: null, gpuMode: 'auto', gpuAutoDisabled: false, ragRerankWideScope: false })
    expect(resolveAskCandidateScope(s, true, null, noOccupancy())).toBe('capped')
  })

  it('is deterministic for a fixed settings AND occupancy snapshot (calling it twice in a row never disagrees with itself)', () => {
    const s = settings({ ragRerankWideScope: true })
    const first = resolveAskCandidateScope(s, true, null, noOccupancy())
    const second = resolveAskCandidateScope(s, true, null, noOccupancy())
    expect(second).toBe(first)
  })

  // Wave 8 ruling (a): a chat start in flight/pending, or a translation occupant, forces `cpu`
  // regardless of how favourable the settings/probe otherwise look — proven directly against
  // this function (not just against the shared helper below), since it is the one production
  // call site that must never regress to trusting the setting alone.
  it('a chat start in flight/pending, or a translation occupant, forces the scope down to "capped" even on the measurement machine\'s own GPU fixture', () => {
    const s = settings({
      gpuMode: 'auto',
      gpuAutoDisabled: false,
      gpuProbe: {
        devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }],
        probedAt: new Date().toISOString()
      }
    })
    const committed = 'qwen3.5-4b-ud-q4kxl'
    const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')
    expect(
      resolveAskCandidateScope(s, true, MANIFESTS_DIR, { committedModelId: committed, chatStartBusy: false, translationOccupied: false })
    ).toBe(GPU_RERANK_SCOPE) // sanity: the neutral occupancy still resolves the wide scope
    expect(
      resolveAskCandidateScope(s, true, MANIFESTS_DIR, { committedModelId: committed, chatStartBusy: true, translationOccupied: false })
    ).toBe('capped')
    expect(
      resolveAskCandidateScope(s, true, MANIFESTS_DIR, { committedModelId: committed, chatStartBusy: false, translationOccupied: true })
    ).toBe('capped')
  })

  // #495 fix (SF-1, scoped review of PR #495): the reranker's own session GPU-fallback latch
  // (`LlamaReranker.gpuDemoted()`) used to be invisible to this function -- after a demotion the
  // ask site kept resolving the wide GPU_RERANK_SCOPE while the sidecar itself was CPU-pinned,
  // so G (the CPU request ceiling) refused every such ask and a demoted session got NO rerank at
  // all for knowledge-pack asks. `rerankerDemoted` on the occupancy snapshot closes that gap.
  it('SF-1 (#495 fix): a demoted reranker (rerankerDemoted) forces the scope down to "capped" even on the big-card fixture that would otherwise resolve the wide scope', () => {
    const bigCard = settings({
      gpuMode: 'auto',
      gpuAutoDisabled: false,
      gpuProbe: {
        devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }],
        probedAt: new Date().toISOString()
      }
    })
    const committed = 'qwen3.5-4b-ud-q4kxl'
    const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')
    // Sanity: the neutral (not-demoted) occupancy still resolves the wide scope on this fixture.
    expect(resolveAskCandidateScope(bigCard, true, MANIFESTS_DIR, noOccupancy(committed))).toBe(GPU_RERANK_SCOPE)
    expect(
      resolveAskCandidateScope(bigCard, true, MANIFESTS_DIR, { ...noOccupancy(committed), rerankerDemoted: true })
    ).toBe('capped')
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
  const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')

  it('the two call sites resolve the SAME posture from the SAME settings AND occupancy snapshot -- a future divergence fails here', () => {
    // Fixture (i): the measurement machine's own device (RTX 3080 Ti, provable headroom) ->
    // posture 'gpu' (see rerank-profile.test.ts's identical fixture (i)). `committedModelId`
    // stands in for the OLD `activeModelId` fixture value -- since Wave 8 ruling (a) the setting
    // itself is never read for this decision.
    const bigCard = settings({
      gpuMode: 'auto',
      gpuAutoDisabled: false,
      gpuProbe: {
        devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }],
        probedAt: new Date().toISOString()
      }
    })
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
    const occupancy = noOccupancy('qwen3.5-4b-ud-q4kxl')

    // "Drive main/index.ts's seam" -- the shared helper IS that seam's core logic post-fix.
    const posture1 = resolveRerankerDevicePosture(bigCard, MANIFESTS_DIR, occupancy)
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
    expect(resolveAskCandidateScope(bigCard, true, MANIFESTS_DIR, occupancy)).toBe(GPU_RERANK_SCOPE)
    expect(resolveAskCandidateScope(smallCard, true, MANIFESTS_DIR, occupancy)).toBe('capped')
  })
})
