import { describe, it, expect } from 'vitest'
import type { Db } from '../../src/main/services/db'
import { runDocumentEdit, type OriginalDocumentBytes } from '../../src/main/services/skills/run'
import { redactWithEntities } from '../../src/main/services/skills/tools/redaction'
import { verifyAndSpliceEdits } from '../../src/main/services/skills/tools/document-edit'
import { readDocxTextLayer } from '../../src/main/services/export/docx-rewrite'
import { makeDocx, otherDocxParts } from '../helpers/docx'
import { REDACTION_GOLD, EDIT_GOLD } from '../fixtures/gold-set/legal-corpus'
import type { SkillToolAudit } from '../../src/shared/types'
import { openFreshDb } from '../helpers/db-fixtures'
import { scriptedRuntime } from '../helpers/scripted-runtime'
import { seedDocWithChunks as seedChunks } from '../helpers/doc-fixtures'

// GOLD-SET locate-pass fixtures (beta-feedback-2026-07 Phase 10 close-out; plan §13). The synthetic
// lawyer-shaped documents in `tests/fixtures/gold-set/legal-corpus.ts` are driven through the redaction and
// edit pipelines at the PURE level (`redactWithEntities` / `verifyAndSpliceEdits`), which exposes the
// drop-unverifiable count + the span union directly, and the edit gold also through the run SEAM with a
// scripted (mock) runtime replaying the fixture's model reply (the Phase-9 same-format DOCX round-trip over
// several length-changing edits in different paragraphs). The redaction run seam, incl. its DOCX round-trip,
// is covered by skills-redaction.test.ts. No real model runs here — that is a PAID_* manual harness
// (model-benchmarks.md §12); this file pins the STRUCTURAL guarantees (verbatim verify, all-occurrence sweep,
// occurrence precision, drop-unverifiable, DOCX formatting byte-identity), never model judgement quality.

const freshDb = (): Db => openFreshDb('goldset')

const seedDocWithChunks = (db: Db, text: string): string =>
  seedChunks(db, text, { title: 'Gold', mimeType: 'text/plain' })

const EDIT_INSTALL = 'app:document-edit'

// ---- Redaction gold set — the pure verify+sweep pipeline ----

describe('gold set — redaction locate → verify → sweep (pure)', () => {
  for (const gold of REDACTION_GOLD) {
    it(`${gold.id}: sweeps every occurrence, drops the unverifiable, masks + keeps the right spans`, () => {
      const text = gold.paragraphs.join('\n')
      const result = redactWithEntities(text, gold.located, 'perChar')

      // Coverage: every confirmed entity occurrence swept + the regex floor; the unverifiable proposal dropped.
      expect(result.entityMaskCount).toBe(gold.expectedEntityOccurrences)
      expect(result.droppedEntities).toBe(gold.expectedDropped)
      expect(result.totalRedactions).toBe(gold.expectedFloor + gold.expectedEntityOccurrences)

      // The sensitive strings are gone; the kept-scope strings survive verbatim.
      for (const masked of gold.mustMask) expect(result.text, `${masked} must be masked`).not.toContain(masked)
      for (const kept of gold.mustKeep) expect(result.text, `${kept} must survive`).toContain(kept)

      // Per-char masks preserve length (D74) ⇒ line layout survives: same length, same line count.
      expect(result.text.length).toBe(text.length)
      expect(result.text.split('\n')).toHaveLength(text.split('\n').length)
    })
  }
})

// ---- Edit gold set — occurrence-precise verify + splice ----

describe('gold set — targeted edits locate → verify → splice', () => {
  for (const gold of EDIT_GOLD) {
    it(`${gold.id}: splices only the anchored occurrences, drops the unverifiable (pure)`, () => {
      // The DOCX layer includes the trailing newline (`</w:p>` → `\n`), matching `expectedText`.
      const layer = gold.paragraphs.join('\n') + '\n'
      const result = verifyAndSpliceEdits(layer, gold.edits)
      expect(result.applied).toBe(gold.expectedApplied)
      expect(result.dropped).toBe(gold.expectedDropped)
      expect(result.text).toBe(gold.expectedText) // byte-identical outside the anchored spans (D58)
    })
  }

  it('vollmacht-agreement: DOCX in → DOCX out, occurrence-precise, formatting byte-identical', async () => {
    const gold = EDIT_GOLD.find((g) => g.id === 'vollmacht-agreement')!
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'ignored — the DOCX branch reads the injected original bytes')
    const original = await makeDocx(gold.paragraphs)
    const audit: SkillToolAudit = () => {}
    const runtime = scriptedRuntime(JSON.stringify({ edits: gold.edits }))
    let saved: Uint8Array | null = null
    let textCalled = false
    const res = await runDocumentEdit(db, { skillInstallId: EDIT_INSTALL, documentId: docId }, {
      audit,
      confirmed: true,
      runtime,
      instruction: gold.instruction,
      readOriginalDocument: async (): Promise<OriginalDocumentBytes> => ({ format: 'docx', bytes: original }),
      saveBinaryFile: async (_name, bytes) => {
        saved = bytes
        return true
      },
      saveTextFile: async () => {
        textCalled = true
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.editCount).toBe(gold.expectedApplied)
    expect(res.droppedCount).toBe(gold.expectedDropped)
    expect(res.resultKind).toBe('editedPartial') // 2 applied, 1 dropped
    expect(textCalled).toBe(false)

    const layer = await readDocxTextLayer(saved!)
    expect(layer.text).toBe(gold.expectedText) // the defined-term line is untouched (D76 precision)
    const before = await otherDocxParts(original)
    const after = await otherDocxParts(saved!)
    for (const [path, b64] of before) expect(after.get(path), `${path} byte-identical`).toBe(b64)
  })
})
