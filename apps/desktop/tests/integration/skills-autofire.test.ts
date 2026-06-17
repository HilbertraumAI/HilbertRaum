import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { reconcileSkills, setSkillEnabled } from '../../src/main/services/skills/registry'
import { resolveTurnSkill, resolveTurnSkillFromRegistry } from '../../src/main/services/skills/turn'
import { resolveAutoFireSkill } from '../../src/main/services/skills/autofire'
import { createConversation, setConversationDefaultSkill } from '../../src/main/services/chat'
import { updateSettings } from '../../src/main/services/settings'

// Skills S13b — AUTO-FIRE mechanics (skills-s13-plan.md §2.1/§4). Proves the ratified contract:
//   D4  off by default (the safe-merge property — inert in production) AND app-skills only.
//   D6  only a skill that declares triggers.autoFire is a candidate.
//   D2  fire only at AUTOFIRE_SCORE_THRESHOLD (3) — a keyword corroborated by ≥1 doc signal; a lone
//       keyword (2) or a lone doc signal (≤2) does not auto-fire.
//   D5  never override a sticky default or an explicit per-turn clear — fire ONLY when no skill is set.
//   §6.5 an enabled-but-incompatible app skill never auto-fires.
// All deterministic + DB-only (no model, no Electron).

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-autofire-'))
}
function freshDb(): Db {
  return openDatabase(join(tempDir(), 'test.sqlite'))
}
function makeDirs(): { appSkillsDir: string; userSkillsDir: string } {
  const root = tempDir()
  return { appSkillsDir: join(root, 'app-skills'), userSkillsDir: join(root, 'user-skills') }
}

