import { describe, it, expect, vi, beforeEach } from 'vitest'

// #643 / #642 — the ONE in-scope document a top-k-bound document question reads WHOLE instead
// (`registerRagIpc`'s `wholeReadDocumentId`), driven through the real `askDocuments` handler over real
// ingested documents. Top-k keeps at most `ragTopKFinal` (6) sections within a 2,500-token budget and only
// the best section per PDF page, so even a short document could reach the prompt incomplete. A document
// that fits the launched window's whole-document budget is now read in order; a summary ask over one
// document too large for that, with a ready deep index, is answered from the tree (#642). The coverage
// stamp itself (`capped` + `labelledExcerpts`) is owned by `rag-relevance-coverage.test.ts`.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  app: { getVersion: () => '0.0.0-test' }
}))

import { IPC } from '../../src/shared/ipc'
import type { Message } from '../../src/shared/types'
import type { Db } from '../../src/main/services/db'
import { createConversation } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { t } from '../../src/shared/i18n'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { recordingRuntime, type RecordingRuntime } from '../helpers/scripted-runtime'
import { ingestTextFile, makeRagAskContext, makeSkillsWorld } from '../helpers/skills-world'
import { documentApproxTokenTotal, wholeDocumentFitBudgetTokens } from '../../src/main/services/rag'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** `lines` statement rows of ~5 tokens each under an "Abrechnung" header; 110 rows make two sections. */
const statement = (lines: number): string =>
  [
    'Abrechnung Ausgaben EUR',
    ...Array.from({ length: lines }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')} Ausgaben Miete -800,00 1.200,00`)
  ].join('\n')

/** More than top-k's six sections, but inside a 16k window's whole-document budget (not a 4k one's). */
const EIGHT_SECTIONS = statement(700)

interface Harness {
  db: Db
  conversationId: string
  docId: string
  chunkIds: string[]
  runtime: RecordingRuntime
}

async function makeHarness(o: {
  text: string
  /** Ingested as this file name (default `abrechnung.txt`); a `.md` gives one section per heading. */
  fileName?: string
  contextWindow: number
  packIds?: string[]
  /** A second scoped document mid re-index: `processing`, its old deep index still `ready` (until the
   *  chunk transaction marks it stale), so the router sees a ready tree no answerable document has. */
  reindexingTreeDoc?: boolean
}): Promise<Harness> {
  const w = makeSkillsWorld('wholeread')
  const docId = await ingestTextFile(w, o.fileName ?? 'abrechnung.txt', o.text)
  const documentIds = [docId]
  if (o.reindexingTreeDoc) {
    const other = await ingestTextFile(w, 'notiz.txt', statement(20))
    w.db.prepare("UPDATE documents SET status = 'processing', tree_status = 'ready' WHERE id = ?").run(other)
    documentIds.push(other)
  }
  const runtime = recordingRuntime('Model answer.', { contextWindow: o.contextWindow })
  registerRagIpc(makeRagAskContext(w, runtime).ctx)
  const conv = createConversation(w.db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds, ...(o.packIds ? { packIds: o.packIds } : {}) }
  })
  const chunkIds = (
    w.db.prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index').all(docId) as Array<{ id: string }>
  ).map((r) => r.id)
  return { db: w.db, conversationId: conv.id, docId, chunkIds, runtime }
}

async function ask(h: Harness, question: string): Promise<Message> {
  const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, question, null)
  return result as Message
}

/** A ready single-level deep index: one root summary over every section (the tree map-reduce material).
 *  `usable: false` leaves the root summary empty: the status says ready, but the tree has nothing to read. */
function seedReadyTree(h: Harness, usable = true): void {
  const now = new Date().toISOString()
  h.db
    .prepare(
      `INSERT INTO tree_nodes
         (id, document_id, scope_key, level, ordinal, parent_id, is_root, summary_text,
          embedding_blob, dimensions, embedding_model_id, content_hash, model_id, created_at)
       VALUES (?, ?, NULL, 1, 0, NULL, 1, ?, NULL, NULL, NULL, ?, 'mock', ?)`
    )
    .run('root-1', h.docId, usable ? 'Summary: monthly rent payments of 800 EUR.' : ' ', 'hash-root-1', now)
  const edge = h.db.prepare('INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, 1, ?)')
  h.chunkIds.forEach((id, i) => edge.run('root-1', id, i))
  h.db.prepare("UPDATE documents SET tree_status = 'ready' WHERE id = ?").run(h.docId)
}

beforeEach(() => {
  inFlightStreams.clear()
})

