import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { reconcileSkills, setSkillEnabled } from '../../src/main/services/skills/registry'
import { suggestSkillsForTurn } from '../../src/main/services/skills/suggest'
import { createConversation, getConversationDefaultSkill } from '../../src/main/services/chat'

// Skills plan §10.2/§16 (S8) — suggestSkills orchestration. Proves: scope is resolved MAIN-side from
// the conversationId (a doc in scope drives the offer, §22-C4); only ENABLED skills are candidates;
// at most one offer; and it is INERT — suggesting never writes the conversation's active_skill_id
// (never auto-applies — auto-fire is the deferred S13 wave).

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-suggest-'))
}
function freshDb(): Db {
  return openDatabase(join(tempDir(), 'test.sqlite'))
}
function dirs(): { appSkillsDir: string; userSkillsDir: string } {
  const root = tempDir()
  return { appSkillsDir: join(root, 'app-skills'), userSkillsDir: join(root, 'user-skills') }
}

function writeSkill(
  dir: string,
  id: string,
  triggers: { keywords?: string[]; mimeTypes?: string[]; filenamePatterns?: string[] }
): void {
  const d = join(dir, id)
  mkdirSync(d, { recursive: true })
  const lines = ['---', `id: ${id}`, `title: Skill ${id}`, `description: ${id} skill`, 'version: 1.0.0', 'triggers:']
  if (triggers.keywords) lines.push(`  keywords: [${triggers.keywords.join(', ')}]`)
  if (triggers.mimeTypes) lines.push(`  mimeTypes: [${triggers.mimeTypes.join(', ')}]`)
  if (triggers.filenamePatterns)
    lines.push(`  filenamePatterns: [${triggers.filenamePatterns.map((p) => `"${p}"`).join(', ')}]`)
  lines.push('---', `Instructions for ${id}.`)
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
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

  it('resolves the document scope MAIN-side: an in-scope file drives the offer (§22-C4)', () => {
    const db = freshDb()
    const d = dirs()
    // mime + filename together clear the bar (a lone filename would not).
    writeSkill(d.userSkillsDir, 'bank', { mimeTypes: ['application/pdf'], filenamePatterns: ['*statement*'] })
    reconcileSkills(db, d)
    setSkillEnabled(db, 'user:bank', true)
    const docId = seedIndexedDoc(db, 'march-statement.pdf', 'application/pdf')
    // The conversation's persisted scope names this doc; suggestSkills must resolve it from the
    // conversationId alone (the renderer passes no document ids — §22-C4).
    const conv = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [docId] }
    })
    // No question text — the suggestion comes purely from the in-scope document signals.
    const out = suggestSkillsForTurn(db, conv.id, '')
    expect(out.map((s) => s.installId)).toEqual(['user:bank'])
  })

  it('never suggests a DISABLED skill (candidates are enabled only)', () => {
    const db = freshDb()
    const d = dirs()
    writeSkill(d.userSkillsDir, 'bank', { keywords: ['bank statement'] })
    reconcileSkills(db, d) // drop-in installs DISABLED (DS19) — left disabled
    const conv = createConversation(db, {})
    expect(suggestSkillsForTurn(db, conv.id, 'bank statement please')).toEqual([])
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

  it('returns nothing for an unknown conversation + no keyword match (empty-tolerant)', () => {
    const db = freshDb()
    const d = dirs()
    writeSkill(d.userSkillsDir, 'bank', { keywords: ['bank statement'] })
    reconcileSkills(db, d)
    setSkillEnabled(db, 'user:bank', true)
    expect(suggestSkillsForTurn(db, 'no-such-conversation', 'hello there')).toEqual([])
  })
})

// German trigger coverage against the REAL committed meeting-protocol skill (bilingual reference).
// App skills install enabled by default, so reconciling the repo's app-skills/ makes it a live
// candidate; a German meeting question must clear the threshold and be the returned offer.
describe('meeting-protocol — German triggers fire against the real selector', () => {
  const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')

  function realDeps(): { appSkillsDir: string; userSkillsDir: string } {
    return {
      appSkillsDir: join(REPO_ROOT, 'app-skills'),
      userSkillsDir: join(tempDir(), 'user-skills')
    }
  }

  it('offers meeting-protocol for a German protocol question; nothing for a neutral one', () => {
    const db = freshDb()
    reconcileSkills(db, realDeps()) // app skills → enabled
    const conv = createConversation(db, {})

    const offer = suggestSkillsForTurn(db, conv.id, 'Erstelle bitte ein Protokoll dieser Besprechung')
    expect(offer).toHaveLength(1)
    expect(offer[0].installId).toBe('app:meeting-protocol')

    expect(suggestSkillsForTurn(db, conv.id, "What's the weather?")).toEqual([])
  })

  it('offers invoice for a German invoice question; nothing for a neutral one', () => {
    const db = freshDb()
    reconcileSkills(db, realDeps()) // app skills → enabled
    const conv = createConversation(db, {})

    // "rechnung" is a keyword (weight 2) → clears SUGGEST_SCORE_THRESHOLD on the real selector.
    const offer = suggestSkillsForTurn(db, conv.id, 'Prüfe die Beträge auf dieser Rechnung')
    expect(offer).toHaveLength(1)
    expect(offer[0].installId).toBe('app:invoice')

    expect(suggestSkillsForTurn(db, conv.id, 'Sag mir einen Witz')).toEqual([])
  })

  it('offers document-redaction for a German anonymization question; nothing for a neutral one', () => {
    const db = freshDb()
    reconcileSkills(db, realDeps()) // app skills → enabled
    const conv = createConversation(db, {})

    // "anonymisieren" is a keyword (weight 2) → clears SUGGEST_SCORE_THRESHOLD on the real selector.
    const offer = suggestSkillsForTurn(db, conv.id, 'Bitte dieses Dokument anonymisieren')
    expect(offer).toHaveLength(1)
    expect(offer[0].installId).toBe('app:document-redaction')

    expect(suggestSkillsForTurn(db, conv.id, 'Wie spät ist es?')).toEqual([])
  })
})
