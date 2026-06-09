// Shared registry of in-flight stream cancellers, keyed by conversation id.
//
// Both the plain chat path (`sendChatMessage`) and the RAG path (`askDocuments`) register
// their AbortController here while streaming, so a single `stopGeneration(conversationId)`
// handler can cancel either one. Conversation ids are unique across both modes, so one map
// is sufficient (there is at most one active stream per conversation).
export const inFlightStreams = new Map<string, AbortController>()
