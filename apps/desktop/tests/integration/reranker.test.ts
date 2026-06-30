import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { LlamaReranker } from '../../src/main/services/reranker/llama'
import { createSelectedReranker } from '../../src/main/services/reranker/factory'
import { approxTokenCount, CHUNK_DEFAULTS } from '../../src/main/services/ingestion/chunker'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

// Phase 21 (rag-design §11 reranker): the reranker sidecar — driven entirely through the
// fake-spawn + mocked-loopback-fetch harness (the E5 embedder test pattern). CI never
// needs a binary or a model; the live load + latency check is the HILBERTRAUM_RERANK_SMOKE
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

/**
 * Reproduces llama-server's n_ctx 500: a query+document sequence whose combined approx-token
 * cost exceeds the context makes the real server reply HTTP 500 ("input … is too large to
 * process"). With a space-less passage left untruncated this 500 → rerank() throws → the caller
 * (rag/index.ts) silently keeps the fused order — the reranker no-ops on CJK/Thai (EMB-1). The
 * token-aware truncation must keep the sent inputs under the context so this never fires.
 */
function ctxBoundedRerankFetch(
  contextTokens: number,
  recorded: Array<{ query: string; documents: string[] }>
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
    if (u.endsWith('/v1/rerank')) {
      const body = JSON.parse(String(init?.body)) as { query: string; documents: string[] }
      recorded.push(body)
      const overflows = body.documents.some(
        (d) => approxTokenCount(body.query) + approxTokenCount(d) > contextTokens
      )
      if (overflows) return { ok: false, status: 500 } as Response
      const results = body.documents.map((_d, index) => ({ index, relevance_score: index }))
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
    // Deterministically wait until the rerank request has REACHED fetch (the signal was handed over)
    // before aborting — a fixed `sleep(1)` could fire before fetch under CPU starvation and exercise a
    // different (pre-flight) path (T5). State-poll on the captured signal (the file's own idiom).
    while (!seenSignal) await new Promise((r) => setTimeout(r, 1))
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
    // HILBERTRAUM_RERANK_SMOKE; rag-design §12.1 R1 deviation). Must match --ctx-size.
    expect(args).toContain('--batch-size 2048')
    expect(args).toContain('--ubatch-size 2048')
    expect(args).toContain('--ctx-size 2048')
    // CHAT_SERVER_ARGS are chat-only (Phase 20) and must NOT leak to this sidecar.
    expect(args).not.toContain('--jinja')
    expect(args).not.toContain('--reasoning-format')
    await reranker.stop()
    expect(child.killed).toBe(true)
  })

  it('truncates query and documents to the approx-token budget before sending', async () => {
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
    // English words are ~1 approx token each. The query cap is 160; the doc cap is the WHOLE chunk
    // window (CHUNK_DEFAULTS.chunkSizeTokens, RAG-N3) so a chunk's tail is never dropped before scoring.
    expect(recorded[0].query.split(' ').length).toBeLessThanOrEqual(160)
    expect(recorded[0].documents[0].split(' ').length).toBeLessThanOrEqual(CHUNK_DEFAULTS.chunkSizeTokens)
    expect(recorded[0].documents[0].startsWith('word0 word1')).toBe(true) // head kept
  })

  // EMB-1 (backend audit 2026-06-27): the OLD whitespace word-split treated a space-less CJK/Thai
  // passage as a SINGLE "word" and never truncated it → it overflowed n_ctx, the sidecar 500'd,
  // and rerank() threw, so rag/index.ts silently fell back to the fused order (a no-op reranker on
  // those scripts). The token-aware truncation (shared with the E5 embedder) keeps it under ctx.
  it('truncates a space-less CJK passage so the rerank does not overflow n_ctx and silently no-op [EMB-1]', async () => {
    const DEFAULT_CTX = 2048 // the reranker's default contextTokens
    const recorded: Array<{ query: string; documents: string[] }> = []
    const reranker = new LlamaReranker({
      ...base,
      spawn: fakeSpawn().spawn,
      fetchImpl: ctxBoundedRerankFetch(DEFAULT_CTX, recorded)
    })
    const cjk = '東'.repeat(5000) // one giant space-less "word", far over the context
    expect(approxTokenCount(cjk)).toBeGreaterThan(DEFAULT_CTX) // would 500 if sent untruncated
    const hits = await reranker.rerank('質問', [cjk, '短い文書'])
    await reranker.stop()

    // The reranker returned a real reordering — it did NOT 500 and fall through to fused order.
    expect(hits).toHaveLength(2)
    // The sent passage was truncated by token COST (CJK ~1 token/char), not left whole.
    expect(recorded[0].documents[0].length).toBeLessThan(cjk.length)
    expect(approxTokenCount(recorded[0].documents[0])).toBeLessThanOrEqual(DEFAULT_CTX)
  })

  // RAG-N3 (full audit 2026-06-28): chunks are sized to CHUNK_DEFAULTS.chunkSizeTokens (500)
  // approx tokens, but the reranker used to truncate every candidate to 320 before scoring — so a
  // chunk whose discriminating sentence sits in its SECOND HALF was scored on a prefix that never
  // contained it, and that truncated score drives BOTH the final order AND the dedup-by-page winner
  // (rag/index.ts:303-312). This pins that the WHOLE chunk reaches the sidecar: a chunk-sized doc
  // with a sentinel in its TAIL (past the old 320-token budget) is sent in full.
  // TEETH: PRE-FIX (doc cap 320) this FAILS — the tail is dropped before sending; the fix (cap =
  // chunkSizeTokens) makes it pass. Any future change that re-narrows the budget breaks it again.
  it('sends the WHOLE chunk to the reranker, including the tail past the old 320-token budget [RAG-N3]', async () => {
    const recorded: Array<{ query: string; documents: string[] }> = []
    const reranker = new LlamaReranker({
      ...base,
      spawn: fakeSpawn().spawn,
      fetchImpl: rerankFetch([1], recorded)
    })
    // ~400 head tokens, then a sentinel landing well past the old 320-token doc budget but still
    // within one 500-token chunk window — the exact RAG-N3 case (key sentence in the chunk's tail).
    const head = Array.from({ length: 400 }, (_, i) => `h${i}`).join(' ')
    const doc = `${head} TAILSENTINEL trailing context words`
    expect(approxTokenCount(doc)).toBeGreaterThan(320) // the tail is BEYOND the old doc budget
    expect(approxTokenCount(doc)).toBeLessThanOrEqual(CHUNK_DEFAULTS.chunkSizeTokens) // ...but within a chunk
    await reranker.rerank('which chunk is most relevant?', [doc])
    await reranker.stop()
    expect(recorded[0].documents[0].startsWith('h0 h1')).toBe(true) // head still kept
    expect(recorded[0].documents[0]).toContain('TAILSENTINEL') // the tail is now scored too
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

  // F7 (post-merge audit): a TRANSIENT port-bind race must NOT arm the failed-start latch. The
  // reranker's latch is more persistent than the embedder's — suspend() deliberately keeps it (a
  // bad GGUF won't load after unlock either) — so arming it for a race killed reranking for the
  // WHOLE session (a silent quality regression: rag/index.ts falls back to fused order). With the
  // fix the latch stays null for a race, so the next rerank() retries AND it survives suspend.
  it('does NOT latch a transient bind-race; rerank retries and stays available across suspend (F7)', async () => {
    const calls: Array<{ args: string[] }> = []
    let portFree = false
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild() as FakeChild & { stderr: EventEmitter }
      child.stderr = new EventEmitter()
      if (!portFree) {
        // A port-bind race: stderr reports EADDRINUSE and the child exits before health.
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('error: bind: address already in use\n'))
          child.emit('exit', 1, null)
        })
      }
      return child
    }
    // /health stays 503 while the port is contended so waitForHealthy observes the bind-race exit.
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: portFree, status: portFree ? 200 : 503 } as Response
      if (u.endsWith('/v1/rerank')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl })

    // Doubly-unlucky startup: both the initial start and its single bind-retry lose the port.
    await expect(reranker.rerank('q', ['a'])).rejects.toThrow(/address already in use/)
    expect(calls.length).toBe(2)

    // The latch must NOT arm for a transient race: a later rerank re-attempts a fresh start.
    portFree = true
    expect(await reranker.rerank('q', ['a'])).toHaveLength(1)
    expect(calls.length).toBe(3) // re-spawned, not fast-failed on a cached error

    // …and because a bind race never latched, reranking survives a suspend (workspace lock) — the
    // suspend()-keeps-latch policy is now correct (it forgives a race, persists a genuine fault).
    await reranker.suspend()
    expect(await reranker.rerank('q', ['b'])).toHaveLength(1)
    expect(calls.length).toBe(4)
    await reranker.stop()
  })

  it('a GENUINE load-fault latch still survives suspend — only transient races are forgiven (F7)', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      queueMicrotask(() => child.emit('exit', 1, null)) // a generic crash (bad GGUF), NOT a bind race
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
    expect(calls.length).toBe(1) // armed — no bind-retry for a non-race fault
    // suspend() must NOT clear a genuine load fault: a bad GGUF won't load after unlock either.
    await reranker.suspend()
    await expect(reranker.rerank('q', ['a'])).rejects.toThrow()
    expect(calls.length).toBe(1) // still latched — no re-spawn
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

  // F19 (full-audit-2026-06-29-postmerge): the reranker mirror of the embedder's guard. suspend()
  // (workspace lock) sets no `stopped`-style latch, so a suspend() that interleaves with a concurrent
  // rerank() could tear down the OLD sidecar while a fresh ensureStarted SPAWNS and RETAINS a new one
  // — surviving the lock with query/chunk-text-derived state in RAM. The `tearingDown` guard closes
  // it. Deterministic interleave via a gated-exit child; TEETH: drop the guard → child2 spawns,
  // is never killed, calls.length === 2 → red.
  it('suspend() does not retain a sidecar spawned by a concurrent rerank during teardown (F19)', async () => {
    class GatedChild extends EventEmitter implements ChildProcessLike {
      pid = 9
      killed = false
      private wantExit = false
      private released = false
      kill(): boolean {
        this.killed = true
        this.wantExit = true
        if (this.released) this.emit('exit', 0, null)
        return true
      }
      releaseExit(): void {
        this.released = true
        if (this.wantExit) this.emit('exit', 0, null)
      }
    }
    const children: GatedChild[] = []
    const calls: string[][] = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push(args)
      const c = new GatedChild()
      children.push(c)
      return c
    }
    const firstHealth = { release: null as null | (() => void) }
    let firstHealthDone = false
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) {
        if (!firstHealthDone) {
          await new Promise<void>((r) => (firstHealth.release = r))
          firstHealthDone = true
        }
        return { ok: true, status: 200 } as Response
      }
      if (u.endsWith('/v1/rerank')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch

    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl })

    // start1 in flight, parks on the gated first /health. Under the guard rerank1 itself rejects
    // (its post-start re-check sees tearingDown), so attach the catch up front.
    const rerank1 = reranker.rerank('q', ['a']).catch(() => undefined)
    while (!firstHealth.release) await new Promise((r) => setTimeout(r, 1))
    expect(children.length).toBe(1)

    const suspendP = reranker.suspend() // teardown: tearingDown=true, awaits this.starting (start1)
    await new Promise((r) => setTimeout(r, 1))

    firstHealth.release!() // start1 resolves → teardown advances to server.stop()
    while (!children[0].killed) await new Promise((r) => setTimeout(r, 1)) // teardown parked on the gated exit

    const rerank2 = reranker.rerank('q', ['b']).then(
      () => 'ok',
      () => 'rejected'
    )
    // DX-6 (Phase 7): deterministic in place of a fixed 25 ms "nothing spawned" settle. Under the
    // F19 tearingDown guard rerank2's ensureStarted REFUSES in the teardown window, so rerank2
    // settles to 'rejected' on its own — no wall-clock wait. A regression that spawned child2 would
    // instead resolve 'ok' (and bump calls.length below), so awaiting the outcome is the assertion.
    expect(await rerank2).toBe('rejected')

    children[0].releaseExit()
    await suspendP
    await rerank1

    expect(calls.length).toBe(1)
    for (const c of children) expect(c.killed).toBe(true)
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
