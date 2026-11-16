import { vi, type Mock } from 'vitest'
import type {
  EvidencePackOptions,
  EvidenceReview,
  EvidenceReviewBulkAction,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceReviewSummary,
  EvidenceSourceSnapshot
} from '../../src/shared/types'
import type { PreloadApi } from '../../src/preload'
import { EVIDENCE_PACK_OPTION_DEFAULTS } from '../../src/shared/evidence-review'
import { deriveReadyGate } from '../../src/main/services/evidence-reviews'
import { stubApi } from './renderer'

// Shared renderer-test fixtures for the EP-1 review workspace (plan §7): one detail shaped
// exactly like the Phase-1 `getEvidenceReview` read-model. Tests override per case.
// The fixture gate comes from MAIN's `deriveReadyGate` — the authority a real detail would
// carry — NOT from the renderer's `computeReadyGate` mirror, so footer/gating tests never
// validate the mirror against itself (review FIX-4; the mirror's equivalence is pinned
// separately in tests/unit/evidence-review-gate.test.ts).
//
// P4: every successful session open now fires `refreshEvidenceReviewState` (plan §9.1 "on
// review open"), so review test files stub it structurally via `stubReviewApi` below —
// the plain `stubApi` plus the freshness auto-stub (override per test for outdated cases).

export function makeItem(over: Partial<EvidenceReviewItem> & { id: string }): EvidenceReviewItem {
  return {
    reviewId: 'r1',
    ordinal: 0,
    kind: 'block',
    blockKey: 'b0-paragraph-abc',
    blockKind: 'paragraph',
    startOffset: null,
    endOffset: null,
    textSnapshot: 'Alpha [S1]',
    decision: 'not_reviewed',
    reviewerNote: null,
    links: [],
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    ...over
  }
}

/** A fresh (not outdated) freshness verdict matching `makeDetail`'s single source. */
export function makeFreshness(over: Partial<EvidenceReviewFreshness> = {}): EvidenceReviewFreshness {
  return {
    reviewId: 'r1',
    outdated: false,
    answerState: 'unchanged',
    coverageState: 'unchanged',
    sources: [{ key: 's1', state: 'unchanged' }],
    acknowledgedAt: null,
    ...over
  }
}

/**
 * `stubApi` + the P4 freshness stub the open-session flow always calls. Overrides win —
 * pass your own `refreshEvidenceReviewState` (or freshness via `fresh`) for outdated
 * cases. Returns the installed refresh spy for call assertions.
 */
export function stubReviewApi(
  overrides: Parameters<typeof stubApi>[0] = {},
  fresh?: EvidenceReviewFreshness
): { refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(
    async (reviewId: string): Promise<EvidenceReviewFreshness | null> =>
      fresh ?? makeFreshness({ reviewId })
  )
  stubApi({ refreshEvidenceReviewState: refresh, ...overrides })
  return { refresh }
}

export function makeDetail(over: Partial<EvidenceReviewDetail> = {}): EvidenceReviewDetail {
  const items = over.items ?? [
    makeItem({ id: 'i1', ordinal: 0 }),
    makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta' })
  ]
  return {
    id: 'r1',
    conversationId: 'c1',
    messageId: 'm1',
    questionMessageId: 'q1',
    title: 'Evidence review',
    status: 'draft',
    outdated: false,
    reviewerLabel: null,
    generalNote: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    completedAt: null,
    answerSnapshot: 'Alpha [S1]\n\nBeta',
    questionSnapshot: 'What does the contract say?',
    sources: [
      {
        key: 's1',
        machineLabel: 'S1',
        kind: 'direct_excerpt',
        identity: 'resolved',
        documentId: 'd1',
        documentTitle: 'contract.pdf',
        documentSha256: 'ab'.repeat(32),
        mimeType: 'application/pdf',
        pageNumber: 12,
        sectionLabel: null,
        snippet: 'Either party may terminate…',
        sourceChunkId: null,
        availabilityAtCreation: 'available'
      }
    ],
    coverageSnapshot: { mode: 'relevance', chunksCovered: 2, chunksTotal: 10 },
    generationSnapshot: {
      generatedAt: '2026-07-18T09:00:00.000Z',
      modelId: 'model-1',
      modelDisplayName: 'Local Model',
      skillId: null,
      skillDisplayName: null,
      appVersion: '0.1.52',
      answerTruncated: false,
      answerMode: 'relevance'
    },
    exports: [],
    gate: deriveReadyGate(items),
    ...over,
    items
  }
}

