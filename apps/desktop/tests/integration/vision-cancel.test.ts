import { describe, it, expect, vi } from 'vitest'
import { VisionService, type VisionStreamEmitter } from '../../src/main/services/vision'
import type { ImageAnalyzeRequest, VisionStatus } from '../../src/shared/types'
import { until } from '../helpers/hang-budget'
import { pngHeader } from '../helpers/image-fixtures'

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

const req = (): ImageAnalyzeRequest => ({
  imageBytes: pngHeader(2, 2), // a parseable PNG header (SEC-6)
  mimeType: 'image/png',
  question: 'what is in this image'
})

// Deterministic queue-drain for the single hops after a resolve (each `await tick()` crosses one
// macrotask boundary, draining the microtasks); waits for a state go through `until`
// (tests/helpers/hang-budget.ts).
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('VisionService cancel vs terminal completion (F18)', () => {
  it('a cancel that races completion does not resurrect the job to done or fire emit.done', async () => {
    let resolveAnalyze!: (answer: string) => void
    const service = new VisionService({
      isWorkspaceLocking: () => false,
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
    await until(() => tokenSpy.mock.calls.length > 0, 'run() reaching the analyze await')

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
      isWorkspaceLocking: () => false,
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
    await until(() => tokenSpy.mock.calls.length > 0, 'run() reaching the analyze await')

    // Cancel — the abort fired, but the runtime call has NOT unwound yet (the gate holds it).
    expect(service.cancel(job.jobId).state).toBe('cancelled')

    // An analyze in the drain window must be busy-REJECTED, never run concurrently.
    const during = service.analyze(req(), emit)
    expect(during.state).toBe('failed')
    expect(during.error).toBe('busy')

    // Once the aborted request fully unwinds, the slot frees and a new analyze is admitted.
    releaseUnwind()
    await until(() => !service.hasActiveJob(), 'the aborted request unwinding and freeing the busy slot')
    expect(service.analyze(req(), emit).state).toBe('queued') // the slot is free again: a new analyze is admitted
    await service.stop() // aborts the (hanging) accepted job so nothing dangles past the test
  })
})

// AUD-02: `analyze()`'s OWN lock guard, with no IPC guard in front (every images-IPC row is refused by the handler's
// `workspaceAdmitsWork` first, so none of them reaches this line, #897). The rows above are the unlocked control: the
// same request with no lock under way is admitted (`queued`).
describe('VisionService.analyze refuses while a workspace lock is under way (AUD-02)', () => {
  it('answers a terminal cancelled job: no status read, no runtime built, nothing streamed, the slot stays free', async () => {
    const getStatus = vi.fn(async () => AVAILABLE)
    const createRuntime = vi.fn()
    const service = new VisionService({ getStatus, createRuntime, isWorkspaceLocking: () => true })
    const emit: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }

    expect(service.analyze(req(), emit)).toMatchObject({ state: 'failed', error: 'cancelled' })
    await tick()
    expect(getStatus).not.toHaveBeenCalled()
    expect(createRuntime).not.toHaveBeenCalled()
    expect(emit.token).not.toHaveBeenCalled()
    expect(emit.done).not.toHaveBeenCalled()
    expect(emit.error).not.toHaveBeenCalled()
    expect(service.hasActiveJob()).toBe(false)
  })

  // Its twin with the latch answering "not locking", as it does whenever no lock is under way: the guard reads the
  // answer, so the same request is admitted and runs to its answer.
  it('admits the same request when the latch answers "not locking"', async () => {
    const getStatus = vi.fn(async () => AVAILABLE)
    const service = new VisionService({
      getStatus,
      createRuntime: () => ({ analyze: async () => 'a picture of a cat' }),
      isWorkspaceLocking: () => false
    })
    const emit: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }

    expect(service.analyze(req(), emit).state).toBe('queued')
    await until(() => (emit.done as ReturnType<typeof vi.fn>).mock.calls.length > 0, 'the admitted analyze finishing')
    expect(getStatus).toHaveBeenCalled()
    expect(emit.error).not.toHaveBeenCalled()
  })
})
