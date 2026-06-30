import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, listTables, type Db } from '../../src/main/services/db'
import {
  createSkillRegistry,
  discoverSkillsInDir,
  getSkill,
  getSkillsByDeclaredId,
  listSkills,
  markSkillUnavailable,
  reconcileSkills,
  setSkillEnabled,
  skillInstallId,
  type ReconcileOptions
} from '../../src/main/services/skills/registry'
import { loadSkillPackage } from '../../src/main/services/skills/loader'
import { parseSkillManifestFromDir } from '../../src/main/services/skills/manifest'
import { DEFAULT_SKILL_LIMITS, type SkillLimits } from '../../src/main/services/skills/limits'

// Skills plan Phase S3 — registry & persistence (revised §0, plaintext plain-folder model):
// the additive `skills` table + the uniform disk reconcile of app-skills/ + user-skills/, with
// drop-in-disabled (DS19), DB-rebuild re-derivation (no orphan), and mark-unavailable.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-skills-'))
}

function freshDb(): Db {
  return openDatabase(join(tempDir(), 'test.sqlite'))
}

interface SkillFields {
  id?: string
  title?: string
  version?: string
  kind?: string
  keywords?: string[]
  body?: string
  extraFrontmatter?: string
}

/** Write a `<dir>/<folderName>/SKILL.md` package. Defaults make a minimal valid instruction skill. */
function writeSkill(parentDir: string, folderName: string, fields: SkillFields = {}): string {
  const dir = join(parentDir, folderName)
  mkdirSync(dir, { recursive: true })
  const id = fields.id ?? folderName
  const lines = [
    '---',
    `id: ${id}`,
    `title: ${fields.title ?? 'Skill ' + id}`,
    `description: A test skill named ${id}`,
    `version: ${fields.version ?? '1.0.0'}`
  ]
  if (fields.kind) lines.push(`kind: ${fields.kind}`)
  if (fields.keywords) {
    lines.push('triggers:')
    lines.push(`  keywords: [${fields.keywords.join(', ')}]`)
  }
  if (fields.extraFrontmatter) lines.push(fields.extraFrontmatter)
  lines.push('---')
  lines.push(fields.body ?? `Instructions for ${id}.`)
  writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'), 'utf8')
  return dir
}

/** A reconcile-options pair over two fresh temp source dirs. */
function makeDirs(): { appSkillsDir: string; userSkillsDir: string } {
  const root = tempDir()
  return { appSkillsDir: join(root, 'app-skills'), userSkillsDir: join(root, 'user-skills') }
}

function opts(dirs: { appSkillsDir: string; userSkillsDir: string }): ReconcileOptions {
  return { ...dirs }
}

describe('skills registry — schema', () => {
  it('adds the additive skills table + nullable ref columns', () => {
    const db = freshDb()
    expect(listTables(db)).toContain('skills')
    const convCols = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    const msgCols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(convCols).toContain('active_skill_id')
    expect(msgCols).toContain('skill_id')
    // No FK FROM messages INTO skills (audit C3) — refs are cleared by an app-level sweep.
    const fks = db.prepare('PRAGMA foreign_key_list(messages)').all() as Array<{ table: string }>
    expect(fks.some((f) => f.table === 'skills')).toBe(false)
  })
})

