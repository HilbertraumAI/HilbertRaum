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

// TEST-1 (full-audit-2026-06-29 follow-up, Phase 7): the flaky real-timer idle-teardown block that
// used to live here (it raced real `setTimeout`s against tiny `idleTimeoutMs` in BOTH directions —
// `sleep(15)` asserting not-yet-torn-down, `sleep(60)` asserting torn-down — a spurious-red shape
// under CI load, the known T6/T7 residual) has been DELETED. Every case it covered is now asserted
// DETERMINISTICALLY by the injected-clock twin below: teardown-after-idle + cold restart → (b),
// in-flight guard → (a), clock reset → (d), stop()-cancels-timer → (f). No idle `sleep` remains.

// TEST-2: the same interlock, but DETERMINISTIC. Instead of `sleep`-ordering a real idle timer,
// we inject a controllable clock (fire the teardown ON DEMAND) and a child whose exit we GATE
// (hold the soft-teardown window open). This races the exact guard branches the design comments
// emphasize: removing a guard (`this.starting`/`inFlight`, the synchronous `this.server = null`,
// the `stop()` await of `idleTeardownPromise`, the `unref`) reddens a test here.
describe('VisionRuntime — idle-teardown interlock, deterministic (RUNTIME-4 / TEST-2)', () => {
  /** A child whose 'exit' we control: `hold=true` makes kill() NOT emit, `release()` emits it. */
  class GatedChild extends EventEmitter implements ChildProcessLike {
    pid = 9
    killed = false
    hold = false
    kill(): boolean {
      this.killed = true
      if (!this.hold) queueMicrotask(() => this.emit('exit', 0, null))
      return true
    }
    release(): void {
      queueMicrotask(() => this.emit('exit', 0, null))
    }
  }

  function gatedSpawn() {
    const calls: Array<{ args: string[] }> = []
    const children: GatedChild[] = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new GatedChild()
      children.push(child)
      return child
    }
    return { spawn, calls, children }
  }

  /** A controllable idle clock: captures the latest scheduled cb (fire it by hand) + set/clear/unref
   *  counts so re-arm (clock reset) and cancel (stop) are observable without a wall-clock wait. */
  function fakeClock() {
    const state = { fire: null as (() => void) | null, setCount: 0, clearCount: 0, unrefCount: 0 }
    const clock = {
      set(cb: () => void) {
        state.setCount++
        state.fire = cb
        return {
          clear: () => {
            state.clearCount++
            if (state.fire === cb) state.fire = null
          },
          unref: () => {
            state.unrefCount++
          }
        }
      }
    }
    return { clock, state }
  }

  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('(b) an analyze mid-soft-teardown cold-starts a fresh child (this.server nulled synchronously)', async () => {
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })

    await rt.analyze(analyzeOpts) // child0 live; the idle cb is captured
    expect(calls.length).toBe(1)
    children[0].hold = true // hold child0's exit so the soft teardown stays IN FLIGHT
    state.fire!() // fire the idle teardown: nulls this.server synchronously, kills child0 (gated)
    expect(children[0].killed).toBe(true)

    // server === null while the old child is still stopping → this analyze cold-starts a NEW child.
    const answer = await rt.analyze(analyzeOpts)
    expect(answer).toBe(FIXTURE_ANSWER)
    expect(calls.length).toBe(2)
    expect(children.length).toBe(2)

    children[0].release() // let the held teardown finish
    await rt.stop()
  })

  it('(c) stop() during an in-flight soft teardown AWAITS it (no orphan)', async () => {
    const { spawn, children } = gatedSpawn()
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })

    await rt.analyze(analyzeOpts)
    children[0].hold = true
    state.fire!() // soft teardown now in flight (gated open)
    expect(children[0].killed).toBe(true)

    let stopResolved = false
    const stopP = rt.stop().then(() => {
      stopResolved = true
    })
    await tick()
    await tick()
    expect(stopResolved).toBe(false) // stop() is AWAITING idleTeardownPromise — cannot have resolved

    children[0].release() // unblock the teardown
    await stopP
    expect(stopResolved).toBe(true)
    expect(children.length).toBe(1) // no orphan, no extra child spawned
  })

  it("(e) the idle timer is unref'd so it can never block a clean quit", async () => {
    const { spawn } = gatedSpawn()
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.analyze(analyzeOpts) // settles → arms the idle timer
    expect(state.setCount).toBeGreaterThan(0)
    expect(state.unrefCount).toBe(state.setCount) // every armed idle timer was unref'd
    await rt.stop()
  })

  it('(a) a stale idle fire is a no-op while a job is in flight (the inFlight guard)', async () => {
    const { spawn, calls, children } = gatedSpawn()
    let chatCount = 0
    const gate: { release: (() => void) | null } = { release: null }
    const gatedFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      chatCount++
      if (chatCount >= 2) await new Promise<void>((resolve) => (gate.release = resolve))
      return { ok: true, status: 200, body: sseBody(FIXTURE_SSE) } as unknown as Response
    }) as typeof fetch
    const { clock, state } = fakeClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: gatedFetch, idleClock: clock })

    await rt.analyze(analyzeOpts) // chat #1 completes → child0; an idle cb is armed (state.fire)
    const staleCb = state.fire! // capture it BEFORE the next analyze cancels the timer
    const p2 = rt.analyze(analyzeOpts) // chat #2 gates → inFlight=1, child0 reused
    while (!gate.release) await tick()

    // Simulate a timer that FIRED racing the cancel (cb already dispatched): idleTeardown must
    // SKIP because a job is in flight (inFlight>0) and never tear down the live sidecar.
    staleCb()
    expect(children[0].killed).toBe(false)
    expect(calls.length).toBe(1) // the in-flight job's sidecar was never torn down

    gate.release()
    expect(await p2).toBe(FIXTURE_ANSWER)
    await rt.stop()
  })

  // (d) PORTED from the deleted real-timer "resets the idle clock on every analyze" case (TEST-1):
  // a re-used sidecar must never be torn down by the FIRST (now-cancelled) timer. Deterministic:
  // assert via the clock that re-entry CLEARED T1 and re-armed T2, then fire T2 to confirm the
  // rearmed timer is the one that tears the idle sidecar down — no `sleep(15)`/`sleep(60)` race.
  it('(d) re-entry RESETS the idle clock — a reused sidecar is never torn down by the stale timer', async () => {
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })

    await rt.analyze(analyzeOpts) // settles → arms idle timer T1
    expect(state.setCount).toBe(1)
    const staleCb = state.fire! // T1's callback

    await rt.analyze(analyzeOpts) // re-entry CANCELS T1 and re-arms T2; the sidecar is REUSED
    expect(calls.length).toBe(1) // reused — NOT a cold restart
    expect(children[0].killed).toBe(false)
    expect(state.clearCount).toBe(1) // T1 was cancelled on re-entry (the clock reset)
    expect(state.setCount).toBe(2) // a fresh timer (T2) was armed
    expect(state.fire).not.toBe(staleCb) // the armed timer is T2, not the stale T1

    // The REARMED timer (T2), when it fires, tears the now-idle sidecar down.
    state.fire!()
    expect(children[0].killed).toBe(true)
    await rt.stop()
  })

  // (f) PORTED from the deleted real-timer "stop() cancels a pending idle timer" case (TEST-1):
  // a permanent stop() before the idle timer fires must cancel it and leave nothing extra spawned/
  // killed. Deterministic: assert the clock recorded the cancel, then fire the captured stale cb by
  // hand and confirm the `stopped` guard makes it inert — no `sleep(40)` "assert nothing happened".
  it('(f) stop() CANCELS a pending idle timer — a later stale fire is inert (no extra child)', async () => {
    const { spawn, children } = gatedSpawn()
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })

    await rt.analyze(analyzeOpts) // arms the idle timer
    expect(state.setCount).toBe(1)
    const staleCb = state.fire!

    await rt.stop() // permanent teardown BEFORE the idle timer fires
    expect(children[0].killed).toBe(true)
    expect(state.clearCount).toBeGreaterThanOrEqual(1) // stop() cancelled the pending idle timer
    expect(children.length).toBe(1)

    // Even a stale timer that somehow fired AFTER stop() is a no-op (the `stopped` guard in
    // idleTeardown), so it can never resurrect or double-kill the sidecar post-quit.
    staleCb()
    await tick()
    expect(children.length).toBe(1) // nothing extra spawned or killed
  })
})
