import { describe, it, expect } from 'vitest'
import {
  buildEvidencePackModel,
  resolveEvidencePackOptions
} from '../../src/main/services/evidence-pack/pack-model'
import {
  escapeHtml,
  formatPackTimestamp,
  renderEvidencePackHtml
} from '../../src/main/services/evidence-pack/render-html'
import { EVIDENCE_PACK_OPTION_DEFAULTS } from '../../src/shared/evidence-review'
import { t } from '../../src/shared/i18n'
import type { EvidencePackOptions, EvidenceReviewDetail } from '../../src/shared/types'
import { makeDetail, makeItem } from '../helpers/evidenceReview'

// EP-1 plan §8.2 — the pure HTML renderer: the new `escapeHtml` primitive, the spec §29.4
// injection suite (hostile markdown/HTML/script in answer, snippets, notes, titles →
// escaped in output), the §17.2 self-containment rules (zero scripts, zero remote refs,
// embedded styles), the D-1 print contract Phase 6 depends on (@page A4, break-inside,
// h1–h3 semantic hierarchy, system fonts, grayscale warnings), EN/DE localization frozen
// at generation, and byte determinism.

const META = {
  packId: '00000000-0000-4000-8000-000000000001',
  generatedAt: '2026-07-18T12:34:00.000Z',
  format: 'html'
} as const

function opts(over: Partial<EvidencePackOptions> = {}): EvidencePackOptions {
  return { language: 'en', ...EVIDENCE_PACK_OPTION_DEFAULTS, ...over }
}

function render(detail: EvidenceReviewDetail, over: Partial<EvidencePackOptions> = {}): string {
  return renderEvidencePackHtml(buildEvidencePackModel(detail, opts(over), META))
}

describe('escapeHtml (the widened xmlEscape primitive)', () => {
  it('escapes all five breakout characters', () => {
    expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&#39;z&quot;)&lt;/script&gt;'
    )
  })

  it('leaves plain text (incl. unicode) untouched', () => {
    expect(escapeHtml('Straße § 12 — geändert ✓')).toBe('Straße § 12 — geändert ✓')
  })
})

describe('formatPackTimestamp (deterministic, locale-independent)', () => {
  it('renders UTC YYYY-MM-DD HH:MM', () => {
    expect(formatPackTimestamp('2026-07-18T12:34:56.789Z')).toBe('2026-07-18 12:34 UTC')
    // Offset input normalizes to UTC — machine-independent.
    expect(formatPackTimestamp('2026-07-18T14:34:00.000+02:00')).toBe('2026-07-18 12:34 UTC')
  })

  it('passes unparseable input through verbatim (never invents a date)', () => {
    expect(formatPackTimestamp('not-a-date')).toBe('not-a-date')
  })

  it('passes ZONE-LESS input through verbatim — host-local parsing would be TZ-dependent and stamping UTC would invent a zone (FIX-4)', () => {
    expect(formatPackTimestamp('2026-07-18T12:00:00')).toBe('2026-07-18T12:00:00')
    expect(formatPackTimestamp('2026-07-18T12:00:00.000')).toBe('2026-07-18T12:00:00.000')
    expect(formatPackTimestamp('2026-07-18')).toBe('2026-07-18')
    // Explicitly-zoned forms still format.
    expect(formatPackTimestamp('2026-07-18T12:00:00+00:00')).toBe('2026-07-18 12:00 UTC')
    expect(formatPackTimestamp('2026-07-18T12:00:00z')).toBe('2026-07-18 12:00 UTC')
  })
})

