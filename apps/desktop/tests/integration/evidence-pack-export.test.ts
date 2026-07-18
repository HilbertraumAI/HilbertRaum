import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installOfflineNetworkGuard } from '../../src/main/services/offlineGuard'
import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createEvidenceReviewFromMessage } from '../../src/main/services/evidence-pack/snapshot'
import {
  exportEvidencePackToFile,
  packFormatForDestination,
  resolvePackExportFormat,
  suggestedPackFileName,
  writePackFileAtomic,
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
import type { Citation, CoverageInfo } from '../../src/shared/types'

// EP-1 plan §8 exit gate (spec §30 Phase-2 gate) — the export pipeline end to end against
// a real SQLite workspace: DETERMINISTIC GOLDEN PACKS for the five spec §29.5 classes
// (relevance / whole-doc / partial-coverage / missing-source / German) plus the P4
// outdated-acknowledged pack (spec §28.6 — six goldens total), the §20.3/§28.9
// ATOMICITY guarantees (failure ⇒ no destination file, no export row), encoding (UTF-8,
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

let offlineViolations: string[] = []
let uninstallGuard: () => void = () => {}

beforeEach(() => {
  offlineViolations = []
  uninstallGuard = installOfflineNetworkGuard({
    offline: true,
    onViolation: (host) => offlineViolations.push(host)
  })
})

afterEach(() => {
  uninstallGuard()
  expect(offlineViolations).toEqual([])
})

function freshDb(): { db: Db; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-eppack-'))
  return { db: openDatabase(join(root, 'test.sqlite')), root }
}

function seedDocument(db: Db, opts: { title: string; sha256?: string; mime?: string }): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'indexed', ?, ?)`
  ).run(id, opts.title, opts.mime ?? 'application/pdf', opts.sha256 ?? 'ab'.repeat(32), now, now)
  return id
}

function seedAnswer(
  db: Db,
  opts: {
    content: string
    citations?: Citation[] | null
    coverage?: CoverageInfo | null
    question?: string
    title?: string
    truncated?: boolean
  }
): string {
  const conv = createConversation(db, { title: opts.title ?? 'Contract questions', modelId: 'test-model-q4' })
  appendMessage(db, {
    conversationId: conv.id,
    role: 'user',
    content: opts.question ?? 'What about termination?'
  })
  const msg = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: opts.content,
    citations: opts.citations ?? null,
    coverage: opts.coverage ?? null,
    truncated: opts.truncated
  })
  return msg.id
}

/** P6: the printer seam is REQUIRED — this stub doubles as the assertion that no
 *  HTML-format path ever touches the hidden-window print harness. */
const NEVER_PDF: Parameters<typeof exportEvidencePackToFile>[3]['renderPdf'] = async () => {
  throw new Error('renderPdf must not be called for an HTML export')
}

const EXPORT_DEPS = (dest: string): Parameters<typeof exportEvidencePackToFile>[3] => ({
  chooseDestination: async () => dest,
  renderPdf: NEVER_PDF,
  newPackId: () => FIXED_PACK_ID,
  now: () => FIXED_NOW
})

/** Normalize the run-dependent bytes exactly as spec §29.5 prescribes: timestamps + pack
 *  ids (every timestamp renders through the ONE deterministic formatter). */
function normalize(html: string): string {
  return html
    .replaceAll(FIXED_PACK_ID, 'PACK_ID')
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\b/g, 'TIMESTAMP')
}

function compareGolden(name: string, html: string): void {
  const normalized = normalize(html)
  const goldenPath = join(GOLDEN_DIR, `${name}.html`)
  if (process.env.UPDATE_EVIDENCE_PACK_GOLDENS) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(goldenPath, normalized, 'utf8')
    return
  }
  expect(existsSync(goldenPath), `golden missing: ${goldenPath} (run with UPDATE_EVIDENCE_PACK_GOLDENS=1)`).toBe(true)
  expect(normalized).toBe(readFileSync(goldenPath, 'utf8'))
}

// ---- The six golden classes (the five spec §29.5 classes + P4 outdated-acknowledged) --

describe('golden packs (deterministic; spec §29.5)', () => {
  it('relevance pack — ready review, notes, links, ready-review export allowed', async () => {
    const { db, root } = freshDb()
    const docId = seedDocument(db, { title: 'contract.pdf', sha256: 'ab'.repeat(32) })
    const messageId = seedAnswer(db, {
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
    const detail = createEvidenceReviewFromMessage(db, messageId, {
      appVersion: '0.1.52-test',
      modelDisplayName: () => 'Test Model'
    })
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
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'en' }, EXPORT_DEPS(dest))
    expect(record).not.toBeNull()
    compareGolden('relevance', readFileSync(dest, 'utf8'))
  })

  it('whole-document pack — provenance wording, zero auto-links', async () => {
    const { db, root } = freshDb()
    const docId = seedDocument(db, { title: 'report.pdf', sha256: 'cd'.repeat(32) })
    const messageId = seedAnswer(db, {
      content: 'The report concludes X.\n\nSection provenance follows. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'report.pdf', documentId: docId, snippet: 'Chapter 2 overview.' }],
      coverage: { mode: 'tree', chunksCovered: 40, chunksTotal: 40 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {
      appVersion: '0.1.52-test',
      modelDisplayName: () => 'Test Model'
    })
    const dest = join(root, 'whole-doc.html')
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'en' }, EXPORT_DEPS(dest))
    expect(record).not.toBeNull()
    const html = readFileSync(dest, 'utf8')
    // The load-bearing §24.3 claim: provenance, never citations; zero answer_marker links.
    expect(html).toContain('whole-document analysis')
    expect(html).not.toContain('Cited by the answer')
    compareGolden('whole-doc', html)
  })

  it('partial-coverage pack — capped mode + recorded output truncation warn honestly', async () => {
    const { db, root } = freshDb()
    const docId = seedDocument(db, { title: 'ledger.xlsx', mime: 'application/vnd.ms-excel', sha256: 'ee'.repeat(32) })
    const messageId = seedAnswer(db, {
      content: 'Partial listing of entries.\n\nOnly the beginning was analyzed.',
      citations: [{ label: 'S1', sourceTitle: 'ledger.xlsx', documentId: docId, snippet: 'Rows 1-100.' }],
      coverage: { mode: 'capped', chunksCovered: 3, chunksTotal: 9, truncated: true },
      truncated: true
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {
      appVersion: '0.1.52-test',
      modelDisplayName: () => 'Test Model'
    })
    const dest = join(root, 'partial-coverage.html')
    await exportEvidencePackToFile(db, detail.id, { language: 'en' }, EXPORT_DEPS(dest))
    const html = readFileSync(dest, 'utf8')
    expect(html).toContain('3 of 9')
    compareGolden('partial-coverage', html)
  })

  it('missing-source pack — resolved-but-missing DISTINCT from unresolved identity', async () => {
    const { db, root } = freshDb()
    // Two docs with the SAME title → the legacy citation stays identity:'unresolved';
    // a documentId pointing at NO row → resolved + availability 'missing'.
    seedDocument(db, { title: 'notes.docx' })
    seedDocument(db, { title: 'notes.docx' })
    const messageId = seedAnswer(db, {
      content: 'Claim about the deleted source. [S1]\n\nClaim about the ambiguous source. [S2]',
      citations: [
        { label: 'S1', sourceTitle: 'gone.pdf', documentId: 'no-such-doc', snippet: 'Old excerpt.' },
        { label: 'S2', sourceTitle: 'notes.docx', snippet: 'Ambiguous excerpt.' }
      ],
      coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 2 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {
      appVersion: '0.1.52-test',
      modelDisplayName: () => 'Test Model'
    })
    const dest = join(root, 'missing-source.html')
    await exportEvidencePackToFile(db, detail.id, { language: 'en' }, EXPORT_DEPS(dest))
    const html = readFileSync(dest, 'utf8')
    expect(html).toContain('could not be verified')
    expect(html).toContain('already missing')
    compareGolden('missing-source', html)
  })

  it('outdated-acknowledged pack — P4 (spec §28.6): the pack records the mismatch + acknowledge', async () => {
    const { db, root } = freshDb()
    const docId = seedDocument(db, { title: 'contract.pdf', sha256: 'ab'.repeat(32) })
    const messageId = seedAnswer(db, {
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
    const detail = createEvidenceReviewFromMessage(db, messageId, {
      appVersion: '0.1.52-test',
      modelDisplayName: () => 'Test Model'
    })
    // The source document CHANGES after the review (stored hash updated by re-ingestion) —
    // the review is outdated; export works only after the explicit acknowledge (§28.6).
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)
    expect(acknowledgeEvidenceReviewFreshness(db, detail.id)?.acknowledgedAt).toBeTruthy()

    const dest = join(root, 'outdated-acknowledged.html')
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'en' }, EXPORT_DEPS(dest))
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
    const { db, root } = freshDb()
    const docId = seedDocument(db, { title: 'vertrag.pdf', sha256: 'ab'.repeat(32) })
    const messageId = seedAnswer(db, {
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
    const detail = createEvidenceReviewFromMessage(db, messageId, {
      appVersion: '0.1.52-test',
      modelDisplayName: () => 'Test Model'
    })
    const dest = join(root, 'german.html')
    await exportEvidencePackToFile(db, detail.id, { language: 'de' }, EXPORT_DEPS(dest))
    const html = readFileSync(dest, 'utf8')
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('[Q1]') // DE display marker
    expect(html).toContain('Nachweispaket')
    expect(html).toContain('ausschließlich') // umlaut/ß round-trip
    compareGolden('german', html)
  })
})

// ---- Pipeline guarantees -----------------------------------------------------------

describe('atomicity + failure semantics (spec §20.3/§28.9)', () => {
  it('a failing write leaves NO destination file, NO tmp sibling, NO export row', async () => {
    const { db, root } = freshDb()
    const messageId = seedAnswer(db, {
      content: 'Plain claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    // Destination inside a directory that does not exist → openSync throws mid-pipeline.
    const dest = join(root, 'no-such-dir', 'pack.html')
    await expect(
      exportEvidencePackToFile(db, detail.id, {}, EXPORT_DEPS(dest))
    ).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
    expect(listEvidenceExports(db, detail.id)).toEqual([])
    // The review itself stays usable (spec §28.9).
    expect(getEvidenceReview(db, detail.id)?.status).toBe('draft')
  })

  it('a failure AFTER the tmp write (rename refused) removes the tmp and records nothing', async () => {
    const { db, root } = freshDb()
    const messageId = seedAnswer(db, {
      content: 'Another claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    // The destination IS an existing non-empty DIRECTORY → renameSync throws after the
    // bytes hit the tmp sibling — the interrupted-mid-pipeline case.
    const dest = join(root, 'occupied')
    mkdirSync(join(dest, 'child'), { recursive: true })
    await expect(
      exportEvidencePackToFile(db, detail.id, {}, EXPORT_DEPS(dest))
    ).rejects.toThrow()
    expect(existsSync(`${dest}.tmp`)).toBe(false)
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(listEvidenceExports(db, detail.id)).toEqual([])
  })

  it('cancel (no destination chosen) records nothing and writes nothing', async () => {
    const { db, root } = freshDb()
    const messageId = seedAnswer(db, {
      content: 'Cancelled claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    const result = await exportEvidencePackToFile(db, detail.id, {}, {
      chooseDestination: async () => null,
      renderPdf: NEVER_PDF
    })
    expect(result).toBeNull()
    expect(listEvidenceExports(db, detail.id)).toEqual([])
    expect(readdirSync(root).filter((f) => f.endsWith('.html') || f.endsWith('.tmp'))).toEqual([])
  })

  it('FIX-1a: a record failure AFTER the rename unlinks the file — no destination, no row, distinct error', async () => {
    const { db, root } = freshDb()
    const messageId = seedAnswer(db, {
      content: 'Post-rename claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
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
    expect(existsSync(`${dest}.tmp`)).toBe(false)
    // …and no row exists (trigger removed so the read runs clean).
    db.exec('DROP TRIGGER fail_export')
    expect(listEvidenceExports(db, detail.id)).toEqual([])
    // The review itself stays usable.
    expect(getEvidenceReview(db, detail.id)?.status).toBe('draft')
  })

  it('FIX-1b: review deleted while the save dialog was open → file unlinked, thrown — NEVER a silent cancel-shaped null', async () => {
    const { db, root } = freshDb()
    const messageId = seedAnswer(db, {
      content: 'Deleted-mid-dialog claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    const dest = join(root, 'deleted-mid-dialog.html')
    await expect(
      exportEvidencePackToFile(db, detail.id, {}, {
        chooseDestination: async () => {
          // Another window deletes the review while this one's dialog is open —
          // recordEvidenceExport will return null (its no-orphan-rows guard).
          expect(deleteEvidenceReview(db, detail.id)).toBe(true)
          return dest
        },
        renderPdf: NEVER_PDF
      })
    ).rejects.toBeInstanceOf(EvidencePackRecordError)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.tmp`)).toBe(false)
  })

  it('unknown review id → null, no dialog shown', async () => {
    const { db } = freshDb()
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
  const PDF_BYTES = Buffer.from('%PDF-1.7\nfake-pack-pdf-bytes\n%%EOF', 'utf8')

  function seedSimpleReview(db: Db): string {
    const messageId = seedAnswer(db, {
      content: 'PDF claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    return createEvidenceReviewFromMessage(db, messageId, {}).id
  }

  it('prints the rendered HTML verbatim, writes the PDF bytes atomically, records format "pdf"', async () => {
    const { db, root } = freshDb()
    const reviewId = seedSimpleReview(db)
    const dest = join(root, 'pack.pdf')
    const suggested: Array<[string, string]> = []
    let printed: { html: string; packId: string; sourceHtmlPath: string } | null = null
    const record = await exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
      chooseDestination: async (name, format) => {
        suggested.push([name, format])
        return dest
      },
      renderPdf: async (html, opts) => {
        printed = { html, ...opts }
        return PDF_BYTES
      },
      newPackId: () => FIXED_PACK_ID,
      now: () => FIXED_NOW
    })
    // The suggested name follows the requested format; the dialog is told the format too.
    expect(suggested).toEqual([['Contract questions.pdf', 'pdf']])
    // The print harness got the Phase-3 render output UNCHANGED (D-1: one template)…
    expect(printed!.html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(printed!.html).toContain(FIXED_PACK_ID)
    // …the pipeline's pack id for the footer, and a `.html` print-source SIBLING of the
    // destination (file:// MIME is sniffed from the extension).
    expect(printed!.packId).toBe(FIXED_PACK_ID)
    expect(printed!.sourceHtmlPath).toBe(`${dest}.print.tmp.html`)
    // The destination holds the PRINTER's bytes, atomically, hash-of-file recorded.
    expect(readFileSync(dest)).toEqual(PDF_BYTES)
    expect(existsSync(`${dest}.tmp`)).toBe(false)
    expect(record).not.toBeNull()
    expect(record!.format).toBe('pdf')
    expect(record!.fileName).toBe('pack.pdf')
    expect(record!.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION)
    expect(record!.fileSha256).toBe(sha256Of(readFileSync(dest)))
    // The format NEVER enters options_json — `evidence_exports.format` is its column.
    expect(record!.options).not.toHaveProperty('format')
  })

  it('the chosen extension has the final word: a .html destination under a PDF request stays HTML (and vice versa)', async () => {
    const { db, root } = freshDb()
    const reviewId = seedSimpleReview(db)

    // Requested PDF, saved as .html via the dialog's type dropdown → real HTML, no print.
    const asHtml = join(root, 'flipped.html')
    const first = await exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
      chooseDestination: async () => asHtml,
      renderPdf: NEVER_PDF
    })
    expect(first!.format).toBe('html')
    expect(readFileSync(asHtml, 'utf8').startsWith('<!DOCTYPE html>')).toBe(true)

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
    const { db, root } = freshDb()
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
    const { db, root } = freshDb()
    const docId = seedDocument(db, { title: 'drift.pdf', sha256: 'ab'.repeat(32) })
    const messageId = seedAnswer(db, {
      content: 'Drifting claim. [S1]',
      citations: [
        { label: 'S1', sourceTitle: 'drift.pdf', documentId: docId, snippet: 'The drifting fact.' }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const reviewId = createEvidenceReviewFromMessage(db, messageId, {}).id
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

  it('post-rename record failure unlinks the PDF too — the SAME tail semantics (P3 FIX-1b)', async () => {
    const { db, root } = freshDb()
    const reviewId = seedSimpleReview(db)
    const dest = join(root, 'unrecorded.pdf')
    await expect(
      exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
        chooseDestination: async () => {
          expect(deleteEvidenceReview(db, reviewId)).toBe(true)
          return dest
        },
        renderPdf: async () => PDF_BYTES
      })
    ).rejects.toBeInstanceOf(EvidencePackRecordError)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.tmp`)).toBe(false)
  })
})

describe('encoding + hash + record contents', () => {
  it('writes UTF-8 WITHOUT a BOM, meta charset present, umlauts intact; recorded hash matches the file bytes', async () => {
    const { db, root } = freshDb()
    const messageId = seedAnswer(db, {
      content: 'Größenmaßstäbe prüfen — ausschließlich örtlich. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'maß.pdf', snippet: 'Straße & Größe <> "quote" \'tick\'' }],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    const dest = join(root, 'encoding.html')
    const record = await exportEvidencePackToFile(db, detail.id, { language: 'de' }, EXPORT_DEPS(dest))
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
    const { db, root } = freshDb()
    const messageId = seedAnswer(db, {
      content: 'History claim.',
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
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
  })

  it('writePackFileAtomic writes-through and returns the on-disk hash', () => {
    const { root } = freshDb()
    const dest = join(root, 'atomic.html')
    const hash = writePackFileAtomic(dest, 'content-ä')
    expect(readFileSync(dest, 'utf8')).toBe('content-ä')
    expect(hash).toBe(sha256Of(readFileSync(dest)))
    expect(existsSync(`${dest}.tmp`)).toBe(false)
  })

  it('writePackFileAtomic writes Buffer content VERBATIM (P6: the printToPDF bytes)', () => {
    const { root } = freshDb()
    const dest = join(root, 'atomic.pdf')
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80])
    const hash = writePackFileAtomic(dest, bytes)
    expect(readFileSync(dest)).toEqual(bytes)
    expect(hash).toBe(sha256Of(bytes))
    expect(existsSync(`${dest}.tmp`)).toBe(false)
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
})
