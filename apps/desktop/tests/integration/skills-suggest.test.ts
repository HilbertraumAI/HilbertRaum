import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { corpusGeneration, type Db } from '../../src/main/services/db'
import type { RetrievalScope } from '../../src/shared/types'
import { reconcileSkills, setSkillEnabled } from '../../src/main/services/skills/registry'
import { suggestSkillsForTurn } from '../../src/main/services/skills/suggest'
import { __suggestSignalMaterializations } from '../../src/main/services/skills/scope-signals'
import { documentsInScope } from '../../src/main/services/skills/scope-documents'
import { createConversation, getConversationDefaultSkill } from '../../src/main/services/chat'
import {
  addToCollection,
  createCollection,
  getBuiltinCollection,
  removeFromCollection,
  setDocumentsLifecycle
} from '../../src/main/services/collections'
import { deleteDocument } from '../../src/main/services/ingestion'
import { openFreshDb, tempRoot } from '../helpers/db-fixtures'
import { makeSkillDirs, writeSkillPackage, type SkillDirs } from '../helpers/skill-fixtures'

// Skills plan §10.2/§16 (S8) — suggestSkills orchestration. Proves: scope is resolved MAIN-side from
// the conversationId (a doc in scope drives the offer, §22-C4); only ENABLED skills are candidates;
// at most one offer; and it is INERT — suggesting never writes the conversation's active_skill_id
// (never auto-applies — auto-fire is the deferred S13 wave).

const freshDb = (): Db => openFreshDb('suggest')
const dirs = (): SkillDirs => makeSkillDirs('suggest')

function writeSkill(
  dir: string,
  id: string,
  triggers: { keywords?: string[]; mimeTypes?: string[]; filenamePatterns?: string[] }
): void {
  writeSkillPackage(dir, { id, triggers })
}

function seedDoc(db: Db, title: string, mime: string, status = 'indexed'): string {
  const now = new Date().toISOString()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, title, status, mime, now, now)
  return id
}

const PDF = 'application/pdf'

/** Seed an indexed document and file it into `collectionId`; returns its id. */
function fileDoc(db: Db, collectionId: string, title: string, mime: string): string {
  const id = seedDoc(db, title, mime)
  addToCollection(db, [id], collectionId)
  return id
}

/**
 * Two keyword-tied skills: `alpha` (keyword only) and `beta` (keyword + PDF MIME). Both score 2 on the bank-statement
 * question, and the installId tie-break offers `user:alpha` — unless a PDF is in the conversation's scope, which lifts
 * `beta` to 3. So the returned offer says exactly whether the in-scope signals held a PDF, and a stale memo shows in it.
 */
function pdfDecidesOffer(db: Db): (conversationId: string) => string[] {
  const d = dirs()
  writeSkill(d.userSkillsDir, 'alpha', { keywords: ['bank statement'] })
  writeSkill(d.userSkillsDir, 'beta', { keywords: ['bank statement'], mimeTypes: [PDF] })
  reconcileSkills(db, d)
  setSkillEnabled(db, 'user:alpha', true)
  setSkillEnabled(db, 'user:beta', true)
  return (conversationId) =>
    suggestSkillsForTurn(db, conversationId, 'reconcile my bank statement').map((s) => s.installId)
}

const rowidOf = (db: Db, sql: string, ...params: string[]): number =>
  (db.prepare(sql).get(...params) as { rowid: number }).rowid
const docRowid = (db: Db, id: string): number => rowidOf(db, 'SELECT rowid FROM documents WHERE id = ?', id)
const membershipRowid = (db: Db, documentId: string, collectionId: string): number =>
  rowidOf(
    db,
    'SELECT rowid FROM document_collections WHERE document_id = ? AND collection_id = ?',
    documentId,
    collectionId
  )

/** The status write the ingestion pipeline makes at every stage (`setStatus` in ingestion/index.ts). */
function setDocStatus(db: Db, id: string, status: string): void {
  db.prepare('UPDATE documents SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    id
  )
}

