import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChatSSE, isRuntimeUnresponsiveError } from '../../src/main/services/runtime/llama'

// #598 — the REAL wire shape of llama-server's prompt-progress events and the pings around them, captured on the
// pinned b11146 with the app's chat argv and request body plus `return_progress: true` (provenance in each fixture's
// header). Both pinned builds ping every ~30 s while prefill runs, from the HTTP thread, so before the first token a
// ping proves only that the process lives; the progress events are the compute loop's own sign of life. One capture is
// a legitimate multi-batch CPU prefill, the other a real compute wedge (one compute thread suspended after the first
// batch). Replayed on their recorded timelines with fake timers. Re-capture on every runtime pin bump (TS-3(a)).

const fixture = (name: string): string => readFileSync(join(__dirname, '../fixtures', name), 'utf8')
const PREFILL = fixture('chat-sse-progress-b11146.txt')
const WEDGE = fixture('chat-sse-progress-stall-b11146.txt')
// The previous pin, still on drives without the #516 update: the same request and prompt, truncated after the first token.
const PREFILL_B9849 = fixture('chat-sse-progress-b9849.txt')

/** The fixture's socket reads: each `: +<ms> ms` line marks when the bytes below it arrived. */
function reads(fixture: string): Array<{ at: number; bytes: string }> {
  const parts = fixture.split(/^: \+(\d+) ms\n/m)
  const out: Array<{ at: number; bytes: string }> = []
  for (let i = 1; i < parts.length; i += 2) out.push({ at: Number(parts[i]), bytes: parts[i + 1] })
  return out
}

/** The parsed `data:` events that carry a `prompt_progress`. */
function progressEvents(fixture: string): Array<{
  choices: Array<{ delta: unknown }>
  prompt_progress: { total: number; cache: number; processed: number; time_ms: number }
}> {
  return fixture
    .split('\n')
    .filter((l) => l.startsWith('data: {') && l.includes('"prompt_progress"'))
    .map((l) => JSON.parse(l.slice('data: '.length)))
}

/**
 * Feed the capture into `readChatSSE` (production budgets) on its own timeline, up to `untilMs` after the request. The
 * reader's outcome is observable through the returned getters; `advance` moves the clock further without new bytes.
 */
async function replay(fixture: string, untilMs: number) {
  vi.useFakeTimers()
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
    for await (const t of readChatSSE(body)) out.push(t)
  })().then(
    () => (outcome = 'ended'),
    (e: unknown) => (outcome = e)
  )
  let now = 0
  for (const { at, bytes } of reads(fixture)) {
    if (at > untilMs) break
    await vi.advanceTimersByTimeAsync(at - now)
    now = at
    controller.enqueue(enc.encode(bytes))
  }
  await vi.advanceTimersByTimeAsync(untilMs - now)
  return { out, outcome: () => outcome, advance: (ms: number) => vi.advanceTimersByTimeAsync(ms) }
}

describe('readChatSSE on the captured b11146 prompt-progress transcripts (#598)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['b11146', PREFILL],
    ['b9849', PREFILL_B9849]
  ])('the %s capture has the #598 shape: a text-less progress event with the headers and after every batch, pings between', (_pin, text) => {
    const events = progressEvents(text)
    expect(events.map((e) => e.prompt_progress.processed)).toEqual([0, 2048, 4096, 6144, 6381])
    for (const e of events) {
      expect(e.choices[0].delta).toEqual({ role: 'assistant', content: null }) // nothing for the reader to yield
      expect(Object.keys(e.prompt_progress).sort()).toEqual(['cache', 'processed', 'time_ms', 'total'])
    }
    expect(events.at(-1)!.prompt_progress.total).toBe(6381)
    const first = reads(text)[0]
    expect(first.at).toBeLessThan(1_000) // the 0 % event rides with the response headers (+28–34 ms)
    expect(first.bytes).toContain('"processed":0')
    expect(reads(text).filter((r) => r.bytes === ':\n\n').length).toBeGreaterThan(0) // pings between the batches
  })

  it('replayed on its timeline, the legitimate 187 s CPU prefill answers — progress events are not the first token', async () => {
    // If a progress event counted as the first chunk, the 30 s stream budget would cut the 73.7 s third batch.
    const r = await replay(PREFILL, 192_411)
    expect(r.outcome()).toBe('ended')
    expect(r.out.join('')).toBe('There are 100 distinct words in the given list.')
  })

  it('the captured wedge ends 7 min after its last progress event although the pings keep coming', async () => {
    const lastProgress = Math.max(...reads(WEDGE).filter((r) => r.bytes.includes('"prompt_progress"')).map((r) => r.at))
    expect(lastProgress).toBeLessThan(60_000) // the first batch's event; the thread was suspended right after it
    const r = await replay(WEDGE, lastProgress + 419_999)
    expect(r.outcome()).toBe('pending')
    await r.advance(1)
    expect(isRuntimeUnresponsiveError(r.outcome())).toBe(true) // ⇒ main.chat.runtimeUnresponsive / local API 502
    expect((r.outcome() as Error).message).toContain('no prompt progress for 420000ms')
    expect(r.out).toEqual([])
  })
})
