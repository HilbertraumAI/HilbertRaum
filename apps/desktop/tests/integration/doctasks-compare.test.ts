import { describe, it, expect, beforeEach } from 'vitest'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  getDocument,
  getDocumentOrigin,
  listDocuments,
  readStoredDocumentText,
  type IngestionDeps
} from '../../src/main/services/ingestion'
import {
  COMPARE_MAP_CALL_CEILING,
  COMPARE_OUTPUT_TOKENS,
  COMPARE_TEMPERATURE,
  TASK_COMPARE_PICK_TWO_MESSAGE,
  TASK_COMPARE_REINDEX_MESSAGE,
  TASK_DOCUMENT_NOT_READY_MESSAGE,
  compareAttributionLine,
  compareBudgetWords,
  compareTruncationNotice,
  compareRedlineHeading,
  type DocTaskDeps,
  type DocTaskManager
} from '../../src/main/services/doctasks'
import { DIFF_RENDER_MAX } from '../../src/main/services/diff'
import { listAuditEvents } from '../../src/main/services/audit'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Embedder } from '../../src/main/services/embeddings'
import { until } from '../helpers/hang-budget'
import {
  dbAudit,
  docTaskManager,
  docTaskRuntime,
  docTaskWorld,
  importText,
  importWords,
  userPromptOf,
  waitTerminal,
  type DocRuntime,
  type DocRuntimeCall,
  type DocRuntimeOptions,
  type DocTaskStatusOf,
  type DocTaskWorld
} from '../helpers/doctask-fixtures'

// Phase 35 — the compare document task (wave-3 plan §8, decisions D28 + D37):
// two-document validation, the auto mode switch by token math (single-pass full
// compare vs section-matched map/reduce), the D37 segments-not-chunks input, the
// embedder-visibility (staleEmbeddings) guard, deterministic vector pairing, the map
// ceiling + honest truncation notice, report materialization with both-source
// provenance, cancel-persists-nothing, and the ids-only audit events (the materialize
// lease is the shared `materializeDocument`'s, pinned in doctasks-translation.test.ts).
// CI posture: zero model, zero network.

let w: DocTaskWorld
let db: Db
let storeDir: string

beforeEach(() => {
  w = docTaskWorld('doccmp')
  ;({ db, storeDir } = w)
})

const REPORT =
  '## What both documents share\n- A shared point.\n\n## What differs between them\n- A difference.'

/** Canned replies per call shape: pair notes for map calls, the REPORT otherwise. */
const compareReply = (call: DocRuntimeCall): string =>
  userPromptOf(call).includes('section by section') ? '- Same: a note.' : REPORT
const compareRuntime = (o: DocRuntimeOptions = {}): DocRuntime => docTaskRuntime({ reply: compareReply, ...o })
/** Mode (b) needs a small window and an embedder the stored vectors are visible to. */
const MODE_B: Partial<DocTaskDeps> = {
  getContextTokens: () => 1024,
  getIngestionDeps: () => ({ embedder: createMockEmbedder() })
}

async function runCompare(manager: DocTaskManager, a: string, b: string): Promise<DocTaskStatusOf> {
  const { jobId } = manager.startDocTask({ kind: 'compare', documentIds: [a, b] })
  return waitTerminal(manager, jobId)
}

describe('validation (exactly two distinct ready documents)', () => {
  it('refuses one, three, or duplicate document ids with friendly copy', async () => {
    const a = await importWords(w, 50, { name: 'a.txt', prefix: 'alpha' })
    const b = await importWords(w, 50, { name: 'b.txt', prefix: 'beta' })
    const manager = docTaskManager(w, { getRuntime: () => compareRuntime() })
    for (const ids of [[a], [a, b, a], [a, a], []]) {
      expect(() => manager.startDocTask({ kind: 'compare', documentIds: ids })).toThrow(
        TASK_COMPARE_PICK_TWO_MESSAGE
      )
    }
  })

  it('refuses when either document is not ready', async () => {
    const a = await importWords(w, 50, { name: 'a.txt', prefix: 'alpha' })
    const p = join(w.root, 'pending.txt')
    writeFileSync(p, 'hello world', 'utf8')
    const queued = createQueuedDocument(db, p)
    const manager = docTaskManager(w, { getRuntime: () => compareRuntime() })
    expect(() =>
      manager.startDocTask({ kind: 'compare', documentIds: [a, queued.id] })
    ).toThrow(TASK_DOCUMENT_NOT_READY_MESSAGE)
    expect(() => manager.startDocTask({ kind: 'compare', documentIds: [a, 'nope'] })).toThrow(
      TASK_DOCUMENT_NOT_READY_MESSAGE
    )
  })
})

