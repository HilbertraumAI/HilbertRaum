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

import { resolveAskCandidateScope } from '../../src/main/ipc/registerRagIpc'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types'

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
      expect(resolveAskCandidateScope(settings(overrides), false)).toBe('capped')
    }
  })

  it('rerankerAvailable: true with no usable probe on record and the opt-in off -> "capped" (the default profile\'s scope, unchanged)', () => {
    const s = settings({ gpuProbe: null, gpuMode: 'auto', gpuAutoDisabled: false, ragRerankWideScope: false })
    expect(resolveAskCandidateScope(s, true)).toBe('capped')
  })

  it('is deterministic for a fixed settings snapshot (calling it twice in a row never disagrees with itself)', () => {
    const s = settings({ ragRerankWideScope: true })
    const first = resolveAskCandidateScope(s, true)
    const second = resolveAskCandidateScope(s, true)
    expect(second).toBe(first)
  })
})
