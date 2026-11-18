import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// EP-1 Phase 1 (plan §6.4) — the evidence-review IPC surface through the mocked-electron
// harness: the full create→read→update round trip (the four answer classes are the
// builder's, pinned in evidence-snapshot.test.ts), payload guards, the reviewer-origin forcing
// rule, the real freshness verdict over the wire, the idempotent create — and the phase's
// MANDATORY no-model/no-network assertions: the runtime is a tripwire that fails the suite if
// ANY handler touches it, and the real offline connect-guard must stay silent after EVERY test
// (`useOfflineGuard`; spec FR-2/FR-12; plan §6 exit gate).

const ipcState = vi.hoisted(() => ({
  handlers: new Map() as IpcHandlers,
  // The export handler's native save dialog, test-controlled; `lastOptions` is what the handler passed.
  saveDialog: {
    canceled: true as boolean,
    filePath: undefined as string | undefined,
    lastOptions: undefined as Record<string, unknown> | undefined
  },
  // The REAL print harness on the shared fake hidden window (#563: it fetches through the app's real scheme handler).
  print: { windows: [] as FakePrintWindow[], appListeners: new Map() } as FakePrintElectronState
}))
vi.mock('electron', async () => {
  const { fakePrintElectron } = await import('../helpers/fake-print-window')
  const { fakeIpcMain } = await import('../helpers/ipc')
  // The fake `app.getVersion()` is '0.0.0-test': create stamps it into the generation snapshot (IP1 reads it).
  return fakePrintElectron(ipcState.print, {
    ipcMain: fakeIpcMain(ipcState.handlers),
    dialog: {
      showSaveDialog: async (options: Record<string, unknown>) => {
        ipcState.saveDialog.lastOptions = options
        return { canceled: ipcState.saveDialog.canceled, filePath: ipcState.saveDialog.filePath }
      }
    }
  })
})

// node:fs/promises passes through, except an armed `rm` of ONE path (the G1 cleanup failure).
const fsState = vi.hoisted(() => ({ failRmFor: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fsState.failRmFor !== null && String(args[0]) === fsState.failRmFor) {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink (injected)'), { code: 'EPERM' })
      }
      return actual.rm(...args)
    }
  }
})

import { registerEvidenceReviewsIpc } from '../../src/main/ipc/registerEvidenceReviewsIpc'
import { listAuditEvents } from '../../src/main/services/audit'
import { IPC } from '../../src/shared/ipc'
import { t as tShared } from '../../src/shared/i18n'
import type {
  Citation,
  CoverageInfo,
  EvidenceExportRecord,
  EvidenceReadyGate,
  EvidenceReview,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceReviewSummary
} from '../../src/shared/types'
import { freshWorkspaceDb } from '../helpers/db-fixtures'
import {
  evidenceIpcContext,
  seedAssistantAnswer,
  seedSourceDocument,
  useOfflineGuard
} from '../helpers/evidence-fixtures'
import type { FakePrintElectronState, FakePrintWindow } from '../helpers/fake-print-window'
import { manifestsDirWith, rawManifest } from '../helpers/manifest-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers

const RELEVANCE = {
  content: '# H\n\nClaim one. [S1]\n\nClaim two. [S2]',
  citations: [
    { label: 'S1', sourceTitle: 'A.pdf' },
    { label: 'S2', sourceTitle: 'B.pdf' }
  ] as Citation[],
  coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 9 } as CoverageInfo
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // "%PDF-"

// The REAL offline tripwire is installed for every test in this file and asserted silent after
// each one; any remote connect attempt during the evidence flows fails the suite (loopback
// exempt, as in production).
useOfflineGuard()
beforeEach(() => {
  ipcState.handlers.clear()
  fsState.failRmFor = null
})

/** One workspace + the real registrar on H's tripwired context. */
function harness(o: { unlocked?: () => boolean; manifestsDir?: string } = {}) {
  const { db, root } = freshWorkspaceDb('epipc')
  const c = evidenceIpcContext(db, root, o)
  registerEvidenceReviewsIpc(c.ctx)
  return { db, root, ...c }
}

