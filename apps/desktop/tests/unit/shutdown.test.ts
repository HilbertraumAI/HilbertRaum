import { describe, it, expect } from 'vitest'
import { performShutdown } from '../../src/main/shutdown'
import type { AppContext } from '../../src/main/services/context'

// REL-4 (full-audit-2026-06-29 follow-up): the QUIT teardown must abort in-flight chat/RAG streams
// BEFORE runtime.stop() — like the workspace-LOCK path — so a partial reply unwinds as an ABORT and
// persists (generateAssistantMessage), instead of the sidecar being killed mid-stream (a non-abort
// error that loses the partial). performShutdown was extracted from main/index.ts to make this
// ordering unit-testable with a fake ctx. The whole sequence: abort build + abort streams → stop
// sidecars → detach log → lock.

/** A fake AbortController that records when it is aborted, so the test can assert ordering. */
function recordingController(order: string[], label: string): AbortController {
  const ctl = {
    signal: { aborted: false } as unknown as AbortSignal,
    abort: () => {
      ;(ctl.signal as { aborted: boolean }).aborted = true
      order.push(label)
    }
  }
  return ctl as unknown as AbortController
}

function fakeCtx(order: string[]): AppContext {
  const stop = (label: string) => async () => {
    order.push(label)
  }
  return {
    docTasks: {
      abortActiveBuild: () => order.push('abort-build'),
      // TA-1 (H1): quit flushes the whole doc-task pipeline (running + queued) before the
      // sidecars stop, and awaits the running task's abort-unwind settle before lock().
      cancelAllDocTasks: () => order.push('cancel-tasks'),
      awaitActiveTaskSettled: async () => {
        order.push('task-settle')
      }
    },
    // TG-4: the Translate-view job service is aborted on quit too (before the sidecar stop below),
    // so its next window can't respawn the server being killed.
    translateJobs: { stop: stop('translateJobs.stop') },
    runtime: { stop: stop('runtime.stop') },
    embedder: { stop: stop('embedder.stop') },
    reranker: { stop: stop('reranker.stop') },
    transcriber: { stop: stop('transcriber.stop') },
    ocrEngine: { stop: stop('ocr.stop') },
    vision: { stop: stop('vision.stop') },
    translator: { stop: stop('translator.stop') },
    workspace: { lock: () => order.push('lock') }
  } as unknown as AppContext
}

