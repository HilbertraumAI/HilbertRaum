import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  performShutdown,
  createAppLifecycleHandlers,
  emergencyLock,
  SHUTDOWN_OVERALL_DEADLINE_MS
} from '../../src/main/shutdown'
import type { AppContext } from '../../src/main/services/context'

// REL-4 (full-audit-2026-06-29 follow-up): the QUIT teardown must abort in-flight chat/RAG streams
// BEFORE runtime.stop() — like the workspace-LOCK path — so a partial reply unwinds as an ABORT and
// persists (generateAssistantMessage), instead of the sidecar being killed mid-stream (a non-abort
// error that loses the partial). performShutdown was extracted from main/index.ts to make this
// ordering unit-testable with a fake ctx. The whole sequence: abort build + abort streams → stop
// sidecars → detach log → lock.

/** A logger the ordering tests do not care about (`error` + `info` — the quit path logs both). */
const quietLog = { error: () => undefined, info: () => undefined }

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
    // CODE-3 (full-audit 2026-07-11): the manager's permanent shutdown latch is armed FIRST,
    // before anything else runtime-related, so a background auto-start whose weight hash
    // completes during this teardown can never enqueue a fresh start after the stop.
    runtime: { shutdown: () => order.push('runtime.latch'), stop: stop('runtime.stop') },
    embedder: { stop: stop('embedder.stop') },
    reranker: { stop: stop('reranker.stop') },
    transcriber: { stop: stop('transcriber.stop') },
    ocrEngine: { stop: stop('ocr.stop') },
    vision: { stop: stop('vision.stop') },
    translator: { stop: stop('translator.stop') },
    // Local-api wave: the endpoint's stop() (aborts external streams, closes sockets)
    // runs BEFORE the sidecar stops, so no outside caller holds the model mid-teardown.
    localApi: { stop: stop('localApi.stop') },
    // #237: the plaintext-operation registry (preview / re-index / import / dictation / export)
    // is aborted with the other aborts, settled after the doc-task settle, swept before lock.
    plaintextOps: {
      abortAll: () => order.push('plaintext.abort'),
      awaitSettled: async () => {
        order.push('plaintext.settle')
        return true
      },
      sweepRegistered: () => {
        order.push('plaintext.sweep')
        return 0
      },
      size: () => 0
    },
    // Issue #51: quit calls workspace.shutdown() (lock + plaintext checkpoint/close). The
    // ordering event keeps its historical 'lock' label — every assertion below pins it.
    workspace: { shutdown: () => order.push('lock') }
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
      log: quietLog
    })

    // The stream WAS aborted (reds if the REL-4 abort loop is removed).
    expect(controller.signal.aborted).toBe(true)
    expect(order).toContain('abort-stream')

    const i = (label: string): number => order.indexOf(label)
    // CODE-3 (full-audit 2026-07-11): the runtime manager's permanent shutdown latch is the
    // FIRST thing the teardown does — armed before the aborts and before every sidecar stop,
    // so a racing auto-start (its multi-GB hash just completed) finds start() latched no
    // matter where in this sequence it lands.
    expect(i('runtime.latch')).toBe(0)
    expect(i('runtime.latch')).toBeLessThan(i('abort-build'))
    expect(i('runtime.latch')).toBeLessThan(i('runtime.stop'))
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
    // Local-api wave: the endpoint dies BEFORE the runtime sidecar, so no external caller
    // can reach (or hold a stream on) the model while the children are killed.
    expect(i('localApi.stop')).toBeGreaterThanOrEqual(0)
    expect(i('localApi.stop')).toBeLessThan(i('runtime.stop'))
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
      log: quietLog
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
        log: quietLog
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
      log: quietLog
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
      log: quietLog
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

  // #237: a preview / re-index / import-prepare / dictation / export in flight is aborted with
  // the other aborts (before any sidecar stop), its settle awaited after the doc-task settle, and
  // its still-registered transients shredded before the log flush + lock.
  it('aborts, settles and sweeps the plaintext operations — abort before the sidecars, sweep before lock (#237)', async () => {
    const order: string[] = []
    await performShutdown(fakeCtx(order), {
      inFlightStreams: new Map(),
      detachVaultKey: () => order.push('detach'),
      log: quietLog
    })
    const i = (label: string): number => order.indexOf(label)
    expect(i('plaintext.abort')).toBeGreaterThanOrEqual(0)
    expect(i('plaintext.abort')).toBeLessThan(i('runtime.stop'))
    expect(i('plaintext.settle')).toBeGreaterThan(i('task-settle'))
    expect(i('plaintext.sweep')).toBeGreaterThan(i('plaintext.settle'))
    expect(i('plaintext.sweep')).toBeLessThan(i('detach'))
    expect(i('lock')).toBe(order.length - 1)
  })
})

