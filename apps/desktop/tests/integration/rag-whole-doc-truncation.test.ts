import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// W1 — whole-document budget honesty (audit §2.2, plan §7 rec 4). At the DEFAULT 4096 context a
// "whole document" read is really a prefix read; before W1 it carried no notice and duplicated ~16%
// of the scarce budget via chunk overlap, and a German (subword-dense) doc could overflow n_ctx.
// This suite pins, on a realistic ~10-page German fixture at contextTokens=4096:
//   1. the 1.5 German-subword safety divisor on the whole-doc budget,
//   2. de-overlap: consecutive same-segment chunks no longer repeat their ~80-token boundary,
//   3. the single read flags its truncation at the fit budget, and a document that fits answers
//      notice-free,
//   4. the share-safe PII pre-scan (U2): whole-document counts and the verdict gate on a fitting read.
// The over-budget whole-doc TURN with no tree (Phase 1: the chunk map-reduce covers the WHOLE document,
// untruncated, share-safe scan in its reduce turn) is owned by rag-whole-doc-mapreduce.test.ts.

import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createQueuedDocument } from '../../src/main/services/ingestion'
import { CHAT_RESPONSE_RESERVE_TOKENS } from '../../src/main/services/chat'
import {
  buildShareSafeScanBlock,
  documentApproxTokenTotal,
  retrieveWholeDocument,
  scanWholeDocumentForPii,
  TOKENS_PER_WORD,
  wholeDocumentBudgetTokens,
  wholeDocumentFitBudgetTokens
} from '../../src/main/services/rag'
import { approxTokenCount } from '../../src/main/services/ingestion/chunker'
import { recordingRuntime, type RecordingRuntime } from '../helpers/scripted-runtime'
import { answerWholeDoc, germanDoc, WHOLE_DOC_QUESTION, wholeDocHarness } from '../helpers/whole-doc-fixtures'

/** Insert a chunk row directly, for precise control over segment labels (page/section) the ingestion
 *  path would coalesce away — used to exercise the cross-segment de-overlap gate. */
function insertChunk(
  db: Db,
  docId: string,
  index: number,
  text: string,
  pageNumber: number | null,
  sectionLabel: string | null
): void {
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `c-${docId}-${index}`,
    docId,
    index,
    text,
    'fixture.txt',
    pageNumber,
    sectionLabel,
    approxTokenCount(text),
    '2026-07-02T00:00:00.000Z'
  )
}

const CTX = 4096

/** A runtime that reports a 4096 window (§L0) and captures the assembled grounded turn. */
function capturingRuntime(): RecordingRuntime {
  return recordingRuntime('Zusammenfassung des Anfangs.', { contextWindow: CTX })
}

/** All `M####` markers across a chunk set, in order. Duplicates ⇒ an un-stripped overlap boundary. */
function markersOf(texts: string[]): string[] {
  return texts.flatMap((t) => t.match(/M\d{4}/g) ?? [])
}

