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

  // Abort an in-flight deep-index build before stopping the sidecars (plan §4.1 M9): it is not in
  // inFlightStreams, so nothing else would stop it, and it would keep using the runtime as it is torn
  // down. Leaves the tree resumable (reconcileStuckTrees on relaunch).
  try {
    ctx?.docTasks?.abortActiveBuild()
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
  // Flush the encrypted diagnostics log to disk while the vault key is still live (lock() zeroes it).
  // No-op for plaintext_dev (that log is appended in real time).
  detachVaultKey()
  // Lock (re-encrypt + shred) the plaintext working DB. No-op for plaintext_dev.
  try {
    ctx?.workspace.lock()
  } catch (err) {
    log.error('Failed to lock workspace on quit', String(err))
  }
}