// ---- Review + export test campaign (commit H): the factories the review suites copied locally ----

/**
 * The `EvidenceReview` head a write path returns (`markEvidenceReviewReady`'s `review`, `reopenEvidenceReview`): the
 * head fields of `makeDetail()`, `over` last. Replaces the hand-typed 12-field literals at 27bd0b0d:
 * ReviewScreen.test.tsx:58, :134, :315, :550 and reviewSession.test.ts:227.
 */
export function makeReviewHead(over: Partial<EvidenceReview> = {}): EvidenceReview {
  const d = makeDetail()
  return {
    id: d.id,
    conversationId: d.conversationId,
    messageId: d.messageId,
    questionMessageId: d.questionMessageId,
    title: d.title,
    status: d.status,
    outdated: d.outdated,
    reviewerLabel: d.reviewerLabel,
    generalNote: d.generalNote,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    completedAt: d.completedAt,
    ...over
  }
}

/**
 * `n` document sources cloned from `makeDetail()`'s one: key `s<i+1>`, label `S<i+1>`, title `doc-<i+1>.pdf`, snippet
 * `Snippet number <i+1>`; `over(i)` spreads last per source. Replaces `makeSources` at 27bd0b0d:
 * ReviewEvidencePane.test.tsx:30 and its verbatim copy at ReviewGateA11y.test.tsx:150.
 */
export function makeSourceSnapshots(
  n: number,
  over?: (i: number) => Partial<EvidenceSourceSnapshot>
): EvidenceSourceSnapshot[] {
  const base = makeDetail().sources[0]!
  return Array.from({ length: n }, (_, i) => ({
    ...base,
    key: `s${i + 1}`,
    machineLabel: `S${i + 1}`,
    documentTitle: `doc-${i + 1}.pdf`,
    snippet: `Snippet number ${i + 1}`,
    ...over?.(i)
  }))
}

/**
 * One frozen ARCHIVE (knowledge-pack) source as the snapshot builder writes it: `sourceKind: 'archive'`, identity
 * 'unresolved', null document id / hash / mime / page / chunk / `availabilityAtCreation`, the locator set (`packId` +
 * `articlePath`) and `archiveTitle`, under `makeDetail()`'s key 's1'. A row that reads a title, locator or snippet
 * passes it. Replaces the literals at 27bd0b0d: ReviewScreen.test.tsx:913 (`archiveDetail`),
 * ReviewEvidencePane.test.tsx:226 and :291 (`archiveSnapshot`), unit/evidence-pack-html.test.ts:304 (`archiveDetail`)
 * and unit/evidence-pack-model.test.ts:211 and :245.
 */
export function archiveSource(over: Partial<EvidenceSourceSnapshot> = {}): EvidenceSourceSnapshot {
  return {
    key: 's1',
    machineLabel: 'S1',
    kind: 'direct_excerpt',
    identity: 'unresolved',
    documentId: null,
    documentTitle: 'Treibhausgas',
    documentSha256: null,
    mimeType: null,
    pageNumber: null,
    sectionLabel: 'Landwirtschaft',
    snippet: 'Methan entsteht in der Landwirtschaft.',
    sourceChunkId: null,
    availabilityAtCreation: null,
    sourceKind: 'archive',
    archiveTitle: 'Wikipedia (DE)',
    packId: 'pack-uuid-1',
    articlePath: 'A/Treibhausgas',
    ...over
  }
}

