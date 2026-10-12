import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { until, within } from '../helpers/hang-budget'
import { FakeChild, GatedChild, exitingChild, fakeSpawn, loadingSidecar } from '../helpers/fake-sidecar'
import { E5Embedder } from '../../src/main/services/embeddings/e5'
import { isEmbedderError } from '../../src/main/services/embeddings/errors'
import { approxTokenCount } from '../../src/main/services/ingestion/chunker'
import { createSelectedEmbedder } from '../../src/main/services/embeddings/factory'
import { isEngineCannotRunError, resetEngineProblemsForTest } from '../../src/main/services/runtime/engine-load'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'

const base = {
  id: 'multilingual-e5-small-q8',
  binPath: '/bin/llama-server',
  modelPath: '/models/e5.gguf',
  findPort: async () => 52000,
  healthIntervalMs: 1,
  // The fake server returns 2-dim vectors; declare that so the width guard accepts them.
  dimensions: 2
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

  it('spawns the embeddings sidecar lazily, once, reuses it, and stop() kills it', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([[1, 0]]) })
    expect(calls.length).toBe(0) // not started until the first embed
    await embedder.embed(['a'])
    await embedder.embed(['b'])
    expect(calls.length).toBe(1) // reused, not re-spawned
    await embedder.stop()
    expect(children[0]!.killed).toBe(true)
  })

  // M7 (audit round 4): chunk sizing is approx tokens but the sidecar context is real
  // BPE tokens — oversize inputs overflowed the context and failed the whole document,
  // and all (up to 1000) chunks went out as ONE request with no timeout.
  //
  // Regression (HTTP 500 on a German translation import): the embedder is the MULTILINGUAL
  // E5, and subword-heavy languages (German ~2 real tokens/word) and space-less scripts
  // (CJK — counted ~1 token/CHAR) cost far more real BPE tokens than a naive word split
  // implies. A word-count truncation let those inputs stay over the 512-token context, so
  // the sidecar 500'd and the whole materialized translation failed to import. Truncation
  // is now measured by approxTokenCount against a real-BPE safety factor.
  it.each([
    { shape: 'long prose', input: Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' '), head: 'word0 word1' },
    // The case a word split collapses to "1 word".
    { shape: 'a glued space-less run', input: 'Donaudampfschifffahrtsgesellschaftskapitän'.repeat(60), head: 'Donaudampf' },
    { shape: 'a CJK run', input: '東'.repeat(2000), head: '東東' }
  ])('truncates $shape to the embedder context budget before sending (M7)', async ({ input, head }) => {
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
    await embedder.embed([input, 'short text'])
    await embedder.stop()

    const sent = bodies[0].input
    // The sent head fits the approx-token budget, so its real-token cost stays under ctx.
    expect(approxTokenCount(sent[0])).toBeLessThanOrEqual(Math.floor(512 / 2.2))
    expect(sent[0].startsWith(head)).toBe(true) // the chunk's head is kept
    expect(sent[1]).toBe('short text') // short inputs pass through untouched
  })

  it('splits large inputs into bounded batches and maps every vector back to its input across batch boundaries', async () => {
    const bodies: Array<{ input: string[] }> = []
    const batchFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      bodies.push(body)
      // Encode each input's own number (`text N`) into its vector's direction, which survives
      // L2 normalization, so every vector can be traced back to the input it belongs to.
      const data = body.input.map((t, i) => ({ embedding: [1, Number(t.split(' ')[1])], index: i }))
      return { ok: true, status: 200, json: async () => ({ data }) } as Response
    }) as typeof fetch

    const embedder = new E5Embedder({ ...base, batchSize: 3, spawn: fakeSpawn().spawn, fetchImpl: batchFetch })
    const texts = Array.from({ length: 7 }, (_, i) => `text ${i}`)
    const vectors = await embedder.embed(texts)
    await embedder.stop()

    expect(bodies.map((b) => b.input.length)).toEqual([3, 3, 1]) // bounded batches
    expect(bodies.flatMap((b) => b.input)).toEqual(texts) // every input sent once, in order
    expect(vectors).toHaveLength(7)
    expect(vectors.map((v) => Math.round(v[1] / v[0]))).toEqual([0, 1, 2, 3, 4, 5, 6])
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
    const { spawn, children } = fakeSpawn()
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
    await until(() => health.release !== null, 'the lazy start polling /health')

    const stopPromise = embedder.stop() // app quits while the sidecar is still starting
    health.release!()
    await stopPromise
    await embedPromise.catch(() => undefined) // the embed may fail; no-orphan is the point

    expect(children[0]!.killed).toBe(true)
    // The stopped flag must also block a later embed from resurrecting the sidecar.
    await expect(embedder.embed(['b'])).rejects.toThrow(/stopped/)
  })

  // #635: a document question that finds the sidecar stopped starts it, and its Stop used to reach
  // only the request after the start — so a Stop during a start that hung waited out the 180 s
  // health budget. The question now stops waiting at once; the start goes on for the import
  // embedding (with no signal, as ingestion does) that shares it.
  it('a Stop during a hung cold start ends the question at once; an import sharing the start still embeds (#635)', async () => {
    const { spawn, calls, children } = fakeSpawn()
    // This llama-server stays loading (/health 503) until `state.loaded`.
    const { fetchImpl, state } = loadingSidecar(embedFetch([[3, 4]]))
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })

    const stop = new AbortController()
    const question = embedder.embed(['question'], { signal: stop.signal })
    await until(() => state.probes > 0, 'the cold start polling /health')
    const importing = embedder.embed(['chunk']) // joins the same start
    // The chat's own reason (`endedEarlyAbortReason('user')`) is what a real Stop carries.
    const reason = new DOMException('Stopped by the user', 'AbortError')
    stop.abort(reason)
    // The question's own reason, untouched — the chat's Stop path, never a search-model failure.
    expect(await within(question.catch((e: unknown) => e), 'the Stop ending the wait for the start')).toBe(reason)

    state.loaded = true
    // The start was not cancelled: the import's embed lands on it.
    const [v] = await importing
    expect(children[0]!.killed).toBe(false)
    expect(v[0]).toBeCloseTo(0.6, 6)
    expect(calls.length).toBe(1) // one start, shared
    expect(embedder.isLoaded()).toBe(true)
    await embedder.stop()
  })

  it('a caller stopped before the embed starts no sidecar (#635)', async () => {
    const { spawn, calls } = fakeSpawn()
    const served = embedFetch([[1, 0]])
    // Honours the request signal as real fetch does, so the request itself could never serve a
    // stopped caller: what is under test is only whether a sidecar gets started for it.
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return served(url, init)
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
    const reason = new DOMException('Stopped by the user', 'AbortError')
    await expect(embedder.embed(['question'], { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(calls.length).toBe(0)
    await embedder.stop()
  })

  // Phase 21 fix: lockWorkspace used to call stop(), whose latch is permanent — every
  // post-lock/unlock embed then failed with "Embedder is stopped". The lock path now
  // suspends instead: the sidecar dies (its memory held chunk text) but restarts lazily.
  it('suspend() stops the sidecar but allows a lazy restart (workspace-lock path)', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([[1, 0]]) })
    await embedder.embed(['a'])
    await embedder.suspend()
    expect(children[0].killed).toBe(true)
    const vectors = await embedder.embed(['b']) // lazily restarts a fresh sidecar
    expect(vectors).toHaveLength(1)
    expect(calls.length).toBe(2)
    await embedder.stop()
  })

  // #634: the start failure is also what every document row of the session stores (latched), and
  // llama-server's stderr names the weight file by absolute path. These lines are the real b9849
  // `llama-server` given a truncated copy of the e5 GGUF (DesktopDiT, 2026-10-07), path shortened.
  it('latches a failed start (fail fast, one spawn) as a path-free start failure, and clears the latch on suspend()', async () => {
    const weightPath = 'D:\\HilbertRaum\\models\\embeddings\\multilingual-e5-small-q8.gguf'
    // The server dies immediately: a corrupt/incomplete GGUF.
    const { spawn, calls } = fakeSpawn(() =>
      exitingChild(
        1,
        [
          `0.00.214.130 I srv    load_model: loading model '${weightPath}'`,
          "0.00.273.164 E llama_model_load: error loading model: tensor 'token_embd.weight' data is not within the file bounds, model is corrupted or incomplete",
          `0.00.333.627 E cmn  common_init_: failed to load model '${weightPath}'`,
          '0.00.334.509 E srv  llama_server: exiting due to model loading error',
          ''
        ].join('\n')
      )
    )
    const embedder = new E5Embedder({
      ...base,
      spawn,
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    })
    const first = await embedder.embed(['a']).catch((e: unknown) => e)
    expect(isEmbedderError(first) && first.kind).toBe('start')
    expect((first as Error).message).not.toContain('HilbertRaum') // no part of the path
    expect(await embedder.embed(['a']).catch((e: unknown) => e)).toBe(first) // the latched error
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
    // /health answers 503 while the port is contended (loadingSidecar), so waitForHealthy observes
    // the bind-race exit (a 200 here would mask it). Once the port is free it serves ok.
    const { fetchImpl, state } = loadingSidecar(embedFetch([[1, 0]]))
    // A port-bind race: stderr reports EADDRINUSE and the child exits before health.
    const { spawn, calls } = fakeSpawn(() =>
      state.loaded ? new FakeChild() : exitingChild(1, 'error: bind: address already in use\n')
    )
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })

    // The doubly-unlucky startup: BOTH the initial start and its single bind-retry lose the port.
    // #634: transient, so it reads `failed` (try again), never "could not start, check the files".
    await expect(embedder.embed(['a'])).rejects.toMatchObject({ name: 'EmbedderError', kind: 'failed' })
    expect(calls.length).toBe(2) // one start + one bind-retry, both raced — NOT a permanent fault

    // The latch must NOT be armed for a transient race: the next embed re-attempts a fresh start
    // (it does not throw a cached error). The port is now free, so it starts and embeds.
    state.loaded = true
    const [v] = await embedder.embed(['b'])
    expect(Array.from(v)).toEqual([1, 0])
    expect(calls.length).toBe(3) // re-spawned a fresh start, rather than fast-failing on the latch
    await embedder.stop()
  })

  // #244 + #634: a lock during a cold start aborts the start; the embed waiting on it ends as
  // `interrupted` (the row's "re-index" copy), never as the `start` failure that points at the model files.
  it('a suspend() during a cold start ends the waiting embed as interrupted, never as a start failure (#244, #634)', async () => {
    const { spawn, children } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(embedFetch([[1, 0]]))
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
    const first = embedder.embed(['a']).catch((e: unknown) => e)
    await until(() => state.probes > 0, 'the cold start polling /health')
    await embedder.suspend()
    expect(await first).toMatchObject({ name: 'EmbedderError', kind: 'interrupted' })
    expect(children[0]!.killed).toBe(true)
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
    const { spawn, calls, children } = fakeSpawn(() => new GatedChild())
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
    await until(() => firstHealth.release !== null, 'start1 parked on /health')
    expect(children.length).toBe(1)

    const suspendP = embedder.suspend() // teardown: tearingDown=true, awaits this.starting (start1)
    // Let teardown register its await on start1: one macrotask hop over a pure microtask chain —
    // deterministic; a lost race only weakens the interleave, never the assertions (the `killed`
    // poll below is the real gate) (TS-1: justified fixed sleep).
    await new Promise((r) => setTimeout(r, 1))

    firstHealth.release!() // start1 resolves → this.server set → teardown advances to server.stop()
    // teardown calls child1.kill() (exit gated) then PARKS — wait until that observable kill happens.
    await until(() => children[0]!.killed, 'the teardown killing child1')

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
    const { spawn, children } = fakeSpawn() // FakeChild.kill() emits exit on a microtask → suspend completes fast
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
      (e: unknown) => e
    )
    await until(() => gate.release !== null, 'batch 1 in flight') // parked

    await embedder.suspend() // teardown runs to completion: kills the child, nulls this.server
    expect(children[0]!.killed).toBe(true)

    gate.release!() // batch 1 resolves → loop advances → batch 2 re-check fires
    const result = await embedP

    // Clean, recognizable cancellation — NOT "llama-server is not started" / a count mismatch.
    // #634: typed as an interruption, so the document row reads "interrupted", not a failure.
    expect(result).toMatchObject({ name: 'EmbedderError', kind: 'interrupted' })
    expect((result as Error).message).toMatch(/suspending|locking/)
    expect(embedCalls).toBe(1) // the second batch never issued a request to the dead sidecar
    await embedder.stop()
  })

  // #634: the usual lock mid-import — one batch, in flight when the teardown kills the sidecar, so
  // undici ends the request ("terminated"). It used to reach the document row as that raw word.
  it('a lock that kills the sidecar under an in-flight request ends the embed as interrupted (#634)', async () => {
    const { spawn, children } = fakeSpawn()
    let endRequest: ((err: Error) => void) | null = null
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      return await new Promise<Response>((_resolve, reject) => (endRequest = reject))
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
    const embedP = embedder.embed(['a']).catch((e: unknown) => e)
    await until(() => endRequest !== null, 'the request in flight')
    // The kill closes the request's socket — what a real sidecar's death does to undici. (The child
    // exists once the request is in flight.)
    const child = children[0]!
    const kill = child.kill.bind(child)
    child.kill = () => {
      endRequest?.(new TypeError('terminated'))
      return kill()
    }
    await embedder.suspend()
    expect(await embedP).toMatchObject({ name: 'EmbedderError', kind: 'interrupted' })
    await embedder.stop()
  })

  // #634: a sidecar that died on its own after it was healthy stayed `this.server`, so every later
  // embed went to the dead port ("fetch failed") until a lock/unlock — the row's Try again failed.
  it('a sidecar that crashes is started again on the next embed; the request it cut off failed (#634)', async () => {
    let alive = false
    const { spawn, children } = fakeSpawn(() => {
      alive = true
      return new FakeChild()
    })
    const parked = { reject: null as null | ((err: Error) => void) }
    let park = false
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (!alive) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (park) return await new Promise<Response>((_resolve, reject) => (parked.reject = reject))
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 0], index: 0 }] }) } as Response
    }) as typeof fetch
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl })
    await embedder.embed(['warm-up'])

    park = true
    const cutOff = embedder.embed(['a']).catch((e: unknown) => e)
    await until(() => parked.reject !== null, 'the request parked')
    // The crash: the process exits on its own, and its socket closes under the request.
    alive = false
    children[0]!.crash(3221225477)
    parked.reject!(new TypeError('terminated'))
    // A crash is not a lock: the request failed, it was not interrupted.
    expect(await cutOff).toMatchObject({ name: 'EmbedderError', kind: 'failed' })

    park = false
    const [v] = await embedder.embed(['b'])
    expect(Array.from(v)).toEqual([1, 0])
    expect(children.length).toBe(2) // a fresh sidecar, not the dead one
    await embedder.stop()
  })

  // #475: the single-flight teardown pass `reranker/llama.ts` has had since Wave 8 ruling (c)(i)
  // (pinned the same way in reranker-wave8.test.ts). Before it, an overlapping suspend()/stop() saw
  // `this.server` already nulled, ran its own empty teardown, settled at once and cleared `tearingDown`
  // in its own `finally` while the first caller's kill was still in flight.
  it.each([{ joiner: 'suspend' as const }, { joiner: 'stop' as const }])(
    '#475: an overlapping $joiner() joins the in-flight suspend() pass and settles only after the shared kill',
    async ({ joiner }) => {
      const { spawn, children } = fakeSpawn(() => new GatedChild())
      const embedder = new E5Embedder({ ...base, spawn, fetchImpl: embedFetch([[1, 0]]) })
      await embedder.embed(['a'])
      const suspendP = embedder.suspend()
      let joinerSettled = false
      const joinerP = embedder[joiner]().then(() => {
        joinerSettled = true
      })
      // One macrotask hop, no observable to gate on (justified): a joiner that did NOT join runs its own
      // empty teardown and settles within microtasks; the shared pass stays parked on the gated exit
      // (the kill's 2 s grace is far away).
      await new Promise((r) => setImmediate(r))
      expect(joinerSettled).toBe(false)
      children[0]!.releaseExit()
      await Promise.all([suspendP, joinerP])
      expect(children).toHaveLength(1)
      expect(children[0]!.killed).toBe(true)
      await embedder.stop()
    }
  )
})

