import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  readChatSSE,
  RuntimeUnresponsiveError,
  isRuntimeUnresponsiveError,
  ChatStreamError,
  isChatStreamError
} from '../../src/main/services/runtime/llama'

// CB-5 — the completion stream had no inactivity timeout: a sidecar that HANGS (GPU stall, deadlocked
// slot) left `readChatSSE` awaiting the next SSE read forever, wedging the conversation in
// `inFlightStreams`. A two-phase idle watchdog now races each `reader.read()` against an injectable
// budget (prefill, then a tighter inter-chunk budget) and rejects with `RuntimeUnresponsiveError`.

const enc = new TextEncoder()
// Fixture provenance (CODE-9/TQ-6, full-audit 2026-07-11): these SSE frames are hand-authored to the
// llama-server output shape — `choices[].delta.content` for answer tokens,
// `choices[].delta.reasoning_content` for `--reasoning-format deepseek` thinking deltas. The content
// shape is pinned by real captures on the current pin b11146 (`chat-sse-timings-b11146.txt`, #512;
// `vision/vision-sse-b11146.txt`, #518); the reasoning shape has no capture yet — re-verify it against
// a captured smoke transcript on a runtime pin bump (BUILD_STATE §5 TS-3 inventory).
const chatChunk = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const reasoningChunk = (reasoning_content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content } }] })}\n\n`
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A producer that enqueues each frame after `gapMs`, modelling a slow-but-alive stream. */
function pacedStream(frames: string[], gapMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const f of frames) {
        await delay(gapMs)
        controller.enqueue(enc.encode(f))
      }
      controller.close()
    }
  })
}

describe('readChatSSE — CB-5 idle watchdog', () => {
  it('rejects RuntimeUnresponsiveError when no chunk arrives within the prefill budget', async () => {
    const stream = new ReadableStream<Uint8Array>({ start() { /* never enqueues, never closes */ } })
    const idle = { prefillMs: 20, progressMs: 420_000, streamMs: 10 }
    const iterate = (async () => {
      for await (const _t of readChatSSE(stream, undefined, undefined, undefined, idle)) {
        /* the stream never produces a token */
      }
    })()
    const err = await iterate.then(
      () => null,
      (e: unknown) => e
    )
    expect(isRuntimeUnresponsiveError(err)).toBe(true)
    expect(err).toBeInstanceOf(RuntimeUnresponsiveError)
  })

  it('rejects only AFTER the first chunk lands and the tighter STREAM budget then elapses', async () => {
    // First chunk arrives fast (well within prefill), then the sidecar goes silent past streamMs.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(chatChunk('hello')))
        // never enqueues again, never closes ⇒ the inter-chunk (stream) budget must fire.
      }
    })
    const idle = { prefillMs: 1000, progressMs: 420_000, streamMs: 20 }
    const out: string[] = []
    const err = await (async () => {
      for await (const t of readChatSSE(stream, undefined, undefined, undefined, idle)) out.push(t)
      return null
    })().catch((e: unknown) => e)
    expect(out).toEqual(['hello']) // the first chunk streamed through
    expect(isRuntimeUnresponsiveError(err)).toBe(true) // the tighter stream budget tripped, not prefill
  })

  it('iterates a steady stream clean — the idle timer RESETS per chunk (total time exceeds one budget)', async () => {
    // Each 15 ms gap is < streamMs (30), but three of them (45 ms) exceed a single budget: a clean
    // run proves the timer is re-armed every read rather than counting from the start.
    const stream = pacedStream([chatChunk('a'), chatChunk('b'), chatChunk('c'), 'data: [DONE]\n\n'], 15)
    const idle = { prefillMs: 50, progressMs: 420_000, streamMs: 30 }
    const out: string[] = []
    for await (const t of readChatSSE(stream, undefined, undefined, undefined, idle)) out.push(t)
    expect(out.join('')).toBe('abc')
  })

  it('a long reasoning ("thinking") phase counts as chunks and does NOT trip the watchdog', async () => {
    // Reasoning deltas (no answer token) keep resetting the timer, then the answer arrives.
    const stream = pacedStream(
      [reasoningChunk('think 1'), reasoningChunk('think 2'), reasoningChunk('think 3'), chatChunk('done')],
      15
    )
    const idle = { prefillMs: 50, progressMs: 420_000, streamMs: 30 }
    const reasoning: string[] = []
    const out: string[] = []
    for await (const t of readChatSSE(stream, undefined, (d) => reasoning.push(d), undefined, idle)) {
      out.push(t)
    }
    expect(reasoning).toEqual(['think 1', 'think 2', 'think 3'])
    expect(out.join('')).toBe('done')
  })

  it('a user Stop (signal abort) rejects with AbortError first — a hang is NEVER converted to it', async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({ start() { /* never enqueues */ } })
    const idle = { prefillMs: 1000, progressMs: 420_000, streamMs: 1000 }
    const iterate = (async () => {
      for await (const _t of readChatSSE(stream, controller.signal, undefined, undefined, idle)) {
        /* none */
      }
    })()
    controller.abort()
    const err = await iterate.then(
      () => null,
      (e: unknown) => e
    )
    expect((err as Error).name).toBe('AbortError')
    expect(isRuntimeUnresponsiveError(err)).toBe(false)
  })
})

// #594 — both pinned builds write an SSE comment (`:`) after every ~30 s of silence
// (`--sse-ping-interval`, default 30; b9849 too, measured in #598). Captured 2026-10-05 on the b11146
// CPU build (scratch capture, not committed): `:` at 30.26 / 60.54 / 90.79 s … through a 320.9 s
// prefill. A ping is the server's HTTP thread, not the model, so once tokens flow it must not re-arm
// the stream budget — it did, because the timer was re-armed per READ. Fake timers: no real pacing.
/** The production budgets (`DEFAULT_IDLE` in llama.ts). */
const PINNED = { prefillMs: 120_000, progressMs: 420_000, streamMs: 30_000 }

/** A body the test writes into, like the sidecar's socket. */
function sidecarBody(): { body: ReadableStream<Uint8Array>; write: (frame: string) => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    }
  })
  return { body, write: (frame) => controller.enqueue(enc.encode(frame)) }
}

describe('readChatSSE — SSE comment pings in the stream phase (#594)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a ping after the first token does not reset the stream budget', async () => {
    vi.useFakeTimers()
    const { body, write } = sidecarBody()
    const out: string[] = []
    let outcome: unknown = 'pending'
    void (async () => {
      for await (const t of readChatSSE(body, undefined, undefined, undefined, PINNED)) out.push(t)
    })().then(
      () => (outcome = 'ended'),
      (e: unknown) => (outcome = e)
    )
    write(chatChunk('hello'))
    await vi.advanceTimersByTimeAsync(20_000)
    write(': ping\n\n') // inside the budget: under the old per-read timer this bought 30 s more
    await vi.advanceTimersByTimeAsync(9_999)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(out).toEqual(['hello'])
    expect(isRuntimeUnresponsiveError(outcome)).toBe(true)
    expect((outcome as Error).message).toContain('30000ms') // names the budget, not the remainder
  })

  it('a model event split across reads counts as output from its first bytes', async () => {
    vi.useFakeTimers()
    const { body, write } = sidecarBody()
    const gen = readChatSSE(body, undefined, undefined, undefined, PINNED)
    write(chatChunk('hello'))
    expect((await gen.next()).value).toBe('hello')
    const next = gen.next()
    await vi.advanceTimersByTimeAsync(20_000)
    write(':\n\n') // 20 s of the 30 already spent waiting…
    await vi.advanceTimersByTimeAsync(9_000)
    write('data: {"choices":[{"delta":{"content":" wor') // …when the next event starts arriving
    await vi.advanceTimersByTimeAsync(5_000)
    write('ld"}}]}\n\n')
    expect((await next).value).toBe(' world')
    await gen.return(undefined)
  })

  it('a wall-clock step (NTP, a manual change) does not eat the stream budget', async () => {
    vi.useFakeTimers()
    const { body, write } = sidecarBody()
    const gen = readChatSSE(body, undefined, undefined, undefined, PINNED)
    write(chatChunk('hello'))
    expect((await gen.next()).value).toBe('hello')
    const next = gen.next()
    await vi.advanceTimersByTimeAsync(10_000)
    vi.setSystemTime(Date.now() + 60_000) // the wall clock jumps; monotonic time does not
    write(':\n\n')
    await vi.advanceTimersByTimeAsync(15_000)
    write(chatChunk(' world'))
    expect((await next).value).toBe(' world')
    await gen.return(undefined)
  })

  it('time the consumer spends between pulls is not counted against the stream budget', async () => {
    // The local API waits up to 15 s on a slow client's drain between pulls; that is not the model.
    vi.useFakeTimers()
    const { body, write } = sidecarBody()
    const gen = readChatSSE(body, undefined, undefined, undefined, PINNED)
    write(chatChunk('a'))
    expect((await gen.next()).value).toBe('a')
    await vi.advanceTimersByTimeAsync(45_000) // the consumer holds the generator, not pulling
    const next = gen.next()
    await vi.advanceTimersByTimeAsync(29_000)
    write(chatChunk('b'))
    expect((await next).value).toBe('b')
    await gen.return(undefined)
  })
})

// #598 — before the first token both pinned builds keep pinging while the compute loop is wedged, so
// a ping proves only that the PROCESS lives. Prefill therefore has two clocks: any byte re-arms the
// 120 s process clock; only a `prompt_progress` event (requested via `return_progress`) or model
// output re-arms the 7 min compute clock. The real wedge, replayed from a b11146 capture, is pinned
// in chat-sse-progress-fixture.test.ts; these rows pin the clock rules the capture cannot reach.
describe('readChatSSE — prefill liveness: the process and compute clocks (#598)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // The b11146 progress event's shape (chat-sse-progress-b11146.txt): a role-only delta plus a
  // top-level `prompt_progress`.
  const progress = (processed: number): string =>
    `data: ${JSON.stringify({
      choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }],
      object: 'chat.completion.chunk',
      prompt_progress: { total: 6144, cache: 0, processed, time_ms: 0 }
    })}\n\n`
  const PING = ':\n\n'

  /** Replays `events` (absolute ms) into a reader on the production budgets, then waits `tailMs`. */
  async function replay(events: Array<[number, string]>, tailMs: number) {
    vi.useFakeTimers()
    const { body, write } = sidecarBody()
    const out: string[] = []
    let outcome: unknown = 'pending'
    let endedAt = -1
    const t0 = performance.now()
    void (async () => {
      for await (const t of readChatSSE(body, undefined, undefined, undefined, PINNED)) out.push(t)
    })().then(
      () => {
        outcome = 'ended'
        endedAt = performance.now() - t0
      },
      (e: unknown) => {
        outcome = e
        endedAt = performance.now() - t0
      }
    )
    let now = 0
    for (const [at, frame] of events) {
      await vi.advanceTimersByTimeAsync(at - now)
      now = at
      write(frame)
    }
    await vi.advanceTimersByTimeAsync(tailMs)
    return { out, outcome: () => outcome, endedAt: () => endedAt }
  }

  /** A ping every 30 s from `from` (exclusive) up to `to` (inclusive), as llama-server sends them. */
  const pings = (from: number, to: number): Array<[number, string]> => {
    const out: Array<[number, string]> = []
    for (let t = from + 30_000; t <= to; t += 30_000) out.push([t, PING])
    return out
  }

  it('the compute clock is per batch: 20 minutes of prefill, a progress event every 400 s, answer', async () => {
    const events: Array<[number, string]> = [[0, progress(0)]]
    for (let batch = 1; batch <= 3; batch++) {
      events.push(...pings((batch - 1) * 400_000, batch * 400_000 - 1), [batch * 400_000, progress(batch * 2048)])
    }
    events.push([1_200_500, chatChunk('Answer') + 'data: [DONE]\n\n'])
    const r = await replay(events, 0)
    expect(r.outcome()).toBe('ended')
    expect(r.out).toEqual(['Answer'])
  })

  it('a frozen process — not even a ping — still ends at the 120 s process clock, not the compute clock', async () => {
    const r = await replay([[0, progress(0)], [30_000, PING]], 150_000)
    expect(isRuntimeUnresponsiveError(r.outcome())).toBe(true)
    expect(r.endedAt()).toBe(150_000) // 120 s after the last byte
    expect((r.outcome() as Error).message).toContain('no data at all (pings included) for 120000ms')
  })

  it('only a progress event or model output re-arms the compute clock — not some other text-less frame', async () => {
    // A role-only chunk carries no progress: a wedged server that still wrote one must not look alive.
    const roleOnly = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: null } }] })}\n\n`
    const r = await replay([[0, progress(0)], ...pings(0, 190_000), [200_000, roleOnly], ...pings(200_000, 410_000)], 10_000)
    expect(isRuntimeUnresponsiveError(r.outcome())).toBe(true)
    expect(r.endedAt()).toBe(420_000) // 7 min after the 0 % event, the role-only chunk notwithstanding
  })

  it('a server that sends no progress events keeps the pre-#598 rule: pings carry a 500 s prefill', async () => {
    const r = await replay([...pings(0, 480_000), [500_000, chatChunk('Answer') + 'data: [DONE]\n\n']], 0)
    expect(r.outcome()).toBe('ended')
    expect(r.out).toEqual(['Answer'])
  })
})

