import { describe, it, expect } from 'vitest'
import {
  buildEvidencePackModel,
  resolveEvidencePackOptions,
  EVIDENCE_PACK_SCHEMA_VERSION,
  PACK_DECISION_ORDER
} from '../../src/main/services/evidence-pack/pack-model'
import { sourceKindForMode } from '../../src/main/services/evidence-pack/snapshot'
import {
  EVIDENCE_PACK_OPTION_DEFAULTS,
  evidencePaneMode
} from '../../src/shared/evidence-review'
import type { CoverageInfo, EvidencePackOptions } from '../../src/shared/types'
import { makeDetail, makeItem } from '../helpers/evidenceReview'

// EP-1 plan §8.1 — the pure pack model: §16.2 option resolution at the untrusted boundary
// (defaults + tolerance), the nine-section §16.1 normalization from stored review data
// only, the honesty-mode REUSE pin (pack mapping ≡ evidencePaneMode ≡ the P1
// sourceKindForMode semantics — unknown-PRESENT modes stay WEAK), and the malformed→
// "Unavailable" (null, never invented) degradations.

const META = { packId: 'pack-1', generatedAt: '2026-07-18T12:00:00.000Z' }

function opts(over: Partial<EvidencePackOptions> = {}): EvidencePackOptions {
  return { language: 'en', ...EVIDENCE_PACK_OPTION_DEFAULTS, ...over }
}

describe('resolveEvidencePackOptions (spec §16.2 boundary)', () => {
  it('applies the shared defaults — privacy-sensitive technical extras OFF', () => {
    expect(resolveEvidencePackOptions(undefined)).toEqual({
      language: 'en',
      includeReviewerNotes: true,
      includeSourceExcerpts: true,
      includeDocumentHashes: true,
      includeUnreviewedItems: true,
      includeTechnicalDetails: false
    })
    // The resolver's defaults ARE the shared constant (renderer panel parity).
    expect(resolveEvidencePackOptions({})).toEqual({ language: 'en', ...EVIDENCE_PACK_OPTION_DEFAULTS })
  })

  it('keeps only literally-boolean flags and drops unknown keys (never coerced)', () => {
    const resolved = resolveEvidencePackOptions({
      includeReviewerNotes: false,
      includeTechnicalDetails: true,
      includeSourceExcerpts: 'yes', // not boolean → default
      includeDocumentHashes: 1, // not boolean → default
      includeSourcePaths: true // unknown key → dropped, no path flag exists
    })
    expect(resolved.includeReviewerNotes).toBe(false)
    expect(resolved.includeTechnicalDetails).toBe(true)
    expect(resolved.includeSourceExcerpts).toBe(true)
    expect(resolved.includeDocumentHashes).toBe(true)
    expect(resolved.includeUnreviewedItems).toBe(true)
    expect('includeSourcePaths' in resolved).toBe(false)
  })

  it("resolves language to 'de' only on the literal, else 'en'", () => {
    expect(resolveEvidencePackOptions({ language: 'de' }).language).toBe('de')
    expect(resolveEvidencePackOptions({ language: 'fr' }).language).toBe('en')
    expect(resolveEvidencePackOptions({ language: 42 }).language).toBe('en')
    expect(resolveEvidencePackOptions([]).language).toBe('en')
  })
})

