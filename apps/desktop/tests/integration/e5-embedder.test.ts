import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { E5Embedder } from '../../src/main/services/embeddings/e5'
import { createSelectedEmbedder } from '../../src/main/services/embeddings/factory'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

function fakeSpawn() {
  const calls: Array<{ args: string[] }> = []
  const child = new FakeChild()
  const spawn = (_c: string, args: string[]): ChildProcessLike => {
    calls.push({ args })
    return child
  }
  return { spawn, calls, child }
}

/** Routes /health (ok) and /v1/embeddings (returns the given per-text embeddings). */
function embedFetch(embeddings: number[][], opts: { shuffle?: boolean } = {}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
    if (u.endsWith('/v1/embeddings')) {
      // Return exactly the configured embeddings (a wrong count triggers the guard).
      const data = embeddings.map((e, i) => ({ embedding: e, index: i }))
      if (opts.shuffle) data.reverse() // server returns out of order; embedder must re-sort by index
      return { ok: true, status: 200, json: async () => ({ data }) } as Response
    }
    throw new Error(`unexpected url ${u}`)
  }) as typeof fetch
}

describe('E5Embedder', () => {
  const base = {
    id: 'multilingual-e5-small-q8',
    binPath: '/bin/llama-server',
    modelPath: '/models/e5.gguf',
    findPort: async () => 52000,
    healthIntervalMs: 1,
    // The fake server returns 2-dim vectors; declare that so the width guard accepts them.
    dimensions: 2
  }

  it('embeds via the loopback server and L2-normalizes the result', async () => {
    const { spawn } = fakeSpawn()
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([[3, 4]]) })
    const [v] = await embedder.embed(['hello'])
    // 3-4-5 triangle → normalized to 0.6 / 0.8 (Float32 precision).
    expect(v[0]).toBeCloseTo(0.6, 6)
    expect(v[1]).toBeCloseTo(0.8, 6)
    let norm = 0
    for (const x of v) norm += x * x
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6)
    expect(embedder.id).toBe('multilingual-e5-small-q8')
    await embedder.stop()
  })

  it('preserves input order even if the server returns shuffled indices', async () => {
    const { spawn } = fakeSpawn()
    const embedder = new E5Embedder({
      ...base,
      spawn,
      fetchImpl: embedFetch([[1, 0], [0, 1]], { shuffle: true })
    })
    const [a, b] = await embedder.embed(['first', 'second'])
    expect(Array.from(a)).toEqual([1, 0])
    expect(Array.from(b)).toEqual([0, 1])
    await embedder.stop()
  })

  it('spawns the embeddings sidecar once with --embedding, lazily, and reuses it', async () => {
    const { spawn, calls, child } = fakeSpawn()
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([[1, 0]]) })
    expect(calls.length).toBe(0) // not started until the first embed
    await embedder.embed(['a'])
    await embedder.embed(['b'])
    expect(calls.length).toBe(1) // reused, not re-spawned
    expect(calls[0].args).toContain('--embedding')
    expect(calls[0].args.join(' ')).toContain('--host 127.0.0.1')
    await embedder.stop()
    expect(child.killed).toBe(true)
  })

  it('returns [] for an empty batch without starting the server', async () => {
    const { spawn, calls } = fakeSpawn()
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([]) })
    expect(await embedder.embed([])).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('throws when the server returns the wrong number of embeddings', async () => {
    const { spawn } = fakeSpawn()
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([[1, 0]]) })
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow(/count mismatch/)
    await embedder.stop()
  })

  it('throws on a wrong-width vector instead of storing a 0/short-dim embedding', async () => {
    const { spawn } = fakeSpawn()
    // Declares 384 dims but the server returns a 2-dim (or empty) vector → reject, so the
    // document fails rather than persisting an un-searchable row (H4).
    const embedder = new E5Embedder({
      ...base,
      dimensions: 384,
      spawn,
      fetchImpl: embedFetch([[1, 0]])
    })
    await expect(embedder.embed(['a'])).rejects.toThrow(/dimension mismatch/)
    await embedder.stop()
  })
})

// ---- Embedder selector ----------------------------------------------------------

describe('createSelectedEmbedder', () => {
  const model = { id: 'multilingual-e5-small-q8', modelPath: '/models/e5.gguf' }

  it('falls back to the mock when no binary / no weights / no model', () => {
    const noBin = createSelectedEmbedder({ rootPath: '/r', model, resolveBin: () => null })
    expect(noBin.id).toBe('mock-embedder')

    const noWeights = createSelectedEmbedder({
      rootPath: '/r',
      model,
      resolveBin: () => '/bin/llama-server',
      modelExists: () => false
    })
    expect(noWeights.id).toBe('mock-embedder')

    const noModel = createSelectedEmbedder({ rootPath: '/r', model: null, resolveBin: () => '/bin/x' })
    expect(noModel.id).toBe('mock-embedder')
  })

  it('selects the real E5 embedder (manifest id) when binary AND weights are present', () => {
    const e = createSelectedEmbedder({
      rootPath: '/r',
      model,
      resolveBin: () => '/bin/llama-server',
      modelExists: () => true
    })
    expect(e.id).toBe('multilingual-e5-small-q8')
    expect(e).toBeInstanceOf(E5Embedder)
  })
})