const projectScope = (db: Db, collectionId: string): string =>
  createConversation(db, { mode: 'documents', scope: { collectionIds: [collectionId], documentIds: [] } }).id

/** Delete the newest document, then import a PDF into the same collection: it takes the freed rowids. */
function replaceNewestWithPdf(db: Db, collectionId: string, newest: string): void {
  const freed = [docRowid(db, newest), membershipRowid(db, newest, collectionId)]
  deleteDocument(db, tempRoot('suggest-store'), newest)
  const pdf = fileDoc(db, collectionId, 'march-statement.pdf', PDF)
  // The case the issue names: both new rows reuse the freed highest rowids, so COUNT and MAX(rowid) repeat.
  expect([docRowid(db, pdf), membershipRowid(db, pdf, collectionId)]).toEqual(freed)
}

describe('suggestSkillsForTurn (S8)', () => {
  it('suggests a skill by keyword in the draft question', () => {
    const db = freshDb()
    const d = dirs()
    writeSkill(d.userSkillsDir, 'bank', { keywords: ['bank statement'] })
    reconcileSkills(db, d)
    setSkillEnabled(db, 'user:bank', true)
    const conv = createConversation(db, {})
    const out = suggestSkillsForTurn(db, conv.id, 'please reconcile my bank statement')
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ installId: 'user:bank', title: 'Skill bank' })
  })

  it('resolves the document scope MAIN-side: an in-scope PDF ranks the doc-corroborated skill first (§22-C4)', () => {
    const db = freshDb()
    // Only a resolved in-scope PDF makes `beta` win the keyword tie (see `pdfDecidesOffer`).
    const offer = pdfDecidesOffer(db)
    const docId = seedDoc(db, 'march-statement.pdf', PDF)
    // The conversation's persisted scope names this doc; suggestSkills must resolve it from the
    // conversationId alone (the renderer passes no document ids — §22-C4).
    const conv = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [docId] }
    })
    expect(offer(conv.id)).toEqual(['user:beta'])
  })

  it('never suggests a DISABLED skill (candidates are enabled only)', () => {
    const db = freshDb()
    const d = dirs()
    writeSkill(d.userSkillsDir, 'bank', { keywords: ['bank statement'] })
    reconcileSkills(db, d) // drop-in installs DISABLED (DS19) — left disabled
    const conv = createConversation(db, {})
    expect(suggestSkillsForTurn(db, conv.id, 'bank statement please')).toEqual([])
  })

  it('never suggests an enabled-but-incompatible skill (§6.5/M1 airtight gate)', () => {
    const db = freshDb()
    const d = dirs()
    const dir = join(d.userSkillsDir, 'futurebank')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        'id: futurebank',
        'title: Skill futurebank',
        'description: needs a newer app',
        'version: 1.0.0',
        'compatibility:',
        '  minAppVersion: 99.0.0',
        'triggers:',
        '  keywords: [bank statement]',
        '---',
        'Instructions for futurebank.'
      ].join('\n'),
      'utf8'
    )
    reconcileSkills(db, d)
    setSkillEnabled(db, 'user:futurebank', true) // force-enable (simulate a stale enabled flag)
    const conv = createConversation(db, {})
    const q = 'please reconcile my bank statement'
    // Too old → not offered even though enabled and a strong keyword match.
    expect(suggestSkillsForTurn(db, conv.id, q, '1.2.3')).toEqual([])
    // New enough → offered normally.
    expect(suggestSkillsForTurn(db, conv.id, q, '99.0.0')).toEqual([
      { installId: 'user:futurebank', title: 'Skill futurebank' }
    ])
  })

  it('is INERT — suggesting never sets the conversation default (never auto-applies)', () => {
    const db = freshDb()
    const d = dirs()
    writeSkill(d.userSkillsDir, 'bank', { keywords: ['bank statement'] })
    reconcileSkills(db, d)
    setSkillEnabled(db, 'user:bank', true)
    const conv = createConversation(db, {})
    expect(getConversationDefaultSkill(db, conv.id)).toBeNull()
    suggestSkillsForTurn(db, conv.id, 'bank statement')
    // The offer is computed but NOT applied: the sticky default is untouched.
    expect(getConversationDefaultSkill(db, conv.id)).toBeNull()
  })

  // F-29 (audit 2026-07-16): the whole-corpus suggestion signals are re-materialized on every
  // debounced composer pause; memoize them per scope until a write changes the in-scope set
  // (#581: the corpus generation, not `(COUNT, MAX(rowid))`). Suggestions must stay byte-identical.
  it('memoizes whole-corpus doc signals across repeated suggestions; a corpus change re-ranks the offer (F-29)', () => {
    const db = freshDb()
    const offer = pdfDecidesOffer(db)
    const library = getBuiltinCollection(db, 'library')!.id
    const notes = fileDoc(db, library, 'notes.txt', 'text/plain')
    const conv = createConversation(db, {}) // whole-corpus (Library) scope — the expensive path

    expect(__suggestSignalMaterializations(db)).toBe(0)
    // Five debounced-pause suggestions over an UNCHANGED corpus materialize the whole-corpus signals
    // exactly ONCE; the resident cache serves the other four, and every offer is byte-identical.
    expect(offer(conv.id)).toEqual(['user:alpha'])
    for (let i = 0; i < 4; i++) expect(offer(conv.id)).toEqual(['user:alpha'])
    expect(__suggestSignalMaterializations(db)).toBe(1)

    // A deep-index build stamps `tree_status` / `updated_at` on its document again and again while the user
    // types. Those writes cannot change the signals, so they must not cost a re-materialization (#581).
    db.prepare(`UPDATE documents SET tree_status = 'building', updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      notes
    )
    expect(offer(conv.id)).toEqual(['user:alpha'])
    expect(__suggestSignalMaterializations(db)).toBe(1)

    // Nor does a PDF that is still importing: its queued row and pipeline steps are in no scope until it lands
    // as `indexed`, so they cost nothing either (#581).
    const pdf = seedDoc(db, 'march-statement.pdf', PDF, 'queued')
    for (const step of ['extracting', 'chunking', 'embedding']) setDocStatus(db, pdf, step)
    expect(offer(conv.id)).toEqual(['user:alpha'])
    expect(__suggestSignalMaterializations(db)).toBe(1)

    // The import finishing changes the in-scope set → the next call re-materializes and the offer re-ranks.
    setDocStatus(db, pdf, 'indexed')
    addToCollection(db, [pdf], library)
    expect(offer(conv.id)).toEqual(['user:beta'])
    expect(__suggestSignalMaterializations(db)).toBe(2)

    // A documents-off conversation on the SAME Db is never served the whole-corpus signals from the memo
    // (the deny-all bit is part of the scope fingerprint): no PDF in scope → the keyword-only tie-break.
    // Prime the memo first with an explicit "All documents" scope — it resolves to the same empty ids, so
    // only the deny-all bit keeps the two fingerprints apart.
    const all = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [] } })
    expect(offer(all.id)).toEqual(['user:beta'])
    const off = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [], documentsOff: true }
    })
    expect(offer(off.id)).toEqual(['user:alpha'])
  })

  // #581: the memo must never outlive a change to the in-scope set. Its old key, `(COUNT, MAX(rowid))` over the indexed
  // documents and over the memberships, repeated whenever SQLite handed a freed highest rowid to the next row (both are rowid
  // tables), and never saw an archive toggle or a status swap below the highest row. Each case asks once (which primes the
  // memo), makes one kind of write that moves a PDF into or out of scope, and expects the next offer to follow it. The
  // collision rows failed on the old key; the plain add/remove rows guard the triggers that alone see those writes now.
  it.each<[string, 'enters' | 'leaves', (db: Db) => { conversationId: string; change: () => void }]>([
    [
      'delete of the newest document and an import, Library scope',
      'enters',
      (db) => {
        const library = getBuiltinCollection(db, 'library')!.id
        fileDoc(db, library, 'notes.txt', 'text/plain')
        const newest = fileDoc(db, library, 'minutes.txt', 'text/plain')
        return {
          conversationId: createConversation(db, {}).id,
          change: () => replaceNewestWithPdf(db, library, newest)
        }
      }
    ],
    [
      'delete of the newest document and an import, project scope',
      'enters',
      (db) => {
        const project = createCollection(db, 'Tax 2025').id
        fileDoc(db, project, 'notes.txt', 'text/plain')
        const newest = fileDoc(db, project, 'minutes.txt', 'text/plain')
        return {
          conversationId: projectScope(db, project),
          change: () => replaceNewestWithPdf(db, project, newest)
        }
      }
    ],
    [
      'project membership swap that reuses the freed membership row',
      'enters',
      (db) => {
        const project = createCollection(db, 'Tax 2025').id
        const pdf = fileDoc(db, getBuiltinCollection(db, 'library')!.id, 'march-statement.pdf', PDF)
        const notes = fileDoc(db, project, 'notes.txt', 'text/plain') // filed last: the highest membership row
        return {
          conversationId: projectScope(db, project),
          change: () => {
            const freed = membershipRowid(db, notes, project)
            removeFromCollection(db, [notes], project)
            addToCollection(db, [pdf], project)
            expect(membershipRowid(db, pdf, project)).toBe(freed)
          }
        }
      }
    ],
    [
      'document archived',
      'leaves',
      (db) => {
        const library = getBuiltinCollection(db, 'library')!.id
        fileDoc(db, library, 'notes.txt', 'text/plain')
        const pdf = fileDoc(db, library, 'march-statement.pdf', PDF)
        return {
          conversationId: createConversation(db, {}).id,
          change: () => setDocumentsLifecycle(db, [pdf], 'archived')
        }
      }
    ],
    [
      're-index that finishes while another starts, below the highest indexed row',
      'enters',
      (db) => {
        const library = getBuiltinCollection(db, 'library')!.id
        const pdf = fileDoc(db, library, 'march-statement.pdf', PDF)
        const notes = fileDoc(db, library, 'notes.txt', 'text/plain')
        fileDoc(db, library, 'minutes.txt', 'text/plain') // stays indexed: MAX(rowid) never moves
        setDocStatus(db, pdf, 'embedding') // mid re-index: out of the indexed set
        return {
          conversationId: createConversation(db, {}).id,
          change: () => {
            setDocStatus(db, pdf, 'indexed')
            setDocStatus(db, notes, 'queued')
          }
        }
      }
    ],
    [
      // A generated document (a translation, a comparison) belongs to no collection and is reached only by explicit
      // selection, so no membership row cascades with its delete: only the documents delete trigger sees it go.
      'delete of a selected document that belongs to no collection',
      'leaves',
      (db) => {
        const pdf = seedDoc(db, 'march-statement.pdf', PDF)
        return {
          conversationId: createConversation(db, {
            mode: 'documents',
            scope: { collectionIds: [], documentIds: [pdf] }
          }).id,
          change: () => deleteDocument(db, tempRoot('suggest-store'), pdf)
        }
      }
    ],
    [
      'document added to the project',
      'enters',
      (db) => {
        const project = createCollection(db, 'Tax 2025').id
        fileDoc(db, project, 'notes.txt', 'text/plain')
        const pdf = fileDoc(db, getBuiltinCollection(db, 'library')!.id, 'march-statement.pdf', PDF)
        return {
          conversationId: projectScope(db, project),
          change: () => addToCollection(db, [pdf], project)
        }
      }
    ],
    [
      'document removed from the project',
      'leaves',
      (db) => {
        const project = createCollection(db, 'Tax 2025').id
        fileDoc(db, project, 'notes.txt', 'text/plain')
        const pdf = fileDoc(db, project, 'march-statement.pdf', PDF)
        return {
          conversationId: projectScope(db, project),
          change: () => removeFromCollection(db, [pdf], project)
        }
      }
    ]
  ])('the offer follows a %s (#581)', (_change, pdf, arrange) => {
    const db = freshDb()
    const offer = pdfDecidesOffer(db)
    const { conversationId, change } = arrange(db)
    const [before, after] = pdf === 'enters' ? ['user:alpha', 'user:beta'] : ['user:beta', 'user:alpha']
    expect(offer(conversationId)).toEqual([before])
    change()
    expect(offer(conversationId)).toEqual([after])
  })

  // #581: the generation's update trigger names the `documents` columns the scope query reads. This holds it to that
  // without reading either source: write every column of an in-scope document in turn, with values that flip the
  // predicates such a query uses (a status, an archive lifecycle, NULL against a set value, a date), and whenever the
  // query's answer changes, the generation must have moved. A predicate on a column the trigger misses fails here.
  it('every single-column write that changes the in-scope documents moves the corpus generation (#581)', () => {
    const db = freshDb()
    const library = getBuiltinCollection(db, 'library')!.id
    const doc = fileDoc(db, library, 'march-statement.pdf', PDF)
    const scopes: RetrievalScope[] = [
      { collectionIds: [library], documentIds: null, includeArchived: false },
      { collectionIds: null, documentIds: [doc], includeArchived: false },
      { collectionIds: null, documentIds: null, includeArchived: true }
    ]
    const answer = (): string =>
      JSON.stringify(scopes.map((s) => documentsInScope(db, s, { requireChunks: false })))
    const columns = (db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((c) => c !== 'id')
    const values = [null, 'indexed', 'failed', 'archived', 'permanent', 'other', '2000-01-01T00:00:00.000Z', 0, 1]
    const changedTheAnswer = new Set<string>()
    for (const column of columns) {
      const original = (db.prepare(`SELECT ${column} AS v FROM documents WHERE id = ?`).get(doc) as { v: unknown }).v
      for (const value of values) {
        const before = answer()
        const generation = corpusGeneration(db)
        try {
          db.prepare(`UPDATE documents SET ${column} = ? WHERE id = ?`).run(value as string | number | null, doc)
        } catch {
          continue // a NOT NULL column refuses null
        }
        if (answer() !== before) {
          changedTheAnswer.add(column)
          expect({ column, value, moved: corpusGeneration(db) !== generation }).toEqual({ column, value, moved: true })
        }
        db.prepare(`UPDATE documents SET ${column} = ? WHERE id = ?`).run(original as string | number | null, doc)
      }
    }
    // Not vacuous: the writes do reach the columns the query reads today.
    expect([...changedTheAnswer]).toEqual(expect.arrayContaining(['status', 'title', 'mime_type', 'lifecycle']))
  })

  // A rollback rewinds the generation with the data, so the next write can land on the same number with other
  // content. A suggestion read inside the transaction must therefore not be memoized (#581).
  it('never memoizes signals read inside a transaction that is then rolled back (#581)', () => {
    const db = freshDb()
    const offer = pdfDecidesOffer(db)
    const library = getBuiltinCollection(db, 'library')!.id
    fileDoc(db, library, 'notes.txt', 'text/plain')
    const conv = createConversation(db, {})
    expect(offer(conv.id)).toEqual(['user:alpha'])
    db.exec('BEGIN')
    // Raw membership insert: `addToCollection` opens its own transaction.
    db.prepare(
      `INSERT INTO document_collections (document_id, collection_id, role, added_at) VALUES (?, ?, 'source', ?)`
    ).run(seedDoc(db, 'march-statement.pdf', PDF), library, new Date().toISOString())
    expect(offer(conv.id)).toEqual(['user:beta'])
    db.exec('ROLLBACK')
    fileDoc(db, library, 'minutes.txt', 'text/plain') // the same two bumps: the generation repeats
    expect(offer(conv.id)).toEqual(['user:alpha'])
  })

  it('returns nothing for an unknown conversation + no keyword match (empty-tolerant)', () => {
    const db = freshDb()
    const d = dirs()
    writeSkill(d.userSkillsDir, 'bank', { keywords: ['bank statement'] })
    reconcileSkills(db, d)
    setSkillEnabled(db, 'user:bank', true)
    expect(suggestSkillsForTurn(db, 'no-such-conversation', 'hello there')).toEqual([])
  })
})
