import { describe, it, expect } from 'vitest'
import {
  resolveSidecarSelection,
  type SidecarModel
} from '../../src/main/services/select-sidecar-backed'

// L16 (audit-2026-06-13): the shared model→binary→weights availability ladder that the
// embeddings / reranker / transcriber factories now delegate to. Drive it through the
// resolveBin/modelExists seams (no real binaries, no fs).

const MODEL: SidecarModel = { id: 'm', modelPath: 'C:/weights/m.gguf' }

function run(over: {
  model: SidecarModel | null
  bin: string | null
  weights: boolean
}) {
  return resolveSidecarSelection<SidecarModel, unknown>({
    rootPath: 'C:/drive',
    model: over.model,
    resolveBin: () => over.bin,
    modelExists: () => over.weights,
    makeReal: () => ({}),
    binaryName: 'llama-server',
    modelNoun: 'embedding model'
  })
}

describe('resolveSidecarSelection (L16)', () => {
  it('reports unavailable when no model is configured', () => {
    const sel = run({ model: null, bin: 'C:/bin', weights: true })
    expect(sel.available).toBe(false)
    expect(sel.reason).toBe('no embedding model configured')
  })

  it('reports unavailable when the binary is missing', () => {
    const sel = run({ model: MODEL, bin: null, weights: true })
    expect(sel.available).toBe(false)
    expect(sel.reason).toBe('no llama-server binary on the drive')
  })

  it('reports unavailable when the weights are absent', () => {
    const sel = run({ model: MODEL, bin: 'C:/bin', weights: false })
    expect(sel.available).toBe(false)
    expect(sel.reason).toBe('embedding model weights not present')
  })

  it('reports available with the model + binPath when both are present', () => {
    const sel = run({ model: MODEL, bin: 'C:/bin/llama-server', weights: true })
    expect(sel.available).toBe(true)
    if (sel.available) {
      expect(sel.reason).toBe('binary + weights present')
      expect(sel.model).toBe(MODEL)
      expect(sel.binPath).toBe('C:/bin/llama-server')
    }
  })

  it('checks the rungs in order: model first, then binary, then weights', () => {
    // No model wins even if a binary is given; no binary wins over present weights.
    expect(run({ model: null, bin: null, weights: false }).reason).toBe(
      'no embedding model configured'
    )
    expect(run({ model: MODEL, bin: null, weights: false }).reason).toBe(
      'no llama-server binary on the drive'
    )
  })
})