// ---- #238 / #230 — the quit handler itself ------------------
//
// B1 (the review's `o1-double-quit` reproduction, ported and INVERTED): `isShuttingDown` is set
// before `performShutdown` starts, and the re-entry branch of the `will-quit` handler returned
// WITHOUT `event.preventDefault()`, so a second quit while the teardown was parked (a wedged
// sidecar stop — the 180 s health window (#244)) let Electron's default quit proceed with the working DB still
// plaintext on the drive. The one parked point is `embedder.stop()`.
//
// Does not prove: that Electron re-emits `will-quit` after a prevented one (documentation-derived;
// on macOS the default Quit role re-runs before-quit → will-quit for a second ⌘Q).

/** A fake ctx whose every member resolves immediately EXCEPT `embedder.stop`, which parks. */
function parkedCtx(order: string[]): { ctx: AppContext; release: () => void } {
  let release: () => void = () => undefined
  const ctx = fakeCtx(order) as unknown as { embedder: { stop: () => Promise<void> } }
  ctx.embedder.stop = () => {
    order.push('embedder.stop(parked)')
    return new Promise<void>((r) => {
      release = r
    })
  }
  return { ctx: ctx as unknown as AppContext, release: () => release() }
}

/** The `{preventDefault, defaultPrevented}` subset of Electron's `will-quit` event. */
function quitEvent(): { preventDefault: () => void; defaultPrevented: boolean } {
  const ev = {
    defaultPrevented: false,
    preventDefault: () => {
      ev.defaultPrevented = true
    }
  }
  return ev
}

/** Let the parked teardown run up to its park point (the paper's 30-iteration drain). */
async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}


describe('will-quit re-entry during a parked teardown (#238, B1 inverted)', () => {
  /** The real `will-quit` handler over the real `performShutdown`, parked on `embedder.stop()`. */
  function harness() {
    const order: string[] = []
    const exits: number[] = []
    const { ctx, release } = parkedCtx(order)
    const handlers = createAppLifecycleHandlers({
      performShutdown: () =>
        performShutdown(ctx, {
          inFlightStreams: new Map(),
          detachVaultKey: () => order.push('detach'),
          log: quietLog
        }),
      emergencyLock: () => order.push('emergency-lock'),
      exit: (code) => {
        order.push('exit')
        exits.push(code)
      },
      createWindow: () => order.push('createWindow'),
      windowCount: () => 0,
      killSidecarChildren: () => order.push('reap'),
      log: quietLog
    })
    return { order, exits, release, handlers }
  }

  it('prevents the SECOND will-quit too; the lock runs exactly once, after release, then exit', async () => {
    const { order, exits, release, handlers } = harness()

    const first = quitEvent()
    handlers.onWillQuit(first)
    await drain()
    expect(first.defaultPrevented).toBe(true)
    expect(order).toContain('embedder.stop(parked)') // the teardown is parked mid-sidecar-stop
    expect(order).not.toContain('lock') // …so the working DB is still plaintext
    expect(exits).toEqual([])

    const second = quitEvent()
    handlers.onWillQuit(second)
    await drain()
    // INVERTED B1: the re-entry must be prevented as well — nothing but the teardown's own
    // completion may release the quit while the vault is unlocked.
    expect(second.defaultPrevented).toBe(true)
    expect(order).not.toContain('lock')
    expect(exits).toEqual([])

    release()
    await drain()
    expect(order.filter((l) => l === 'lock')).toHaveLength(1)
    // lock → (reap whatever a deadline-abandoned stop left) → exit, exactly once, from the finally.
    expect(order.slice(-3)).toEqual(['lock', 'reap', 'exit'])
    expect(exits).toEqual([0])
  })

  it('reaches the re-entry branch while the vault is still UNLOCKED and prevents there too (fresh closure)', async () => {
    const { order, exits, handlers } = harness()
    handlers.onWillQuit(quitEvent())
    await drain()
    expect(handlers.isShuttingDown()).toBe(true)
    expect(order).not.toContain('lock') // the re-entry below happens with the DB open
    const reentry = quitEvent()
    handlers.onWillQuit(reentry)
    expect(reentry.defaultPrevented).toBe(true)
    expect(exits).toEqual([]) // never released by the re-entry
  })
})

