import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { LlamaReranker } from '../../src/main/services/reranker/llama'
import { createSelectedReranker } from '../../src/main/services/reranker/factory'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

// Phase 21 (rag-design §11 reranker): the reranker sidecar — driven entirely through the
// fake-spawn + mocked-loopback-fetch harness (the E5 embedder test pattern). CI never
// needs a binary or a model; the live load + latency check is the PAID_RERANK_SMOKE
// manual harness (tests/manual/rerank-smoke.test.ts).

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

/**
 * Routes /health (ok) and /v1/rerank. Replies in the b9585 Jina shape (rag-design
 * §12.1 R1): `results: [{ index, relevance_score }]` SORTED BY SCORE DESC — deliberately
 * not input order, so the index-mapping contract is exercised.
 */
function rerankFetch(scores: number[], recorded?: Array<{ query: string; documents: string[] }>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
    if (u.endsWith('/v1/rerank')) {
      const body = JSON.parse(String(init?.body)) as { query: string; documents: string[] }
      recorded?.push(body)
      const results = scores
        .slice(0, body.documents.length)
        .map((relevance_score, index) => ({ index, relevance_score }))
        .sort((a, b) => b.relevance_score - a.relevance_score)
      return { ok: true, status: 200, json: async () => ({ results }) } as Response
    }
    throw new Error(`unexpected url ${u}`)
  }) as typeof fetch
}

const base = {
  id: 'bge-reranker-v2-m3-f16',
  binPath: '/bin/llama-server',
  modelPath: '/models/reranker.gguf',
  findPort: async () => 53000,
  healthIntervalMs: 1
}

