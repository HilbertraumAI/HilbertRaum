import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../src/main/services/db'
import {
  exportEvidencePackToFile,
  packFormatForDestination,
  resolvePackExportFormat,
  suggestedPackFileName,
  writePackFileAtomic,
  packTmpPath,
  EvidencePackOutdatedError,
  EvidencePackRecordError
} from '../../src/main/services/evidence-pack/export'
import { acknowledgeEvidenceReviewFreshness } from '../../src/main/services/evidence-pack/freshness'
import { EVIDENCE_PACK_SCHEMA_VERSION } from '../../src/main/services/evidence-pack/pack-model'
import {
  deleteEvidenceReview,
  getEvidenceReview,
  listEvidenceExports,
  markEvidenceReviewReady,
  updateEvidenceReview,
  updateEvidenceReviewItem
} from '../../src/main/services/evidence-reviews'
import { sha256Of } from '../../src/main/services/assets'
import { t } from '../../src/shared/i18n'
import { tempRoot, freshWorkspaceDb } from '../helpers/db-fixtures'
import {
  exportDeps,
  NEVER_PDF,
  normalizePack,
  seedAssistantAnswer,
  seedEvidenceReview,
  seedSourceDocument,
  useOfflineGuard,
  type SeedAnswerOptions
} from '../helpers/evidence-fixtures'

// EP-1 plan §8 exit gate (spec §30 Phase-2 gate) — the export pipeline end to end against
// a real SQLite workspace: DETERMINISTIC GOLDEN PACKS for the five spec §29.5 classes
// (relevance / whole-doc / partial-coverage / missing-source / German) plus the P4
// outdated-acknowledged pack (spec §28.6) plus the two ZIM archive-mixed packs (PR #294
// review M11 — eight goldens total), the post-rename (§28.9) failure semantics; the
// write/rename failure paths live in evidence-pack-export-async-fs.test.ts (AUD-15
// instrumentation), encoding (UTF-8,
// NO BOM, meta charset), recorded-hash-matches-file-bytes, options persisted, export on a
// READY review (the write-guard covers item mutations only — verified, not assumed), and
// cancel ⇒ no row. The REAL offline network guard runs across every test; the pipeline
// takes no runtime/embedder at all (its signature is (db, id, options, deps)), so a model
// call is structurally impossible — the guard pins the no-network half.
//
// Golden maintenance: UPDATE_EVIDENCE_PACK_GOLDENS=1 npx vitest run <this file> rewrites
// tests/fixtures/evidence-packs/*.html; review the diff like code (spec §29.5).

const GOLDEN_DIR = join(__dirname, '..', 'fixtures', 'evidence-packs')
const FIXED_PACK_ID = '00000000-0000-4000-8000-00000000e9a1'
const FIXED_NOW = '2026-07-18T12:00:00.000Z'

useOfflineGuard()

/** The golden inputs, stated here rather than inherited from the helper's defaults: the conversation title (the
 *  suggested file name and the pack's cover), the model id and the question all render into the packs. */
const seedPackAnswer = (db: Db, o: SeedAnswerOptions): ReturnType<typeof seedAssistantAnswer> =>
  seedAssistantAnswer(db, {
    title: 'Contract questions',
    modelId: 'test-model-q4',
    question: 'What about termination?',
    ...o
  })

/** The generation metadata every golden pack records. */
const GOLDEN_DEPS = { appVersion: '0.1.52-test', modelDisplayName: () => 'Test Model' }

/** The goldens' fixed pack id and clock (spec §29.5 normalizes both away again). */
const goldenExport = (dest: string): ReturnType<typeof exportDeps> =>
  exportDeps(dest, { newPackId: () => FIXED_PACK_ID, now: () => FIXED_NOW })

function compareGolden(name: string, html: string): void {
  const normalized = normalizePack(html, [FIXED_PACK_ID])
  const goldenPath = join(GOLDEN_DIR, `${name}.html`)
  if (process.env.UPDATE_EVIDENCE_PACK_GOLDENS) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(goldenPath, normalized, 'utf8')
    return
  }
  expect(existsSync(goldenPath), `golden missing: ${goldenPath} (run with UPDATE_EVIDENCE_PACK_GOLDENS=1)`).toBe(true)
  expect(normalized).toBe(readFileSync(goldenPath, 'utf8'))
}

// ---- The eight golden classes (the five spec §29.5 classes + P4 outdated-acknowledged +
// ---- the two ZIM archive-mixed classes, PR #294 review M11) --------------------------

