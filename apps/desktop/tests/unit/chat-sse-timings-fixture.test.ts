import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChatSSE } from '../../src/main/services/runtime/llama'
import type { RuntimeTimings } from '../../src/main/services/runtime'
import { answerSpeedFrom } from '../../src/main/ipc/chat-stream'
import { formatAnswerSpeed } from '../../src/renderer/chat/answerSpeed'
import { fmt1 } from '../../src/renderer/lib/format'
import { t } from '../../src/shared/i18n'
import type { Message } from '../../src/shared/types'

// #290/#291 — the REAL wire shape of llama-server's `timings` on a streamed chat completion,
// captured from the pinned b9849 on the #291 reporter's rig (issue #298, 2026-09-04). This
// replaces the hand-authored guess the reader was built against: at b9849 the timings block
// rides the `finish_reason: "stop"` chunk itself, and there is no trailing choices-less chunk.
// The tolerant shapes in read-chat-sse.test.ts stay as robustness cases; THIS file is the pin.
// Re-capture on every runtime pin bump (TS-3(a)).

const FIXTURE = readFileSync(join(__dirname, '../fixtures/chat-sse-timings-b9849.txt'), 'utf8')

/** A `ReadableStream` over `text`, optionally chopped into `chunkSize`-byte frames. */
function streamOf(text: string, chunkSize?: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let pos = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close()
        return
      }
      const end = chunkSize ? Math.min(pos + chunkSize, bytes.length) : bytes.length
      controller.enqueue(bytes.slice(pos, end))
      pos = end
    }
  })
}

async function run(stream: ReadableStream<Uint8Array>): Promise<{
  answer: string
  finishes: Array<{ reason: string; timings?: RuntimeTimings }>
}> {
  const finishes: Array<{ reason: string; timings?: RuntimeTimings }> = []
  let answer = ''
  for await (const delta of readChatSSE(stream, undefined, undefined, (reason, timings) =>
    finishes.push({ reason, timings })
  )) {
    answer += delta
  }
  return { answer, finishes }
}

describe('readChatSSE on the captured b9849 timings transcript (#298)', () => {
  it('the capture has the documented shape: content chunk, finish chunk WITH timings, [DONE]', () => {
    const frames = FIXTURE.split('\n').filter((l) => l.startsWith('data:'))
    expect(frames).toHaveLength(3)
    expect(frames[0]).toContain('"finish_reason":null')
    expect(frames[1]).toContain('"finish_reason":"stop"')
    expect(frames[1]).toContain('"timings":{')
    expect(frames[2]).toBe('data: [DONE]')
  })

  it('yields the last delta and hands the finish reason + the server timings up once', async () => {
    const { answer, finishes } = await run(streamOf(FIXTURE))
    expect(answer).toBe('.')
    expect(finishes).toHaveLength(1)
    expect(finishes[0].reason).toBe('stop')
    const tm = finishes[0].timings
    expect(tm).toBeDefined()
    // The figures the app displays — matched against the server's own print_timing line on #298:
    // `eval time = 848.62 ms / 25 tokens (29.46 tokens per second)`.
    expect(tm!.predicted_n).toBe(25)
    expect(tm!.predicted_per_second).toBeCloseTo(29.46, 2)
    expect(tm!.predicted_ms).toBeCloseTo(848.618, 3)
    expect(tm!.prompt_n).toBe(18)
    expect(tm!.prompt_ms).toBeCloseTo(442.473, 3)
    expect(tm!.prompt_per_second).toBeCloseTo(40.68, 2)
  })

  it('parses identically when the transcript arrives in small frames split mid-JSON', async () => {
    for (const size of [7, 64, 333]) {
      const { answer, finishes } = await run(streamOf(FIXTURE, size))
      expect(answer).toBe('.')
      expect(finishes).toHaveLength(1)
      expect(finishes[0].timings?.predicted_per_second).toBeCloseTo(29.46, 2)
    }
  })

  it('reports the decode figure the Diagnostics probe and the speed line would show', async () => {
    const { finishes } = await run(streamOf(FIXTURE))
    const tm = finishes[0].timings!
    // The figures the app shows, through production: the speed payload, the chat line and the Performance screen.
    const reply: Message = { id: 'a1', conversationId: 'c1', role: 'assistant', content: '.', createdAt: '2026-09-04T00:00:00Z', tokenCount: null }
    const speed = answerSpeedFrom(reply, tm, 1_800)!
    // The server counts TOKENS (predicted_n 25; the capture drafted 20 and accepted 15 with MTP) — why the old chunk count under-read (#291).
    expect(speed).toEqual({ messageId: 'a1', tokensPerSecond: tm.predicted_per_second, ttftMs: 1_800, tokens: 25 })
    expect(formatAnswerSpeed(speed, (key, params) => t('en', key, params), 'en')).toBe('29 tok/s · 1.8 s to first token · 25 tokens')
    expect(fmt1(speed.tokensPerSecond, 'en')).toBe('29.5') // PerformanceScreen's speed tile
  })
})

// #512: the same capture re-taken on the b11146 pin (gemma4-12b, the app's chat argv). The wire
// shape did not change: timings still ride the `finish_reason: "stop"` chunk, then [DONE].
const FIXTURE_B11146 = readFileSync(join(__dirname, '../fixtures/chat-sse-timings-b11146.txt'), 'utf8')

describe('readChatSSE on the b11146 re-capture (#512)', () => {
  it('has the b9849 shape: content chunk, finish chunk WITH timings, [DONE]', () => {
    const frames = FIXTURE_B11146.split('\n').filter((l) => l.startsWith('data:'))
    expect(frames).toHaveLength(3)
    expect(frames[0]).toContain('"finish_reason":null')
    expect(frames[1]).toContain('"finish_reason":"stop"')
    expect(frames[1]).toContain('"timings":{')
    expect(frames[1]).toContain('"system_fingerprint":"b11146-7fe450e19"')
    expect(frames[2]).toBe('data: [DONE]')
  })

  it('hands the finish reason + timings up once, whole or split mid-JSON', async () => {
    for (const size of [undefined, 7, 64, 333]) {
      const { answer, finishes } = await run(streamOf(FIXTURE_B11146, size))
      expect(answer).toBe('.')
      expect(finishes).toHaveLength(1)
      expect(finishes[0].reason).toBe('stop')
      const tm = finishes[0].timings!
      // The server's own print_timing line: `eval time = 6426.08 ms / 24 tokens (3.58 tokens per second)`.
      expect(tm.predicted_n).toBe(24)
      expect(tm.predicted_per_second).toBeCloseTo(3.579, 3)
      expect(tm.prompt_n).toBe(19)
      expect(tm.prompt_ms).toBeCloseTo(942.623, 3)
    }
  })
})