describe('LlamaReranker', () => {
  it('scores documents via /v1/rerank and maps results back by index (server sorts by score)', async () => {
    const { spawn } = fakeSpawn()
    const recorded: Array<{ query: string; documents: string[] }> = []
    // Input 0 scores low, input 1 high → the server's response order is [1, 0].
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch([-2.5, 7.1], recorded) })
    const hits = await reranker.rerank('which doc?', ['irrelevant', 'relevant'])
    expect(hits).toHaveLength(2)
    const byIndex = new Map(hits.map((h) => [h.index, h.score]))
    expect(byIndex.get(0)).toBeCloseTo(-2.5, 6)
    expect(byIndex.get(1)).toBeCloseTo(7.1, 6)
    // Request shape per the b9585 source: { query, documents } (Jina format).
    expect(recorded[0].query).toBe('which doc?')
    expect(recorded[0].documents).toEqual(['irrelevant', 'relevant'])
    await reranker.stop()
  })

  // M-C5: a caller "Stop" (opts.signal) must abort the (CPU-slow) rerank in flight,
  // not only on the request timeout.
  it('forwards the caller abort signal to the rerank request (aborts in flight)', async () => {
    const { spawn } = fakeSpawn()
    let seenSignal: AbortSignal | undefined
    const hangingFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      seenSignal = init?.signal ?? undefined
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as typeof fetch

    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: hangingFetch })
    const controller = new AbortController()
    const rerankPromise = reranker.rerank('q', ['a', 'b'], { signal: controller.signal })
    await new Promise((r) => setTimeout(r, 1))
    controller.abort()
    await expect(rerankPromise).rejects.toThrow(/abort/i)
    expect(seenSignal?.aborted).toBe(true)
    await reranker.stop()
  })

  it('spawns the sidecar once with --rerank + CPU pin, lazily, WITHOUT the chat args', async () => {
    const { spawn, calls, child } = fakeSpawn()
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch([1]) })
    expect(calls.length).toBe(0) // not started until the first rerank
    await reranker.rerank('q', ['d'])
    await reranker.rerank('q2', ['d2'])
    expect(calls.length).toBe(1) // reused, not re-spawned
    const args = calls[0].args.join(' ')
    expect(args).toContain('--rerank')
    expect(args).toContain('--host 127.0.0.1') // localhost-only, locked
    // CPU pin, same rationale as the E5 embedder (architecture.md GPU record §7).
    expect(args).toContain('--device none')
    expect(args).not.toContain('-ngl')
    // Physical batch sized to the context: in --rerank/embedding mode llama-server forces
    // n_batch = n_ubatch and defaults them to 512, but a query+document rerank input runs
    // ~670 tokens — the 512 default 500s the whole request on real-length chunks (found by
    // PAID_RERANK_SMOKE; rag-design §12.1 R1 deviation). Must match --ctx-size.
    expect(args).toContain('--batch-size 2048')
    expect(args).toContain('--ubatch-size 2048')
    expect(args).toContain('--ctx-size 2048')
    // CHAT_SERVER_ARGS are chat-only (Phase 20) and must NOT leak to this sidecar.
    expect(args).not.toContain('--jinja')
    expect(args).not.toContain('--reasoning-format')
    await reranker.stop()
    expect(child.killed).toBe(true)
  })

  it('truncates query and documents to the word budget before sending', async () => {
    const recorded: Array<{ query: string; documents: string[] }> = []
    const reranker = new LlamaReranker({
      ...base,
      spawn: fakeSpawn().spawn,
      fetchImpl: rerankFetch([1], recorded)
    })
    const longDoc = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ')
    const longQuery = Array.from({ length: 500 }, (_, i) => `q${i}`).join(' ')
    await reranker.rerank(longQuery, [longDoc])
    await reranker.stop()
    expect(recorded[0].query.split(' ').length).toBeLessThanOrEqual(160)
    expect(recorded[0].documents[0].split(' ').length).toBeLessThanOrEqual(320)
    expect(recorded[0].documents[0].startsWith('word0 word1')).toBe(true) // head kept
  })

  it('returns [] for an empty batch without starting the server', async () => {
    const { spawn, calls } = fakeSpawn()
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch([]) })
    expect(await reranker.rerank('q', [])).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('throws when the server does not return exactly one score per input', async () => {
    const { spawn } = fakeSpawn()
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch([1]) })
    await expect(reranker.rerank('q', ['a', 'b'])).rejects.toThrow(/mismatch/)
    await reranker.stop()
  })

  it('latches a failed start: later rerank() calls fail fast without re-spawning', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      // The server dies immediately (e.g. an incompatible GGUF — the E5 q8_0 story).
      queueMicrotask(() => child.emit('exit', 1, null))
      return child
    }
    const reranker = new LlamaReranker({
      ...base,
      spawn,
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    })
    await expect(reranker.rerank('q', ['a'])).rejects.toThrow()
    await expect(reranker.rerank('q', ['a'])).rejects.toThrow()
    // One spawn total: the failed-start latch prevents a health-timeout stall per question.
    expect(calls.length).toBe(1)
    await reranker.stop()
  })

  it('stop() during the in-flight lazy start kills the sidecar and blocks restarts', async () => {
    const { spawn, child } = fakeSpawn()
    const health: { release: (() => void) | null } = { release: null }
    const gatedFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) {
        await new Promise<void>((resolve) => (health.release = resolve))
        return { ok: true, status: 200 } as Response
      }
      return { ok: true, status: 200, json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) } as Response
    }) as typeof fetch

    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: gatedFetch })
    const rerankPromise = reranker.rerank('q', ['a'])
    while (!health.release) await new Promise((r) => setTimeout(r, 1))
    const stopPromise = reranker.stop()
    health.release()
    await stopPromise
    await rerankPromise.catch(() => undefined)
    expect(child.killed).toBe(true)
    await expect(reranker.rerank('q', ['b'])).rejects.toThrow(/stopped/)
  })

  it('suspend() stops the sidecar but allows a lazy restart (workspace-lock path)', async () => {
    const calls: Array<{ args: string[] }> = []
    const children: FakeChild[] = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      children.push(child)
      return child
    }
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch([1, 2]) })
    await reranker.rerank('q', ['a'])
    await reranker.suspend()
    expect(children[0].killed).toBe(true)
    // Unlike stop(), the next rerank lazily restarts a fresh sidecar.
    const hits = await reranker.rerank('q', ['b'])
    expect(hits).toHaveLength(1)
    expect(calls.length).toBe(2)
    await reranker.stop()
  })
})

// ---- Reranker selector ------------------------------------------------------------

describe('createSelectedReranker', () => {
  const model = { id: 'bge-reranker-v2-m3-f16', modelPath: '/models/reranker.gguf' }

  it('returns null (NOT a mock) when no binary / no weights / no model', () => {
    expect(createSelectedReranker({ rootPath: '/r', model, resolveBin: () => null })).toBeNull()
    expect(
      createSelectedReranker({
        rootPath: '/r',
        model,
        resolveBin: () => '/bin/llama-server',
        modelExists: () => false
      })
    ).toBeNull()
    expect(createSelectedReranker({ rootPath: '/r', model: null, resolveBin: () => '/bin/x' })).toBeNull()
  })

  it('selects the real reranker (manifest id) when binary AND weights are present', () => {
    const r = createSelectedReranker({
      rootPath: '/r',
      model,
      resolveBin: () => '/bin/llama-server',
      modelExists: () => true
    })
    expect(r).toBeInstanceOf(LlamaReranker)
    expect(r?.id).toBe('bge-reranker-v2-m3-f16')
  })
})
