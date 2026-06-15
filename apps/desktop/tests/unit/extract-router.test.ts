import { describe, it, expect } from 'vitest'
import {
  routeQuestion,
  mapQuestionToRecordType
} from '../../src/main/services/analysis/router'
import { parseExtraction } from '../../src/main/services/analysis/extract'

// Whole-document-analysis Phase 3 (plan §4.2/§4.4, §7): the PURE task router (classification +
// precedence + low-confidence→relevance + open-vocab→type mapping, EN+DE) and the tolerant
// JSON-array parse for the extract pass. No DB, no model.

describe('routeQuestion — coverage-extract classification', () => {
  const base = { treeAvailable: false, extractAvailable: true, documentCount: 1 }

  it('routes "list every X" / "how many" to coverage-extract, never relevance', () => {
    for (const q of [
      'list every deadline',
      'enumerate all the parties',
      'how many payments are there?',
      'count the obligations'
    ]) {
      const d = routeQuestion({ ...base, question: q })
      expect(d.engine).toBe('coverage-extract')
    }
  })

  it('classifies German coverage triggers (jede / alle / wie viele / sämtliche)', () => {
    for (const q of ['liste alle Fristen', 'wie viele Parteien', 'sämtliche Pflichten auflisten']) {
      expect(routeQuestion({ ...base, question: q }).engine).toBe('coverage-extract')
    }
  })

  it('maps the open-vocabulary {X} to the closed extract type (EN + DE), default generic', () => {
    expect(mapQuestionToRecordType('list every deadline')).toBe('date')
    expect(mapQuestionToRecordType('what are the fees and costs')).toBe('amount')
    expect(mapQuestionToRecordType('who are the parties')).toBe('party')
    expect(mapQuestionToRecordType('list all obligations and clauses')).toBe('obligation')
    expect(mapQuestionToRecordType('liste alle Fristen')).toBe('date')
    expect(mapQuestionToRecordType('alle Beträge')).toBe('amount')
    expect(mapQuestionToRecordType('wer sind die Parteien')).toBe('party')
    expect(mapQuestionToRecordType('list everything important')).toBe('generic')
  })

  it('falls back to relevance (low confidence) when no extract data exists — never a false complete', () => {
    const d = routeQuestion({ ...base, extractAvailable: false, question: 'list every date' })
    expect(d.engine).toBe('relevance')
    expect(d.confidence).toBe('low')
  })
})

describe('routeQuestion — precedence + non-coverage', () => {
  it('honours precedence: compare (2 docs) > coverage-extract', () => {
    const d = routeQuestion({
      question: 'compare the obligations and list every clause',
      documentCount: 2,
      treeAvailable: false,
      extractAvailable: true
    })
    expect(d.engine).toBe('compare')
  })

  it('a compare question without two documents falls back to relevance', () => {
    const d = routeQuestion({
      question: 'what is the difference here',
      documentCount: 1,
      treeAvailable: false,
      extractAvailable: false
    })
    expect(d.engine).toBe('relevance')
    expect(d.confidence).toBe('low')
  })

  it('explicit task buttons win outright', () => {
    expect(
      routeQuestion({
        taskType: 'summary',
        question: 'anything',
        treeAvailable: true,
        extractAvailable: false
      }).engine
    ).toBe('tree-summary')
    expect(
      routeQuestion({
        taskType: 'compare',
        question: 'anything',
        documentCount: 2,
        treeAvailable: false,
        extractAvailable: false
      }).engine
    ).toBe('compare')
  })

  it('routes "summarize / overview" to tree-summary only when a tree is ready', () => {
    expect(
      routeQuestion({ question: 'summarize this document', treeAvailable: true, extractAvailable: false })
        .engine
    ).toBe('tree-summary')
    expect(
      routeQuestion({ question: 'summarize this document', treeAvailable: false, extractAvailable: false })
        .engine
    ).toBe('relevance')
  })

  it('an ordinary question routes to relevance, byte-unchanged (high confidence)', () => {
    const d = routeQuestion({
      question: 'what does the contract say about termination?',
      documentCount: 1,
      treeAvailable: true,
      extractAvailable: true
    })
    expect(d.engine).toBe('relevance')
    expect(d.confidence).toBe('high')
  })
})

describe('parseExtraction — tolerant JSON-array parse (H7)', () => {
  it('parses a clean array of typed items', () => {
    const items = parseExtraction('[{"type":"date","value":"2020-01-01"},{"type":"party","value":"Acme"}]')
    expect(items).toEqual([
      { type: 'date', value: '2020-01-01' },
      { type: 'party', value: 'Acme' }
    ])
  })

  it('recovers an array wrapped in prose / code fences', () => {
    const items = parseExtraction('Sure! ```json\n[{"type":"amount","value":"$5"}]\n``` done')
    expect(items).toEqual([{ type: 'amount', value: '$5' }])
  })

  it('treats an empty array as a VALID parse (chunk genuinely had nothing), not unparsed', () => {
    expect(parseExtraction('[]')).toEqual([])
  })

  it('coerces an unknown type to generic and drops empty values', () => {
    const items = parseExtraction('[{"type":"weird","value":"x"},{"type":"date","value":"  "}]')
    expect(items).toEqual([{ type: 'generic', value: 'x' }])
  })

  it('returns null (→ retry, then unparsed marker) when no JSON array is present', () => {
    expect(parseExtraction('I could not find anything useful.')).toBeNull()
    expect(parseExtraction('{not an array}')).toBeNull()
  })
})
