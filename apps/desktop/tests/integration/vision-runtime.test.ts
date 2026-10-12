import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VisionAnalyzeError,
  VisionRuntime,
  type VisionAnalyzeOptions
} from '../../src/main/services/vision/runtime'
import { VisionService, type VisionStreamEmitter } from '../../src/main/services/vision'
import { EngineCannotRunError, resetEngineProblemsForTest } from '../../src/main/services/runtime/engine-load'
import type { ImageAnalyzeRequest, ImageJob, VisionStatus } from '../../src/shared/types'
import { until, within } from '../helpers/hang-budget'
import { FakeChild, GatedChild, fakeIdleClock, fakeSpawn, loadingSidecar, sseBody } from '../helpers/fake-sidecar'
import { pngHeader } from '../helpers/image-fixtures'

// V4 hardening tests for the real VisionRuntime (image-understanding plan §16 V4 / §17): lazy
// single-flight start, the failed-start latch, cancellation, NO orphan on a racing stop, and —
// the heart of V4 — the net-new idle-teardown interlock (RUNTIME-4): teardown after idle, the
// timer reset on every entry, NO teardown while a job runs, and a clean cold restart afterwards.
// No real binary is spawned: spawn/fetchImpl/findPort are injected (the e5/reranker seam).

// The verbatim b11146 vision capture (#518; provenance in tests/unit/vision-sse.test.ts).
const FIXTURE_SSE = readFileSync(
  join(__dirname, '../fixtures/vision/vision-sse-b11146.txt'),
  'utf8'
)
const FIXTURE_ANSWER = 'This is a German invoice issued by Müller & Söhne GmbH, and it is in German.'

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

/** A child that dies during its start (a corrupt GGUF, an OOM): it exits before /health ever answers. */
function dyingChild(code: number): FakeChild {
  const child = new FakeChild()
  queueMicrotask(() => child.crash(code))
  return child
}

/** A sidecar that never answers: every request is refused. */
const refusedFetch = (async () => {
  throw new Error('connection refused')
}) as unknown as typeof fetch

// ---- VisionService-level helpers (the #117 failed-start-recovery cases) ----------------------

const VLM_AVAILABLE: VisionStatus = { available: true, modelId: 'vlm', modelDisplayName: 'VLM' }

/** A request that passes the main-side guard: a parseable PNG header (SEC-6). */
function serviceReq(): ImageAnalyzeRequest {
  return { imageBytes: pngHeader(2, 2), mimeType: 'image/png', question: 'What is in this image?' }
}

/** Run one service analyze to its terminal job (done/failed/cancelled) via polling. */
async function runToTerminal(service: VisionService, req: ImageAnalyzeRequest): Promise<ImageJob> {
  const emit: VisionStreamEmitter = { token: () => {}, done: () => {}, error: () => {} }
  const initial = service.analyze(req, emit)
  if (initial.state === 'failed' || initial.state === 'cancelled') return initial
  const settled = (): boolean => ['done', 'failed', 'cancelled'].includes(service.getJob(initial.jobId).state)
  await until(settled, 'the vision job reaching a terminal state')
  return service.getJob(initial.jobId)
}

