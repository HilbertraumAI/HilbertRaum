import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChatSSE } from '../../src/main/services/runtime/llama'

// SSE parser regression on a verbatim vision capture: the vision sidecar's streamed frames are
// byte-identical to text chat, so `readChatSSE` parses them UNCHANGED — there is no
// vision-specific reader (established by the V1 research gate, BUILD_STATE 2026-06-20, on
// b9585). This guards that contract on the real fixture, including the load-bearing
// partial-UTF-8-across-frames case (the German "Müller"/"Söhne" multibyte chars must
// reconstruct even when a frame is split mid-codepoint).
//
// Fixture provenance (#518, 2026-09-27): re-taken on the CURRENT pin b11146 the way V1 made it —
// the K: test drive's `llama-server` with the app's vision argv (`--mmproj`, `--parallel 1`,
// `--device none --no-mmproj-offload`, ctx 4096), one streamed `/v1/chat/completions` with
// `cache_prompt: true` and a base64 `image_url` of `invoice-synthetic.png` (a content-free
// invoice drawn by `make-invoice.ps1`, fictional issuer "Müller & Söhne GmbH"), the response
// bytes written untouched except the drive letter in the `model` field (`<drive>`). The b9585
// sample it replaces answered a real scan that was never in the repo. Re-capture on every
// runtime pin bump (TS-3(a)).

const FIXTURE = readFileSync(
  join(__dirname, '../fixtures/vision/vision-sse-b11146.txt'),
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
    expect(answer).toBe('This is a German invoice issued by Müller & Söhne GmbH, and it is in German.')
    // The capture is what the wire carried: b11146's fingerprint, the timings on the stop frame.
    expect(FIXTURE).toContain('"system_fingerprint":"b11146-7fe450e19"')
    expect(FIXTURE.trimEnd().endsWith('data: [DONE]')).toBe(true)
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
