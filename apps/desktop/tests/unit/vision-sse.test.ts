import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChatSSE } from '../../src/main/services/runtime/llama'
import { sseBody } from '../helpers/fake-sidecar'

// SSE parser regression on a verbatim vision capture: the vision sidecar's streamed frames are
// byte-identical to text chat, so `readChatSSE` parses them UNCHANGED — there is no
// vision-specific reader (established by the V1 research gate, BUILD_STATE 2026-06-20, on
// b9585). This guards that contract on the real fixture, including the load-bearing
// partial-UTF-8-across-frames case (the German "Müller"/"Söhne" multibyte chars must
// reconstruct even when a frame is split mid-codepoint).
//
// Fixture provenance (#518, 2026-09-27): re-taken on b11146 (the pin until #729) the way V1 made it —
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

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let answer = ''
  for await (const delta of readChatSSE(stream)) answer += delta
  return answer
}

describe('readChatSSE on the vision SSE fixture', () => {
  it('reconstructs the full answer from the verbatim capture', async () => {
    const answer = await collect(sseBody(FIXTURE))
    expect(answer).toBe('This is a German invoice issued by Müller & Söhne GmbH, and it is in German.')
    // The capture is what the wire carried: b11146's fingerprint, the timings on the stop frame.
    expect(FIXTURE).toContain('"system_fingerprint":"b11146-7fe450e19"')
    expect(FIXTURE.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('is byte-chunking invariant — splitting frames mid-UTF-8 yields the same answer', async () => {
    const whole = await collect(sseBody(FIXTURE))
    // One byte per read FORCES a frame boundary inside the multibyte ü/ö sequences; the
    // streaming TextDecoder must hold the partial bytes across reads, not emit U+FFFD.
    const oneByte = await collect(sseBody(FIXTURE, 1))
    expect(oneByte).toBe(whole)
    expect(oneByte).not.toContain('�') // no replacement char ⇒ no mangled codepoint
    expect(oneByte).toContain('Müller & Söhne')
  })
})

// #729: the same capture re-taken on the b12110 pin (2026-11-07, GTX 1070 Ti box, the scratch root's official
// llama-b12110-bin-win-vulkan-x64.zip install): the app's vision argv (`--mmproj`, `--parallel 1`, `--device none
// --no-mmproj-offload`, ctx 4096), one streamed request with `cache_prompt: true`, the question "Which language is this
// document in, and who issued it? Answer in one sentence." and the same `invoice-synthetic.png`. Drives that have not
// taken the #516 update still run b11146, so its capture above stays. The frames have the same shape on both builds.
const FIXTURE_B12110 = readFileSync(join(__dirname, '../fixtures/vision/vision-sse-b12110.txt'), 'utf8')

describe('readChatSSE on the b12110 vision capture (#729)', () => {
  it('reconstructs the answer, whole and one byte per read, with the b12110 fingerprint', async () => {
    const whole = await collect(sseBody(FIXTURE_B12110))
    expect(whole).toBe('The document is in German and it is issued by Müller & Söhne GmbH.')
    expect(await collect(sseBody(FIXTURE_B12110, 1))).toBe(whole)
    expect(FIXTURE_B12110).toContain('"system_fingerprint":"b12110-cd959bae9"')
    expect(FIXTURE_B12110).toContain('"timings":{')
    expect(FIXTURE_B12110.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })
})
