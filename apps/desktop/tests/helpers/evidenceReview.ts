import { vi, type Mock } from 'vitest'
import type {
  EvidenceExportRecord,
  EvidenceLinkInput,
  EvidencePackOptions,
  EvidenceReview,
  EvidenceReviewBulkAction,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceReviewItemPatch,
  EvidenceReviewPatch,
  EvidenceReviewSummary,
  EvidenceSourceSnapshot
} from '../../src/shared/types'
import type { PreloadApi } from '../../src/preload'
import { EVIDENCE_PACK_OPTION_DEFAULTS, deriveReadyGate } from '../../src/shared/evidence-review'
import { stubApi } from './renderer'

// Shared renderer-test fixtures for the EP-1 review workspace (plan §7): one detail shaped
// exactly like the Phase-1 `getEvidenceReview` read-model. Tests override per case.
// The fixture gate comes from `deriveReadyGate` (`shared/evidence-review.ts`), the one D-7 gate
// main and the renderer both run (#839); its matrix is tests/unit/evidence-review-gate.test.ts.
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
        // Production always sends one (#839); undefined only reads as 'document' by tolerance.
        sourceKind: 'document',
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

/** The review calls `reviewMain` answers, by the name its arrival log uses. */
export type ReviewMainCall = 'item' | 'head' | 'link' | 'unlink' | 'delete' | 'markReady' | 'export' | 'reopen' | 'get'

/** One answer `reviewMain` owes: decided at arrival, delivered once it is not held. */
interface ReviewMainAnswer {
  kind: ReviewMainCall
  held: boolean
  deliver(): void
}

/**
 * A main-side stand-in for one open review that PERSISTS every write the store sends (#889, #901): item decisions and
 * notes, the head (title / reviewer label / general note), links, selection deletes, ready / draft, and what each
 * Mark ready / Export / Reopen found saved. Each handler decides at ARRIVAL, by main's rules
 * (`services/evidence-reviews.ts`): an item write, a link or a delete on a READY review is refused (null / false), an
 * unknown id answers null / false, a key outside the snapshot answers null, an empty title is ignored, Mark ready marks
 * only when `deriveReadyGate` over the saved rows is eligible, and an export reads the saved review before its dialog
 * opens (`exportEvidencePackToFile`).
 *
 * Answers: `holdNext(kind)` holds the next call of that kind (decided already, answered on `release()`; with `'fail'`
 * it persists nothing and rejects when released); `failNext(kind)` makes it persist nothing and reject at once
 * ("disk I/O error"). Every review handler but the export is synchronous in main, so their answers come back in
 * ARRIVAL order: a held answer holds every later one behind it. The export (dialog, PDF print) is asynchronous and is
 * held on its own. `onArrival` runs inside each handler, at the moment main sees the call.
 */