describe('golden packs (deterministic; spec §29.5)', () => {
  it('relevance pack — ready review, notes, links, ready-review export allowed', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const docId = seedSourceDocument(db, { title: 'contract.pdf', sha256: 'ab'.repeat(32), mime: 'application/pdf' })
    const answer = seedPackAnswer(db, {
      content:
        '# Findings\n\nTermination requires 30 days notice. [S1]\n\nThe fee is fixed. [S2]\n\n`[S1] stays literal in code`',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'contract.pdf',
          documentId: docId,
          pageNumber: 12,
          section: 'Termination',
          snippet: 'Either party may terminate with 30 days notice.'
        },
        { label: 'S2', sourceTitle: 'contract.pdf', documentId: docId, snippet: 'The fee is fixed at 100.' }
      ],
      coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 10 }
    })
    const detail = seedEvidenceReview(db, answer, GOLDEN_DEPS)
    for (const item of detail.items) {
      if (item.blockKind !== 'heading') {
        updateEvidenceReviewItem(db, item.id, { decision: 'supported', reviewerNote: 'Verified on page 12.' })
      }
    }
    updateEvidenceReview(db, detail.id, { reviewerLabel: 'A. Reviewer', generalNote: 'All statements verified.' })
    const ready = markEvidenceReviewReady(db, detail.id)
    expect(ready?.review.status).toBe('ready')

    // Export the READY review — the write-guard must not block it (P2 handoff: verify).
    const dest = join(root, 'relevance.html')
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'en' }, goldenExport(dest))
    expect(record).not.toBeNull()
    compareGolden('relevance', readFileSync(dest, 'utf8'))
  })

  it('whole-document pack — provenance wording, zero auto-links', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const docId = seedSourceDocument(db, { title: 'report.pdf', sha256: 'cd'.repeat(32), mime: 'application/pdf' })
    const answer = seedPackAnswer(db, {
      content: 'The report concludes X.\n\nSection provenance follows. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'report.pdf', documentId: docId, snippet: 'Chapter 2 overview.' }],
      coverage: { mode: 'tree', chunksCovered: 40, chunksTotal: 40 }
    })
    const detail = seedEvidenceReview(db, answer, GOLDEN_DEPS)
    const dest = join(root, 'whole-doc.html')
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'en' }, goldenExport(dest))
    expect(record).not.toBeNull()
    const html = readFileSync(dest, 'utf8')
    // The load-bearing §24.3 claim: provenance, never citations; zero answer_marker links.
    expect(html).toContain('whole-document analysis')
    expect(html).not.toContain('Cited by the answer')
    compareGolden('whole-doc', html)
  })

  it('partial-coverage pack — capped mode + recorded output truncation warn honestly', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const docId = seedSourceDocument(db, { title: 'ledger.xlsx', mime: 'application/vnd.ms-excel', sha256: 'ee'.repeat(32) })
    const answer = seedPackAnswer(db, {
      content: 'Partial listing of entries.\n\nOnly the beginning was analyzed.',
      citations: [{ label: 'S1', sourceTitle: 'ledger.xlsx', documentId: docId, snippet: 'Rows 1-100.' }],
      coverage: { mode: 'capped', chunksCovered: 3, chunksTotal: 9, truncated: true },
      truncated: true
    })
    const detail = seedEvidenceReview(db, answer, GOLDEN_DEPS)
    const dest = join(root, 'partial-coverage.html')
    await exportEvidencePackToFile(db, detail.id, { language: 'en' }, goldenExport(dest))
    const html = readFileSync(dest, 'utf8')
    expect(html).toContain('3 of 9')
    compareGolden('partial-coverage', html)
  })

  it('missing-source pack — resolved-but-missing DISTINCT from unresolved identity', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    // Two docs with the SAME title → the legacy citation stays identity:'unresolved';
    // a documentId pointing at NO row → resolved + availability 'missing'.
    seedSourceDocument(db, { title: 'notes.docx' })
    seedSourceDocument(db, { title: 'notes.docx' })
    const answer = seedPackAnswer(db, {
      content: 'Claim about the deleted source. [S1]\n\nClaim about the ambiguous source. [S2]',
      citations: [
        { label: 'S1', sourceTitle: 'gone.pdf', documentId: 'no-such-doc', snippet: 'Old excerpt.' },
        { label: 'S2', sourceTitle: 'notes.docx', snippet: 'Ambiguous excerpt.' }
      ],
      coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 2 }
    })
    const detail = seedEvidenceReview(db, answer, GOLDEN_DEPS)
    const dest = join(root, 'missing-source.html')
    await exportEvidencePackToFile(db, detail.id, { language: 'en' }, goldenExport(dest))
    const html = readFileSync(dest, 'utf8')
    expect(html).toContain('could not be verified')
    expect(html).toContain('already missing')
    compareGolden('missing-source', html)
  })

  it('outdated-acknowledged pack — P4 (spec §28.6): the pack records the mismatch + acknowledge', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const docId = seedSourceDocument(db, { title: 'contract.pdf', sha256: 'ab'.repeat(32), mime: 'application/pdf' })
    const answer = seedPackAnswer(db, {
      content: 'Termination requires 30 days notice. [S1]',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'contract.pdf',
          documentId: docId,
          pageNumber: 12,
          snippet: 'Either party may terminate with 30 days notice.'
        }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 10 }
    })
    const detail = seedEvidenceReview(db, answer, GOLDEN_DEPS)
    // The source document CHANGES after the review (stored hash updated by re-ingestion) —
    // the review is outdated; export works only after the explicit acknowledge (§28.6).
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)
    expect(acknowledgeEvidenceReviewFreshness(db, detail.id)?.acknowledgedAt).toBeTruthy()

    const dest = join(root, 'outdated-acknowledged.html')
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'en' }, goldenExport(dest))
    expect(record).not.toBeNull()
    const html = readFileSync(dest, 'utf8')
    // Cover warning + coverage-section mismatch record + acknowledge stamp + §16.1.7 cell.
    expect(html).toContain('This review is outdated')
    expect(html).toContain('1 source document has changed since this review was created.')
    expect(html).toContain('The reviewer acknowledged this change on')
    expect(html).toContain('Changed since review')
    compareGolden('outdated-acknowledged', html)
  })

  it('German pack — DE copy + [Q{n}] markers, frozen at generation', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const docId = seedSourceDocument(db, { title: 'vertrag.pdf', sha256: 'ab'.repeat(32), mime: 'application/pdf' })
    const answer = seedPackAnswer(db, {
      title: 'Vertragsfragen',
      question: 'Was gilt bei Kündigung?',
      content: 'Die Kündigungsfrist beträgt 30 Tage. [S1]\n\nDie Gebühr ist fest vereinbart.',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'vertrag.pdf',
          documentId: docId,
          pageNumber: 3,
          snippet: 'Kündigung mit einer Frist von 30 Tagen — ausschließlich schriftlich.'
        }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 4 }
    })
    const detail = seedEvidenceReview(db, answer, GOLDEN_DEPS)
    const dest = join(root, 'german.html')
    await exportEvidencePackToFile(db, detail.id, { language: 'de' }, goldenExport(dest))
    const html = readFileSync(dest, 'utf8')
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('[Q1]') // DE display marker
    expect(html).toContain('Nachweispaket')
    expect(html).toContain('ausschließlich') // umlaut/ß round-trip
    compareGolden('german', html)
  })

  // ---- ZIM knowledge packs (PR #294 review M11 → #301): the two ARCHIVE golden classes ----
  // A mixed pack (one workspace document + one knowledge-pack article) in each language. They
  // pin the whole archive surface as BYTES: the "Knowledge pack" line, the mono pack-id/article
  // locator, the archive-specific identity warning (never the legacy unresolved one), the
  // §16.1.6 archive count, and the §16.1.7 type/availability cells with NO hash. The EN one
  // carries hostile markup inside the archive title so the golden pins the escaping too.
  const ARCHIVE_PACK_ID_EN = '5c9a7e21-4b6d-4f38-9a0c-1d2e3f4a5b6c'
  const ARCHIVE_PACK_ID_DE = '7e2d4c60-8a19-4b53-bc71-0f5a6d3e2c14'
  const ARCHIVE_ARTICLE_PATH = 'Treibhausgas/Übersicht_ß'

  it('archive-mixed pack (EN) — a knowledge-pack article beside a document source: locator, archive warning, escaped hostile title', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const docId = seedSourceDocument(db, { title: 'contract.pdf', sha256: 'ab'.repeat(32), mime: 'application/pdf' })
    const answer = seedPackAnswer(db, {
      content:
        'Termination requires 30 days notice. [S1]\n\nMethane from agriculture is a greenhouse gas. [S2]',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'contract.pdf',
          documentId: docId,
          pageNumber: 12,
          section: 'Termination',
          snippet: 'Either party may terminate with 30 days notice.'
        },
        {
          label: 'S2',
          sourceTitle: 'Treibhausgas',
          pageNumber: null,
          section: 'Landwirtschaft',
          snippet: 'Methan aus der Landwirtschaft ist ein Treibhausgas.',
          sourceKind: 'archive',
          packId: ARCHIVE_PACK_ID_EN,
          archiveTitle: 'Wikipedia (DE) – Klimawandel <b>',
          articlePath: ARCHIVE_ARTICLE_PATH
          // NO documentId by construction (H2): an archive citation names no `documents` row.
        }
      ],
      coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 9 }
    })
    const detail = seedEvidenceReview(db, answer, GOLDEN_DEPS)
    const dest = join(root, 'archive-mixed.html')
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'en' }, goldenExport(dest))
    expect(record).not.toBeNull()
    const html = readFileSync(dest, 'utf8')
    // The load-bearing M11 claims, stated here as well as pinned by the golden bytes.
    expect(html).toContain(`${t('en', 'packExport.evidence.archive')}: Wikipedia (DE) – Klimawandel &lt;b&gt;`)
    expect(html).toContain(`${t('en', 'packExport.evidence.packId')}: ${ARCHIVE_PACK_ID_EN}`)
    expect(html).toContain(`${t('en', 'packExport.evidence.article')}: Treibhausgas/Übersicht_ß`)
    expect(html).toContain(t('en', 'packExport.evidence.archiveIdentity'))
    expect(html).not.toContain(t('en', 'packExport.evidence.identityUnresolved'))
    expect(html).toContain(t('en', 'packExport.sources.typeArchive'))
    expect(html).toContain(t('en', 'packExport.sources.availabilityArchive'))
    // The §16.1.6 archive count, singular form (one archive source).
    expect(html).toContain(t('en', 'review.summary.sourcesArchive.one', { count: 1 }))
    // Hostile markup never survives raw, and the document's hash appears ONCE (its own row).
    expect(html).not.toContain('Klimawandel <b>')
    expect(html.split('ab'.repeat(32)).length - 1).toBe(1)
    compareGolden('archive-mixed', html)
  })

  it('archive-mixed-de pack (DE) — the same mixed shape in German: umlaut/ß locator through the DE catalog', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const docId = seedSourceDocument(db, { title: 'vertrag.pdf', sha256: 'cd'.repeat(32), mime: 'application/pdf' })
    const answer = seedPackAnswer(db, {
      title: 'Vertragsfragen',
      question: 'Was gilt bei Kündigung und wie entsteht Treibhausgas?',
      content:
        'Die Kündigungsfrist beträgt 30 Tage. [S1]\n\nMethan entsteht in der Landwirtschaft. [S2]',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'vertrag.pdf',
          documentId: docId,
          pageNumber: 3,
          snippet: 'Kündigung mit einer Frist von 30 Tagen — ausschließlich schriftlich.'
        },
        {
          label: 'S2',
          sourceTitle: 'Treibhausgas',
          pageNumber: null,
          section: 'Landwirtschaft',
          snippet: 'Methan aus der Landwirtschaft ist ein Treibhausgas.',
          sourceKind: 'archive',
          packId: ARCHIVE_PACK_ID_DE,
          archiveTitle: 'Wikipedia (DE) – Klimawandel',
          articlePath: ARCHIVE_ARTICLE_PATH
        }
      ],
      coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 6 }
    })
    const detail = seedEvidenceReview(db, answer, GOLDEN_DEPS)
    const dest = join(root, 'archive-mixed-de.html')
    await exportEvidencePackToFile(db, detail.id, { language: 'de' }, goldenExport(dest))
    const html = readFileSync(dest, 'utf8')
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('[Q2]') // DE display marker on the archive card
    expect(html).toContain(`${t('de', 'packExport.evidence.archive')}: Wikipedia (DE) – Klimawandel`)
    expect(html).toContain(`${t('de', 'packExport.evidence.packId')}: ${ARCHIVE_PACK_ID_DE}`)
    expect(html).toContain(`${t('de', 'packExport.evidence.article')}: Treibhausgas/Übersicht_ß`)
    expect(html).toContain(t('de', 'packExport.evidence.archiveIdentity'))
    expect(html).not.toContain(t('de', 'packExport.evidence.identityUnresolved'))
    expect(html).toContain(t('de', 'packExport.sources.typeArchive'))
    expect(html).toContain(t('de', 'packExport.sources.availabilityArchive'))
    expect(html.split('cd'.repeat(32)).length - 1).toBe(1)
    compareGolden('archive-mixed-de', html)
  })
})