describe('evidence-review IPC round trips (mocked-electron harness)', () => {
  it('create→read→update→decide→select→link→ready→reopen→refresh, model never touched, offline guard silent', async () => {
    const { db, runtimeTouched } = harness()
    // FIX-4c: one citation WITH a documentId (the byId resolution branch) and one without
    // (title-unmatched → unresolved) — both resolved under the tripwire-asserted flow.
    const docId = seedSourceDocument(db, { title: 'A.pdf', sha256: 'aa'.repeat(32) })
    const { conversationId, messageId } = seedAssistantAnswer(db, {
      content: RELEVANCE.content,
      citations: [
        { label: 'S1', sourceTitle: 'A.pdf', documentId: docId, chunkId: 'c1' },
        { label: 'S2', sourceTitle: 'B.pdf' }
      ],
      coverage: RELEVANCE.coverage,
      modelId: 'm1'
    })

    // -- create
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    expect(created.status).toBe('draft')
    expect(created.items.map((i) => i.blockKind)).toEqual(['heading', 'paragraph', 'paragraph'])
    expect(created.sources.map((s) => s.key)).toEqual(['S1', 'S2'])
    expect(created.sources[0]).toMatchObject({
      identity: 'resolved',
      documentId: docId,
      documentSha256: 'aa'.repeat(32),
      availabilityAtCreation: 'available'
    })
    expect(created.sources[1]).toMatchObject({ identity: 'unresolved', documentId: null })
    expect(created.items[1]!.links).toEqual([{ evidenceKey: 'S1', origin: 'answer_marker', relation: null }])
    // Generation snapshot got the injected electron app version; the model id records even
    // with no manifests dir (display name honestly null, never invented).
    expect(created.generationSnapshot).toMatchObject({
      appVersion: '0.0.0-test',
      modelId: 'm1',
      modelDisplayName: null
    })

    // -- idempotent create: the SAME review comes back; no duplicate; ONE audit event.
    const { result: againRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    expect((againRaw as EvidenceReviewDetail).id).toBe(created.id)
    expect(listAuditEvents(db, { limit: 100 }).filter((e) => e.type === 'evidence_review_created')).toHaveLength(1)

    // -- entry-point read (the transcript's chip state: the conversation batch, AUD-12)
    const { result: summariesRaw } = await invoke(handlers, IPC.getEvidenceReviewSummariesForConversation, conversationId)
    const [summary] = summariesRaw as EvidenceReviewSummary[]
    expect(summary).toMatchObject({ id: created.id, messageId, status: 'draft', outdated: false })
    expect(summary!.gate).toEqual({ eligible: false, requiredTotal: 2, decidedTotal: 0 })

    // -- head patch
    const { result: patchedRaw } = await invoke(handlers, IPC.updateEvidenceReview, created.id, {
      title: 'Renamed review',
      reviewerLabel: 'P. Reviewer',
      generalNote: 'Overall note'
    })
    expect(patchedRaw as EvidenceReview).toMatchObject({
      title: 'Renamed review',
      reviewerLabel: 'P. Reviewer',
      generalNote: 'Overall note'
    })

    // -- item decision + note
    const itemA = created.items[1]!
    const { result: decidedRaw } = await invoke(handlers, IPC.updateEvidenceReviewItem, itemA.id, {
      decision: 'supported',
      reviewerNote: 'Checked against §5.'
    })
    expect(decidedRaw as EvidenceReviewItem).toMatchObject({ decision: 'supported', reviewerNote: 'Checked against §5.' })

    // -- reviewer selection: valid offsets carve a slice; misaligned offsets refuse (null).
    const { result: selRaw } = await invoke(handlers, IPC.createEvidenceSelection, created.id, {
      blockKey: itemA.blockKey,
      startOffset: 0,
      endOffset: 5
    })
    const selection = selRaw as EvidenceReviewItem
    expect(selection).toMatchObject({ kind: 'selection', textSnapshot: 'Claim' })
    const { result: badSel } = await invoke(handlers, IPC.createEvidenceSelection, created.id, {
      blockKey: itemA.blockKey,
      startOffset: 2,
      endOffset: 999
    })
    expect(badSel).toBeNull()

    // -- links: a renderer set is ALWAYS 'reviewer' — even a payload claiming
    // 'answer_marker' (the honesty-load-bearing origin only the snapshot builder mints).
    const { result: linkedRaw } = await invoke(handlers, IPC.setEvidenceLink, selection.id, 'S2', {
      origin: 'answer_marker',
      relation: 'supports'
    })
    const linked = linkedRaw as EvidenceReviewItem
    expect(linked.links).toEqual([{ evidenceKey: 'S2', origin: 'reviewer', relation: 'supports' }])
    // Unknown source key refuses.
    const { result: badLink } = await invoke(handlers, IPC.setEvidenceLink, selection.id, 'S9', {
      origin: 'reviewer'
    })
    expect(badLink).toBeNull()
    const { result: removed } = await invoke(handlers, IPC.removeEvidenceLink, selection.id, 'S2')
    expect(removed).toBe(true)

    // -- FIX-4a: a REAL selection deletion through the handler (success path under the
    // tripwires); a structural BLOCK item refuses.
    const { result: selDeleted } = await invoke(handlers, IPC.deleteEvidenceSelection, selection.id)
    expect(selDeleted).toBe(true)
    const { result: blockRefused } = await invoke(handlers, IPC.deleteEvidenceSelection, itemA.id)
    expect(blockRefused).toBe(false)

    // -- mark ready refuses while a required block is undecided (gate says why)…
    const { result: refusedRaw } = await invoke(handlers, IPC.markEvidenceReviewReady, created.id)
    const refused = refusedRaw as { review: EvidenceReview; gate: EvidenceReadyGate }
    expect(refused.review.status).toBe('draft')
    expect(refused.gate).toEqual({ eligible: false, requiredTotal: 2, decidedTotal: 1 })
    expect(listAuditEvents(db, { limit: 100 }).some((e) => e.type === 'evidence_review_ready')).toBe(false)

    // …then succeeds once every required block is decided ('not_applicable' counts).
    const itemB = created.items[2]!
    await invoke(handlers, IPC.updateEvidenceReviewItem, itemB.id, { decision: 'not_applicable' })
    const { result: readyRaw } = await invoke(handlers, IPC.markEvidenceReviewReady, created.id)
    const ready = readyRaw as { review: EvidenceReview; gate: EvidenceReadyGate }
    expect(ready.review.status).toBe('ready')
    expect(ready.review.completedAt).toBeTruthy()
    expect(ready.gate.eligible).toBe(true)

    // -- reopen back to draft (spec §18.4)
    const { result: reopenedRaw } = await invoke(handlers, IPC.reopenEvidenceReview, created.id)
    expect(reopenedRaw as EvidenceReview).toMatchObject({ status: 'draft', completedAt: null })

    // -- freshness (REAL since Phase 4): the untouched workspace reads honestly — resolved
    // source unchanged, unresolved source 'unverifiable' (never 'changed'), answer +
    // coverage unchanged, not outdated, nothing acknowledged; unknown id → null.
    const { result: freshRaw } = await invoke(handlers, IPC.refreshEvidenceReviewState, created.id)
    expect(freshRaw as EvidenceReviewFreshness).toEqual({
      reviewId: created.id,
      outdated: false,
      answerState: 'unchanged',
      coverageState: 'unchanged',
      sources: [
        { key: 'S1', state: 'unchanged' },
        { key: 'S2', state: 'unverifiable' }
      ],
      acknowledgedAt: null
    })
    const { result: freshMissing } = await invoke(handlers, IPC.refreshEvidenceReviewState, 'nope')
    expect(freshMissing).toBeNull()

    const types = listAuditEvents(db, { limit: 100 }).map((e) => e.type)
    expect(types).toContain('evidence_review_created')
    expect(types).toContain('evidence_review_ready')

    // -- the phase's hard rule, asserted over the WHOLE flow (the offline guard: after every test):
    expect(runtimeTouched).toEqual([]) // model runtime never consulted, never started
  })

  // #839 F2: every other row runs with no manifests dir (display name honestly null). With the drive's catalog, create
  // stamps the model's catalog name once, main-side; the renderer never supplies it.
  it('create stamps the catalog display name of the conversation model into the generation snapshot', async () => {
    const { db, runtimeTouched } = harness({ manifestsDir: manifestsDirWith(rawManifest()) })
    const { messageId } = seedAssistantAnswer(db, { ...RELEVANCE, modelId: 'qwen3-4b-instruct-q4' })
    const created = (await invoke(handlers, IPC.createEvidenceReview, messageId)).result as EvidenceReviewDetail
    expect(created.generationSnapshot).toMatchObject({
      modelId: 'qwen3-4b-instruct-q4',
      modelDisplayName: 'Qwen3 4B Instruct Q4'
    })
    expect(runtimeTouched).toEqual([])
  })

  it('payload guards: malformed ids and shapes read as unknown; create refuses garbage loudly', async () => {
    const { db, runtimeTouched } = harness()
    const { messageId } = seedAssistantAnswer(db, RELEVANCE)
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail

    // Non-string / empty ids → unknown (null/false), never a throw or a cast.
    expect((await invoke(handlers, IPC.getEvidenceReview, 42)).result).toBeNull()
    expect((await invoke(handlers, IPC.updateEvidenceReview, {}, { title: 'x' })).result).toBeNull()
    expect((await invoke(handlers, IPC.deleteEvidenceSelection, null)).result).toBe(false)
    expect((await invoke(handlers, IPC.removeEvidenceLink, created.items[0]!.id, 7)).result).toBe(false)
    // The legs above bind and match no row (null contract; {} is read as an empty named-parameter bag). `true` cannot be bound by node:sqlite: only safeId keeps these from throwing.
    expect((await invoke(handlers, IPC.getEvidenceReview, true)).result).toBeNull()
    expect((await invoke(handlers, IPC.updateEvidenceReview, true, { title: 'x' })).result).toBeNull()
    expect((await invoke(handlers, IPC.deleteEvidenceSelection, true)).result).toBe(false)
    expect((await invoke(handlers, IPC.removeEvidenceLink, created.items[0]!.id, true)).result).toBe(false)
    await expect(invoke(handlers, IPC.createEvidenceReview, { not: 'a string' })).rejects.toThrow(
      tShared('en', 'main.evidenceReviews.invalidRequest')
    )
    // Unknown and non-assistant messages: the builder's ids-only errors cross the wire unmapped.
    await expect(invoke(handlers, IPC.createEvidenceReview, 'missing-msg')).rejects.toThrow('missing-msg')
    const userTurn = seedAssistantAnswer(db, { content: 'A', question: 'Q' })
    await expect(invoke(handlers, IPC.createEvidenceReview, userTurn.questionId!)).rejects.toThrow(userTurn.questionId!)

    // A malformed item patch DROPS the bad fields: an unknown decision literal never
    // reaches storage and never clears the stored decision.
    const item = created.items[1]!
    await invoke(handlers, IPC.updateEvidenceReviewItem, item.id, { decision: 'supported' })
    const { result: junkPatch } = await invoke(handlers, IPC.updateEvidenceReviewItem, item.id, {
      decision: 'totally_bogus',
      reviewerNote: 42
    })
    expect(junkPatch as EvidenceReviewItem).toMatchObject({ decision: 'supported', reviewerNote: null })

    // A malformed head patch DROPS the bad field: a non-string reviewer label never reaches storage.
    const { result: labelKept } = await invoke(handlers, IPC.updateEvidenceReview, created.id, { reviewerLabel: 42 })
    expect(labelKept as EvidenceReview).toMatchObject({ reviewerLabel: null })

    // A malformed selection input refuses. The two shapes below are refused by the service too ('' matches no block, '0' is not an integer).
    expect(
      (await invoke(handlers, IPC.createEvidenceSelection, created.id, { blockKey: '', startOffset: 0, endOffset: 1 }))
        .result
    ).toBeNull()
    expect(
      (await invoke(handlers, IPC.createEvidenceSelection, created.id, { blockKey: item.blockKey, startOffset: '0', endOffset: 1 }))
        .result
    ).toBeNull()
    // A TRUTHY non-object passes the handler's `id && selection` check unless sanitizeSelectionInput turns it into null:
    // the service would read `(42).blockKey`, bind undefined and throw.
    expect((await invoke(handlers, IPC.createEvidenceSelection, created.id, 42)).result).toBeNull()

    // FIX-4b: the hard rules hold across the guard flows too.
    expect(runtimeTouched).toEqual([])
  })

  it('FIX-5: markReady on an already-ready review is a NO-OP — original completed_at kept, exactly one audit event', async () => {
    const { db, runtimeTouched } = harness()
    const { messageId } = seedAssistantAnswer(db, {
      content: 'Single claim. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'A.pdf' }],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    await invoke(handlers, IPC.updateEvidenceReviewItem, created.items[0]!.id, { decision: 'supported' })
    const { result: firstRaw } = await invoke(handlers, IPC.markEvidenceReviewReady, created.id)
    expect((firstRaw as { review: EvidenceReview }).review.status).toBe('ready')

    // Pin the stamp with a sentinel value so a buggy re-UPDATE cannot hide inside the
    // same clock millisecond, then mark again.
    const SENTINEL_STAMP = '2020-01-01T00:00:00.000Z'
    db.prepare('UPDATE evidence_reviews SET completed_at = ? WHERE id = ?').run(SENTINEL_STAMP, created.id)
    const { result: againRaw } = await invoke(handlers, IPC.markEvidenceReviewReady, created.id)
    const again = againRaw as { review: EvidenceReview; gate: EvidenceReadyGate }
    expect(again.review.status).toBe('ready')
    expect(again.review.completedAt).toBe(SENTINEL_STAMP) // no re-stamp
    expect(again.gate.eligible).toBe(true)
    // The service-internal transition flag never crosses the wire.
    expect('becameReady' in (againRaw as Record<string, unknown>)).toBe(false)
    // Exactly ONE ready event across the double call.
    expect(listAuditEvents(db, { limit: 100 }).filter((e) => e.type === 'evidence_review_ready')).toHaveLength(1)

    expect(runtimeTouched).toEqual([])
  })
})

// ---- Phase 2 (plan §7): the vault lock gate and the D-2 count (the restart leg lives in evidence-reviews.test.ts) ----
describe('vault lock + the D-2 delete-confirm count (EP-1 plan §7 exit gate)', () => {
  // The EVERY-channel lock guarantee lives in ipc-lock-coverage.test.ts (it enumerates all
  // registered handlers); this leg samples read/write/count through a REAL lock→unlock cycle.
  it('vault lock refuses sampled evidence channels (read/write/count) with the friendly copy; unlock restores the data', async () => {
    let unlocked = true
    const h = harness({ unlocked: () => unlocked })
    const { conversationId, messageId } = seedAssistantAnswer(h.db, {
      content: RELEVANCE.content,
      citations: RELEVANCE.citations,
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    const target = created.items.find((i) => i.blockKind === 'paragraph')!
    await invoke(handlers, IPC.updateEvidenceReviewItem, target.id, { decision: 'follow_up' })

    unlocked = false
    await expect(invoke(handlers, IPC.getEvidenceReview, created.id)).rejects.toThrow(
      'Workspace is locked. Unlock it to work on evidence reviews.'
    )
    await expect(
      invoke(handlers, IPC.updateEvidenceReviewItem, target.id, { decision: 'supported' })
    ).rejects.toThrow('Workspace is locked.')
    await expect(
      invoke(handlers, IPC.countEvidenceReviewsForConversation, conversationId)
    ).rejects.toThrow('Workspace is locked.')

    unlocked = true
    const { result: afterRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    const after = afterRaw as EvidenceReviewDetail
    // The pre-lock decision is intact; the locked-out write never landed.
    expect(after.items.find((i) => i.id === target.id)!.decision).toBe('follow_up')
    expect(h.runtimeTouched).toEqual([])
  })

  it('countEvidenceReviewsForConversation (D-2): per-conversation counts, ids-only, malformed → 0', async () => {
    const h = harness()
    const a = seedAssistantAnswer(h.db, { content: RELEVANCE.content, citations: RELEVANCE.citations })
    const b = seedAssistantAnswer(h.db, { content: 'Other. [S1]', citations: RELEVANCE.citations })

    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, a.conversationId)).result).toBe(0)
    await invoke(handlers, IPC.createEvidenceReview, a.messageId)
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, a.conversationId)).result).toBe(1)
    // Isolation: conversation B still counts zero.
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, b.conversationId)).result).toBe(0)
    // Malformed ids read as "no reviews", matching the surface's unknown-id results.
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, 42)).result).toBe(0)
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, '')).result).toBe(0)
    // 42 and '' bind and count nothing (the null contract); `true` cannot be bound: only safeId keeps it from throwing.
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, true)).result).toBe(0)
    expect(h.runtimeTouched).toEqual([])
  })
})

