import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VisionRuntime, type VisionAnalyzeOptions } from '../../src/main/services/vision/runtime'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

// V4 hardening tests for the real VisionRuntime (image-understanding plan §16 V4 / §17): lazy
// single-flight start, the failed-start latch, cancellation, NO orphan on a racing stop, and —
// the heart of V4 — the net-new idle-teardown interlock (RUNTIME-4): teardown after idle, the
// timer reset on every entry, NO teardown while a job runs, and a clean cold restart afterwards.
// No real binary is spawned: spawn/fetchImpl/findPort are injected (the e5/reranker seam).

const FIXTURE_SSE = readFileSync(
  join(__dirname, '../fixtures/vision/vision-sse-sample.txt'),
  'utf8'
)
const FIXTURE_ANSWER = 'This is an invoice from Müller & Söhne GmbH, and it is in German.'

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

function fakeSpawn() {
  const calls: Array<{ args: string[] }> = []
  const children: FakeChild[] = []
  const spawn = (_c: string, args: string[]): ChildProcessLike => {
    calls.push({ args })
    const child = new FakeChild()
    children.push(child)
    return child
  }
  return { spawn, calls, children }
}

/** A `ReadableStream` over the SSE text (one chunk; readChatSSE handles the rest). */
function sseBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.close()
      sent = true
      controller.enqueue(bytes)
    }
  })
}

/** Routes /health (ok) and /v1/chat/completions (the fixture SSE). Records request URLs/bodies. */
function visionFetch(sse = FIXTURE_SSE) {
  const urls: string[] = []
  const bodies: unknown[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    urls.push(u)
    if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
    if (u.endsWith('/v1/chat/completions')) {
      bodies.push(JSON.parse(String(init?.body)))
      return { ok: true, status: 200, body: sseBody(sse) } as unknown as Response
    }
    throw new Error(`unexpected url ${u}`)
  }) as typeof fetch
  return { fetchImpl, urls, bodies }
}

const base = {
  modelId: 'vlm',
  binPath: '/bin/llama-server',
  modelPath: '/models/vlm.gguf',
  projectorPath: '/models/mmproj.gguf',
  findPort: async () => 51000,
  healthIntervalMs: 1
}

const analyzeOpts: VisionAnalyzeOptions = {
  imageBytes: new Uint8Array([1, 2, 3, 4]),
  mimeType: 'image/png',
  question: 'What is in this image?'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('VisionRuntime — start + analyze', () => {
  it('lazily spawns the sidecar with --mmproj + --device none and streams the answer', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl, bodies } = visionFetch()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })

    const tokens: string[] = []
    const answer = await rt.analyze({ ...analyzeOpts, onToken: (d) => tokens.push(d) })

    expect(answer).toBe(FIXTURE_ANSWER)
    expect(tokens.join('')).toBe(FIXTURE_ANSWER) // streamed token-by-token
    const args = calls[0].args.join(' ')
    expect(args).toContain('--mmproj /models/mmproj.gguf')
    expect(args).toContain('--device none') // CPU-pinned (V1-resolved)
    expect(args).toContain('--host 127.0.0.1') // loopback only
    expect(args).not.toContain('--reasoning-format') // non-reasoning VLM
    // The request inlines the image as a base64 data-URL and caches the prefill (V1).
    const body = bodies[0] as { cache_prompt: boolean; messages: Array<{ content: unknown }> }
    expect(body.cache_prompt).toBe(true)
    const content = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>
    expect(content[1].image_url?.url.startsWith('data:image/png;base64,')).toBe(true)
    await rt.stop()
  })

  it('shares ONE start across concurrent analyses (single-flight)', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    const [a, b] = await Promise.all([rt.analyze(analyzeOpts), rt.analyze(analyzeOpts)])
    expect(a).toBe(FIXTURE_ANSWER)
    expect(b).toBe(FIXTURE_ANSWER)
    expect(calls.length).toBe(1) // one shared spawn, not two
    await rt.stop()
  })

  it('latches a failed start (fail fast, ONE spawn) instead of re-awaiting the health timeout', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      queueMicrotask(() => child.emit('exit', 1, null)) // dies immediately (corrupt GGUF)
      return child
    }
    const rt = new VisionRuntime({
      ...base,
      spawn,
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    })
    await expect(rt.analyze(analyzeOpts)).rejects.toThrow()
    await expect(rt.analyze(analyzeOpts)).rejects.toThrow()
    expect(calls.length).toBe(1) // the latch prevented a second spawn + health-timeout stall
    await rt.stop()
  })

  it('forwards the caller abort signal to the chat request (cancels in flight)', async () => {
    const { spawn } = fakeSpawn()
    let seenSignal: AbortSignal | undefined
    const hangingFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      seenSignal = init?.signal ?? undefined
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        )
      })
    }) as typeof fetch

    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: hangingFetch })
    const controller = new AbortController()
    const p = rt.analyze({ ...analyzeOpts, signal: controller.signal })
    await sleep(2) // let the request reach the fetch
    controller.abort()
    await expect(p).rejects.toThrow(/abort/i)
    expect(seenSignal?.aborted).toBe(true)
    await rt.stop()
  })

  it('stop() during the in-flight lazy start kills the child (no orphan) and blocks restart', async () => {
    const { spawn, children } = fakeSpawn()
    const health: { release: (() => void) | null } = { release: null }
    const gatedFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) {
        await new Promise<void>((resolve) => (health.release = resolve))
        return { ok: true, status: 200 } as Response
      }
      return { ok: true, status: 200, body: sseBody(FIXTURE_SSE) } as unknown as Response
    }) as typeof fetch

    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: gatedFetch })
    const p = rt.analyze(analyzeOpts)
    while (!health.release) await sleep(1) // start is in flight, polling /health

    const stopPromise = rt.stop() // quit/lock while still starting
    health.release()
    await stopPromise
    await p.catch(() => undefined) // the analyze may fail; no-orphan is the point

    expect(children[0].killed).toBe(true)
    await expect(rt.analyze(analyzeOpts)).rejects.toThrow(/stopped/)
  })
})

