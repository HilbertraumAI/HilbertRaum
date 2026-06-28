import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  getDocument,
  processDocument,
  reconcileStuckExtracts,
  reindexDocument
} from '../../src/main/services/ingestion'
import { DocTaskManager } from '../../src/main/services/doctasks'
import {
  aggregateExtractions,
  extractDocument,
  SCAN_MARKER_TYPE
} from '../../src/main/services/analysis/extract'
import { buildListingAnswer } from '../../src/main/services/analysis/listing-answer'
import { ModelSlotArbiter } from '../../src/main/services/analysis/model-slot-arbiter'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import type { RetrievalScope } from '../../src/shared/types'

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

// Whole-document-analysis Phase 3 (plan §4.2/§6/§7): the per-chunk structured-extract pass +
// the query-time SQL aggregation. Mock runtime — a deterministic JSON-array reply driven by
// `@@token@@` markers in the passage; no model, no network.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-wdx-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

async function importText(text: string, name = 'doc.txt'): Promise<string> {
  const p = join(tmp, name)
  writeFileSync(p, text, 'utf8')
  const info = createQueuedDocument(db, p)
  await processDocument(db, storeDir, info.id)
  return info.id
}

function importWords(words: number, name = 'doc.txt'): Promise<string> {
  const text = Array.from({ length: words }, (_, i) => `word${i}`).join(' ')
  return importText(text, name)
}

interface ScriptedRuntime extends ModelRuntime {
  calls: number
}

/**
 * Mock runtime for the extract pass: replies with a JSON array of `{type:'party', value}` for
 * every `@@token@@` in the passage; `@@BADJSON@@` triggers an unparseable reply (both
 * attempts), exercising the unparsed-marker path (H7).
 */
function extractRuntime(opts: { tokenDelayMs?: number } = {}): ScriptedRuntime {
  const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const tmr = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(tmr)
        resolve()
      })
    })
  const rt: ScriptedRuntime = {
    modelId: 'extract-model',
    calls: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      rt.calls += 1
      const user = messages.find((m) => m.role === 'user')?.content ?? ''
      const at = user.indexOf('Passage:\n')
      const passage = at >= 0 ? user.slice(at + 'Passage:\n'.length) : ''
      let reply: string
      if (passage.includes('@@BADJSON@@')) {
        reply = 'sorry — I have no structured output for you here'
      } else {
        const tokens = [...passage.matchAll(/@@(\w+)@@/g)].map((m) => m[1])
        reply = JSON.stringify(tokens.map((t) => ({ type: 'party', value: t })))
      }
      if (opts.tokenDelayMs) await delay(opts.tokenDelayMs, options?.signal)
      if (options?.signal?.aborted) return
      yield reply
    }
  }
  return rt
}

function makeManager(runtime: ModelRuntime | null, contextTokens = 4096): DocTaskManager {
  return new DocTaskManager({
    getDb: () => db,
    getRuntime: () => runtime,
    isChatStreaming: () => false,
    getContextTokens: () => contextTokens,
    getStoreDir: () => storeDir,
    getIngestionDeps: () => ({}),
    beginDocumentWork: () => () => {}
  })
}

