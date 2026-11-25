import { describe, it, expect, vi } from 'vitest'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { failedSkillNeedsNewerApp, parseSkillMarkdown, skillNeedsNewerApp } from '../../src/shared/skill-manifest'
import { DESKTOP_ROOT } from '../helpers/repo-files'
import type { Db } from '../../src/main/services/db'
import { log } from '../../src/main/services/logging'
import { listTables, tempRoot, openFreshDb } from '../helpers/db-fixtures'
import { makeSkillDirs, writeSkillPackage, type SkillDirs } from '../helpers/skill-fixtures'
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
import { runnableToolNames } from '../../src/main/services/skills/tool-runs'
import { parseSkillManifestFromDir } from '../../src/main/services/skills/manifest'
import { DEFAULT_SKILL_LIMITS, type SkillLimits } from '../../src/main/services/skills/limits'

// Skills plan Phase S3 — registry & persistence (revised §0, plaintext plain-folder model):
// the additive `skills` table + the uniform disk reconcile of app-skills/ + user-skills/, with
// drop-in-disabled (DS19), DB-rebuild re-derivation (no orphan), and mark-unavailable.

const tempDir = (): string => tempRoot('skills')

const freshDb = (): Db => openFreshDb('skills')

interface SkillFields {
  id?: string
  title?: string
  version?: string
  kind?: string
  keywords?: string[]
  minAppVersion?: string
  body?: string
  extraFrontmatter?: string
}

/** Write a `<dir>/<folderName>/SKILL.md` package. Defaults make a minimal valid instruction skill. */
function writeSkill(parentDir: string, folderName: string, fields: SkillFields = {}): string {
  const id = fields.id ?? folderName
  return writeSkillPackage(
    parentDir,
    {
      id,
      title: fields.title ?? 'Skill ' + id,
      description: `A test skill named ${id}`,
      version: fields.version,
      kind: fields.kind,
      minAppVersion: fields.minAppVersion,
      triggers: fields.keywords ? { keywords: fields.keywords } : undefined,
      extraFrontmatter: fields.extraFrontmatter,
      body: fields.body
    },
    folderName
  )
}

/** A reconcile-options pair over two fresh temp source dirs. */
const makeDirs = (): SkillDirs => makeSkillDirs('skills')

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
    // SKA-32 content nuance: an INVALID folder name is arbitrary user text — the error line carries
    // the structural reason WITHOUT the name; the parallel code identifies it.
    expect(res.errors.some((e) => e.includes('Bad_Name'))).toBe(false)
    expect(res.errors.some((e) => e.includes('not a valid skill id'))).toBe(true)
    expect(res.errorCodes).toContain('invalidFolderName')
    // A VALID folder name (it IS a skill id) may ride the human-readable line.
    expect(res.errors.some((e) => e.includes('broken'))).toBe(true)
    expect(res.errorCodes).toContain('invalidManifest')
    // Codes stay parallel to the lines.
    expect(res.errorCodes).toHaveLength(res.errors.length)
    // The non-skill folder is skipped without an error.
    expect(res.errors.some((e) => e.includes('not-a-skill'))).toBe(false)
  })

  // SKA-16 (audit 2026-07-03, U7): one unreadable SKILL.md used to THROW out of discovery and kill
  // ALL reconciliation for the session. TEETH: revert the manifest.ts isFile() guard + the per-folder
  // try/catch → the directory-SKILL.md fixture throws EISDIR here and this test errors.
  it('survives a DIRECTORY named SKILL.md among good skills (skips it quietly — SKA-16)', () => {
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'good-one')
    // The hand-unpack accident: user-skills/foo/SKILL.md is a DIRECTORY.
    mkdirSync(join(dirs.userSkillsDir, 'foo', 'SKILL.md'), { recursive: true })
    writeSkill(dirs.userSkillsDir, 'zz-good-two')

    const res = discoverSkillsInDir(dirs.userSkillsDir, 'user')
    // Discovery stayed alive past the bad folder; the good skills on BOTH sides of it are found.
    expect(res.skills.map((s) => s.folderName)).toEqual(['good-one', 'zz-good-two'])
    // A non-file SKILL.md is "not a skill package" — skipped quietly, not an error.
    expect(res.errors).toHaveLength(0)
    expect(res.errorCodes).toHaveLength(0)
    // Reconcile has no guard of its own around discovery: both good skills still land in the DB.
    const db = freshDb()
    expect(reconcileSkills(db, opts(dirs)).inserted).toBe(2)
    expect(getSkill(db, skillInstallId('user', 'good-one'))).not.toBeNull()
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

  // W-65 (T2.14, F-25's new verdict): a folder whose SKILL.md fails this version's checks but declares a well-formed
  // minimum above the running app was made for a newer version; it gets its own code, not `invalidManifest`. The gate is
  // fail-open, so an app version it cannot read ('') leaves the folder `invalidManifest`.
  it.each([
    ['an app below the minimum', '0.1.66', 'needsNewerApp'],
    ['a pre-release of the minimum (older than its own release)', '0.2.0-beta.1', 'needsNewerApp'],
    ['an unknown app version (the gate is fail-open)', '', 'invalidManifest']
  ])('a folder made for a newer version, on %s (app %j), is %s', (_name, appVersion, code) => {
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'from-the-future', { kind: 'agent', minAppVersion: '0.2.0' })
    const res = discoverSkillsInDir(dirs.userSkillsDir, 'user', { appVersion })
    expect(res.skills).toHaveLength(0)
    expect(res.errorCodes).toEqual([code])
    expect(res.errors).toHaveLength(1)
  })
})