export function reviewMain(detail: EvidenceReviewDetail): {
  api: Partial<PreloadApi>
  /** Arrival order: `item:<id>`, `head`, `link:<id>`, `unlink:<id>`, `delete:<id>`, `markReady`, `export`, `reopen`, `get`. */
  order: string[]
  /** The review as saved now (what `getEvidenceReview` reads). */
  db(): EvidenceReviewDetail
  /** The saved review as each Mark ready / Export / Reopen found it on arrival, in arrival order. */
  atCall: Array<{ call: 'markReady' | 'export' | 'reopen'; saved: EvidenceReviewDetail }>
  holdNext(kind: ReviewMainCall, then?: 'answer' | 'fail'): { release(): void }
  failNext(kind: ReviewMainCall): void
  cancelPlans(): void
  /** The answers still held, oldest first. */
  held(): Array<{ kind: ReviewMainCall; release(): void }>
  /** Rejections delivered to the store so far (of one kind of call, when given). */
  failuresDelivered(kind?: ReviewMainCall): number
  onArrival: ((kind: ReviewMainCall) => void) | null
} {
  type Plan = { kind: ReviewMainCall; hold: boolean; fail: boolean; answer?: ReviewMainAnswer }
  let head = { title: detail.title, reviewerLabel: detail.reviewerLabel, generalNote: detail.generalNote }
  let ready = detail.status === 'ready'
  const copy = (i: EvidenceReviewItem): EvidenceReviewItem => ({ ...i, links: i.links.map((l) => ({ ...l })) })
  let rows = detail.items.map(copy)
  const keys = new Set(detail.sources.map((s) => s.key))
  const order: string[] = []
  const atCall: Array<{ call: 'markReady' | 'export' | 'reopen'; saved: EvidenceReviewDetail }> = []
  const plans: Plan[] = []
  const inOrder: ReviewMainAnswer[] = [] // the synchronous handlers' answers, delivered strictly in arrival order
  const own: ReviewMainAnswer[] = [] // held export answers
  const failures = new Map<ReviewMainCall, number>()
  const db = (): EvidenceReviewDetail => {
    const items = rows.map(copy)
    return { ...detail, ...head, status: ready ? 'ready' : 'draft', items, gate: deriveReadyGate(items) }
  }
  const reviewHead = (): EvidenceReview => ({
    ...makeReviewHead({ id: detail.id }),
    ...head,
    status: ready ? 'ready' : 'draft'
  })
  const live = (id: string): EvidenceReviewItem | undefined => rows.find((r) => r.id === id)
  const pump = (): void => {
    while (inOrder[0] && !inOrder[0].held) inOrder.shift()!.deliver()
  }
  const release = (answer: ReviewMainAnswer): void => {
    if (!answer.held) return
    answer.held = false
    const at = own.indexOf(answer)
    if (at >= 0) {
      own.splice(at, 1)
      answer.deliver()
    } else pump()
  }
  function call<T>(kind: ReviewMainCall, label: string, decide: () => T): Promise<T> {
    order.push(label)
    main.onArrival?.(kind)
    const at = plans.findIndex((p) => p.kind === kind)
    const plan: Plan = at >= 0 ? plans.splice(at, 1)[0]! : { kind, hold: false, fail: false }
    const value = plan.fail ? undefined : decide() // a failed call persists nothing
    return new Promise<T>((resolve, reject) => {
      const answer: ReviewMainAnswer = {
        kind,
        held: plan.hold,
        deliver(): void {
          if (!plan.fail) return resolve(value as T)
          failures.set(kind, (failures.get(kind) ?? 0) + 1)
          reject(new Error('disk I/O error'))
        }
      }
      plan.answer = answer
      if (kind === 'export') {
        if (answer.held) own.push(answer)
        else answer.deliver()
      } else {
        inOrder.push(answer)
        pump()
      }
    })
  }
  const api: Partial<PreloadApi> = {
    getEvidenceReview: vi.fn((id: string) => call('get', 'get', () => (id === detail.id ? db() : null))),
    updateEvidenceReviewItem: vi.fn((id: string, patch: EvidenceReviewItemPatch) =>
      call('item', `item:${id}`, () => {
        const row = live(id)
        if (!row || ready) return null
        if (patch.decision !== undefined) row.decision = patch.decision
        if (patch.reviewerNote !== undefined) row.reviewerNote = patch.reviewerNote
        return copy(row)
      })
    ),
    updateEvidenceReview: vi.fn((_id: string, patch: EvidenceReviewPatch) =>
      call('head', 'head', () => {
        head = {
          title: patch.title !== undefined && patch.title.trim().length > 0 ? patch.title.trim() : head.title,
          reviewerLabel: patch.reviewerLabel !== undefined ? patch.reviewerLabel : head.reviewerLabel,
          generalNote: patch.generalNote !== undefined ? patch.generalNote : head.generalNote
        }
        return reviewHead()
      })
    ),
    setEvidenceLink: vi.fn((itemId: string, key: string, input: EvidenceLinkInput) =>
      call('link', `link:${itemId}`, () => {
        const row = live(itemId)
        if (!row || ready || !keys.has(key)) return null
        row.links = [
          ...row.links.filter((l) => l.evidenceKey !== key),
          { evidenceKey: key, origin: 'reviewer' as const, relation: input.relation ?? null }
        ]
        return copy(row)
      })
    ),
    removeEvidenceLink: vi.fn((itemId: string, key: string) =>
      call('unlink', `unlink:${itemId}`, () => {
        const row = live(itemId)
        if (!row || ready || !row.links.some((l) => l.evidenceKey === key)) return false
        row.links = row.links.filter((l) => l.evidenceKey !== key)
        return true
      })
    ),
    deleteEvidenceSelection: vi.fn((id: string) =>
      call('delete', `delete:${id}`, () => {
        const row = live(id)
        if (!row || row.kind !== 'selection' || ready) return false
        rows = rows.filter((r) => r.id !== id)
        return true
      })
    ),
    markEvidenceReviewReady: vi.fn(() =>
      call('markReady', 'markReady', () => {
        atCall.push({ call: 'markReady', saved: db() })
        const gate = deriveReadyGate(rows)
        if (gate.eligible) ready = true
        return { review: reviewHead(), gate }
      })
    ),
    reopenEvidenceReview: vi.fn(() =>
      call('reopen', 'reopen', () => {
        atCall.push({ call: 'reopen', saved: db() })
        ready = false
        return reviewHead()
      })
    ),
    exportEvidencePack: vi.fn(() =>
      call('export', 'export', (): EvidenceExportRecord => {
        atCall.push({ call: 'export', saved: db() })
        return {
          id: `x${atCall.length}`,
          reviewId: detail.id,
          format: 'html',
          schemaVersion: 1,
          fileName: 'pack.html',
          fileSha256: 'aa'.repeat(32),
          options: null,
          createdAt: '2026-07-18T12:00:00.000Z'
        }
      })
    )
  }
  const main = {
    api,
    order,
    db,
    atCall,
    holdNext(kind: ReviewMainCall, then: 'answer' | 'fail' = 'answer'): { release(): void } {
      const plan: Plan = { kind, hold: true, fail: then === 'fail' }
      plans.push(plan)
      return {
        release(): void {
          if (!plan.answer) throw new Error(`reviewMain: the held ${kind} call has not arrived`)
          release(plan.answer)
        }
      }
    },
    failNext(kind: ReviewMainCall): void {
      plans.push({ kind, hold: false, fail: true })
    },
    /** Drop every `holdNext` / `failNext` no call has met yet. */
    cancelPlans(): void {
      plans.length = 0
    },
    held(): Array<{ kind: ReviewMainCall; release(): void }> {
      return [...inOrder, ...own].filter((a) => a.held).map((a) => ({ kind: a.kind, release: () => release(a) }))
    },
    failuresDelivered: (kind?: ReviewMainCall): number =>
      kind ? (failures.get(kind) ?? 0) : [...failures.values()].reduce((a, b) => a + b, 0),
    onArrival: null as ((kind: ReviewMainCall) => void) | null
  }
  return main
}

