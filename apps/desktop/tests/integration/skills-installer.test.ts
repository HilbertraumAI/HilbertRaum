import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  previewSkillPackage,
  importSkill,
  exportSkill,
  deleteSkill,
  SKILL_IMPORT_ERRORS,
  type SkillInstallerDeps
} from '../../src/main/services/skills/installer'
import { getSkill, getSkillsByDeclaredId, reconcileSkills, skillInstallId } from '../../src/main/services/skills/registry'
import { DEFAULT_SKILL_LIMITS, type SkillLimits } from '../../src/main/services/skills/limits'

// Skills plan Phase S4 — the import/export/install/delete lifecycle + the NEW safe member-by-member
// extractor (§22-A2). A view-imported `.skill.zip` is attacker-supplied and is now written STRAIGHT
// into a real on-disk folder, so the extractor matrix (traversal / symlink / zip-bomb-on-inflated /
// nested-archive-magic / extension-allowlist / §6.4 caps) is first-class HERE, not deferred to S12.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-skill-s4-'))
}

function freshDb(): Db {
  return openDatabase(join(tempDir(), 'test.sqlite'))
}

function makeDeps(over: Partial<SkillInstallerDeps> = {}): SkillInstallerDeps {
  const root = tempDir()
  return {
    appSkillsDir: join(root, 'app-skills'),
    userSkillsDir: join(root, 'user-skills'),
    now: () => '2026-06-17T00:00:00.000Z',
    ...over
  }
}

function skillMd(fields: { id?: string; title?: string; version?: string; body?: string } = {}): string {
  const id = fields.id ?? 'my-skill'
  return [
    '---',
    `id: ${id}`,
    `title: ${fields.title ?? 'My Skill'}`,
    `description: A test skill named ${id}.`,
    `version: ${fields.version ?? '1.0.0'}`,
    '---',
    fields.body ?? `Instructions for ${id}.`
  ].join('\n')
}

interface ZipMember {
  name: string
  content: string | Buffer
  unixPermissions?: number
  compress?: boolean
}

/** Build a `.skill.zip` on disk from explicit members (JSZip is only a TEST fixture builder). */
async function writeZip(members: ZipMember[], opts: { compress?: boolean } = {}): Promise<string> {
  const zip = new JSZip()
  for (const m of members) {
    zip.file(m.name, m.content, m.unixPermissions != null ? { unixPermissions: m.unixPermissions } : undefined)
  }
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    // UNIX platform so JSZip writes unixPermissions into the external attributes (the symlink
    // mode bits the extractor inspects); default DOS platform drops them.
    platform: 'UNIX',
    compression: opts.compress ? 'DEFLATE' : 'STORE'
  })
  const path = join(tempDir(), 'pkg.skill.zip')
  writeFileSync(path, buf)
  return path
}

/** A minimal valid single-file `.skill.zip`. */
async function validZip(fields: Parameters<typeof skillMd>[0] = {}): Promise<string> {
  return writeZip([{ name: 'SKILL.md', content: skillMd(fields) }])
}

// ---- the extractor matrix (§22-A2 / §9.2) -------------------------------------------

