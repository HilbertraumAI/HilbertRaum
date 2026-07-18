import { describe, it, expect } from 'vitest'
import {
  deriveReadyGate,
  parseGenerationSnapshot,
  parseSourceSnapshots
} from '../../src/main/services/evidence-reviews'
import type { AnswerBlockKind, ReviewDecision } from '../../src/shared/types'

// EP-1 Phase 0 (plan §5) — the D-7 ready-gate derivation matrix + the pure tolerant
// snapshot parsers. Storage-level behavior lives in tests/integration/evidence-reviews.test.ts.

function item(
  kind: 'block' | 'selection',
  decision: ReviewDecision,
  blockKind: AnswerBlockKind | null = null
): { kind: 'block' | 'selection'; blockKind: AnswerBlockKind | null; decision: ReviewDecision } {
  return { kind, blockKind, decision }
}

describe('deriveReadyGate (D-7: all non-heading answer blocks decided)', () => {
  it('an item-less review is vacuously eligible (nothing to review)', () => {
    expect(deriveReadyGate([])).toEqual({ eligible: true, requiredTotal: 0, decidedTotal: 0 })
  })

  it('an undecided paragraph block blocks readiness', () => {
    expect(deriveReadyGate([item('block', 'not_reviewed', 'paragraph')])).toEqual({
      eligible: false,
      requiredTotal: 1,
      decidedTotal: 0
    })
  })

  it.each<ReviewDecision>([
    'supported',
    'partly_supported',
    'not_supported',
    'follow_up',
    'not_applicable'
  ])('decision %s counts as decided (not_applicable included — D-7)', (decision) => {
    expect(deriveReadyGate([item('block', decision, 'paragraph')])).toEqual({
      eligible: true,
      requiredTotal: 1,
      decidedTotal: 1
    })
  })

  it('heading blocks are exempt — even an explicitly not_reviewed heading never gates', () => {
    expect(deriveReadyGate([item('block', 'not_reviewed', 'heading')])).toEqual({
      eligible: true,
      requiredTotal: 0,
      decidedTotal: 0
    })
  })

  it('an UNCLASSIFIED block (blockKind null) is required — corruption cannot exempt a block', () => {
    expect(deriveReadyGate([item('block', 'not_reviewed', null)])).toEqual({
      eligible: false,
      requiredTotal: 1,
      decidedTotal: 0
    })
  })

  it('selections never gate readiness (they are reviewer refinements, not answer blocks)', () => {
    expect(deriveReadyGate([item('selection', 'not_reviewed', 'paragraph')])).toEqual({
      eligible: true,
      requiredTotal: 0,
      decidedTotal: 0
    })
  })

  it('mixed review: eligible only once every required block is decided', () => {
    const items = [
      item('block', 'not_applicable', 'heading'), // exempt AND decided-by-default
      item('block', 'supported', 'paragraph'),
      item('block', 'not_reviewed', 'list_item'), // the one undecided required item
      item('block', 'follow_up', 'table'),
      item('selection', 'not_reviewed', 'paragraph') // never required
    ]
    expect(deriveReadyGate(items)).toEqual({ eligible: false, requiredTotal: 3, decidedTotal: 2 })
    items[2] = item('block', 'not_supported', 'list_item')
    expect(deriveReadyGate(items)).toEqual({ eligible: true, requiredTotal: 3, decidedTotal: 3 })
  })

  it('fence/blockquote blocks are required like paragraphs', () => {
    expect(
      deriveReadyGate([
        item('block', 'not_reviewed', 'fence'),
        item('block', 'not_reviewed', 'blockquote')
      ])
    ).toEqual({ eligible: false, requiredTotal: 2, decidedTotal: 0 })
  })
})

describe('parseSourceSnapshots (tolerant — malformed → safe defaults, never a throw)', () => {
  it('null / not-JSON / non-array / empty degrade to []', () => {
    expect(parseSourceSnapshots(null)).toEqual([])
    expect(parseSourceSnapshots('not json at all {')).toEqual([])
    expect(parseSourceSnapshots('{"key":"s1"}')).toEqual([])
    expect(parseSourceSnapshots('[]')).toEqual([])
  })

  it('keeps valid elements, drops the rest; unknown kind/identity coalesce to the WEAKEST claim', () => {
    const json = JSON.stringify([
      {
        key: 's1',
        documentTitle: 'contract.pdf',
        kind: 'direct_excerpt',
        identity: 'resolved',
        documentId: 'doc-1',
        documentSha256: 'abc',
        pageNumber: 3,
        snippet: 'Termination requires 30 days notice.',
        availabilityAtCreation: 'available'
      },
      42, // not an object
      { documentTitle: 'no key' }, // missing required key
      { key: 's2', documentTitle: 'weird.pdf', kind: 'super_citation', identity: 'yes', pageNumber: 'three' }
    ])
    const parsed = parseSourceSnapshots(json)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({
      key: 's1',
      kind: 'direct_excerpt',
      identity: 'resolved',
      documentId: 'doc-1',
      availabilityAtCreation: 'available',
      pageNumber: 3
    })
    // The repaired element claims NOTHING it cannot prove: provenance-strength kind,
    // unresolved identity, no availability, dropped mistyped page number.
    expect(parsed[1]).toMatchObject({
      key: 's2',
      kind: 'whole_document_provenance',
      identity: 'unresolved',
      availabilityAtCreation: null,
      pageNumber: null
    })
  })

  it('availability is never reported for an unresolved identity (it cannot be known)', () => {
    const parsed = parseSourceSnapshots(
      JSON.stringify([
        { key: 's1', documentTitle: 't', identity: 'unresolved', availabilityAtCreation: 'available' }
      ])
    )
    expect(parsed[0].availabilityAtCreation).toBeNull()
  })
})

