import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChatSSE } from '../../src/main/services/runtime/llama'

// SSE parser regression on the V1 verbatim capture (BUILD_STATE 2026-06-20): the vision
// sidecar's streamed frames are byte-identical to text chat, so `readChatSSE` parses them
// UNCHANGED — there is no vision-specific reader. This guards that contract on the real
// fixture, including the load-bearing partial-UTF-8-across-frames case (the German "Müller"/
// "Söhne" multibyte chars must reconstruct even when a frame is split mid-codepoint).

const FIXTURE = readFileSync(
  join(__dirname, '../fixtures/vision/vision-sse-sample.txt'),
  'utf8'
)

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

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let answer = ''
  for await (const delta of readChatSSE(stream)) answer += delta
  return answer
}

describe('readChatSSE on the vision SSE fixture', () => {
  it('reconstructs the full answer from the verbatim capture', async () => {
    const answer = await collect(streamOf(FIXTURE))
    expect(answer).toBe(
      'This is an invoice from Müller & Söhne GmbH, and it is in German.'
    )
  })

  it('is byte-chunking invariant — splitting frames mid-UTF-8 yields the same answer', async () => {
    const whole = await collect(streamOf(FIXTURE))
    // One byte per read FORCES a frame boundary inside the multibyte ü/ö sequences; the
    // streaming TextDecoder must hold the partial bytes across reads, not emit U+FFFD.
    const oneByte = await collect(streamOf(FIXTURE, 1))
    expect(oneByte).toBe(whole)
    expect(oneByte).not.toContain('�') // no replacement char ⇒ no mangled codepoint
    expect(oneByte).toContain('Müller & Söhne')
  })
})
