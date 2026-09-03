import {
  inFlightStreams as realInFlightStreams,
  streamSettled as realStreamSettled,
  awaitInFlightStreamsSettled
} from './ipc/inflight'
import { detachVaultKey as realDetachVaultKey, log as realLog } from './services/logging'
import { killRegisteredSidecarChildren } from './services/runtime/sidecar'
import type { AppContext } from './services/context'

// Graceful QUIT teardown (Electron `will-quit`), extracted from `main/index.ts` so its ORDERING is
// unit-testable with a fake ctx (the real `main/index.ts` registers app handlers at import time and
// cannot be imported under jsdom). The will-quit handler is the only caller. The SYNCHRONOUS
// best-effort lock the crash path and the OS session-end handler share (`emergencyLock`, #248)
// lives here too, for the same reason.

/** Injection seams so a unit test can drive `performShutdown` without the real singletons. */
export interface ShutdownDeps {
  /** In-flight chat/RAG stream cancellers (REL-4). Defaults to the real shared registry. */
  inFlightStreams?: Map<string, AbortController>
  /** Per-stream "settled" promises (R1). Defaults to the real shared registry. */
  streamSettled?: Map<string, Promise<void>>
  /** Flush the encrypted diagnostics log before `lock()` zeroes the vault key. */
  detachVaultKey?: () => void
  /** Logger (`error`, plus `info` for the two quit-progress lines. (#238) */
  log?: Pick<typeof realLog, 'error' | 'info'>
}

/**
 * Overall bound on the AWAITED MIDDLE of `performShutdown` (#238, #230;
 * owner decision 13 unanswered → this default, #230): the local-API stop, the sidecar stops, the
 * stream settle, the doc-task settle and the plaintext-operation settle (#237) are raced as ONE
 * section against this deadline. The per-step bounds sum to 25.5 s (local API ≤ 0.5 s; sidecars
 * ≤ 10 s — the transcriber's suspend timeout; streams 5 s; doc tasks 5 s; plaintext operations
 * 5 s), so 30 s only ever fires on a step that is not honouring its own bound. When it fires,
 * the teardown logs, ABANDONS the parked promises and
 * goes straight on to the log flush + the vault lock — the lock is never inside the race (a
 * deadline that abandoned the lock would reproduce the hard-kill outcome it exists to prevent).
 * Whatever a parked sidecar stop left behind is reaped synchronously right before `app.exit`
 * (`killRegisteredSidecarChildren`, the CODE-11 crash-path reaper, now also run by the quit
 * handler's finally — see `createAppLifecycleHandlers`).
 */
export const SHUTDOWN_OVERALL_DEADLINE_MS = 30_000

/**
 * Stop the sidecars and AWAIT their exit so no orphaned `llama-server` survives, then re-encrypt +
 * shred the plaintext working DB (encrypted vault only). `runtime.stop()` waits a couple of seconds
 * for the child to die, so this MUST be awaited — a fire-and-forget would let Electron tear down
 * mid-kill and orphan the children.
 *
 * Ordering (REL-4, full-audit-2026-06-29 follow-up): abort the in-flight deep-index build AND the
 * in-flight chat/RAG streams BEFORE `runtime.stop()`, mirroring the workspace-LOCK path
 * (`registerWorkspaceIpc.lockWorkspace`). A `controller.abort()` makes the generation loop unwind as
 * an ABORT, so `generateAssistantMessage` persists the partial reply (synchronously, via
 * `appendMessage`) while `ctx.db` is still open — `lock()` runs last. Killing the sidecar first
 * (the previous quit ordering: `runtime.stop()` with no prior abort) instead throws a NON-abort
 * stream error, and the partial is dropped rather than persisted-as-partial.
 *
 * R1 (full-audit-2026-06-30, Phase C) SUPERSEDES the original "the partial persists during the
 * awaited `runtime.stop()` window" reliance: that was a RACE (for an already-exited/mock sidecar
 * `runtime.stop()` can resolve before the abort-unwind reaches `appendMessage`). The teardown now
 * explicitly awaits each stream's SETTLE (`awaitInFlightStreamsSettled`) after the sidecar stop and
 * before `lock()`, so persist-before-close is the ORDERING, not a race — mirroring `lockWorkspace`.
 */