type AnyStatus = ReturnType<DocTaskManager['getDocTask']>
async function waitTerminal(m: DocTaskManager, jobId: string): Promise<AnyStatus> {
  const start = Date.now()
  for (;;) {
    const s = m.getDocTask(jobId)
    if (s.state === 'done' || s.state === 'failed' || s.state === 'cancelled') return s
    if (Date.now() - start > 10_000) throw new Error(`task never finished: ${s.state}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const chunkCount = (id: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(id) as { n: number }).n
const extractStatus = (id: string): string | null =>
  (db.prepare('SELECT extract_status FROM documents WHERE id = ?').get(id) as { extract_status: string | null })
    .extract_status
const recordRows = (id: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM extraction_records WHERE document_id = ?').get(id) as { n: number }).n

// ---- The pass: O(n) calls, scan markers, unparsed accounting -----------------------------

describe('extract pass', () => {
  it('makes O(n) model calls (one per chunk) and marks every chunk scanned', async () => {
    const id = await importWords(2000)
    const n = chunkCount(id)
    expect(n).toBeGreaterThan(1)
    const rt = extractRuntime()
    const m = makeManager(rt)
    const { jobId } = m.startDocTask({ kind: 'extract', documentIds: [id] })
    const s = await waitTerminal(m, jobId)
    expect(s.state).toBe('done')
    expect(rt.calls).toBe(n) // exactly one generate per chunk
    expect(extractStatus(id)).toBe('ready')
    // Every chunk got exactly one __scan__ marker.
    const markers = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM extraction_records WHERE document_id = ? AND record_type = ?`
        )
        .get(id, SCAN_MARKER_TYPE) as { n: number }
    ).n
    expect(markers).toBe(n)
  })

  it('records an unparsed marker (never drops the chunk) when a reply is unparseable [H7]', async () => {
    const id = await importText('Intro text. @@BADJSON@@ trailing text.')
    const rt = extractRuntime()
    const m = makeManager(rt)
    const { jobId } = m.startDocTask({ kind: 'extract', documentIds: [id] })
    expect((await waitTerminal(m, jobId)).state).toBe('done')
    // One retry then an unparsed marker → 2 calls for the one chunk.
    expect(rt.calls).toBe(2)
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'party')
    expect(listing.scannedChunks).toBe(1)
    expect(listing.unparsedChunks).toBe(1)
  })

  it('a warm cache makes a re-run cost 0 model calls (resume/idempotent)', async () => {
    const id = await importWords(1500)
    const rt = extractRuntime()
    const m = makeManager(rt)
    await waitTerminal(m, m.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    const firstCalls = rt.calls
    expect(firstCalls).toBeGreaterThan(0)
    // Second pass over the unchanged chunks: every chunk is cached via its __scan__ marker.
    await waitTerminal(m, m.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(rt.calls).toBe(firstCalls) // no additional generate calls
    expect(extractStatus(id)).toBe('ready')
  })

  it('rolls back on an injected insert failure; the shared connection is not poisoned [H11]', async () => {
    const id = await importText('Body with @@alice@@ and @@bob@@.')
    let failOnce = true
    const wrapped = {
      prepare(sql: string) {
        const stmt = db.prepare(sql)
        if (failOnce && sql.includes('INSERT INTO extraction_records')) {
          return {
            run: () => {
              failOnce = false
              throw new Error('SQLITE_IOERR: injected extraction insert failure')
            }
          }
        }
        return stmt
      },
      exec: (sql: string) => db.exec(sql)
    } as unknown as Db

    await expect(
      extractDocument(id, {
        db: wrapped,
        modelId: 'm',
        signal: new AbortController().signal,
        arbiter: new ModelSlotArbiter(),
        jobId: 'job-x-h11',
        generate: async () => '[{"type":"party","value":"alice"}]'
      })
    ).rejects.toThrow(/injected extraction insert/)

    // The connection is usable: a fresh transaction starts cleanly (no dangling BEGIN).
    expect(() => {
      db.exec('BEGIN')
      db.exec('COMMIT')
    }).not.toThrow()
    // Left resumable: still 'extracting', not finalized to 'ready'.
    expect(extractStatus(id)).toBe('extracting')
    expect(reconcileStuckExtracts(db, new Date(Date.now() + 1000).toISOString())).toBe(1)
    expect(extractStatus(id)).toBe('pending')
  })
})

// ---- Aggregation: GROUP BY via buildScopeFilter, 0 model calls ---------------------------