// ---- #607: a response body that stalls after the headers --------------------------------------
//
// Each /v1/embeddings attempt runs under combineSignals(caller, 120 s). From the 2026-06-30
// context-overflow retry until #607 the embedder cleared it as soon as fetch() resolved — at the
// HEADERS — so the body read after it had no deadline of ours (only undici's 300 s idle limit), and
// the clear also detached the caller's signal, so a Stop never reached that read either. Real
// loopback socket, real fetch: whether an abort after the headers ends `res.json()` is undici's
// behaviour, not a fake's.

/**
 * A loopback `llama-server --embedding`: /health answers, and /v1/embeddings answers normally until
 * `stall(status)`. From then on it writes the status line, the headers and the first bytes of the
 * body, and nothing more — a sidecar that froze mid-response.
 */
async function stallingSidecar(): Promise<{
  port: number
  stall: (status: number) => void
  /** The client tore the stalled request's connection down. */
  closed: Promise<void>
  close: () => Promise<void>
}> {
  let stallStatus: number | null = null
  let markClosed!: () => void
  const closed = new Promise<void>((r) => (markClosed = r))
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end('{"status":"ok"}')
      return
    }
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      if (stallStatus === null) {
        const input = (JSON.parse(body) as { input: string[] }).input
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: input.map((_t, index) => ({ embedding: [3, 4], index })) }))
        return
      }
      res.on('close', markClosed)
      res.writeHead(stallStatus, { 'content-type': 'application/json', 'content-length': '4096' })
      res.write('{"')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    stall: (status) => {
      stallStatus = status
    },
    closed,
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    }
  }
}

