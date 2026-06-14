import { describe, it, expect } from 'vitest'
import {
  suggestFilingForDocument,
  suggestFilingForDocuments
} from '../../src/main/services/filing-suggestions'
import type { Collection, DocumentInfo } from '../../src/shared/types'

// Phase-F filing-suggestion engine (plan §20). PURE, LOCAL, DETERMINISTIC, tolerant: the
// same inputs always yield the same ranked output, missing metadata yields no suggestion and
// never throws, and generated/Temporary/archived/already-filed docs are never subjects.

function doc(over: Partial<DocumentInfo>): DocumentInfo {
  return {
    id: 'd1',
    title: 'notes.pdf',
    originalPath: null,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

function project(over: Partial<Collection>): Collection {
  return {
    id: 'p1',
    name: 'Project',
    type: 'project',
    description: null,
    builtin: false,
    color: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    ...over
  }
}

describe('suggestFilingForDocument (plan §20 Phase F)', () => {
  it('folder-name match: source folder equals a project name ⇒ suggest that project', () => {
    const tax = project({ id: 'tax', name: 'Tax 2025' })
    const subject = doc({ id: 'd', title: 'return.pdf', sourceFolderLabel: 'Tax 2025' })
    const out = suggestFilingForDocument(subject, [tax], [subject])
    expect(out[0]).toMatchObject({
      ruleId: 'folder-name-match',
      target: { kind: 'existingProject', collectionId: 'tax' },
      reasonKey: 'docs.suggest.reason.folder',
      reasonParams: { folder: 'Tax 2025' }
    })
  })

  it('folder-name match is case-insensitive and matches a contained name', () => {
    const tax = project({ id: 'tax', name: 'Tax' })
    const subject = doc({ id: 'd', sourceFolderLabel: 'My TAX papers' })
    const out = suggestFilingForDocument(subject, [tax], [subject])
    expect(out.map((s) => s.target)).toContainEqual({ kind: 'existingProject', collectionId: 'tax' })
  })

  it('same-source-folder cohort: another doc from the same folder is filed in project X ⇒ suggest X', () => {
    const client = project({ id: 'cli', name: 'Client Müller' })
    // The subject's folder label does NOT match any project name (so rule 1 can't fire),
    // but a sibling from the same folder is already filed in the project.
    const sibling = doc({
      id: 'sib',
      title: 'older.pdf',
      sourceFolderLabel: 'Downloads',
      collections: [{ id: 'cli', name: 'Client Müller', type: 'project', role: 'source' }]
    })
    const subject = doc({ id: 'd', title: 'newer.pdf', sourceFolderLabel: 'Downloads' })
    const out = suggestFilingForDocument(subject, [client], [subject, sibling])
    expect(out[0]).toMatchObject({
      ruleId: 'same-source-folder-cohort',
      target: { kind: 'existingProject', collectionId: 'cli' },
      reasonKey: 'docs.suggest.reason.cohort'
    })
  })

  it('filename pattern (EN): an invoice name with NO matching project ⇒ suggest creating one', () => {
    const subject = doc({ id: 'd', title: 'ACME-invoice-0042.pdf' })
    const out = suggestFilingForDocument(subject, [], [subject])
    expect(out[0]).toMatchObject({
      ruleId: 'filename-pattern',
      target: { kind: 'newProject', suggestedName: 'Invoices' },
      reasonKey: 'docs.suggest.reason.filename'
    })
  })

  it('filename pattern (DE): "Rechnung" matches an existing project whose name fits the category', () => {
    const inv = project({ id: 'inv', name: 'Rechnungen' })
    const subject = doc({ id: 'd', title: 'Rechnung_Januar.pdf' })
    const out = suggestFilingForDocument(subject, [inv], [subject])
    expect(out[0]).toMatchObject({
      ruleId: 'filename-pattern',
      target: { kind: 'existingProject', collectionId: 'inv' }
    })
  })

  it('no-suggestion case: an ordinary unfiled doc with no folder + no pattern ⇒ []', () => {
    const subject = doc({ id: 'd', title: 'meeting-minutes.pdf' })
    expect(suggestFilingForDocument(subject, [project({})], [subject])).toEqual([])
  })

  it('ranking + de-dup: folder-name match outranks the cohort, and the same project is not repeated', () => {
    const tax = project({ id: 'tax', name: 'Tax 2025' })
    const sibling = doc({
      id: 'sib',
      sourceFolderLabel: 'Tax 2025',
      collections: [{ id: 'tax', name: 'Tax 2025', type: 'project', role: 'source' }]
    })
    const subject = doc({ id: 'd', title: 'return.pdf', sourceFolderLabel: 'Tax 2025' })
    const out = suggestFilingForDocument(subject, [tax], [subject, sibling])
    // Both rule 1 and rule 2 point at 'tax'; only the higher-ranked folder-name match survives.
    expect(out).toHaveLength(1)
    expect(out[0].ruleId).toBe('folder-name-match')
  })

  it('excludes generated / temporary / archived / already-filed docs as subjects', () => {
    const tax = project({ id: 'tax', name: 'Tax 2025' })
    const base = { title: 'return.pdf', sourceFolderLabel: 'Tax 2025' }
    const generated = doc({
      ...base,
      id: 'g',
      origin: { kind: 'translation', sourceDocumentIds: ['s'], createdAt: 'x' }
    })
    const temporary = doc({ ...base, id: 't', lifecycle: 'temporary' })
    const archived = doc({ ...base, id: 'a', lifecycle: 'archived' })
    const filed = doc({
      ...base,
      id: 'f',
      collections: [{ id: 'other', name: 'Other', type: 'project', role: 'source' }]
    })
    for (const subject of [generated, temporary, archived, filed]) {
      expect(suggestFilingForDocument(subject, [tax], [subject])).toEqual([])
    }
  })

  it('does not suggest an archived project (folder match or cohort)', () => {
    const archivedProject = project({ id: 'arc', name: 'Tax 2025', archivedAt: '2026-02-01T00:00:00.000Z' })
    const sibling = doc({
      id: 'sib',
      sourceFolderLabel: 'Tax 2025',
      collections: [{ id: 'arc', name: 'Tax 2025', type: 'project', role: 'source' }]
    })
    const subject = doc({ id: 'd', sourceFolderLabel: 'Tax 2025' })
    expect(suggestFilingForDocument(subject, [archivedProject], [subject, sibling])).toEqual([])
  })

  it('is tolerant of missing/empty sourceFolderLabel and odd metadata (never throws)', () => {
    const tax = project({ id: 'tax', name: 'Tax 2025' })
    expect(() => suggestFilingForDocument(doc({ sourceFolderLabel: null }), [tax], [])).not.toThrow()
    expect(suggestFilingForDocument(doc({ sourceFolderLabel: '' }), [tax], [])).toEqual([])
    expect(suggestFilingForDocument(doc({ sourceFolderLabel: '   ' }), [tax], [])).toEqual([])
    // A sibling with no collections array must not break the cohort tally.
    const subject = doc({ id: 'd', title: 'x.pdf', sourceFolderLabel: 'F' })
    const sibling = doc({ id: 's', sourceFolderLabel: 'F' })
    expect(() => suggestFilingForDocument(subject, [tax], [subject, sibling])).not.toThrow()
  })

  it('is deterministic — repeated calls return identical output (no randomness, no clock)', () => {
    const tax = project({ id: 'tax', name: 'Tax 2025' })
    const subject = doc({ id: 'd', title: 'invoice.pdf', sourceFolderLabel: 'Tax 2025' })
    const a = suggestFilingForDocument(subject, [tax], [subject])
    const b = suggestFilingForDocument(subject, [tax], [subject])
    expect(a).toEqual(b)
  })
})

describe('suggestFilingForDocuments (batch)', () => {
  it('returns one entry per suggestable document and skips the rest', () => {
    const tax = project({ id: 'tax', name: 'Tax 2025' })
    const withSuggestion = doc({ id: 'd1', title: 'return.pdf', sourceFolderLabel: 'Tax 2025' })
    const ordinary = doc({ id: 'd2', title: 'random.pdf' })
    const generated = doc({
      id: 'd3',
      title: 'invoice.pdf',
      origin: { kind: 'translation', sourceDocumentIds: ['s'], createdAt: 'x' }
    })
    const out = suggestFilingForDocuments([withSuggestion, ordinary, generated], [tax])
    expect(out.map((r) => r.documentId)).toEqual(['d1'])
    expect(out[0].suggestions[0].target).toEqual({ kind: 'existingProject', collectionId: 'tax' })
  })
})
