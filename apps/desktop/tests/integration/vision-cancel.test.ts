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
    while (tokenSpy.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 1))

    // The user cancels mid-flight.
    expect(service.cancel(job.jobId).state).toBe('cancelled')

    // A (misbehaving) runtime then resolves a full, non-empty answer AFTER the cancel.
    resolveAnalyze('a complete answer')
    await new Promise((r) => setTimeout(r, 5))

    // The terminal write was guarded: the job stays cancelled and emit.done never fired.
    expect(service.getJob(job.jobId).state).toBe('cancelled')
    expect(emit.done).not.toHaveBeenCalled()
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
    while (doneSpy.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 1))

    expect(service.getJob(job.jobId).state).toBe('done')
    expect(service.getJob(job.jobId).answer).toBe('a bar chart')
    expect(emit.done).toHaveBeenCalledTimes(1)
  })
})
