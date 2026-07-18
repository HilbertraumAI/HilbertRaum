import type {
  CoverageInfo,
  EvidenceExportFormat,
  EvidenceGenerationSnapshot,
  EvidencePackLanguage,
  EvidencePackOptions,
  EvidenceReadyGate,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewStatus,
  EvidenceSourceFreshnessState,
  EvidenceSourceSnapshot,
  ReviewDecision
} from '../../../shared/types'
import {
  EVIDENCE_PACK_OPTION_DEFAULTS,
  evidencePaneMode,
  type EvidencePaneMode
} from '../../../shared/evidence-review'

// Evidence-pack model (EP-1 plan §8.1, pure): normalize ONE stored review read-model into
// the nine mandatory §16.1 sections + the §16.2 option flags, ready for the fixed HTML
// template. Built from its INPUTS only — no workspace re-reads, no model runtime, no
// network. Availability facts are the ones recorded at review creation PLUS, since P4, the
// at-export freshness verdict the pipeline INJECTS (spec §20.1 refresh step — computed
// outside from stored facts, passed in like packId/generatedAt so the model stays pure);
// with no verdict injected the pack honestly says "not re-verified" (`freshnessNote`).
// Honesty rules carried through from Phases 0–2:
//  - malformed/absent metadata stays null and renders "Unavailable" — NEVER invented
//    (spec §20.2/§25.5); the tolerant row→DTO parsers upstream already degraded toward the
//    weaker claim, and this module never repairs a null into a value.
//  - the coverage honesty class REUSES the shared `evidencePaneMode` mapping (the Phase-1
//    `sourceKindForMode` semantics — unknown-but-present modes stay whole-document/WEAK);
//    per-source kinds come from the stored snapshot verbatim.
//  - `identity: 'unresolved'` sources present as "identity could not be verified" —
//    DISTINCT from resolved-but-missing (P0/P1 semantics; the renderer keys differ).
// Determinism: same detail + same options + same language ⇒ identical model except the
// injected `packId` + `generatedAt` (minted by the pipeline, normalized by golden tests).

/** Stamped into every pack and every `evidence_exports.schema_version` row. */
export const EVIDENCE_PACK_SCHEMA_VERSION = 1

/** Fixed decision order for the summary counts (mirrors the UI's DECISION_ORDER). */
export const PACK_DECISION_ORDER: readonly ReviewDecision[] = [
  'supported',
  'partly_supported',
  'not_supported',
  'follow_up',
  'not_applicable',
  'not_reviewed'
]

const RELATION_ORDER = ['supports', 'qualifies', 'contradicts', 'context'] as const
type PackRelation = (typeof RELATION_ORDER)[number]

/**
 * Untrusted-boundary resolver for the renderer's export-panel payload: known boolean flags
 * are kept only when literally boolean, `language` only when literally 'de' (else 'en'),
 * everything else falls back to `EVIDENCE_PACK_OPTION_DEFAULTS`. Unknown keys are DROPPED
 * (the sanitize-patch idiom) — the resolved set is what gets persisted to
 * `evidence_exports.options_json`, so garbage can never masquerade as a recorded choice.
 */
export function resolveEvidencePackOptions(raw: unknown): EvidencePackOptions {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const flag = (name: keyof Omit<EvidencePackOptions, 'language'>): boolean =>
    typeof v[name] === 'boolean' ? (v[name] as boolean) : EVIDENCE_PACK_OPTION_DEFAULTS[name]
  return {
    language: v.language === 'de' ? 'de' : 'en',
    includeReviewerNotes: flag('includeReviewerNotes'),
    includeSourceExcerpts: flag('includeSourceExcerpts'),
    includeDocumentHashes: flag('includeDocumentHashes'),
    includeUnreviewedItems: flag('includeUnreviewedItems'),
    includeTechnicalDetails: flag('includeTechnicalDetails')
  }
}

/** One evidence link as the pack renders it (item → register entry by 1-based index). */
export interface EvidencePackLink {
  /** 1-based index into `EvidencePackModel.evidence`; null when the stored key matches no
   *  snapshot source (tolerated, rendered without an anchor — never invented). */
  sourceIndex: number | null
  /** Display label: the source's document title (falls back to the raw evidence key). */
  label: string
  /** Machine citation label ("S1") for direct excerpts; localized at render. */
  machineLabel: string | null
  origin: 'answer_marker' | 'reviewer'
  relation: PackRelation | null
}