describe('safe extractor — rejects (nothing persisted, friendly + structural)', () => {
  it('rejects path traversal (../ escape)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd() },
      { name: '../evil.txt', content: 'pwned' }
    ])
    const preview = previewSkillPackage(db, zip, deps)
    expect(preview.ok).toBe(false)
    expect(preview.errors).toContain(SKILL_IMPORT_ERRORS.pathTraversal)
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.pathTraversal)
    expect(existsSync(deps.userSkillsDir) ? readdirSync(deps.userSkillsDir) : []).toEqual([])
  })

  it('rejects absolute / drive-letter member paths', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd() },
      { name: 'C:/Windows/evil.txt', content: 'x' }
    ])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.absolutePath)
  })

  it('rejects a symlink member (via its unix mode bits)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const S_IFLNK = 0o120000
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd() },
      { name: 'link.txt', content: '/etc/passwd', unixPermissions: S_IFLNK | 0o777 }
    ])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.symlink)
  })

  it('rejects a zip bomb on ACTUAL inflated bytes (not the declared size)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const limits: SkillLimits = { ...DEFAULT_SKILL_LIMITS, maxFileBytes: 64 * 1024 }
    // 1 MiB of a single repeated byte: deflates tiny, inflates well past the per-file cap.
    const zip = await writeZip([{ name: 'SKILL.md', content: 'A'.repeat(1024 * 1024) }], { compress: true })
    expect(() => importSkill(db, zip, { ...deps, limits })).toThrow(SKILL_IMPORT_ERRORS.fileTooLarge)
  })

  it('rejects a nested archive disguised by extension (magic-byte sniff — E2)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    // A real zip's leading bytes inside a member named like an allowed .csv.
    const innerZip = await new JSZip().file('a.txt', 'x').generateAsync({ type: 'nodebuffer' })
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd() },
      { name: 'resources/data.csv', content: innerZip }
    ])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.nestedArchive)
  })

  it('rejects a disallowed file extension', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd() },
      { name: 'evil.exe', content: 'MZ' }
    ])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.badExtension)
  })

  it('enforces the §6.4 caps (total size, file count, depth)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const tinyTotal: SkillLimits = { ...DEFAULT_SKILL_LIMITS, maxTotalBytes: 64 }
    const big = await writeZip([{ name: 'SKILL.md', content: 'x'.repeat(512) }])
    expect(() => importSkill(db, big, { ...deps, limits: tinyTotal })).toThrow(SKILL_IMPORT_ERRORS.tooLarge)

    const fewFiles: SkillLimits = { ...DEFAULT_SKILL_LIMITS, maxFiles: 1 }
    const many = await writeZip([
      { name: 'SKILL.md', content: skillMd() },
      { name: 'examples/a.md', content: 'a' },
      { name: 'examples/b.md', content: 'b' }
    ])
    expect(() => importSkill(db, many, { ...deps, limits: fewFiles })).toThrow(SKILL_IMPORT_ERRORS.tooManyFiles)

    const shallow: SkillLimits = { ...DEFAULT_SKILL_LIMITS, maxDepth: 2 }
    const deep = await writeZip([
      { name: 'SKILL.md', content: skillMd() },
      { name: 'a/b/c/deep.md', content: 'd' }
    ])
    expect(() => importSkill(db, deep, { ...deps, limits: shallow })).toThrow(SKILL_IMPORT_ERRORS.tooDeep)
  })

  it('rejects a package with no SKILL.md', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([{ name: 'notes.txt', content: 'just notes' }])
    const preview = previewSkillPackage(db, zip, deps)
    expect(preview.ok).toBe(false)
    expect(preview.errors).toContain(SKILL_IMPORT_ERRORS.noSkillMd)
  })

  it('a rejected import leaves NOTHING in user-skills (staging removed)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd() },
      { name: '../escape.txt', content: 'x' }
    ])
    expect(() => importSkill(db, zip, deps)).toThrow()
    const entries = existsSync(deps.userSkillsDir) ? readdirSync(deps.userSkillsDir) : []
    expect(entries).toEqual([]) // no <id>/ and no leftover .skill-import-* staging dir
  })
})

describe('safe extractor — never routes a .skill.zip through tar (§22-A2)', () => {
  it('the installer source contains no tar extractor reference', () => {
    const src = readFileSync(join(__dirname, '../../src/main/services/skills/installer.ts'), 'utf8')
    expect(src).not.toContain('extractWithTar')
    expect(src).not.toContain('tar -xf')
    expect(src).not.toContain('runtime-download')
  })
})

// ---- accepts + lifecycle -------------------------------------------------------------

describe('import → install (DS7 enabled-with-warning, folder named by id)', () => {
  it('installs a valid skill enabled with the warning unacknowledged, folder == id', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await validZip({ id: 'bank-statement' })
    const info = importSkill(db, zip, deps).info
    expect(info.id).toBe('bank-statement')
    expect(info.installId).toBe(skillInstallId('user', 'bank-statement'))
    expect(info.enabled).toBe(true) // DS7
    expect(info.warningAck).toBe(false) // persistent warning until acknowledged
    expect(info.source).toBe('user')
    expect(info.permissionSummary).toContain('cannot access the network')
    expect(existsSync(join(deps.userSkillsDir, 'bank-statement', 'SKILL.md'))).toBe(true)
  })

  it('normalizes a zip that wraps files under a single <id>/ folder', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([{ name: 'wrapped/SKILL.md', content: skillMd({ id: 'wrapped' }) }])
    const info = importSkill(db, zip, deps).info
    expect(info.id).toBe('wrapped')
    expect(existsSync(join(deps.userSkillsDir, 'wrapped', 'SKILL.md'))).toBe(true)
  })

  it('imports a folder source as well as a zip', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const folder = join(tempDir(), 'folder-skill')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), skillMd({ id: 'folder-skill' }))
    const info = importSkill(db, folder, deps).info
    expect(info.id).toBe('folder-skill')
    expect(info.enabled).toBe(true)
  })
})

describe('duplicate id — coexist with one active (DS12)', () => {
  it('re-import (upgrade) replaces the folder and keeps one user row', async () => {
    const db = freshDb()
    const deps = makeDeps()
    importSkill(db, await validZip({ id: 'dup', version: '1.0.0' }), deps)
    const upgraded = importSkill(db, await validZip({ id: 'dup', version: '1.1.0' }), deps).info
    expect(upgraded.version).toBe('1.1.0')
    expect(getSkillsByDeclaredId(db, 'dup').filter((s) => s.source === 'user')).toHaveLength(1)
  })

  it('a user import coexists DISABLED when an enabled app skill shares the id (trust-first)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    // Seed an enabled app skill of id "shared".
    mkdirSync(join(deps.appSkillsDir, 'shared'), { recursive: true })
    writeFileSync(join(deps.appSkillsDir, 'shared', 'SKILL.md'), skillMd({ id: 'shared' }))
    reconcileSkills(db, { appSkillsDir: deps.appSkillsDir, userSkillsDir: deps.userSkillsDir })
    const appInstall = skillInstallId('app', 'shared')
    expect(getSkill(db, appInstall)?.enabled).toBe(true)

    const userInfo = importSkill(db, await validZip({ id: 'shared' }), deps).info
    expect(userInfo.enabled).toBe(false) // coexists disabled — must not shadow the app skill
    expect(userInfo.duplicateId).toBe(true)
    expect(getSkill(db, appInstall)?.enabled).toBe(true) // app stays effective
  })

})