describe('parseGenerationSnapshot (tolerant — absent = "Unavailable", never invented)', () => {
  it('null / not-JSON / array / primitive degrade to null', () => {
    expect(parseGenerationSnapshot(null)).toBeNull()
    expect(parseGenerationSnapshot('nope {')).toBeNull()
    expect(parseGenerationSnapshot('[1,2]')).toBeNull()
    expect(parseGenerationSnapshot('"just a string"')).toBeNull()
  })

  it('field-tolerant: mistyped fields drop to null, valid ones survive', () => {
    const parsed = parseGenerationSnapshot(
      JSON.stringify({
        generatedAt: '2026-07-18T00:00:00.000Z',
        modelId: 'qwen3-4b',
        modelDisplayName: 12,
        appVersion: '0.1.52',
        answerTruncated: 'yes',
        answerMode: 'relevance'
      })
    )
    expect(parsed).toEqual({
      generatedAt: '2026-07-18T00:00:00.000Z',
      modelId: 'qwen3-4b',
      modelDisplayName: null,
      skillId: null,
      skillDisplayName: null,
      appVersion: '0.1.52',
      answerTruncated: null,
      answerMode: 'relevance'
    })
  })

  it('an unknown answerMode drops to null (never a guessed mode)', () => {
    expect(parseGenerationSnapshot(JSON.stringify({ answerMode: 'psychic' }))?.answerMode).toBeNull()
  })
})

// ---- Renderer gate mirror ≡ main gate (Phase-2 review FIX-4) ----------------------------
// The renderer's `computeReadyGate` (lib/reviewSession.ts) recomputes the D-7 gate for
// optimistic in-between states while main's `deriveReadyGate` stays authoritative at rest
// and on markReady. Both are pure — this matrix PINS their equivalence so the mirror can
// never drift silently (heading exemption, NULL blockKind, selections, N/A-counts-as-
// decided, mixed, empty).
import { computeReadyGate } from '../../src/renderer/lib/reviewSession'
import type { EvidenceReviewItem } from '../../src/shared/types'

function mirrorItem(
  kind: 'block' | 'selection',
  decision: ReviewDecision,
  blockKind: AnswerBlockKind | null = null
): EvidenceReviewItem {
  return {
    id: `${kind}-${decision}-${blockKind ?? 'null'}-${Math.random()}`,
    reviewId: 'r1',
    ordinal: 0,
    kind,
    blockKey: 'b0',
    blockKind,
    startOffset: null,
    endOffset: null,
    textSnapshot: 'x',
    decision,
    reviewerNote: null,
    links: [],
    createdAt: 'now',
    updatedAt: 'now'
  }
}

describe('computeReadyGate ≡ deriveReadyGate (renderer mirror equivalence, FIX-4)', () => {
  const MATRIX: EvidenceReviewItem[][] = [
    [],
    [mirrorItem('block', 'not_reviewed', 'paragraph')],
    [mirrorItem('block', 'not_applicable', 'paragraph')], // N/A counts as decided
    [mirrorItem('block', 'not_reviewed', 'heading')], // heading exempt
    [mirrorItem('block', 'supported', 'heading')], // decided heading still exempt from required
    [mirrorItem('block', 'not_reviewed', null)], // NULL kind → required (safe direction)
    [mirrorItem('selection', 'not_reviewed', 'paragraph')], // selections never gate
    [mirrorItem('selection', 'supported', null)],
    [
      // mixed: heading(N/A) + decided para + undecided list_item + selection + NULL-kind decided
      mirrorItem('block', 'not_applicable', 'heading'),
      mirrorItem('block', 'supported', 'paragraph'),
      mirrorItem('block', 'not_reviewed', 'list_item'),
      mirrorItem('selection', 'not_reviewed', 'paragraph'),
      mirrorItem('block', 'follow_up', null)
    ],
    [
      // fully decided mixed set
      mirrorItem('block', 'partly_supported', 'paragraph'),
      mirrorItem('block', 'not_supported', 'table'),
      mirrorItem('block', 'follow_up', 'fence'),
      mirrorItem('block', 'not_applicable', 'blockquote')
    ]
  ]

  it('every matrix row produces IDENTICAL gates from both implementations', () => {
    for (const items of MATRIX) {
      expect(computeReadyGate(items)).toEqual(deriveReadyGate(items))
    }
  })

  it('every decision × blockKind × kind combination agrees (exhaustive single-item sweep)', () => {
    const decisions: ReviewDecision[] = [
      'supported',
      'partly_supported',
      'not_supported',
      'follow_up',
      'not_reviewed',
      'not_applicable'
    ]
    const kinds: Array<AnswerBlockKind | null> = [
      'paragraph',
      'list_item',
      'heading',
      'fence',
      'table',
      'blockquote',
      null
    ]
    for (const kind of ['block', 'selection'] as const) {
      for (const decision of decisions) {
        for (const blockKind of kinds) {
          const items = [mirrorItem(kind, decision, blockKind)]
          expect(computeReadyGate(items)).toEqual(deriveReadyGate(items))
        }
      }
    }
  })
})