describe('aggregateExtractions', () => {
  async function extractOf(id: string): Promise<void> {
    const m = makeManager(extractRuntime())
    await waitTerminal(m, m.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
  }

  it('GROUPs by normalized_value with counts + provenance, matching a planted ground-truth', async () => {
    const id = await importText('Pay @@alice@@ then @@bob@@. Later @@alice@@ signs again.')
    await extractOf(id)
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'party')
    const byValue = new Map(listing.items.map((i) => [i.value, i]))
    expect([...byValue.keys()].sort()).toEqual(['alice', 'bob'])
    expect(byValue.get('alice')!.count).toBe(2) // planted twice
    expect(byValue.get('bob')!.count).toBe(1)
    expect(byValue.get('alice')!.sourceChunkIds.length).toBeGreaterThan(0) // per-item provenance
    expect(listing.scannedChunks).toBe(1)
    expect(listing.unparsedChunks).toBe(0)
    expect(listing.fullyChunked).toBe(true)
  })

  it('aggregation is read-only — it makes ZERO model calls', async () => {
    const id = await importText('@@alice@@ and @@bob@@.')
    const rt = extractRuntime()
    const m = makeManager(rt)
    await waitTerminal(m, m.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    const before = rt.calls
    aggregateExtractions(db, { documentIds: [id] }, 'party')
    aggregateExtractions(db, { documentIds: [id] }, 'date')
    expect(rt.calls).toBe(before)
  })

  it('excludes an archived in-scope document [M3]', async () => {
    const a = await importText('@@alice@@ only in A.', 'a.txt')
    const b = await importText('@@zach@@ only in B.', 'b.txt')
    const m = makeManager(extractRuntime())
    await waitTerminal(m, m.startDocTask({ kind: 'extract', documentIds: [a] }).jobId)
    await waitTerminal(m, m.startDocTask({ kind: 'extract', documentIds: [b] }).jobId)
    db.prepare("UPDATE documents SET lifecycle = 'archived' WHERE id = ?").run(b)

    const scope: RetrievalScope = { documentIds: [a, b] } // includeArchived defaults false
    const listing = aggregateExtractions(db, scope, 'party')
    const values = listing.items.map((i) => i.value)
    expect(values).toContain('alice')
    expect(values).not.toContain('zach') // archived B excluded
  })

  it('the listing answer is honest — "sections scanned" + caveat, never bare "complete" [H7]', async () => {
    const id = await importText('Pay @@alice@@ then @@bob@@ once.')
    await extractOf(id)
    const answer = buildListingAnswer(db, aggregateExtractions(db, { documentIds: [id] }, 'party'), tr)
    expect(answer).toMatch(/sections scanned/)
    expect(answer).toMatch(/not guaranteed complete/)
    expect(answer).toMatch(/alice/)
    expect(answer).toMatch(/bob/)
  })

  it('a multi-doc scope with extraction on only ONE doc says "sections scanned", NOT "whole document" [RAG-1]', async () => {
    // Two indexed, fully-chunked documents, but extraction ran on only A. `fullyChunked` is
    // true (neither doc is missing the marker), yet only A's chunks carry a `__scan__` marker
    // → scannedChunks < totalChunks. The over-claim the H7 invariant forbids is "across the
    // whole document"; the honest wording is "across N sections scanned".
    const a = await importText('Pay @@alice@@ and @@bob@@.', 'a.txt')
    const b = await importText('Some unrelated text with no tokens to extract.', 'b.txt')
    await extractOf(a) // NOT b

    const listing = aggregateExtractions(db, { documentIds: [a, b] }, 'party')
    expect(listing.items.length).toBeGreaterThan(0) // alice/bob, so we hit the coverage branch
    expect(listing.fullyChunked).toBe(true) // both docs are fully chunked (the chunking invariant)
    expect(listing.scannedChunks).toBeLessThan(listing.totalChunks) // but B was never scanned

    const answer = buildListingAnswer(db, listing, tr)
    expect(answer).not.toMatch(/whole document/) // RAG-1: no over-claim
    expect(answer).toMatch(/sections scanned/) // honest coverage wording

    // The single-document fully-extracted scope is unchanged: it DOES say "whole document".
    const soloAnswer = buildListingAnswer(db, aggregateExtractions(db, { documentIds: [a] }, 'party'), tr)
    expect(soloAnswer).toMatch(/whole document/)
  })

  it('an unparsed section is surfaced in the listing answer, never silently dropped [H7]', async () => {
    const id = await importText('@@BADJSON@@')
    await extractOf(id)
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'party')
    expect(listing.unparsedChunks).toBe(1)
    const answer = buildListingAnswer(db, listing, tr)
    expect(answer).toMatch(/sections scanned/)
    expect(answer).toMatch(/could not be read/)
  })

  it('re-index cascades away the old rows [H1] and marks the pass stale', async () => {
    const id = await importText('@@alice@@ and @@bob@@.')
    await extractOf(id)
    expect(recordRows(id)).toBeGreaterThan(0)
    expect(extractStatus(id)).toBe('ready')

    await reindexDocument(db, storeDir, id)
    expect(recordRows(id)).toBe(0) // extraction rows cascaded via chunk_id ON DELETE CASCADE
    expect(extractStatus(id)).toBe('stale')
    expect(getDocument(db, id)?.status).toBe('indexed')
  })
})
