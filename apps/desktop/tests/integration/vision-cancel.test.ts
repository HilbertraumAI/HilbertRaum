import { describe, it, expect, vi } from 'vitest'
import { VisionService, type VisionStreamEmitter } from '../../src/main/services/vision'
import type { ImageAnalyzeRequest, VisionStatus } from '../../src/shared/types'

// F18 (full-audit-2026-06-29-postmerge): the VisionService terminal `done` write must NOT resurrect
// a job the user cancelled mid-flight (nor re-fire emit.done). The write now routes through the
// cancelled-guarded `set()` helper (returning whether it applied) instead of a raw `this.jobs.set`.
//
// This is a LATENT guard: in the current control flow the `signal.aborted` check one statement
// before the done write already catches a concurrent cancel (there is no `await` between them), so
// the scenario is double-guarded. The `set()` routing is defense-in-depth against a refactor that
// inserts an `await` there (or moves the abort check) — exactly what the audit flagged. This test
// pins the END-STATE contract; the teeth-check that the `set()` routing is load-bearing is the
// dual-neuter recorded in the architecture §-ledger (remove the abort check AND the set() guard →
// the cancelled job is resurrected to `done` + emit.done re-fires).

const AVAILABLE: VisionStatus = { available: true, modelId: 'vlm', modelDisplayName: 'VLM' }

// A valid PNG header (8-byte signature + IHDR width@16/height@20) so the main-side guard accepts it.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0, 0, 0, 0, 0, 0, 0, 0, // IHDR length + "IHDR" tag
  0, 0, 0, 2, 0, 0, 0, 2 // width@16 = 2, height@20 = 2
])

const req = (): ImageAnalyzeRequest => ({
  imageBytes: PNG_BYTES,
  mimeType: 'image/png',
  question: 'what is in this image'
})

// Deterministic queue-drain (NOT a wall-clock wait): each `await tick()` flushes the macrotask
// boundary, which first drains all pending microtasks. `while (cond) await tick()` re-checks an
// observable until run() is provably at the interleave point — no `setTimeout(r, N)` race (T1).
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('VisionService cancel vs terminal completion (F18)', () => {
  it('a cancel that races completion does not resurrect the job to done or fire emit.done', async () => {
    let resolveAnalyze!: (answer: string) => void
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      // A runtime that streams a token, then hangs until the test resolves it — letting the test
      // inject a cancel() while run() is parked on the analyze await.
      createRuntime: () => ({
        analyze: (o: { onToken?: (d: string) => void }) =>
          new Promise<string>((res) => {
            resolveAnalyze = res
            o.onToken?.('partial ')
          })
      })
    })

    const emit: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job = service.analyze(req(), emit)
    expect(job.state).toBe('queued')

    // Let run() reach the analyze await (status resolved, onToken fired once).
    const tokenSpy = emit.token as ReturnType<typeof vi.fn>
    while (tokenSpy.mock.calls.length === 0) await tick()

    // The user cancels mid-flight.
    expect(service.cancel(job.jobId).state).toBe('cancelled')

    // A (misbehaving) runtime then resolves a full, non-empty answer AFTER the cancel. run()'s
    // continuation after `await runtime.analyze(...)` is synchronous (the abort re-check → return, or
    // — under a neuter — the guarded terminal `done` write), so a single queue-drain deterministically
    // flushes it: in the GOOD case nothing changes; under the F18 dual-neuter emit.done fires and the
    // assertions below redden. No fixed `sleep(5)`.
    resolveAnalyze('a complete answer')
    await tick()
    await tick()

    // The terminal write was guarded: the job stays cancelled and emit.done never fired.
    expect(service.getJob(job.jobId).state).toBe('cancelled')
    expect(emit.done).not.toHaveBeenCalled()
  })

  // #120 item 3 (cancel slot-release window): cancel() used to null `activeJobId` synchronously
  // while the aborted runtime call was still unwinding, so a new analyze admitted in that window
  // ran CONCURRENTLY against the `--parallel 1` sidecar (queueing server-side behind the draining
  // request — the RUNTIME-5 single-slot-server regression class). The slot is now held until
  // run()'s `finally`, i.e. until the aborted request fully unwound.
  it('holds the busy slot until the aborted request unwinds — an immediate analyze busy-rejects', async () => {
    let releaseUnwind!: () => void
    const unwindGate = new Promise<void>((r) => (releaseUnwind = r))
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      // A runtime whose in-flight request does NOT unwind at the abort instant: on abort it
      // waits for the test's gate, then rejects — modelling the sidecar draining the request.
      createRuntime: () => ({
        analyze: (o: { signal?: AbortSignal; onToken?: (d: string) => void }) =>
          new Promise<string>((_res, rej) => {
            o.onToken?.('partial ')
            o.signal?.addEventListener('abort', () => {
              void unwindGate.then(() => rej(new DOMException('Aborted', 'AbortError')))
            })
          })
      })
    })

    const emit: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job = service.analyze(req(), emit)
    const tokenSpy = emit.token as ReturnType<typeof vi.fn>
    while (tokenSpy.mock.calls.length === 0) await tick()

    // Cancel — the abort fired, but the runtime call has NOT unwound yet (the gate holds it).
    expect(service.cancel(job.jobId).state).toBe('cancelled')

    // An analyze in the drain window must be busy-REJECTED, never run concurrently.
    const during = service.analyze(req(), emit)
    expect(during.state).toBe('failed')
    expect(during.error).toBe('busy')

    // Once the aborted request fully unwinds, the slot frees and a new analyze is admitted.
    releaseUnwind()
    let accepted = false
    for (let i = 0; i < 400 && !accepted; i++) {
      await tick()
      const attempt = service.analyze(req(), emit)
      if (attempt.error !== 'busy') {
        expect(attempt.state).toBe('queued')
        accepted = true
      }
    }
    expect(accepted).toBe(true)
    await service.stop() // aborts the (hanging) accepted job so nothing dangles past the test
  })

  it('still completes normally when no cancel intervenes (happy-path regression)', async () => {
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      createRuntime: () => ({
        analyze: async (o: { onToken?: (d: string) => void }) => {
          o.onToken?.('a bar chart')
          return 'a bar chart'
        }
      })
    })
    const emit: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job = service.analyze(req(), emit)

    const doneSpy = emit.done as ReturnType<typeof vi.fn>
    while (doneSpy.mock.calls.length === 0) await tick()

    expect(service.getJob(job.jobId).state).toBe('done')
    expect(service.getJob(job.jobId).answer).toBe('a bar chart')
    expect(emit.done).toHaveBeenCalledTimes(1)
  })
})
