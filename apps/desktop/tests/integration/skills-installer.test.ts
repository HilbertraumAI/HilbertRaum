import { describe, it, expect, vi } from 'vitest'
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
import { randomBytes } from 'node:crypto'
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

// Phase 8 / S-1: spy on `zlib.inflateRawSync` to prove the importer rejects an over-cap member
// BEFORE inflating it. `vi.spyOn` can't redefine a frozen ESM namespace, and spying on a default
// import doesn't intercept the installer's `import * as zlib` binding — so mock the module record
// itself (call-through preserves real inflate behaviour for every other test in this file).
const { inflateSpy } = vi.hoisted(() => ({ inflateSpy: vi.fn() }))
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  inflateSpy.mockImplementation((...args: Parameters<typeof actual.inflateRawSync>) =>
    actual.inflateRawSync(...args)
  )
  return { ...actual, inflateRawSync: inflateSpy as unknown as typeof actual.inflateRawSync }
})

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

const RAW_SIG_LFH = 0x04034b50
const RAW_SIG_CDH = 0x02014b50
const RAW_SIG_EOCD = 0x06054b50

/**
 * Hand-build a STORE-method `.skill.zip` on disk from explicit members. Unlike JSZip (which keys
 * files by name and so cannot emit two entries that share a name), this honours the member list
 * verbatim — letting a fixture craft the duplicate central-directory entries S-2 must reject.
 */