describe('mode (a) — small-docs full compare (D37: re-extracted segments)', () => {
  it('one model call over both FULL texts → a materialized report with both-source provenance', async () => {
    // 600 unique words each: more than one 500-token chunk, so the STORED chunks
    // overlap by ~80 tokens — but the prompt must carry each word exactly ONCE (D37:
    // segments, not chunks). At ctx 4096 the budget is 2526 words, so 1200 total
    // still fits a single pass. No embedder anywhere in this world (import or manager):
    // mode (a) must not need vectors — the guard only mode (b) runs.
    const a = await importWords(w, 600, { name: 'a.txt', prefix: 'alpha' })
    const b = await importWords(w, 600, { name: 'b.txt', prefix: 'beta' })
    const runtime = compareRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime, audit: dbAudit(db) })

    const status = await runCompare(manager, a, b)
    expect(status.state).toBe('done')
    expect(runtime.calls).toHaveLength(1)
    expect(status.progress).toEqual({ stepsDone: 2, stepsTotal: 2 })
    expect(runtime.calls[0].options?.maxTokens).toBe(COMPARE_OUTPUT_TOKENS)
    expect(runtime.calls[0].options?.temperature).toBe(COMPARE_TEMPERATURE)

    // The single prompt carries both documents' full texts — every word exactly once
    // (chunk concatenation would duplicate the ~80-token overlap, e.g. alpha450).
    const prompt = userPromptOf(runtime.calls[0])
    expect(prompt).toContain('Document A ("a.txt")')
    expect(prompt).toContain('Document B ("b.txt")')
    for (const probe of ['alpha450 ', 'alpha0 ', 'beta450 ']) {
      expect(prompt.split(probe)).toHaveLength(2) // exactly one occurrence
    }

    // The result: a NEW indexed document "Comparison: a vs b.md" with attribution,
    // the report body, NO truncation notice, and compare provenance for BOTH ids.
    const newId = status.resultRef?.documentId as string
    expect(newId).toBeTruthy()
    const created = getDocument(db, newId)
    expect(created?.status).toBe('indexed')
    expect(created?.chunkCount).toBeGreaterThan(0)
    expect(created?.title).toBe('Comparison: a vs b.md')
    // Phase D: structured GeneratedProvenance (kind + both source ids, A/B order + model).
    const expectedOrigin = {
      kind: 'compare',
      sourceDocumentIds: [a, b],
      modelId: 'scripted-model',
      createdAt: expect.any(String)
    }
    expect(created?.origin).toEqual(expectedOrigin)
    expect(getDocumentOrigin(db, newId)).toEqual(expectedOrigin)
    const { text } = await readStoredDocumentText(db, storeDir, newId)
    expect(text.startsWith(`> ${compareAttributionLine('scripted-model')}`)).toBe(true)
    expect(text).toContain(REPORT)
    expect(text).not.toContain('covers the beginning')

    // Audit: ids-only completion with BOTH source ids + the import of the report.
    const events = listAuditEvents(db, { limit: 100 })
    const completed = events.find((e) => e.type === 'document_task_completed')
    expect(completed?.metadata).toEqual({ kind: 'compare', documentId: a, documentIdB: b })
    const imported = events.find((e) => e.type === 'document_imported')
    expect(imported?.metadata).toMatchObject({ documentId: newId, status: 'indexed' })

    // No transient survived.
    expect(readdirSync(storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })
})

