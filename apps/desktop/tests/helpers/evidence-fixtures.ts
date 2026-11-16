// Main-side evidence-review fixtures (review + export test campaign, commit H): the document/chunk/answer seeds, the two
// review seeds, the no-model IPC context with its runtime tripwire, the offline-guard hook and the export deps the
// evidence suites each built for themselves. Replaces the local copies cited per function (file:line at 27bd0b0d).
//
// Rules:
//  - No `electron`, no renderer module, no registrar (`registerEvidenceReviewsIpc` imports electron): safe beside each
//    suite's own hoisted `vi.mock('electron', …)` and in suites that mock nothing. The renderer-side review fixtures
//    live in ./evidenceReview.ts (it imports `stubApi`).
//  - Defaults are NOT a contract. A row that reads a seeded value (a conversation title, a model id, a question, a
//    hash) passes it explicitly. Golden packs must stay byte-identical without UPDATE_EVIDENCE_PACK_GOLDENS.
//  - Two review seeds, never one: `seedReviewChain` writes through the storage CRUD (no builder), `seedEvidenceReview`
//    runs the real snapshot builder. Do not use `seedEvidenceReview` in evidence-snapshot.test.ts, where the builder
//    call is the act under test.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, expect } from 'vitest'
import { createAuditRecorder, type AuditRecorder } from '../../src/main/services/audit'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import type { AppContext } from '../../src/main/services/context'
import type { Db } from '../../src/main/services/db'
import type { Embedder } from '../../src/main/services/embeddings'
import type { EvidencePackExportDeps } from '../../src/main/services/evidence-pack/export'
import {
  createEvidenceReviewFromMessage,
  type EvidenceSnapshotDeps
} from '../../src/main/services/evidence-pack/snapshot'
import {
  createEvidenceReview,
  createEvidenceReviewItems,
  recordEvidenceExport,
  setEvidenceLink,
  updateEvidenceReviewItem
} from '../../src/main/services/evidence-reviews'
import { installOfflineNetworkGuard } from '../../src/main/services/offlineGuard'
import type {
  Citation,
  CoverageInfo,
  EndedEarly,
  EvidenceReviewDetail,
  EvidenceSourceSnapshot
} from '../../src/shared/types'
import { ANY_SENDER } from './ipc'

/**
 * One `documents` row ONLY (no stored file anywhere), status 'indexed'. `sha256: undefined` gets the default hash
 * (`'ab'.repeat(32)`); an explicit `null` STAYS null (the "hash unknown" rows depend on it, FR5), so the check is
 * `=== undefined`, never `??`. `id` pins the row id (async-fs's `'doc-async-fs'`); default a random UUID.
 * Replaces at 27bd0b0d: evidence-snapshot.test.ts:26, evidence-freshness.test.ts:99 (the nullable-hash variant),
 * evidence-reviews-ipc.test.ts:172, evidence-pack-export.test.ts:74, evidence-source-context-overlap.test.ts:34, and the
 * inline inserts at evidence-review-batch-ops.test.ts:130, evidence-pack-export-async-fs.test.ts:135 and
 * evidence-review-open-perf.test.ts:129.
 */
