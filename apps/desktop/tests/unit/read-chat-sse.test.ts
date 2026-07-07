import { describe, it, expect } from 'vitest'
import {
  readChatSSE,
  RuntimeUnresponsiveError,
  isRuntimeUnresponsiveError
} from '../../src/main/services/runtime/llama'

// CB-5 — the completion stream had no inactivity timeout: a sidecar that HANGS (GPU stall, deadlocked
// slot) left `readChatSSE` awaiting the next SSE read forever, wedging the conversation in
// `inFlightStreams`. A two-phase idle watchdog now races each `reader.read()` against an injectable
// budget (prefill, then a tighter inter-chunk budget) and rejects with `RuntimeUnresponsiveError`.

const enc = new TextEncoder()
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