afterEach(() => vi.useRealTimers())

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
    expect(args).toContain('--device none') // CPU-pinned LM (V1-resolved)
    expect(args).toContain('--no-mmproj-offload') // projector on CPU too — b9849 offloads it to GPU by default (RUNTIME-6)
    expect(args).toContain('--parallel 1') // single slot — b9849 defaults to n_slots=4+unified KV (RUNTIME-5)
    expect(args).not.toContain('-np ') // VISION_SLOT_ARGS' own long form; the chat `-np 1` (#319) does not reach here
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

  it('forwards the caller abort signal to the chat request, and a user abort is not mis-mapped to timedOut (#123)', async () => {
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
    // Deterministically wait until the request has REACHED fetch (the signal was handed over)
    // before aborting — a fixed `sleep(2)` could fire before fetch under CPU starvation and
    // exercise a different (pre-flight) path. State-poll on the captured signal (TS-1).
    await until(() => seenSignal !== undefined, 'the analyze reaching the chat request')
    controller.abort()
    const err: unknown = await p.catch((e: unknown) => e)
    expect(String(err)).toMatch(/abort/i)
    expect(err).not.toBeInstanceOf(VisionAnalyzeError) // stays a plain abort → the service maps 'cancelled', never timedOut
    expect(seenSignal?.aborted).toBe(true)
    await rt.stop()
  })

  // #123: the two user-actionable runtime failures used to collapse into the generic
  // 'runtimeFailed'. The timeout-driven abort (the caller signal did NOT fire, so `combineSignals`'
  // timeout did) and llama-server's context-exceeded rejection now carry their own codes.
  it('maps the request-timeout abort to timedOut at the shipped 300 s bound (#123)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) // combineSignals' deadline is a plain setTimeout
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
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: hangingFetch, idleTimeoutMs: 100_000 })
    const outcome = rt.analyze(analyzeOpts).catch((e: unknown) => e)
    await until(() => seenSignal !== undefined, 'the analyze reaching the chat request')
    await vi.advanceTimersByTimeAsync(299_999)
    expect(seenSignal!.aborted).toBe(false) // 1 ms short of the 300 s per-analyze bound: still waiting
    await vi.advanceTimersByTimeAsync(1)
    const err = await within(outcome, 'the timed-out analyze settling')
    expect(err).toBeInstanceOf(VisionAnalyzeError)
    expect((err as VisionAnalyzeError).code).toBe('timedOut')
    await rt.stop()
  })

  it('maps the llama-server context-exceeded rejection to contextExceeded (#123)', async () => {
    const { spawn } = fakeSpawn()
    const overflowFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      // The documented b9849 rejection shape (known-limitations "exceed_context_size_error").
      return {
        ok: false,
        status: 400,
        text: async () =>
          '{"error":{"code":400,"message":"the request exceeds the available context size","type":"exceed_context_size_error"}}'
      } as unknown as Response
    }) as typeof fetch
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: overflowFetch, idleTimeoutMs: 100_000 })
    const err = (await rt.analyze(analyzeOpts).catch((e) => e)) as VisionAnalyzeError
    expect(err).toBeInstanceOf(VisionAnalyzeError)
    expect(err.code).toBe('contextExceeded')
    await rt.stop()
  })

  it('a llama-server 400 that is not a context overflow stays a plain error (→ runtimeFailed in the service)', async () => {
    const { spawn } = fakeSpawn()
    const failingFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      return {
        ok: false,
        status: 400,
        text: async () =>
          '{"error":{"code":400,"message":"failed to process image","type":"invalid_request_error"}}'
      } as unknown as Response
    }) as typeof fetch
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: failingFetch, idleTimeoutMs: 100_000 })
    const err = await rt.analyze(analyzeOpts).catch((e) => e)
    expect(err).not.toBeInstanceOf(VisionAnalyzeError)
    expect(String(err)).toContain('HTTP 400')
    await rt.stop()
  })

  it('the typed code rides the job to the renderer as job.error (#123, service mapping)', async () => {
    const service = new VisionService({
      getStatus: async () => VLM_AVAILABLE,
      createRuntime: () => ({
        analyze: async () => {
          throw new VisionAnalyzeError('timedOut', 'Vision request timed out after 300000 ms')
        }
      })
    })
    const job = await runToTerminal(service, serviceReq())
    expect(job.state).toBe('failed')
    expect(job.error).toBe('timedOut')
    await service.stop()
  })

  it('stop() during the in-flight lazy start is permanent: a later analyze refuses and spawns nothing', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(visionFetch().fetchImpl)
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl })
    const p = rt.analyze(analyzeOpts).catch(() => undefined)
    await until(() => state.probes > 0, 'the cold start polling /health')
    await rt.stop() // quit/lock while still starting — sidecar-teardown-abort owns the #244 kill + settle bound
    await within(p, 'the aborted start ending the analyze')
    expect(children[0].killed).toBe(true) // precondition: the start's child went with the stop
    state.loaded = true // a restart would now come up healthy at once, so only the stop latch can refuse it
    await expect(rt.analyze(analyzeOpts)).rejects.toThrow(/stopped/)
    expect(calls.length).toBe(1) // the refused analyze spawned nothing
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
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('(b) an analyze mid-soft-teardown cold-starts a fresh child (this.server nulled synchronously)', async () => {
    const { spawn, calls, children } = fakeSpawn(() => new GatedChild())
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeIdleClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })

    await rt.analyze(analyzeOpts) // child0 live; the idle cb is captured
    expect(calls.length).toBe(1)
    state.fire!() // child0's exit waits for releaseExit(), so the soft teardown stays IN FLIGHT
    expect(children[0].killed).toBe(true)

    // server === null while the old child is still stopping → this analyze cold-starts a NEW child.
    const answer = await rt.analyze(analyzeOpts)
    expect(answer).toBe(FIXTURE_ANSWER)
    expect(calls.length).toBe(2)
    expect(children.length).toBe(2)

    for (const child of children) child.releaseExit() // let both exits through
    await rt.stop()
  })

  it('(c) stop() during an in-flight soft teardown AWAITS it (no orphan)', async () => {
    const { spawn, children } = fakeSpawn(() => new GatedChild())
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeIdleClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })

    await rt.analyze(analyzeOpts)
    state.fire!() // soft teardown now in flight (gated open)
    expect(children[0].killed).toBe(true)

    let stopResolved = false
    const stopP = rt.stop().then(() => {
      stopResolved = true
    })
    await tick()
    await tick()
    expect(stopResolved).toBe(false) // stop() is AWAITING idleTeardownPromise — cannot have resolved

    children[0].releaseExit() // unblock the teardown
    await stopP
    expect(stopResolved).toBe(true)
    expect(children.length).toBe(1) // no orphan, no extra child spawned
  })

  it("(e) the idle timer is unref'd so it can never block a clean quit", async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeIdleClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.analyze(analyzeOpts) // settles → arms the idle timer
    expect(state.setCount).toBeGreaterThan(0)
    expect(state.unrefCount).toBe(state.setCount) // every armed idle timer was unref'd
    await rt.stop()
  })

  it('(a) a stale idle fire is a no-op while a job is in flight (the inFlight guard)', async () => {
    const { spawn, calls, children } = fakeSpawn()
    let chatCount = 0
    const gate: { release: (() => void) | null } = { release: null }
    const gatedFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      chatCount++
      if (chatCount >= 2) await new Promise<void>((resolve) => (gate.release = resolve))
      return { ok: true, status: 200, body: sseBody(FIXTURE_SSE) } as unknown as Response
    }) as typeof fetch
    const { clock, state } = fakeIdleClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: gatedFetch, idleClock: clock })

    await rt.analyze(analyzeOpts) // chat #1 completes → child0; an idle cb is armed (state.fire)
    const staleCb = state.fire! // capture it BEFORE the next analyze cancels the timer
    const p2 = rt.analyze(analyzeOpts) // chat #2 gates → inFlight=1, child0 reused
    await until(() => gate.release !== null, 'the second analyze reaching its gated chat request')

    // Simulate a timer that FIRED racing the cancel (cb already dispatched): idleTeardown must
    // SKIP because a job is in flight (inFlight>0) and never tear down the live sidecar.
    staleCb()
    expect(children[0].killed).toBe(false)
    expect(calls.length).toBe(1) // the in-flight job's sidecar was never torn down

    gate.release!()
    expect(await p2).toBe(FIXTURE_ANSWER)
    await rt.stop()
  })

  // (d) PORTED from the deleted real-timer "resets the idle clock on every analyze" case (TEST-1):
  // a re-used sidecar must never be torn down by the FIRST (now-cancelled) timer. Deterministic:
  // assert via the clock that re-entry CLEARED T1 and re-armed T2, then fire T2 to confirm the
  // rearmed timer is the one that tears the idle sidecar down — no `sleep(15)`/`sleep(60)` race.
  it('(d) re-entry RESETS the idle clock — a reused sidecar is never torn down by the stale timer', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeIdleClock()
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
    const { spawn, children } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const { clock, state } = fakeIdleClock()
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

  // R7 (full-audit-2026-06-30, Phase C): analyze()'s `finally` armIdleTimer() vs a concurrent stop()
  // is unsynchronized across the await. The literal race is ALREADY closed — TWICE — inside
  // armIdleTimer (it returns early on `this.stopped` AND on `!this.server`, both of which stop() sets
  // synchronously before any await), so a timer can't even be armed in the window. This is a
  // PROPERTY/regression guard for that interlock (no idle timer survives a stop() racing an analyze
  // settle); the re-cancel after stop()'s awaits is a third, defense-in-depth backstop that makes
  // stop()'s "no live idle timer on return" postcondition LOCAL (independent of armIdleTimer's
  // guards) — it only becomes load-bearing if a future refactor weakens BOTH of those checks.
  it('(g) no idle timer survives a stop() that races an analyze settling (R7)', async () => {
    const { spawn } = fakeSpawn()
    const { clock, state } = fakeIdleClock()
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>((r) => (releaseFetch = r))
    let chatCount = 0
    const gatedFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      chatCount++
      await fetchGate // hold the analyze in flight so its settle can be raced against stop()
      return { ok: true, status: 200, body: sseBody(FIXTURE_SSE) } as unknown as Response
    }) as typeof fetch
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl: gatedFetch, idleClock: clock })

    const p = rt.analyze(analyzeOpts) // in flight; the idle timer is cancelled while inFlight > 0
    await until(() => chatCount > 0, 'the analyze reaching the gated chat request')

    // stop() begins (sets `stopped` synchronously) and the analyze settles in its window: its
    // `finally` calls armIdleTimer(), which must NOT arm a timer that outlives the teardown.
    const stopP = rt.stop()
    releaseFetch()
    await Promise.allSettled([p, stopP])

    expect(state.fire).toBeNull() // no idle timer armed/left live after the racing stop()
  })

  // #637: a cancelled analyze no longer waits for its cold start, so its `finally` runs while the
  // start is still in flight — and armIdleTimer returns early on `starting`. The start's own
  // settle must arm the clock, or a start that lands with nobody waiting stays resident until
  // lock or quit.
  it('(h) a start that lands after every analyze was cancelled arms the idle clock, and its fire tears it down (#637)', async () => {
    const { spawn, children } = fakeSpawn()
    const { fetchImpl, state: start } = loadingSidecar(visionFetch().fetchImpl)
    const { clock, state } = fakeIdleClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })

    const cancel = new AbortController()
    const cancelled = rt.analyze({ ...analyzeOpts, signal: cancel.signal }).catch(() => undefined)
    await until(() => start.probes > 0, 'the cold start polling /health')
    cancel.abort()
    await within(cancelled, 'the cancel ending the wait for the start')
    expect(state.fire).toBeNull() // the analyze settled while the start was still loading

    start.loaded = true
    await until(() => rt.isLoaded(), 'the abandoned start landing')
    expect(state.fire).not.toBeNull() // armed by the start's settle, with no analyze in flight
    state.fire!()
    expect(children[0].killed).toBe(true)
    expect(rt.isLoaded()).toBe(false)
    await rt.stop()
  })

  // M1 (F-14): the TA-6 crash-recovery fix ported verbatim from translation/runtime.ts. A healthy
  // vision child that dies on its OWN (OOM — the three-process RAM peak makes 12 GB machines
  // likely-OOM) must not leave `this.server` pointing at a dead handle where every later analyze
  // fails 'runtimeFailed' until a full idle window elapses. The onUnexpectedExit hook drops the
  // dead handle so the next analyze cold-starts. Mirrors translation-runtime.test.ts's M1 cases.
  it('recovers from a mid-session sidecar CRASH: the next analyze cold-starts a fresh child (M1)', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const { clock } = fakeIdleClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.analyze(analyzeOpts)
    expect(calls.length).toBe(1)
    // The child dies on its OWN (OOM) after having been healthy, outside stop() — a real 'exit'.
    // LlamaServer fires onUnexpectedExit, and the runtime drops the dead handle so the next
    // analyze cold-starts instead of failing forever against a stale server.
    children[0].crash(137) // 137 = OOM-killed
    await tick()
    const answer = await rt.analyze(analyzeOpts)
    expect(answer).toBe(FIXTURE_ANSWER)
    expect(calls.length).toBe(2) // cold-started a fresh child rather than reusing the dead one
    await rt.stop()
  })

  // #117 (alongside the F-14/M1 pin above): F-14 recovers a child that dies AFTER becoming
  // healthy; a child that dies DURING start used to latch forever — `startFailed` is sticky and
  // `VisionService` never discarded the cached runtime, so ONE transient cold-start failure
  // (OOM under RAM pressure, the startup port race) bricked image understanding for the rest
  // of the session and made "Try again" permanently misleading. The service now discards a
  // start-failed runtime and rebuilds fresh past a short cooldown.
  it('recovers from a FAILED start: once the 5 s cooldown has passed the next analyze rebuilds a fresh runtime (#117)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }) // the cooldown reads Date.now(); frozen, it moves only when the test moves it
    const t0 = Date.now()
    const { fetchImpl } = visionFetch()
    let spawned = 0
    const { spawn } = fakeSpawn(() => (++spawned === 1 ? dyingChild(137) : new FakeChild())) // the first start dies (transient OOM)
    const failingFetch = (async (url: string | URL, init?: RequestInit) => {
      if (spawned === 1) throw new Error('connection refused') // the dead first child never answers /health
      return fetchImpl(url, init)
    }) as typeof fetch
    let built = 0
    const service = new VisionService({
      getStatus: async () => VLM_AVAILABLE,
      createRuntime: () => {
        built++
        return new VisionRuntime({ ...base, spawn, fetchImpl: failingFetch, idleTimeoutMs: 100_000 })
      }
    })

    const first = await runToTerminal(service, serviceReq())
    expect(first.state).toBe('failed')
    expect(first.error).toBe('runtimeFailed')

    vi.setSystemTime(t0 + 5_000) // exactly the shipped VISION_START_FAILURE_COOLDOWN_MS: the window is over
    // The user's retry: the start-failed runtime was DISCARDED, a fresh one is built + spawned.
    const second = await runToTerminal(service, serviceReq())
    expect(second.state).toBe('done')
    expect(second.answer).toBe(FIXTURE_ANSWER)
    expect(built).toBe(2)
    expect(spawned).toBe(2)
    await service.stop()
  })

  it('fails FAST inside the 5 s start-failure cooldown — no re-spawn per retry (corrupt-GGUF case, #117)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    const { spawn, calls } = fakeSpawn(() => dyingChild(1)) // dies every time (corrupt GGUF)
    let built = 0
    const service = new VisionService({
      getStatus: async () => VLM_AVAILABLE,
      createRuntime: () => {
        built++
        return new VisionRuntime({ ...base, spawn, fetchImpl: refusedFetch })
      }
    })

    expect((await runToTerminal(service, serviceReq())).error).toBe('runtimeFailed')
    vi.setSystemTime(t0 + 4_999) // 1 ms short of the shipped window
    // A retry INSIDE the window fast-fails without building or spawning anything new.
    expect((await runToTerminal(service, serviceReq())).error).toBe('runtimeFailed')
    expect(built).toBe(1)
    expect(calls.length).toBe(1)
    await service.stop()
  })

  it('isStartFailed() reports the latch (false before/after a healthy start, true after a failed one), and a latched runtime refuses without re-spawning', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const healthy = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    expect(healthy.isStartFailed()).toBe(false)
    await healthy.analyze(analyzeOpts)
    expect(healthy.isStartFailed()).toBe(false)
    await healthy.stop()

    const dyingSpawn = fakeSpawn(() => dyingChild(1))
    const dying = new VisionRuntime({ ...base, spawn: dyingSpawn.spawn, fetchImpl: refusedFetch })
    await expect(dying.analyze(analyzeOpts)).rejects.toThrow()
    expect(dying.isStartFailed()).toBe(true)
    await expect(dying.analyze(analyzeOpts)).rejects.toThrow() // carried from the retired "latches a failed start" row
    expect(dyingSpawn.calls.length).toBe(1) // the latch refused without a second spawn + health wait
    await dying.stop()
  })

  // #656: Node can report one death twice — an 'error' (the process is gone) and later its 'exit' — and
  // LlamaServer passes both on as onUnexpectedExit. By the second report an analyze has cold-started a
  // NEWER child; dropping the handle again (no `this.server === server` check) would strand it and
  // spawn a third. (A late 'exit' after a soft idle teardown reaches no listener, so it cannot test this.)
  it("a dead child's second death report does NOT clobber the newer instance (identity-compared, #656)", async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const { clock } = fakeIdleClock()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.analyze(analyzeOpts) // child0
    children[0].emit('error', new Error('read ECHILD')) // first report: M1 drops the dead handle
    await rt.analyze(analyzeOpts) // cold-starts child1, the NEWER instance
    expect(calls.length).toBe(2)
    children[0].crash(137) // the late 'exit' of the same death
    expect(await rt.analyze(analyzeOpts)).toBe(FIXTURE_ANSWER)
    expect(calls.length).toBe(2) // child1 reused, no third spawn
    expect(rt.isLoaded()).toBe(true)
    await rt.stop()
  })
})

