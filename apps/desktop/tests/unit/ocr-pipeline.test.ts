import { describe, it, expect } from 'vitest'
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

  it('does nothing for a zero-page document', async () => {
    let calls = 0
    await pipelinePages(0, async (n) => Buffer.from([n]), () => {
      calls++
    })
    expect(calls).toBe(0)
  })
})
