import type {
  Conversation,
  CoverageInfo,
  EvidencePackLanguage,
  EvidencePackOptions,
  Message
} from './types'
import type { MessageKey, UiLanguageInfo } from './i18n'

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

/**
 * #643: did this answer's ONE grounded turn show the model every cited section under its `[Sn]`
 * label (a whole document read in order, or the compare whole read)? Then its citations are
 * labelled excerpts, like a relevance answer's, not whole-document provenance. Honoured for
 * `capped` only — no other mode can mint labels. The one reading of `coverage.labelledExcerpts`
 * shared by the chat Sources disclosure, the evidence snapshot and the review caption.
 */
export function hasLabelledExcerpts(
  coverage: Pick<CoverageInfo, 'mode' | 'labelledExcerpts'> | null | undefined
): boolean {
  return coverage?.mode === 'capped' && coverage.labelledExcerpts === true
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
 * #643: a `capped` answer stamped `labelledExcerpts` (one grounded turn over the whole
 * document, its sections shown as `[Sn]` excerpts) reads as relevance too — its sources ARE
 * the excerpts supplied to the model, and the snapshot made them direct excerpts.
 */
export function evidencePaneMode(coverage: CoverageInfo | null): EvidencePaneMode {
  const mode = coverage?.mode
  if (mode == null || mode === 'relevance') return 'relevance'
  if (hasLabelledExcerpts(coverage)) return 'relevance'
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

/**
 * The export dialog's line per pack language (i18n record D-L11): one full sentence per
 * language, never a sentence with the language name interpolated, because a language name
 * inside a sentence needs case and lower-casing in Russian, French, Spanish and Italian.
 * Its keys are also the set of pack languages: adding one is a compile error here until
 * its sentence exists.
 */
const PACK_LANGUAGE_LINE = {
  en: 'review.export.packLanguage.en',
  de: 'review.export.packLanguage.de'
} as const satisfies Record<EvidencePackLanguage, MessageKey>

/** Whether `value` is a language evidence packs can be written in (the export boundary's
 *  guard: anything else exports in English). */
export function isPackLanguage(value: unknown): value is EvidencePackLanguage {
  return typeof value === 'string' && Object.hasOwn(PACK_LANGUAGE_LINE, value)
}

/**
 * The language a pack exported from this UI language is written in
 * (UI-languages owner call D-5 (b), 2026-11-11): the UI language itself when its registry
 * entry writes evidence packs (`evidencePack`), English otherwise. Production passes the
 * real registry entry (`uiLanguageInfo(lang)`).
 */
export function packLanguageFor(
  info: Pick<UiLanguageInfo, 'code' | 'evidencePack'>
): EvidencePackLanguage {
  return info.evidencePack && isPackLanguage(info.code) ? info.code : 'en'
}

/**
 * The key of the export dialog's pack-language line for this UI language, or null when
 * the pack is written in the UI language itself (there is nothing to point out).
 */
export function packLanguageLineKey(
  info: Pick<UiLanguageInfo, 'code' | 'evidencePack'>
): MessageKey | null {
  const pack = packLanguageFor(info)
  return pack === info.code ? null : PACK_LANGUAGE_LINE[pack]
}
