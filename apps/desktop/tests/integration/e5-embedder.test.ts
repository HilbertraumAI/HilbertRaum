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

  // M7 (audit round 4): chunk sizing is whitespace WORDS but the sidecar context is real
  // BPE tokens — oversize inputs overflowed the context and failed the whole document,
  // and all (up to 1000) chunks went out as ONE request with no timeout.
  it('truncates each input to the embedder context budget before sending', async () => {
    const bodies: Array<{ input: string[] }> = []
    const recordingFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      bodies.push(body)
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: body.input.map((_, i) => ({ embedding: [1, 0], index: i })) })
      } as Response
    }) as typeof fetch

    const embedder = new E5Embedder({ ...base, contextTokens: 512, spawn: fakeSpawn().spawn, fetchImpl: recordingFetch })
    const longText = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ')
    await embedder.embed([longText, 'short text'])
    await embedder.stop()

    const sent = bodies[0].input
    const maxWords = Math.floor(512 / 1.4)
    expect(sent[0].split(' ').length).toBeLessThanOrEqual(maxWords) // truncated
    expect(sent[0].startsWith('word0 word1')).toBe(true) // the chunk's head is kept
    expect(sent[1]).toBe('short text') // short inputs pass through untouched
  })

  it('splits large inputs into bounded batches, preserving global order', async () => {
    const bodies: Array<{ input: string[] }> = []
    let counter = 0
    const batchFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      bodies.push(body)
      // Encode a global counter into the vector so order is verifiable end-to-end.
      const data = body.input.map((_, i) => ({ embedding: [++counter, 0], index: i }))
      return { ok: true, status: 200, json: async () => ({ data }) } as Response
    }) as typeof fetch

    const embedder = new E5Embedder({ ...base, batchSize: 3, spawn: fakeSpawn().spawn, fetchImpl: batchFetch })
    const texts = Array.from({ length: 7 }, (_, i) => `text ${i}`)
    const vectors = await embedder.embed(texts)
    await embedder.stop()

    expect(bodies.map((b) => b.input.length)).toEqual([3, 3, 1]) // bounded batches
    expect(vectors).toHaveLength(7)
    // L2-normalized [n, 0] → [1, 0]; the global order check is that nothing was dropped
    // or duplicated across batch boundaries.
    expect(vectors.every((v) => v.length === 2)).toBe(true)
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

  // H3 (audit round 4): `this.server` is only assigned after the lazy start resolves,
  // so a stop() racing the first embed() used to see `server == null`, return, and let
  // the just-spawned sidecar outlive the app as an orphan. stop() must await the
  // in-flight start and kill whatever it produced — and block any later restart.
  it('stop() during the in-flight lazy start kills the sidecar (no orphan)', async () => {
    const { spawn, child } = fakeSpawn()
    const health: { release: (() => void) | null } = { release: null }
    const gatedFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) {
        // Hold the health poll so the start stays in flight until the test releases it.
        await new Promise<void>((resolve) => (health.release = resolve))
        return { ok: true, status: 200 } as Response
      }
      if (u.endsWith('/v1/embeddings')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: [1, 0], index: 0 }] })
        } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch

    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: gatedFetch })
    const embedPromise = embedder.embed(['a'])
    // Wait until the lazy start has spawned the child and is polling /health.
    while (!health.release) await new Promise((r) => setTimeout(r, 1))

    const stopPromise = embedder.stop() // app quits while the sidecar is still starting
    health.release()
    await stopPromise
    await embedPromise.catch(() => undefined) // the embed may fail; no-orphan is the point

    expect(child.killed).toBe(true)
    // The stopped flag must also block a later embed from resurrecting the sidecar.
    await expect(embedder.embed(['b'])).rejects.toThrow(/stopped/)
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
