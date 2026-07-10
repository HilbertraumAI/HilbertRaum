import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { E5Embedder } from '../../src/main/services/embeddings/e5'
import { approxTokenCount } from '../../src/main/services/ingestion/chunker'
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

  // RT-4: the embedding sidecar must raise --batch-size/--ubatch-size above the context so
  // multiple inputs of a 32-input request co-decode per physical batch instead of the 512
  // embedding-mode default processing them ~1 at a time. Mirrors the reranker's arg test.
  it('spawns with --embedding + CPU pin and a raised physical batch (RT-4)', async () => {
    const { spawn, calls } = fakeSpawn()
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([[3, 4]]) })
    await embedder.embed(['hello'])
    expect(calls).toHaveLength(1)
    const args = calls[0].args.join(' ')
    expect(args).toContain('--embedding')
    expect(args).toContain('--pooling mean')
    expect(args).toContain('--device none') // CPU-pinned
    expect(args).not.toContain('-ngl')
    // Physical batch raised to 2048 (> the 512 ctx) for multi-sequence throughput.
    expect(args).toContain('--batch-size 2048')
    expect(args).toContain('--ubatch-size 2048')
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

  // L3: the OpenAI embeddings schema makes `index` optional. Handle the two clean cases
  // (all-indexed → sort; none-indexed → trust array order) and reject a partial mix, which
  // would collapse the missing entries to 0 and silently misalign vectors↔chunks.
  it('trusts response array order when NO entry carries an index', async () => {
    const noIndexFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      // Deliberately omit `index`; the embedder must keep this exact order.
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] })
      } as Response
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn: fakeSpawn().spawn, fetchImpl: noIndexFetch })
    const [a, b] = await embedder.embed(['first', 'second'])
    expect(Array.from(a)).toEqual([1, 0])
    expect(Array.from(b)).toEqual([0, 1])
    await embedder.stop()
  })

  it('rejects a response that mixes indexed and unindexed entries (L3)', async () => {
    const mixedFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 0], index: 1 }, { embedding: [0, 1] }] })
      } as Response
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn: fakeSpawn().spawn, fetchImpl: mixedFetch })
    await expect(embedder.embed(['first', 'second'])).rejects.toThrow(/mixes indexed/)
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
    // Phase 15 (architecture.md GPU record §7, decided): the embedder is PINNED to CPU — the
    // Vulkan default build would otherwise auto-offload it into VRAM contention with
    // the chat model and expose ingestion to driver flakiness.
    expect(calls[0].args.join(' ')).toContain('--device none')
    expect(calls[0].args.join(' ')).not.toContain('-ngl')
    await embedder.stop()
    expect(child.killed).toBe(true)
  })

  // M7 (audit round 4): chunk sizing is approx tokens but the sidecar context is real
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
    const maxApproxTokens = Math.floor(512 / 2.2)
    // The sent head fits the approx-token budget, so its real-token cost stays under ctx.
    expect(approxTokenCount(sent[0])).toBeLessThanOrEqual(maxApproxTokens)
    expect(sent[0].startsWith('word0 word1')).toBe(true) // the chunk's head is kept
    expect(sent[1]).toBe('short text') // short inputs pass through untouched
  })

  // Regression (HTTP 500 on a German translation import): the embedder is the MULTILINGUAL
  // E5, and subword-heavy languages (German ~2 real tokens/word) and space-less scripts
  // (CJK — counted ~1 token/CHAR) cost far more real BPE tokens than a naive word split
  // implies. A word-count truncation let those inputs stay over the 512-token context, so
  // the sidecar 500'd and the whole materialized translation failed to import. Truncation
  // is now measured by approxTokenCount against a real-BPE safety factor.
  it('truncates subword-heavy and space-less inputs so they cannot overflow the context', async () => {
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
    // A glued, space-less run (the case a word split collapses to "1 word") and a long
    // CJK run — both far over a 512-token budget if not truncated by token cost.
    const noSpace = 'Donaudampfschifffahrtsgesellschaftskapitän'.repeat(60) // one giant "word"
    const cjk = '東'.repeat(2000)
    await embedder.embed([noSpace, cjk])
    await embedder.stop()

    const maxApproxTokens = Math.floor(512 / 2.2)
    for (const sent of bodies[0].input) {
      expect(approxTokenCount(sent)).toBeLessThanOrEqual(maxApproxTokens)
    }
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

  // M-C5: a caller "Stop" (opts.signal) must be plumbed into the loopback fetch so query
  // embedding aborts promptly, not only on the request timeout.
  it('forwards the caller abort signal to the embeddings request (aborts in flight)', async () => {
    const { spawn } = fakeSpawn()
    let seenSignal: AbortSignal | undefined
    const hangingFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      seenSignal = init?.signal ?? undefined
      // Never resolve on its own — only the aborted signal ends this request.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as typeof fetch

    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: hangingFetch })
    const controller = new AbortController()
    const embedPromise = embedder.embed(['hello'], { signal: controller.signal })
    // Deterministically wait until the embed request REACHED fetch (the signal was handed over)
    // before the user hits Stop — a fixed `sleep(1)` could fire before fetch under load (T5).
    // State-poll on the captured signal (the file's own idiom).
    while (!seenSignal) await new Promise((r) => setTimeout(r, 1))
    controller.abort()
    await expect(embedPromise).rejects.toThrow(/abort/i)
    // The signal handed to fetch fires when the caller aborts (combined with the timeout).
    expect(seenSignal?.aborted).toBe(true)
    await embedder.stop()
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

  // Empty/whitespace inputs are NOT sent to the sidecar (llama.cpp 400s on an empty input). They
  // get an all-zero vector and the request carries only the non-empty inputs, placed back in order.
  it('zero-vectors empty/whitespace inputs without sending them to the server', async () => {
    const { spawn } = fakeSpawn()
    const sentInputs: string[][] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (u.endsWith('/v1/embeddings')) {
        const body = JSON.parse(String(init?.body)) as { input: string[] }
        sentInputs.push(body.input)
        const data = body.input.map((_t, i) => ({ embedding: [1, 0], index: i }))
        return { ok: true, status: 200, json: async () => ({ data }) } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
    const out = await embedder.embed(['hello', '   ', '', 'world'])
    expect(out).toHaveLength(4)
    // Only the two non-empty inputs reached the sidecar, in order.
    expect(sentInputs).toEqual([['hello', 'world']])
    // The empty slots are all-zero vectors (cosine 0); the non-empty ones are normalized.
    expect(Array.from(out[1])).toEqual([0, 0])
    expect(Array.from(out[2])).toEqual([0, 0])
    expect(Array.from(out[0])).toEqual([1, 0])
    expect(Array.from(out[3])).toEqual([1, 0])
    await embedder.stop()
  })

  // A 4xx must carry the sidecar's REASON, not the JSON envelope — that message is what makes the
  // "Embedding request failed: HTTP 400" the user reported debuggable.
  it('extracts the error message (not the JSON envelope) from a non-OK body', async () => {
    const { spawn } = fakeSpawn()
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (u.endsWith('/v1/embeddings')) {
        return {
          ok: false,
          status: 400,
          // llama.cpp's OpenAI-shaped error envelope.
          text: async () =>
            JSON.stringify({ error: { code: 400, message: 'input is empty', type: 'invalid_request_error' } })
        } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
    const err = await embedder.embed(['x']).then(
      () => null,
      (e: unknown) => e as Error
    )
    expect(err?.message).toMatch(/HTTP 400 — input is empty/)
    expect(err?.message).not.toContain('{') // no raw JSON dumped at the user
    expect(err?.message).not.toContain('"error"')
    await embedder.stop()
  })

  // A context overflow (the chunk still tokenizes over E5's hard 512 after truncation) is recovered
  // by halving this batch's budget and retrying — the chunk's head embeds instead of failing the doc.
  it('re-truncates and retries on a context-overflow 400, then succeeds', async () => {
    const { spawn } = fakeSpawn()
    const sent: string[] = []
    let attempts = 0
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (u.endsWith('/v1/embeddings')) {
        const body = JSON.parse(String(init?.body)) as { input: string[] }
        sent.push(body.input[0])
        attempts += 1
        if (attempts === 1) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                error: {
                  code: 400,
                  message: 'input (623 tokens) is larger than the max context size (512 tokens). skipping',
                  type: 'exceed_context_size_error',
                  n_prompt_tokens: 623,
                  n_ctx: 512
                }
              })
          } as Response
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: body.input.map((_t, i) => ({ embedding: [1, 0], index: i })) })
        } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
    const longText = 'lorem ipsum dolor sit amet '.repeat(200)
    const [v] = await embedder.embed([longText])
    expect(Array.from(v)).toEqual([1, 0]) // succeeded after the retry
    expect(attempts).toBe(2)
    expect(sent[1].length).toBeLessThan(sent[0].length) // retry sent a harder-truncated input
    await embedder.stop()
  })

  // Dev coverage measurement (HR_EMBED_COVERAGE=1): the embedder tokenizes the FULL chunk AND the
  // truncated text it actually sends, via the sidecar's /tokenize, to size the upstream chunker.
  it('tokenizes full vs sent text via /tokenize when coverage measurement is enabled', async () => {
    const { spawn } = fakeSpawn()
    const tokenizeContents: string[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (u.endsWith('/tokenize')) {
        const body = JSON.parse(String(init?.body)) as { content: string }
        tokenizeContents.push(body.content)
        // Fake tokenizer: 1 token per whitespace word — enough to exercise the measurement path.
        return { ok: true, status: 200, json: async () => ({ tokens: body.content.split(/\s+/) }) } as Response
      }
      if (u.endsWith('/v1/embeddings')) {
        const body = JSON.parse(String(init?.body)) as { input: string[] }
        return { ok: true, status: 200, json: async () => ({ data: body.input.map((_t, i) => ({ embedding: [1, 0], index: i })) }) } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
    process.env.HR_EMBED_COVERAGE = '1'
    try {
      const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
      await embedder.embed(['alpha beta', 'gamma'])
      // Two inputs × (full + sent) = four /tokenize calls; the chunk text is among them.
      expect(tokenizeContents).toContain('alpha beta')
      expect(tokenizeContents.length).toBe(4)
      await embedder.stop()
    } finally {
      delete process.env.HR_EMBED_COVERAGE
    }
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

  // Phase 21 fix: lockWorkspace used to call stop(), whose latch is permanent — every
  // post-lock/unlock embed then failed with "Embedder is stopped". The lock path now
  // suspends instead: the sidecar dies (its memory held chunk text) but restarts lazily.
  it('suspend() stops the sidecar but allows a lazy restart (workspace-lock path)', async () => {
    const calls: Array<{ args: string[] }> = []
    const children: FakeChild[] = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      children.push(child)
      return child
    }
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([[1, 0]]) })
    await embedder.embed(['a'])
    await embedder.suspend()
    expect(children[0].killed).toBe(true)
    const vectors = await embedder.embed(['b']) // lazily restarts a fresh sidecar
    expect(vectors).toHaveLength(1)
    expect(calls.length).toBe(2)
    await embedder.stop()
  })

  it('latches a failed start (fail fast, one spawn) and clears the latch on suspend()', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      // The server dies immediately (e.g. a corrupt/incompatible GGUF).
      queueMicrotask(() => child.emit('exit', 1, null))
      return child
    }
    const embedder = new E5Embedder({
      ...base,
      spawn,
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    })
    await expect(embedder.embed(['a'])).rejects.toThrow()
    await expect(embedder.embed(['a'])).rejects.toThrow()
    // One spawn total: the failed-start latch prevents a health-timeout stall per embed.
    expect(calls.length).toBe(1)
    // Unlike the reranker, suspend() (workspace lock) clears the latch so the user can
    // replace the weight file and retry imports without restarting the app.
    await embedder.suspend()
    await expect(embedder.embed(['a'])).rejects.toThrow()
    expect(calls.length).toBe(2)
    await embedder.stop()
  })

  // F4 (post-merge audit): a TRANSIENT port-bind race must NOT arm the failed-start latch.
  // LlamaServer.start retries a bind race only ONCE (REL-1); if the embedder loses the port
  // twice during the near-simultaneous chat+embedder+reranker+vision startup, start() throws a
  // bind-class error. The latch is for a PERMANENT fault (a bad GGUF) — arming it for a bind
  // race silently disabled ALL imports for the session until lock/unlock. With the fix the
  // latch stays null, so the next embed() re-attempts a fresh start on a new port.
  it('does NOT latch a transient bind-race; a later embed retries on a fresh port (F4)', async () => {
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
    // /health stays unhealthy (503) while the port is contended, so waitForHealthy loops until it
    // observes the bind-race exit (a 200 here would mask it). Once the port is free it serves ok.
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: portFree, status: portFree ? 200 : 503 } as Response
      if (u.endsWith('/v1/embeddings')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 0], index: 0 }] }) } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })

    // The doubly-unlucky startup: BOTH the initial start and its single bind-retry lose the port.
    await expect(embedder.embed(['a'])).rejects.toThrow(/address already in use/)
    expect(calls.length).toBe(2) // one start + one bind-retry, both raced — NOT a permanent fault

    // The latch must NOT be armed for a transient race: the next embed re-attempts a fresh start
    // (it does not throw a cached error). The port is now free, so it starts and embeds.
    portFree = true
    const [v] = await embedder.embed(['b'])
    expect(Array.from(v)).toEqual([1, 0])
    expect(calls.length).toBe(3) // re-spawned a fresh start, rather than fast-failing on the latch
    await embedder.stop()
  })

  // L4: suspend() must clear the failed-start latch AFTER teardown, not before. If a
  // first-start is in flight when suspend() runs, teardown awaits it; should that start
  // then FAIL, it re-arms `startFailed`. Clearing the latch last guarantees a post-suspend
  // embed() gets a fresh attempt rather than throwing the stale failure.
  it('suspend() clears the latch even when an in-flight start fails during teardown (L4)', async () => {
    let attempt = 0
    const spawn = (): ChildProcessLike => new FakeChild()
    // First start: hold /health, then fail (exit emitted by the test). Later starts: healthy.
    const health = { release: null as (() => void) | null }
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) {
        attempt++
        if (attempt === 1) {
          // First start stays in flight until the test releases it, then rejects (sidecar died).
          await new Promise<void>((resolve) => (health.release = resolve))
          throw new Error('connection refused')
        }
        return { ok: true, status: 200 } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 0], index: 0 }] })
      } as Response
    }) as typeof fetch

    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
    const first = embedder.embed(['a']) // first start goes in flight, polling /health
    while (!health.release) await new Promise((r) => setTimeout(r, 1))

    const suspendPromise = embedder.suspend() // teardown awaits the in-flight start
    health.release!() // the in-flight start now fails DURING teardown's await
    await suspendPromise
    await first.catch(() => undefined)

    // If the latch had been cleared before teardown, the racing failure would have re-armed
    // it and this embed would throw the stale 'connection refused'. Clearing last → fresh start.
    const [v] = await embedder.embed(['b'])
    expect(Array.from(v)).toEqual([1, 0])
    await embedder.stop()
  })

  // F19 (full-audit-2026-06-29-postmerge): suspend() (workspace lock) sets no `stopped`-style latch,
  // so a suspend() that interleaves with a concurrent embed() could tear down the OLD sidecar while a
  // fresh ensureStarted SPAWNS and RETAINS a new one — surviving the lock with chunk-text-derived
  // state in RAM. The `tearingDown` guard gives suspend() the orphan protection stop() gets from
  // `stopped`. Deterministic interleave: a gated-exit child PARKS teardown's server.stop(), and a
  // concurrent embed() fires in that window. TEETH: drop the `tearingDown` guard → the concurrent
  // embed spawns child2, it is never killed, and `calls.length` is 2 → both assertions red.
  it('suspend() does not retain a sidecar spawned by a concurrent embed during teardown (F19)', async () => {
    // kill() marks `killed` but HOLDS the 'exit' event until releaseExit(), so server.stop() parks.
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
    // The FIRST start's /health is gated (the start stays in flight); later starts are healthy at once.
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
      if (u.endsWith('/v1/embeddings')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 0], index: 0 }] }) } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch

    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })

    // start1 in flight, parks on the gated first /health. Under the guard embed1 itself rejects
    // (its post-start re-check sees tearingDown), so attach the catch up front to avoid an
    // unhandled rejection while the test orchestrates the interleave.
    const embed1 = embedder.embed(['a']).catch(() => undefined)
    while (!firstHealth.release) await new Promise((r) => setTimeout(r, 1))
    expect(children.length).toBe(1)

    const suspendP = embedder.suspend() // teardown: tearingDown=true, awaits this.starting (start1)
    // Let teardown register its await on start1: one macrotask hop over a pure microtask chain —
    // deterministic; a lost race only weakens the interleave, never the assertions (the `killed`
    // poll below is the real gate) (TS-1: justified fixed sleep).
    await new Promise((r) => setTimeout(r, 1))

    firstHealth.release!() // start1 resolves → this.server set → teardown advances to server.stop()
    // teardown calls child1.kill() (exit gated) then PARKS — wait until that observable kill happens.
    while (!children[0].killed) await new Promise((r) => setTimeout(r, 1))

    // THE RACE: a concurrent embed in the teardown window. With the F19 guard ensureStarted refuses
    // (tearingDown); without it, it spawns child2 and retains it past the lock.
    const embed2 = embedder.embed(['b']).then(
      () => 'ok',
      () => 'rejected'
    )
    // DX-6 (Phase 7): deterministic in place of a fixed 25 ms "nothing spawned" settle. Under the
    // F19 tearingDown guard embed2's ensureStarted REFUSES in the teardown window, so embed2 settles
    // to 'rejected' on its own — no wall-clock wait. A regression that spawned child2 would instead
    // resolve 'ok' (and bump calls.length below), so awaiting the outcome is the assertion.
    expect(await embed2).toBe('rejected')

    children[0].releaseExit() // unblock teardown's server.stop()
    await suspendP
    await embed1

    // No sidecar survives the lock: only child1 was ever spawned, and it was killed.
    expect(calls.length).toBe(1)
    for (const c of children) expect(c.killed).toBe(true)
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

  // REL-3 (full-audit-2026-06-29 follow-up): embed() captures `server` ONCE then loops batches. A
  // suspend() (workspace lock) mid-loop — racing a large ingestion's many batches — nulls the
  // sidecar, so the NEXT batch used to throw the runtime's "llama-server is not started" (a
  // confusing per-document error). The per-batch re-check surfaces a clean cancellation instead.
  // Deterministic interleave: batchSize=1 over two inputs; the FIRST batch's /v1/embeddings is
  // gated, suspend() runs to completion in that window (nulling this.server), then the gate releases
  // so the loop advances to the second batch's re-check. TEETH: drop the re-check → batch 2 fetches
  // the dead captured server → "llama-server is not started" (not the cancellation class) → red.
  it('embed() re-checks teardown between batches and cancels cleanly on a mid-loop suspend (REL-3)', async () => {
    const { spawn, child } = fakeSpawn() // FakeChild.kill() emits exit on a microtask → suspend completes fast
    const gate = { release: null as null | (() => void) }
    let embedCalls = 0
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (u.endsWith('/v1/embeddings')) {
        embedCalls += 1
        if (embedCalls === 1) await new Promise<void>((r) => (gate.release = r)) // park batch 1
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: [1, 0], index: 0 }] })
        } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch

    const embedder = new E5Embedder({ ...base, spawn, fetchImpl, batchSize: 1 })
    const embedP = embedder.embed(['a', 'b']).then(
      () => 'resolved',
      (e: Error) => e.message
    )
    while (!gate.release) await new Promise((r) => setTimeout(r, 1)) // batch 1 in flight (parked)

    await embedder.suspend() // teardown runs to completion: kills the child, nulls this.server
    expect(child.killed).toBe(true)

    gate.release!() // batch 1 resolves → loop advances → batch 2 re-check fires
    const result = await embedP

    // Clean, recognizable cancellation — NOT "llama-server is not started" / a count mismatch.
    expect(result).toMatch(/suspending|locking/)
    expect(result).not.toMatch(/not started/)
    expect(embedCalls).toBe(1) // the second batch never issued a request to the dead sidecar
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