describe('mode (d) — diff-driven compare (similar version pairs, the what-changed case)', () => {
  it('catches a single deleted word deep in the doc: exact redline + model sees the change list', async () => {
    // A near-identical pair whose ONLY difference is one deleted word (the "tempor" regression):
    // the model-eyeball modes miss it; the deterministic diff cannot.
    const base = Array.from({ length: 300 }, (_, i) => `word${i}`)
    const withWord = base.slice(0, 150).concat(['tempor'], base.slice(150)).join(' ')
    const without = base.join(' ')
    const a = await importText(w, withWord, { name: 'v1.txt' })
    const b = await importText(w, without, { name: 'v2.txt' })
    const rt = compareRuntime()
    const status = await runCompare(docTaskManager(w, { getRuntime: () => rt }), a, b)

    expect(status.state).toBe('done')
    // Exactly ONE model call — to INTERPRET the deterministic change list (not eyeball two walls).
    expect(rt.calls).toHaveLength(1)
    const prompt = userPromptOf(rt.calls[0])
    expect(prompt).toContain('deterministic word-level comparison')
    expect(prompt).toContain('Removed: "tempor"') // the exact change is handed to the model
    // The materialized document leads with the deterministic redline showing the exact deletion.
    const { text } = await readStoredDocumentText(db, storeDir, status.resultRef?.documentId as string)
    expect(text).toContain(compareRedlineHeading())
    expect(text).toContain('~~tempor~~')
    expect(text).not.toContain('covers the beginning')
    expect(text).not.toContain('This change list is PARTIAL') // one change: the full list is shown
  })

  it('identical documents: deterministic "textually identical" report, NO model call', async () => {
    const same = Array.from({ length: 200 }, (_, i) => `same${i}`).join(' ')
    const a = await importText(w, same, { name: 'id1.txt' })
    const b = await importText(w, same, { name: 'id2.txt' })
    const rt = compareRuntime()
    const status = await runCompare(docTaskManager(w, { getRuntime: () => rt }), a, b)

    expect(status.state).toBe('done')
    expect(rt.calls).toHaveLength(0) // the word diff is ground truth — no model needed
    expect(status.progress).toEqual({ stepsDone: 1, stepsTotal: 1 })
    const { text } = await readStoredDocumentText(db, storeDir, status.resultRef?.documentId as string)
    expect(text).toContain('textually identical')
  })

  it('a change list past DIFF_RENDER_MAX materializes the PARTIAL note under the redline heading (SK-2)', async () => {
    // DIFF_RENDER_MAX + 1 one-word changes, three equal words apart: a version pair (changed share ≈ 0.4) whose
    // capped list still fits an 8 k window's per-call budget, so mode (d) runs and its render cap fires.
    const version = (p: string): string =>
      Array.from({ length: DIFF_RENDER_MAX + 1 }, (_, i) => `${p}${i}`).join(' keep keep keep ')
    const a = await importText(w, version('A'), { name: 'v1.txt' })
    const b = await importText(w, version('B'), { name: 'v2.txt' })
    const rt = compareRuntime()
    const status = await runCompare(docTaskManager(w, { getRuntime: () => rt, getContextTokens: () => 8192 }), a, b)
    expect(status.state).toBe('done')
    expect(userPromptOf(rt.calls[0])).toContain('(+1 further change(s) not listed)') // mode (d), capped list
    const { text } = await readStoredDocumentText(db, storeDir, status.resultRef?.documentId as string)
    const heading = text.indexOf(compareRedlineHeading())
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('> **This change list is PARTIAL**')).toBeGreaterThan(heading) // under the heading
  })

  it('a full rewrite (all words differ) falls back to the thematic modes — NOT a giant redline', async () => {
    // 100% different → the diff is abandoned (equal share 0) and the existing single-pass mode runs.
    const a = await importText(w, Array.from({ length: 120 }, (_, i) => `aa${i}`).join(' '), { name: 'r1.txt' })
    const b = await importText(w, Array.from({ length: 120 }, (_, i) => `bb${i}`).join(' '), { name: 'r2.txt' })
    const rt = compareRuntime()
    const status = await runCompare(docTaskManager(w, { getRuntime: () => rt }), a, b)

    expect(status.state).toBe('done')
    const prompt = userPromptOf(rt.calls[0])
    expect(prompt).toContain('Compare document A') // mode (a) fallback, not the diff prompt
    const { text } = await readStoredDocumentText(db, storeDir, status.resultRef?.documentId as string)
    expect(text).not.toContain(compareRedlineHeading())
  })
})