describe('whole-document budget honesty at the default 4096 context (W1, audit §2.2)', () => {
  it('applies the 1.5 German-subword safety divisor to the whole-doc budget', () => {
    const raw = wholeDocumentBudgetTokens(CTX, WHOLE_DOC_QUESTION, null)
    const fit = wholeDocumentFitBudgetTokens(CTX, WHOLE_DOC_QUESTION, null)
    // Exactly the divisor the relevance path uses (RETRIEVAL_FIT_SAFETY = 1.5), floored to the 512 floor.
    expect(fit).toBe(Math.max(512, Math.floor(raw / 1.5)))
    // The divisor actually shrinks the budget (it was applied, not a no-op).
    expect(fit).toBeLessThan(raw)
    // Plan §W1 criterion: the read budget stays ≤ (context − response reserve) / 1.5.
    expect(fit).toBeLessThanOrEqual(Math.floor((CTX - CHAT_RESPONSE_RESERVE_TOKENS) / 1.5))
  })

  it('de-overlaps consecutive same-segment chunks: no duplicated ~80-token boundary', async () => {
    const h = await wholeDocHarness(germanDoc(280)) // ~11 pages, well over the 4096 whole-doc budget
    const dbTokens = (
      h.db
        .prepare('SELECT COALESCE(SUM(token_count), 0) AS s FROM chunks WHERE document_id = ?')
        .get(h.docId) as { s: number }
    ).s
    // Read the WHOLE document (huge budget → every chunk selected, truncated:false).
    const full = retrieveWholeDocument(h.db, h.docId, 100_000_000)
    expect(full.truncated).toBe(false)
    expect(full.chunks.length).toBeGreaterThan(2) // the fixture really did span multiple overlapping chunks
    // Every unique per-sentence marker appears at most once across the assembled excerpts — the
    // duplicated overlap prefix was stripped (without de-overlap the ~80-token boundary repeats markers).
    const markers = markersOf(full.chunks.map((c) => c.text))
    expect(new Set(markers).size).toBe(markers.length)
    // De-overlap reclaimed real budget: the assembled word count is strictly below the naive
    // per-chunk sum (which double-counts each boundary overlap).
    const assembledWords = full.chunks.reduce((a, c) => a + approxTokenCount(c.text), 0)
    expect(assembledWords).toBeLessThan(dbTokens)
    // The compare-split sizing (documentApproxTokenTotal) de-overlaps the SAME way (plan §W1 item 3),
    // so a document's half of the split is proportioned on real, not overlap-inflated, size. It reports
    // TOKENS_PER_WORD-scaled tokens, so compare against the naive scaled per-chunk sum (what
    // it would be WITHOUT de-overlap) — de-overlap must make it strictly smaller.
    const perChunk = h.db
      .prepare('SELECT token_count FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(h.docId) as Array<{ token_count: number }>
    const naiveScaled = perChunk.reduce((a, r) => a + Math.ceil(r.token_count * TOKENS_PER_WORD), 0)
    expect(documentApproxTokenTotal(h.db, h.docId)).toBeLessThan(naiveScaled)
  })

  it('de-overlap gate is per-segment: a cross-segment boundary word-run is NOT stripped', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-wholedocseg-'))
    const db = openDatabase(join(root, 'test.sqlite'))
    seedSettings(db)
    const doc = createQueuedDocument(db, join(root, 'fixture.txt'))
    // c0,c1 are the SAME segment (page 1): their shared boundary "SHARED ALPHA BETA" IS a real chunk
    // overlap → must be stripped from c1. c2 is a DIFFERENT segment (page 2) whose leading run
    // "TAIL GAMMA DELTA" coincidentally equals c1's tail — but a cross-segment repeat is NOT an overlap
    // and must be LEFT intact (the metadata gate; otherwise real page-2 content would be eaten).
    insertChunk(db, doc.id, 0, 'A ONE A TWO A THREE SHARED ALPHA BETA', 1, null)
    insertChunk(db, doc.id, 1, 'SHARED ALPHA BETA B ONE B TWO TAIL GAMMA DELTA', 1, null)
    insertChunk(db, doc.id, 2, 'TAIL GAMMA DELTA C ONE C TWO C THREE', 2, null)

    const full = retrieveWholeDocument(db, doc.id, 100_000_000)
    expect(full.chunks.length).toBe(3)
    // c0 unchanged (first chunk).
    expect(full.chunks[0].text).toBe('A ONE A TWO A THREE SHARED ALPHA BETA')
    // c1: the same-segment overlap prefix is stripped.
    expect(full.chunks[1].text).toBe('B ONE B TWO TAIL GAMMA DELTA')
    // c2: the cross-segment leading run survives verbatim — the gate refused to strip it.
    expect(full.chunks[2].text).toBe('TAIL GAMMA DELTA C ONE C TWO C THREE')
  })

  it('de-overlap is safe on space-less (glued) chunks: no empty excerpt, content preserved', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-wholedocspaceless-'))
    const db = openDatabase(join(root, 'test.sqlite'))
    seedSettings(db)
    const doc = createQueuedDocument(db, join(root, 'glued.txt'))
    // Two same-segment space-less runs (CJK — no whitespace, so a whole chunk is ONE "word" to a
    // word-splitter). The chunker re-includes a byte-exact overlap; the character-based de-overlap must
    // strip exactly that shared suffix↔prefix and NEVER empty a chunk (the CRITICAL a word-level scan hit).
    const overlap = '一二三四五六七八九十'
    insertChunk(db, doc.id, 0, `甲乙丙丁戊己庚辛${overlap}`, null, null)
    insertChunk(db, doc.id, 1, `${overlap}壬癸子丑寅卯辰巳`, null, null)

    const full = retrieveWholeDocument(db, doc.id, 100_000_000)
    expect(full.chunks.length).toBe(2)
    // No chunk was emptied.
    expect(full.chunks[0].text.length).toBeGreaterThan(0)
    expect(full.chunks[1].text.length).toBeGreaterThan(0)
    // The duplicated overlap run was stripped from the second chunk (appears once across the read)…
    expect(full.chunks[1].text).toBe('壬癸子丑寅卯辰巳')
    // …and the unique new content of the second chunk survived.
    expect(full.chunks[1].text).toContain('壬癸子丑寅卯辰巳')
    // The overlap run is present exactly once across the two assembled excerpts.
    const joined = full.chunks.map((c) => c.text).join('｜')
    expect(joined.split(overlap).length - 1).toBe(1)
  })

  it('truncates the read at the fit budget and flags it (posture: honest beginning, not silent prefix)', async () => {
    const h = await wholeDocHarness(germanDoc(280)) // ~11 pages, well over the 4096 whole-doc budget
    const fit = wholeDocumentFitBudgetTokens(CTX, WHOLE_DOC_QUESTION, null)
    const partial = retrieveWholeDocument(h.db, h.docId, fit)
    expect(partial.truncated).toBe(true)
    expect(partial.chunksCovered).toBeLessThan(partial.chunksTotal)
    expect(partial.chunksCovered).toBeGreaterThan(0)
  })

  it('a small (non-truncating) document keeps the whole-doc read honest and notice-free', async () => {
    const h = await wholeDocHarness(germanDoc(3)) // three sentences — fits any sane budget
    const runtime = capturingRuntime()
    const msg = await answerWholeDoc(h, runtime)

    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    const userTurn = runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    // The floor read's notice is composed at runtime ("IMPORTANT — PARTIAL " + "DOCUMENT", rag/index.ts
    // `truncationNotice`), so no source grep finds it — but a fitting read must never carry it.
    expect(userTurn).not.toContain('PARTIAL DOCUMENT')
  })
})