describe('skills registry — discovery', () => {
  it('skips non-skill folders silently and flags unsafe names / invalid manifests', () => {
    const dirs = makeDirs()
    mkdirSync(join(dirs.userSkillsDir, 'not-a-skill', 'sub'), { recursive: true }) // no SKILL.md
    writeSkill(dirs.userSkillsDir, 'Bad_Name') // not SKILL_ID_RE
    writeSkill(dirs.userSkillsDir, 'broken', { version: 'not-semver' }) // fails validation
    writeSkill(dirs.userSkillsDir, 'good')

    const res = discoverSkillsInDir(dirs.userSkillsDir, 'user')
    expect(res.skills.map((s) => s.folderName)).toEqual(['good'])
    expect(res.errors.some((e) => e.includes('Bad_Name'))).toBe(true)
    expect(res.errors.some((e) => e.includes('broken'))).toBe(true)
    // The non-skill folder is skipped without an error.
    expect(res.errors.some((e) => e.includes('not-a-skill'))).toBe(false)
  })

  it('keeps the first of two folders declaring the same id within a source', () => {
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'alpha', { id: 'dup' })
    writeSkill(dirs.userSkillsDir, 'beta', { id: 'dup' })
    const res = discoverSkillsInDir(dirs.userSkillsDir, 'user')
    expect(res.skills).toHaveLength(1)
    expect(res.skills[0].folderName).toBe('alpha') // sorted readdir order
    expect(res.errors.some((e) => e.includes('duplicate skill id'))).toBe(true)
  })

  it('returns no skills (no error) for an absent directory', () => {
    const res = discoverSkillsInDir(join(tempDir(), 'does-not-exist'), 'app')
    expect(res.skills).toHaveLength(0)
    expect(res.errors).toHaveLength(0)
  })
})

describe('skills registry — drop-in file-size cap (S2, full-audit-2026-06-30)', () => {
  // The installer's stageZip/stageFolder enforce maxFileBytes; the DROP-IN read path
  // (parseSkillManifestFromDir, reached by discoverSkillsInDir / loadSkillPackage on every
  // reconcile + per chat turn) must do the same statSync pre-check so an over-cap SKILL.md /
  // manifest.json dropped into the unencrypted user-skills/ is rejected/skipped WITHOUT being
  // read wholesale into the main process — a local memory-exhaustion DoS otherwise.
  const tightLimits: SkillLimits = { ...DEFAULT_SKILL_LIMITS, maxFileBytes: 512 }

  it('rejects an over-cap SKILL.md without reading it (and the same file is fine under the default cap)', () => {
    const dirs = makeDirs()
    // A perfectly VALID skill whose SKILL.md is padded past the (tight) per-file cap; only the
    // size cap can reject it (the 4 KiB body is far under the default 64 KiB maxBodyChars).
    writeSkill(dirs.userSkillsDir, 'huge', { body: 'x'.repeat(4096) })

    const capped = discoverSkillsInDir(dirs.userSkillsDir, 'user', { limits: tightLimits })
    expect(capped.skills).toHaveLength(0)
    expect(
      capped.errors.some((e) => e.includes('huge') && /larger than the allowed size/.test(e))
    ).toBe(true)

    // Discriminator (teeth): the file is otherwise valid — under the default 1 MiB cap the
    // identical folder discovers OK, so the statSync guard is the ONLY thing rejecting it.
    const generous = discoverSkillsInDir(dirs.userSkillsDir, 'user')
    expect(generous.skills.map((s) => s.folderName)).toEqual(['huge'])
  })

  it('skips an over-cap manifest.json without reading it; the skill still loads', () => {
    const dirs = makeDirs()
    // In-cap SKILL.md, but an over-cap manifest.json whose title CONFLICTS — if it were read, the
    // parser would emit a DS2 conflict note. Padding keeps the JSON valid but past the tight cap.
    const skillDir = writeSkill(dirs.userSkillsDir, 'cached', { title: 'Canonical Title' })
    const conflicting = { title: 'STALE CACHE TITLE', _pad: 'y'.repeat(4096) }
    writeFileSync(join(skillDir, 'manifest.json'), JSON.stringify(conflicting), 'utf8')

    // The skill still loads (the over-cap cache is non-fatal, exactly like a malformed one)…
    const capped = parseSkillManifestFromDir(skillDir, { limits: tightLimits })
    expect(capped.ok).toBe(true)
    expect(capped.manifest?.title).toBe('Canonical Title')
    // …and the over-cap manifest.json was NOT read: a DS2 conflict note would appear if it had been.
    expect(capped.notes.some((n) => /manifest\.json .* disagrees/.test(n))).toBe(false)

    // Discriminator (teeth): under the default cap the same manifest.json IS read → the note appears.
    const generous = parseSkillManifestFromDir(skillDir)
    expect(generous.ok).toBe(true)
    expect(generous.notes.some((n) => /manifest\.json .* disagrees/.test(n))).toBe(true)
  })
})

