import { describe, it, expect } from 'vitest'
import {
  generatedStaleness,
  matchesSmartView,
  LARGE_FILE_BYTES,
  type DocumentInfo,
  type GeneratedProvenance
} from '../../src/shared/types'
import { makeDocumentInfo } from '../helpers/chat-fixtures'

// Phase-E smart views + generated-staleness (plan §7.6/§12.1/§15.3). These are pure,
// tolerant derivations over already-listed DocumentInfo fields — no DB, no throw — and the
// single source of truth shared by the renderer rail and the docs:list filter.

describe('matchesSmartView (plan §7.6/§12.1)', () => {
  it('unfiled = not filed into any project (Library/Temporary builtins do not count)', () => {
    const projectFiled = makeDocumentInfo({ collections: [{ id: 'p', name: 'Tax', type: 'project', role: 'source' }] })
    const libraryOnly = makeDocumentInfo({
      collections: [{ id: 'lib', name: 'Library', type: 'library', role: 'source' }]
    })
    const nowhere = makeDocumentInfo({ collections: [] })
    expect(matchesSmartView(projectFiled, 'unfiled')).toBe(false) // filed → excluded
    expect(matchesSmartView(libraryOnly, 'unfiled')).toBe(true) // Library doesn't count as filed
    expect(matchesSmartView(nowhere, 'unfiled')).toBe(true)
  })

  it('failed selects only status==="failed"', () => {
    expect(matchesSmartView(makeDocumentInfo({ status: 'failed' }), 'failed')).toBe(true)
    expect(matchesSmartView(makeDocumentInfo({ status: 'indexed' }), 'failed')).toBe(false)
  })

  it('large selects only files at/above the documented threshold', () => {
    expect(matchesSmartView(makeDocumentInfo({ sizeBytes: LARGE_FILE_BYTES }), 'large')).toBe(true)
    expect(matchesSmartView(makeDocumentInfo({ sizeBytes: LARGE_FILE_BYTES - 1 }), 'large')).toBe(false)
    expect(matchesSmartView(makeDocumentInfo({ sizeBytes: null }), 'large')).toBe(false)
  })

  it('audio selects audio mime or a generated transcript', () => {
    expect(matchesSmartView(makeDocumentInfo({ mimeType: 'audio/mpeg' }), 'audio')).toBe(true)
    expect(matchesSmartView(makeDocumentInfo({ mimeType: 'application/pdf' }), 'audio')).toBe(false)
    const transcript = makeDocumentInfo({
      mimeType: 'text/markdown',
      origin: { kind: 'transcript', sourceDocumentIds: ['s1'], createdAt: '2026-01-02T00:00:00.000Z' }
    })
    expect(matchesSmartView(transcript, 'audio')).toBe(true)
  })

  it('ocr selects an OCR result or a detected scan', () => {
    const ocrDoc = makeDocumentInfo({ ocr: { pageCount: 2, languages: ['eng'], engineId: 't', createdAt: 'x' } })
    expect(matchesSmartView(ocrDoc, 'ocr')).toBe(true)
    expect(matchesSmartView(makeDocumentInfo({ scanDetected: true }), 'ocr')).toBe(true)
    expect(matchesSmartView(makeDocumentInfo({}), 'ocr')).toBe(false)
  })

  it('needsReindex / generated / archived select their rows', () => {
    expect(matchesSmartView(makeDocumentInfo({ staleEmbeddings: true }), 'needsReindex')).toBe(true)
    expect(matchesSmartView(makeDocumentInfo({ staleEmbeddings: false }), 'needsReindex')).toBe(false)
    const gen = makeDocumentInfo({ origin: { kind: 'translation', sourceDocumentIds: ['s'], createdAt: 'x' } })
    expect(matchesSmartView(gen, 'generated')).toBe(true)
    expect(matchesSmartView(makeDocumentInfo({}), 'generated')).toBe(false)
    expect(matchesSmartView(makeDocumentInfo({ lifecycle: 'archived' }), 'archived')).toBe(true)
    expect(matchesSmartView(makeDocumentInfo({ lifecycle: 'permanent' }), 'archived')).toBe(false)
  })
})

describe('generatedStaleness (plan §15.3)', () => {
  const OUTPUT_CREATED = '2026-03-01T00:00:00.000Z'
  function generated(over: Partial<GeneratedProvenance> = {}): DocumentInfo {
    return makeDocumentInfo({
      id: 'gen',
      origin: { kind: 'translation', sourceDocumentIds: ['s1'], createdAt: OUTPUT_CREATED, ...over }
    })
  }

  it('flags source-changed when a source was updated after createdAt', () => {
    const sources = new Map([['s1', { updatedAt: '2026-04-01T00:00:00.000Z', lifecycle: 'permanent' as const }]])
    expect(generatedStaleness(generated(), sources)).toEqual({ stale: true, reason: 'source-changed' })
  })

  it('not stale when the source is untouched (updated before createdAt)', () => {
    const sources = new Map([['s1', { updatedAt: '2026-02-01T00:00:00.000Z', lifecycle: 'permanent' as const }]])
    expect(generatedStaleness(generated(), sources)).toEqual({ stale: false, reason: null })
  })

  it('flags source-removed when a source is missing (deleted)', () => {
    expect(generatedStaleness(generated(), new Map())).toEqual({ stale: true, reason: 'source-removed' })
  })

  it('flags source-removed when a source was archived', () => {
    const sources = new Map([['s1', { updatedAt: '2026-04-01T00:00:00.000Z', lifecycle: 'archived' as const }]])
    expect(generatedStaleness(generated(), sources)).toEqual({ stale: true, reason: 'source-removed' })
  })

  it('no flag (and no throw) on a malformed/empty createdAt', () => {
    const sources = new Map([['s1', { updatedAt: '2026-04-01T00:00:00.000Z' }]])
    expect(generatedStaleness(generated({ createdAt: '' }), sources)).toEqual({ stale: false, reason: null })
    expect(generatedStaleness(generated({ createdAt: 'not-a-date' }), sources)).toEqual({
      stale: false,
      reason: null
    })
  })

  it('a legacy origin shape (no createdAt) is never flagged', () => {
    const legacy = makeDocumentInfo({ origin: { type: 'translation', translatedFrom: 's1', targetLang: 'de' } })
    const sources = new Map([['s1', { updatedAt: '2026-04-01T00:00:00.000Z' }]])
    expect(generatedStaleness(legacy, sources)).toEqual({ stale: false, reason: null })
  })

  it('a non-generated document is never evaluated', () => {
    expect(generatedStaleness(makeDocumentInfo({ origin: null }), new Map())).toEqual({ stale: false, reason: null })
  })
})
