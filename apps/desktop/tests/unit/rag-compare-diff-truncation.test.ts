import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { retrieveCompareDiff, buildCompareDiffPrompt, wholeDocumentFitBudgetTokens } from '../../src/main/services/rag'
import { wordDiff, renderChangesForModel, renderRedline, DIFF_RENDER_MAX } from '../../src/main/services/diff'
import { approxTokenCount } from '../../src/main/services/ingestion/chunker'

// Audit SK-2 (skills-audit-2026-07-07): the model-facing diff renderers cap the change list at
// DIFF_RENDER_MAX and drop the LATER changes; before this fix the chat compare path passed no `max`
// and set `truncated` only from the TOKEN budget, so a pair with >DIFF_RENDER_MAX changes that still
// fit the budget produced a prompt asserting the list is "complete and exact" over a capped list.
// These tests pin: (1) >cap ⇒ truncated:true + a PARTIAL prompt (with the budget NOT the cause), and
// (2) ≤cap at the same budget ⇒ truncated:false + a completeness assertion (the fix can't over-fire).

/** A word stream of `n` distinct `${prefix}i` tokens, each separated by 3 identical `keep` words so
 *  the tokens between changes stay EQUAL and every altered token is its OWN coalesced change. Two
 *  such streams with different prefixes therefore diff to exactly `n` separate changes. Three equal
 *  separators per change keep the changed-word fraction well under isPreciseDiffUseful's 0.5 bar. */
function stream(n: number, prefix: string): string {
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    if (i > 0) parts.push('keep', 'keep', 'keep')
    parts.push(`${prefix}${i}`)
  }
  return parts.join(' ')
}

const BIG_BUDGET = 1_000_000 // tokens — far more than a 200-change render needs, so the budget never truncates.

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-cmpdiff-')), 'test.sqlite'))
}

