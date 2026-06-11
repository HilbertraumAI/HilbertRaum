import { describe, it, expect } from 'vitest'
import { detectFilenameScope } from '../../src/main/services/rag/scope'

const docs = [
  { id: 'd1', title: 'contract.pdf' },
  { id: 'd2', title: 'Q3 financial report.docx' },
  { id: 'd3', title: 'invoice_2024.csv' }
]

describe('detectFilenameScope', () => {
  it('matches a file named with its extension', () => {
    expect(detectFilenameScope('please analyze contract.pdf', docs)).toEqual({
      ids: ['d1'],
      titles: ['contract.pdf']
    })
  })

  it('matches the bare stem (no extension typed)', () => {
    expect(detectFilenameScope('summarize the contract for me', docs)).toEqual({
      ids: ['d1'],
      titles: ['contract.pdf']
    })
  })

  it('matches a multi-word filename across spaces/separators and is case-insensitive', () => {
    // "q3 financial report" appears as a contiguous token run regardless of case.
    expect(detectFilenameScope('what does the Q3 FINANCIAL REPORT say?', docs)).toEqual({
      ids: ['d2'],
      titles: ['Q3 financial report.docx']
    })
  })

  it('normalizes underscores in the filename to a phrase match', () => {
    expect(detectFilenameScope('open invoice 2024 and total it', docs)).toEqual({
      ids: ['d3'],
      titles: ['invoice_2024.csv']
    })
  })

  it('returns null when no filename is named (generic question)', () => {
    expect(detectFilenameScope('what are my obligations this year?', docs)).toBeNull()
  })

  it('does not match on a partial word inside another token', () => {
    // "contractual" must not trigger the "contract" document (token-boundary match).
    expect(detectFilenameScope('explain my contractual duties', docs)).toBeNull()
  })

  it('can match more than one named document', () => {
    const result = detectFilenameScope('compare contract.pdf with invoice_2024', docs)
    expect(result?.ids.sort()).toEqual(['d1', 'd3'])
  })

  it('ignores a lone generic word so a file named Document.pdf does not capture everything', () => {
    const generic = [{ id: 'g1', title: 'Document.pdf' }, { id: 'd1', title: 'contract.pdf' }]
    expect(detectFilenameScope('analyze this document please', generic)).toBeNull()
  })

  it('returns null when the question would match the entire corpus (no narrowing)', () => {
    const two = [{ id: 'a', title: 'alpha.txt' }, { id: 'b', title: 'beta.txt' }]
    expect(detectFilenameScope('compare alpha and beta', two)).toBeNull()
  })

  it('matches the single document when it is the only one and is named', () => {
    const one = [{ id: 'only', title: 'alpha.txt' }]
    expect(detectFilenameScope('summarize alpha', one)).toEqual({ ids: ['only'], titles: ['alpha.txt'] })
  })

  it('returns null for an empty corpus or empty question', () => {
    expect(detectFilenameScope('contract', [])).toBeNull()
    expect(detectFilenameScope('   ', docs)).toBeNull()
  })
})
