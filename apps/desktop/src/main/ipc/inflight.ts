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