describe('evidence-pack export over IPC (plan §8.3 — the 15th channel)', () => {
  beforeEach(() => {
    ipcState.saveDialog.canceled = true
    ipcState.saveDialog.filePath = undefined
    ipcState.saveDialog.lastOptions = undefined
    ipcState.print.windows.length = 0
    ipcState.print.printToPDF = async () => PDF_BYTES
  })

  it('cancel → null, no file, no row, no audit event', async () => {
    const h = harness()
    const { messageId } = seedAssistantAnswer(h.db, {
      content: RELEVANCE.content,
      citations: RELEVANCE.citations,
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    ipcState.saveDialog.canceled = true
    const { result } = await invoke(handlers, IPC.exportEvidencePack, created.id, {})
    expect(result).toBeNull()
    const { result: detailRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    expect((detailRaw as EvidenceReviewDetail).exports).toEqual([])
    expect(listAuditEvents(h.db, { limit: 100 }).some((e) => e.type === 'evidence_pack_exported')).toBe(false)
    expect(h.runtimeTouched).toEqual([])
  })

  it('FIX-1: a post-rename record failure surfaces as the LOCALIZED distinct error — file removed, no row, no audit event, never null', async () => {
    const h = harness()
    const { messageId } = seedAssistantAnswer(h.db, {
      content: RELEVANCE.content,
      citations: RELEVANCE.citations,
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    const dest = join(h.root, 'post-rename-ipc.html')
    ipcState.saveDialog.canceled = false
    ipcState.saveDialog.filePath = dest
    // Injected row-insert failure AFTER the pipeline's load (INSERT-only trigger).
    h.db.exec(
      "CREATE TRIGGER fail_export BEFORE INSERT ON evidence_exports BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    await expect(invoke(handlers, IPC.exportEvidencePack, created.id, {})).rejects.toThrow(
      'The evidence pack could not be recorded in the export history, so the exported file was removed.'
    )
    h.db.exec('DROP TRIGGER fail_export')
    expect(existsSync(dest)).toBe(false)
    const { result: detailRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    expect((detailRaw as EvidenceReviewDetail).exports).toEqual([])
    expect(listAuditEvents(h.db, { limit: 100 }).some((e) => e.type === 'evidence_pack_exported')).toBe(false)
    expect(h.runtimeTouched).toEqual([])
  })

  it('FIX-1: a post-rename record failure whose cleanup also fails surfaces the exportFileNotRecorded copy — the file stays, no row, no audit event', async () => {
    const { db, root, runtimeTouched } = harness()
    const { messageId } = seedAssistantAnswer(db, {
      content: RELEVANCE.content,
      citations: RELEVANCE.citations,
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    const dest = join(root, 'unrecorded-ipc.html')
    ipcState.saveDialog.canceled = false
    ipcState.saveDialog.filePath = dest
    // The record INSERT fails after the rename, and the unlink that would restore "no file" fails too.
    db.exec("CREATE TRIGGER fail_export BEFORE INSERT ON evidence_exports BEGIN SELECT RAISE(ABORT, 'injected'); END")
    fsState.failRmFor = dest
    try {
      await expect(invoke(handlers, IPC.exportEvidencePack, created.id, {})).rejects.toThrow(
        tShared('en', 'main.evidenceReviews.exportFileNotRecorded')
      )
    } finally {
      fsState.failRmFor = null
      db.exec('DROP TRIGGER fail_export')
    }
    // The one named residual state (security-model "named, never silent"): the file exists and nothing records it.
    expect(existsSync(dest)).toBe(true)
    const { result: detailRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    expect((detailRaw as EvidenceReviewDetail).exports).toEqual([])
    expect(listAuditEvents(db, { limit: 100 }).some((e) => e.type === 'evidence_pack_exported')).toBe(false)
    expect(runtimeTouched).toEqual([])
  })

  it('guards the boundary: malformed id → null without a dialog; hostile options resolve to defaults', async () => {
    const h = harness()
    // Unknown/malformed ids never reach the dialog: the dialog would also answer null (it is cancelled), so read what it was asked.
    expect((await invoke(handlers, IPC.exportEvidencePack, 42, {})).result).toBeNull()
    expect((await invoke(handlers, IPC.exportEvidencePack, '', {})).result).toBeNull()
    expect((await invoke(handlers, IPC.exportEvidencePack, 'no-such-review', {})).result).toBeNull()
    expect(ipcState.saveDialog.lastOptions).toBeUndefined() // no dialog for a malformed or unknown id

    const { messageId } = seedAssistantAnswer(h.db, {
      content: RELEVANCE.content,
      citations: RELEVANCE.citations,
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    const dest = join(h.root, 'hostile-options.html')
    ipcState.saveDialog.canceled = false
    ipcState.saveDialog.filePath = dest
    const { result: recordRaw } = await invoke(handlers, IPC.exportEvidencePack, created.id, {
      language: 'xx',
      includeReviewerNotes: 'yes',
      includeSourcePaths: true,
      nested: { deep: true }
    })
    const record = recordRaw as EvidenceExportRecord
    // The persisted option set is the RESOLVED one — garbage never masquerades as a choice.
    expect(record.options).toEqual({
      language: 'en',
      includeReviewerNotes: true,
      includeSourceExcerpts: true,
      includeDocumentHashes: true,
      includeUnreviewedItems: true,
      includeTechnicalDetails: false
    })
    expect(h.runtimeTouched).toEqual([])
  })

  it('P6: PDF over the SAME channel — dialog offers BOTH formats (PDF first), the REAL harness prints, row + audit say "pdf"', async () => {
    const h = harness()
    const { messageId } = seedAssistantAnswer(h.db, {
      content: RELEVANCE.content,
      citations: RELEVANCE.citations,
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    const dest = join(h.root, 'pack.pdf')
    ipcState.saveDialog.canceled = false
    ipcState.saveDialog.filePath = dest
    const { result: recordRaw } = await invoke(handlers, IPC.exportEvidencePack, created.id, {
      language: 'en',
      format: 'pdf'
    })
    const record = recordRaw as EvidenceExportRecord

    // The dialog offered BOTH formats, requested one first, suggested name .pdf.
    expect(ipcState.saveDialog.lastOptions?.filters).toEqual([
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'HTML', extensions: ['html'] }
    ])
    expect(String(ipcState.saveDialog.lastOptions?.defaultPath)).toMatch(/\.pdf$/)

    // The REAL print harness ran: it loaded the pack FROM MEMORY on the print host under a
    // random token (#563), served once by the app's own scheme handler — and nothing beside the
    // destination but the destination itself.
    expect(ipcState.print.windows).toHaveLength(1)
    expect(String(ipcState.print.windows[0]!.loadedUrl)).toMatch(/^hilbertraum:\/\/print\/[0-9a-f]{64}$/)
    expect(ipcState.print.windows[0]!.served?.status).toBe(200)
    expect(ipcState.print.windows[0]!.served?.body.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(readdirSync(h.root).filter((f) => f.startsWith('pack.pdf'))).toEqual(['pack.pdf'])

    // The destination holds the printer's bytes; the row + audit record 'pdf'.
    expect(new Uint8Array(readFileSync(dest))).toEqual(PDF_BYTES)
    expect(record.format).toBe('pdf')
    expect(record.fileName).toBe('pack.pdf')
    expect(record.options).not.toHaveProperty('format')
    const exported = listAuditEvents(h.db, { limit: 100 }).find((e) => e.type === 'evidence_pack_exported')
    expect(exported?.metadata).toEqual({ reviewId: created.id, format: 'pdf' })

    // The history read shows the raw stored format (display passthrough) and the recorded hash.
    const { result: detailRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    expect((detailRaw as EvidenceReviewDetail).exports).toEqual([
      expect.objectContaining({ format: 'pdf', fileName: 'pack.pdf', fileSha256: record.fileSha256 })
    ])

    expect(h.runtimeTouched).toEqual([])
  })

  it('P6: absent or malformed format reads html — HTML filter first, both still offered', async () => {
    const h = harness()
    const { messageId } = seedAssistantAnswer(h.db, {
      content: RELEVANCE.content,
      citations: RELEVANCE.citations,
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    // 'PDF' (wrong case) is NOT normalized — the boundary reads it as the default.
    ipcState.saveDialog.canceled = true
    await invoke(handlers, IPC.exportEvidencePack, created.id, { format: 'PDF' })
    expect(ipcState.saveDialog.lastOptions?.filters).toEqual([
      { name: 'HTML', extensions: ['html'] },
      { name: 'PDF', extensions: ['pdf'] }
    ])
    expect(String(ipcState.saveDialog.lastOptions?.defaultPath)).toMatch(/\.html$/)
    // §24.3 (#839 F3): the pack leaves the encrypted workspace; the dialog says so (the macOS sheet shows `message`).
    expect(ipcState.saveDialog.lastOptions?.message).toBe(tShared('en', 'review.export.encryptionWarning'))
    expect(h.runtimeTouched).toEqual([])
  })
})