describe('injection suite (spec §29.4)', () => {
  const HOSTILE = `<script>fetch('http://evil.example')</script><img src=x onerror=alert(1)>"'&`

  it('escapes hostile content in answer, question, notes, titles, snippets, labels', () => {
    const detail = makeDetail({
      title: `${HOSTILE} title`,
      questionSnapshot: `${HOSTILE} question`,
      answerSnapshot: `${HOSTILE} answer [S1]`,
      generalNote: `${HOSTILE} note`,
      reviewerLabel: `${HOSTILE} label`,
      items: [
        makeItem({
          id: 'i1',
          textSnapshot: `${HOSTILE} item`,
          reviewerNote: `${HOSTILE} item-note`,
          decision: 'supported',
          links: [{ evidenceKey: `s1${HOSTILE}`, origin: 'answer_marker', relation: null }]
        })
      ],
      // FIX-6: a hostile RAW coverage mode (reachable — parseCoverage accepts any string)
      // flows into the technical section's answerModeRaw mono span.
      coverageSnapshot: {
        mode: HOSTILE,
        chunksCovered: 1,
        chunksTotal: 2
      } as unknown as import('../../src/shared/types').CoverageInfo,
      sources: [
        {
          // FIX-6: hostile strings through the technical-details surfaces too — key
          // (techSourceKeys), machineLabel, documentSha256 all render in mono spans.
          key: `s1${HOSTILE}`,
          machineLabel: `S1${HOSTILE}`,
          kind: 'direct_excerpt',
          identity: 'resolved',
          documentId: 'd1',
          documentTitle: `${HOSTILE} doc.pdf`,
          documentSha256: `${HOSTILE}${'ab'.repeat(16)}`,
          mimeType: `${HOSTILE}/pdf`,
          pageNumber: 3,
          sectionLabel: `${HOSTILE} §4`,
          snippet: `${HOSTILE} snippet`,
          sourceChunkId: null,
          availabilityAtCreation: 'available'
        }
      ],
      generationSnapshot: {
        generatedAt: '2026-07-18T09:00:00.000Z',
        modelId: `${HOSTILE}-model`,
        modelDisplayName: `${HOSTILE} Model`,
        skillId: null,
        skillDisplayName: `${HOSTILE} Skill`,
        appVersion: `${HOSTILE}-v1`,
        answerTruncated: false,
        answerMode: 'relevance'
      }
    })
    const html = render(detail, { includeTechnicalDetails: true })
    expect(html).not.toContain('<script')
    // No REAL tag can carry the handler — the escaped text may contain the substring.
    expect(html).not.toMatch(/<[a-z][^>]*onerror/i)
    expect(html).not.toContain('<img')
    // The payload IS present — escaped, not silently dropped.
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // FIX-6: the structural remote-ref/self-containment sweep over the HOSTILE render
    // (not only the benign one): no real element, no attribute or CSS can reference out.
    expect(html).not.toMatch(/<(?:script|img|link|iframe|object|embed|form)\b/i)
    expect(html).not.toMatch(/<[a-z][^>]*\bon\w+\s*=/i)
    expect(html).not.toMatch(/(?:href|src)\s*=\s*["']?\s*(?:https?:|javascript:|data:)/i)
    expect(html).not.toMatch(/url\s*\(|@import|@font-face/i)
    expect(html.match(/<style>/g)).toHaveLength(1)
    // Every internal anchor stays index-derived even with a hostile source KEY.
    expect(html).not.toMatch(/href="(?!#)/)
    expect(html).toContain('id="src-1"')
  })

  it('keeps hostile markdown inert (rendered as escaped plain text, never as markup)', () => {
    const detail = makeDetail({
      answerSnapshot: '[click](javascript:alert(1)) <iframe src="https://x"></iframe>'
    })
    const html = render(detail)
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('&lt;iframe')
  })
})

describe('self-containment (spec §17.2) + print contract (plan §4 D-1)', () => {
  const html = render(makeDetail())

  it('contains zero scripts and zero remote references', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\bhttps?:\/\//i)
    expect(html).not.toMatch(/url\s*\(/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/@font-face/i)
    expect(html).not.toMatch(/<link/i)
    expect(html).not.toMatch(/<img/i)
  })

  it('embeds exactly one stylesheet and declares utf-8', () => {
    expect(html.match(/<style>/g)).toHaveLength(1)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('honors the D-1 print contract: @page A4, break-inside, system fonts', () => {
    expect(html).toContain('@page { size: A4;')
    expect(html).toContain('break-inside: avoid')
    expect(html).toContain('font-family: system-ui')
    expect(html).toContain('@media print')
  })

  it('keeps the h1–h3 hierarchy semantic (the Phase-6 bookmark tree)', () => {
    expect(html.match(/<h1>/g)).toHaveLength(1)
    // Eight section heads after the cover (§16.1 sections 2–9).
    expect(html.match(/<h2>/g)).toHaveLength(8)
    expect((html.match(/<h3>/g) ?? []).length).toBeGreaterThan(0)
    expect(html).not.toMatch(/<h[4-6]>/)
  })

  it('warning blocks are grayscale-readable (border + icon + text, never color-only)', () => {
    expect(html).toContain('class="warning"')
    expect(html).toContain('⚠')
  })

  it('anchors are index-derived and internal only', () => {
    expect(html).toContain('id="src-1"')
    expect(html).toContain('href="#src-1"')
    expect(html).not.toMatch(/href="(?!#)/)
  })
})

describe('localization frozen at generation (plan §8.2)', () => {
  it('renders the DE pack in German with [Q{n}] display markers, code spans literal', () => {
    const detail = makeDetail({
      answerSnapshot: 'Alpha [S1]\n\n`[S1] literal` und\n\n```\n[S1] fenced\n```'
    })
    const de = render(detail, { language: 'de' })
    expect(de).toContain('<html lang="de">')
    expect(de).toContain(t('de', 'packExport.section.qa'))
    expect(de).toContain(t('de', 'packExport.privacy'))
    // Prose marker localizes ([Q1]); code-span and fenced markers stay [S1].
    expect(de).toContain('Alpha [Q1]')
    expect(de).toContain('`[S1] literal`')
    expect(de).toContain('[S1] fenced')
    const en = render(detail)
    expect(en).toContain('<html lang="en">')
    expect(en).toContain('Alpha [S1]')
    expect(en).toContain(t('en', 'packExport.section.qa'))
  })
})

describe('option flags in the rendered pack (spec §16.2)', () => {
  const detail = makeDetail({
    generalNote: 'NOTE_GENERAL',
    items: [
      makeItem({ id: 'i1', ordinal: 0, decision: 'supported', reviewerNote: 'NOTE_ITEM' }),
      makeItem({ id: 'i2', ordinal: 1, decision: 'not_reviewed', textSnapshot: 'UNREVIEWED_TEXT' })
    ]
  })

  it('defaults: notes/excerpts/hashes/unreviewed present, technical absent', () => {
    const html = render(detail)
    expect(html).toContain('NOTE_GENERAL')
    expect(html).toContain('NOTE_ITEM')
    expect(html).toContain('UNREVIEWED_TEXT')
    expect(html).toContain('Either party may terminate…')
    expect(html).toContain('ab'.repeat(32))
    // The technical SECTION is absent (its label still appears in the option echo).
    expect(html).not.toContain(`<h3>${t('en', 'packExport.generation.technical')}</h3>`)
  })

  it('excluded notes/excerpts/hashes vanish with an honest notice; the option echo records the choice', () => {
    const html = render(detail, {
      includeReviewerNotes: false,
      includeSourceExcerpts: false,
      includeDocumentHashes: false,
      includeUnreviewedItems: false
    })
    expect(html).not.toContain('NOTE_GENERAL')
    expect(html).not.toContain('NOTE_ITEM')
    expect(html).not.toContain('UNREVIEWED_TEXT')
    expect(html).not.toContain('Either party may terminate…')
    expect(html).not.toContain('ab'.repeat(32))
    expect(html).toContain(t('en', 'packExport.excluded.notes'))
    expect(html).toContain(t('en', 'packExport.excluded.excerpts'))
    expect(html).toContain(t('en', 'packExport.sources.hashExcluded'))
    expect(html).toContain(
      t('en', 'packExport.items.unreviewedExcluded.one', { count: 1 })
    )
    // Integrity section echoes every flag honestly.
    expect(html).toContain(`${t('en', 'review.export.optNotes')}: ${t('en', 'packExport.integrity.optExcluded')}`)
    expect(html).toContain(`${t('en', 'review.export.optUnreviewed')}: ${t('en', 'packExport.integrity.optExcluded')}`)
  })

  it('technical details render only when opted in', () => {
    const html = render(detail, { includeTechnicalDetails: true })
    expect(html).toContain(t('en', 'packExport.generation.technical'))
    expect(html).toContain('relevance')
  })

  it('item numbers come from the CARRIED ordinal — excluding unreviewed items leaves honest holes (FIX-7)', () => {
    const three = makeDetail({
      items: [
        makeItem({ id: 'i1', ordinal: 0, decision: 'supported', textSnapshot: 'First' }),
        makeItem({ id: 'i2', ordinal: 1, decision: 'not_reviewed', textSnapshot: 'Hidden' }),
        makeItem({ id: 'i3', ordinal: 2, decision: 'follow_up', textSnapshot: 'Third' })
      ]
    })
    const html = render(three, { includeUnreviewedItems: false })
    // Pack "Item 3" is STILL workspace item 3 — never renumbered over the hole.
    expect(html).toContain(t('en', 'packExport.item.number', { n: 1 }))
    expect(html).not.toContain(t('en', 'packExport.item.number', { n: 2 }))
    expect(html).toContain(t('en', 'packExport.item.number', { n: 3 }))
    expect(html).toContain(t('en', 'packExport.items.unreviewedExcluded.one', { count: 1 }))
  })
})

describe('honesty rendering', () => {
  it('unresolved identity and resolved-but-missing sources get DISTINCT copy', () => {
    const detail = makeDetail({
      sources: [
        {
          key: 's1',
          machineLabel: null,
          kind: 'whole_document_provenance',
          identity: 'unresolved',
          documentId: null,
          documentTitle: 'ambiguous.pdf',
          documentSha256: null,
          mimeType: null,
          pageNumber: null,
          sectionLabel: null,
          snippet: null,
          sourceChunkId: null,
          availabilityAtCreation: null
        },
        {
          key: 's2',
          machineLabel: null,
          kind: 'whole_document_provenance',
          identity: 'resolved',
          documentId: 'gone',
          documentTitle: 'deleted.pdf',
          documentSha256: null,
          mimeType: null,
          pageNumber: null,
          sectionLabel: null,
          snippet: null,
          sourceChunkId: null,
          availabilityAtCreation: 'missing'
        }
      ],
      coverageSnapshot: { mode: 'tree', chunksCovered: 4, chunksTotal: 4 }
    })
    const html = render(detail)
    expect(html).toContain(t('en', 'packExport.evidence.identityUnresolved'))
    expect(html).toContain(t('en', 'packExport.evidence.missingAtCreation'))
    expect(html).toContain(t('en', 'packExport.sources.availabilityUnknown'))
    expect(html).toContain(t('en', 'packExport.sources.availabilityMissing'))
    // Whole-document honesty caption (§24.3) — provenance, never citations.
    expect(html).toContain(t('en', 'packExport.coverage.modeWholeDoc'))
  })

  it('absent generation metadata renders "Unavailable" — never invented', () => {
    const html = render(makeDetail({ generationSnapshot: null }))
    expect(html).toContain(t('en', 'review.summary.unavailable'))
  })

  it('no-truncation-record is stated as "no record", never as "complete"', () => {
    const html = render(makeDetail({ generationSnapshot: null }))
    expect(html).toContain(t('en', 'packExport.coverage.noTruncationRecord'))
    expect(html).not.toContain(t('en', 'review.summary.truncated'))
  })

  it('the truncation warning renders when honestly recorded', () => {
    const detail = makeDetail()
    detail.generationSnapshot!.answerTruncated = true
    const html = render(detail)
    expect(html).toContain(t('en', 'review.summary.truncated'))
  })

  it('always states that file paths are never included', () => {
    expect(render(makeDetail())).toContain(t('en', 'packExport.sources.pathNote'))
  })
})

describe('P4 freshness in the pack (spec §16.1.7/§28.6 — INJECTED verdict, model stays pure)', () => {
  const outdatedFreshness = {
    reviewId: 'r1',
    outdated: true,
    answerState: 'unchanged' as const,
    coverageState: 'unchanged' as const,
    sources: [{ key: 's1', state: 'changed' as const }],
    acknowledgedAt: '2026-07-18T11:00:00.000Z'
  }

  it('WITHOUT a verdict: the P3 shape — not-re-verified note, creation-availability column, null currentState', () => {
    const model = buildEvidencePackModel(makeDetail(), opts(), META)
    expect(model.freshness).toBeNull()
    expect(model.evidence[0]!.currentState).toBeNull()
    const html = renderEvidencePackHtml(model)
    expect(html).toContain(t('en', 'packExport.coverage.freshnessNote'))
    expect(html).not.toContain(t('en', 'packExport.coverage.freshnessChecked'))
    expect(html).toContain(t('en', 'packExport.sources.colAvailability'))
    expect(html).not.toContain(t('en', 'packExport.sources.colAvailabilityExport'))
  })

  it('WITH a verdict: at-export column + per-card state + conditionalized note', () => {
    const model = buildEvidencePackModel(makeDetail(), opts(), META, {
      reviewId: 'r1',
      outdated: false,
      answerState: 'unchanged',
      coverageState: 'unchanged',
      sources: [{ key: 's1', state: 'unchanged' }],
      acknowledgedAt: null
    })
    expect(model.freshness).toMatchObject({ outdated: false, sourcesChanged: 0 })
    expect(model.evidence[0]!.currentState).toBe('unchanged')
    const html = renderEvidencePackHtml(model)
    expect(html).toContain(t('en', 'packExport.coverage.freshnessChecked'))
    expect(html).not.toContain(t('en', 'packExport.coverage.freshnessNote'))
    expect(html).toContain(t('en', 'packExport.sources.colAvailabilityExport'))
    // Not outdated → no cover warning, no acknowledge line.
    expect(html).not.toContain(t('en', 'packExport.coverage.outdated'))
    expect(html).not.toContain('acknowledged this change')
  })

  it('outdated + acknowledged: cover warning, mismatch record, acknowledge stamp, changed cell (spec §28.6)', () => {
    const model = buildEvidencePackModel(makeDetail(), opts(), META, outdatedFreshness)
    expect(model.outdated).toBe(true) // the verdict overrides the detail's constant-false
    const html = renderEvidencePackHtml(model)
    expect(html).toContain(t('en', 'packExport.coverage.outdated'))
    expect(html).toContain(t('en', 'packExport.coverage.sourcesChangedNow.one', { count: 1 }))
    expect(html).toContain(t('en', 'packExport.evidence.changedSince'))
    expect(html).toContain(t('en', 'packExport.sources.availabilityChanged'))
    expect(html).toContain(
      t('en', 'packExport.coverage.acknowledged', { date: '2026-07-18 11:00 UTC' })
    )
  })

  it('sourcesMissingNow counts NEW deletions only — creation-missing keeps its own warning', () => {
    const detail = makeDetail({
      sources: [
        { ...makeDetail().sources[0]!, key: 's1' },
        {
          ...makeDetail().sources[0]!,
          key: 's2',
          documentId: 'gone-at-creation',
          availabilityAtCreation: 'missing'
        }
      ]
    })
    const model = buildEvidencePackModel(detail, opts(), META, {
      reviewId: 'r1',
      outdated: false,
      answerState: 'unchanged',
      coverageState: 'unchanged',
      sources: [
        { key: 's1', state: 'missing' }, // NEW deletion
        { key: 's2', state: 'missing' } // was already missing at creation
      ],
      acknowledgedAt: null
    })
    expect(model.freshness).toMatchObject({ sourcesMissingNow: 1, outdated: false })
    const html = renderEvidencePackHtml(model)
    expect(html).toContain(t('en', 'packExport.coverage.sourcesMissingNow.one', { count: 1 }))
    // Per-card: the NEW deletion carries §15.4 copy; the creation-missing card keeps ONLY
    // its original warning (no duplicate).
    expect(html.match(new RegExp(escapeForRegex(t('en', 'packExport.evidence.missingNow')), 'g'))).toHaveLength(1)
    expect(html).toContain(t('en', 'packExport.evidence.missingAtCreation'))
    // A deleted source never makes the pack outdated (spec §28.7) — no cover warning.
    expect(html).not.toContain(t('en', 'packExport.coverage.outdated'))
  })

  it('a source key absent from the verdict degrades to unverifiable, never to a claim', () => {
    const model = buildEvidencePackModel(makeDetail(), opts(), META, {
      reviewId: 'r1',
      outdated: false,
      answerState: 'unchanged',
      coverageState: 'unchanged',
      sources: [], // verdict lists nothing for s1
      acknowledgedAt: null
    })
    expect(model.evidence[0]!.currentState).toBe('unverifiable')
    expect(renderEvidencePackHtml(model)).toContain(
      t('en', 'packExport.sources.availabilityUnknown')
    )
  })
})

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('determinism (plan §8 boundary)', () => {
  it('same detail + options + language ⇒ byte-identical output', () => {
    const detail = makeDetail()
    const a = renderEvidencePackHtml(buildEvidencePackModel(detail, opts(), META))
    const b = renderEvidencePackHtml(buildEvidencePackModel(detail, opts(), META))
    expect(a).toBe(b)
  })

  it('only packId + generatedAt vary between two exports of the same review', () => {
    const detail = makeDetail()
    const a = renderEvidencePackHtml(buildEvidencePackModel(detail, opts(), META))
    const b = renderEvidencePackHtml(
      buildEvidencePackModel(detail, opts(), {
        packId: '00000000-0000-4000-8000-000000000002',
        generatedAt: '2026-07-19T00:01:00.000Z',
        format: 'html'
      })
    )
    const normalize = (s: string): string =>
      s
        .replaceAll('00000000-0000-4000-8000-000000000001', 'PACK_ID')
        .replaceAll('00000000-0000-4000-8000-000000000002', 'PACK_ID')
        .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\b/g, 'TS')
    expect(normalize(a)).toBe(normalize(b))
  })

  it('resolved options round through the boundary resolver identically', () => {
    const detail = makeDetail()
    const viaResolver = renderEvidencePackHtml(
      buildEvidencePackModel(detail, resolveEvidencePackOptions({ language: 'en' }), META)
    )
    expect(viaResolver).toBe(renderEvidencePackHtml(buildEvidencePackModel(detail, opts(), META)))
  })
})

describe('P6 format line (FIX-1 — the ONE model-format-dependent line)', () => {
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

  it('format "pdf" states the printed-rendition wording on cover AND integrity; "html" keeps the P3 line — and NOTHING else differs', () => {
    const detail = makeDetail()
    const pdfLine = t('en', 'packExport.meta.formatValuePdf', { version: 1 })
    const htmlLine = t('en', 'packExport.meta.formatValue', { version: 1 })
    const asPdf = renderEvidencePackHtml(
      buildEvidencePackModel(detail, opts(), { ...META, format: 'pdf' })
    )
    const asHtml = renderEvidencePackHtml(buildEvidencePackModel(detail, opts(), META))
    // A .pdf artifact never self-describes as "Self-contained HTML" (cover + integrity —
    // the section a verifier reads next to the hash note).
    expect(count(asPdf, pdfLine)).toBe(2)
    expect(asPdf).not.toContain(htmlLine)
    expect(count(asHtml, htmlLine)).toBe(2)
    expect(asHtml).not.toContain(pdfLine)
    // The strong pin: swapping that one line converts one output into the other byte-for-
    // byte — the format branches exactly one line, so the HTML goldens stay green.
    expect(asHtml.replaceAll(htmlLine, pdfLine)).toBe(asPdf)
  })

  it('DE: the PDF line localizes from the current catalog like every pack string', () => {
    const html = renderEvidencePackHtml(
      buildEvidencePackModel(makeDetail(), opts({ language: 'de' }), { ...META, format: 'pdf' })
    )
    expect(html).toContain(t('de', 'packExport.meta.formatValuePdf', { version: 1 }))
    expect(html).not.toContain(t('de', 'packExport.meta.formatValue', { version: 1 }))
  })
})
