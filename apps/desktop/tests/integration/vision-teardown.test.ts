import { describe, it, expect, vi } from 'vitest'
import { VisionService, type VisionStreamEmitter, type VisionAnalyzer } from '../../src/main/services/vision'
import type { ImageAnalyzeRequest, VisionStatus } from '../../src/shared/types'

// REL-2 (full-audit-2026-06-29 follow-up): VisionService.stop() (workspace LOCK / quit) must not be
// defeated by a run() that REBUILDS the runtime during teardown. run() does
// `this.runtime ??= createRuntime(status)` after an `await getStatus()`; without an orchestrator-level
// latch, a run() scheduled by an analyze() that lands DURING a teardown spawns a FRESH ~4.6 GB vision
// sidecar that outlives the teardown (co-resident with the vault re-encrypt). The fix mirrors the
// e5/reranker F19 `tearingDown` flag (GPU §5.5c): set at the top of stop(), cleared in finally,
// re-checked in run() at the top AND after the getStatus() await — a losing run() ends `cancelled`,
// spawns nothing.
//
// Both interleavings below are DETERMINISTIC — the run() is launched detached (`void this.run`), so
// nothing about wall-clock time guarantees it has reached the interleave point. Instead of a fixed
// `sleep(N)` (which under CPU starvation can let the assertion pass VACUOUSLY before the interleave
// even happens — full-audit-2026-06-30 T1), each test PARKS the run() on a gate and `while (cond) await
// tick()`-polls an observable counter until the run() is provably at the interleave point before the
// teardown fires. The de-flaked pattern mirrors the injected-clock `vision-runtime.test.ts` cases and
// the Phase-C R7 test.
//
// Teeth (verified empirically against the real `VisionService`): both guards are co-guards, so each
// scenario reddens only on the DUAL neuter (single-neuter is backstopped by the twin) — recorded
// transparently, the R7 / F18 co-guarded-twin precedent:
//  (1) a NEW analyze() during an in-progress teardown — the job's controller is FRESH (NOT aborted by
//      stop()'s synchronous abort loop, which ran before the job existed), so `signal.aborted` does NOT
//      co-guard. The two `tearingDown` checks (top-of-run + post-getStatus) are the pair; neutering BOTH
//      lets run() build a second runtime (createCalls === 2), neutering either alone stays green.
//  (2) the audit's literal "run() parked in getStatus() while stop() interleaves", held with the
//      teardown genuinely IN FLIGHT (runtime#1.stop() gated open, so `tearingDown` stays true across
//      the resume). That job's controller IS aborted by stop(), so `signal.aborted` co-guards it and the
//      post-getStatus `tearingDown` re-check is its defense-in-depth twin; neutering BOTH lets run()
//      build a second runtime, neutering either alone stays green. This genuinely EXERCISES the
//      post-getStatus re-check (it is the live backstop here), the thing the audit worried could ship
//      green vacuously.

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
// boundary, draining all pending microtasks. `while (cond) await tick()` re-checks an observable
// counter and so cannot proceed until the run() is genuinely at the interleave point.
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

const calls = (fn: VisionStreamEmitter['done']): number =>
  (fn as ReturnType<typeof vi.fn>).mock.calls.length

const settled = (state: string): boolean =>
  state === 'queued' || state === 'starting' || state === 'analyzing' ? false : true

