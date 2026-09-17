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
import { resolveRerankerDevicePosture } from '../../src/main/services/rag/device-posture'
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
      expect(resolveAskCandidateScope(settings(overrides), false, null)).toBe('capped')
    }
  })

  it('rerankerAvailable: true with no usable probe on record and the opt-in off -> "capped" (the default profile\'s scope, unchanged)', () => {
    const s = settings({ gpuProbe: null, gpuMode: 'auto', gpuAutoDisabled: false, ragRerankWideScope: false })
    expect(resolveAskCandidateScope(s, true, null)).toBe('capped')
  })

  it('is deterministic for a fixed settings snapshot (calling it twice in a row never disagrees with itself)', () => {
    const s = settings({ ragRerankWideScope: true })
    const first = resolveAskCandidateScope(s, true, null)
    const second = resolveAskCandidateScope(s, true, null)
    expect(second).toBe(first)
  })
})

// Wave 6 ruling (c) (scoped Opus review of step 4-5, finding C1): ONE shared posture helper must
// feed BOTH `main/index.ts`'s `rerankerDevicePosture` seam and this function, so the two can
// never disagree. `main/index.ts`'s seam is, after the fix, nothing but a DB-fetch wrapper around
// `resolveRerankerDevicePosture(settings, manifestsDir)` (see that closure's own comment) — so
// calling the shared helper directly here stands in for that seam, and driving
// `resolveAskCandidateScope` from the EXACT SAME (settings, manifestsDir) fixture proves the two
// call sites agree, not just that each one is independently plausible. Real model manifests, the
// same ones `rerank-profile.test.ts`'s headroom-gate fixtures use — never a hand-duplicated MiB
// figure — so a manifest edit that silently moves the threshold is caught here too.
describe('resolveAskCandidateScope and the shared posture helper resolve the same posture (Wave 6 ruling (c))', () => {
  const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')

  it('the two call sites resolve the SAME posture from the SAME settings snapshot -- a future divergence fails here', () => {
    // Fixture (i): the measurement machine's own device (RTX 3080 Ti, provable headroom) ->
    // posture 'gpu' (see rerank-profile.test.ts's identical fixture (i)).
    const bigCard = settings({
      gpuMode: 'auto',
      gpuAutoDisabled: false,
      activeModelId: 'qwen3.5-4b-ud-q4kxl',
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
      activeModelId: 'qwen3.5-4b-ud-q4kxl',
      gpuProbe: {
        devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994 } as GpuDevice],
        probedAt: new Date().toISOString()
      }
    })

    // "Drive main/index.ts's seam" -- the shared helper IS that seam's core logic post-fix.
    const posture1 = resolveRerankerDevicePosture(bigCard, MANIFESTS_DIR)
    const posture2 = resolveRerankerDevicePosture(smallCard, MANIFESTS_DIR)
    expect(posture1).toBe('gpu')
    expect(posture2).toBe('cpu')

    // resolveAskCandidateScope, called with the EXACT SAME (settings, manifestsDir), must reflect
    // the SAME posture computed above -- both fixtures resolve profile 'gpu' (both cards clear
    // USABLE_VRAM_MB for the profile bump), so the resulting scope is the observable witness of
    // which posture resolveAskCandidateScope used. A future edit that re-derives posture inline
    // instead of delegating to the shared helper (or forgets to wire manifestsDir through) would
    // make one of these two assertions disagree with the posture computed above.
    expect(resolveAskCandidateScope(bigCard, true, MANIFESTS_DIR)).toBe(GPU_RERANK_SCOPE)
    expect(resolveAskCandidateScope(smallCard, true, MANIFESTS_DIR)).toBe('capped')
  })
})