describe('E5Embedder — a response body that stalls after the headers (#607)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** An embedder on the loopback sidecar, already started (one normal embed), plus a promise per
   *  request that resolves when real `fetch` hands its response — the headers — to the embedder. */
  async function startedEmbedder(port: number) {
    const headers: Array<() => void> = []
    const headersArrived = (): Promise<void> => new Promise<void>((r) => headers.push(r))
    const embedder = new E5Embedder({
      ...base,
      spawn: fakeSpawn().spawn,
      findPort: async () => port,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        const res = await fetch(url, init)
        if (String(url).endsWith('/v1/embeddings')) headers.shift()?.()
        return res
      }) as typeof fetch
    })
    const [v] = await embedder.embed(['warm-up'])
    expect(v[0]).toBeCloseTo(0.6, 6) // the sidecar answers normally before the stall
    return { embedder, headersArrived }
  }

  it.each([
    // The deadline — what a stall before the headers has always ended with. #634: typed, so the row
    // and the chat name the search model instead of showing "The operation timed out.".
    { status: 200, check: (e: Error) => expect(e).toMatchObject({ name: 'EmbedderError', kind: 'timeout' }) },
    // A stalled error body leaves the status alone (#594's rule for the chat error body).
    {
      status: 500,
      check: (e: Error) =>
        expect(e).toMatchObject({ name: 'EmbedderError', kind: 'failed', message: 'Embedding request failed: HTTP 500' })
    }
  ])('an HTTP $status response whose body stalls ends at exactly the 120 s request timeout and closes the connection', async ({ status, check }) => {
    const sidecar = await stallingSidecar()
    const { embedder, headersArrived } = await startedEmbedder(sidecar.port)
    sidecar.stall(status)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const arrived = headersArrived()
    let outcome: unknown = 'pending'
    const run = embedder.embed(['hello']).then(
      () => (outcome = 'embedded'),
      (e: unknown) => (outcome = e)
    )
    await within(arrived, 'the response headers arriving')
    await vi.advanceTimersByTimeAsync(119_999)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await within(run, 'the request deadline firing during the body read')
    check(outcome as Error)
    await within(sidecar.closed, 'the request connection closing')
    vi.useRealTimers()
    await embedder.stop()
    await sidecar.close()
  })

  it('a user Stop during a stalled body ends the embed at once, and the connection closes', async () => {
    const sidecar = await stallingSidecar()
    const { embedder, headersArrived } = await startedEmbedder(sidecar.port)
    sidecar.stall(200)
    const arrived = headersArrived()
    const stop = new AbortController()
    const run = embedder.embed(['hello'], { signal: stop.signal }).then(
      () => null,
      (e: unknown) => e
    )
    await within(arrived, 'the response headers arriving')
    stop.abort()
    const err = await within(run, 'the Stop ending the body read')
    expect((err as Error).name).toBe('AbortError') // the caller's own reason, not the timeout
    await within(sidecar.closed, 'the request connection closing')
    await embedder.stop()
    await sidecar.close()
  })
})