// U2 (audit §3.5): the share-safe review whole-doc turn injects a deterministic whole-document PII count
// summary into the grounded prompt, and gates the "Likely low risk" verdict on non-truncated coverage.
describe('share-safe PII pre-scan injection (U2, audit §3.5)', () => {
  it('buildShareSafeScanBlock reports counts and gates the verdict ONLY when truncated', () => {
    const counts = { email: 2, phone: 0, iban: 1, card: 0, date: 3, url: 0 }
    const fit = buildShareSafeScanBlock(counts, false)
    // Counts only (never a value); no verdict gate when the whole document fit.
    expect(fit).toContain('e-mail addresses: 2')
    expect(fit).toContain('IBANs: 1')
    expect(fit).toContain('payment-card numbers: 0')
    expect(fit).toContain('dates: 3')
    expect(fit).not.toContain('MUST NOT')
    expect(fit).not.toContain('Likely low risk')

    // A truncated read FORBIDS the low-risk verdict (privacy verdict rests on whole-document coverage).
    const capped = buildShareSafeScanBlock(counts, true)
    expect(capped).toContain('e-mail addresses: 2')
    expect(capped).toContain('MUST NOT')
    expect(capped).toContain('Likely low risk after review')
  })

  it('scanWholeDocumentForPii counts PII across ALL chunks (whole document, not budget-capped)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-scanpii-'))
    const db = openDatabase(join(root, 'test.sqlite'))
    seedSettings(db)
    const docId = 'doc-scan'
    db.prepare(
      `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
       VALUES (?, 'Letter', 'indexed', 'text/plain', 1, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`
    ).run(docId)
    insertChunk(db, docId, 0, 'Contact us at team@example.com for details.', 1, null)
    insertChunk(db, docId, 1, 'Bank: IBAN AT61 1904 3002 3457 3201 and card 4111 1111 1111 1111.', 2, null)
    const counts = scanWholeDocumentForPii(db, docId)
    expect(counts.email).toBe(1)
    expect(counts.iban).toBe(1)
    expect(counts.card).toBe(1)
    expect(counts.phone).toBe(0)
  })

  it('SKA-3 R8: the share-safe pre-scan counts Unicode print variants — the verdict input is no longer 0', () => {
    // Before R8 a typographically-set document (NBSP-grouped IBAN/card, non-breaking-hyphen phone,
    // parenthesized US phone) pre-scanned as ALL ZEROS, so the share-safe verdict rested on "no PII
    // found" while the export carried every identifier verbatim. The scan shares the shadowed
    // redactText pipeline, so these now count exactly as a real redaction would mask them.
    // Special characters as \u escapes (the T1 convention).
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-scanpii-uni-'))
    const db = openDatabase(join(root, 'test.sqlite'))
    seedSettings(db)
    const docId = 'doc-scan-uni'
    db.prepare(
      `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
       VALUES (?, 'Brief', 'indexed', 'text/plain', 1, '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:00.000Z')`
    ).run(docId)
    insertChunk(db, docId, 0, 'IBAN AT61\u00a01904\u00a03002\u00a03457\u00a03201, Karte 4111\u00a01111\u00a01111\u00a01111.', 1, null)
    insertChunk(db, docId, 1, 'Tel +43 664\u20111234567, US office (555) 123-4567.', 2, null)
    const counts = scanWholeDocumentForPii(db, docId)
    expect(counts.iban).toBe(1)
    expect(counts.card).toBe(1)
    expect(counts.phone).toBe(2)
    expect(counts.email).toBe(0)
  })

  // The over-budget share-safe turn (the scan block in the chunk map-reduce's reduce turn, no gate) is
  // owned by rag-whole-doc-mapreduce.test.ts ('share-safe: …').
  it('a small (fitting) document injects the scan block WITH counts and NO verdict gate', async () => {
    const h = await wholeDocHarness('Please review before sharing. Reach me at jane@example.com.')
    const runtime = capturingRuntime()
    const msg = await answerWholeDoc(h, runtime, { wholeDocumentPiiScan: true }, 'Is this safe to share?')

    expect(msg.coverage?.truncated).toBe(false)
    const userTurn = runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userTurn).toContain('AUTOMATED PRE-SCAN')
    expect(userTurn).toContain('e-mail addresses: 1') // the planted address was detected (as a COUNT)
    expect(userTurn).not.toContain('MUST NOT') // fit ⇒ no verdict gate
  })
})