/** Seed one document as a single chunk carrying the whole word stream. */
function seedDoc(db: Db, id: string, text: string): void {
  const now = '2026-01-01T00:00:00.000Z'
  db.prepare(
    `INSERT INTO documents (id, title, status, origin_json, created_at, updated_at)
     VALUES (?, ?, 'indexed', NULL, ?, ?)`
  ).run(id, `${id}.txt`, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
     VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, ?)`
  ).run(`${id}-c0`, id, text, `${id}.txt`, now)
}

function compareOf(nChanges: number): { truncated: boolean; prompt: string } {
  const db = freshDb()
  seedDoc(db, 'docA', stream(nChanges, 'A'))
  seedDoc(db, 'docB', stream(nChanges, 'B'))
  const result = retrieveCompareDiff(db, ['docA', 'docB'], BIG_BUDGET)
  db.close()
  expect(result).not.toBeNull()
  const r = result!
  const prompt = buildCompareDiffPrompt(
    'what changed?',
    r.redlineText,
    r.changesText,
    r.labelA,
    r.labelB,
    null,
    r.truncated
  )
  return { truncated: r.truncated, prompt }
}

describe('retrieveCompareDiff — the DIFF_RENDER_MAX render cap sets truncated (SK-2)', () => {
  it('>DIFF_RENDER_MAX changes within budget ⇒ truncated:true and a PARTIAL prompt (NOT "complete and exact")', () => {
    const nChanges = DIFF_RENDER_MAX + 50 // 250 — over the render cap, well under DEFAULT_MAX_EDITS/maxWords.

    // Budget-truncation must NOT be the cause: rendering ALL 250 changes costs far less than the budget,
    // so the ONLY reason this list is capped is the DIFF_RENDER_MAX render cap (else the test would pass
    // for the wrong reason).
    const full = wordDiff(stream(nChanges, 'A'), stream(nChanges, 'B'))!
    expect(full.changes.length).toBe(nChanges)
    const fullTokens = approxTokenCount(renderChangesForModel(full.changes, { max: nChanges }).text) * 1.3
    expect(fullTokens).toBeLessThan(BIG_BUDGET)

    const { truncated, prompt } = compareOf(nChanges)
    expect(truncated).toBe(true)
    expect(prompt).toContain('PARTIAL')
    expect(prompt).not.toContain('complete and exact')
    expect(prompt).toMatch(/do NOT describe anything as unchanged/i)
  })

  it('≤DIFF_RENDER_MAX changes at the same budget ⇒ truncated:false and a completeness assertion', () => {
    const { truncated, prompt } = compareOf(DIFF_RENDER_MAX - 50) // 150 — under the render cap.
    expect(truncated).toBe(false)
    expect(prompt).toContain('they are complete and exact')
    expect(prompt).not.toContain('PARTIAL')
  })
})

// CODE-5 (full-audit 2026-07-11): the token budget must cover the WHOLE model-facing payload —
// `changesText` AND `redlineText` together. Per change the redline repeats the same removed+added
// words plus context as the change list, so budgeting `changesText` alone let the assembled turn run
// ~2× the proven budget (which already consumes the whole RETRIEVAL_FIT_SAFETY headroom) — the #41
// `exceed_context_size_error` class on the primary version-compare route. The change list is the
// load-bearing half: when the pair over-runs, the redline is dropped FIRST (the doctask mode-d
// sibling keeps the redline out of the prompt entirely — doctasks/handlers/compare.ts:171–178).
describe('retrieveCompareDiff — the budget covers changes + redline JOINTLY (CODE-5)', () => {
  /** Total approx-token cost of both model-facing blocks, in the SAME 1.3-scaled currency the
   *  budget check uses (`approxTokenCount × TOKENS_PER_WORD`). */
  const payloadTokens = (r: { changesText: string; redlineText: string }): number =>
    (approxTokenCount(r.changesText) + approxTokenCount(r.redlineText)) * 1.3

  it('a ~200-one-word-change pair at a 4096-token window keeps the whole payload within budget', () => {
    const nChanges = 200
    const db = freshDb()
    seedDoc(db, 'docA', stream(nChanges, 'A'))
    seedDoc(db, 'docB', stream(nChanges, 'B'))
    // The REAL budget the grounded compare path hands retrieveCompareDiff for a 4096-token window.
    const budget = wholeDocumentFitBudgetTokens(4096, 'what changed?', null)
    const result = retrieveCompareDiff(db, ['docA', 'docB'], budget)
    db.close()
    // The diff route still answers (no fall-through to the capped whole-doc read)…
    expect(result).not.toBeNull()
    expect(result!.changesText.length).toBeGreaterThan(0)
    // …and the assembled model-facing payload fits the proven budget — redline INCLUDED. Pre-fix the
    // redline rode unbudgeted, so this total ran ~2× the budget and provably exceeded n_ctx.
    expect(payloadTokens(result!)).toBeLessThanOrEqual(budget)
  })

  it('drops the redline FIRST when the pair over-runs but the full change list alone fits', () => {
    const nChanges = 120 // under DIFF_RENDER_MAX so the render cap cannot interfere
    const a = stream(nChanges, 'A')
    const b = stream(nChanges, 'B')
    const full = wordDiff(a, b)!
    const changesText = renderChangesForModel(full.changes, { max: DIFF_RENDER_MAX }).text
    const changesWords = approxTokenCount(changesText)
    const redlineWords = approxTokenCount(renderRedline(full.changes, { max: DIFF_RENDER_MAX }).text)
    // A budget the COMPLETE change list fits alone but the changes+redline pair over-runs.
    const budget = Math.floor((changesWords + redlineWords / 2) * 1.3)
    expect(changesWords * 1.3).toBeLessThanOrEqual(budget) // sanity: the list alone fits

    const db = freshDb()
    seedDoc(db, 'docA', a)
    seedDoc(db, 'docB', b)
    const result = retrieveCompareDiff(db, ['docA', 'docB'], budget)
    db.close()
    expect(result).not.toBeNull()
    // The load-bearing change list survives COMPLETE; the redline is the first thing to go.
    expect(result!.changesText).toBe(changesText)
    expect(result!.redlineText).toBe('')
    expect(result!.truncated).toBe(false) // the change list itself is complete — the prompt may say so
    expect(payloadTokens(result!)).toBeLessThanOrEqual(budget)
  })
})