/**
 * The chip-state read-model (one `getEvidenceReviewSummariesForConversation` element) for `makeDetail()`'s review:
 * draft, not outdated, gate 0 of 2. Replaces `summary()` at 27bd0b0d: ReviewEntryPoints.test.tsx:35 (whose defaults
 * these are) and ChatReviewChipBatch.test.tsx:45 (which derived `id` from the message id: pass `id` and `messageId`).
 */
export function makeSummary(over: Partial<EvidenceReviewSummary> = {}): EvidenceReviewSummary {
  return {
    id: 'r1',
    conversationId: 'c1',
    messageId: 'm1',
    title: 'Evidence review',
    status: 'draft',
    outdated: false,
    gate: { eligible: false, requiredTotal: 2, decidedTotal: 0 },
    updatedAt: '2026-07-18T10:00:00.000Z',
    ...over
  }
}

/** One item after `action`, by MAIN's predicates (evidence-reviews.ts `bulkUpdateStatement`). */
function bulkSwept(item: EvidenceReviewItem, action: EvidenceReviewBulkAction): EvidenceReviewItem {
  switch (action) {
    case 'headings_not_applicable':
      // `kind <> 'selection'` (an unknown kind reads as a block) AND `block_kind = 'heading'`.
      return item.kind !== 'selection' && item.blockKind === 'heading' && item.decision !== 'not_applicable'
        ? { ...item, decision: 'not_applicable' }
        : item
    case 'clear_decisions':
      return item.decision !== 'not_reviewed' ? { ...item, decision: 'not_reviewed' } : item
    case 'undecided_follow_up':
      // Undecided = 'not_reviewed' (every other literal is a decision).
      return item.decision === 'not_reviewed' ? { ...item, decision: 'follow_up' } : item
    default: {
      const unknown: never = action
      throw new Error(`bulkBackend: unknown bulk action ${String(unknown)}`)
    }
  }
}

/**
 * The AUD-13 main-side stand-in for `applyEvidenceReviewBulkAction`: `spy` applies the named sweep to its OWN copy of
 * `items` in ONE step and resolves the whole refreshed set (copies), so the store is tested against a batch that lands
 * whole, never a per-item drip. The predicates are main's: headings = `kind <> 'selection'` AND blockKind 'heading';
 * undecided = 'not_reviewed'. `current()` reads the copy after the last sweep. Replaces at 27bd0b0d:
 * reviewSession.test.ts:305 (`bulkBackend`, which keyed headings on `kind === 'block'`) and the inline stand-in at
 * ReviewScreen.test.tsx:466 (which ignored `kind`).
 */
export function bulkBackend(items: readonly EvidenceReviewItem[]): {
  spy: Mock<PreloadApi['applyEvidenceReviewBulkAction']>
  current(): EvidenceReviewItem[]
} {
  let rows = items.map((i) => ({ ...i }))
  const spy = vi.fn<PreloadApi['applyEvidenceReviewBulkAction']>(async (_reviewId, action) => {
    rows = rows.map((i) => bulkSwept(i, action))
    return rows.map((i) => ({ ...i }))
  })
  return { spy, current: () => rows }
}

/**
 * The pack metadata the pure pack-model / HTML-renderer rows build with (a fixed UUID-shaped pack id, a fixed
 * generation time, format 'html'). Replaces `META` at 27bd0b0d: unit/evidence-pack-html.test.ts:23 (these values) and
 * unit/evidence-pack-model.test.ts:25 (`packId: 'pack-1'`, `12:00`; a row that reads them passes its own).
 */
export const PACK_META = {
  packId: '00000000-0000-4000-8000-000000000001',
  generatedAt: '2026-07-18T12:34:00.000Z',
  format: 'html'
} as const

/**
 * Resolved pack options: English, the shared §16.2 defaults, `over` last. Replaces `opts()` at 27bd0b0d:
 * unit/evidence-pack-html.test.ts:29 and unit/evidence-pack-model.test.ts:27.
 */
export function packOptions(over: Partial<EvidencePackOptions> = {}): EvidencePackOptions {
  return { language: 'en', ...EVIDENCE_PACK_OPTION_DEFAULTS, ...over }
}