describe('activate during a parked teardown (#238)', () => {
  it('does not create a window once a quit began (Dock click while the teardown is parked)', async () => {
    let windows = 0
    let created = 0
    const handlers = createAppLifecycleHandlers({
      performShutdown: () => new Promise<void>(() => {}), // parked forever
      emergencyLock: () => undefined,
      exit: () => undefined,
      createWindow: () => {
        created++
        windows++
      },
      windowCount: () => windows,
      killSidecarChildren: () => undefined,
      log: quietLog
    })
    handlers.onActivate()
    expect(created).toBe(1) // a normal Dock click with no window creates one
    windows = 0 // the user closed the window; the app stays in the Dock (macOS)
    handlers.onWillQuit(quitEvent())
    expect(handlers.isShuttingDown()).toBe(true)
    handlers.onActivate()
    expect(created).toBe(1) // no fresh window against a workspace whose lock latch is armed
  })
})

// #248: an OS session end (Windows `session-end` on the main window; macOS `powerMonitor`
// `shutdown`, unverified on a Mac — #226) never passes through `will-quit`, so before this
// handler the process was killed with the working DB still plaintext on the drive and the next
// launch shredded the session delta. The handler runs the crash path's synchronous best-effort
// lock (`emergencyLock`) exactly once, shares the quit closure so a session end and a quit can
// never lock twice, and lets a `will-quit` that follows the lock exit at once (a prevented quit
// that never exits would make macOS report the app as cancelling the shutdown).
describe('OS session end (#248) — a best-effort synchronous lock, exactly once', () => {
  /** The real session-end lock and the real (parkable) quit teardown over ONE fake ctx. */
  function sessionHarness() {
    const order: string[] = []
    const exits: number[] = []
    let windows = 1
    const { ctx, release } = parkedCtx(order)
    const handlers = createAppLifecycleHandlers({
      performShutdown: () =>
        performShutdown(ctx, {
          inFlightStreams: new Map(),
          detachVaultKey: () => order.push('detach'),
          log: quietLog
        }),
      emergencyLock: () =>
        emergencyLock(ctx, {
          detachVaultKey: () => order.push('detach'),
          killSidecarChildren: () => order.push('reap'),
          log: quietLog
        }),
      exit: (code) => {
        order.push('exit')
        exits.push(code)
      },
      createWindow: () => {
        order.push('createWindow')
        windows++
      },
      windowCount: () => windows,
      killSidecarChildren: () => order.push('reap'),
      log: quietLog
    })
    return { order, exits, release, handlers, setWindows: (n: number) => void (windows = n) }
  }

  it('locks the unlocked workspace SYNCHRONOUSLY on session end — flush, lock, reap — exactly once', () => {
    const { order, exits, handlers } = sessionHarness()
    handlers.onSessionEnd({ reasons: ['shutdown'] })
    // No await: the OS kills the process as soon as the handler returns, so everything that
    // matters happened by now. The local-API stop is fire-and-forget (in-process, no orphan).
    expect(order).toEqual(['localApi.stop', 'detach', 'lock', 'reap'])
    expect(handlers.isShuttingDown()).toBe(true)
    expect(exits).toEqual([]) // the lock does not exit by itself — the OS ends the process
  })

  it('a second emission does not lock twice', () => {
    const { order, handlers } = sessionHarness()
    handlers.onSessionEnd({ reasons: ['logoff'] })
    handlers.onSessionEnd({ reasons: ['logoff'] })
    handlers.onSessionEnd() // the macOS leg carries no event
    expect(order.filter((l) => l === 'lock')).toHaveLength(1)
    expect(order.filter((l) => l === 'reap')).toHaveLength(1)
  })

  it('a will-quit AFTER the session-end lock exits at once — no teardown, no second lock', async () => {
    const { order, exits, handlers } = sessionHarness()
    handlers.onSessionEnd()
    const ev = quitEvent()
    handlers.onWillQuit(ev)
    await drain()
    expect(ev.defaultPrevented).toBe(true)
    expect(order).not.toContain('embedder.stop(parked)') // the awaited teardown never started
    expect(order.filter((l) => l === 'lock')).toHaveLength(1)
    expect(order.slice(-2)).toEqual(['reap', 'exit']) // reaped again right before the exit
    expect(exits).toEqual([0])
    // …and a will-quit re-entry after that exit is inert too.
    handlers.onWillQuit(quitEvent())
    expect(exits).toEqual([0])
  })

  it('a session end DURING a parked quit teardown defers to it — the teardown owns the one lock', async () => {
    const { order, exits, release, handlers } = sessionHarness()
    handlers.onWillQuit(quitEvent())
    await drain()
    expect(order).toContain('embedder.stop(parked)')
    expect(order).not.toContain('lock')
    handlers.onSessionEnd({ reasons: ['shutdown'] })
    expect(order).not.toContain('lock') // not a second, competing lock mid-teardown
    release()
    await drain()
    expect(order.filter((l) => l === 'lock')).toHaveLength(1)
    expect(order.slice(-3)).toEqual(['lock', 'reap', 'exit']) // the exit path still reaps
    expect(exits).toEqual([0])
  })

  it('no fresh window after a session-end lock (the activate guard shares the closure)', () => {
    const { order, handlers, setWindows } = sessionHarness()
    setWindows(0)
    handlers.onActivate()
    expect(order.filter((l) => l === 'createWindow')).toHaveLength(1) // a normal Dock click creates one
    setWindows(0)
    handlers.onSessionEnd()
    handlers.onActivate()
    expect(order.filter((l) => l === 'createWindow')).toHaveLength(1) // …but none against the locked vault
  })

  it('emergencyLock is throw-safe: a lock that throws still reaps the sidecar children', () => {
    const order: string[] = []
    const ctx = {
      localApi: { stop: async () => Promise.reject(new Error('already stopped')) },
      workspace: {
        shutdown: () => {
          order.push('lock(throws)')
          throw new Error('ENOSPC')
        }
      }
    } as unknown as AppContext
    const errors: string[] = []
    emergencyLock(ctx, {
      detachVaultKey: () => order.push('detach'),
      killSidecarChildren: () => order.push('reap'),
      log: { error: (msg: string) => void errors.push(msg), info: () => undefined }
    })
    expect(order).toEqual(['detach', 'lock(throws)', 'reap'])
    expect(errors.length).toBeGreaterThanOrEqual(1)
    // A null ctx (a crash before initBackend) is safe too.
    expect(() =>
      emergencyLock(null, { detachVaultKey: () => undefined, killSidecarChildren: () => undefined, log: quietLog })
    ).not.toThrow()
  })

  it('index.ts wires the handler: session-end on the main window (win32), powerMonitor shutdown (darwin), the crash path', () => {
    // Source-text pin (idiom: window-security.test.ts) — index.ts cannot be imported under vitest.
    const indexSrc = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    expect(indexSrc).toContain("on('session-end', lifecycle.onSessionEnd)")
    expect(indexSrc).toContain("powerMonitor.on('shutdown'")
    // The crash path itself (not the lifecycle deps binding) calls the lock before exit(1).
    expect(indexSrc).toMatch(/process\.on\('uncaughtException'[\s\S]*?\bemergencyLock\(ctx\)[\s\S]*?process\.exit\(1\)/)
  })
})

describe('overall teardown deadline (#238 / #230)', () => {
  it('bounds the awaited middle at SHUTDOWN_OVERALL_DEADLINE_MS and still locks AFTER it', async () => {
    // §1.4: a REAL timer captured before the fake clock bounds the await below — never count
    // event-loop turns as a time budget.
    const realSetTimeout = setTimeout
    const realClearTimeout = clearTimeout
    vi.useFakeTimers()
    try {
      const order: string[] = []
      const { ctx } = parkedCtx(order) // never released: the parked stop is abandoned
      const p = performShutdown(ctx, {
        inFlightStreams: new Map(),
        detachVaultKey: () => order.push('detach'),
        log: { error: (m) => order.push(`log:${m}`), info: (m) => order.push(`log:${m}`) }
      })
      let resolved = false
      void p.then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(SHUTDOWN_OVERALL_DEADLINE_MS - 1)
      expect(order).toContain('embedder.stop(parked)')
      expect(order).not.toContain('lock') // one ms short of the deadline: still waiting
      expect(resolved).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          p,
          new Promise<never>((_, reject) => {
            bound = realSetTimeout(() => reject(new Error('the lock did not run after the deadline')), 2_000)
          })
        ])
      } finally {
        if (bound) realClearTimeout(bound)
      }
      // The lock and the log flush sit OUTSIDE the raced section: they ran after the deadline
      // fired, although the parked stop never resolved. (A fix that raced the whole tail would
      // resolve on time while abandoning the lock — this ordering is what catches it.)
      const deadlineLog = order.findIndex((l) => l.startsWith('log:') && /deadline/i.test(l))
      expect(deadlineLog).toBeGreaterThan(order.indexOf('embedder.stop(parked)'))
      expect(order.indexOf('detach')).toBeGreaterThan(deadlineLog)
      expect(order[order.length - 1]).toBe('lock')
      expect(order.filter((l) => l === 'lock')).toHaveLength(1)
      expect(order.some((l) => /locking workspace/i.test(l))).toBe(true) // the "quit: locking" line
    } finally {
      vi.useRealTimers()
    }
  })

  // #237: the plaintext-operation settle sits INSIDE the raced section (the deadline can abandon
  // it) but the sweep sits OUTSIDE, beside the lock — so a settle that never resolves still ends
  // with the registered transients shredded before the vault re-encrypts.
  it('sweeps the plaintext operations after a deadline abandoned their settle, before the lock', async () => {
    const realSetTimeout = setTimeout
    const realClearTimeout = clearTimeout
    vi.useFakeTimers()
    try {
      const order: string[] = []
      const ctx = fakeCtx(order) as unknown as {
        plaintextOps: { awaitSettled: () => Promise<boolean> }
      }
      ctx.plaintextOps.awaitSettled = () => {
        order.push('plaintext.settle(parked)')
        return new Promise<boolean>(() => {}) // never resolves — abandoned by the deadline
      }
      const p = performShutdown(ctx as unknown as AppContext, {
        inFlightStreams: new Map(),
        detachVaultKey: () => order.push('detach'),
        log: quietLog
      })
      await vi.advanceTimersByTimeAsync(SHUTDOWN_OVERALL_DEADLINE_MS)
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          p,
          new Promise<never>((_, reject) => {
            bound = realSetTimeout(() => reject(new Error('the lock did not run after the deadline')), 2_000)
          })
        ])
      } finally {
        if (bound) realClearTimeout(bound)
      }
      const i = (label: string): number => order.indexOf(label)
      expect(i('plaintext.settle(parked)')).toBeGreaterThan(i('task-settle'))
      expect(i('plaintext.sweep')).toBeGreaterThan(i('plaintext.settle(parked)'))
      expect(i('plaintext.sweep')).toBeLessThan(i('detach'))
      expect(order[order.length - 1]).toBe('lock')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves no deadline timer pending after a teardown that completes on its own', async () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      await performShutdown(fakeCtx(order), {
        inFlightStreams: new Map(),
        detachVaultKey: () => order.push('detach'),
        log: quietLog
      })
      expect(order[order.length - 1]).toBe('lock')
      expect(vi.getTimerCount()).toBe(0) // the deadline timer was cleared, not left to fire
    } finally {
      vi.useRealTimers()
    }
  })
})
