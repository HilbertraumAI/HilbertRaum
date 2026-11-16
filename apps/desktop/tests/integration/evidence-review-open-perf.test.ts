import { describe, it, expect, vi, beforeEach } from 'vitest'

// EP-1 P5 — the spec §26 performance pass, as a REGRESSION TRIPWIRE, not a benchmark:
//   (a) opening a review must not start ANY model runtime/sidecar — the runtime and the
//       embedder are tripwires that record and throw on every touch, and the REAL offline
//       connect-guard is installed across the whole flow and asserted silent after it;
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

const ipcState = vi.hoisted(() => ({ handlers: new Map() as IpcHandlers }))
vi.mock('electron', async () => ({
  ipcMain: (await import('../helpers/ipc')).fakeIpcMain(ipcState.handlers),
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true, filePath: undefined }) }
}))

import { registerEvidenceReviewsIpc } from '../../src/main/ipc/registerEvidenceReviewsIpc'
import { IPC } from '../../src/shared/ipc'
import type {
  Citation,
  EvidenceReviewDetail,
  EvidenceReviewFreshness
} from '../../src/shared/types'
import { freshWorkspaceDb } from '../helpers/db-fixtures'
import {
  evidenceIpcContext,
  seedAssistantAnswer,
  seedSourceDocument,
  useOfflineGuard
} from '../helpers/evidence-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers

/** How many sources the perf review carries — ABOVE the spec §26 24-card norm. */
const SOURCE_COUNT = 30

useOfflineGuard()
beforeEach(() => {
  ipcState.handlers.clear()
})

describe('evidence-review open performance (spec §26, plan §10)', () => {
  it(`opens a ${SOURCE_COUNT}-source review with zero runtime touches, offline guard silent, well inside the §26 budget`, async () => {
    const { db, root } = freshWorkspaceDb('epperf')
    const { ctx, runtimeTouched } = evidenceIpcContext(db, root)
    registerEvidenceReviewsIpc(ctx)

    // Seed SOURCE_COUNT resolvable documents + one answer citing every one of them.
    const citations: Citation[] = []
    const paragraphs: string[] = []
    for (let i = 1; i <= SOURCE_COUNT; i++) {
      const docId = seedSourceDocument(db, { title: `doc-${i}.pdf`, sha256: String(i).padStart(2, '0').repeat(32) })
      citations.push({
        label: `S${i}`,
        sourceTitle: `doc-${i}.pdf`,
        documentId: docId,
        snippet: `Persisted snippet ${i} — long enough to resemble a real excerpt.`
      } as Citation)
      paragraphs.push(`Claim number ${i} rests on its own source. [S${i}]`)
    }
    const { messageId } = seedAssistantAnswer(db, {
      content: paragraphs.join('\n\n'),
      citations,
      coverage: { mode: 'relevance', chunksCovered: SOURCE_COUNT, chunksTotal: SOURCE_COUNT * 2 }
    })

    // Creation (spec §26 "review creation should use persisted message and source data") —
    // timed for the record; the assert below covers the OPEN path the norm names.
    const tCreate = performance.now()
    const { result: createdRaw } = await invoke(handlers, IPC.createEvidenceReview, messageId)
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

    // (a) No sidecar/model start — the FR-2/FR-12 hard rule, tripwire-proven (the offline
    // guard is asserted silent after the test by `useOfflineGuard`).
    expect(runtimeTouched).toEqual([])

    // (b) The §26 wall-clock budget (≤1 s with 24 cards on the target laptop) as an
    // order-of-magnitude tripwire: measured single-digit ms here — see the header note.
    expect(openMs).toBeLessThan(1000)

    // The recorded measurement (design-guidelines §11.13 carries the numbers from this run).
    console.info(
      `[evidence-review-open-perf] sources=${SOURCE_COUNT} create=${createMs.toFixed(1)}ms open=${openMs.toFixed(1)}ms`
    )
  })
})
