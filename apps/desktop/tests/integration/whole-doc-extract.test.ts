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
    getTranslator: () => null,
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

  it('re-extract is idempotent per chunk — the __scan__ marker count never doubles [DATA-3]', async () => {
    const id = await importWords(1500)
    const n = chunkCount(id)
    expect(n).toBeGreaterThan(1)
    const markerCount = (): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM extraction_records WHERE document_id = ? AND record_type = ?`
          )
          .get(id, SCAN_MARKER_TYPE) as { n: number }
      ).n

    // First pass: exactly one __scan__ marker per chunk.
    const m1 = makeManager(extractRuntime())
    await waitTerminal(m1, m1.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(markerCount()).toBe(n)

    // Second pass over the unchanged document: every chunk is a cache hit (matching marker) → it is
    // SKIPPED, so no new markers are written. The audit's concern — markers doubling per generation.
    const m2 = makeManager(extractRuntime())
    await waitTerminal(m2, m2.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(markerCount()).toBe(n) // still one per chunk, NOT 2n

    // Force the COMMIT path (not the cache skip): mutate one chunk's text so its content hash changes
    // → the next pass MISSES the cache and re-commits that chunk. commitChunk deletes the chunk's
    // prior rows before inserting, so its marker is REPLACED, never accumulated.
    const firstChunk = db
      .prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 1')
      .get(id) as { id: string }
    db.prepare('UPDATE chunks SET text = ? WHERE id = ?').run(
      'Totally different chunk text for re-extraction.',
      firstChunk.id
    )
    const m3 = makeManager(extractRuntime())
    await waitTerminal(m3, m3.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(markerCount()).toBe(n) // the re-commit replaced the chunk's marker — no doubling
  })

  it('escalates the retry token cap so a reasoning model that burns the first budget still extracts [#50]', async () => {
    // A reasoning model can spend the whole 384-token budget on reasoning_content: the
    // manager's generate discards reasoning deltas, so attempt 1 collapses to ''. The retry
    // must raise the cap — at temperature 0 an identical retry is byte-identical.
    const id = await importText('Payment of € 12,90 to @@acme@@ on 2026-01-01.')
    const budgets: Array<number | undefined> = []
    const rt: ScriptedRuntime = {
      ...extractRuntime(),
      calls: 0,
      async *chatStream(_messages: ChatMessage[], options?: RuntimeChatOptions) {
        rt.calls += 1
        budgets.push(options?.maxTokens)
        // All reasoning, no content at the small cap; room to answer at the escalated cap.
        if ((options?.maxTokens ?? 0) <= 384) return
        yield '[{"type":"party","value":"acme"}]'
      }
    }
    const m = makeManager(rt)
    expect((await waitTerminal(m, m.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)).state).toBe('done')
    expect(rt.calls).toBe(2)
    expect(budgets[0]).toBe(384)
    expect(budgets[1]).toBeGreaterThan(384) // the escalated retry cap
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'party')
    expect(listing.unparsedChunks).toBe(0) // the chunk parsed on the escalated attempt
    expect(listing.items.map((i) => i.value)).toContain('acme')
  })

  // F-01 (audit 2026-07-16): the scan cache was content-keyed ONLY — after a chat-model swap an
  // explicit re-run hit every old-model `ok` marker (0 calls) and flipped extract_status to
  // 'ready' without re-extracting, so listings permanently served the weakest model that ever
  // scanned the document. The markerExists lookup is now ALSO keyed by the current pass's
  // model_id (the sibling tree cache's M12 posture); commitChunk's delete-then-insert makes the
  // replacement clean. The hash itself stays model-free (analysis-extract-hash.test.ts pins it
  // byte-identical; persisted rows must stay addressable).
  it('a model swap invalidates the scan cache — an explicit re-run under a different model re-extracts (F-01)', async () => {
    const id = await importText('Payment to @@acme@@ and @@globex@@.')
    // Pass 1 under model A ('extract-model'): the chunk scans ok.
    const modelA = extractRuntime()
    const mA = makeManager(modelA)
    await waitTerminal(mA, mA.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(modelA.calls).toBe(1)
    const modelIds = (): string[] =>
      (
        db
          .prepare('SELECT DISTINCT model_id AS m FROM extraction_records WHERE document_id = ?')
          .all(id) as unknown as Array<{ m: string }>
      ).map((r) => r.m)
    expect(modelIds()).toEqual(['extract-model'])

    // Pass 2 under model B: the old-model ok marker must be a cache MISS — the chunk is
    // re-extracted and its rows now carry model B (replaced, never mixed). Same object as the
    // factory returns (its chatStream closes over itself for `calls`), only the id differs.
    const modelB = extractRuntime()
    ;(modelB as { modelId: string }).modelId = 'stronger-model'
    const mB = makeManager(modelB)
    await waitTerminal(mB, mB.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(modelB.calls).toBe(1) // generate ran again under the new model
    expect(modelIds()).toEqual(['stronger-model']) // rows replaced — no mixed-model set
    expect(extractStatus(id)).toBe('ready')
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'party')
    expect(listing.items.map((i) => i.value).sort()).toEqual(['acme', 'globex'])

    // Same-model re-run stays a warm cache — the #50 economy holds (0 further calls).
    const mB2 = makeManager(modelB)
    await waitTerminal(mB2, mB2.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(modelB.calls).toBe(1)
  })

  it('an unparsed marker is NOT a cache hit — the next run retries the chunk [#50]', async () => {
    const id = await importText('Once-broken chunk. @@BADJSON@@')
    // Run 1: unparseable both attempts → unparsed marker (the poisoned state of #50).
    const bad = extractRuntime()
    const m1 = makeManager(bad)
    await waitTerminal(m1, m1.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(aggregateExtractions(db, { documentIds: [id] }, 'party').unparsedChunks).toBe(1)

    // Run 2 (e.g. after switching to a better model): the unparsed chunk is RETRIED, not
    // skipped, and its marker is REPLACED by an ok scan with the extracted items.
    const good: ScriptedRuntime = {
      ...extractRuntime(),
      calls: 0,
      async *chatStream() {
        good.calls += 1
        yield '[{"type":"party","value":"alice"}]'
      }
    }
    const m2 = makeManager(good)
    await waitTerminal(m2, m2.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(good.calls).toBe(1) // the unparsed chunk was a cache MISS
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'party')
    expect(listing.unparsedChunks).toBe(0) // marker replaced, never doubled
    expect(listing.scannedChunks).toBe(1)
    expect(listing.items.map((i) => i.value)).toContain('alice')

    // Run 3 over the now-ok chunk: back to a warm cache, 0 calls.
    const m3 = makeManager(good)
    await waitTerminal(m3, m3.startDocTask({ kind: 'extract', documentIds: [id] }).jobId)
    expect(good.calls).toBe(1)
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

  it('an EMPTY listing dominated by unreadable sections carries the retry hint (+ skill hint for amounts) [#50]', async () => {
    const id = await importText('@@BADJSON@@')
    await extractOf(id)
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'amount')
    expect(listing.items.length).toBe(0)
    expect(listing.unparsedChunks).toBe(1)
    const answer = buildListingAnswer(db, listing, tr)
    expect(answer).toMatch(/Build deep index/) // points at the retry (unparsed is retryable now)
    expect(answer).toMatch(/bank-statement skill/) // amounts → the exact-extraction skill
    // A non-amount kind gets the retry hint but no bank-statement pointer.
    const partyAnswer = buildListingAnswer(db, aggregateExtractions(db, { documentIds: [id] }, 'party'), tr)
    expect(partyAnswer).toMatch(/Build deep index/)
    expect(partyAnswer).not.toMatch(/bank-statement skill/)
  })

  it('an empty listing over READABLE sections stays a plain honest "none found" — no hint [#50]', async () => {
    const id = await importText('Plain text with nothing to extract and no tokens.')
    await extractOf(id)
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'amount')
    expect(listing.items.length).toBe(0)
    expect(listing.unparsedChunks).toBe(0)
    const answer = buildListingAnswer(db, listing, tr)
    expect(answer).not.toMatch(/Build deep index/)
    expect(answer).not.toMatch(/bank-statement skill/)
  })

  // Issue #54 (owner decision 2026-07-17, option 1): an aggregation-shaped ask (categorize /
  // group by / sum per …) served by this engine gets a WRONG-SHAPED answer — a frequency list,
  // not the requested categories/sums. A non-empty listing must LEAD with the honest shape hint
  // (+ the bank-statement-skill pointer for `amount`); without the flag it stays byte-unchanged.
  it('#54: aggregationAsk LEADS a non-empty amount listing with the shape hint + skill pointer', async () => {
    // The scripted extract runtime only emits `party` records, so plant the amount row directly
    // (the extract pass supplies the scan markers; the row shape matches the pass's own inserts).
    const id = await importText('Pay 12,50 EUR and 99,00 EUR today, plus some filler prose.')
    await extractOf(id)
    const chunkId = (
      db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 1').get(id) as { id: string }
    ).id
    db.prepare(
      `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
       VALUES ('54rec1', ?, ?, 'amount', '12,50 EUR', '12.50', 'hash-54', '2026-07-17T00:00:00.000Z')`
    ).run(id, chunkId)
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'amount')
    expect(listing.items.length).toBeGreaterThan(0)
    const answer = buildListingAnswer(db, listing, tr, { aggregationAsk: true })
    expect(answer.startsWith(tr('analysis.listing.aggregationHint'))).toBe(true)
    expect(answer).toContain(tr('analysis.listing.aggregationHintAmountSkill'))
    // The hint leads the list — it never replaces it (items + caveat still present).
    expect(answer).toMatch(/12,50/)
    expect(answer).toMatch(/not guaranteed complete/)
    // Without the flag the answer is byte-unchanged (no hint).
    const plain = buildListingAnswer(db, listing, tr)
    expect(plain).not.toContain(tr('analysis.listing.aggregationHint'))
  })

  it('#54: a non-amount aggregation listing gets the generic hint WITHOUT the bank-skill pointer', async () => {
    const id = await importText('Pay @@alice@@ then @@bob@@ once.')
    await extractOf(id)
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'party')
    expect(listing.items.length).toBeGreaterThan(0)
    const answer = buildListingAnswer(db, listing, tr, { aggregationAsk: true })
    expect(answer.startsWith(tr('analysis.listing.aggregationHint'))).toBe(true)
    expect(answer).not.toContain(tr('analysis.listing.aggregationHintAmountSkill'))
  })

  it('#54: the EMPTY branch keeps its own #50 hint pair — the aggregation hint never doubles it', async () => {
    const id = await importText('@@BADJSON@@')
    await extractOf(id)
    const listing = aggregateExtractions(db, { documentIds: [id] }, 'amount')
    expect(listing.items.length).toBe(0)
    const answer = buildListingAnswer(db, listing, tr, { aggregationAsk: true })
    expect(answer).not.toContain(tr('analysis.listing.aggregationHint'))
    expect(answer).toMatch(/bank-statement skill/) // the #50 pointer, exactly once
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