export function seedSourceDocument(
  db: Db,
  o: { title: string; sha256?: string | null; mime?: string; id?: string }
): string {
  const id = o.id ?? randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'indexed', ?, ?)`
  ).run(id, o.title, o.mime ?? 'application/pdf', o.sha256 === undefined ? 'ab'.repeat(32) : o.sha256, now, now)
  return id
}

/**
 * One `chunks` row of `documentId` (`source_label` `S<index + 1>`). Replaces the byte-identical `seedChunk` at
 * 27bd0b0d: evidence-freshness.test.ts:109 and evidence-source-context-overlap.test.ts:44.
 */
export function seedEvidenceChunk(
  db: Db,
  o: { documentId: string; index: number; text: string; page?: number | null; section?: string | null }
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    o.documentId,
    o.index,
    o.text,
    `S${o.index + 1}`,
    o.page ?? null,
    o.section ?? null,
    new Date().toISOString()
  )
  return id
}

export interface SeedAnswerOptions {
  content: string
  citations?: Citation[] | null
  coverage?: CoverageInfo | null
  /** The user turn before the answer; `null` = NO user turn at all. Default `'What about termination?'`. */
  question?: string | null
  /** Conversation title. Default `'Contract questions'`. */
  title?: string
  /** Conversation model id; `null` passes through as "no model recorded". Default `'test-model-q4'`. */
  modelId?: string | null
  truncated?: boolean
  endedEarly?: EndedEarly
  /** The skill install id the answer is stamped with (`messages.skill_id`). */
  skillId?: string
}

/**
 * One conversation + (unless `question: null`) its user turn + the assistant answer, through the REAL chat service.
 * `questionId` is the user turn's message id, null when none was written.
 * Replaces at 27bd0b0d: evidence-snapshot.test.ts:44 (the superset, whose defaults these are),
 * evidence-pack-export.test.ts:84, evidence-freshness.test.ts:130, evidence-reviews-ipc.test.ts:182,
 * evidence-reviews.test.ts:64, and the answer halves of evidence-source-context-overlap.test.ts:71,
 * evidence-pack-export-concurrent.test.ts:151 and evidence-pack-export-async-fs.test.ts:132.
 */
export function seedAssistantAnswer(
  db: Db,
  o: SeedAnswerOptions
): { conversationId: string; messageId: string; questionId: string | null } {
  const conv = createConversation(db, {
    title: o.title ?? 'Contract questions',
    // `null` must pass through as an explicit "no model recorded" (?? would swallow it).
    modelId: o.modelId !== undefined ? o.modelId : 'test-model-q4'
  })
  let questionId: string | null = null
  if (o.question !== null) {
    questionId = appendMessage(db, {
      conversationId: conv.id,
      role: 'user',
      content: o.question ?? 'What about termination?'
    }).id
  }
  const msg = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: o.content,
    citations: o.citations ?? null,
    coverage: o.coverage ?? null,
    truncated: o.truncated,
    endedEarly: o.endedEarly,
    skillId: o.skillId
  })
  return { conversationId: conv.id, messageId: msg.id, questionId }
}

/** The default source of `seedReviewChain`: one resolved direct excerpt under key 'S1'. */
const CHAIN_SOURCES: EvidenceSourceSnapshot[] = [
  {
    key: 'S1',
    machineLabel: 'S1',
    kind: 'direct_excerpt',
    identity: 'resolved',
    documentTitle: 'contract.pdf'
  }
]

/**
 * A REAL review chain on `messageId` through the storage CRUD (no snapshot builder): head (title
 * `'Payment terms review'`, reviewer label `'P. Reviewer'`) + one decided, annotated block item + one reviewer link
 * (`supports`) to the FIRST source + one recorded html export. Every table the message FK cascades into gets a row.
 * `sources` replaces the default single 'S1' source; the link goes to `sources[0].key`.
 * Replaces at 27bd0b0d: regenerate-evidence-review-guard.test.ts:144 (whose values these are) and
 * evidence-reviews.test.ts:548 (`seedFullReview`, which linked 'S1' with origin answer_marker).
 */
export function seedReviewChain(
  db: Db,
  messageId: string,
  o: { sources?: EvidenceSourceSnapshot[] } = {}
): { reviewId: string; itemId: string } {
  const sources = o.sources ?? CHAIN_SOURCES
  const linkKey = sources[0]?.key
  if (!linkKey) throw new Error('test setup: seedReviewChain needs at least one source to link')
  const answerSnapshot = 'The payment term is 30 days. [S1]'
  const review = createEvidenceReview(db, {
    messageId,
    title: 'Payment terms review',
    answerSnapshot,
    questionSnapshot: 'what are the payment terms',
    reviewerLabel: 'P. Reviewer',
    sources
  })
  const [item] = createEvidenceReviewItems(db, review.id, [
    { kind: 'block', blockKey: 'b0', blockKind: 'paragraph', textSnapshot: answerSnapshot }
  ])
  if (!item) throw new Error('test setup: review item was not created')
  updateEvidenceReviewItem(db, item.id, {
    decision: 'supported',
    reviewerNote: 'Checked against clause 5 of the contract.'
  })
  if (!setEvidenceLink(db, item.id, linkKey, { origin: 'reviewer', relation: 'supports' })) {
    throw new Error(`test setup: the link to source ${linkKey} was refused`)
  }
  recordEvidenceExport(db, {
    reviewId: review.id,
    format: 'html',
    schemaVersion: 1,
    fileName: 'payment-terms.html',
    fileSha256: 'ab'.repeat(32)
  })
  return { reviewId: review.id, itemId: item.id }
}

/**
 * The draft review the REAL snapshot builder makes for `answer.messageId`. `deps` defaults to `{}` (no app version,
 * no display name: the "Unavailable" generation cells); the goldens pass their own.
 * Replaces at 27bd0b0d: the `createEvidenceReviewFromMessage(db, id, {})` tails of evidence-freshness.test.ts:147,
 * evidence-source-context-overlap.test.ts:71, evidence-pack-export-concurrent.test.ts:151 and
 * evidence-pack-export-async-fs.test.ts:132, and the inline builder calls in evidence-pack-export.test.ts.
 */
export function seedEvidenceReview(
  db: Db,
  answer: { messageId: string },
  deps: EvidenceSnapshotDeps = {}
): EvidenceReviewDetail {
  return createEvidenceReviewFromMessage(db, answer.messageId, deps)
}

/** The members the evidence-surface tripwire covers (the copies' set). */
const RUNTIME_MEMBERS = ['active', 'activeModelId', 'start', 'stop', 'status'] as const

/**
 * A model-runtime TRIPWIRE: every touch of a member is recorded in `touched` AND throws, so a handler that reaches
 * for the runtime fails loudly even where it would swallow a null. Suites assert `touched` stays `[]`.
 * Replaces at 27bd0b0d: evidence-reviews-ipc.test.ts:114 and evidence-review-open-perf.test.ts:53 (recorded, returned
 * null) and the throwing runtime of evidence-freshness.test.ts:648 (`makeCtx`).
 */
export function tripwireRuntime(touched: string[]): AppContext['runtime'] {
  const runtime: Record<string, () => never> = {}
  for (const member of RUNTIME_MEMBERS) {
    runtime[member] = () => {
      touched.push(member)
      throw new Error(`model runtime must never be touched on the evidence surface (runtime.${member})`)
    }
  }
  return runtime as unknown as AppContext['runtime']
}

/** The embedder tripwire beside `tripwireRuntime`: `embed` records `'embed'` into the same list and throws. */
function tripwireEmbedder(touched: string[]): Embedder {
  return {
    id: 'tripwire-embedder',
    dimensions: 1,
    embed: async () => {
      touched.push('embed')
      throw new Error('the embedder must never be touched on the evidence surface')
    }
  }
}

/**
 * The AppContext the evidence IPC suites hand to `registerEvidenceReviewsIpc`: paths under `root`, `isUnlocked` from
 * `o.unlocked` (default always unlocked), `tripwireRuntime` + a tripwire embedder (both feed `runtimeTouched`),
 * `manifestsDir` (default null), `isDev: true`. `audit` records `{ type, meta }` into the returned list AND writes
 * through the real `createAuditRecorder`, so `listAuditEvents(db, …)` reads the same events.
 * Replaces at 27bd0b0d: evidence-reviews-ipc.test.ts:147 (`makeHarness`), evidence-review-open-perf.test.ts:77
 * (`makeHarness`), evidence-freshness.test.ts:648 (`makeCtx`) and evidence-review-batch-ops.test.ts:160 (`ctxFor`,
 * which had no runtime and no audit at all).
 */
export function evidenceIpcContext(
  db: Db,
  root: string,
  o: { unlocked?: () => boolean; manifestsDir?: string | null } = {}
): {
  ctx: AppContext
  runtimeTouched: string[]
  audit: Array<{ type: string; meta?: Record<string, unknown> }>
} {
  const runtimeTouched: string[] = []
  const audit: Array<{ type: string; meta?: Record<string, unknown> }> = []
  const persist = createAuditRecorder(() => db)
  const recorder: AuditRecorder = (type, message, meta) => {
    audit.push({ type, meta })
    persist(type, message, meta)
  }
  const ctx = {
    trustedSenders: ANY_SENDER,
    db,
    paths: { workspacePath: root, rootPath: root, configPath: join(root, 'config.json') },
    workspace: { isUnlocked: o.unlocked ?? (() => true) },
    runtime: tripwireRuntime(runtimeTouched),
    embedder: tripwireEmbedder(runtimeTouched),
    manifestsDir: o.manifestsDir ?? null,
    isDev: true,
    audit: recorder
  } as unknown as AppContext
  return { ctx, runtimeTouched, audit }
}

/**
 * The REAL offline connect-guard around every test of the calling scope: `beforeEach` installs
 * `installOfflineNetworkGuard` (offline), `afterEach` expects no violation and uninstalls in `finally` (a red
 * assertion never leaks the patched `connect` into the next test). Call it ONCE, at file or describe scope.
 * `violations()` reads the current test's list. Replaces at 27bd0b0d the guard pairs of evidence-freshness.test.ts:79-91
 * and evidence-pack-export.test.ts:56-67 (asserted), and of evidence-reviews-ipc.test.ts:217-228 and
 * evidence-review-open-perf.test.ts:105-116 (uninstalled without asserting).
 */
export function useOfflineGuard(): { violations(): readonly string[] } {
  let violations: string[] = []
  let uninstall: () => void = () => {}
  beforeEach(() => {
    violations = []
    uninstall = installOfflineNetworkGuard({
      isOffline: () => true,
      onViolation: (host) => violations.push(host)
    })
  })
  afterEach(() => {
    try {
      expect(violations).toEqual([])
    } finally {
      uninstall()
      uninstall = () => {}
    }
  })
  return { violations: () => violations }
}

/**
 * The printer seam is REQUIRED: this stub doubles as the assertion that an HTML-format path never reaches the
 * hidden-window print harness. Replaces at 27bd0b0d: evidence-pack-export.test.ts:114, evidence-freshness.test.ts:53,
 * evidence-pack-export-async-fs.test.ts:122 and evidence-pack-export-concurrent.test.ts:301.
 */
export const NEVER_PDF: EvidencePackExportDeps['renderPdf'] = async () => {
  throw new Error('renderPdf must not be called for an HTML export')
}

/**
 * Export deps that save to `dest` and never print; `over` spreads last. It does NOT inject `newPackId` / `now`: a row
 * that needs the fixed id and clock passes them (the goldens), so the rows that run the default mint and clock keep
 * doing so. Replaces at 27bd0b0d: evidence-pack-export.test.ts:118 (`EXPORT_DEPS`, which fixed both) and the inline
 * `{ chooseDestination: async () => dest, renderPdf: NEVER_PDF }` literals across the export suites.
 */
export function exportDeps(dest: string, over: Partial<EvidencePackExportDeps> = {}): EvidencePackExportDeps {
  return { chooseDestination: async () => dest, renderPdf: NEVER_PDF, ...over }
}

/**
 * Normalize a rendered pack's run-dependent bytes exactly as spec §29.5 prescribes: each id in `packIds` →
 * `PACK_ID`, every `YYYY-MM-DD HH:MM UTC` timestamp → `TIMESTAMP` (the golden files' tokens). Replaces at 27bd0b0d:
 * evidence-pack-export.test.ts:127 (`normalize`, one fixed id) and the inline `normalize` of
 * evidence-pack-html.test.ts:600 (two ids, token `TS`).
 */
export function normalizePack(html: string, packIds: string[]): string {
  let out = html
  for (const id of packIds) out = out.replaceAll(id, 'PACK_ID')
  return out.replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\b/g, 'TIMESTAMP')
}