describe('performShutdown ordering (REL-4)', () => {
  it('aborts in-flight streams BEFORE stopping the runtime, then detaches the log, then locks', async () => {
    const order: string[] = []
    const controller = recordingController(order, 'abort-stream')
    const streams = new Map<string, AbortController>([['c1', controller]])

    await performShutdown(fakeCtx(order), {
      inFlightStreams: streams,
      detachVaultKey: () => order.push('detach'),
      log: { error: () => undefined }
    })

    // The stream WAS aborted (reds if the REL-4 abort loop is removed).
    expect(controller.signal.aborted).toBe(true)
    expect(order).toContain('abort-stream')

    const i = (label: string): number => order.indexOf(label)
    // Streams aborted before EVERY sidecar stop — so the partial persists (DB still open) before
    // the sidecar dies.
    expect(i('abort-stream')).toBeGreaterThanOrEqual(0)
    expect(i('abort-stream')).toBeLessThan(i('runtime.stop'))
    expect(i('abort-build')).toBeLessThan(i('runtime.stop'))
    // TG-4: the Translate-view job is aborted BEFORE the translator sidecar is stopped, so a queued
    // next window can't lazily respawn the server being killed.
    expect(i('translateJobs.stop')).toBeGreaterThanOrEqual(0)
    expect(i('translateJobs.stop')).toBeLessThan(i('translator.stop'))
    // TA-1 (H1): the doc-task pipeline is flushed BEFORE the translator (and every) sidecar stops,
    // so a running/queued translation can't materialize a half-translated transient during teardown.
    expect(i('cancel-tasks')).toBeGreaterThanOrEqual(0)
    expect(i('cancel-tasks')).toBeLessThan(i('translator.stop'))
    // …and its abort-unwind SETTLE is awaited after the sidecar stop, before the vault re-encrypts.
    expect(i('task-settle')).toBeGreaterThan(i('runtime.stop'))
    expect(i('task-settle')).toBeLessThan(i('lock'))
    // Sidecars stopped before the log detaches and the vault re-encrypts; lock() is last of all.
    expect(i('runtime.stop')).toBeLessThan(i('detach'))
    expect(i('detach')).toBeLessThan(i('lock'))
    expect(i('lock')).toBe(order.length - 1)
  })

  it('skips an already-aborted controller and still completes the teardown', async () => {
    const order: string[] = []
    const already = recordingController(order, 'should-not-fire')
    ;(already.signal as { aborted: boolean }).aborted = true // already aborted (e.g. user Stop)

    await performShutdown(fakeCtx(order), {
      inFlightStreams: new Map([['c1', already]]),
      detachVaultKey: () => order.push('detach'),
      log: { error: () => undefined }
    })

    expect(order).not.toContain('should-not-fire') // not re-aborted
    expect(order).toContain('runtime.stop')
    expect(order[order.length - 1]).toBe('lock') // teardown still ran to completion
  })

  it('is a safe no-op-ish call with a null ctx (crash/early-quit path)', async () => {
    const order: string[] = []
    await expect(
      performShutdown(null, {
        inFlightStreams: new Map(),
        detachVaultKey: () => order.push('detach'),
        log: { error: () => undefined }
      })
    ).resolves.toBeUndefined()
    expect(order).toEqual(['detach']) // only the always-runs detach fired; no ctx calls threw
  })

  // R1 (full-audit-2026-06-30, Phase C): aborting a stream is not enough — the partial reply
  // persists in the stream's OWN promise (the abort-unwind → appendMessage), which the teardown
  // never awaited. The quit path now AWAITS each in-flight stream's SETTLE (after the sidecar stop,
  // before detach/lock), so the partial persists deterministically while the DB is still open.
  it('AWAITS each in-flight stream settle before locking (R1)', async () => {
    const order: string[] = []
    const controller = recordingController(order, 'abort-stream')
    let persist!: () => void
    const settled = new Map<string, Promise<void>>([
      [
        'c1',
        new Promise<void>((r) => {
          persist = () => {
            order.push('persist')
            r()
          }
        })
      ]
    ])

    const p = performShutdown(fakeCtx(order), {
      inFlightStreams: new Map([['c1', controller]]),
      streamSettled: settled,
      detachVaultKey: () => order.push('detach'),
      log: { error: () => undefined }
    })

    const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
    while (!order.includes('runtime.stop')) await tick()
    await tick()
    await tick()
    // The sidecars were stopped, but lock() has NOT run — the teardown is blocked on the settle.
    expect(order).toContain('runtime.stop')
    expect(order).not.toContain('persist')
    expect(order).not.toContain('lock')

    persist() // the aborted partial finished persisting → settle resolves
    await p

    // The partial persisted BEFORE the vault re-encrypted; lock() is last of all.
    expect(order.indexOf('persist')).toBeGreaterThan(order.indexOf('runtime.stop'))
    expect(order.indexOf('persist')).toBeLessThan(order.indexOf('lock'))
    expect(order[order.length - 1]).toBe('lock')
  })

  // H1 (TA-1): the flushed doc-task's abort-unwind (which materializes/shreds its transient
  // synchronously while the DB is open) must SETTLE before lock() closes the DB. The quit path
  // awaits `ctx.docTasks.awaitActiveTaskSettled()` (bounded) after the sidecar stop, before lock.
  it('AWAITS the cancelled doc-task settle before locking (H1)', async () => {
    const order: string[] = []
    let unwind!: () => void
    const ctx = fakeCtx(order) as unknown as {
      docTasks: { awaitActiveTaskSettled: () => Promise<void> }
    }
    // Override the resolved-immediately settle with one the test controls.
    ctx.docTasks.awaitActiveTaskSettled = () =>
      new Promise<void>((r) => {
        unwind = () => {
          order.push('unwound')
          r()
        }
      })

    const p = performShutdown(ctx as unknown as AppContext, {
      inFlightStreams: new Map(),
      detachVaultKey: () => order.push('detach'),
      log: { error: () => undefined }
    })

    const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
    while (!order.includes('runtime.stop')) await tick()
    await tick()
    await tick()
    // The sidecars stopped, but lock() has NOT run — the teardown is blocked on the doc-task settle.
    expect(order).toContain('runtime.stop')
    expect(order).not.toContain('unwound')
    expect(order).not.toContain('lock')

    unwind() // the aborted task finished materializing/shredding → settle resolves
    await p

    // The abort-unwind finished BEFORE the vault re-encrypted; lock() is last of all.
    expect(order.indexOf('unwound')).toBeGreaterThan(order.indexOf('runtime.stop'))
    expect(order.indexOf('unwound')).toBeLessThan(order.indexOf('lock'))
    expect(order[order.length - 1]).toBe('lock')
  })
})
