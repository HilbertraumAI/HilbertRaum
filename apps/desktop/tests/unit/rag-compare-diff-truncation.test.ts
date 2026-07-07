import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { retrieveCompareDiff, buildCompareDiffPrompt } from '../../src/main/services/rag'
import { wordDiff, renderChangesForModel, DIFF_RENDER_MAX } from '../../src/main/services/diff'
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