// ---- Pipeline guarantees -----------------------------------------------------------

/** The printer's stand-in output for the PDF rows. */
const PDF_BYTES = Buffer.from('%PDF-1.7\nfake-pack-pdf-bytes\n%%EOF', 'utf8')

describe('atomicity + failure semantics (spec §20.3/§28.9)', () => {
  it('cancel (no destination chosen) records nothing and writes nothing', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const answer = seedPackAnswer(db, {
      content: 'Cancelled claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = seedEvidenceReview(db, answer)
    const result = await exportEvidencePackToFile(db, detail.id, {}, {
      chooseDestination: async () => null,
      renderPdf: NEVER_PDF
    })
    expect(result).toBeNull()
    expect(listEvidenceExports(db, detail.id)).toEqual([])
    expect(readdirSync(root).filter((f) => f.endsWith('.html') || f.endsWith('.tmp'))).toEqual([])
  })

  it('FIX-1a: a record failure AFTER the rename unlinks the file — no destination, no row, distinct error', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const answer = seedPackAnswer(db, {
      content: 'Post-rename claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = seedEvidenceReview(db, answer)
    const dest = join(root, 'post-rename.html')
    await expect(
      exportEvidencePackToFile(db, detail.id, {}, {
        chooseDestination: async () => {
          // Injected row-insert failure (the P1 FIX-2 trigger idiom), armed AFTER the
          // pipeline's initial load so only the post-rename INSERT hits it.
          db.exec(
            "CREATE TRIGGER fail_export BEFORE INSERT ON evidence_exports BEGIN SELECT RAISE(ABORT, 'injected record failure'); END"
          )
          return dest
        },
        renderPdf: NEVER_PDF
      })
    ).rejects.toBeInstanceOf(EvidencePackRecordError)
    // The invariant is RESTORED: the freshly-renamed destination was unlinked…
    expect(existsSync(dest)).toBe(false)
    // …and no scratch sibling survives under ANY name (the tmp file is named per export,
    // AUD-17, so asserting one fixed path would no longer prove anything).
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
    // …and no row exists (trigger removed so the read runs clean).
    db.exec('DROP TRIGGER fail_export')
    expect(listEvidenceExports(db, detail.id)).toEqual([])
    // The review itself stays usable.
    expect(getEvidenceReview(db, detail.id)?.status).toBe('draft')
  })

  // One row per format: the PDF leg is the SAME post-rename tail (P3 FIX-1b), reached through the print arm.
  it.each([
    ['html', { ext: '.html', request: {}, prints: false }],
    ['pdf', { ext: '.pdf', request: { format: 'pdf' }, prints: true }]
  ] as const)('FIX-1b (%s): review deleted while the save dialog was open → file unlinked, thrown — NEVER a silent cancel-shaped null', async (_format, row) => {
    const { db, root } = freshWorkspaceDb('eppack')
    const answer = seedPackAnswer(db, {
      content: 'Deleted-mid-dialog claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = seedEvidenceReview(db, answer)
    const dest = join(root, `deleted-mid-dialog${row.ext}`)
    let printed = false
    await expect(
      exportEvidencePackToFile(db, detail.id, row.request, exportDeps(dest, {
        chooseDestination: async () => {
          // Another window deletes the review while this one's dialog is open —
          // recordEvidenceExport will return null (its no-orphan-rows guard).
          expect(deleteEvidenceReview(db, detail.id)).toBe(true)
          return dest
        },
        renderPdf: row.prints
          ? async () => {
              printed = true
              return PDF_BYTES
            }
          : NEVER_PDF
      }))
    ).rejects.toBeInstanceOf(EvidencePackRecordError)
    expect(printed).toBe(row.prints) // the pdf leg really took the PDF arm
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('unknown review id → null, no dialog shown', async () => {
    const { db } = freshWorkspaceDb('eppack')
    let dialogShown = false
    const result = await exportEvidencePackToFile(db, 'no-such-review', {}, {
      chooseDestination: async () => {
        dialogShown = true
        return null
      },
      renderPdf: NEVER_PDF
    })
    expect(result).toBeNull()
    expect(dialogShown).toBe(false)
  })
})

// ---- P6: PDF through the SAME pipeline (plan §11; the harness itself is unit + smoke
// tested — here the seam contract, the shared atomic tail, and the format rules) --------

describe('PDF format (P6 plan §11 — same pipeline, same atomic tail)', () => {
  function seedSimpleReview(db: Db): string {
    const answer = seedPackAnswer(db, {
      content: 'PDF claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    return seedEvidenceReview(db, answer).id
  }

  it('prints the rendered HTML verbatim, writes the PDF bytes atomically, records format "pdf"', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const reviewId = seedSimpleReview(db)
    // D-1 one template: the same review exported as HTML first; its history row is removed so the PDF render below
    // reads identical stored state (recording an export touches no review column, evidence-reviews.ts:1146-1177).
    const htmlDest = join(root, 'verbatim.html')
    await exportEvidencePackToFile(db, reviewId, {}, goldenExport(htmlDest))
    const asHtml = readFileSync(htmlDest, 'utf8')
    db.prepare('DELETE FROM evidence_exports WHERE review_id = ?').run(reviewId)
    const dest = join(root, 'pack.pdf')
    const suggested: Array<[string, string]> = []
    let printed: { html: string; opts: Record<string, unknown> } | null = null
    const record = await exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
      chooseDestination: async (name, format) => {
        suggested.push([name, format])
        return dest
      },
      renderPdf: async (html, opts) => {
        printed = { html, opts: { ...opts } }
        return PDF_BYTES
      },
      newPackId: () => FIXED_PACK_ID,
      now: () => FIXED_NOW
    })
    // The suggested name follows the requested format; the dialog is told the format too.
    expect(suggested).toEqual([['Contract questions.pdf', 'pdf']])
    // The print harness got the Phase-3 render output UNCHANGED (D-1: one template): byte for byte the HTML pack,
    // except the one format line…
    const htmlLine = t('en', 'packExport.meta.formatValue', { version: 1 })
    const pdfLine = t('en', 'packExport.meta.formatValuePdf', { version: 1 })
    expect(printed!.html).toBe(asHtml.replaceAll(htmlLine, pdfLine))
    // …and it self-describes as a PDF (FIX-1): the printed rendition line, never the
    // "Self-contained HTML" claim, on the artifact a verifier actually reads. (This pair also proves the line is
    // there at all: without it the replaceAll above would be a no-op.)
    expect(printed!.html).toContain(pdfLine)
    expect(printed!.html).not.toContain(htmlLine)
    // …and the pipeline's pack id for the footer — nothing else: no print-source path, because
    // the printer holds the page in memory (#563; it used to be a `.print.tmp.html` sibling).
    expect(printed!.opts).toEqual({ packId: FIXED_PACK_ID })
    // The destination holds the PRINTER's bytes, atomically, hash-of-file recorded — and it is
    // the only file the export left beside it.
    expect(readFileSync(dest)).toEqual(PDF_BYTES)
    expect(readdirSync(root).filter((f) => f.startsWith('pack.pdf'))).toEqual(['pack.pdf'])
    expect(record).not.toBeNull()
    expect(record!.format).toBe('pdf')
    expect(record!.fileName).toBe('pack.pdf')
    expect(record!.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION)
    expect(record!.fileSha256).toBe(sha256Of(readFileSync(dest)))
    // The format NEVER enters options_json — `evidence_exports.format` is its column.
    expect(record!.options).not.toHaveProperty('format')
  })

  it('the chosen extension has the final word: a .html destination under a PDF request stays HTML (and vice versa)', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const reviewId = seedSimpleReview(db)

    // Requested PDF, saved as .html via the dialog's type dropdown → real HTML, no print.
    const asHtml = join(root, 'flipped.html')
    const first = await exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
      chooseDestination: async () => asHtml,
      renderPdf: NEVER_PDF
    })
    expect(first!.format).toBe('html')
    const flippedHtml = readFileSync(asHtml, 'utf8')
    expect(flippedHtml.startsWith('<!DOCTYPE html>')).toBe(true)
    // FIX-1: the EFFECTIVE format drives the self-description — this file IS HTML.
    expect(flippedHtml).toContain(t('en', 'packExport.meta.formatValue', { version: 1 }))
    expect(flippedHtml).not.toContain(t('en', 'packExport.meta.formatValuePdf', { version: 1 }))

    // Requested (default) HTML, saved as .pdf → printed PDF, recorded as such.
    const asPdf = join(root, 'flipped.pdf')
    const second = await exportEvidencePackToFile(db, reviewId, {}, {
      chooseDestination: async () => asPdf,
      renderPdf: async () => PDF_BYTES
    })
    expect(second!.format).toBe('pdf')
    expect(readFileSync(asPdf)).toEqual(PDF_BYTES)
  })

  it('kill mid-print (a rejecting printer) leaves NO destination file, NO siblings, NO row', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const reviewId = seedSimpleReview(db)
    const dest = join(root, 'killed.pdf')
    await expect(
      exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
        chooseDestination: async () => dest,
        // The harness rejects like a window destroyed mid-print (app quit, crash, wedge).
        renderPdf: async () => {
          throw new Error('Object has been destroyed')
        }
      })
    ).rejects.toThrow('Object has been destroyed')
    expect(existsSync(dest)).toBe(false)
    // No pack residue of ANY kind — destination, atomic tmp, or print source.
    expect(readdirSync(root).filter((f) => !f.startsWith('test.sqlite'))).toEqual([])
    expect(listEvidenceExports(db, reviewId)).toEqual([])
  })

  it('outdated-unacknowledged refuses BEFORE any dialog or print work — the P4 order holds for PDF', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const docId = seedSourceDocument(db, { title: 'drift.pdf', sha256: 'ab'.repeat(32), mime: 'application/pdf' })
    const answer = seedPackAnswer(db, {
      content: 'Drifting claim. [S1]',
      citations: [
        { label: 'S1', sourceTitle: 'drift.pdf', documentId: docId, snippet: 'The drifting fact.' }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const reviewId = seedEvidenceReview(db, answer).id
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)

    let dialogShown = false
    let printCalled = false
    await expect(
      exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
        chooseDestination: async () => {
          dialogShown = true
          return join(root, 'refused.pdf')
        },
        renderPdf: async () => {
          printCalled = true
          return PDF_BYTES
        }
      })
    ).rejects.toBeInstanceOf(EvidencePackOutdatedError)
    expect(dialogShown).toBe(false)
    expect(printCalled).toBe(false)
    expect(listEvidenceExports(db, reviewId)).toEqual([])

    // Acknowledged → the PDF path unlocks like HTML did in P4.
    expect(acknowledgeEvidenceReviewFreshness(db, reviewId)!.acknowledgedAt).toBeTruthy()
    const dest = join(root, 'acked.pdf')
    const record = await exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
      chooseDestination: async () => dest,
      renderPdf: async () => PDF_BYTES
    })
    expect(record!.format).toBe('pdf')
  })

  it('cancel under a PDF request: no print, no file, no row (FIX-3)', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const reviewId = seedSimpleReview(db)
    let printCalled = false
    const result = await exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
      chooseDestination: async () => null,
      renderPdf: async () => {
        printCalled = true
        return PDF_BYTES
      }
    })
    expect(result).toBeNull()
    expect(printCalled).toBe(false)
    expect(readdirSync(root).filter((f) => !f.startsWith('test.sqlite'))).toEqual([])
    expect(listEvidenceExports(db, reviewId)).toEqual([])
  })
})