describe('VisionService teardown vs runtime rebuild (REL-2)', () => {
  it('an analyze() that lands during an in-progress stop() does NOT spawn a fresh sidecar', async () => {
    let createCalls = 0
    // The teardown of the FIRST runtime parks until the test releases it, holding `tearingDown` true.
    // `stopEntered` lets the test wait DETERMINISTICALLY until stop() has reached the gated
    // runtime.stop() await (the teardown window is genuinely open) — no `sleep(2)` race.
    let stopEntered = false
    let releaseRuntimeStop!: () => void
    const runtimeStopGate = new Promise<void>((r) => (releaseRuntimeStop = r))
    const createRuntime = (): VisionAnalyzer => {
      createCalls++
      return {
        analyze: async (o: { onToken?: (d: string) => void }) => {
          o.onToken?.('answer ')
          return 'an answer'
        },
        stop: () => {
          stopEntered = true
          return runtimeStopGate
        }
      }
    }
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime })

    // First analyze → builds runtime #1 and completes; this.runtime is now live.
    const emit1: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job1 = service.analyze(req(), emit1)
    while (calls(emit1.done) === 0) await tick()
    expect(createCalls).toBe(1)

    // stop() begins and PARKS in runtime#1.stop() (gated) — `tearingDown` stays true throughout.
    const stopP = service.stop()
    while (!stopEntered) await tick() // stop() has reached the gated runtime.stop() await

    // A NEW analyze() lands during the teardown window. Its controller is fresh (stop()'s abort loop
    // already ran), so only the `tearingDown` latch can stop it spawning runtime #2.
    const emit2: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job2 = service.analyze(req(), emit2)
    // Poll until run2 has reached a terminal state — whether it was (correctly) cancelled by the latch
    // or (under a neuter) wrongly allowed to spawn + complete, it settles, so the poll terminates.
    while (!settled(service.getJob(job2.jobId).state)) await tick()

    // No second runtime was built, and the racing job ended cancelled — not started, not done.
    expect(createCalls).toBe(1)
    expect(service.getJob(job2.jobId).state).toBe('cancelled')
    expect(emit2.done).not.toHaveBeenCalled()
    expect(emit2.error).not.toHaveBeenCalled()

    // Release the teardown; stop() completes cleanly.
    releaseRuntimeStop()
    await stopP
    expect(service.getJob(job1.jobId).state).toBe('failed') // jobs purged by stop() → unknown ⇒ failed
  })

  it('a run() parked in getStatus() during an IN-FLIGHT stop() ends cancelled and spawns no new sidecar', async () => {
    let createCalls = 0
    // runtime#1.stop() parks so the teardown stays IN FLIGHT (`tearingDown` true) across the resume —
    // this is what makes the post-getStatus `tearingDown` re-check a LIVE co-guard here.
    let stopEntered = false
    let releaseRuntimeStop!: () => void
    const runtimeStopGate = new Promise<void>((r) => (releaseRuntimeStop = r))
    // getStatus parks the SECOND analyze's run() inside the getStatus() await; `statusEntries` lets the
    // test wait deterministically until run#2 is provably parked there before stop() fires.
    let statusEntries = 0
    let releaseStatus!: () => void
    const statusGate = new Promise<void>((r) => (releaseStatus = r))
    const service = new VisionService({
      getStatus: async () => {
        statusEntries++
        if (statusEntries >= 2) await statusGate // park ONLY run#2 in getStatus()
        return AVAILABLE
      },
      createRuntime: (): VisionAnalyzer => {
        createCalls++
        return {
          analyze: async (o: { onToken?: (d: string) => void }) => {
            o.onToken?.('answer ')
            return 'an answer'
          },
          stop: () => {
            stopEntered = true
            return runtimeStopGate
          }
        }
      }
    })

    // analyze #1 builds runtime #1 and completes → this.runtime live, the slot is free again.
    const emit1: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    service.analyze(req(), emit1)
    while (calls(emit1.done) === 0) await tick()
    expect(createCalls).toBe(1)

    // analyze #2 → run#2 parks in the gated getStatus(); its controller IS registered (stop() will abort it).
    const emit2: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job2 = service.analyze(req(), emit2)
    while (statusEntries < 2) await tick() // run#2 has reached the getStatus() await

    // stop() begins: arms `tearingDown`, aborts run#2's controller, nulls this.runtime, and PARKS in
    // runtime#1.stop() — so when run#2 resumes the teardown is genuinely still in flight.
    const stopP = service.stop()
    while (!stopEntered) await tick()

    // run#2 resumes from getStatus DURING the in-flight teardown → must end cancelled, build nothing.
    releaseStatus()
    while (!settled(service.getJob(job2.jobId).state)) await tick()

    expect(createCalls).toBe(1) // no SECOND runtime built
    expect(service.getJob(job2.jobId).state).toBe('cancelled')
    expect(emit2.done).not.toHaveBeenCalled()
    expect(emit2.error).not.toHaveBeenCalled()

    releaseRuntimeStop()
    await stopP
  })
})
