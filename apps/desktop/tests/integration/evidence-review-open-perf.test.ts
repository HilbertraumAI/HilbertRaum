import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installOfflineNetworkGuard } from '../../src/main/services/offlineGuard'

// EP-1 P5 — the spec §26 performance pass, as a REGRESSION TRIPWIRE, not a benchmark:
//   (a) opening a review must not start ANY model runtime/sidecar — the runtime and the
//       embedder are tripwires that record (and, for start, throw on) every touch, and the
//       REAL offline connect-guard is installed across the whole flow;
//   (b) a review with MORE than the spec's 24-source norm opens through the real IPC
//       handlers by awaiting the same two calls the renderer's open path makes
//       (evidence:get + evidence:refreshState) — no fixed sleeps anywhere, the gate is the
//       resolved read-model itself. The wall-clock assert is deliberately the spec's own
//       ≤1 s figure: the open is a handful of SQLite reads measured in single-digit
//       milliseconds here, so 1 000 ms is a ~100× order-of-magnitude guard, far above CI
//       jitter and far below "someone added a model call / a table scan per source".
// The matching renderer-side bound (mounted evidence cards never exceed the
// PROVENANCE_CARD_CAP batch) is pinned in tests/renderer/ReviewEvidencePane.test.tsx —
// together they are the plan-§10 "measure BEFORE virtualizing" record: the cap+reveal
// keeps both the data read and the DOM bounded, so @tanstack/react-virtual stays out.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true, filePath: undefined }) }
}))

import { randomUUID } from 'node:crypto'
import { registerEvidenceReviewsIpc } from '../../src/main/ipc/registerEvidenceReviewsIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createAuditRecorder } from '../../src/main/services/audit'
import type { AppContext } from '../../src/main/services/context'
import type {
  Citation,
  EvidenceReviewDetail,
  EvidenceReviewFreshness
} from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** How many sources the perf review carries — ABOVE the spec §26 24-card norm. */
const SOURCE_COUNT = 30

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

function makeHarness(): { ctx: AppContext; db: Db; runtimeTouched: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-epperf-'))
  const db = openDatabase(join(root, 'test.sqlite'))
  const runtimeTouched: string[] = []
  const ctx = {
    db,
    paths: { workspacePath: root, rootPath: root, configPath: join(root, 'config.json') },
    workspace: { isUnlocked: () => true },
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
  return { ctx, db, runtimeTouched }
}

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

describe('evidence-review open performance (spec §26, plan §10)', () => {
  it(`opens a ${SOURCE_COUNT}-source review with zero runtime touches, offline guard silent, well inside the §26 budget`, async () => {
    const { ctx, db, runtimeTouched } = makeHarness()
    registerEvidenceReviewsIpc(ctx)

    // Seed SOURCE_COUNT resolvable documents + one answer citing every one of them.
    const now = new Date().toISOString()
    const citations: Citation[] = []
    const paragraphs: string[] = []
    for (let i = 1; i <= SOURCE_COUNT; i++) {
      const docId = randomUUID()
      db.prepare(
        `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
         VALUES (?, ?, 'application/pdf', ?, 'indexed', ?, ?)`
      ).run(docId, `doc-${i}.pdf`, String(i).padStart(2, '0').repeat(32), now, now)
      citations.push({
        label: `S${i}`,
        sourceTitle: `doc-${i}.pdf`,
        documentId: docId,
        snippet: `Persisted snippet ${i} — long enough to resemble a real excerpt.`
      } as Citation)
      paragraphs.push(`Claim number ${i} rests on its own source. [S${i}]`)
    }
    const conv = createConversation(db, { title: 'Perf review chat', modelId: 'm1' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Big question?' })
    const msg = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: paragraphs.join('\n\n'),
      citations,
      coverage: { mode: 'relevance', chunksCovered: SOURCE_COUNT, chunksTotal: SOURCE_COUNT * 2 }
    })

    // Creation (spec §26 "review creation should use persisted message and source data") —
    // timed for the record; the assert below covers the OPEN path the norm names.
    const tCreate = performance.now()
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, msg.id)
    const createMs = performance.now() - tCreate
    const created = createdRaw as EvidenceReviewDetail
    expect(created.sources).toHaveLength(SOURCE_COUNT)
    expect(created.items.length).toBeGreaterThanOrEqual(SOURCE_COUNT)

    // THE OPEN PATH — exactly the two calls the renderer's openReviewSession makes:
    // the detail read it awaits, plus the freshness check it fires. No sleeps; the gate
    // is the resolved read-model.
    const tOpen = performance.now()
    const { result: openedRaw } = await invoke(handlers, IPC.getEvidenceReview, created.id)
    const { result: freshRaw } = await invoke(handlers, IPC.refreshEvidenceReviewState, created.id)
    const openMs = performance.now() - tOpen

    const opened = openedRaw as EvidenceReviewDetail
    expect(opened.id).toBe(created.id)
    expect(opened.sources).toHaveLength(SOURCE_COUNT)
    expect((freshRaw as EvidenceReviewFreshness).outdated).toBe(false)
    expect((freshRaw as EvidenceReviewFreshness).sources).toHaveLength(SOURCE_COUNT)

    // (a) No sidecar/model start — the FR-2/FR-12 hard rule, tripwire-proven.
    expect(runtimeTouched).toEqual([])
    expect(offlineViolations).toEqual([])

    // (b) The §26 wall-clock budget (≤1 s with 24 cards on the target laptop) as an
    // order-of-magnitude tripwire: measured single-digit ms here — see the header note.
    expect(openMs).toBeLessThan(1000)

    // The recorded measurement (design-guidelines §11.13 carries the numbers from this run).
    console.info(
      `[evidence-review-open-perf] sources=${SOURCE_COUNT} create=${createMs.toFixed(1)}ms open=${openMs.toFixed(1)}ms`
    )
  })
})
