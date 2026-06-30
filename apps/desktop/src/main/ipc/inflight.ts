// Shared registry of in-flight stream cancellers, keyed by conversation id.
//
// Both the plain chat path (`sendChatMessage`) and the RAG path (`askDocuments`) register
// their AbortController here while streaming, so a single `stopGeneration(conversationId)`
// handler can cancel either one. Conversation ids are unique across both modes, so one map
// is sufficient. At most one active stream per conversation is ENFORCED by both IPC handlers
// (they reject a new generation while `has(conversationId)` is true), and each handler only
// deletes its own entry on cleanup, so a canceller is never clobbered.
export const inFlightStreams = new Map<string, AbortController>()

/** A live snapshot of an in-flight generation's accumulated output. */
export interface StreamBuffer {
  /** Answer tokens accumulated so far (matches the renderer's live streamText). */
  content: string
  /** Deep-mode reasoning deltas accumulated so far (the live "Thinking…" line). */
  reasoning: string
}

// Live accumulated output per in-flight conversation, kept ALONGSIDE the canceller so a
// Chat screen that was unmounted mid-stream (the user navigated away and back) can recover
// the in-progress reply on remount — the token events fired while it was gone are missed
// otherwise, and the still-running generation would otherwise look idle while blocking a
// new message. Written by the stream wrapper as tokens flow; deleted on the same cleanup
// as the canceller, so a `has()` here always mirrors `inFlightStreams`.
export const streamBuffers = new Map<string, StreamBuffer>()

// R1 (full-audit-2026-06-30, Phase C) — per-stream "settled" promise, kept ALONGSIDE the
// canceller. It resolves when the stream wrapper's run has FULLY unwound — including the
// abort-driven partial-reply persistence (`generateAssistantMessage` → `appendMessage`) — so
// the lock/quit teardown can deterministically wait for each aborted partial to persist while
// `ctx.db` is still open, instead of relying on `runtime.stop()` outrunning the abort-unwind.
// Set in lockstep with `inFlightStreams`/`streamBuffers` and deleted on the same cleanup, so a
// `has()` here always mirrors `inFlightStreams`. Never rejects (the wrapper resolves it in its
// `finally`); always awaited via `allSettled` so one stream can't block teardown.
export const streamSettled = new Map<string, Promise<void>>()

/**
 * R1 — await every in-flight stream's settle (its abort-unwind partial-reply persistence) so a
 * lock/quit closes the DB only AFTER each partial has persisted. Snapshots the live promises (a
 * stream that already finished has removed its entry, so only still-pending ones are awaited).
 * Best-effort: `allSettled` so a misbehaving stream's rejection cannot block teardown.
 *
 * CONTRACT — the caller MUST `controller.abort()` every in-flight stream FIRST so they are
 * actually unwinding when this is awaited; otherwise a long generation would stall teardown.
 */
export async function awaitInFlightStreamsSettled(
  settled: Map<string, Promise<void>> = streamSettled
): Promise<void> {
  await Promise.allSettled([...settled.values()])
}