// #530: the OS loader refused the engine program — the service reports `engineCannotRun` (not the
// generic `runtimeFailed`), repeats it inside the cooldown, and "Check again" drops the cooldown.
describe('VisionService — OS loader refusal (#530)', () => {
  // the cooldown is the shipped 5 s: a frozen Date keeps every retry here inside it, however slow the worker
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
  afterEach(() => resetEngineProblemsForTest())

  const refusal = () =>
    new EngineCannotRunError('llama-server', {
      family: 'llama_cpp',
      reason: 'library-missing',
      os: 'linux',
      name: 'libgomp.so.1',
      exit: 'exit code 127'
    })

  function refusingService() {
    let built = 0
    let healthy = false
    const service = new VisionService({
      getStatus: async () => VLM_AVAILABLE,
      createRuntime: () => {
        built++
        return {
          analyze: async () => {
            if (healthy) return FIXTURE_ANSWER
            throw refusal()
          },
          isStartFailed: () => !healthy
        }
      }
    })
    return { service, built: () => built, heal: () => (healthy = true) }
  }

  it('resetStartFailure() drops the cooldown so the next analyze builds a fresh runtime', async () => {
    const { service, built, heal } = refusingService()
    expect((await runToTerminal(service, serviceReq())).error).toBe('engineCannotRun')
    service.resetStartFailure()
    heal()
    const next = await runToTerminal(service, serviceReq())
    expect(next.state).toBe('done')
    expect(built()).toBe(2)
    await service.stop()
  })

  it('a real VisionRuntime whose sidecar the loader refuses ends engineCannotRun (one spawn)', async () => {
    const { spawn, calls } = fakeSpawn(() => {
      const child = new FakeChild()
      const stderr = new EventEmitter()
      ;(child as unknown as { stderr: EventEmitter }).stderr = stderr
      queueMicrotask(() => {
        stderr.emit(
          'data',
          '/media/someone/HR/runtime/llama.cpp/linux/llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'
        )
        child.crash(127)
        child.emit('close', 127, null)
      })
      return child
    })
    const service = new VisionService({
      getStatus: async () => VLM_AVAILABLE,
      createRuntime: () => new VisionRuntime({ ...base, spawn, fetchImpl: refusedFetch })
    })
    expect((await runToTerminal(service, serviceReq())).error).toBe('engineCannotRun')
    expect((await runToTerminal(service, serviceReq())).error).toBe('engineCannotRun')
    expect(calls.length).toBe(1)
    await service.stop()
  })
})

