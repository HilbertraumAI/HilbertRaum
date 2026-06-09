// Shared registry of in-flight stream cancellers, keyed by conversation id.
//
// Both the plain chat path (`sendChatMessage`) and the RAG path (`askDocuments`) register
// their AbortController here while streaming, so a single `stopGeneration(conversationId)`
// handler can cancel either one. Conversation ids are unique across both modes, so one map
// is sufficient. At most one active stream per conversation is ENFORCED by both IPC handlers
// (they reject a new generation while `has(conversationId)` is true), and each handler only
// deletes its own entry on cleanup, so a canceller is never clobbered.
export const inFlightStreams = new Map<string, AbortController>()