describe('askDocuments — one document that fits is read whole (#643)', () => {
  it.each([
    { contextWindow: 16384, read: 'whole' },
    { contextWindow: 4096, read: 'top-k' }
  ])('a document of more than six sections at a $contextWindow-token window is read $read', async ({ contextWindow, read }) => {
    const h = await makeHarness({ text: EIGHT_SECTIONS, contextWindow })
    // The premise: more sections than top-k can ever keep.
    expect(h.chunkIds.length).toBeGreaterThan(6)

    const msg = await ask(h, 'Wie hoch ist die Miete?')
    expect(h.runtime.calls).toBe(1)
    if (read === 'whole') {
      // Every section, in document order, under its [Sn] label — in the prompt and in the citations.
      expect(msg.coverage).toMatchObject({ mode: 'capped', truncated: false, chunksCovered: h.chunkIds.length })
      expect(msg.citations!.map((c) => c.chunkId)).toEqual(h.chunkIds)
      const prompt = h.runtime.lastMessages[h.runtime.lastMessages.length - 1].content
      expect(prompt).toContain(`[S${h.chunkIds.length}]`)
    } else {
      // The same document overflows a 4k window's budget: top-k, as before.
      expect(msg.coverage?.mode).toBe('relevance')
      expect(msg.coverage!.chunksCovered).toBeLessThan(h.chunkIds.length)
    }
  })

  // The issue's comment: top-k keeps the best section per PDF page, so a two-page document of three
  // sections can never reach the prompt whole, and #641's heads-up then (truly) says items may be missing.
  it('a two-page document of three sections reaches the prompt whole, so no heads-up is shown', async () => {
    const h = await makeHarness({ text: statement(250), contextWindow: 8192 })
    expect(h.chunkIds.length).toBe(3)
    const page = h.db.prepare('UPDATE chunks SET page_number = ? WHERE id = ?')
    ;[1, 1, 2].forEach((p, i) => page.run(p, h.chunkIds[i]))

    // A typed count ask with no deep index: the router's low-confidence `coverage` fallback.
    const msg = await ask(h, 'Zähle die Ausgaben')
    expect(msg.coverage).toMatchObject({ mode: 'capped', chunksCovered: 3, chunksTotal: 3 })
    expect(msg.content).not.toContain(t('en', 'analysis.wholeDocHint'))
    expect(msg.content.startsWith('Model answer.')).toBe(true)
  })

  // Every section also costs its `[Sn] File: …` line in the prompt. Thirty one-line slides: their text
  // alone (240 units) fits a 2,048 window's 512-unit budget, the text plus 30 × 32 units of framing does not.
  it.each([
    { contextWindow: 2048, mode: 'relevance' },
    { contextWindow: 4096, mode: 'capped' }
  ])('thirty short sections at a $contextWindow-token window: their framing counts too ($mode)', async ({ contextWindow, mode }) => {
    const slides = Array.from({ length: 30 }, (_, i) => `# Folie ${i + 1}\n\nMiete Abschnitt ${i + 1}.`).join('\n\n')
    const h = await makeHarness({ text: slides, fileName: 'folien.md', contextWindow })
    expect(h.chunkIds.length).toBe(30)
    const question = 'Wie hoch ist die Miete?'
    // The premise: the text alone fits even the smaller window's budget.
    expect(documentApproxTokenTotal(h.db, h.docId)).toBeLessThanOrEqual(wholeDocumentFitBudgetTokens(2048, question, null))
    const msg = await ask(h, question)
    expect(msg.coverage?.mode).toBe(mode)
  })

  it.each([
    // The whole read never queries a knowledge pack; a pack chat keeps the retrieval that does.
    { name: 'a chat with knowledge packs', question: 'Wie hoch ist die Miete?', packIds: ['pack-1'], calls: 1, mode: 'relevance' },
    // Small talk keeps top-k, which answers it without a model call when nothing matches.
    { name: 'small talk', question: 'thanks!', packIds: undefined, calls: 0, mode: undefined }
  ])('$name stays top-k over a document that fits', async ({ question, packIds, calls, mode }) => {
    const h = await makeHarness({ text: statement(110), contextWindow: 8192, packIds })
    const msg = await ask(h, question)
    expect(h.runtime.calls).toBe(calls)
    expect(msg.coverage?.mode).toBe(mode)
  })
})

describe('askDocuments — a summary ask with a ready deep index reads the tree (#642)', () => {
  it.each([
    { name: 'too large to read whole, ready deep index → the tree', contextWindow: 4096, tree: true, mode: 'tree' },
    { name: 'too large to read whole, no deep index → top-k', contextWindow: 4096, tree: false, mode: 'relevance' },
    // `answerWholeDocFromTree` would decline it, and the whole path would then map-reduce the chunks.
    { name: 'too large, a ready deep index without a usable summary → top-k', contextWindow: 4096, tree: 'empty', mode: 'relevance' },
    { name: 'fits, ready deep index → the whole document, not the tree', contextWindow: 16384, tree: true, mode: 'capped' },
    // The ready tree belongs to the other document, which is being re-indexed: this one has none, so
    // the whole-document path would run an unasked-for chunk map-reduce over it.
    { name: "too large, another document's deep index → top-k", contextWindow: 4096, tree: false, mode: 'relevance', reindexingTreeDoc: true }
  ])('$name', async ({ contextWindow, tree, mode, reindexingTreeDoc }) => {
    const h = await makeHarness({ text: EIGHT_SECTIONS, contextWindow, reindexingTreeDoc })
    if (tree) seedReadyTree(h, tree !== 'empty')

    const msg = await ask(h, 'Fasse die Abrechnung zusammen')
    expect(msg.coverage?.mode).toBe(mode)
    // One model call each: the tree material fits one reduce window; never a chunk map-reduce.
    expect(h.runtime.calls).toBe(1)
    if (mode === 'tree') {
      expect(msg.coverage).toMatchObject({ treeStatus: 'ready', chunksCovered: h.chunkIds.length, truncated: false })
      const prompt = h.runtime.lastMessages[h.runtime.lastMessages.length - 1].content
      expect(prompt).toContain('monthly rent payments of 800 EUR')
    }
  })
})