// F-02 (audit 2026-07-16) — llama-server reports a MID-GENERATION failure in-band on the open
// SSE stream and then closes it without `[DONE]`. parseSseLine used to treat both in-band shapes
// as keep-alives, so readChatSSE ended CLEANLY and a partially-generated answer persisted as if
// complete (finish_reason null ⇒ no truncated badge, no error — the silent-truncation class the
// translation reader was hardened against in TA-4 M2/M3). The reader must reject instead.
//
// Frame-shape provenance (TS-3(a) rider): the two in-band shapes mirror the ones the repo
// verified on b9849 in the TA-4 translation-audit record (docs/architecture.md "translation
// audit"): a `data: {"error":{…}}` frame and a bare `error: {…}` SSE field line. No capture of
// either exists on the current pin b11146 (#518 re-took the SUCCESS streams only) — CI green does
// NOT evidence this wire contract; re-verify both shapes against a captured smoke transcript on
// every runtime pin bump (BUILD_STATE §5 TS-3 inventory; the real-server error-frame smoke is owed).
describe('readChatSSE — in-band error frames reject the stream (F-02)', () => {
  const errorDataFrame = (message: string, type: string): string =>
    `data: ${JSON.stringify({ error: { code: 500, message, type } })}\n\n`

  it('tokens → `data: {"error":{…}}` frame → close ⇒ the generator REJECTS; the partial is not treated complete', async () => {
    const stream = pacedStream(
      [chatChunk('The first half of'), chatChunk(' the answer'), errorDataFrame('slot error', 'server_error')],
      1
    )
    const out: string[] = []
    const err = await (async () => {
      for await (const t of readChatSSE(stream)) out.push(t)
      return null
    })().catch((e: unknown) => e)
    // The tokens before the failure streamed through (live UI), but the iteration must REJECT —
    // never end cleanly with the partial masquerading as a finished reply.
    expect(out.join('')).toBe('The first half of the answer')
    expect(err).not.toBeNull()
    expect(isChatStreamError(err)).toBe(true)
    expect(err).toBeInstanceOf(ChatStreamError)
    expect((err as ChatStreamError).serverType).toBe('server_error')
  })

  it('a bare `error: {…}` SSE field line (the non-`data:` carrier) also rejects', async () => {
    const stream = pacedStream(
      [chatChunk('partial'), `error: ${JSON.stringify({ message: 'context shift refused', type: 'slot_error' })}\n\n`],
      1
    )
    const out: string[] = []
    const err = await (async () => {
      for await (const t of readChatSSE(stream)) out.push(t)
      return null
    })().catch((e: unknown) => e)
    expect(out).toEqual(['partial'])
    expect(isChatStreamError(err)).toBe(true)
    expect((err as ChatStreamError).serverType).toBe('slot_error')
  })

  it('an error frame with an unparseable payload still rejects (an error field is never a keep-alive)', async () => {
    const stream = pacedStream([chatChunk('x'), 'error: not-json\n\n'], 1)
    const err = await (async () => {
      for await (const _t of readChatSSE(stream)) void _t
      return null
    })().catch((e: unknown) => e)
    expect(isChatStreamError(err)).toBe(true)
  })

  it('an error frame sent WITHOUT a trailing newline before close (the flushed tail) still rejects', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(chatChunk('tok')))
        // The server dies mid-write: the error frame arrives with no trailing newline, then close.
        controller.enqueue(enc.encode('data: {"error":{"message":"oom","type":"server_error"}}'))
        controller.close()
      }
    })
    const err = await (async () => {
      for await (const _t of readChatSSE(stream)) void _t
      return null
    })().catch((e: unknown) => e)
    expect(isChatStreamError(err)).toBe(true)
  })

  it('regression: answer content that merely CONTAINS "error:" is data, never an error frame', async () => {
    const stream = pacedStream(
      [chatChunk('error: this is answer text'), chatChunk(' more'), 'data: [DONE]\n\n'],
      1
    )
    const out: string[] = []
    for await (const t of readChatSSE(stream)) out.push(t)
    expect(out.join('')).toBe('error: this is answer text more')
  })

  it('regression: a well-formed stream (tokens → finish_reason → [DONE]) is byte-identical — no error, finish surfaced', async () => {
    const finishChunk = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    const stream = pacedStream([chatChunk('a'), chatChunk('b'), finishChunk, 'data: [DONE]\n\n'], 1)
    const out: string[] = []
    let finish: string | null = null
    for await (const t of readChatSSE(stream, undefined, undefined, (r) => (finish = r))) out.push(t)
    expect(out.join('')).toBe('ab')
    expect(finish).toBe('stop')
  })
})

