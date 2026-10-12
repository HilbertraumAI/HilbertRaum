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
  weights: boolean | ((path: string) => boolean)
}) {
  const weights = over.weights
  return resolveSidecarSelection<SidecarModel, unknown>({
    rootPath: 'C:/drive',
    model: over.model,
    resolveBin: () => over.bin,
    modelExists: typeof weights === 'function' ? weights : () => weights,
    makeReal: () => ({}),
    binaryName: 'llama-server',
    modelNoun: 'embedding model'
  })
}

describe('resolveSidecarSelection (L16)', () => {
  it.each<[string, Parameters<typeof run>[0], string]>([
    ['no model is configured', { model: null, bin: 'C:/bin', weights: true }, 'no embedding model configured'],
    ['the binary is missing', { model: MODEL, bin: null, weights: true }, 'no llama-server binary on the drive'],
    ['the weights are absent', { model: MODEL, bin: 'C:/bin', weights: false }, 'embedding model weights not present'],
    // Precedence when several rungs fail: model first, then binary, then weights.
    ['no model, no binary, no weights — the model wins', { model: null, bin: null, weights: false }, 'no embedding model configured'],
    ['no binary, no weights — the binary wins', { model: MODEL, bin: null, weights: false }, 'no llama-server binary on the drive']
  ])('reports unavailable when %s', (_label, input, reason) => {
    const sel = run(input)
    expect(sel.available).toBe(false)
    expect(sel.reason).toBe(reason)
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

  // #310: a sidecar-backed role's weight can be several files. Existence only (these roles
  // never hash) — but ALL of them, or the role would report available on a fraction of a model
  // and fail at load time instead of at the gate.
  describe('multi-file weights (#310)', () => {
    const SHARDED: SidecarModel = {
      id: 'm',
      modelPath: 'C:/weights/m-00001-of-00003.gguf',
      requiredPaths: [
        'C:/weights/m-00001-of-00003.gguf',
        'C:/weights/m-00002-of-00003.gguf',
        'C:/weights/m-00003-of-00003.gguf'
      ]
    }

    it('reports weights not present when ANY required file is absent', () => {
      const sel = run({
        model: SHARDED,
        bin: 'C:/bin',
        weights: (p) => !p.endsWith('m-00002-of-00003.gguf')
      })
      expect(sel.available).toBe(false)
      expect(sel.reason).toBe('embedding model weights not present')
    })

    it('reports available when EVERY required file is present', () => {
      const sel = run({ model: SHARDED, bin: 'C:/bin', weights: () => true })
      expect(sel.available).toBe(true)
    })

    it('falls back to [modelPath] when the caller declares no requiredPaths', () => {
      const checked: string[] = []
      const sel = run({
        model: MODEL,
        bin: 'C:/bin',
        weights: (p) => {
          checked.push(p)
          return true
        }
      })
      expect(sel.available).toBe(true)
      expect(checked).toEqual(['C:/weights/m.gguf'])
    })
  })
})
