import type { Conversation, Message } from './types'

// Evidence Pack / Review Mode — the entry-point eligibility rule (spec §9.1), as ONE pure
// shared predicate so the renderer action row, the sources-disclosure footer (Phase 2) and
// any main-side guard can never disagree about which answers offer a review.

/**
 * Whether an answer can offer "Review evidence" (spec §9.1): it must be an ASSISTANT
 * message that is document-grounded — it carries citations or coverage metadata, or lives
 * in a documents conversation (pass the conversation when known; omitting it simply makes
 * the check rest on the message's own metadata).
 *
 * The spec's third condition — "persisted and no longer streaming" — is the CALLER's
 * state: a still-streaming reply has no persisted row yet, so the renderer must gate on
 * its own streaming flag before consulting this predicate (Phase 2 wires that).
 */
export function isReviewEligible(
  message: Pick<Message, 'role' | 'citations' | 'coverage'>,
  conversation?: Pick<Conversation, 'mode'> | null
): boolean {
  if (message.role !== 'assistant') return false
  if (message.citations && message.citations.length > 0) return true
  if (message.coverage != null) return true
  return conversation?.mode === 'documents'
}