export async function performShutdown(ctx: AppContext | null, deps: ShutdownDeps = {}): Promise<void> {
  const inFlightStreams = deps.inFlightStreams ?? realInFlightStreams
  const streamSettled = deps.streamSettled ?? realStreamSettled
  const detachVaultKey = deps.detachVaultKey ?? realDetachVaultKey
  const log = deps.log ?? realLog

  // AUD-02 — arm the WORKSPACE lock latch FIRST, and in its OWN best-effort try (two latches
  // sharing one `catch` would make whichever runs second silently optional). The teardown below
  // spends up to ~25.5 s in awaited windows (the local-API stop ≤ 0.5 s, the sidecar stops ≤ 10 s,
  // the stream settle ≤ 5 s, the doc-task settle ≤ 5 s, the plaintext-operation settle ≤ 5 s — bounded as a whole by
  // `SHUTDOWN_OVERALL_DEADLINE_MS`) during which the DB is still OPEN, so `isUnlocked()` is still true and every
  // content-surface guard still admits. Most sidecars are safe here because QUIT uses the
  // permanently-latching `stop()` where lock uses the non-latching `suspend()` — a translate or
  // embed admitted now fails at `ensureStarted` instead of respawning. Two are not:
  //   • VISION rebuilds its runtime per analyze and clears its `tearingDown` flag in `stop()`'s
  //     own `finally`, so once `vision.stop()` resolves inside the `allSettled` below an admitted
  //     `imageAnalyze` builds a FRESH ~4.6 GB llama-server, which then ORPHANS at `app.exit(0)`
  //     (loopback port + GBs of RAM held, Windows especially).
  //   • An admitted IMPORT decrypts a document to a plaintext transient; `app.exit(0)` landing
  //     between that write and the `finally` that shreds it strands plaintext on the drive until
  //     the next launch's crash sweep.
  // Nothing on this path clears the latch and the process exits, so arming it is terminal by
  // construction — exactly what quit wants.
  try {
    ctx?.workspace.beginLock?.()
  } catch {
    /* best-effort */
  }
  // CODE-3 (full-audit 2026-07-11): arm the runtime manager's PERMANENT shutdown latch before
  // anything else runtime-related. `maybeAutoStartActiveModel` hashes a multi-GB weight before it
  // ever touches the manager; if that hash completes during this teardown's awaited windows, the
  // background start would otherwise enqueue AFTER the `runtime.stop()` below — and `app.exit(0)`
  // then kills the parent mid-start, orphaning the child (loopback port + GBs of RAM, Windows
  // especially). With the latch armed, `start()` rejects without invoking the factory. Latch-only
  // and synchronous — the awaited stop stays in the sidecar block below (REL-4 ordering intact).
  try {
    ctx?.runtime.shutdown()
  } catch {
    /* best-effort */
  }
  // Abort an in-flight deep-index build before stopping the sidecars (plan §4.1 M9): it is not in
  // inFlightStreams, so nothing else would stop it, and it would keep using the runtime as it is torn
  // down. Leaves the tree resumable (reconcileStuckTrees on relaunch).
  try {
    ctx?.docTasks?.abortActiveBuild()
    // H1 (TA-1): a running translation doc-task must be cancelled — and the whole queue flushed —
    // BEFORE the sidecars stop, mirroring the lock path. Left uncancelled on quit, `translator.stop()`
    // kills its in-flight window, retries fail fast against the `stopped` latch, and a task with an
    // already-succeeded window proceeds to `materializeDocument` DURING teardown — writing a
    // half-translated plaintext transient that races the DB close (plaintext on the drive until the
    // next-launch sweep if a hard exit lands between the write and the `finally` shred). The abort-unwind
    // is awaited below (while ctx.db is still open) so it settles before `lock()`.
    ctx?.docTasks?.cancelAllDocTasks?.()
    // Abort an in-flight Translate-view job (TG-4) too, before the sidecar stop below — its next
    // window would otherwise call translate() and race a lazy respawn of the server being killed.
    void ctx?.translateJobs?.stop()
  } catch {
    /* best-effort */
  }
  // #237: abort every plaintext operation in flight (a preview, re-index, import prepare,
  // dictation or export holding a `.parse*` transient) now, so it has the whole teardown to
  // unwind; its settle is awaited inside the deadline section below and its transients are
  // swept right before the lock.
  try {
    ctx?.plaintextOps?.abortAll()
  } catch {
    /* best-effort */
  }
  // REL-4: abort in-flight chat/RAG streams so each partial reply persists (see the ordering note
  // above). Best-effort per controller — a misbehaving canceller must not block the rest of teardown.
  try {
    for (const controller of inFlightStreams.values()) {
      if (!controller.signal.aborted) controller.abort()
    }
  } catch (err) {
    log.error('Error aborting in-flight streams on quit', String(err))
  }
  // #238 / #230: the five awaited steps below are bounded as a WHOLE by
  // `SHUTDOWN_OVERALL_DEADLINE_MS` (see the constant). The log flush and the lock stay OUTSIDE.
  await withOverallDeadline(async () => {
    // The local API dies BEFORE the sidecars (local-api wave): stop() aborts active + queued
    // external streams and closes every socket, so no outside caller holds the model while
    // the children below are killed. In-process (no orphan class) — but awaited so its
    // sockets are deterministically gone before the vault work.
    try {
      await (ctx?.localApi?.stop() ?? Promise.resolve())
    } catch (err) {
      log.error('Error stopping the local API on quit', String(err))
    }
    try {
      await Promise.allSettled([
        ctx?.runtime.stop() ?? Promise.resolve(),
        ctx?.embedder.stop?.() ?? Promise.resolve(),
        ctx?.reranker?.stop?.() ?? Promise.resolve(),
        ctx?.transcriber?.stop?.() ?? Promise.resolve(),
        ctx?.ocrEngine?.stop?.() ?? Promise.resolve(),
        // The vision sidecar is a 4th co-resident llama-server (PROD-1) — kill it too so no
        // child orphans on quit.
        ctx?.vision?.stop() ?? Promise.resolve(),
        // The TranslateGemma sidecar (TG wave) is a 5th co-resident llama-server — permanent stop()
        // so its child + its KV cache of recent source/translation text never orphan on quit.
        ctx?.translator?.stop?.() ?? Promise.resolve()
      ])
    } catch (err) {
      log.error('Error stopping sidecars on quit', String(err))
    }
    // R1 (full-audit-2026-06-30, Phase C): deterministically await each aborted stream's SETTLE
    // (its partial-reply persistence) before lock() closes the DB — the same guarantee the lock
    // path now makes. The aborts above unwind each generation as an ABORT so the partial persists
    // via `appendMessage` while `ctx.db` is open, but that runs in the stream's OWN promise this
    // teardown never awaited; the REL-4 ordering only ensured the abort fired FIRST, still racing
    // `runtime.stop()` vs the abort-unwind. Awaiting the settle makes persist-before-close the
    // ordering. After the sidecar stop so a generation ignoring its signal is unwound by the dead
    // sidecar (no quit stall). Best-effort (`allSettled`).
    await awaitInFlightStreamsSettled(streamSettled)
    // H1 (TA-1): await the cancelled doc-task's abort-unwind before lock() closes the DB. The
    // translation handler persists/shreds its `.parse` transient synchronously during the unwind
    // while ctx.db is open; awaiting the settle here makes cleanup-before-close the ORDERING, not a
    // race. Bounded (~5 s) so a wedged handler can never hang quit. Mirrors the stream-settle above.
    await awaitActiveDocTaskSettled(ctx, log)
    // #237: then the plaintext operations aborted above — same bound. A parser that cannot cancel
    // (pdfjs, mammoth) outlives it; the sweep below (outside this section, so a deadline that
    // abandons this settle still reaches it) shreds its transient before the lock.
    await awaitPlaintextOpsSettled(ctx, log)
  }, log)
  sweepPlaintextOps(ctx, log)
  // #238: by now no window is left (Windows/Linux quit after window-all-closed), so this line
  // is the only visible state of a quit that is locking — and it lands in the encrypted log
  // because it precedes the flush below.
  log.info('quit: locking workspace')
  // Flush the encrypted diagnostics log to disk while the vault key is still live (lock() zeroes it).
  // No-op for plaintext_dev (that log is appended in real time).
  detachVaultKey()
  // Lock (re-encrypt + shred) the encrypted vault's working DB; for plaintext_dev — where
  // lock() is a no-op — checkpoint + close so no -wal/-shm sidecars remain on the drive at
  // rest (issue #51: at-rest WAL sidecars on a non-journaling exFAT stick read as "the last
  // session never closed cleanly" and worsen hard-unplug outcomes).
  try {
    ctx?.workspace.shutdown()
  } catch (err) {
    log.error('Failed to lock workspace on quit', String(err))
  }
}

