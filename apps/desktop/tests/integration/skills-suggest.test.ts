import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Db } from '../../src/main/services/db'
import { reconcileSkills, setSkillEnabled } from '../../src/main/services/skills/registry'
import { suggestSkillsForTurn } from '../../src/main/services/skills/suggest'
import { __suggestSignalMaterializations } from '../../src/main/services/skills/scope-signals'
import { createConversation, getConversationDefaultSkill } from '../../src/main/services/chat'
import { addToCollection, getBuiltinCollection } from '../../src/main/services/collections'
import { openFreshDb } from '../helpers/db-fixtures'
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

function seedIndexedDoc(db: Db, title: string, mime: string): string {
  const now = new Date().toISOString()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?, ?)`
  ).run(id, title, mime, now, now)
  return id
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
    const d = dirs()
    // Two keyword-tied skills: `alpha` is keyword-only, `beta` also declares the PDF MIME. Without the scope's doc
    // signals both score 2 and the installId tie-break offers `user:alpha`; only a resolved in-scope PDF makes `beta` win.
    writeSkill(d.userSkillsDir, 'alpha', { keywords: ['bank statement'] })
    writeSkill(d.userSkillsDir, 'beta', { keywords: ['bank statement'], mimeTypes: ['application/pdf'] })
    reconcileSkills(db, d)
    setSkillEnabled(db, 'user:alpha', true)
    setSkillEnabled(db, 'user:beta', true)
    const docId = seedIndexedDoc(db, 'march-statement.pdf', 'application/pdf')
    // The conversation's persisted scope names this doc; suggestSkills must resolve it from the
    // conversationId alone (the renderer passes no document ids — §22-C4).
    const conv = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [docId] }
    })
    expect(suggestSkillsForTurn(db, conv.id, 'reconcile my bank statement').map((s) => s.installId)).toEqual([
      'user:beta'
    ])
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
  // debounced composer pause; memoize them keyed by the documents-table `(COUNT, MAX(rowid))`
  // signature and invalidate on a corpus change. Suggestions must stay byte-identical.
  it('memoizes whole-corpus doc signals across repeated suggestions; a corpus change re-ranks the offer (F-29)', () => {
    const db = freshDb()
    const d = dirs()
    // Keyword-tied `alpha` (keyword only) and `beta` (keyword + PDF MIME): the offer flips from `alpha` to `beta` only once a
    // PDF is in the corpus, so a stale memo (or a constant corpus signature) is visible in the returned offer.
    writeSkill(d.userSkillsDir, 'alpha', { keywords: ['bank statement'] })
    writeSkill(d.userSkillsDir, 'beta', { keywords: ['bank statement'], mimeTypes: ['application/pdf'] })
    reconcileSkills(db, d)
    setSkillEnabled(db, 'user:alpha', true)
    setSkillEnabled(db, 'user:beta', true)
    const importDoc = (title: string, mime: string): void =>
      addToCollection(db, [seedIndexedDoc(db, title, mime)], getBuiltinCollection(db, 'library')!.id)
    importDoc('notes.txt', 'text/plain')
    const conv = createConversation(db, {}) // whole-corpus (Library) scope — the expensive path
    const q = 'reconcile my bank statement'
    const ids = (): string[] => suggestSkillsForTurn(db, conv.id, q).map((s) => s.installId)

    expect(__suggestSignalMaterializations(db)).toBe(0)
    // Five debounced-pause suggestions over an UNCHANGED corpus materialize the whole-corpus signals
    // exactly ONCE; the resident cache serves the other four, and every offer is byte-identical.
    expect(ids()).toEqual(['user:alpha'])
    for (let i = 0; i < 4; i++) expect(ids()).toEqual(['user:alpha'])
    expect(__suggestSignalMaterializations(db)).toBe(1)

    // Importing a PDF changes the signature → the next call re-materializes and the offer re-ranks.
    importDoc('march-statement.pdf', 'application/pdf')
    expect(ids()).toEqual(['user:beta'])
    expect(__suggestSignalMaterializations(db)).toBe(2)

    // A documents-off conversation on the SAME Db is never served the whole-corpus signals from the memo
    // (the deny-all bit is part of the scope fingerprint): no PDF in scope → the keyword-only tie-break.
    // Prime the memo first with an explicit "All documents" scope — it resolves to the same empty ids, so
    // only the deny-all bit keeps the two fingerprints apart.
    const all = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [] } })
    expect(suggestSkillsForTurn(db, all.id, q).map((s) => s.installId)).toEqual(['user:beta'])
    const off = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [], documentsOff: true }
    })
    expect(suggestSkillsForTurn(db, off.id, q).map((s) => s.installId)).toEqual(['user:alpha'])
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