// #637: an analyze awaited the vision sidecar's lazy start before its signal reached anything, so a
// cancel during a start that hung held the job — and VisionService's busy slot — up to the 180 s
// health budget. The cancel now ends only that analyze's wait; the start goes on for the next one.
describe('#637 — a cancel during the vision cold start', () => {
  it('ends that analyze at once with its own reason; an analyze sharing the start gets its answer', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(visionFetch().fetchImpl)
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })

    const cancel = new AbortController()
    const cancelled = rt.analyze({ ...analyzeOpts, signal: cancel.signal }).catch((e: unknown) => e)
    await until(() => state.probes > 0, 'the cold start polling /health')
    const other = rt.analyze(analyzeOpts) // the next analyze joins the same start
    const reason = new DOMException('Cancelled by the user', 'AbortError')
    cancel.abort(reason)
    // The analyze's own reason, which the service reads as `cancelled` (its signal is aborted).
    expect(await within(cancelled, 'the cancel ending the wait for the start')).toBe(reason)

    state.loaded = true
    expect(await within(other, 'the shared start serving the other analyze')).toBe(FIXTURE_ANSWER)
    expect(children[0].killed).toBe(false) // the cancel never cancelled the start
    expect(calls.length).toBe(1)
    await rt.stop()
  })

  it('an analyze cancelled before it begins starts no sidecar', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = visionFetch()
    const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    const reason = new DOMException('Cancelled by the user', 'AbortError')
    await expect(rt.analyze({ ...analyzeOpts, signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(calls.length).toBe(0)
    await rt.stop()
  })

  it('VisionService: the cancelled job frees the busy slot at once, and the next job joins its start', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(visionFetch().fetchImpl)
    const service = new VisionService({
      getStatus: async () => VLM_AVAILABLE,
      createRuntime: () => new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    })
    const emit: VisionStreamEmitter = { token: () => {}, done: () => {}, error: () => {} }

    const first = service.analyze(serviceReq(), emit)
    await until(() => state.probes > 0, 'the cold start polling /health')
    expect(service.cancel(first.jobId).state).toBe('cancelled')
    // Before #637 the slot stayed taken until the start landed: a new analysis read "busy".
    await until(() => !service.hasActiveJob(), 'the cancelled job freeing the busy slot')

    const next = service.analyze(serviceReq(), emit)
    expect(next.state).toBe('queued')
    await until(() => service.getJob(next.jobId).state === 'analyzing', 'the next job reaching the runtime')
    expect(calls.length).toBe(1) // waiting on the same start: the abandoned job sent no request
    state.loaded = true
    await until(() => service.getJob(next.jobId).state === 'done', 'the next job finishing')
    expect(service.getJob(next.jobId).answer).toBe(FIXTURE_ANSWER)
    expect(calls.length).toBe(1)
    await service.stop()
  })

  // The cancelled job is gone by the time its start fails, so run()'s catch — which discards a
  // start-failed runtime (#117) — never sees the failure. The next job must not inherit it.
  it('VisionService: a start that fails after its cancelled job left does not fail the next job', async () => {
    const { spawn, children } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(visionFetch().fetchImpl)
    const runtimes: VisionRuntime[] = []
    const service = new VisionService({
      getStatus: async () => VLM_AVAILABLE,
      createRuntime: () => {
        const rt = new VisionRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
        runtimes.push(rt)
        return rt
      }
    })
    const emit: VisionStreamEmitter = { token: () => {}, done: () => {}, error: () => {} }

    const first = service.analyze(serviceReq(), emit)
    await until(() => state.probes > 0, 'the cold start polling /health')
    service.cancel(first.jobId)
    await until(() => !service.hasActiveJob(), 'the cancelled job freeing the busy slot')
    children[0].crash(1) // the abandoned start dies while loading
    await until(() => runtimes[0].isStartFailed(), 'the abandoned start failing')
    state.loaded = true // the next child answers at once

    const next = await runToTerminal(service, serviceReq())
    expect(next.state).toBe('done')
    expect(next.answer).toBe(FIXTURE_ANSWER)
    expect(runtimes.length).toBe(2) // a fresh runtime, not the latched one
    expect(children.length).toBe(2)
    await service.stop()
  })
})