/**
 * Race `section` against `SHUTDOWN_OVERALL_DEADLINE_MS` (#238 / #230). On the deadline the
 * section's promise is abandoned (its rejection, if any, is swallowed so it can never surface as
 * an unhandled rejection later) and the caller proceeds; on completion the timer is cleared so a
 * finished teardown never holds a live handle. The timer is unref'd for the same reason.
 */
async function withOverallDeadline(
  section: () => Promise<void>,
  log: Pick<typeof realLog, 'error'>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.error(
        'quit: overall teardown deadline reached — abandoning the parked stops and locking the workspace now',
        { deadlineMs: SHUTDOWN_OVERALL_DEADLINE_MS }
      )
      resolve()
    }, SHUTDOWN_OVERALL_DEADLINE_MS)
    timer.unref()
  })
  // The section cannot reject today (every step is try/caught or `allSettled`); the catch makes
  // that structural, so neither a pre-deadline rejection nor an abandoned one can skip the lock.
  const raced = section().catch((err) => log.error('quit: teardown section failed', String(err)))
  try {
    await Promise.race([raced, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---- The synchronous best-effort lock (crash path + OS session end) -------------------

/** Injection seams for `emergencyLock` (defaults are the real singletons). */
export interface EmergencyLockDeps {
  /** Flush the encrypted diagnostics log before `lock()` zeroes the vault key. */
  detachVaultKey?: () => void
  /** `killRegisteredSidecarChildren` — the synchronous, throw-safe-per-PID reaper. */
  killSidecarChildren?: () => void
  log?: Pick<typeof realLog, 'error' | 'info'>
}

/**
 * Lock the workspace NOW, synchronously and best-effort, for a process that is about to die
 * without `will-quit`: the `uncaughtException` crash path (`main/index.ts`) and an OS session
 * end (#248 — Windows `session-end`, macOS `powerMonitor` `shutdown`). NOT the awaited
 * `performShutdown` teardown: nothing here can be awaited, because whoever called this exits
 * or is killed as soon as it returns. In order: arm the workspace lock latch (so no content
 * surface admits new work between here and the kill), fire-and-forget the local API's stop
 * (in-process, no orphan class — only so live external sockets abort instead of dangling until
 * the OS reaps them), flush the encrypted log while the vault key is live, then
 * `workspace.shutdown()` = `lock()` (re-encrypt + shred the plaintext working DB; for
 * `plaintext_dev` a checkpoint + close so no `-wal`/`-shm` outlive the process, #51). Then reap
 * every registered sidecar child: on Windows the children survive the parent, so without this
 * a `llama-server` holding GBs of RAM and a loopback port outlives the session (the data-safety
 * half first, the hygiene half in its OWN try so a lock throw cannot skip it). A failed lock is
 * logged and left to the next launch's recovery (`workspace.shutdown()` closes the re-opened
 * handle so the working file rests bare and newer than `.enc` — the salvage signature `init()`
 * rolls forward instead of shredding).
 */
export function emergencyLock(ctx: AppContext | null, deps: EmergencyLockDeps = {}): void {
  const detachVaultKey = deps.detachVaultKey ?? realDetachVaultKey
  const killSidecarChildren = deps.killSidecarChildren ?? killRegisteredSidecarChildren
  const log = deps.log ?? realLog
  try {
    ctx?.workspace.beginLock?.()
  } catch {
    /* best-effort */
  }
  try {
    void ctx?.localApi?.stop().catch(() => {})
  } catch {
    /* best-effort */
  }
  try {
    detachVaultKey()
    ctx?.workspace.shutdown()
  } catch (err) {
    log.error('emergency lock failed — the next launch recovers the working copy', String(err))
  }
  try {
    killSidecarChildren()
  } catch {
    /* best-effort */
  }
}

// ---- The Electron app-lifecycle handlers (#238) -------------------

/** The subset of Electron's `will-quit` event the handler uses (kept electron-free for tests). */
export interface WillQuitEventLike {
  preventDefault(): void
}

/**
 * The subset of Electron's `WindowSessionEndEvent` (Windows `session-end`) the handler reads;
 * the macOS `powerMonitor` `shutdown` listener is typed without an event.
 */
export interface SessionEndEventLike {
  reasons?: ReadonlyArray<string>
}

/** The Electron surface the handlers touch — injected so `tests/unit/shutdown.test.ts` drives them. */
export interface AppLifecycleDeps {
  /** The graceful teardown; the real caller binds `performShutdown(ctx)`. Never expected to reject. */
  performShutdown: () => Promise<void>
  /**
   * The synchronous best-effort lock for a process that is about to be killed without a quit
   * (#248); the real caller binds `emergencyLock(ctx)`. Never expected to throw.
   */
  emergencyLock: () => void
  /** `app.exit` — the ONLY way the process leaves once a quit has begun. */
  exit: (code: number) => void
  /** `createWindow` (a macOS Dock click fires `activate` with no window open). */
  createWindow: () => void
  /** `BrowserWindow.getAllWindows().length`. */
  windowCount: () => number
  /**
   * `killRegisteredSidecarChildren` — reaps, synchronously and right before `exit`, whatever a
   * deadline-abandoned sidecar stop left behind (the CODE-11 crash-path reaper, reused). A no-op
   * after a teardown that completed: every stopped child unregistered itself on exit.
   */
  killSidecarChildren: () => void
  log: Pick<typeof realLog, 'error' | 'info'>
}

export interface AppLifecycleHandlers {
  onWillQuit: (event: WillQuitEventLike) => void
  onActivate: () => void
  /**
   * The OS is ending the session (#248): Windows `session-end` on the main window (a shutdown,
   * restart or log-off — cannot be prevented; the process is killed once the handler returns),
   * or macOS `powerMonitor` `shutdown` (unverified on a Mac — #226). Runs `emergencyLock` once.
   */
  onSessionEnd: (event?: SessionEndEventLike) => void
  /** True from the first `will-quit` or session end on (tests + diagnostics). */
  isShuttingDown: () => boolean
}

/**
 * ONE factory over ONE `isShuttingDown` closure (#238).
 * Before this, `main/index.ts` held the flag inline: the `will-quit` re-entry branch returned
 * WITHOUT `preventDefault()` — its comment assumed "cleanup already ran", but the flag is set
 * BEFORE `performShutdown` starts, so a second quit while the teardown was still awaiting a
 * sidecar stop (a wedged cold start held it up to 180 s — #244) let Electron's default quit
 * proceed with the working DB still plaintext on the drive: the next launch found a live WAL,
 * declined to preserve it and shredded it — every change since the last lock lost. On macOS a
 * second ⌘Q while the app sits windowless in the Dock reaches exactly that branch. And a Dock
 * click (`activate`) during the parked teardown opened a fresh window against a workspace whose
 * runtime latch and lock latch were already armed.
 *
 * The handlers must share the closure: a per-handler copy of the flag would freeze the
 * activate guard at `false` in production while a test constructing it with `true` still passed.
 * `main/index.ts` cannot be imported under vitest (it takes the single-instance lock and may call
 * `app.exit` at module scope), so everything Electron is injected via `AppLifecycleDeps`.
 *
 * #248 — the OS session-end handler shares it too, so a session end and a quit can never lock
 * twice, whichever arrives first: a session end during a running quit teardown defers to it
 * (that teardown owns the lock and exits from its own finally — on Windows this ordering cannot
 * even occur, `session-end` is a window event and the quit closed every window before
 * `will-quit`); a `will-quit` AFTER the session-end lock exits at once instead of starting the
 * teardown — the vault is already locked and the children reaped, and a prevented quit that never
 * exited would make macOS report the app as cancelling the shutdown.
 */
export function createAppLifecycleHandlers(deps: AppLifecycleDeps): AppLifecycleHandlers {
  let shuttingDown = false
  /** The session-end lock ran (nothing awaits; a later `will-quit` has nothing left to do). */
  let sessionEndLocked = false
  return {
    onWillQuit: (event) => {
      // #238: EVERY will-quit is prevented — the first one starts the teardown, any later one
      // arrives while it is still running (the DB is plaintext until `performShutdown` locks
      // it). The teardown's own finally is the only exit; `app.exit` re-emits nothing.
      event.preventDefault()
      if (shuttingDown) {
        if (sessionEndLocked) {
          sessionEndLocked = false // exit once; `app.exit` returns nothing to re-enter with
          // Reap again right before the exit: on macOS a cancelled system shutdown leaves the
          // app alive after the lock, and a background model auto-start could have spawned a
          // child since (`emergencyLock` arms the workspace latch, not the runtime latch).
          try {
            deps.killSidecarChildren()
          } catch {
            /* best-effort */
          }
          deps.exit(0)
        }
        return
      }
      shuttingDown = true
      void deps
        .performShutdown()
        .catch((err) => deps.log.error('quit: teardown failed', String(err)))
        .finally(() => {
          try {
            deps.killSidecarChildren()
          } catch {
            /* best-effort */
          }
          deps.exit(0)
        })
    },
    onActivate: () => {
      // #238: no fresh window once a quit has begun.
      if (shuttingDown) return
      if (deps.windowCount() === 0) deps.createWindow()
    },
    onSessionEnd: (event) => {
      // #248: once only, and never beside a running quit teardown (see the factory comment).
      if (shuttingDown) {
        deps.log.info('session-end: a quit teardown is already running — it owns the lock')
        return
      }
      shuttingDown = true
      sessionEndLocked = true
      // Logged BEFORE the lock so the line lands in the encrypted log (the lock flushes it).
      deps.log.info('session-end: locking workspace', { reasons: event?.reasons ?? [] })
      try {
        deps.emergencyLock()
      } catch (err) {
        deps.log.error('session-end: lock failed', String(err))
      }
    },
    isShuttingDown: () => shuttingDown
  }
}

/** Upper bound on how long quit/lock waits for a cancelled doc-task to unwind (H1/TA-1). */
const SHUTDOWN_TASK_SETTLE_TIMEOUT_MS = 5_000

/**
 * Await the currently-running doc-task's abort-unwind, bounded by a timeout so a wedged handler
 * cannot hang quit (H1/TA-1). The manager persists/shreds its transient synchronously during the
 * unwind while `ctx.db` is open, so this must run before `lock()`. Best-effort — never throws.
 */
async function awaitActiveDocTaskSettled(
  ctx: AppContext | null,
  log: Pick<typeof realLog, 'error'>
): Promise<void> {
  let settle: Promise<void> | undefined
  try {
    settle = ctx?.docTasks?.awaitActiveTaskSettled?.()
  } catch (err) {
    log.error('Error awaiting doc-task settle on quit', String(err))
    return
  }
  if (!settle) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHUTDOWN_TASK_SETTLE_TIMEOUT_MS)
    timer.unref()
  })
  try {
    await Promise.race([settle.catch(() => undefined), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Await the aborted plaintext operations (preview / re-index / import prepare / dictation /
 * export) within `SHUTDOWN_TASK_SETTLE_TIMEOUT_MS` (#237). Best-effort — never throws.
 */
async function awaitPlaintextOpsSettled(
  ctx: AppContext | null,
  log: Pick<typeof realLog, 'error' | 'info'>
): Promise<void> {
  const ops = ctx?.plaintextOps
  if (!ops) return
  try {
    const settled = await ops.awaitSettled(SHUTDOWN_TASK_SETTLE_TIMEOUT_MS)
    if (!settled) log.info('quit: plaintext operations still running at the settle bound', { live: ops.size() })
  } catch (err) {
    log.error('Error settling plaintext operations on quit', String(err))
  }
}

/** Shred every still-registered `.parse*` transient (only registered paths — never a stored copy). */
function sweepPlaintextOps(ctx: AppContext | null, log: Pick<typeof realLog, 'error' | 'info'>): void {
  try {
    const swept = ctx?.plaintextOps?.sweepRegistered() ?? 0
    if (swept > 0) log.info('quit: swept registered plaintext transients', { swept })
  } catch (err) {
    log.error('Error sweeping plaintext transients on quit', String(err))
  }
}
