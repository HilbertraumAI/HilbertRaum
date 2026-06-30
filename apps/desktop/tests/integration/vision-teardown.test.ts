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
// Two interleavings are covered:
//  (1) a NEW analyze() during an in-progress teardown — the top-of-run latch is SOLELY load-bearing
//      here (the job's controller is fresh, NOT aborted by stop()'s synchronous abort loop which ran
//      before the job existed), so the single-neuter teeth-check (remove the top check) reddens.
//  (2) the audit's literal "run() parked in getStatus() while stop() interleaves" — that job's
//      controller IS aborted by stop(), so the existing `signal.aborted` check co-guards it; the
//      post-getStatus re-check is the defense-in-depth twin. Pinned as an end-state regression.

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('VisionService teardown vs runtime rebuild (REL-2)', () => {
  it('an analyze() that lands during an in-progress stop() does NOT spawn a fresh sidecar', async () => {
    let createCalls = 0
    // The teardown of the FIRST runtime parks until the test releases it, holding `tearingDown` true.
    let releaseRuntimeStop!: () => void
    const runtimeStopGate = new Promise<void>((r) => (releaseRuntimeStop = r))
    const createRuntime = (): VisionAnalyzer => {
      createCalls++
      return {
        analyze: async (o: { onToken?: (d: string) => void }) => {
          o.onToken?.('answer ')
          return 'an answer'
        },
        stop: () => runtimeStopGate
      }
    }
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime })

    // First analyze → builds runtime #1 and completes; this.runtime is now live.
    const emit1: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job1 = service.analyze(req(), emit1)
    const done1 = emit1.done as ReturnType<typeof vi.fn>
    while (done1.mock.calls.length === 0) await sleep(1)
    expect(createCalls).toBe(1)

    // stop() begins and PARKS in runtime#1.stop() (gated) — `tearingDown` stays true throughout.
    const stopP = service.stop()
    await sleep(2) // let stop() reach the gated runtime.stop() await

    // A NEW analyze() lands during the teardown window. Its controller is fresh (stop()'s abort loop
    // already ran), so only the `tearingDown` latch can stop it spawning runtime #2.
    const emit2: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job2 = service.analyze(req(), emit2)
    await sleep(10) // ample for run2 to (wrongly) spawn + analyze if it were allowed

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

  it('a run() parked in getStatus() while stop() interleaves ends cancelled and spawns nothing', async () => {
    let createCalls = 0
    let releaseStatus!: () => void
    const statusGate = new Promise<void>((r) => (releaseStatus = r))
    const service = new VisionService({
      getStatus: async () => {
        await statusGate // park run() in the getStatus() await
        return AVAILABLE
      },
      createRuntime: (): VisionAnalyzer => {
        createCalls++
        return { analyze: async () => 'unreached' }
      }
    })

    const emit: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const job = service.analyze(req(), emit)
    await sleep(2) // run() is now parked in getStatus()

    const stopP = service.stop() // aborts the parked job's controller + arms tearingDown
    await stopP
    releaseStatus() // run() resumes — must NOT build a runtime
    await sleep(5)

    expect(createCalls).toBe(0)
    expect(emit.done).not.toHaveBeenCalled()
    // The job was purged by stop() (unknown ⇒ failed); the point is no sidecar was spawned.
    expect(service.getJob(job.jobId).state).toBe('failed')
  })
})
