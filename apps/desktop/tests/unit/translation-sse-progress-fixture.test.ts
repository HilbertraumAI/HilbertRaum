import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCompletionSSE } from '../../src/main/services/translation/completion'
import { isRuntimeUnresponsiveError } from '../../src/main/services/runtime/llama'

// #605 — the REAL wire shape of the translation sidecar's native `/completion` stream with `return_progress`, captured on
// the pinned b11146 (and the previous pin b9849) with TranslationRuntime's request body and the translation argv, 512-token
// batches included (provenance in each fixture's header). Before the first token a ping proves only that the process
// lives; a progress frame proves the compute loop moved; after the first token only tokens count. One capture is a
// legitimate multi-batch CPU prefill, two are real wedges (one compute thread suspended, the pings going on): in prefill
// and in decode. Replayed on their recorded timelines with fake timers at the production budgets. Re-capture on every
// runtime pin bump (TS-3(a)).

const fixture = (name: string): string => readFileSync(join(__dirname, '../fixtures', name), 'utf8')
const PREFILL = fixture('translation-sse-progress-b11146.txt')
const PREFILL_B9849 = fixture('translation-sse-progress-b9849.txt')
const PREFILL_WEDGE = fixture('translation-sse-progress-stall-b11146.txt')
const DECODE_WEDGE = fixture('translation-sse-decode-stall-b11146.txt')

/** The fixture's socket reads: each `: +<ms> ms` line marks when the bytes below it arrived. */
function reads(text: string): Array<{ at: number; bytes: string }> {
  const parts = text.split(/^: \+(\d+) ms\n/m)
  const out: Array<{ at: number; bytes: string }> = []
  for (let i = 1; i < parts.length; i += 2) out.push({ at: Number(parts[i]), bytes: parts[i + 1] })
  return out
}

interface Frame {
  content?: string
  tokens?: number[]
  prompt_progress?: { total: number; cache: number; processed: number; time_ms: number }
}

/** Every `data:` frame, with the arrival time of the read that carried it. */
function frames(text: string): Array<{ at: number; frame: Frame }> {
  return reads(text).flatMap(({ at, bytes }) =>
    bytes
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => ({ at, frame: JSON.parse(l.slice('data: '.length)) as Frame }))
  )
}

/**
 * Feed the capture into `readCompletionSSE` (production budgets) on its own timeline, up to `untilMs` after the request.
 * The reader's outcome is observable through the returned getters; `advance` moves the clock further without new bytes.
 */
async function replay(text: string, untilMs: number) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    }
  })
  const out: string[] = []
  let outcome: unknown = 'pending'
  void (async () => {
    for await (const t of readCompletionSSE(body)) out.push(t)
  })().then(
    () => (outcome = 'ended'),
    (e: unknown) => (outcome = e)
  )
  let now = 0
  for (const { at, bytes } of reads(text)) {
    if (at > untilMs) break
    await vi.advanceTimersByTimeAsync(at - now)
    now = at
    controller.enqueue(enc.encode(bytes))
  }
  await vi.advanceTimersByTimeAsync(untilMs - now)
  return { out, outcome: () => outcome, advance: (ms: number) => vi.advanceTimersByTimeAsync(ms) }
}

describe('readCompletionSSE on the captured /completion transcripts (#605)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['b11146', PREFILL],
    ['b9849', PREFILL_B9849]
  ])('the %s capture has the #605 shape: a text-less progress frame with the headers and after every 512-token batch, pings between', (_pin, text) => {
    const progress = frames(text).filter((f) => f.frame.prompt_progress)
    expect(progress.length).toBeGreaterThanOrEqual(3) // a window's prefill is no longer one silent batch
    expect(progress[0].at).toBeLessThan(1_000) // the 0 % frame rides with the response headers
    expect(progress[0].frame.prompt_progress!.processed).toBe(0)
    for (const [i, p] of progress.entries()) {
      expect(p.frame.content).toBe('') // nothing for the reader to yield
      expect(Object.keys(p.frame.prompt_progress!).sort()).toEqual(['cache', 'processed', 'time_ms', 'total'])
      if (i > 0) {
        const step = p.frame.prompt_progress!.processed - progress[i - 1].frame.prompt_progress!.processed
        expect(step).toBeGreaterThan(0)
        expect(step).toBeLessThanOrEqual(512) // TRANSLATION_BATCH_ARGS
      }
    }
    const last = progress.at(-1)!.frame.prompt_progress!
    expect(last.processed).toBe(last.total)
    expect(reads(text).filter((r) => r.bytes === ':\n\n').length).toBeGreaterThan(0) // pings between the batches
  })

  it('replayed on its timeline, the legitimate two-thread CPU prefill streams its tokens — no clock runs out', async () => {
    const lastRead = reads(PREFILL).at(-1)!.at
    const r = await replay(PREFILL, lastRead)
    expect(r.outcome()).toBe('pending') // truncated after the 12th token: the reader waits for the rest
    expect(r.out.join('')).toBe('Invoice No. 1000 was forwarded to accounting')
  })

  it('the captured prefill wedge ends 10 min after its last progress frame although the pings keep coming', async () => {
    const lastProgress = Math.max(...frames(PREFILL_WEDGE).filter((f) => f.frame.prompt_progress).map((f) => f.at))
    expect(lastProgress).toBeLessThan(120_000) // the first batch's frame; the thread was suspended right after it
    const r = await replay(PREFILL_WEDGE, lastProgress + 599_999)
    expect(r.outcome()).toBe('pending')
    await r.advance(1)
    expect(isRuntimeUnresponsiveError(r.outcome())).toBe(true) // ⇒ TranslationRuntime stops the sidecar, the window retries
    expect((r.outcome() as Error).message).toContain('no prompt progress for 600000ms')
    expect(r.out).toEqual([])
  })

  it('the captured decode wedge ends 120 s after its last token although the pings keep coming', async () => {
    const tokens = frames(DECODE_WEDGE).filter((f) => f.frame.tokens && !f.frame.prompt_progress)
    const lastToken = tokens.at(-1)!.at
    const pingsAfter = reads(DECODE_WEDGE).filter((r) => r.at > lastToken && r.bytes === ':\n\n')
    expect(pingsAfter.at(-1)!.at).toBeGreaterThan(lastToken + 120_000) // the server kept pinging past the budget
    const r = await replay(DECODE_WEDGE, lastToken + 119_999)
    expect(r.outcome()).toBe('pending')
    await r.advance(1)
    expect(isRuntimeUnresponsiveError(r.outcome())).toBe(true)
    expect((r.outcome() as Error).message).toContain('no output for 120000ms')
    expect(r.out.join('')).toBe(tokens.map((t) => t.frame.content).join('')) // every token before the wedge, nothing after
  })
})