/** One item-by-item entry (§16.1.4). */
export interface EvidencePackItem {
  ordinal: number
  kind: 'block' | 'selection'
  heading: boolean
  text: string
  decision: ReviewDecision
  /** null = no note recorded OR notes excluded by options (the renderer distinguishes via
   *  `options.includeReviewerNotes`). */
  note: string | null
  links: EvidencePackLink[]
}

/** One evidence-register entry (§16.1.5) — also feeds the source register (§16.1.7). */
export interface EvidencePackSource {
  /** 1-based, stable anchor identity (`#src-{index}`) — index-derived, never content-derived. */
  index: number
  key: string
  machineLabel: string | null
  kind: EvidenceSourceSnapshot['kind']
  identity: 'resolved' | 'unresolved'
  documentTitle: string
  /** null = absent or excluded by options (renderer distinguishes via the flag). */
  documentSha256: string | null
  mimeType: string | null
  pageNumber: number | null
  sectionLabel: string | null
  /** null = none persisted or excluded by options. */
  snippet: string | null
  availabilityAtCreation: 'available' | 'missing' | null
  /**
   * P4: the source's freshness state AT EXPORT (spec §16.1.7 "availability at export
   * time"), carried from the INJECTED freshness verdict — null when the model was built
   * without one (the pack then renders creation-time facts + the not-re-verified note,
   * the P3 behavior). Never derived inside this module: freshness facts always arrive as
   * input so the model stays pure and deterministic.
   */
  currentState: EvidenceSourceFreshnessState | null
  /** Deduped reviewer-assigned relations pointing at this source, in fixed order (§16.1.5
   *  "Reviewer relation where assigned"). */
  relations: PackRelation[]
}

/** Coverage-and-limitations facts (§16.1.6) — creation-time record; the P4 `freshness`
 *  block below carries the at-export re-check when one was performed. */
export interface EvidencePackHonesty {
  paneMode: EvidencePaneMode
  /** The raw recorded coverage mode literal (or null) — technical detail, not the claim. */
  answerModeRaw: string | null
  chunksCovered: number | null
  chunksTotal: number | null
  /** True only when truncation was honestly RECORDED; null = no record (never "false"). */
  answerTruncated: boolean | null
  unresolvedSources: number
  missingSources: number
}

/**
 * P4 (spec §28.6/§21.3): the freshness verdict the export pipeline computed at generation,
 * normalized for rendering. `null` on the model = no verdict was injected — the renderer
 * then keeps the P3 "not re-verified for this export" note. Counts are drift-oriented:
 * `sourcesMissingNow` counts NEWLY-missing sources only (present at creation, gone now) —
 * creation-time missing sources already carry their own §16.1.5 warning.
 */
export interface EvidencePackFreshness {
  outdated: boolean
  answerChanged: boolean
  coverageChanged: boolean
  sourcesChanged: number
  sourcesMissingNow: number
  /** The user's explicit acknowledge of the CURRENT drift (spec §28.6); null = none. */
  acknowledgedAt: string | null
}

/** The normalized pack (all nine §16.1 sections' data). */
export interface EvidencePackModel {
  packId: string
  schemaVersion: number
  /** The artifact's format (P6): drives the cover/integrity "Format" line so a PDF never
   *  self-describes as HTML. Injected by the pipeline (the effective, extension-decided
   *  format) — one template renders both; only this one line branches. */
  format: EvidenceExportFormat
  language: EvidencePackLanguage
  /** Pack generation timestamp (ISO) — the §16.1.1 export date and §16.1.8 export stamp. */
  generatedAt: string
  options: EvidencePackOptions
  // §16.1.1 Cover
  title: string
  status: EvidenceReviewStatus
  outdated: boolean
  // §16.1.2 Question and answer (frozen snapshots; markers localized at render)
  question: string | null
  answer: string
  // §16.1.3 Review summary
  summary: {
    reviewerLabel: string | null
    createdAt: string
    updatedAt: string
    completedAt: string | null
    /** Newest PRIOR export stamp (display-only, plan §8.4); null = first export. */
    lastExportedAt: string | null
    generalNote: string | null
    decisionCounts: Array<{ decision: ReviewDecision; count: number }>
    followUps: number
    gate: EvidenceReadyGate
  }
  // §16.1.4 Item-by-item review
  items: EvidencePackItem[]
  /** Items hidden by `includeUnreviewedItems: false` — counted honestly, never silent. */
  excludedItemCount: number
  // §16.1.5 + §16.1.7 Evidence/source registers
  evidence: EvidencePackSource[]
  // §16.1.6 Coverage and limitations
  honesty: EvidencePackHonesty
  /** P4: the at-export freshness verdict (spec §28.6); null = none injected (P3 shape). */
  freshness: EvidencePackFreshness | null
  /** Raw stored coverage (for the technical subsection only). */
  coverage: CoverageInfo | null
  // §16.1.8 Generation details (absent fields render "Unavailable")
  generation: EvidenceGenerationSnapshot | null
}

