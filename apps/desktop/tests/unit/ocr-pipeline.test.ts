import { describe, it, expect, vi } from 'vitest'
import { pipelinePages } from '../../src/main/services/ocr/pipeline'

// ING-5 — bounded 1-deep render/recognize look-ahead. Pure orchestration (no Electron):
// fake render + recognize functions let us assert ordering, the one-extra-PNG memory bound,
// the render(N+1)↔recognize(N) overlap, and cancellation without a hidden window.

/** A deferred promise we can resolve from the test to drive timing precisely. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = () => r()))
  return { promise, resolve }
}

describe('pipelinePages (ING-5 OCR look-ahead)', () => {
  it('recognizes pages strictly in order', async () => {
    const recognized: number[] = []
    await pipelinePages(
      4,
      async (n) => Buffer.from([n]),
      async (n) => {
        recognized.push(n)
      }
    )
    expect(recognized).toEqual([1, 2, 3, 4])
  })

  it('renders page N+1 while page N recognizes, but never more than one ahead', async () => {
    const rendered: number[] = []
    const recognizeStarted: number[] = []
    const gates = new Map<number, ReturnType<typeof deferred>>()
    const recognizing: number[] = []
    let maxRendered = 0
    let maxConcurrentRecognize = 0

    const run = pipelinePages(
      3,
      async (n) => {
        rendered.push(n)
        return Buffer.from([n])
      },
      (n) => {
        recognizeStarted.push(n)
        recognizing.push(n)
        maxConcurrentRecognize = Math.max(maxConcurrentRecognize, recognizing.length)
        const g = deferred()
        gates.set(n, g)
        return g.promise.then(() => {
          recognizing.splice(recognizing.indexOf(n), 1)
        })
      }
    )

    // Let microtasks settle: page 1 rendered + recognize(1) started, page 2 rendered ahead
    // (the look-ahead) while recognize(1) is gated — but recognize(2) NOT started yet.
    await Promise.resolve()
    await Promise.resolve()
    maxRendered = Math.max(...rendered)
    expect(recognizeStarted).toEqual([1]) // only page 1 recognizing
    expect(rendered).toContain(2) // page 2 already rendered ahead (overlap)
    expect(maxRendered).toBe(2) // never rendered more than one ahead (page 3 not yet)

    // Release recognitions one at a time; the pipeline advances by one each time.
    gates.get(1)!.resolve()
    await Promise.resolve()
    await Promise.resolve()
    gates.get(2)!.resolve()
    await Promise.resolve()
    await Promise.resolve()
    gates.get(3)!.resolve()
    await run

    expect(recognizeStarted).toEqual([1, 2, 3])
    expect(maxConcurrentRecognize).toBe(1) // recognitions never overlap (single engine)
  })

  it('aborts before starting more work when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const rendered: number[] = []
    await expect(
      pipelinePages(
        3,
        async (n) => {
          rendered.push(n)
          return Buffer.from([n])
        },
        async () => {},
        { signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(DOMException)
    expect(rendered).toEqual([]) // nothing rendered after an up-front abort
  })

  it('stops promptly when the signal aborts mid-run and surfaces the abort', async () => {
    const controller = new AbortController()
    const recognized: number[] = []
    await expect(
      pipelinePages(
        10,
        async (n) => Buffer.from([n]),
        async (n) => {
          recognized.push(n)
          if (n === 2) controller.abort()
        },
        { signal: controller.signal, abortError: () => new DOMException('cancelled', 'AbortError') }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    // Recognized a bounded prefix, not all ten pages.
    expect(recognized.length).toBeLessThan(10)
    expect(recognized.slice(0, 2)).toEqual([1, 2])
  })

  it('propagates a recognition error and does not leak the in-flight recognition', async () => {
    await expect(
      pipelinePages(
        3,
        async (n) => Buffer.from([n]),
        async (n) => {
          if (n === 2) throw new Error('recognize failed on page 2')
        }
      )
    ).rejects.toThrow('recognize failed on page 2')
  })

  // BE-6 (ocr-audit 2026-07-18): a crafted PDF can declare an enormous page count. The walk is
  // clamped to `maxPages` (the ingestion M-2 posture) in the pure pipeline so the cap is enforced
  // regardless of the caller. Watched fail pre-fix: without the `maxPages` input the loop walked
  // all 1000 declared pages. Absent `maxPages` ⇒ historical behaviour (walk every page).
  it('clamps the walk to maxPages when the declared count is larger (BE-6)', async () => {
    const rendered: number[] = []
    const recognized: number[] = []
    await pipelinePages(
      1000,
      async (n) => {
        rendered.push(n)
        return Buffer.from([n & 0xff])
      },
      async (n) => {
        recognized.push(n)
      },
      { maxPages: 5 }
    )
    expect(recognized).toEqual([1, 2, 3, 4, 5])
    expect(rendered).toEqual([1, 2, 3, 4, 5]) // never rendered beyond the cap (no page 6 look-ahead)
  })

  it('does not clamp when maxPages exceeds the declared count (BE-6)', async () => {
    const recognized: number[] = []
    await pipelinePages(
      2,
      async (n) => Buffer.from([n]),
      async (n) => {
        recognized.push(n)
      },
      { maxPages: 5 }
    )
    expect(recognized).toEqual([1, 2]) // min(declared, cap) — the real page count wins
  })

  it('does nothing for a zero-page document', async () => {
    let calls = 0
    await pipelinePages(0, async (n) => Buffer.from([n]), () => {
      calls++
    })
    expect(calls).toBe(0)
  })

  // R4 (full-audit-2026-06-30, Phase C): the in-try drain of the LAST recognition awaits it once;
  // if it rejects, the catch must NOT re-await the SAME already-settled promise (there is no
  // still-pending look-ahead for the final page). The fix nulls `prevOnPage` before the final await.
  it('does not re-await an already-settled FINAL-page recognition in the catch (R4)', async () => {
    const failure = new Error('final page recognize failed')
    const finalP = Promise.reject(failure)
    finalP.catch(() => undefined) // pre-handle with the REAL `then` (before the spy) → no unhandled-rejection warning
    // `await p` on a native promise uses the internal then (invisible here); an EXPLICIT
    // `p.catch(...)` calls `p.then`, so this spy counts ONLY a catch-block re-await of the final
    // recognition — 0 when fixed, 1 with the double-drain bug.
    const thenSpy = vi.spyOn(finalP, 'then')

    await expect(
      pipelinePages(3, async (n) => Buffer.from([n]), (n) => (n === 3 ? finalP : undefined))
    ).rejects.toBe(failure)

    expect(thenSpy).toHaveBeenCalledTimes(0)
  })
})
