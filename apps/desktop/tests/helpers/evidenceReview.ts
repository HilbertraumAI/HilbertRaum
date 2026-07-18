import type { EvidenceReviewDetail, EvidenceReviewItem } from '../../src/shared/types'
import { computeReadyGate } from '../../src/renderer/lib/reviewSession'

// Shared renderer-test fixtures for the EP-1 review workspace (plan §7): one detail shaped
// exactly like the Phase-1 `getEvidenceReview` read-model. Tests override per case.

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
    gate: computeReadyGate(items),
    ...over,
    items
  }
}
