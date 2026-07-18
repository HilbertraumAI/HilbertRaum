import { vi } from 'vitest'
import type { EvidenceReviewDetail, EvidenceReviewFreshness, EvidenceReviewItem } from '../../src/shared/types'
import { deriveReadyGate } from '../../src/main/services/evidence-reviews'
import { stubApi } from './renderer'

// Shared renderer-test fixtures for the EP-1 review workspace (plan §7): one detail shaped
// exactly like the Phase-1 `getEvidenceReview` read-model. Tests override per case.
// The fixture gate comes from MAIN's `deriveReadyGate` — the authority a real detail would
// carry — NOT from the renderer's `computeReadyGate` mirror, so footer/gating tests never
// validate the mirror against itself (review FIX-4; the mirror's equivalence is pinned
// separately in tests/unit/evidence-review-gate.test.ts).
//
// P4: every successful session open now fires `refreshEvidenceReviewState` (plan §9.1 "on
// review open"), so review test files stub it structurally via `stubReviewApi` below —
// the plain `stubApi` plus the freshness auto-stub (override per test for outdated cases).

export function makeItem(over: Partial<EvidenceReviewItem> & { id: string }): EvidenceReviewItem {
  return {
    reviewId: 'r1',
    ordinal: 0,
    kind: 'block',
    blockKey: 'b0-paragraph-abc',
    blockKind: 'paragraph',
    startOffset: null,
    endOffset: null,
    textSnapshot: 'Alpha [S1]',
    decision: 'not_reviewed',
    reviewerNote: null,
    links: [],
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    ...over
  }
}

/** A fresh (not outdated) freshness verdict matching `makeDetail`'s single source. */
export function makeFreshness(over: Partial<EvidenceReviewFreshness> = {}): EvidenceReviewFreshness {
  return {
    reviewId: 'r1',
    outdated: false,
    answerState: 'unchanged',
    coverageState: 'unchanged',
    sources: [{ key: 's1', state: 'unchanged' }],
    acknowledgedAt: null,
    ...over
  }
}

/**
 * `stubApi` + the P4 freshness stub the open-session flow always calls. Overrides win —
 * pass your own `refreshEvidenceReviewState` (or freshness via `fresh`) for outdated
 * cases. Returns the installed refresh spy for call assertions.
 */
export function stubReviewApi(
  overrides: Parameters<typeof stubApi>[0] = {},
  fresh?: EvidenceReviewFreshness
): { refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(
    async (reviewId: string): Promise<EvidenceReviewFreshness | null> =>
      fresh ?? makeFreshness({ reviewId })
  )
  stubApi({ refreshEvidenceReviewState: refresh, ...overrides })
  return { refresh }
}

export function makeDetail(over: Partial<EvidenceReviewDetail> = {}): EvidenceReviewDetail {
  const items = over.items ?? [
    makeItem({ id: 'i1', ordinal: 0 }),
    makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta' })
  ]
  return {
    id: 'r1',
    conversationId: 'c1',
    messageId: 'm1',
    questionMessageId: 'q1',
    title: 'Evidence review',
    status: 'draft',
    outdated: false,
    reviewerLabel: null,
    generalNote: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    completedAt: null,
    answerSnapshot: 'Alpha [S1]\n\nBeta',
    questionSnapshot: 'What does the contract say?',
    sources: [
      {
        key: 's1',
        machineLabel: 'S1',
        kind: 'direct_excerpt',
        identity: 'resolved',
        documentId: 'd1',
        documentTitle: 'contract.pdf',
        documentSha256: 'ab'.repeat(32),
        mimeType: 'application/pdf',
        pageNumber: 12,
        sectionLabel: null,
        snippet: 'Either party may terminate…',
        sourceChunkId: null,
        availabilityAtCreation: 'available'
      }
    ],
    coverageSnapshot: { mode: 'relevance', chunksCovered: 2, chunksTotal: 10 },
    generationSnapshot: {
      generatedAt: '2026-07-18T09:00:00.000Z',
      modelId: 'model-1',
      modelDisplayName: 'Local Model',
      skillId: null,
      skillDisplayName: null,
      appVersion: '0.1.52',
      answerTruncated: false,
      answerMode: 'relevance'
    },
    exports: [],
    gate: deriveReadyGate(items),
    ...over,
    items
  }
}
