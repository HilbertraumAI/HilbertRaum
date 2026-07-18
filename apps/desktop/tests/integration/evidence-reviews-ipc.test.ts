import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installOfflineNetworkGuard } from '../../src/main/services/offlineGuard'

// EP-1 Phase 1 (plan §6.4) — the evidence-review IPC surface through the mocked-electron
// harness: full create→read→update→delete round trips for all four answer classes, payload
// guards, the reviewer-origin forcing rule, the freshness stub, the idempotent create — and
// the phase's MANDATORY no-model/no-network assertions: the runtime is a tripwire that
// fails the suite if ANY handler touches it, and the real offline connect-guard must stay
// silent across the entire flow (spec FR-2/FR-12; plan §6 exit gate).

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  // Phase 3 (plan §8.3): the export handler's native save dialog, test-controlled. P6
  // records the options the handler passed (the filter-list "offers PDF and HTML" pin).
  saveDialog: {
    canceled: true as boolean,
    filePath: undefined as string | undefined,
    lastOptions: undefined as Record<string, unknown> | undefined
  },
  // P6: what the REAL print harness saw on the fake hidden window (bytes it returns,
  // the loaded file, whether the print source existed on disk at load time).
  pdf: {
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), // "%PDF-"
    loadedPath: undefined as string | undefined,
    sourceExistedAtLoad: false
  }
}))
vi.mock('electron', async () => {
  const { existsSync } = await import('node:fs')
  // P6: a constructible hidden-window fake — the REAL printEvidencePackHtmlToPdf drives
  // it (loadFile → fonts → printToPDF → destroy); only Electron itself is faked.
  class BrowserWindow {
    static getFocusedWindow(): null {
      return null
    }
    destroyed = false
    webContents = {
      setWindowOpenHandler: (): void => {},
      on: (): void => {},
      executeJavaScript: async (): Promise<boolean> => true,
      printToPDF: async (): Promise<Uint8Array> => ipcState.pdf.bytes
    }
    async loadFile(path: string): Promise<void> {
      ipcState.pdf.loadedPath = path
      ipcState.pdf.sourceExistedAtLoad = existsSync(path)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  return {
    ipcMain: {
      handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
      removeHandler: (channel: string) => ipcState.handlers.delete(channel)
    },
    app: {
      getVersion: () => '0.0.0-test',
      once: (): void => {},
      removeListener: (): void => {}
    },
    BrowserWindow,
    dialog: {
      showSaveDialog: async (options: Record<string, unknown>) => {
        ipcState.saveDialog.lastOptions = options
        return {
          canceled: ipcState.saveDialog.canceled,
          filePath: ipcState.saveDialog.filePath
        }
      }
    }
  }
})

import { randomUUID } from 'node:crypto'
import { registerEvidenceReviewsIpc } from '../../src/main/ipc/registerEvidenceReviewsIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createAuditRecorder, listAuditEvents } from '../../src/main/services/audit'
import { isReviewEligible } from '../../src/shared/evidence-review'
import type { AppContext } from '../../src/main/services/context'
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
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** Model tripwire: every runtime touch is recorded — the suite asserts ZERO touches. */
function tripwireRuntime(touched: string[]): AppContext['runtime'] {
  return {
    active: () => {
      touched.push('active')
      return null
    },
    activeModelId: () => {
      touched.push('activeModelId')
      return null
    },
    start: async () => {
      touched.push('start')
      throw new Error('model runtime must never start on the evidence surface')
    },
    stop: async () => {
      touched.push('stop')
    },
    status: () => {
      touched.push('status')
      return { running: false, modelId: null, port: null, healthy: false, message: '' }
    }
  } as unknown as AppContext['runtime']
}

interface Harness {
  ctx: AppContext
  db: Db
  runtimeTouched: string[]
  root: string
}

/** `root` reopens an existing workspace file (the restart legs); `unlocked` makes the
 *  lock state test-controllable (the vault lock/unlock legs). Defaults unchanged. */
function makeHarness(opts: { root?: string; unlocked?: () => boolean } = {}): Harness {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'hilbertraum-epipc-'))
  const db = openDatabase(join(root, 'test.sqlite'))
  const runtimeTouched: string[] = []
  const ctx = {
    db,
    paths: { workspacePath: root, rootPath: root, configPath: join(root, 'config.json') },
    workspace: { isUnlocked: opts.unlocked ?? (() => true) },
    runtime: tripwireRuntime(runtimeTouched),
    embedder: {
      id: 'tripwire-embedder',
      dimensions: 1,
      embed: async () => {
        runtimeTouched.push('embed')
        return []
      }
    },
    manifestsDir: null,
    isDev: true,
    audit: createAuditRecorder(() => db)
  } as unknown as AppContext
  return { ctx, db, runtimeTouched, root }
}

