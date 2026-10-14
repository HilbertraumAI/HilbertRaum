import { describe, it, expect } from 'vitest'
import { pipelinePages } from '../../src/main/services/ocr/pipeline'

// ING-5 — bounded 1-deep render/recognize look-ahead. Pure orchestration (no Electron):
// fake render + recognize functions let us assert ordering, the one-extra-PNG memory bound,
// the render(N+1)↔recognize(N) overlap, and cancellation without a hidden window.

/** A deferred promise we can settle from the test to drive timing precisely. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res()
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Every fake here settles on microtasks, so one macrotask hop lets the pipeline run as far as it
 * can — a justified single-macrotask hop: these claims are about where it STOPS, which nothing
 * else marks.
 */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('pipelinePages (ING-5 OCR look-ahead)', () => {
  it('renders page N+1 while page N recognizes, but never more than one ahead', async () => {
    const rendered: number[] = []
    const recognizeStarted: number[] = []
    const gates = new Map<number, ReturnType<typeof deferred>>()
    const recognizing: number[] = []
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

    // Page 1 rendered + recognize(1) started, page 2 rendered ahead (the look-ahead) while
    // recognize(1) is gated — but recognize(2) NOT started, and page 3 not rendered.
    await settle()
    expect(rendered).toEqual([1, 2])
    expect(recognizeStarted).toEqual([1])

    // Release recognitions one at a time; the pipeline advances by exactly one each time.
    gates.get(1)!.resolve()
    await settle()
    expect(rendered).toEqual([1, 2, 3])
    expect(recognizeStarted).toEqual([1, 2])
    gates.get(2)!.resolve()
    await settle()
    expect(recognizeStarted).toEqual([1, 2, 3])
    gates.get(3)!.resolve()
    await run

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
    const rendered: number[] = []
    const recognized: number[] = []
    await expect(
      pipelinePages(
        10,
        async (n) => {
          rendered.push(n)
          if (n === 3) controller.abort() // the cancel lands while page 3 renders
          return Buffer.from([n])
        },
        async (n) => {
          recognized.push(n)
        },
        { signal: controller.signal, abortError: () => new DOMException('cancelled', 'AbortError') }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(rendered).toEqual([1, 2, 3]) // nothing renders after the cancel
    expect(recognized).toEqual([1, 2]) // the page rendering when it landed is never recognized
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

    // A render that fails while the previous page still recognizes: the pipeline waits for that
    // recognition before it reports, so its late failure never leaks as an unhandled rejection.
    const page2 = deferred()
    let settled = false
    const run = pipelinePages(
      3,
      async (n) => {
        if (n === 3) throw new Error('render failed on page 3')
        return Buffer.from([n])
      },
      (n) => (n === 2 ? page2.promise : undefined)
    )
    run.then(
      () => (settled = true),
      () => (settled = true)
    )
    await settle()
    expect(settled).toBe(false) // still waiting for page 2's recognition
    page2.reject(new Error('late recognition failure'))
    await expect(run).rejects.toThrow('render failed on page 3')
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

  // #575: a text PDF's OCR reads only its scanned pages — in page order, each once, never past
  // the cap or the document's end, and nothing else is rendered.
  it('walks only the given pages, ascending, once each, within the cap (#575)', async () => {
    const rendered: number[] = []
    const recognized: number[] = []
    await pipelinePages(
      8,
      async (n) => {
        rendered.push(n)
        return Buffer.from([n])
      },
      async (n) => {
        recognized.push(n)
      },
      { maxPages: 6, pages: [5, 2, 5, 7, 0, 9] }
    )
    expect(recognized).toEqual([2, 5])
    expect(rendered).toEqual([2, 5])
  })

  it('does nothing for a zero-page document', async () => {
    let calls = 0
    await pipelinePages(0, async (n) => Buffer.from([n]), () => {
      calls++
    })
    expect(calls).toBe(0)
  })
})