describe('downgrade is developer-mode gated (DS15)', () => {
  it('refuses a lower version unless developer mode', async () => {
    const db = freshDb()
    const deps = makeDeps()
    importSkill(db, await validZip({ id: 'dg', version: '2.0.0' }), deps)
    const older = await validZip({ id: 'dg', version: '1.0.0' })
    // Preview flags it; import refuses.
    const blocked = previewSkillPackage(db, older, deps, { developerMode: false })
    expect(blocked.isDowngrade).toBe(true)
    expect(blocked.downgradeBlocked).toBe(true)
    expect(() => importSkill(db, older, deps, { developerMode: false })).toThrow(
      SKILL_IMPORT_ERRORS.downgradeBlocked
    )
    // Developer mode allows it.
    const allowed = importSkill(db, older, deps, { developerMode: true }).info
    expect(allowed.version).toBe('1.0.0')
  })
})

describe('export excludes the cache + includes the package tree (§9.5)', () => {
  it('exports SKILL.md + subtrees, never manifest.json', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd({ id: 'exp' }) },
      { name: 'examples/one.md', content: 'example one' },
      { name: 'manifest.json', content: '{"id":"exp"}' }
    ])
    importSkill(db, zip, deps)
    // Drop a manifest.json cache into the placed folder too (re-derived; must be excluded).
    writeFileSync(join(deps.userSkillsDir, 'exp', 'manifest.json'), '{"cached":true}')
    const dest = join(tempDir(), 'exported.skill.zip')
    exportSkill(db, skillInstallId('user', 'exp'), dest, deps)

    const names = Object.keys((await JSZip.loadAsync(readFileSync(dest))).files)
    expect(names).toContain('SKILL.md')
    expect(names).toContain('examples/one.md')
    expect(names).not.toContain('manifest.json')
  })
})

describe('delete — ref-clear sweep in one txn (§22-C3)', () => {
  it('removes the folder + row and nulls active_skill_id / messages.skill_id', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const info = importSkill(db, await validZip({ id: 'del' }), deps).info
    const installId = info.installId

    // Wire up references the way chat/RAG will (no FK — an app-level sweep clears them).
    db.exec(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1','t','2026-06-17','2026-06-17')"
    )
    db.prepare('UPDATE conversations SET active_skill_id = ? WHERE id = ?').run(installId, 'c1')
    db.exec(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1','c1','assistant','hi','2026-06-17')"
    )
    db.prepare('UPDATE messages SET skill_id = ? WHERE id = ?').run(installId, 'm1')

    const res = deleteSkill(db, installId, deps)
    expect(res.deleted).toBe(true)
    expect(getSkill(db, installId)).toBeNull()
    expect(existsSync(join(deps.userSkillsDir, 'del'))).toBe(false)
    const conv = db.prepare('SELECT active_skill_id FROM conversations WHERE id = ?').get('c1') as {
      active_skill_id: string | null
    }
    const msg = db.prepare('SELECT skill_id FROM messages WHERE id = ?').get('m1') as { skill_id: string | null }
    expect(conv.active_skill_id).toBeNull()
    expect(msg.skill_id).toBeNull()
  })

  it('refuses to delete an app-shipped skill', async () => {
    const db = freshDb()
    const deps = makeDeps()
    mkdirSync(join(deps.appSkillsDir, 'shipped'), { recursive: true })
    writeFileSync(join(deps.appSkillsDir, 'shipped', 'SKILL.md'), skillMd({ id: 'shipped' }))
    reconcileSkills(db, { appSkillsDir: deps.appSkillsDir, userSkillsDir: deps.userSkillsDir })
    expect(() => deleteSkill(db, skillInstallId('app', 'shipped'), deps)).toThrow(
      SKILL_IMPORT_ERRORS.appReadOnly
    )
  })
})

describe('post-extract symlink defence (defence in depth)', () => {
  it('rejects a folder source whose tree contains a symlink', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const folder = join(tempDir(), 'sym-skill')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), skillMd({ id: 'sym-skill' }))
    const target = join(tempDir(), 'outside.txt')
    writeFileSync(target, 'secret')
    try {
      symlinkSync(target, join(folder, 'leak.txt'))
    } catch {
      return // Windows without symlink privilege — skip (the zip-path symlink test covers the logic)
    }
    expect(() => importSkill(db, folder, deps)).toThrow(SKILL_IMPORT_ERRORS.symlink)
  })
})