describe('buildEvidencePackModel (spec §16.1 normalization)', () => {
  it('carries the nine-section facts from the stored detail only', () => {
    const detail = makeDetail({
      reviewerLabel: 'A. Reviewer',
      generalNote: 'overall fine',
      items: [
        makeItem({ id: 'i1', ordinal: 0, decision: 'supported', reviewerNote: 'checked p12', links: [{ evidenceKey: 's1', origin: 'answer_marker', relation: null }] }),
        makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-heading-x', blockKind: 'heading', decision: 'not_applicable', textSnapshot: '## Head' }),
        makeItem({ id: 'i3', ordinal: 2, blockKey: 'b2-paragraph-y', decision: 'follow_up', textSnapshot: 'Gamma' })
      ],
      exports: [
        {
          id: 'x1',
          reviewId: 'r1',
          format: 'html',
          schemaVersion: 1,
          fileName: 'earlier.html',
          fileSha256: 'ff'.repeat(32),
          options: null,
          createdAt: '2026-07-17T09:00:00.000Z'
        }
      ]
    })
    const model = buildEvidencePackModel(detail, opts(), META)
    expect(model.packId).toBe('pack-1')
    expect(model.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION)
    expect(model.format).toBe('html')
    expect(model.title).toBe('Evidence review')
    expect(model.status).toBe('draft')
    expect(model.question).toBe('What does the contract say?')
    expect(model.answer).toBe('Alpha [S1]\n\nBeta')
    expect(model.summary.reviewerLabel).toBe('A. Reviewer')
    expect(model.summary.generalNote).toBe('overall fine')
    expect(model.summary.lastExportedAt).toBe('2026-07-17T09:00:00.000Z')
    expect(model.summary.followUps).toBe(1)
    // Decision counts in the FIXED order, one entry per decision.
    expect(model.summary.decisionCounts.map((c) => c.decision)).toEqual([...PACK_DECISION_ORDER])
    expect(
      model.summary.decisionCounts.find((c) => c.decision === 'supported')?.count
    ).toBe(1)
    // Items in stored order; heading flagged; links resolve to 1-based register indexes.
    expect(model.items).toHaveLength(3)
    expect(model.items[1]!.heading).toBe(true)
    expect(model.items[0]!.links[0]).toMatchObject({
      sourceIndex: 1,
      label: 'contract.pdf',
      machineLabel: 'S1',
      origin: 'answer_marker'
    })
    expect(model.evidence[0]!.index).toBe(1)
    expect(model.evidence[0]!.documentSha256).toBe('ab'.repeat(32))
    expect(model.evidence[0]!.snippet).toBe('Either party may terminate…')
  })

  it('reuses the shared honesty mapping — unknown-PRESENT modes stay WEAK (whole-doc)', () => {
    const cases: Array<CoverageInfo | null> = [
      null,
      { mode: 'relevance', chunksCovered: 1, chunksTotal: 2 },
      { mode: 'tree', chunksCovered: 5, chunksTotal: 5 },
      { mode: 'capped', chunksCovered: 3, chunksTotal: 9 },
      { mode: 'extract', chunksCovered: 2, chunksTotal: 2 },
      // A future/unknown mode a NEWER app version persisted (reachable: parseCoverage
      // accepts any string) — must stay WEAK.
      { mode: 'hologram-v9', chunksCovered: 1, chunksTotal: 1 } as unknown as CoverageInfo
    ]
    for (const coverage of cases) {
      const model = buildEvidencePackModel(makeDetail({ coverageSnapshot: coverage }), opts(), META)
      // The pack's mode IS evidencePaneMode's — never a re-derived map.
      expect(model.honesty.paneMode).toBe(evidencePaneMode(coverage))
    }
    // And evidencePaneMode agrees with the P1 kind map on the weak direction: any mode the
    // snapshot builder calls whole_document_provenance renders the whole-doc caption.
    const weird = { mode: 'hologram-v9' } as unknown as CoverageInfo
    expect(sourceKindForMode(weird.mode)).toBe('whole_document_provenance')
    expect(evidencePaneMode(weird)).toBe('whole_doc')
  })

  it('degrades absent metadata to null — never invented (spec §20.2/§25.5)', () => {
    const model = buildEvidencePackModel(
      makeDetail({
        questionSnapshot: '',
        coverageSnapshot: null,
        generationSnapshot: null,
        reviewerLabel: null,
        generalNote: null,
        completedAt: null,
        sources: [],
        items: [makeItem({ id: 'i1' })],
        exports: []
      }),
      opts(),
      META
    )
    expect(model.question).toBeNull()
    expect(model.generation).toBeNull()
    expect(model.honesty.answerModeRaw).toBeNull()
    expect(model.honesty.chunksCovered).toBeNull()
    expect(model.honesty.answerTruncated).toBeNull() // no record ≠ "not truncated"
    expect(model.summary.reviewerLabel).toBeNull()
    expect(model.summary.lastExportedAt).toBeNull()
    expect(model.evidence).toHaveLength(0)
  })

  it('counts unresolved vs missing sources DISTINCTLY (P0/P1 identity semantics)', () => {
    const detail = makeDetail({
      sources: [
        {
          key: 's1',
          machineLabel: 'S1',
          kind: 'direct_excerpt',
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
          machineLabel: 'S2',
          kind: 'direct_excerpt',
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
      ]
    })
    const model = buildEvidencePackModel(detail, opts(), META)
    expect(model.honesty.unresolvedSources).toBe(1)
    expect(model.honesty.missingSources).toBe(1)
  })

  describe('option-flag matrix (spec §16.2 — privacy defaults honored)', () => {
    const detail = makeDetail({
      generalNote: 'general',
      items: [
        makeItem({ id: 'i1', ordinal: 0, decision: 'supported', reviewerNote: 'note-1' }),
        makeItem({ id: 'i2', ordinal: 1, decision: 'not_reviewed', reviewerNote: 'note-2', links: [{ evidenceKey: 's1', origin: 'reviewer', relation: 'contradicts' }] })
      ]
    })

    it('includeReviewerNotes: false nulls item notes AND the general note', () => {
      const model = buildEvidencePackModel(detail, opts({ includeReviewerNotes: false }), META)
      expect(model.items.every((i) => i.note === null)).toBe(true)
      expect(model.summary.generalNote).toBeNull()
    })

    it('includeSourceExcerpts: false nulls register snippets', () => {
      const model = buildEvidencePackModel(detail, opts({ includeSourceExcerpts: false }), META)
      expect(model.evidence.every((s) => s.snippet === null)).toBe(true)
    })

    it('includeDocumentHashes: false nulls register hashes', () => {
      const model = buildEvidencePackModel(detail, opts({ includeDocumentHashes: false }), META)
      expect(model.evidence.every((s) => s.documentSha256 === null)).toBe(true)
    })

    it('includeUnreviewedItems: false hides not_reviewed items but COUNTS them honestly and keeps their register relations', () => {
      const model = buildEvidencePackModel(detail, opts({ includeUnreviewedItems: false }), META)
      expect(model.items).toHaveLength(1)
      expect(model.items[0]!.decision).toBe('supported')
      expect(model.excludedItemCount).toBe(1)
      // The hidden item's reviewer relation still lands in the register — register facts
      // never depend on a display flag.
      expect(model.evidence[0]!.relations).toEqual(['contradicts'])
      // Summary counts stay over ALL items (the honest totals).
      expect(
        model.summary.decisionCounts.find((c) => c.decision === 'not_reviewed')?.count
      ).toBe(1)
    })

    it('defaults include everything except technical details', () => {
      const model = buildEvidencePackModel(detail, opts(), META)
      expect(model.options.includeTechnicalDetails).toBe(false)
      expect(model.items[0]!.note).toBe('note-1')
      expect(model.excludedItemCount).toBe(0)
    })
  })

  it('tolerates links whose key matches no source (label falls back, no index)', () => {
    const detail = makeDetail({
      items: [
        makeItem({ id: 'i1', links: [{ evidenceKey: 'ghost-key', origin: 'reviewer', relation: null }] })
      ]
    })
    const model = buildEvidencePackModel(detail, opts(), META)
    expect(model.items[0]!.links[0]).toMatchObject({ sourceIndex: null, label: 'ghost-key' })
  })
})