describe('the mode switch (token math boundary)', () => {
  it('exactly at the budget stays single-pass; one word over switches to section-matched', async () => {
    const ctx = 1024
    const budget = compareBudgetWords(ctx) // 200 at the floor
    const embedder = createMockEmbedder()
    const deps = (): IngestionDeps => ({ embedder: createMockEmbedder() })

    // wordsA + wordsB == budget → mode (a): exactly one model call.
    const half = Math.floor(budget / 2)
    const a1 = await importWords(w, half, { name: 'a1.txt', prefix: 'alpha', deps: { embedder } })
    const b1 = await importWords(w, budget - half, { name: 'b1.txt', prefix: 'beta', deps: { embedder } })
    const rt1 = compareRuntime()
    const status1 = await runCompare(
      docTaskManager(w, { getRuntime: () => rt1, getContextTokens: () => ctx, getIngestionDeps: deps }),
      a1,
      b1
    )
    expect(status1.state).toBe('done')
    expect(rt1.calls).toHaveLength(1)
    expect(userPromptOf(rt1.calls[0])).toContain('Compare document A')

    // One word more → mode (b): map call(s) + a reduce.
    const a2 = await importWords(w, half + 1, { name: 'a2.txt', prefix: 'gamma', deps: { embedder } })
    const b2 = await importWords(w, budget - half, { name: 'b2.txt', prefix: 'delta', deps: { embedder } })
    const rt2 = compareRuntime()
    const status2 = await runCompare(
      docTaskManager(w, { getRuntime: () => rt2, getContextTokens: () => ctx, getIngestionDeps: deps }),
      a2,
      b2
    )
    expect(status2.state).toBe('done')
    expect(rt2.calls.length).toBeGreaterThan(1)
    expect(userPromptOf(rt2.calls[0])).toContain('section by section')
    expect(userPromptOf(rt2.calls[rt2.calls.length - 1])).toContain('comparison notes')
  })
})

