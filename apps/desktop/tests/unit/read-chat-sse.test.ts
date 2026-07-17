import { describe, it, expect } from 'vitest'
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
// llama-server (b9849) output shape — `choices[].delta.content` for answer tokens,
// `choices[].delta.reasoning_content` for `--reasoning-format deepseek` thinking deltas. CI green does
// NOT evidence the real wire contract (see BUILD_STATE §5 TS-3 inventory); re-verify these frames against
// a captured smoke transcript on a runtime pin bump.
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
    const idle = { prefillMs: 20, streamMs: 10 }
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
    const idle = { prefillMs: 1000, streamMs: 20 }
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
    const idle = { prefillMs: 50, streamMs: 30 }
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
    const idle = { prefillMs: 50, streamMs: 30 }
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
    const idle = { prefillMs: 1000, streamMs: 1000 }
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

// F-02 (audit 2026-07-16) — llama-server reports a MID-GENERATION failure in-band on the open
// SSE stream and then closes it without `[DONE]`. parseSseLine used to treat both in-band shapes
// as keep-alives, so readChatSSE ended CLEANLY and a partially-generated answer persisted as if
// complete (finish_reason null ⇒ no truncated badge, no error — the silent-truncation class the
// translation reader was hardened against in TA-4 M2/M3). The reader must reject instead.
//
// Frame-shape provenance (b9849, TS-3(a) rider): the two in-band shapes mirror the ones the
// repo verified for the pinned server in the TA-4 translation-audit record
// (docs/architecture.md "translation audit"): a `data: {"error":{…}}` frame and a bare
// `error: {…}` SSE field line. CI green does NOT evidence the real wire contract — re-verify
// both shapes against a captured smoke transcript on every runtime pin bump (BUILD_STATE §5
// TS-3 inventory; the real-server error-frame smoke is owed at the next smoke-drive session).
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