/** Write a SKILL.md (frontmatter triggers + optional autoFire + optional minAppVersion) into `dir`. */
function writeSkill(
  dir: string,
  id: string,
  opts: {
    keywords?: string[]
    mimeTypes?: string[]
    filenamePatterns?: string[]
    autoFire?: boolean
    minAppVersion?: string
  }
): void {
  const d = join(dir, id)
  mkdirSync(d, { recursive: true })
  const lines = ['---', `id: ${id}`, `title: Skill ${id}`, `description: ${id} skill`, 'version: 1.0.0']
  if (opts.minAppVersion) lines.push('compatibility:', `  minAppVersion: ${opts.minAppVersion}`)
  lines.push('triggers:')
  if (opts.keywords) lines.push(`  keywords: [${opts.keywords.join(', ')}]`)
  if (opts.mimeTypes) lines.push(`  mimeTypes: [${opts.mimeTypes.join(', ')}]`)
  if (opts.filenamePatterns)
    lines.push(`  filenamePatterns: [${opts.filenamePatterns.map((p) => `"${p}"`).join(', ')}]`)
  if (opts.autoFire !== undefined) lines.push(`  autoFire: ${opts.autoFire}`)
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

/**
 * An env with one ENABLED app skill `autobank` that declares autoFire + a strong keyword + a doc
 * signal, plus a `documents` conversation whose scope holds a matching PDF (so keyword + mime ⇒
 * score 3). Returns the db, dirs, and the conversation id.
 */
function envWithAutoFireSkill(extra?: (dirs: { appSkillsDir: string; userSkillsDir: string }) => void): {
  db: Db
  dirs: { appSkillsDir: string; userSkillsDir: string }
  convId: string
} {
  const db = freshDb()
  const dirs = makeDirs()
  writeSkill(dirs.appSkillsDir, 'autobank', {
    keywords: ['bank statement'],
    mimeTypes: ['application/pdf'],
    autoFire: true
  })
  extra?.(dirs)
  reconcileSkills(db, dirs) // app skills install ENABLED
  const docId = seedIndexedDoc(db, 'march.pdf', 'application/pdf')
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  return { db, dirs, convId: conv.id }
}

const Q_MATCH = 'please reconcile my bank statement' // keyword "bank statement" (2) + in-scope pdf (1) = 3

describe('resolveAutoFireSkill (S13b — the ratified contract)', () => {
  it('D4: off by default — a no-op even on a clear match (the safe-merge property)', () => {
    const { db, dirs, convId } = envWithAutoFireSkill()
    // Setting untouched ⇒ skillsAutoFireEnabled defaults false ⇒ inert.
    expect(resolveAutoFireSkill(db, dirs, convId, Q_MATCH)).toBeNull()
  })

  it('D2: opted in, keyword + a doc signal (score 3) ⇒ fires', () => {
    const { db, dirs, convId } = envWithAutoFireSkill()
    updateSettings(db, { skillsAutoFireEnabled: true })
    const skill = resolveAutoFireSkill(db, dirs, convId, Q_MATCH)
    expect(skill?.installId).toBe('app:autobank')
    expect(skill?.body).toContain('Instructions for autobank')
  })

  it('D2: a lone keyword (score 2, no doc in scope) does NOT auto-fire', () => {
    const { db, dirs } = envWithAutoFireSkill()
    updateSettings(db, { skillsAutoFireEnabled: true })
    // A conversation with no documents in scope ⇒ keyword-only ⇒ score 2 < 3.
    const conv = createConversation(db, {})
    expect(resolveAutoFireSkill(db, dirs, conv.id, Q_MATCH)).toBeNull()
  })

  it('D2: a lone doc signal (no keyword) does NOT auto-fire', () => {
    const { db, dirs, convId } = envWithAutoFireSkill()
    updateSettings(db, { skillsAutoFireEnabled: true })
    // The PDF is in scope (mime 1) but the question has no keyword ⇒ score 1 < 3.
    expect(resolveAutoFireSkill(db, dirs, convId, 'what is the weather today?')).toBeNull()
  })

  it('D2: an empty question never fires', () => {
    const { db, dirs, convId } = envWithAutoFireSkill()
    updateSettings(db, { skillsAutoFireEnabled: true })
    expect(resolveAutoFireSkill(db, dirs, convId, '   ')).toBeNull()
  })

  it('D6: an app skill that does NOT declare autoFire is never a candidate', () => {
    const { db, dirs, convId } = envWithAutoFireSkill((dirs) => {
      // A SECOND app skill, strong match but NOT opted in — must never fire.
      writeSkill(dirs.appSkillsDir, 'plainbank', {
        keywords: ['bank statement'],
        mimeTypes: ['application/pdf']
      })
    })
    updateSettings(db, { skillsAutoFireEnabled: true })
    // autobank (opted in) wins; plainbank (not opted in) is excluded even though it also scores 3.
    expect(resolveAutoFireSkill(db, dirs, convId, Q_MATCH)?.installId).toBe('app:autobank')

    // With ONLY a non-opted-in app skill present, nothing auto-fires.
    const db2 = freshDb()
    const dirs2 = makeDirs()
    writeSkill(dirs2.appSkillsDir, 'plainbank', { keywords: ['bank statement'], mimeTypes: ['application/pdf'] })
    reconcileSkills(db2, dirs2)
    updateSettings(db2, { skillsAutoFireEnabled: true })
    const docId = seedIndexedDoc(db2, 'march.pdf', 'application/pdf')
    const conv2 = createConversation(db2, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    expect(resolveAutoFireSkill(db2, dirs2, conv2.id, Q_MATCH)).toBeNull()
  })

  it('D4: a USER skill that declares autoFire is never auto-fired (app-only in v1)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'userbank', {
      keywords: ['bank statement'],
      mimeTypes: ['application/pdf'],
      autoFire: true
    })
    reconcileSkills(db, dirs)
    setSkillEnabled(db, 'user:userbank', true) // even enabled, a user skill is not an auto-fire candidate
    updateSettings(db, { skillsAutoFireEnabled: true })
    const docId = seedIndexedDoc(db, 'march.pdf', 'application/pdf')
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    expect(resolveAutoFireSkill(db, dirs, conv.id, Q_MATCH)).toBeNull()
  })

  it('§6.5: an enabled-but-incompatible app skill never auto-fires', () => {
    const { db, dirs, convId } = envWithAutoFireSkill((dirs) => {
      // Rewrite autobank to require a newer app (overwrites the env's autobank before reconcile).
      writeSkill(dirs.appSkillsDir, 'autobank', {
        keywords: ['bank statement'],
        mimeTypes: ['application/pdf'],
        autoFire: true,
        minAppVersion: '99.0.0'
      })
    })
    updateSettings(db, { skillsAutoFireEnabled: true })
    // Too old → excluded even though enabled + opted in + a strong match.
    expect(resolveAutoFireSkill(db, { ...dirs, appVersion: '1.2.3' }, convId, Q_MATCH)).toBeNull()
    // New enough → fires.
    expect(resolveAutoFireSkill(db, { ...dirs, appVersion: '99.0.0' }, convId, Q_MATCH)?.installId).toBe(
      'app:autobank'
    )
  })

  it('a disabled app skill is not a candidate', () => {
    const { db, dirs, convId } = envWithAutoFireSkill()
    setSkillEnabled(db, 'app:autobank', false)
    updateSettings(db, { skillsAutoFireEnabled: true })
    expect(resolveAutoFireSkill(db, dirs, convId, Q_MATCH)).toBeNull()
  })
})