describe('mode (b) — section-matched compare (vectors + map/reduce)', () => {
  it('pairs each A window with retrieved doc-B excerpts; pairing is deterministic', async () => {
    const embedder = createMockEmbedder()
    const a = await importWords(w, 150, { name: 'a.txt', prefix: 'alpha', deps: { embedder } })
    const b = await importWords(w, 150, { name: 'b.txt', prefix: 'beta', deps: { embedder } })

    const run = async (): Promise<string[]> => {
      const rt = compareRuntime()
      const status = await runCompare(docTaskManager(w, { getRuntime: () => rt, ...MODE_B }), a, b)
      expect(status.state).toBe('done')
      return rt.calls.map(userPromptOf)
    }

    const first = await run()
    const mapPrompts = first.slice(0, -1)
    expect(mapPrompts.length).toBeGreaterThanOrEqual(1)
    for (const p of mapPrompts) {
      // Each map call shows an A window and B excerpts retrieved from doc B only.
      expect(p).toContain('Section of document A:')
      expect(p).toContain('Related excerpts of document B:')
      const bSide = p.slice(p.indexOf('Related excerpts of document B:'))
      expect(bSide).toContain('beta')
      expect(bSide).not.toContain('alpha')
    }
    // The reduce merges the notes into the report shape.
    expect(first[first.length - 1]).toContain('comparison notes')

    // Determinism: a second identical run produces byte-identical prompts
    // (stored-vector pairing — no re-embedding, stable tie-breaks).
    const second = await run()
    expect(second).toEqual(first)
  })

  it('caps the map calls at the ceiling and adds the honest truncation notice', async () => {
    const embedder = createMockEmbedder()
    // ~1640 words of chunk text → far more A windows than the ceiling permits.
    const a = await importWords(w, 1400, { name: 'a.txt', prefix: 'alpha', deps: { embedder } })
    const b = await importWords(w, 150, { name: 'b.txt', prefix: 'beta', deps: { embedder } })
    const rt = compareRuntime()
    const status = await runCompare(docTaskManager(w, { getRuntime: () => rt, ...MODE_B }), a, b)
    expect(status.state).toBe('done')
    expect(rt.calls).toHaveLength(COMPARE_MAP_CALL_CEILING + 1) // capped maps + reduce
    expect(status.progress.stepsTotal).toBe(COMPARE_MAP_CALL_CEILING + 2)
    const { text } = await readStoredDocumentText(db, storeDir, status.resultRef?.documentId as string)
    expect(text).toContain(compareTruncationNotice('a.txt'))
  })

  it('skips a physically truncated stored vector instead of failing the whole compare [DATA-2]', async () => {
    const embedder = createMockEmbedder()
    // ~1200 words each → multiple stored chunks per doc, so truncating ONE vector still leaves
    // valid pairing candidates. Mode (b) decodes BOTH sides' stored vectors (manager.ts compare
    // path), the two call sites DATA-2 flags.
    const a = await importWords(w, 1200, { name: 'a.txt', prefix: 'alpha', deps: { embedder } })
    const b = await importWords(w, 1200, { name: 'b.txt', prefix: 'beta', deps: { embedder } })

    // Physically truncate the FIRST stored vector of each document (a partial write). The
    // `dimensions` column still claims 384, so the dimension guard doesn't catch it — the OLD
    // decodeVector threw a RangeError here and failed the whole compare task. The guard now skips.
    const firstChunk = (documentId: string): string =>
      (
        db
          .prepare(
            `SELECT e.chunk_id AS id FROM embeddings e JOIN chunks c ON e.chunk_id = c.id
             WHERE c.document_id = ? ORDER BY c.chunk_index LIMIT 1`
          )
          .get(documentId) as { id: string }
      ).id
    for (const docId of [a, b]) {
      db.prepare('UPDATE embeddings SET vector_blob = ? WHERE chunk_id = ?').run(
        Buffer.alloc(8), // 8 bytes ≪ 384*4
        firstChunk(docId)
      )
    }

    const status = await runCompare(docTaskManager(w, { getRuntime: () => compareRuntime(), ...MODE_B }), a, b)
    // The corrupt rows were skipped and the compare completed — no thrown RangeError.
    expect(status.state).toBe('done')
    expect(getDocument(db, status.resultRef?.documentId as string)?.status).toBe('indexed')
  })

  it('fails friendly when either document is invisible to the active embedder (stale vectors)', async () => {
    // Vectors exist, but under a LEGACY embedder id — the active (mock) embedder
    // cannot see them, so the pairing would silently come up empty. Fail friendly.
    const legacy: Embedder = {
      id: 'legacy-embedder',
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0, 0]))
    }
    const a = await importWords(w, 150, { name: 'a.txt', prefix: 'alpha', deps: { embedder: legacy } })
    const b = await importWords(w, 150, { name: 'b.txt', prefix: 'beta', deps: { embedder: legacy } })
    const rt = compareRuntime()
    const status = await runCompare(docTaskManager(w, { getRuntime: () => rt, ...MODE_B }), a, b)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_COMPARE_REINDEX_MESSAGE)
    expect(rt.calls).toHaveLength(0) // failed BEFORE any model call
    expect(listDocuments(db)).toHaveLength(2) // nothing materialized

    // Same answer when the documents have no vectors at all.
    const c = await importWords(w, 150, { name: 'c.txt', prefix: 'gamma' })
    const d = await importWords(w, 150, { name: 'd.txt', prefix: 'delta' })
    const status2 = await runCompare(docTaskManager(w, { getRuntime: () => compareRuntime(), ...MODE_B }), c, d)
    expect(status2.state).toBe('failed')
    expect(status2.error).toBe(TASK_COMPARE_REINDEX_MESSAGE)
  })
})

describe('cancellation persists nothing', () => {
  it('cancel mid-compare leaves no output document and no transient files', async () => {
    const a = await importWords(w, 600, { name: 'a.txt', prefix: 'alpha' })
    const b = await importWords(w, 600, { name: 'b.txt', prefix: 'beta' })
    const runtime = compareRuntime({ tokenDelayMs: 5 })
    const manager = docTaskManager(w, { getRuntime: () => runtime })
    const { jobId } = manager.startDocTask({ kind: 'compare', documentIds: [a, b] })
    await until(
      () => manager.getDocTask(jobId).state === 'running' && runtime.calls.length > 0,
      'the compare call started'
    )
    manager.cancelDocTask(jobId)
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    expect(listDocuments(db)).toHaveLength(2) // the two sources only
    expect(readdirSync(storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })
})