// ---- Embedder selector ----------------------------------------------------------

describe('createSelectedEmbedder', () => {
  // The no-binary / no-weights rungs are the shared ladder's (select-sidecar-backed.test.ts).
  it('falls back to the mock embedder (never null) when no embedding model is configured', () => {
    expect(createSelectedEmbedder({ rootPath: '/r', model: null }).id).toBe('mock-embedder')
  })

  it('selects the real E5 embedder (manifest id) when the drive holds the llama-server binary AND the weights', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-e5-select-'))
    mkdirSync(llamaServerDir(root), { recursive: true })
    writeFileSync(join(llamaServerDir(root), llamaServerBinaryName()), '') // never spawned: construction is lazy
    const modelPath = join(root, 'models', 'embeddings', 'e5.gguf')
    mkdirSync(join(root, 'models', 'embeddings'), { recursive: true })
    writeFileSync(modelPath, '')
    const e = createSelectedEmbedder({ rootPath: root, model: { id: 'multilingual-e5-small-q8', modelPath } })
    expect(e).toBeInstanceOf(E5Embedder)
    expect(e.id).toBe('multilingual-e5-small-q8')
  })
})

// #530: a program the OS loader refuses latches like any load fault (no retry storm, no raw loader
// line stored on every document), and "Check again" / an engine install re-arms it.
describe('E5Embedder — OS loader refusal (#530)', () => {
  afterEach(() => resetEngineProblemsForTest())

  const refusingFetch = (async () => {
    throw new Error('connection refused')
  }) as unknown as typeof fetch

  const loaderLine =
    '/media/someone/HR/runtime/llama.cpp/linux/llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'

  it('latches a loader refusal: embed rejects with EngineCannotRunError, no second spawn', async () => {
    const { spawn, calls } = fakeSpawn(() => exitingChild(127, loaderLine))
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: refusingFetch })
    const err = await embedder.embed(['hello']).catch((e: unknown) => e)
    expect(isEngineCannotRunError(err)).toBe(true)
    expect(calls.length).toBe(1)

    const again = await embedder.embed(['hello']).catch((e: unknown) => e)
    expect(isEngineCannotRunError(again)).toBe(true) // the latched error, rethrown
    expect(calls.length).toBe(1)
    await embedder.stop()
  })

  it('resetStartFailure() re-arms the latch: the next embed spawns again', async () => {
    const { spawn, calls } = fakeSpawn(() => exitingChild(127, loaderLine))
    const embedder = new E5Embedder({ ...base, spawn, fetchImpl: refusingFetch })
    await expect(embedder.embed(['hello'])).rejects.toThrow()
    expect(calls.length).toBe(1)
    embedder.resetStartFailure()
    await expect(embedder.embed(['hello'])).rejects.toThrow() // refused again, but it TRIED
    expect(calls.length).toBe(2)
    await embedder.stop()
  })
})