describe('encoding + hash + record contents', () => {
  it('writes UTF-8 WITHOUT a BOM, meta charset present, umlauts intact; recorded hash matches the file bytes', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const answer = seedPackAnswer(db, {
      content: 'Größenmaßstäbe prüfen — ausschließlich örtlich. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'maß.pdf', snippet: 'Straße & Größe <> "quote" \'tick\'' }],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = seedEvidenceReview(db, answer)
    const dest = join(root, 'encoding.html')
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'de' }, goldenExport(dest))
    const bytes = readFileSync(dest)
    // No BOM: the file opens with '<' (0x3C) — the bomFor policy deliberately excludes
    // .html (the meta charset is the encoding contract).
    expect(bytes[0]).toBe(0x3c)
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
    const text = bytes.toString('utf8')
    expect(text).toContain('<meta charset="utf-8">')
    expect(text).toContain('Größenmaßstäbe')
    // The recorded hash IS the on-disk bytes' hash (spec §16.1.9).
    expect(record?.fileSha256).toBe(sha256Of(bytes))
    // D-8: bare file name only, schema version stamped, resolved options persisted.
    expect(record?.fileName).toBe('encoding.html')
    expect(record?.fileName.includes(root)).toBe(false)
    expect(record?.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION)
    expect(record?.options).toMatchObject({
      language: 'de',
      includeReviewerNotes: true,
      includeSourceExcerpts: true,
      includeDocumentHashes: true,
      includeUnreviewedItems: true,
      includeTechnicalDetails: false
    })
    // Round-trips through the read side (export history renders from this).
    const readBack = listEvidenceExports(db, detail.id)
    expect(readBack).toHaveLength(1)
    expect(readBack[0]!.fileSha256).toBe(record!.fileSha256)
    expect(readBack[0]!.options?.language).toBe('de')
  })

  it('two exports of one review append history newest-first and the pack states the previous export', async () => {
    const { db, root } = freshWorkspaceDb('eppack')
    const answer = seedPackAnswer(db, {
      content: 'History claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = seedEvidenceReview(db, answer)
    const first = await exportEvidencePackToFile(db, detail.id, {}, {
      chooseDestination: async () => join(root, 'one.html'),
      renderPdf: NEVER_PDF,
      now: () => '2026-07-18T10:00:00.000Z'
    })
    const second = await exportEvidencePackToFile(db, detail.id, {}, {
      chooseDestination: async () => join(root, 'two.html'),
      renderPdf: NEVER_PDF,
      now: () => '2026-07-18T11:00:00.000Z'
    })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    const history = listEvidenceExports(db, detail.id)
    expect(history.map((h) => h.fileName)).toEqual(['two.html', 'one.html'])
    // The SECOND pack's summary honestly names the previous export stamp.
    expect(readFileSync(join(root, 'two.html'), 'utf8')).toContain('Previous export')
  })
})