interface RawZipMember {
  name: string
  data: Buffer
  /** Central-directory general-purpose flag (TEST-4: bit 0 = encrypted). Default 0. */
  gpFlag?: number
  /** Central-directory uncompressed size override (TEST-4: 0xffffffff = ZIP64 sentinel). */
  uncompressedSizeOverride?: number
}
function writeRawZip(members: RawZipMember[]): string {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const m of members) {
    const nameBuf = Buffer.from(m.name, 'utf8')
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(RAW_SIG_LFH, 0)
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0, 8) // method 0 = store
    lfh.writeUInt32LE(m.data.length, 18) // compressed
    lfh.writeUInt32LE(m.data.length, 22) // uncompressed
    lfh.writeUInt16LE(nameBuf.length, 26)
    locals.push(lfh, nameBuf, m.data)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(RAW_SIG_CDH, 0)
    cdh.writeUInt16LE(20, 4) // version made by
    cdh.writeUInt16LE(20, 6) // version needed
    cdh.writeUInt16LE(m.gpFlag ?? 0, 8) // general-purpose flag (bit 0 = encrypted)
    cdh.writeUInt16LE(0, 10) // method 0 = store
    cdh.writeUInt32LE(m.data.length, 20) // compressed
    cdh.writeUInt32LE(m.uncompressedSizeOverride ?? m.data.length, 24) // uncompressed (0xffffffff = ZIP64)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt32LE(0, 38) // external attrs (no symlink bits)
    cdh.writeUInt32LE(offset, 42) // local header offset
    centrals.push(cdh, nameBuf)
    offset += lfh.length + nameBuf.length + m.data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const localBuf = Buffer.concat(locals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(RAW_SIG_EOCD, 0)
  eocd.writeUInt16LE(members.length, 8)
  eocd.writeUInt16LE(members.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16) // cd offset = end of locals
  const path = join(tempDir(), 'raw.skill.zip')
  writeFileSync(path, Buffer.concat([localBuf, centralBuf, eocd]))
  return path
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
    // The parallel content-free code lets the renderer localize the banner (I2).
    expect(preview.errorCodes).toEqual(['pathTraversal'])
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

// ---- Phase 8: zip importer DoS hardening (audit S-1 / S-2) ---------------------------

describe('safe extractor — DoS hardening (S-1 input bound, S-2 collision)', () => {
  it('S-1: rejects a member whose compressedSize exceeds maxFileBytes BEFORE inflating', async () => {
    const limits: SkillLimits = { ...DEFAULT_SKILL_LIMITS, maxFileBytes: 1024 }
    inflateSpy.mockClear()

    // POSITIVE CONTROL — a normal DEFLATE member really runs through inflateRawSync, proving the
    // spy is wired into the installer's call site (so the negative assertion below is meaningful,
    // not a false pass from a spy that never intercepts the installer's `import * as zlib`).
    const ctrl = await writeZip([{ name: 'SKILL.md', content: skillMd({ id: 'ctrl' }) }], { compress: true })
    importSkill(freshDb(), ctrl, makeDeps())
    expect(inflateSpy).toHaveBeenCalled()
    inflateSpy.mockClear()

    // S-1 — an incompressible 4 KiB member: its DEFLATE compressedSize (~4 KiB) exceeds the 1 KiB
    // per-file cap, so the new compressedSize guard must reject it without ever running the
    // synchronous inflate (the main-thread stall). Random bytes never deflate below their length,
    // so the compressedSize > cap relationship holds regardless of the exact ratio.
    const deps = makeDeps()
    const incompressible = randomBytes(4096)
    const zip = await writeZip([{ name: 'SKILL.md', content: incompressible }], { compress: true })
    expect(() => importSkill(freshDb(), zip, { ...deps, limits })).toThrow(SKILL_IMPORT_ERRORS.fileTooLarge)
    // The discriminator: WITHOUT the guard the slice would be sliced + inflated here (the stall);
    // WITH it the input is bounded before inflate, so inflateRawSync is never reached.
    expect(inflateSpy).not.toHaveBeenCalled()
    // Nothing persisted on a rejected import.
    expect(existsSync(deps.userSkillsDir) ? readdirSync(deps.userSkillsDir) : []).toEqual([])
  })

  it('S-2: rejects two members that collapse to the same stripped relPath', () => {
    const db = freshDb()
    const deps = makeDeps()
    // Two distinct central-directory entries that share one common top-level folder, so the prefix
    // strip collapses BOTH to `SKILL.md` — last-writer-wins would silently shadow the first. The
    // collision is caught structurally before anything is written.
    const body = Buffer.from(skillMd({ id: 'collide' }))
    const zip = writeRawZip([
      { name: 'pkg/SKILL.md', data: body },
      { name: 'pkg/SKILL.md', data: body }
    ])
    const preview = previewSkillPackage(db, zip, deps)
    expect(preview.ok).toBe(false)
    expect(preview.errors).toContain(SKILL_IMPORT_ERRORS.duplicatePath)
    expect(preview.errorCodes).toEqual(['duplicatePath'])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.duplicatePath)
    expect(existsSync(deps.userSkillsDir) ? readdirSync(deps.userSkillsDir) : []).toEqual([])
  })

  // SKA-30 (audit 2026-07-03, U7): the S-2 duplicate check compared EXACT strings, but the
  // portable drive's filesystems (NTFS/exFAT) are case-insensitive — `SKILL.md` + `skill.md`
  // last-writer-wins on write (the preview-validated-then-shadowed bypass), while a case-sensitive
  // OS keeps both: a polyglot package installs DIFFERENT instructions per OS. TEETH: revert the
  // guard to the exact-string `seen.has(rel)` → both fixtures import cleanly and these fail.
  it('SKA-30: rejects two members that collide only by CASE (SKILL.md + skill.md)', () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = writeRawZip([
      { name: 'SKILL.md', data: Buffer.from(skillMd({ id: 'case-collide' })) },
      { name: 'skill.md', data: Buffer.from(skillMd({ id: 'evil-shadow' })) }
    ])
    const preview = previewSkillPackage(db, zip, deps)
    expect(preview.ok).toBe(false)
    expect(preview.errorCodes).toEqual(['duplicatePath'])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.duplicatePath)
    expect(existsSync(deps.userSkillsDir) ? readdirSync(deps.userSkillsDir) : []).toEqual([])
  })

  it('SKA-30: rejects a file-vs-directory casing merge (Notes.md file + notes.md/… dir)', () => {
    const db = freshDb()
    const deps = makeDeps()
    // On a case-insensitive write, mkdir('notes.md') collides with the file 'Notes.md'.
    const zip = writeRawZip([
      { name: 'SKILL.md', data: Buffer.from(skillMd({ id: 'dir-merge' })) },
      { name: 'Notes.md', data: Buffer.from('a file') },
      { name: 'notes.md/inner.md', data: Buffer.from('a dir of the same folded name') }
    ])
    const preview = previewSkillPackage(db, zip, deps)
    expect(preview.ok).toBe(false)
    expect(preview.errorCodes).toEqual(['duplicatePath'])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.duplicatePath)
  })

  it('SKA-30: same-name members in DIFFERENT folders still import fine (no over-reject)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd({ id: 'no-over-reject' }) },
      { name: 'examples/readme.md', content: 'a' },
      { name: 'resources/readme.md', content: 'b' }
    ])
    expect(importSkill(db, zip, deps).info.id).toBe('no-over-reject')
  })

  it('a legitimate well-formed package still imports unchanged after the new bounds', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd({ id: 'still-ok' }) },
      { name: 'examples/one.md', content: 'a worked example' }
    ])
    const info = importSkill(db, zip, deps).info
    expect(info.id).toBe('still-ok')
    expect(existsSync(join(deps.userSkillsDir, 'still-ok', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(deps.userSkillsDir, 'still-ok', 'examples', 'one.md'))).toBe(true)
  })
})