describe('skills registry — reconcile', () => {
  it('installs app skills enabled and user drop-ins DISABLED (DS19), with app-assigned trust', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'bank-statement')
    // A user skill that lies about its own trust — the parser ignores it, the registry assigns 'user'.
    writeSkill(dirs.userSkillsDir, 'my-skill', { extraFrontmatter: 'trust: app' })

    const res = reconcileSkills(db, opts(dirs))
    expect(res.inserted).toBe(2)
    expect(res.present).toBe(2)

    const appSkill = getSkill(db, 'app:bank-statement')!
    const userSkill = getSkill(db, 'user:my-skill')!
    expect(appSkill.enabled).toBe(true)
    expect(appSkill.trustedLevel).toBe('app')
    expect(appSkill.warningAck).toBe(true)
    expect(userSkill.enabled).toBe(false) // DS19 — dropped in, disabled until enabled
    expect(userSkill.trustedLevel).toBe('user')
    expect(userSkill.warningAck).toBe(false)
  })

  it('uses the deterministic "<source>:<id>" install id', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'thing')
    reconcileSkills(db, opts(dirs))
    expect(skillInstallId('user', 'thing')).toBe('user:thing')
    expect(getSkill(db, 'user:thing')).not.toBeNull()
  })

  it('lets the same declared id coexist across app and user sources (DS12)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'shared', { version: '2.0.0' })
    writeSkill(dirs.userSkillsDir, 'shared', { version: '1.0.0' })
    reconcileSkills(db, opts(dirs))
    const both = getSkillsByDeclaredId(db, 'shared')
    expect(both.map((s) => s.installId).sort()).toEqual(['app:shared', 'user:shared'])
    expect(both[0].source).toBe('app') // app first
  })

  it('reconcile collapses two same-id rows left both enabled (DS12 one-active safety net)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'shared', { version: '2.0.0' })
    writeSkill(dirs.userSkillsDir, 'shared', { version: '1.0.0' })
    reconcileSkills(db, opts(dirs))
    // Force the conflicting state the safety net exists for (e.g. a DB rebuild that left both on).
    setSkillEnabled(db, 'app:shared', true)
    setSkillEnabled(db, 'user:shared', true)
    reconcileSkills(db, opts(dirs))
    expect(getSkill(db, 'app:shared')!.enabled).toBe(true) // trust-first: the app skill stays active
    expect(getSkill(db, 'user:shared')!.enabled).toBe(false) // the user duplicate is disabled
  })

  it('caches triggers + compatibility into manifest_json (re-derivable cache, §22-C2)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'tagged', { keywords: ['invoice', 'receipt'] })
    reconcileSkills(db, opts(dirs))
    const rec = getSkill(db, 'user:tagged')!
    expect(rec.manifest.triggers.keywords).toEqual(['invoice', 'receipt'])
  })

  it('is idempotent — a second run over unchanged disk changes nothing', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'skill-a')
    writeSkill(dirs.userSkillsDir, 'skill-b')
    const first = reconcileSkills(db, opts(dirs))
    expect(first.inserted).toBe(2)
    const before = listSkills(db).map((s) => s.updatedAt)
    const second = reconcileSkills(db, opts(dirs))
    expect(second).toMatchObject({ inserted: 0, updated: 0, markedUnavailable: 0, present: 2 })
    const after = listSkills(db).map((s) => s.updatedAt)
    expect(after).toEqual(before) // no spurious updated_at bumps
  })

  it('reflects a folder added or a version changed between runs', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'one', { version: '1.0.0' })
    reconcileSkills(db, opts(dirs))

    // Add a second skill and bump the first's version.
    writeSkill(dirs.userSkillsDir, 'two')
    writeSkill(dirs.userSkillsDir, 'one', { version: '1.2.0' })
    const res = reconcileSkills(db, opts(dirs))
    expect(res.inserted).toBe(1) // 'two'
    expect(res.updated).toBe(1) // 'one' version bump
    expect(getSkill(db, 'user:one')!.version).toBe('1.2.0')
  })

  it('preserves the user enabled flag across a routine reconcile', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'keepme')
    reconcileSkills(db, opts(dirs))
    expect(setSkillEnabled(db, 'user:keepme', true)).toBe(true)
    reconcileSkills(db, opts(dirs)) // folder unchanged
    expect(getSkill(db, 'user:keepme')!.enabled).toBe(true) // not reset to the drop-in default
  })

  it('marks a vanished folder unavailable (never deletes) and restores it when the folder returns', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'flaky')
    reconcileSkills(db, opts(dirs))
    setSkillEnabled(db, 'user:flaky', true)

    rmSync(join(dirs.userSkillsDir, 'flaky'), { recursive: true, force: true })
    const gone = reconcileSkills(db, opts(dirs))
    expect(gone.markedUnavailable).toBe(1)
    const rec = getSkill(db, 'user:flaky')!
    expect(rec).not.toBeNull() // row left in place
    expect(rec.unavailableAt).not.toBeNull()
    expect(rec.enabled).toBe(true) // user state preserved through the outage

    writeSkill(dirs.userSkillsDir, 'flaky')
    reconcileSkills(db, opts(dirs))
    expect(getSkill(db, 'user:flaky')!.unavailableAt).toBeNull() // cleared on return
  })

  it('markSkillUnavailable only flips on first detection (idempotent)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'xx')
    reconcileSkills(db, opts(dirs))
    expect(markSkillUnavailable(db, 'user:xx')).toBe(true)
    expect(markSkillUnavailable(db, 'user:xx')).toBe(false) // already flagged
  })

  it('re-derives every skill from disk after a simulated DB rebuild (no orphan)', () => {
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'built-in')
    writeSkill(dirs.userSkillsDir, 'mine')

    const db1 = freshDb()
    reconcileSkills(db1, opts(dirs))
    expect(listSkills(db1)).toHaveLength(2)

    // Rebuild: a brand-new empty DB (disk is truth) re-reads the same folders.
    const db2 = freshDb()
    const res = reconcileSkills(db2, opts(dirs))
    expect(res.inserted).toBe(2)
    expect(listSkills(db2).map((s) => s.installId).sort()).toEqual(['app:built-in', 'user:mine'])
  })
})