function seedDocument(db: Db, opts: { title: string; sha256?: string; mime?: string }): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'indexed', ?, ?)`
  ).run(id, opts.title, opts.mime ?? 'application/pdf', opts.sha256 ?? 'ab'.repeat(32), now, now)
  return id
}

function seedAnswer(
  db: Db,
  opts: {
    content: string
    citations?: Citation[] | null
    coverage?: CoverageInfo | null
    title?: string
  }
): { conversationId: string; messageId: string } {
  const conv = createConversation(db, { title: opts.title ?? 'IPC review chat', modelId: 'm1' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Question?' })
  const msg = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: opts.content,
    citations: opts.citations ?? null,
    coverage: opts.coverage ?? null
  })
  return { conversationId: conv.id, messageId: msg.id }
}

const RELEVANCE = {
  content: '# H\n\nClaim one. [S1]\n\nClaim two. [S2]',
  citations: [
    { label: 'S1', sourceTitle: 'A.pdf' },
    { label: 'S2', sourceTitle: 'B.pdf' }
  ] as Citation[],
  coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 9 } as CoverageInfo
}

// The REAL offline tripwire is installed for every test in this file; any remote connect
// attempt during the evidence flows fails the suite (loopback exempt, as in production).
let offlineViolations: string[] = []
let uninstallGuard: () => void = () => {}

beforeEach(() => {
  ipcState.handlers.clear()
  offlineViolations = []
  uninstallGuard = installOfflineNetworkGuard({
    offline: true,
    onViolation: (host) => offlineViolations.push(host)
  })
})

afterEach(() => {
  uninstallGuard()
})

describe('evidence-review IPC round trips (mocked-electron harness)', () => {
  it('create→read→update→decide→select→link→ready→reopen→refresh→delete, model never touched, offline guard silent', async () => {
    const { ctx, db, runtimeTouched } = makeHarness()
    registerEvidenceReviewsIpc(ctx)
    // FIX-4c: one citation WITH a documentId (the byId resolution branch) and one without
    // (title-unmatched → unresolved) — both resolved under the tripwire-asserted flow.
    const docId = seedDocument(db, { title: 'A.pdf', sha256: 'aa'.repeat(32) })
    const { messageId } = seedAnswer(db, {
      content: RELEVANCE.content,
      citations: [
        { label: 'S1', sourceTitle: 'A.pdf', documentId: docId, chunkId: 'c1' },
        { label: 'S2', sourceTitle: 'B.pdf' }
      ],
      coverage: RELEVANCE.coverage
    })

    // The shared eligibility rule the renderer will use (plan §6.5): this answer qualifies.
    expect(isReviewEligible({ role: 'assistant', citations: RELEVANCE.citations, coverage: RELEVANCE.coverage })).toBe(true)

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

    // -- entry-point read
    const { result: summaryRaw } = await invoke(handlers, IPC.getEvidenceReviewForMessage, messageId)
    const summary = summaryRaw as EvidenceReviewSummary
    expect(summary).toMatchObject({ id: created.id, messageId, status: 'draft', outdated: false })
    expect(summary.gate).toEqual({ eligible: false, requiredTotal: 2, decidedTotal: 0 })

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

    // -- delete
    const { result: deleted } = await invoke(handlers, IPC.deleteEvidenceReview, created.id)
    expect(deleted).toBe(true)
    const { result: goneRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    expect(goneRaw).toBeNull()
    const types = listAuditEvents(db, { limit: 100 }).map((e) => e.type)
    expect(types).toContain('evidence_review_created')
    expect(types).toContain('evidence_review_ready')
    expect(types).toContain('evidence_review_deleted')

    // -- the phase's hard rules, asserted over the WHOLE flow:
    expect(runtimeTouched).toEqual([]) // model runtime never consulted, never started
    expect(offlineViolations).toEqual([]) // no remote connect attempt anywhere
  })

  it('exit gate: create→read→update→delete works for all four answer classes from persisted data only', async () => {
    const { ctx, db, runtimeTouched } = makeHarness()
    registerEvidenceReviewsIpc(ctx)

    const classes = [
      { name: 'relevance', ...RELEVANCE },
      {
        name: 'whole-doc tree',
        content: 'Derived summary.\n\nSecond point. [S1]',
        citations: [{ label: 'S1', sourceTitle: 'R.pdf' }] as Citation[],
        coverage: { mode: 'tree', chunksCovered: 5, chunksTotal: 5 } as CoverageInfo
      },
      {
        name: 'extract',
        content: 'Three amounts found. [S1]',
        citations: [{ label: 'S1', sourceTitle: 'I.pdf' }] as Citation[],
        coverage: { mode: 'extract', chunksCovered: 3, chunksTotal: 3 } as CoverageInfo
      },
      { name: 'legacy no-citation', content: 'Plain legacy answer.', citations: null, coverage: null }
    ] as const

    for (const cls of classes) {
      const { messageId } = seedAnswer(db, cls)
      const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
      const created = createdRaw as EvidenceReviewDetail
      expect(created.items.length).toBeGreaterThan(0)
      if (cls.coverage?.mode === 'tree' || cls.coverage?.mode === 'extract') {
        // Spec §13.3 hard rule through the REAL handler: zero auto-links.
        expect(created.items.every((i) => i.links.length === 0)).toBe(true)
      }
      const { result: read } = await invoke(handlers, IPC.getEvidenceReview, created.id)
      expect((read as EvidenceReviewDetail).id).toBe(created.id)
      const { result: renamed } = await invoke(handlers, IPC.updateEvidenceReview, created.id, {
        title: `${cls.name} pass`
      })
      expect((renamed as EvidenceReview).title).toBe(`${cls.name} pass`)
      const { result: deleted } = await invoke(handlers, IPC.deleteEvidenceReview, created.id)
      expect(deleted).toBe(true)
    }

    expect(runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])
  })

  it('payload guards: malformed ids and shapes read as unknown; create refuses garbage loudly', async () => {
    const { ctx, db, runtimeTouched } = makeHarness()
    registerEvidenceReviewsIpc(ctx)
    const { messageId } = seedAnswer(db, RELEVANCE)
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail

    // Non-string / empty ids → unknown (null/false), never a throw or a cast.
    expect((await invoke(handlers, IPC.getEvidenceReview, 42)).result).toBeNull()
    expect((await invoke(handlers, IPC.getEvidenceReviewForMessage, '')).result).toBeNull()
    expect((await invoke(handlers, IPC.updateEvidenceReview, {}, { title: 'x' })).result).toBeNull()
    expect((await invoke(handlers, IPC.deleteEvidenceSelection, null)).result).toBe(false)
    expect((await invoke(handlers, IPC.removeEvidenceLink, created.items[0]!.id, 7)).result).toBe(false)
    expect((await invoke(handlers, IPC.deleteEvidenceReview, undefined)).result).toBe(false)
    await expect(invoke(handlers, IPC.createEvidenceReview, { not: 'a string' })).rejects.toThrow(
      /review request/i
    )

    // A malformed item patch DROPS the bad fields: an unknown decision literal never
    // reaches storage and never clears the stored decision.
    const item = created.items[1]!
    await invoke(handlers, IPC.updateEvidenceReviewItem, item.id, { decision: 'supported' })
    const { result: junkPatch } = await invoke(handlers, IPC.updateEvidenceReviewItem, item.id, {
      decision: 'totally_bogus',
      reviewerNote: 42
    })
    expect(junkPatch as EvidenceReviewItem).toMatchObject({ decision: 'supported', reviewerNote: null })

    // A malformed head patch keeps the stored title (empty-title renames are ignored too).
    const { result: kept } = await invoke(handlers, IPC.updateEvidenceReview, created.id, {
      title: '   '
    })
    expect((kept as EvidenceReview).title).toBe(created.title)

    // A malformed selection input refuses without touching the service.
    expect(
      (await invoke(handlers, IPC.createEvidenceSelection, created.id, { blockKey: '', startOffset: 0, endOffset: 1 }))
        .result
    ).toBeNull()
    expect(
      (await invoke(handlers, IPC.createEvidenceSelection, created.id, { blockKey: item.blockKey, startOffset: '0', endOffset: 1 }))
        .result
    ).toBeNull()

    // FIX-4b: the hard rules hold across the guard flows too.
    expect(runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])
  })

  it('creating a review for an unknown or non-assistant message throws ids-only errors', async () => {
    const { ctx, db, runtimeTouched } = makeHarness()
    registerEvidenceReviewsIpc(ctx)
    await expect(invoke(handlers, IPC.createEvidenceReview, 'missing-msg')).rejects.toThrow('missing-msg')
    const conv = createConversation(db, { title: 'T' })
    const user = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Q' })
    await expect(invoke(handlers, IPC.createEvidenceReview, user.id)).rejects.toThrow(user.id)

    // FIX-4b: the hard rules hold across the refusal flows too.
    expect(runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])
  })

  it('FIX-5: markReady on an already-ready review is a NO-OP — original completed_at kept, exactly one audit event', async () => {
    const { ctx, db, runtimeTouched } = makeHarness()
    registerEvidenceReviewsIpc(ctx)
    const { messageId } = seedAnswer(db, {
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
    expect(offlineViolations).toEqual([])
  })
})

// ---- Phase 2 (plan §7): the review survives restart and vault lock/unlock -------------
describe('review persistence across restart + lock (EP-1 plan §7 exit gate)', () => {
  it('a decided review reopens INTACT after DB close + reopen (app restart), zero model/network', async () => {
    const first = makeHarness()
    registerEvidenceReviewsIpc(first.ctx)
    const docId = seedDocument(first.db, { title: 'A.pdf' })
    const { messageId } = seedAnswer(first.db, {
      content: RELEVANCE.content,
      citations: [{ label: 'S1', sourceTitle: 'A.pdf', documentId: docId }],
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    const target = created.items.find((i) => i.blockKind === 'paragraph')!
    await invoke(handlers, IPC.updateEvidenceReviewItem, target.id, {
      decision: 'supported',
      reviewerNote: 'checked against page 12'
    })
    await invoke(handlers, IPC.updateEvidenceReview, created.id, { reviewerLabel: 'QA' })

    // "Restart": close the DB, reopen the SAME workspace file, re-register the handlers.
    first.db.close()
    ipcState.handlers.clear()
    const second = makeHarness({ root: first.root })
    registerEvidenceReviewsIpc(second.ctx)

    const { result: reloadedRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    const reloaded = reloadedRaw as EvidenceReviewDetail
    expect(reloaded.reviewerLabel).toBe('QA')
    const reloadedItem = reloaded.items.find((i) => i.id === target.id)!
    expect(reloadedItem.decision).toBe('supported')
    expect(reloadedItem.reviewerNote).toBe('checked against page 12')
    // The frozen snapshots also survived (the review renders THESE, never the live message).
    expect(reloaded.answerSnapshot).toBe(RELEVANCE.content)
    expect(reloaded.sources[0]!.documentTitle).toBe('A.pdf')

    expect(first.runtimeTouched).toEqual([])
    expect(second.runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])
  })

  // The EVERY-channel lock guarantee lives in ipc-lock-coverage.test.ts (it enumerates all
  // registered handlers); this leg samples read/write/count through a REAL lock→unlock cycle.
  it('vault lock refuses sampled evidence channels (read/write/count) with the friendly copy; unlock restores the data', async () => {
    let unlocked = true
    const h = makeHarness({ unlocked: () => unlocked })
    registerEvidenceReviewsIpc(h.ctx)
    const { conversationId, messageId } = seedAnswer(h.db, {
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
    expect(offlineViolations).toEqual([])
  })

  it('countEvidenceReviewsForConversation (D-2): per-conversation counts, ids-only, malformed → 0', async () => {
    const h = makeHarness()
    registerEvidenceReviewsIpc(h.ctx)
    const a = seedAnswer(h.db, { content: RELEVANCE.content, citations: RELEVANCE.citations })
    const b = seedAnswer(h.db, { content: 'Other. [S1]', citations: RELEVANCE.citations })

    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, a.conversationId)).result).toBe(0)
    await invoke(handlers, IPC.createEvidenceReview, a.messageId)
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, a.conversationId)).result).toBe(1)
    // Isolation: conversation B still counts zero.
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, b.conversationId)).result).toBe(0)
    // Malformed ids read as "no reviews", matching the surface's unknown-id results.
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, 42)).result).toBe(0)
    expect((await invoke(handlers, IPC.countEvidenceReviewsForConversation, '')).result).toBe(0)
    expect(h.runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])
  })
})

describe('evidence-pack export over IPC (plan §8.3 — the 15th channel)', () => {
  beforeEach(() => {
    ipcState.saveDialog.canceled = true
    ipcState.saveDialog.filePath = undefined
    ipcState.saveDialog.lastOptions = undefined
    ipcState.pdf.loadedPath = undefined
    ipcState.pdf.sourceExistedAtLoad = false
  })

  it('exports a READY review: file written, record returned, exports on the detail, audit ids-only, no model/no network', async () => {
    const h = makeHarness()
    registerEvidenceReviewsIpc(h.ctx)
    const { messageId } = seedAnswer(h.db, {
      content: RELEVANCE.content,
      citations: RELEVANCE.citations,
      coverage: RELEVANCE.coverage
    })
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
    const created = createdRaw as EvidenceReviewDetail
    for (const item of created.items) {
      if (item.blockKind !== 'heading') {
        await invoke(handlers, IPC.updateEvidenceReviewItem, item.id, { decision: 'supported' })
      }
    }
    const { result: readyRaw } = await invoke(handlers, IPC.markEvidenceReviewReady, created.id)
    expect((readyRaw as { review: EvidenceReview }).review.status).toBe('ready')

    // Export the ready review — the ready-state write-guard must NOT block this (P2
    // handoff: verify, don't assume).
    const dest = join(h.root, 'ready-pack.html')
    ipcState.saveDialog.canceled = false
    ipcState.saveDialog.filePath = dest
    const { result: recordRaw } = await invoke(handlers, IPC.exportEvidencePack, created.id, {
      language: 'en'
    })
    const record = recordRaw as EvidenceExportRecord
    expect(record).not.toBeNull()
    expect(record.format).toBe('html')
    expect(record.fileName).toBe('ready-pack.html')
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toContain('Evidence pack')

    // The detail read now carries the export row (the renderer history source).
    const { result: detailRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    const detail = detailRaw as EvidenceReviewDetail
    expect(detail.exports).toHaveLength(1)
    expect(detail.exports[0]!.fileSha256).toBe(record.fileSha256)

    // Audit: exactly {reviewId, format} — never the path, never the title.
    const exported = listAuditEvents(h.db, { limit: 100 }).find(
      (e) => e.type === 'evidence_pack_exported'
    )
    expect(exported?.message).toBe('Evidence pack exported')
    expect(exported?.metadata).toEqual({ reviewId: created.id, format: 'html' })

    expect(h.runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])
  })

  it('cancel → null, no file, no row, no audit event', async () => {
    const h = makeHarness()
    registerEvidenceReviewsIpc(h.ctx)
    const { messageId } = seedAnswer(h.db, {
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
    expect(
      listAuditEvents(h.db, { limit: 100 }).some((e) => e.type === 'evidence_pack_exported')
    ).toBe(false)
    expect(h.runtimeTouched).toEqual([])
  })

  it('FIX-1: a post-rename record failure surfaces as the LOCALIZED distinct error — file removed, no row, no audit event, never null', async () => {
    const h = makeHarness()
    registerEvidenceReviewsIpc(h.ctx)
    const { messageId } = seedAnswer(h.db, {
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
    expect(
      listAuditEvents(h.db, { limit: 100 }).some((e) => e.type === 'evidence_pack_exported')
    ).toBe(false)
    expect(h.runtimeTouched).toEqual([])
  })

  it('guards the boundary: malformed id → null without a dialog; hostile options resolve to defaults', async () => {
    const h = makeHarness()
    registerEvidenceReviewsIpc(h.ctx)
    // Unknown/malformed ids never reach the dialog (canceled=true would return null
    // anyway — assert the null comes back for both shapes).
    expect((await invoke(handlers, IPC.exportEvidencePack, 42, {})).result).toBeNull()
    expect((await invoke(handlers, IPC.exportEvidencePack, '', {})).result).toBeNull()
    expect((await invoke(handlers, IPC.exportEvidencePack, 'no-such-review', {})).result).toBeNull()

    const { messageId } = seedAnswer(h.db, {
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
    const h = makeHarness()
    registerEvidenceReviewsIpc(h.ctx)
    const { messageId } = seedAnswer(h.db, {
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

    // The REAL print harness ran: it loaded the transient `.print.tmp.html` SIBLING of
    // the destination (present on disk at load time), and removed it afterwards.
    expect(ipcState.pdf.loadedPath).toBe(`${dest}.print.tmp.html`)
    expect(ipcState.pdf.sourceExistedAtLoad).toBe(true)
    expect(existsSync(`${dest}.print.tmp.html`)).toBe(false)

    // The destination holds the printer's bytes; the row + audit record 'pdf'.
    expect(new Uint8Array(readFileSync(dest))).toEqual(ipcState.pdf.bytes)
    expect(record.format).toBe('pdf')
    expect(record.fileName).toBe('pack.pdf')
    expect(record.options).not.toHaveProperty('format')
    const exported = listAuditEvents(h.db, { limit: 100 }).find(
      (e) => e.type === 'evidence_pack_exported'
    )
    expect(exported?.metadata).toEqual({ reviewId: created.id, format: 'pdf' })

    // The history read shows the raw stored format (display passthrough).
    const { result: detailRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    expect((detailRaw as EvidenceReviewDetail).exports[0]!.format).toBe('pdf')

    expect(h.runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])
  })

  it('P6: absent or malformed format reads html — HTML filter first, both still offered', async () => {
    const h = makeHarness()
    registerEvidenceReviewsIpc(h.ctx)
    const { messageId } = seedAnswer(h.db, {
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
    expect(h.runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])
  })
})

describe('isReviewEligible (spec §9.1 — the shared entry-point rule)', () => {
  it('assistant + citations, assistant + coverage, or assistant in a documents conversation', () => {
    const citations = [{ label: 'S1', sourceTitle: 'A.pdf' }]
    const coverage: CoverageInfo = { mode: 'tree', chunksCovered: 1, chunksTotal: 1 }
    expect(isReviewEligible({ role: 'assistant', citations })).toBe(true)
    expect(isReviewEligible({ role: 'assistant', coverage })).toBe(true)
    expect(isReviewEligible({ role: 'assistant' }, { mode: 'documents' })).toBe(true)
    // Not eligible: user turns, plain chat answers without document grounding.
    expect(isReviewEligible({ role: 'user', citations })).toBe(false)
    expect(isReviewEligible({ role: 'assistant' })).toBe(false)
    expect(isReviewEligible({ role: 'assistant', citations: [] }, { mode: 'chat' })).toBe(false)
  })
})