// ---- TEST-4 (full-audit-2026-06-29, Phase 3): the coded error constants with no test -------------
// The installer is the best-tested security surface (the S-1 zip-bomb positive control is exemplary),
// but three coded guards had NO test: the ZIP64 / encrypted-GP-flag rejection (`encryptedZip`), the
// SEC-N1 NUL-byte content-leak defence (`invalidPath`), and the path-length cap (`pathTooLong`). Each
// is exercised through the REAL previewSkillPackage / importSkill entry points (the structural reason
// must surface; nothing throws raw / leaks a path). TEETH per test below (neuter the named guard →
// the errorCodes assertion no longer holds).
describe('safe extractor — coded error constants (TEST-4)', () => {
  it('rejects an ENCRYPTED member (GP-flag bit 0) → encryptedZip', () => {
    const db = freshDb()
    const deps = makeDeps()
    // An otherwise-valid SKILL.md whose central-directory entry sets the "encrypted" GP flag.
    // TEETH: drop `if (gpFlag & 0x0001) throw …encryptedZip` (installer.ts) → the store member reads
    // as plaintext, preview.ok becomes true, and errorCodes is no longer ['encryptedZip'].
    const zip = writeRawZip([{ name: 'SKILL.md', data: Buffer.from(skillMd({ id: 'enc' })), gpFlag: 0x0001 }])
    const preview = previewSkillPackage(db, zip, deps)
    expect(preview.ok).toBe(false)
    expect(preview.errorCodes).toEqual(['encryptedZip'])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.encryptedZip)
  })

  it('rejects a ZIP64-sentinel size member (uncompressedSize = 0xFFFFFFFF) → encryptedZip', () => {
    const db = freshDb()
    const deps = makeDeps()
    // TEETH: drop the `uncompressedSize === 0xffffffff … throw …encryptedZip` ZIP64 guard → the
    // 0xFFFFFFFF declared size instead trips the declared-total cap (`tooLarge`), so errorCodes flips.
    const zip = writeRawZip([
      { name: 'SKILL.md', data: Buffer.from(skillMd({ id: 'z64' })), uncompressedSizeOverride: 0xffffffff }
    ])
    const preview = previewSkillPackage(db, zip, deps)
    expect(preview.ok).toBe(false)
    expect(preview.errorCodes).toEqual(['encryptedZip'])
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.encryptedZip)
  })

  it('rejects a NUL byte in a member path → invalidPath, and never echoes the raw path (SEC-N1)', () => {
    const db = freshDb()
    const deps = makeDeps()
    const NUL = String.fromCharCode(0) // build the NUL via code so the source carries no literal NUL byte
    // SEC-N1: a NUL passes the ../-/drive-/depth checks but makes the OS path invalid; the raw
    // writeFileSync throw would EMBED the attacker-controlled name in the IPC error payload. The
    // structural guard rejects it up front with a FIXED, content-free reason — before any write.
    // TEETH: drop `if (name.includes(NUL)) throw …invalidPath` → the write throws raw
    // ERR_INVALID_ARG_VALUE, which preview remaps to `unreadableZip` (and importSkill throws raw).
    const zip = writeRawZip([
      { name: 'SKILL.md', data: Buffer.from(skillMd({ id: 'nul' })) },
      { name: `evil${NUL}.md`, data: Buffer.from('x') }
    ])
    const preview = previewSkillPackage(db, zip, deps)
    expect(preview.ok).toBe(false)
    expect(preview.errorCodes).toEqual(['invalidPath'])
    // The reason is the fixed structural string — it never echoes the crafted (NUL-bearing) name.
    expect(preview.errors).toEqual([SKILL_IMPORT_ERRORS.invalidPath])
    expect(preview.errors.join('')).not.toContain(NUL)
    expect(() => importSkill(db, zip, deps)).toThrow(SKILL_IMPORT_ERRORS.invalidPath)
  })

  it('rejects an over-long member path → pathTooLong', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const limits: SkillLimits = { ...DEFAULT_SKILL_LIMITS, maxPathLen: 16 }
    // 'SKILL.md' (8) ≤ 16 stays valid; the second member's path (29) exceeds the cap.
    // TEETH: drop `if (name.length > maxPathLen) throw …pathTooLong` → the long .md path is accepted
    // (depth 2 ≤ 4), preview.ok becomes true, and errorCodes is no longer ['pathTooLong'].
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd({ id: 'pl' }) },
      { name: 'examples/way-too-long-name.md', content: 'x' }
    ])
    const preview = previewSkillPackage(db, zip, { ...deps, limits })
    expect(preview.ok).toBe(false)
    expect(preview.errorCodes).toEqual(['pathTooLong'])
    expect(() => importSkill(db, zip, { ...deps, limits })).toThrow(SKILL_IMPORT_ERRORS.pathTooLong)
  })
})

