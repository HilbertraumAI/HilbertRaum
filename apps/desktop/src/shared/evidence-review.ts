import type { Conversation, CoverageInfo, EvidencePackOptions, Message } from './types'

// Evidence Pack / Review Mode — the entry-point eligibility rule (spec §9.1), as ONE pure
// shared predicate so the renderer action row, the sources-disclosure footer (Phase 2) and
// any main-side guard can never disagree about which answers offer a review. Phase 3 adds
// the shared honesty-mode mapping and the pack-export option defaults (plan §8).

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

/** The three honesty-caption classes an answer's evidence presents as (spec §11.4/§24.3). */
export type EvidencePaneMode = 'relevance' | 'whole_doc' | 'structured'

/**
 * Map a snapshotted coverage mode to its honesty class — THE one mapping shared by the
 * review workspace's evidence pane (Phase 2) and the pack's coverage/limitations section
 * (Phase 3), mirroring the Phase-1 snapshot builder (`sourceKindForMode`): relevance/ABSENT
 * → relevance (those citations are labeled excerpts, the renderer `isProvenance`
 * precedent); extract → structured; tree/capped and any UNKNOWN-but-present mode →
 * whole-document — always degrading toward the WEAKER claim (an unknown mode must never
 * present provenance as citations). Moved here from renderer/review/EvidencePane.tsx in
 * Phase 3 so main-side pack building reuses it instead of re-deriving the kind map.
 */
export function evidencePaneMode(coverage: CoverageInfo | null): EvidencePaneMode {
  const mode = coverage?.mode
  if (mode == null || mode === 'relevance') return 'relevance'
  if (mode === 'extract') return 'structured'
  return 'whole_doc'
}

/**
 * Pack-export option defaults (spec §16.2, plan §8.1) — shared so the renderer's export
 * panel and main's `resolveEvidencePackOptions` can never disagree. §16.1-mandated content
 * (notes, excerpts, hashes, unreviewed items) defaults ON; the extra technical subsection
 * defaults OFF. Privacy-sensitive data has no flag at all: the snapshot carries no file
 * paths, so paths are structurally absent from every pack.
 */
export const EVIDENCE_PACK_OPTION_DEFAULTS: Omit<EvidencePackOptions, 'language'> = {
  includeReviewerNotes: true,
  includeSourceExcerpts: true,
  includeDocumentHashes: true,
  includeUnreviewedItems: true,
  includeTechnicalDetails: false
}