/** Trim a string-or-null to null when effectively empty (never renders an empty block). */
function textOrNull(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

/**
 * Build the normalized pack model from one stored review read-model (plan §8.1). Pure:
 * `packId` and `generatedAt` are INJECTED by the pipeline so tests stay deterministic —
 * and so is `freshness` (P4, spec §20.1/§28.6): the pipeline computes the verdict from
 * stored facts and passes it IN; this module never reads ambient state, so the same
 * (detail, options, meta, freshness) inputs always produce the same model. Omitted/null
 * freshness = the P3 shape (creation-time facts + the not-re-verified note).
 */
export function buildEvidencePackModel(
  detail: EvidenceReviewDetail,
  options: EvidencePackOptions,
  meta: { packId: string; generatedAt: string; format: EvidenceExportFormat },
  freshness?: EvidenceReviewFreshness | null
): EvidencePackModel {
  const stateByKey = new Map<string, EvidenceSourceFreshnessState>(
    (freshness?.sources ?? []).map((s) => [s.key, s.state])
  )
  // Evidence register first — items reference entries by index.
  const indexByKey = new Map<string, number>()
  const evidence: EvidencePackSource[] = detail.sources.map((s, i) => {
    const index = i + 1
    if (!indexByKey.has(s.key)) indexByKey.set(s.key, index)
    return {
      index,
      key: s.key,
      machineLabel: textOrNull(s.machineLabel ?? null),
      kind: s.kind,
      identity: s.identity,
      documentTitle: s.documentTitle,
      documentSha256: options.includeDocumentHashes ? textOrNull(s.documentSha256 ?? null) : null,
      mimeType: textOrNull(s.mimeType ?? null),
      pageNumber: typeof s.pageNumber === 'number' ? s.pageNumber : null,
      sectionLabel: textOrNull(s.sectionLabel ?? null),
      snippet: options.includeSourceExcerpts ? textOrNull(s.snippet ?? null) : null,
      availabilityAtCreation: s.availabilityAtCreation ?? null,
      currentState: freshness ? (stateByKey.get(s.key) ?? 'unverifiable') : null,
      relations: []
    }
  })

  // Items in stored order (the detail read is ORDER BY ordinal already); collect reviewer
  // relations into the register while walking the links.
  const visibleItems = options.includeUnreviewedItems
    ? detail.items
    : detail.items.filter((item) => item.decision !== 'not_reviewed')
  const items: EvidencePackItem[] = visibleItems.map((item) => ({
    ordinal: item.ordinal,
    kind: item.kind,
    heading: item.blockKind === 'heading',
    text: item.textSnapshot,
    decision: item.decision,
    note: options.includeReviewerNotes ? textOrNull(item.reviewerNote ?? null) : null,
    links: item.links.map((link): EvidencePackLink => {
      const sourceIndex = indexByKey.get(link.evidenceKey) ?? null
      const source = sourceIndex != null ? evidence[sourceIndex - 1]! : null
      const relation =
        link.relation != null && (RELATION_ORDER as readonly string[]).includes(link.relation)
          ? (link.relation as PackRelation)
          : null
      if (source && relation && !source.relations.includes(relation)) {
        source.relations.push(relation)
      }
      return {
        sourceIndex,
        label: source?.documentTitle ?? link.evidenceKey,
        machineLabel: source?.kind === 'direct_excerpt' ? source.machineLabel : null,
        origin: link.origin,
        relation
      }
    })
  }))
  // Relations from EVERY link (including links on items hidden by the unreviewed filter):
  // walk the full item set so the register's relation facts never depend on a display flag.
  if (!options.includeUnreviewedItems) {
    for (const item of detail.items) {
      if (item.decision !== 'not_reviewed') continue
      for (const link of item.links) {
        const idx = indexByKey.get(link.evidenceKey)
        const source = idx != null ? evidence[idx - 1] : null
        const relation =
          link.relation != null && (RELATION_ORDER as readonly string[]).includes(link.relation)
            ? (link.relation as PackRelation)
            : null
        if (source && relation && !source.relations.includes(relation)) {
          source.relations.push(relation)
        }
      }
    }
  }
  // Fixed relation ordering for determinism regardless of link creation order.
  for (const s of evidence) {
    s.relations.sort((a, b) => RELATION_ORDER.indexOf(a) - RELATION_ORDER.indexOf(b))
  }

  const decisionCounts = PACK_DECISION_ORDER.map((decision) => ({
    decision,
    count: detail.items.filter((i) => i.decision === decision).length
  }))

  const gen = detail.generationSnapshot
  const honesty: EvidencePackHonesty = {
    paneMode: evidencePaneMode(detail.coverageSnapshot),
    answerModeRaw: textOrNull(detail.coverageSnapshot?.mode ?? null),
    chunksCovered:
      typeof detail.coverageSnapshot?.chunksCovered === 'number'
        ? detail.coverageSnapshot.chunksCovered
        : null,
    chunksTotal:
      typeof detail.coverageSnapshot?.chunksTotal === 'number'
        ? detail.coverageSnapshot.chunksTotal
        : null,
    // Positive record only (the P1 generation-snapshot rule): true when honestly recorded
    // as cut off, null otherwise — absence of a record is never rendered as "complete".
    answerTruncated: gen?.answerTruncated === true ? true : null,
    unresolvedSources: detail.sources.filter((s) => s.identity === 'unresolved').length,
    missingSources: detail.sources.filter((s) => s.availabilityAtCreation === 'missing').length
  }

  // P4: normalize the injected verdict. `sourcesMissingNow` counts NEW deletions only —
  // a source already missing at creation keeps its own §16.1.5 warning and is not drift.
  const missingAtCreation = new Set(
    detail.sources.filter((s) => s.availabilityAtCreation === 'missing').map((s) => s.key)
  )
  const packFreshness: EvidencePackFreshness | null = freshness
    ? {
        outdated: freshness.outdated,
        answerChanged: freshness.answerState === 'changed',
        coverageChanged: freshness.coverageState === 'changed',
        sourcesChanged: (freshness.sources ?? []).filter((s) => s.state === 'changed').length,
        sourcesMissingNow: (freshness.sources ?? []).filter(
          (s) => s.state === 'missing' && !missingAtCreation.has(s.key)
        ).length,
        acknowledgedAt: freshness.acknowledgedAt ?? null
      }
    : null

  return {
    packId: meta.packId,
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    format: meta.format,
    language: options.language,
    generatedAt: meta.generatedAt,
    options,
    title: detail.title,
    status: detail.status,
    // The overlay travels with the verdict when one was computed for this export; the
    // detail's own flag (constant-false on service reads) is the fallback.
    outdated: freshness ? freshness.outdated : detail.outdated,
    question: textOrNull(detail.questionSnapshot),
    answer: detail.answerSnapshot,
    summary: {
      reviewerLabel: textOrNull(detail.reviewerLabel ?? null),
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      completedAt: detail.completedAt ?? null,
      lastExportedAt: detail.exports[0]?.createdAt ?? null,
      generalNote: options.includeReviewerNotes ? textOrNull(detail.generalNote ?? null) : null,
      decisionCounts,
      followUps: detail.items.filter((i) => i.decision === 'follow_up').length,
      gate: detail.gate
    },
    items,
    excludedItemCount: detail.items.length - visibleItems.length,
    evidence,
    honesty,
    freshness: packFreshness,
    coverage: detail.coverageSnapshot,
    generation: gen
  }
}
