import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChatSSE } from '../../src/main/services/runtime/llama'
import type { RuntimeTimings } from '../../src/main/services/runtime'

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
    // Rounded to one decimal for the card, integer above 10 tok/s for the chat line.
    expect(Math.round(tm.predicted_per_second! * 10) / 10).toBe(29.5)
    expect(Math.round(tm.predicted_per_second!)).toBe(29)
    // MTP evidence in the capture: 20 drafted, 15 accepted — the server counts TOKENS
    // (predicted_n 25), which is exactly why the old chunk count under-read (#291).
    const raw = JSON.parse(FIXTURE.split('\n').find((l) => l.includes('"timings"'))!.slice('data: '.length)) as {
      timings: { draft_n: number; draft_n_accepted: number }
    }
    expect(raw.timings.draft_n).toBe(20)
    expect(raw.timings.draft_n_accepted).toBe(15)
  })
})