describe('helpers', () => {
  it('suggestedPackFileName slugs content titles, never returns empty, and follows the format (P6)', () => {
    expect(suggestedPackFileName('Contract questions', 'html')).toBe('Contract questions.html')
    expect(suggestedPackFileName('a/b\\c:d*e?f"g<h>i|j', 'html')).toBe('abcdefghij.html')
    expect(suggestedPackFileName('   ', 'html')).toBe('evidence-pack.html')
    expect(suggestedPackFileName('<script>', 'html')).toBe('script.html')
    expect(suggestedPackFileName('Ärger — größer', 'html')).toBe('Ärger  größer.html')
    expect(suggestedPackFileName('Contract questions', 'pdf')).toBe('Contract questions.pdf')
    expect(suggestedPackFileName('   ', 'pdf')).toBe('evidence-pack.pdf')
    // #839 P1h: the stem stops at 60 characters, counted in code points, so the cut never leaves half an astral
    // letter (U+20000, CJK Ext-B: two UTF-16 units) as a lone surrogate in the suggested name.
    expect(suggestedPackFileName('A'.repeat(100), 'html')).toBe(`${'A'.repeat(60)}.html`)
    const astral = '\u{20000}'
    expect(suggestedPackFileName(`${'A'.repeat(59)}${astral}${astral}`, 'pdf')).toBe(`${'A'.repeat(59)}${astral}.pdf`)
    // A cut that lands on a space leaves no space before the extension.
    expect(suggestedPackFileName(`${'A'.repeat(59)} Clause 7`, 'html')).toBe(`${'A'.repeat(59)}.html`)
  })

  // #899: the pack name goes through the shared file-name rule (file-name-stem.test.ts owns it). It used to strip
  // combining marks, so vowel signs and a decomposed accent were lost.
  it('suggestedPackFileName keeps the vowel signs and accents of a title, composing a decomposed one (#899)', () => {
    expect(suggestedPackFileName('हिन्दी', 'html')).toBe('हिन्दी.html')
    expect(suggestedPackFileName('Pru\u0308fung', 'pdf')).toBe('Pr\u00fcfung.pdf')
    expect(suggestedPackFileName('Report (draft)', 'html')).toBe('Report draft.html') // ( ) only in document exports
  })

  // AUD-15: the writer is ASYNC (fs.promises + a FileHandle fsync) so a multi-MB pack no
  // longer stalls the Electron main thread. The CONTRACT below is unchanged — write-through
  // to disk, the hash taken from the bytes read back, no tmp sibling left behind.
  // AUD-17: the tmp sibling is named from the EXPORT's pack id, so two exports to one
  // destination never write the same scratch file (`packTmpPath`).
  it('writePackFileAtomic writes-through and returns the on-disk hash', async () => {
    const { root } = freshWorkspaceDb('eppack')
    const dest = join(root, 'atomic.html')
    const hash = await writePackFileAtomic(dest, 'content-ä', FIXED_PACK_ID)
    expect(readFileSync(dest, 'utf8')).toBe('content-ä')
    expect(hash).toBe(sha256Of(readFileSync(dest)))
    expect(existsSync(packTmpPath(dest, FIXED_PACK_ID))).toBe(false)
    // Nothing scratch-like survives under ANY name.
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('writePackFileAtomic writes Buffer content VERBATIM (P6: the printToPDF bytes)', async () => {
    const { root } = freshWorkspaceDb('eppack')
    const dest = join(root, 'atomic.pdf')
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80])
    const hash = await writePackFileAtomic(dest, bytes, FIXED_PACK_ID)
    expect(readFileSync(dest)).toEqual(bytes)
    expect(hash).toBe(sha256Of(bytes))
    expect(existsSync(packTmpPath(dest, FIXED_PACK_ID))).toBe(false)
  })

  it('resolvePackExportFormat: literal "pdf" only; everything else reads html (P6)', () => {
    expect(resolvePackExportFormat({ format: 'pdf' })).toBe('pdf')
    expect(resolvePackExportFormat({ format: 'html' })).toBe('html')
    expect(resolvePackExportFormat({ format: 'PDF' })).toBe('html') // never normalized
    expect(resolvePackExportFormat({ format: 'docx' })).toBe('html')
    expect(resolvePackExportFormat({})).toBe('html')
    expect(resolvePackExportFormat(null)).toBe('html')
    expect(resolvePackExportFormat('pdf')).toBe('html') // not an object → default
  })

  it('packFormatForDestination: the extension wins, case-insensitively; else the request (P6)', () => {
    expect(packFormatForDestination('C:/x/pack.pdf', 'html')).toBe('pdf')
    expect(packFormatForDestination('C:/x/pack.PDF', 'html')).toBe('pdf')
    expect(packFormatForDestination('/x/pack.html', 'pdf')).toBe('html')
    expect(packFormatForDestination('/x/pack.htm', 'pdf')).toBe('html')
    expect(packFormatForDestination('/x/pack.dat', 'pdf')).toBe('pdf')
    expect(packFormatForDestination('/x/pack', 'pdf')).toBe('pdf')
    expect(packFormatForDestination('/x/pack', 'html')).toBe('html')
  })

  // AUD-17: the one owner of the `packTmpPath` naming rule (moved from evidence-pack-export-concurrent.test.ts).
  it('the tmp-sibling naming rule keeps a hostile pack id out of the file system', () => {
    const A = '11111111-1111-4111-8111-111111111111'
    const B = '22222222-2222-4222-8222-222222222222'
    const dest = join(tempRoot('eppack'), 'pack.pdf')
    // An id that sanitises away entirely (only reachable through an injected mint) still yields
    // a unique hex name rather than a bare dot.
    const empty = packTmpPath(dest, '///')
    expect(empty.slice(dest.length)).toMatch(/^\.[0-9a-f]{32}\.tmp$/)
    expect(packTmpPath(dest, '///')).not.toBe(empty)
    expect(packTmpPath(dest, A)).toBe(`${dest}.${A.replace(/-/g, '')}.tmp`)
    expect(packTmpPath(dest, A)).not.toBe(packTmpPath(dest, B))
    expect(packTmpPath(dest, '../../etc/passwd')).toBe(`${dest}.etcpasswd.tmp`)
    expect(packTmpPath(dest, 'z'.repeat(500))).toBe(`${dest}.${'z'.repeat(32)}.tmp`)
  })
})