// SKA-36 (audit 2026-07-03, U7): crash-leftover `.skill-import-*` staging dirs and stale
// `.skill-backup-*` dirs (dot-names — excluded from discovery) accumulated invisibly on the
// portable drive forever. Reconcile now sweeps them, AGE-GATED (> 1 h by mtime) so a dir a live
// import could still own is never touched. TEETH: drop the sweep call in reconcileSkills → the
// stale-dir assertions fail.
describe('skills registry — stale staging/backup sweep (SKA-36)', () => {
  it('removes >1h-old .skill-import-*/.skill-backup-* dirs; spares fresh ones and real skills', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'keeper')
    const stale = join(dirs.userSkillsDir, '.skill-import-abc123')
    const staleBackup = join(dirs.userSkillsDir, '.skill-backup-keeper')
    const fresh = join(dirs.userSkillsDir, '.skill-import-live')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'SKILL.md'), 'half-written import leftovers')
    mkdirSync(staleBackup, { recursive: true })
    mkdirSync(fresh, { recursive: true })
    // Make the crash leftovers look 2 h old (the fresh dir keeps its just-created mtime).
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, twoHoursAgo, twoHoursAgo)
    utimesSync(staleBackup, twoHoursAgo, twoHoursAgo)

    reconcileSkills(db, opts(dirs))

    expect(existsSync(stale)).toBe(false) // crash leftover swept
    expect(existsSync(staleBackup)).toBe(false) // stale backup swept
    expect(existsSync(fresh)).toBe(true) // a dir a live import could own is NEVER swept
    expect(existsSync(join(dirs.userSkillsDir, 'keeper'))).toBe(true) // real skills untouched
    expect(getSkill(db, skillInstallId('user', 'keeper'))).not.toBeNull()
  })

  // Review hardening: a NOT-yet-sweepable (< 1 h) crash leftover carrying a half-written SKILL.md
  // must not surface as a "folder could not be read" error either — dot-named dirs are skipped
  // before any discovery check (they are lifecycle names, never packages).
  it('a fresh dot-named leftover is invisible to discovery (no phantom SKA-32 error)', () => {
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'good')
    const fresh = join(dirs.userSkillsDir, '.skill-import-crashed')
    mkdirSync(fresh, { recursive: true })
    writeFileSync(join(fresh, 'SKILL.md'), 'half-written')
    const res = discoverSkillsInDir(dirs.userSkillsDir, 'user')
    expect(res.skills.map((s) => s.folderName)).toEqual(['good'])
    expect(res.errors).toHaveLength(0)
    expect(res.errorCodes).toHaveLength(0)
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
    writeSkill(dirs.userSkillsDir, 'tagged', {
      keywords: ['invoice', 'receipt'],
      extraFrontmatter: '  autoFire: true\nanalysis: compare'
    })
    reconcileSkills(db, opts(dirs))
    const rec = getSkill(db, 'user:tagged')!
    expect(rec.manifest.triggers.keywords).toEqual(['invoice', 'receipt'])
    expect(rec.manifest.triggers.autoFire).toBe(true) // D6/#59: survives the DB round trip
    expect(rec.manifest.analysis).toBe('compare') // A3
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

  // W-65 (T2.14, F-25): a newer version rewrote an installed skill's SKILL.md (a kind this version does not know, made for
  // a newer version). The row stays, marked unavailable like a vanished folder, with the user's enabled flag and the
  // stored reason untouched, and the folder is counted as made for a newer version, not as unreadable.
  it('an installed skill a newer version rewrote keeps its row: unavailable, enabled and reason untouched, counted as newer (W-65)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'mine')
    writeSkill(dirs.appSkillsDir, 'built-in', { minAppVersion: '0.2.0' }) // the version gate keeps it off
    const registry = createSkillRegistry({ getDb: () => db, ...dirs, appVersion: '0.1.66' })
    registry.reconcile()
    setSkillEnabled(db, 'user:mine', true) // the user's choice: on, no reason
    const rowOf = (installId: string): unknown =>
      db.prepare('SELECT enabled, disabled_reason, unavailable_at FROM skills WHERE install_id = ?').get(installId)
    expect(rowOf('app:built-in')).toEqual({ enabled: 0, disabled_reason: 'min_app_version', unavailable_at: null })

    writeSkill(dirs.userSkillsDir, 'mine', { kind: 'agent', minAppVersion: '0.2.0' })
    writeSkill(dirs.appSkillsDir, 'built-in', { kind: 'agent', minAppVersion: '0.2.0' })
    registry.reconcile()
    expect(rowOf('user:mine')).toEqual({ enabled: 1, disabled_reason: null, unavailable_at: expect.any(String) })
    expect(rowOf('app:built-in')).toEqual({ enabled: 0, disabled_reason: 'min_app_version', unavailable_at: expect.any(String) })
    expect(registry.reconcileStatus()).toEqual({ errorCount: 0, errorCodes: [], needsNewerAppCount: 2 })
  })

  // W-65 (T2.14 fix round 2, review R2-3): such a row also tells the Skills tab WHY it is unavailable, so it reads "Needs
  // newer app" instead of "Files missing" (its files are on the drive). The reason is derived by each reconcile, found by
  // the row's folder (`path`), never stored: `unavailable_at`, `enabled` and `disabled_reason` stay as F-25 has them.
  // The next reconcile clears it when the folder validates again, when it vanishes, or on an app version the gate cannot
  // read (fail-open: the folder is then just invalid).
  it('the reconcile names the unavailable rows whose folder a newer version rewrote, and clears that when the folder changes (W-65, R2-3)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'mine')
    writeSkill(dirs.userSkillsDir, 'gone')
    writeSkill(dirs.userSkillsDir, 'broken')
    const registry = createSkillRegistry({ getDb: () => db, ...dirs, appVersion: '0.1.66' })
    expect(registry.reconcile().needsNewerAppRows).toEqual([])

    writeSkill(dirs.userSkillsDir, 'mine', { kind: 'agent', minAppVersion: '0.2.0' }) // made for a newer version
    rmSync(join(dirs.userSkillsDir, 'gone'), { recursive: true, force: true }) // vanished
    writeSkill(dirs.userSkillsDir, 'broken', { kind: 'agent' }) // invalid, no newer minimum
    expect(registry.reconcile().needsNewerAppRows).toEqual(['user:mine'])
    expect(['user:mine', 'user:gone', 'user:broken'].map((id) => [registry.unavailableReason(id), getSkill(db, id)!.unavailableAt !== null])).toEqual([
      ['needsNewerApp', true],
      [null, true],
      [null, true]
    ])
    // Never stored: the row's columns are the same as a vanished folder's.
    expect(db.prepare("SELECT enabled, disabled_reason FROM skills WHERE install_id = 'user:mine'").get()).toEqual({
      enabled: 0,
      disabled_reason: 'unconfirmed'
    })

    // On an app version the gate cannot read, the same folder is only invalid.
    const unknownApp = createSkillRegistry({ getDb: () => db, ...dirs, appVersion: '' })
    expect(unknownApp.reconcile().needsNewerAppRows).toEqual([])
    expect(unknownApp.unavailableReason('user:mine')).toBeNull()

    writeSkill(dirs.userSkillsDir, 'mine') // valid again
    expect(registry.reconcile().needsNewerAppRows).toEqual([])
    expect(registry.unavailableReason('user:mine')).toBeNull()
    expect(getSkill(db, 'user:mine')!.unavailableAt).toBeNull()

    writeSkill(dirs.userSkillsDir, 'mine', { kind: 'agent', minAppVersion: '0.2.0' })
    expect(registry.reconcile().needsNewerAppRows).toEqual(['user:mine'])
    rmSync(join(dirs.userSkillsDir, 'mine'), { recursive: true, force: true }) // then the folder vanishes
    registry.reconcile()
    expect(registry.unavailableReason('user:mine')).toBeNull()
    expect(getSkill(db, 'user:mine')!.unavailableAt).not.toBeNull()
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

// #846: `skills.disabled_reason` records why a row is off. Only `min_app_version` is ever acted on: an app skill the
// version gate kept off switches on once this build satisfies it, and every other reason (the user's, DS12's, DS19's,
// one only a newer build knows) is left alone. Frozen old-reader contract: the app-update plan's Appendix B lists these.
describe('skills registry — disabled reason (#846)', () => {
  const T1 = '2026-11-18T10:00:00.000Z'
  const T2 = '2026-11-18T11:00:00.000Z'
  const T3 = '2026-11-18T12:00:00.000Z'
  const at = (dirs: SkillDirs, appVersion: string | undefined, now: string): ReconcileOptions => ({
    ...dirs,
    appVersion,
    now: () => now
  })
  const reasonOf = (db: Db, installId: string): string | null =>
    (db.prepare('SELECT disabled_reason FROM skills WHERE install_id = ?').get(installId) as {
      disabled_reason: string | null
    }).disabled_reason
  const enabledOf = (db: Db, installId: string): boolean => getSkill(db, installId)!.enabled

  it('an app skill the version gate kept off switches on once the app satisfies it, with a counted log line', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'future', { minAppVersion: '2.0.0' })
    reconcileSkills(db, at(dirs, '1.0.0', T1))
    expect(enabledOf(db, 'app:future')).toBe(false)
    expect(reasonOf(db, 'app:future')).toBe('min_app_version')

    // Still too old, then a run that does not know its own version: nothing moves.
    expect(reconcileSkills(db, at(dirs, '1.9.9', T2)).reenabled).toBe(0)
    expect(reconcileSkills(db, at(dirs, undefined, T2)).reenabled).toBe(0)
    // #896: a pre-release of the release it needs is older than that release, as for a model's `min_app_version`.
    expect(reconcileSkills(db, at(dirs, '2.0.0-beta.1', T2)).reenabled).toBe(0)
    expect(reasonOf(db, 'app:future')).toBe('min_app_version')
    expect(enabledOf(db, 'app:future')).toBe(false)

    const info = vi.spyOn(log, 'info')
    try {
      const res = reconcileSkills(db, at(dirs, '2.0.0', T3))
      expect(res.reenabled).toBe(1)
      expect(info).toHaveBeenCalledWith(expect.stringContaining('re-enabled'), { count: 1 })
    } finally {
      info.mockRestore()
    }
    expect(enabledOf(db, 'app:future')).toBe(true)
    expect(reasonOf(db, 'app:future')).toBeNull()
    expect(getSkill(db, 'app:future')!.updatedAt).toBe(T3)
  })

  it('leaves every other reason alone: the user, a DS12 loser, an unconfirmed drop-in, a reason from a newer build', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'switched-off')
    writeSkill(dirs.appSkillsDir, 'shared')
    writeSkill(dirs.userSkillsDir, 'shared')
    writeSkill(dirs.appSkillsDir, 'policy-off')
    writeSkill(dirs.userSkillsDir, 'drop-in')
    reconcileSkills(db, at(dirs, '1.0.0', T1))
    expect(reasonOf(db, 'user:drop-in')).toBe('unconfirmed') // DS19: no import confirmation
    expect(reasonOf(db, 'app:switched-off')).toBeNull() // enabled rows carry no reason

    setSkillEnabled(db, 'app:switched-off', false, T2) // the Settings toggle (default reason)
    expect(reasonOf(db, 'app:switched-off')).toBe('user')
    // The user chose their own copy of `shared` over the built-in (the enable IPC's sibling disable).
    setSkillEnabled(db, 'user:shared', true, T2)
    setSkillEnabled(db, 'app:shared', false, T2, 'duplicate')
    db.prepare("UPDATE skills SET enabled = 0, disabled_reason = 'policy' WHERE install_id = 'app:policy-off'").run()

    const res = reconcileSkills(db, at(dirs, '9.0.0', T3))
    expect(res.reenabled).toBe(0)
    expect(enabledOf(db, 'app:switched-off')).toBe(false)
    expect(enabledOf(db, 'app:shared')).toBe(false)
    expect(enabledOf(db, 'user:shared')).toBe(true)
    expect(enabledOf(db, 'app:policy-off')).toBe(false)
    expect(reasonOf(db, 'app:policy-off')).toBe('policy')
    expect(enabledOf(db, 'user:drop-in')).toBe(false)
  })

  // F-846-3: only an APP skill comes back on. A user import the import gate left off records 'min_app_version' too
  // (installer.ts), and a drop-in row an older build wrote has no reason with installed_at = updated_at; neither is ever
  // switched on by a reconcile, whatever the app version.
  it('never switches on a user skill, whatever its reason says', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'imported', { minAppVersion: '2.0.0' })
    writeSkill(dirs.userSkillsDir, 'legacy-drop-in', { minAppVersion: '2.0.0' })
    reconcileSkills(db, at(dirs, '1.0.0', T1))
    setSkillEnabled(db, 'user:imported', false, T2, 'min_app_version') // what the import gate writes
    db.prepare("UPDATE skills SET disabled_reason = NULL WHERE install_id = 'user:legacy-drop-in'").run()

    const res = reconcileSkills(db, at(dirs, '2.0.0', T3))
    expect(res.reenabled).toBe(0)
    expect(enabledOf(db, 'user:imported')).toBe(false)
    expect(enabledOf(db, 'user:legacy-drop-in')).toBe(false)
    expect(reasonOf(db, 'user:imported')).toBe('min_app_version')
  })

  it('keeps the reason through a manifest change while the app is still too old', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'future', { minAppVersion: '2.0.0' })
    reconcileSkills(db, at(dirs, '1.0.0', T1))
    writeSkill(dirs.appSkillsDir, 'future', { minAppVersion: '2.0.0', version: '1.1.0' })
    expect(reconcileSkills(db, at(dirs, '1.0.0', T2)).updated).toBe(1)
    expect(reasonOf(db, 'app:future')).toBe('min_app_version')
    expect(enabledOf(db, 'app:future')).toBe(false)

    reconcileSkills(db, at(dirs, '2.0.0', T3))
    expect(enabledOf(db, 'app:future')).toBe(true)
  })

  it('infers the reason for a row an older build inserted (no reason, never touched since), and only for that row', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'legacy', { minAppVersion: '2.0.0' })
    writeSkill(dirs.appSkillsDir, 'touched', { minAppVersion: '2.0.0' })
    writeSkill(dirs.appSkillsDir, 'later', { minAppVersion: '3.0.0' })
    reconcileSkills(db, at(dirs, '1.0.0', T1))
    // What a build without the column leaves: the gate's insert (installed_at = updated_at), no reason.
    db.prepare('UPDATE skills SET disabled_reason = NULL').run()
    // A later write moved updated_at: the row could be anything now, so it stays off.
    db.prepare("UPDATE skills SET updated_at = ? WHERE install_id = 'app:touched'").run(T2)

    reconcileSkills(db, at(dirs, '2.0.0', T3))
    expect(enabledOf(db, 'app:legacy')).toBe(true)
    expect(enabledOf(db, 'app:touched')).toBe(false)
    expect(reasonOf(db, 'app:touched')).toBeNull()

    // Still too old for `later`: the inferred reason is recorded, so a later manifest change cannot erase it.
    expect(enabledOf(db, 'app:later')).toBe(false)
    expect(reasonOf(db, 'app:later')).toBe('min_app_version')
    writeSkill(dirs.appSkillsDir, 'later', { minAppVersion: '3.0.0', version: '1.1.0' })
    reconcileSkills(db, at(dirs, '2.0.0', '2026-11-18T13:00:00.000Z'))
    reconcileSkills(db, at(dirs, '3.0.0', '2026-11-18T14:00:00.000Z'))
    expect(enabledOf(db, 'app:later')).toBe(true)
  })

  it('the built-in wins over an enabled user copy of the same id when it switches on (DS12, the arrival rule)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'shared', { minAppVersion: '2.0.0' })
    writeSkill(dirs.userSkillsDir, 'shared')
    reconcileSkills(db, at(dirs, '1.0.0', T1))
    setSkillEnabled(db, 'user:shared', true, T2)

    reconcileSkills(db, at(dirs, '2.0.0', T3))
    expect(enabledOf(db, 'app:shared')).toBe(true)
    expect(enabledOf(db, 'user:shared')).toBe(false)
    expect(reasonOf(db, 'user:shared')).toBe('duplicate')
  })

  // Builds up to v0.1.65 read `skills` with `SELECT *` and write it with explicit column lists (verified at v0.1.50,
  // v0.1.60 and v0.1.65). Their exact statements, against the migrated table: the new column must not break them,
  // and a reason they leave stale on an ENABLED row means nothing.
  it('an older build reads and writes the migrated table unchanged', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.appSkillsDir, 'kept', { minAppVersion: '2.0.0' })
    reconcileSkills(db, at(dirs, '1.0.0', T1))
    const manifestJson = (db.prepare("SELECT manifest_json FROM skills WHERE install_id = 'app:kept'").get() as {
      manifest_json: string
    }).manifest_json

    db.prepare(
      `INSERT INTO skills (install_id, id, title, version, kind, source, path, enabled,
           warning_ack, trusted_level, manifest_json, unavailable_at, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run('user:old', 'old', 'Old', '1.0.0', 'instruction', 'user', 'old', 0, 0, 'user', manifestJson, T1, T1)
    db.prepare(
      `UPDATE skills SET title = ?, version = ?, kind = ?, source = ?, path = ?,
           trusted_level = ?, manifest_json = ?, unavailable_at = NULL, updated_at = ?
         WHERE install_id = ?`
    ).run('Kept', '1.0.0', 'instruction', 'app', 'kept', 'app', manifestJson, T2, 'app:kept')
    db.prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE install_id = ?').run(1, T2, 'app:kept')
    db.prepare('UPDATE skills SET unavailable_at = ?, updated_at = ? WHERE install_id = ? AND unavailable_at IS NULL').run(
      T2,
      T2,
      'user:old'
    )
    const rows = db.prepare('SELECT * FROM skills WHERE install_id IN (?, ?)').all('app:kept', 'user:old') as Array<{
      install_id: string
      enabled: number
      disabled_reason: string | null
    }>
    expect(rows.map((r) => [r.install_id, r.enabled, r.disabled_reason]).sort()).toEqual([
      ['app:kept', 1, 'min_app_version'], // stale, but the row is on: the reason is read only while enabled = 0
      ['user:old', 0, null]
    ])

    reconcileSkills(db, at(dirs, '1.0.0', T3))
    expect(enabledOf(db, 'app:kept')).toBe(true) // never switched off by a stale reason
  })
})

// App-update wave T2.10 (W-62, F-25): release 1 reads the drive's app-skills/ and every user skill a later release leaves,
// for ever. `tests/fixtures/readers/f25-skills/` holds skill folders written from the contract, with W-65's verdict as
// T2.14 built it, and `verdicts.json` says what release 1 makes of each at three app versions: the parse and the gate, the
// discovery code, the row a first reconcile leaves; then four reconcile sequences. The verdicts are data; these rows only
// compare them with the real readers. The folders are copied to a temp root: the reconcile writes beside them.
type F25Discovery = 'valid' | 'invalidManifest' | 'needsNewerApp' | 'invalidFolderName' | 'ignored'
interface F25Verdict {
  discovery: F25Discovery
  gate?: 'compatible' | 'needsNewerApp'
  row: { enabled: boolean; reason: string | null } | null
}
/** T2.7 fix round (R1 MJ-3): what release 1 reads of a value it does not know, of a key it reads leniently. */
interface F25Reads {
  analysis: string | null
  permissions: Record<string, string>
  allowedTools: string[]
  runnableTools: string[]
  noteCodes: string[]
}
interface F25Data {
  appVersion: string
  appVersions: string[]
  /** `id`: the declared id, where it is not the folder name (round 2). */
  skills: Array<F25Verdict & { folder: string; id?: string; class: string; at?: Record<string, F25Verdict>; reads?: F25Reads }>
  sequences: Array<{
    name: string
    folder: string
    steps: Array<{
      reconcileAt?: string
      userDisables?: true
      removeFolder?: true
      replaceWith?: string
      /** Round 2: the row as another build left it (a `disabled_reason` this one does not know). */
      setRow?: { enabled: boolean; reason: string | null }
      expect: { enabled: boolean; reason: string | null; available: boolean }
    }>
  }>
}

describe('F-25 golden skill folders: what release 1 accepts, lists, drops and ignores (T2.10, W-62)', () => {
  const SET = join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f25-skills')
  const data = JSON.parse(readFileSync(join(SET, 'verdicts.json'), 'utf8')) as F25Data
  const goldenDirs = (): SkillDirs => {
    const dirs = makeDirs()
    cpSync(join(SET, 'skills'), dirs.appSkillsDir, { recursive: true })
    return dirs
  }
  const at = (s: F25Data['skills'][number], appVersion: string): F25Verdict => s.at?.[appVersion] ?? s
  const stateOf = (db: Db, installId: string): { enabled: boolean; reason: string | null; available: boolean } | null => {
    const row = db.prepare('SELECT enabled, disabled_reason, unavailable_at FROM skills WHERE install_id = ?').get(installId) as
      | { enabled: number; disabled_reason: string | null; unavailable_at: string | null }
      | undefined
    return row ? { enabled: row.enabled === 1, reason: row.disabled_reason, available: row.unavailable_at === null } : null
  }

  it('every folder of the set has a verdict, and every class occurs', () => {
    expect(data.skills.map((s) => s.folder).sort()).toEqual(readdirSync(join(SET, 'skills')).sort())
    expect(new Set(data.skills.map((s) => s.class))).toEqual(new Set(['accepts', 'lists', 'drops', 'ignores']))
  })

  it.each(data.appVersions.map((v) => [JSON.stringify(v), v] as const))(
    'each folder, at app version %s: the parse and the gate, the discovery code, the row and the counts a reconcile leaves',
    (_label, appVersion) => {
      const dirs = goldenDirs()
      for (const s of data.skills) {
        const want = at(s, appVersion)
        const md = join(dirs.appSkillsDir, s.folder, 'SKILL.md')
        if (want.discovery === 'ignored' || want.discovery === 'invalidFolderName') continue
        const parsed = parseSkillMarkdown(readFileSync(md, 'utf8'))
        expect(parsed.ok, s.folder).toBe(want.discovery === 'valid')
        if (parsed.ok) {
          const gate = skillNeedsNewerApp(parsed.manifest!.compatibility.minAppVersion, appVersion) ? 'needsNewerApp' : 'compatible'
          expect(gate, s.folder).toBe(want.gate)
        } else {
          expect(failedSkillNeedsNewerApp(parsed, appVersion), s.folder).toBe(want.discovery === 'needsNewerApp')
        }
      }

      const found = discoverSkillsInDir(dirs.appSkillsDir, 'app', { appVersion })
      // A folder is named by its skill or its error line; a folder name that is no skill id never rides the line
      // (§22-M1), so those errors are matched by count. A folder neither names, and no unnamed error, is ignored.
      const named = (folder: string): F25Discovery | 'unnamed' => {
        if (found.skills.some((x) => x.folderName === folder)) return 'valid'
        const i = found.errors.findIndex((e) => e.startsWith(`app-skills/${folder}: `))
        return i >= 0 ? (found.errorCodes[i] as F25Discovery) : 'unnamed'
      }
      const unnamedCodes = found.errorCodes.filter((_code, i) => found.errors[i].startsWith('app-skills: '))
      const want = (s: F25Data['skills'][number]): F25Discovery | 'unnamed' => {
        const d = at(s, appVersion).discovery
        return d === 'ignored' || d === 'invalidFolderName' ? 'unnamed' : d
      }
      expect(Object.fromEntries(data.skills.map((s) => [s.folder, named(s.folder)]))).toEqual(
        Object.fromEntries(data.skills.map((s) => [s.folder, want(s)]))
      )
      expect(unnamedCodes).toEqual(data.skills.filter((s) => at(s, appVersion).discovery === 'invalidFolderName').map(() => 'invalidFolderName'))

      const db = freshDb()
      const registry = createSkillRegistry({ getDb: () => db, ...dirs, appVersion })
      registry.reconcile()
      const rows = Object.fromEntries(listSkills(db).map((r) => [r.installId, stateOf(db, r.installId)]))
      const wantRows = Object.fromEntries(
        data.skills.flatMap((s) => {
          const row = at(s, appVersion).row
          return row ? [[`app:${s.id ?? s.folder}`, { ...row, available: true }]] : []
        })
      )
      expect(rows).toEqual(wantRows)
      const count = (codes: F25Discovery[]): number => data.skills.filter((s) => codes.includes(at(s, appVersion).discovery)).length
      const newer = count(['needsNewerApp'])
      const status = registry.reconcileStatus()
      expect(status.errorCount).toBe(count(['invalidManifest', 'invalidFolderName']))
      expect(status.needsNewerAppCount).toBe(newer > 0 ? newer : undefined)
    }
  )

  // T2.7 fix round (R1 MJ-3): a new value of a key release 1 reads leniently (an analysis mode, a permission value, a tool),
  // with no minimum. The skill is valid and the value is dropped, so it runs without it: the parse, and the tools the app
  // skill's row may run.
  it.each(data.skills.filter((s) => s.reads !== undefined).map((s) => [s.folder, s] as const))(
    '%s: the value release 1 does not know is dropped and the skill runs without it (T2.7, R1 MJ-3)',
    (_folder, s) => {
      const dirs = goldenDirs()
      const parsed = parseSkillMarkdown(readFileSync(join(dirs.appSkillsDir, s.folder, 'SKILL.md'), 'utf8'))
      expect(parsed.ok, parsed.errors.join('; ')).toBe(true)
      const db = freshDb()
      reconcileSkills(db, { ...dirs, appVersion: data.appVersion })
      const record = getSkill(db, `app:${s.folder}`)!
      expect({
        analysis: parsed.manifest!.analysis ?? null,
        permissions: parsed.manifest!.permissions,
        allowedTools: parsed.manifest!.allowedTools,
        runnableTools: runnableToolNames(record, data.appVersion),
        noteCodes: (parsed.noteCodes ?? []).map((n) => n.code)
      }).toEqual(s.reads)
    }
  )

  it.each(data.sequences.map((q) => [q.name, q] as const))('%s', (_name, q) => {
    const dirs = goldenDirs()
    const db = freshDb()
    const installId = `app:${q.folder}`
    for (const [i, step] of q.steps.entries()) {
      if (step.removeFolder) rmSync(join(dirs.appSkillsDir, q.folder), { recursive: true, force: true })
      if (step.replaceWith) copyFileSync(join(SET, 'skills', step.replaceWith, 'SKILL.md'), join(dirs.appSkillsDir, q.folder, 'SKILL.md'))
      if (step.userDisables) expect(setSkillEnabled(db, installId, false)).toBe(true)
      if (step.setRow) {
        db.prepare('UPDATE skills SET enabled = ?, disabled_reason = ? WHERE install_id = ?').run(step.setRow.enabled ? 1 : 0, step.setRow.reason, installId)
      }
      if (step.reconcileAt !== undefined) reconcileSkills(db, { ...dirs, appVersion: step.reconcileAt })
      expect(stateOf(db, installId), `step ${i + 1}`).toEqual(step.expect)
    }
  })

  // T2.14 fix round 2 (review R2-3), an addition beside verdicts.json: the reason a reconcile gives for an unavailable row
  // (`needsNewerApp` when its folder now holds a skill made for a newer version), next to the same F-25 columns.
  const reasons = JSON.parse(readFileSync(join(SET, 'unavailable-reasons.json'), 'utf8')) as {
    sequences: Array<{
      name: string
      folder: string
      steps: Array<
        Omit<F25Data['sequences'][number]['steps'][number], 'expect'> & {
          expect: { enabled: boolean; reason: string | null; available: boolean; unavailableReason: string | null }
        }
      >
    }>
  }
  it.each(reasons.sequences.map((q) => [q.name, q] as const))('%s (R2-3)', (_name, q) => {
    const dirs = goldenDirs()
    const db = freshDb()
    const installId = `app:${q.folder}`
    let newerRows: string[] = []
    for (const [i, step] of q.steps.entries()) {
      if (step.removeFolder) rmSync(join(dirs.appSkillsDir, q.folder), { recursive: true, force: true })
      if (step.replaceWith) copyFileSync(join(SET, 'skills', step.replaceWith, 'SKILL.md'), join(dirs.appSkillsDir, q.folder, 'SKILL.md'))
      if (step.reconcileAt !== undefined) newerRows = reconcileSkills(db, { ...dirs, appVersion: step.reconcileAt }).needsNewerAppRows
      const unavailableReason = newerRows.includes(installId) ? 'needsNewerApp' : null
      expect({ ...stateOf(db, installId), unavailableReason }, `step ${i + 1}`).toEqual(step.expect)
    }
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

  // SKA-32 (audit 2026-07-03, U7): discovery errors were computed and then DROPPED by every
  // consumer — a drop-in with one YAML typo simply never appeared, with no toast/log/badge. The
  // registry now summarizes the last reconcile's errors as COUNTS + structural CODES (never folder
  // names or content — §22-M1), for the startup log + the Settings → Skills surfacing.
  it('reconcileStatus() summarizes the last reconcile errors as counts + codes (SKA-32)', () => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'good')
    writeSkill(dirs.userSkillsDir, 'broken', { version: 'not-semver' })
    writeSkill(dirs.userSkillsDir, 'Bad_Name')
    const registry = createSkillRegistry({ getDb: () => db, ...dirs })

    expect(registry.reconcileStatus()).toEqual({ errorCount: 0, errorCodes: [] }) // before any run
    registry.reconcile()
    const status = registry.reconcileStatus()
    expect(status.errorCount).toBe(2)
    expect([...status.errorCodes].sort()).toEqual(['invalidFolderName', 'invalidManifest'])
    // The summary is structural only — no folder name rides it (it is what gets logged/surfaced).
    expect(JSON.stringify(status)).not.toContain('Bad_Name')

    // A clean follow-up reconcile resets the summary (the fixed drop-in appears; errors go to 0).
    rmSync(join(dirs.userSkillsDir, 'broken'), { recursive: true, force: true })
    rmSync(join(dirs.userSkillsDir, 'Bad_Name'), { recursive: true, force: true })
    registry.reconcile()
    expect(registry.reconcileStatus()).toEqual({ errorCount: 0, errorCodes: [] })
  })

  // W-65 (T2.14): the folders made for a newer version get their own count (Settings → Skills shows C06/C07 for them), and
  // the "could not be read" count and codes stop including them. On an app version the gate cannot read, the same folder
  // is unreadable again (fail-open), so it is counted there.
  it.each([
    ['0.1.66', { errorCount: 1, errorCodes: ['invalidManifest'], needsNewerAppCount: 1 }],
    ['', { errorCount: 2, errorCodes: ['invalidManifest'] }]
  ])('reconcileStatus() counts the folders made for a newer version apart (app %j, W-65)', (appVersion, expected) => {
    const db = freshDb()
    const dirs = makeDirs()
    writeSkill(dirs.userSkillsDir, 'good')
    writeSkill(dirs.userSkillsDir, 'broken', { version: 'not-semver' })
    writeSkill(dirs.userSkillsDir, 'from-the-future', { kind: 'agent', minAppVersion: '0.2.0' })
    const registry = createSkillRegistry({ getDb: () => db, ...dirs, appVersion })
    registry.reconcile()
    expect(registry.reconcileStatus()).toEqual(expected)
    expect(JSON.stringify(registry.reconcileStatus())).not.toContain('from-the-future')
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