describe('VisionRuntime — idle-teardown interlock (RUNTIME-4)', () => {
  it('tears the sidecar down after the idle timeout, then cold-restarts on the next analyze', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 20 })

    await rt.analyze(analyzeOpts)
    expect(calls.length).toBe(1)
    expect(children[0].killed).toBe(false) // alive while the idle clock runs

    await sleep(60) // past the idle timeout
    expect(children[0].killed).toBe(true) // SOFT idle teardown fired

    // A fresh analyze re-pays a clean cold start on a NEW child.
    const answer = await rt.analyze(analyzeOpts)
    expect(answer).toBe(FIXTURE_ANSWER)
    expect(calls.length).toBe(2)
    expect(children[1].killed).toBe(false)
    await rt.stop()
  })

  it('does NOT tear down while a job is in flight (the inFlight guard)', async () => {
    const { spawn, children } = fakeSpawn()
    const gate: { release: (() => void) | null } = { release: null }
    const gatedFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      // Hold the chat response open well past the (tiny) idle timeout.
      await new Promise<void>((resolve) => (gate.release = resolve))
      return { ok: true, status: 200, body: sseBody(FIXTURE_SSE) } as unknown as Response
    }) as typeof fetch

    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: gatedFetch, idleTimeoutMs: 5 })
    const p = rt.analyze(analyzeOpts)
    while (!gate.release) await sleep(1)

    await sleep(40) // 8× the idle timeout — but a job is running, so NO teardown
    expect(children[0].killed).toBe(false)

    gate.release!()
    expect(await p).toBe(FIXTURE_ANSWER)
    await rt.stop()
  })

  it('resets the idle clock on every analyze — a re-used sidecar is never prematurely torn down', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 30 })

    await rt.analyze(analyzeOpts) // arms the idle timer (~30ms)
    await sleep(15) // < 30ms — not yet torn down
    await rt.analyze(analyzeOpts) // entry CANCELS the first timer and reuses the sidecar
    expect(calls.length).toBe(1) // reused — the first timer never fired a teardown
    expect(children[0].killed).toBe(false)

    await sleep(60) // now idle past the reset timeout
    expect(children[0].killed).toBe(true) // the rearmed timer eventually tears it down
    await rt.stop()
  })

  it('stop() cancels a pending idle timer (no teardown after a permanent stop)', async () => {
    const { spawn, children } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 20 })
    await rt.analyze(analyzeOpts)
    await rt.stop() // permanent teardown BEFORE the idle timer fires
    expect(children[0].killed).toBe(true)
    expect(children.length).toBe(1) // the (cancelled) idle timer never spawned/killed anything extra
    await sleep(40)
    expect(children.length).toBe(1)
  })
})