/**
 * Where the screen disagrees with the saved review (#889, #901): which items exist, each item's decision, note and
 * (unless `links: false`) links, the progress gate, and the head's title, reviewer label, general note and status.
 * Empty = the screen tells the truth. `links: false` is for a moment when a link's answer may still be on its way.
 */
export function reviewDiff(
  shown: EvidenceReviewDetail | null,
  saved: EvidenceReviewDetail,
  opts: { links?: boolean } = {}
): string[] {
  if (!shown) return ['no review on screen']
  const out: string[] = []
  const say = (what: string, a: unknown, b: unknown): void => {
    if (a !== b) out.push(`${what}: shown ${JSON.stringify(a)}, saved ${JSON.stringify(b)}`)
  }
  for (const field of ['title', 'reviewerLabel', 'generalNote', 'status'] as const) say(field, shown[field], saved[field])
  const ids = (d: EvidenceReviewDetail): string => d.items.map((i) => i.id).sort().join(',')
  say('items', ids(shown), ids(saved))
  const links = (i: EvidenceReviewItem): string =>
    i.links.map((l) => `${l.evidenceKey}/${l.origin}/${l.relation ?? null}`).sort().join(',')
  for (const s of shown.items) {
    const d = saved.items.find((i) => i.id === s.id)
    if (!d) continue
    say(`${s.id}.decision`, s.decision, d.decision)
    say(`${s.id}.reviewerNote`, s.reviewerNote, d.reviewerNote)
    if (opts.links !== false) say(`${s.id}.links`, links(s), links(d))
  }
  say('gate', JSON.stringify(shown.gate), JSON.stringify(deriveReadyGate(saved.items)))
  return out
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