describe('skills registry — handle + loader', () => {
  it('the createSkillRegistry handle reconciles, lists, gets and toggles enable', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'app-one')
    writeSkill(dirs.userSkillsDir, 'user-one')
    const registry = createSkillRegistry({ getDb: () => db, ...dirs })

    const res = registry.reconcile()
    expect(res.present).toBe(2)
    expect(registry.list().map((s) => s.installId)).toEqual(['app:app-one', 'user:user-one'])
    expect(registry.get('user:user-one')!.enabled).toBe(false)
    expect(registry.setEnabled('user:user-one', true)).toBe(true)
    expect(registry.get('user:user-one')!.enabled).toBe(true)
  })

  it('the loader reads the folder for both sources (one mode)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'a-skill', { body: 'App body.' })
    writeSkill(dirs.userSkillsDir, 'u-skill', { body: 'User body.' })
    reconcileSkills(db, opts(dirs))

    const app = loadSkillPackage(getSkill(db, 'app:a-skill')!, dirs)
    const user = loadSkillPackage(getSkill(db, 'user:u-skill')!, dirs)
    expect(app.ok).toBe(true)
    expect(app.body).toBe('App body.')
    expect(user.ok).toBe(true)
    expect(user.body).toBe('User body.')
  })

  it('reconcile creates the user-skills directory so a drop-in has somewhere to land', () => {
    const db = freshDb()
    const dirs = makeDirs() // neither dir exists yet
    const res = reconcileSkills(db, opts(dirs))
    expect(res.present).toBe(0)
    // user-skills/ now exists (created best-effort); a subsequent drop-in is discovered.
    writeSkill(dirs.userSkillsDir, 'late')
    expect(reconcileSkills(db, opts(dirs)).inserted).toBe(1)
  })
})