// #290/#291 — llama-server's per-request `timings` block rides the streamed completion. The REAL
// shape is pinned by `chat-sse-timings-fixture.test.ts` on the b9849 (#298) and b11146 (#512)
// captures (the timings ride the `finish_reason: "stop"` chunk itself; no trailing choices-less chunk). The
// shapes below are ROBUSTNESS cases beyond that pin. The reader remembers the last block seen on
// ANY chunk and hands it up with the finish reason, once, at `[DONE]` / the clean close — and
// never on an abort, an error frame or a watchdog trip.
describe('readChatSSE — server timings ride the finish hand-up (#290/#291)', () => {
  const TIMINGS = {
    prompt_n: 12,
    prompt_ms: 180.5,
    predicted_n: 64,
    predicted_ms: 1336.1,
    predicted_per_second: 47.9,
    prompt_per_second: 66.5
  }
  const finishWithTimings = (): string =>
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: TIMINGS })}\n\n`
  type Finish = { reason: string; timings: unknown }
  const collect = async (frames: string[], signal?: AbortSignal): Promise<{ out: string; finishes: Finish[] }> => {
    const finishes: Finish[] = []
    const out: string[] = []
    for await (const t of readChatSSE(pacedStream(frames, 1), signal, undefined, (reason, timings) =>
      finishes.push({ reason, timings })
    )) {
      out.push(t)
    }
    return { out: out.join(''), finishes }
  }

  it('surfaces a timings object carried on the final (finish_reason) chunk', async () => {
    const { out, finishes } = await collect([chatChunk('a'), chatChunk('b'), finishWithTimings(), 'data: [DONE]\n\n'])
    expect(out).toBe('ab')
    expect(finishes).toEqual([{ reason: 'stop', timings: TIMINGS }])
  })

  it('hands up undefined timings when no chunk carried them (the mock / an older server)', async () => {
    const finishChunk = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    const { finishes } = await collect([chatChunk('a'), finishChunk, 'data: [DONE]\n\n'])
    expect(finishes).toEqual([{ reason: 'stop', timings: undefined }])
  })

  it('still surfaces timings sent on a separate TRAILING chunk with empty choices', async () => {
    const finishChunk = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`
    const trailing = `data: ${JSON.stringify({ choices: [], timings: TIMINGS })}\n\n`
    const { out, finishes } = await collect([chatChunk('x'), finishChunk, trailing, 'data: [DONE]\n\n'])
    expect(out).toBe('x')
    expect(finishes).toEqual([{ reason: 'length', timings: TIMINGS }])
  })

  it('keeps the LAST timings seen when several chunks carry one (cumulative per request)', async () => {
    const early = `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }], timings: { predicted_n: 1 } })}\n\n`
    const { finishes } = await collect([early, finishWithTimings(), 'data: [DONE]\n\n'])
    expect(finishes[0].timings).toEqual(TIMINGS)
  })

  it('hands the timings up on a clean close WITHOUT [DONE] (the flush path)', async () => {
    const enc2 = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc2.encode(chatChunk('a')))
        // No trailing newline, no sentinel — the server closed right after the finish chunk.
        controller.enqueue(enc2.encode(finishWithTimings().trimEnd()))
        controller.close()
      }
    })
    const finishes: Finish[] = []
    for await (const _t of readChatSSE(stream, undefined, undefined, (reason, timings) =>
      finishes.push({ reason, timings })
    )) {
      void _t
    }
    expect(finishes).toEqual([{ reason: 'stop', timings: TIMINGS }])
  })

  it('never reports timings (or a finish) on an aborted stream', async () => {
    const controller = new AbortController()
    const finishes: Finish[] = []
    const out: string[] = []
    for await (const t of readChatSSE(
      pacedStream([chatChunk('a'), chatChunk('b'), finishWithTimings(), 'data: [DONE]\n\n'], 1),
      controller.signal,
      undefined,
      (reason, timings) => finishes.push({ reason, timings })
    )) {
      out.push(t)
      controller.abort()
    }
    expect(out).toEqual(['a'])
    expect(finishes).toEqual([])
  })

  it('never reports timings when an in-band error frame ends the stream (F-02 unchanged)', async () => {
    const finishes: Finish[] = []
    const errorFrame = `data: ${JSON.stringify({ error: { message: 'slot failed', type: 'server_error' } })}\n\n`
    await expect(async () => {
      for await (const _t of readChatSSE(pacedStream([chatChunk('a'), errorFrame], 1), undefined, undefined, (reason, timings) =>
        finishes.push({ reason, timings })
      )) {
        void _t
      }
    }).rejects.toBeInstanceOf(ChatStreamError)
    expect(finishes).toEqual([])
  })

  it('never reports timings when the idle watchdog trips (CB-5 unchanged)', async () => {
    const finishes: Finish[] = []
    const idle = { prefillMs: 500, progressMs: 420_000, streamMs: 40 }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(chatChunk('a')))
        // Then silence beyond the stream budget; the watchdog fires before anything else arrives.
        await delay(400)
        controller.close()
      }
    })
    await expect(async () => {
      for await (const _t of readChatSSE(stream, undefined, undefined, (reason, timings) =>
        finishes.push({ reason, timings }), idle)) {
        void _t
      }
    }).rejects.toBeInstanceOf(RuntimeUnresponsiveError)
    expect(finishes).toEqual([])
  })

  it('ignores a non-object timings value and a timings block on an ignored post-[DONE] chunk', async () => {
    const junk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }], timings: 'nope' })}\n\n`
    const finishChunk = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    const late = `data: ${JSON.stringify({ choices: [], timings: TIMINGS })}\n\n`
    const { out, finishes } = await collect([junk, finishChunk, 'data: [DONE]\n\n', late])
    expect(out).toBe('a')
    expect(finishes).toEqual([{ reason: 'stop', timings: undefined }])
  })
})
