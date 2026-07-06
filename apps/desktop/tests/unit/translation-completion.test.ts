import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  readCompletionSSE,
  CompletionError,
  IncompleteStreamError,
  type CompletionFinal
} from '../../src/main/services/translation/completion'
import { log } from '../../src/main/services/logging'

// TA-4: unit tests for the raw `/completion` SSE reader, driven DIRECTLY with scripted
// `ReadableStream`s (no fake server) so the frame-boundary + terminal-frame + abort discipline is
// pinned at the reader layer. Covers: multi-chunk mid-line splits, CRLF, no-trailing-newline flush,
// terminal frame → onFinal (existing), and the five TA-4 findings — M2 (stream-end-without-final
// throws), M3 (`error:` field line throws), L1 (abort mid-stream throws), L4 (garbled frame skipped
// + counted). The `data:`-error path is the pre-existing behavior, re-pinned here.

/** A `ReadableStream` that emits the given chunks verbatim, one per `pull` (mimics network framing). */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) return controller.close()
      controller.enqueue(enc.encode(chunks[i++]))
    }
  })
}

/** Drain a delta generator to an array. */
async function collect(gen: AsyncGenerator<string, void, unknown>): Promise<string[]> {
  const out: string[] = []
  for await (const d of gen) out.push(d)
  return out
}

const TERMINAL = 'data: {"content":"","stop":true,"stopping_word":"<end_of_turn>","timings":{"predicted_per_second":9.5}}\n'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readCompletionSSE — framing', () => {
  it('reassembles a frame split mid-line across multiple chunks', async () => {
    const stream = streamOf([
      'data: {"cont',
      'ent":"Hello ","stop":false}\n',
      'data: {"content":"world","stop":false}\n',
      TERMINAL
    ])
    const deltas = await collect(readCompletionSSE(stream))
    expect(deltas.join('')).toBe('Hello world')
  })

  it('parses CRLF line endings', async () => {
    const stream = streamOf([
      'data: {"content":"Hi","stop":false}\r\n',
      'data: {"content":"!","stop":false}\r\n',
      'data: {"content":"","stop":true}\r\n'
    ])
    const deltas = await collect(readCompletionSSE(stream))
    expect(deltas.join('')).toBe('Hi!')
  })

  it('flushes a terminal frame the server sent WITHOUT a trailing newline', async () => {
    const stream = streamOf([
      'data: {"content":"Done","stop":false}\n',
      'data: {"content":"","stop":true,"stopping_word":"<end_of_turn>"}' // no trailing \n
    ])
    let final: CompletionFinal | undefined
    const deltas = await collect(readCompletionSSE(stream, undefined, (f) => (final = f)))
    expect(deltas.join('')).toBe('Done')
    expect(final?.stoppingWord).toBe('<end_of_turn>')
  })

  it('reports the terminal frame through onFinal with timings + stopping word', async () => {
    const stream = streamOf(['data: {"content":"x","stop":false}\n', TERMINAL])
    let final: CompletionFinal | undefined
    await collect(readCompletionSSE(stream, undefined, (f) => (final = f)))
    expect(final).toEqual({ stoppingWord: '<end_of_turn>', timings: { predicted_per_second: 9.5 } })
  })

  it('does NOT warn for a clean stream with keep-alive / comment / blank lines', async () => {
    const warn = vi.spyOn(log, 'warn')
    const stream = streamOf([': keep-alive\n', '\n', 'data: {"content":"ok","stop":false}\n', TERMINAL])
    const deltas = await collect(readCompletionSSE(stream))
    expect(deltas.join('')).toBe('ok')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('readCompletionSSE — M2 terminal-frame enforcement', () => {
  it('throws IncompleteStreamError when the stream ends without the terminal stop frame', async () => {
    const stream = streamOf(['data: {"content":"partial","stop":false}\n'])
    await expect(collect(readCompletionSSE(stream))).rejects.toBeInstanceOf(IncompleteStreamError)
  })

  it('yields the flushed delta THEN throws when a no-newline tail has no terminal frame', async () => {
    const stream = streamOf(['data: {"content":"Partial","stop":false}']) // no newline, no terminal
    const gen = readCompletionSSE(stream)
    const first = await gen.next()
    expect(first.value).toBe('Partial')
    await expect(gen.next()).rejects.toBeInstanceOf(IncompleteStreamError)
  })

  it('IncompleteStreamError is a CompletionError subtype, NOT an AbortError (retryable path)', () => {
    const err = new IncompleteStreamError()
    expect(err).toBeInstanceOf(CompletionError)
    expect(err.name).toBe('IncompleteStreamError')
    expect(err.name).not.toBe('AbortError')
  })
})

describe('readCompletionSSE — error frames', () => {
  it('throws a CompletionError on a mid-stream `data:` error frame (existing)', async () => {
    const stream = streamOf([
      'data: {"error":{"message":"context size exceeded","type":"exceed_context_size_error"}}\n'
    ])
    await expect(collect(readCompletionSSE(stream))).rejects.toThrow(
      /Translation request failed: context size exceeded/
    )
  })

  it('M3: throws a CompletionError on a bare `error:` SSE field line', async () => {
    const stream = streamOf(['error: {"message":"boom","type":"server_error"}\n'])
    await expect(collect(readCompletionSSE(stream))).rejects.toThrow(/Translation request failed: boom/)
  })

  it('M3: handles a nested `error: {"error":{…}}` field shape', async () => {
    const stream = streamOf(['error: {"error":{"message":"nested fail","type":"x"}}\n'])
    await expect(collect(readCompletionSSE(stream))).rejects.toThrow(/Translation request failed: nested fail/)
  })

  it('M3: an unparseable `error:` field is still surfaced (never swallowed)', async () => {
    const stream = streamOf(['error: not-json\n'])
    await expect(collect(readCompletionSSE(stream))).rejects.toBeInstanceOf(CompletionError)
  })
})

describe('readCompletionSSE — L1 abort', () => {
  it('throws the abort reason when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    const stream = streamOf([TERMINAL])
    await expect(collect(readCompletionSSE(stream, controller.signal))).rejects.toThrow(/stopped/)
  })

  it('throws (not resolves) when aborted mid-stream between token deliveries', async () => {
    const controller = new AbortController()
    const stream = streamOf([
      'data: {"content":"Hello ","stop":false}\n',
      'data: {"content":"world","stop":false}\n',
      TERMINAL
    ])
    const gen = readCompletionSSE(stream, controller.signal)
    const first = await gen.next()
    expect(first.value).toBe('Hello ')
    controller.abort(new DOMException('user stop', 'AbortError'))
    await expect(gen.next()).rejects.toThrow(/user stop/)
  })
})

describe('readCompletionSSE — L4 garbled-frame counting', () => {
  it('skips a garbled complete `data:` frame, continues, and warns ONCE with a content-free count', async () => {
    const warn = vi.spyOn(log, 'warn')
    const stream = streamOf([
      'data: {not valid json}\n',
      'data: {"content":"ok","stop":false}\n',
      TERMINAL
    ])
    const deltas = await collect(readCompletionSSE(stream))
    expect(deltas.join('')).toBe('ok')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('translation SSE: dropped unparseable frame', { count: 1 })
  })

  it('accumulates the count across multiple garbled frames (one warn per stream)', async () => {
    const warn = vi.spyOn(log, 'warn')
    const stream = streamOf([
      'data: {bad 1}\n',
      'data: {bad 2}\n',
      'data: {"content":"y","stop":false}\n',
      TERMINAL
    ])
    await collect(readCompletionSSE(stream))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('translation SSE: dropped unparseable frame', { count: 2 })
  })
})
