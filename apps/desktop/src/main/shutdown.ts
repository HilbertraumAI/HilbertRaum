import {
  inFlightStreams as realInFlightStreams,
  streamSettled as realStreamSettled,
  awaitInFlightStreamsSettled
} from './ipc/inflight'
import { detachVaultKey as realDetachVaultKey, log as realLog } from './services/logging'
import type { AppContext } from './services/context'

// Graceful QUIT teardown (Electron `will-quit`), extracted from `main/index.ts` so its ORDERING is
// unit-testable with a fake ctx (the real `main/index.ts` registers app handlers at import time and
// cannot be imported under jsdom). The will-quit handler is the only caller.

/** Injection seams so a unit test can drive `performShutdown` without the real singletons. */
export interface ShutdownDeps {
  /** In-flight chat/RAG stream cancellers (REL-4). Defaults to the real shared registry. */
  inFlightStreams?: Map<string, AbortController>
  /** Per-stream "settled" promises (R1). Defaults to the real shared registry. */
  streamSettled?: Map<string, Promise<void>>
  /** Flush the encrypted diagnostics log before `lock()` zeroes the vault key. */
  detachVaultKey?: () => void
  /** Logger (only `error` is used). */
  log?: Pick<typeof realLog, 'error'>
}

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
  // spends up to ~10 s in awaited windows (sidecar stops, the stream settles, the doc-task
  // settle) during which the DB is still OPEN, so `isUnlocked()` is still true and every
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
  // REL-4: abort in-flight chat/RAG streams so each partial reply persists (see the ordering note
  // above). Best-effort per controller — a misbehaving canceller must not block the rest of teardown.
  try {
    for (const controller of inFlightStreams.values()) {
      if (!controller.signal.aborted) controller.abort()
    }
  } catch (err) {
    log.error('Error aborting in-flight streams on quit', String(err))
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