describe('resolveTurnSkill plugs auto-fire into the single resolution path (§22-A1 / D5)', () => {
  it('D5: auto-fires when the turn has no skill set (no per-turn pick, no sticky default)', () => {
    const { db, dirs, convId } = envWithAutoFireSkill()
    updateSettings(db, { skillsAutoFireEnabled: true })
    // requestedInstallId undefined + no sticky default + a strong match ⇒ auto-fire fills the gap.
    expect(resolveTurnSkill(db, dirs, convId, undefined, Q_MATCH)?.installId).toBe('app:autobank')
    // No question passed ⇒ no auto-fire (the legacy callers' default; the resolver only fires with text).
    expect(resolveTurnSkill(db, dirs, convId)).toBeNull()
  })

  it('D5: never overrides a sticky default', () => {
    const { db, dirs, convId } = envWithAutoFireSkill((dirs) => {
      writeSkill(dirs.appSkillsDir, 'other', { keywords: ['unrelated'] })
    })
    updateSettings(db, { skillsAutoFireEnabled: true })
    setConversationDefaultSkill(db, convId, 'app:other')
    // The sticky default wins; auto-fire never overrides it even though autobank would score 3.
    expect(resolveTurnSkill(db, dirs, convId, undefined, Q_MATCH)?.installId).toBe('app:other')
  })

  it('D5: never overrides an explicit per-turn clear (null)', () => {
    const { db, dirs, convId } = envWithAutoFireSkill()
    updateSettings(db, { skillsAutoFireEnabled: true })
    // An explicit clear is a deliberate "no skill" pick — respected, not auto-filled.
    expect(resolveTurnSkill(db, dirs, convId, null, Q_MATCH)).toBeNull()
  })

  it('D5: never overrides an explicit per-turn pick', () => {
    const { db, dirs, convId } = envWithAutoFireSkill((dirs) => {
      writeSkill(dirs.appSkillsDir, 'other', { keywords: ['unrelated'] })
    })
    updateSettings(db, { skillsAutoFireEnabled: true })
    expect(resolveTurnSkill(db, dirs, convId, 'app:other', Q_MATCH)?.installId).toBe('app:other')
  })

  it('threads through resolveTurnSkillFromRegistry (both chat channels share this path)', () => {
    const { db, dirs, convId } = envWithAutoFireSkill()
    updateSettings(db, { skillsAutoFireEnabled: true })
    const registry = { appSkillsDir: dirs.appSkillsDir, userSkillsDir: dirs.userSkillsDir }
    expect(resolveTurnSkillFromRegistry(db, registry, convId, undefined, Q_MATCH)?.installId).toBe('app:autobank')
    // Off by default still inert through the registry wrapper.
    updateSettings(db, { skillsAutoFireEnabled: false })
    expect(resolveTurnSkillFromRegistry(db, registry, convId, undefined, Q_MATCH)).toBeNull()
  })
})