describe('safe extractor — never routes a .skill.zip through tar (§22-A2)', () => {
  // DOCUMENTATION-ONLY static guard (TEST-4): there is nothing to observe at runtime — the installer
  // simply never imports a shell-tar extractor — so this is a source grep, not a behavioral assertion.
  // It pins the §22-A2 contract: a `.skill.zip` is attacker-supplied + unsigned and must NEVER be
  // routed through the validation-blind shell-tar path that elsewhere extracts SHA-verified runtime
  // archives. (A behavioral test would have no call site to intercept.)
  it('the installer source contains no tar extractor reference (documentation-only)', () => {
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

describe('export excludes the cache + includes the package tree (§9.5 / SKA-34)', () => {
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

  // SKA-34 (audit 2026-07-03, U7) — the DECISION: export mirrors IMPORT's acceptance (everything
  // allowed under the skill dir minus the manifest.json cache), so `export(import(pkg)) == pkg`.
  // Before, export collected only the four canonical subdirs: a third-party skill's
  // `notes/usage.md` installed fine and silently VANISHED from a shared re-export. TEETH: restore
  // the EXPORT_SUBDIRS allowlist → `notes/usage.md` is missing and the fidelity assertions fail.
  it('SKA-34: import → export → re-import round-trips a NON-canonical tree byte-identically', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const members = [
      { name: 'SKILL.md', content: skillMd({ id: 'fidelity' }) },
      { name: 'examples/one.md', content: 'a canonical-subdir file' },
      { name: 'notes/usage.md', content: 'a third-party NON-canonical file' },
      { name: 'data.csv', content: 'a,root,file' }
    ]
    importSkill(db, await writeZip(members), deps)

    const dest = join(tempDir(), 'roundtrip.skill.zip')
    exportSkill(db, skillInstallId('user', 'fidelity'), dest, deps)

    // Fidelity half 1: the exported zip carries EXACTLY the imported package files (no cache).
    const exported = await JSZip.loadAsync(readFileSync(dest))
    const names = Object.keys(exported.files).filter((n) => !exported.files[n].dir)
    expect(names.sort()).toEqual(members.map((m) => m.name).sort())
    for (const m of members) {
      expect((await exported.files[m.name].async('nodebuffer')).toString('utf8')).toBe(m.content)
    }

    // Fidelity half 2: the export RE-IMPORTS cleanly on a second machine (a fresh db + dirs).
    const db2 = freshDb()
    const deps2 = makeDeps()
    const info = importSkill(db2, dest, deps2).info
    expect(info.id).toBe('fidelity')
    expect(existsSync(join(deps2.userSkillsDir, 'fidelity', 'notes', 'usage.md'))).toBe(true)
    expect(readFileSync(join(deps2.userSkillsDir, 'fidelity', 'data.csv'), 'utf8')).toBe('a,root,file')
  })

  // Review hardening: import skips dot-named entries too (export always did), so a dot-file can no
  // longer install and then silently vanish from a shared re-export — the two sides agree exactly.
  it('SKA-34: dot-named members are skipped at IMPORT (zip + folder), mirroring export', async () => {
    const db = freshDb()
    const deps = makeDeps()
    const zip = await writeZip([
      { name: 'SKILL.md', content: skillMd({ id: 'dotted' }) },
      { name: '.hidden.md', content: 'dot file' },
      { name: '.notes/tips.md', content: 'dot dir' }
    ])
    importSkill(db, zip, deps)
    expect(existsSync(join(deps.userSkillsDir, 'dotted', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(deps.userSkillsDir, 'dotted', '.hidden.md'))).toBe(false)
    expect(existsSync(join(deps.userSkillsDir, 'dotted', '.notes'))).toBe(false)

    // Folder source: a VCS-tracked skill folder (a .git tree full of disallowed files) imports
    // cleanly — the dot tree is skipped instead of tripping badExtension.
    const folder = join(tempDir(), 'gitted')
    mkdirSync(join(folder, '.git'), { recursive: true })
    writeFileSync(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(folder, 'SKILL.md'), skillMd({ id: 'gitted' }))
    const info = importSkill(db, folder, deps).info
    expect(info.id).toBe('gitted')
    expect(existsSync(join(deps.userSkillsDir, 'gitted', '.git'))).toBe(false)
  })

  it('SKA-34: export skips dot-dirs and disallowed extensions (never staging litter)', async () => {
    const db = freshDb()
    const deps = makeDeps()
    importSkill(db, await validZip({ id: 'litter' }), deps)
    const skillDir = join(deps.userSkillsDir, 'litter')
    // Simulate on-disk litter a power user / a crash could leave INSIDE the skill folder.
    mkdirSync(join(skillDir, '.git'), { recursive: true })
    writeFileSync(join(skillDir, '.git', 'config.txt'), 'x')
    writeFileSync(join(skillDir, '.DS_Store.txt'), 'x')
    writeFileSync(join(skillDir, 'tool.exe'), 'MZ')
    const dest = join(tempDir(), 'litter.skill.zip')
    exportSkill(db, skillInstallId('user', 'litter'), dest, deps)
    const names = Object.keys((await JSZip.loadAsync(readFileSync(dest))).files)
    expect(names).toEqual(['SKILL.md'])
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
