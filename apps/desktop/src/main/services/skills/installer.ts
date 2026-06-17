// Skill import / export / install / delete lifecycle (skills plan §9, revised §0 — unzip/copy
// into a PLAIN on-disk folder, NOT an encrypted blob). This is the security heart of S4: a
// view-imported `.skill.zip` is attacker-supplied and unsigned, and we now write its contents
// STRAIGHT into a real folder under user-skills/, so every member is validated before a single
// byte lands.
//
// ZIP MECHANISM (the contract, §22-A2). There is NO reusable safe extractor in the repo: the only
// archive→disk path elsewhere is a validation-blind shell-tar extractor whose safety rests on the
// archive being SHA-verified against an app-controlled source list FIRST — the opposite trust
// model. A `.skill.zip` is attacker-supplied and unsigned, so it must NEVER be routed through that
// path. So this module ships a NET-NEW member-by-member reader built on Node's BUILT-IN `node:zlib`
// + a hand-rolled central-directory parser (the same style as ingestion/limits.ts
// `declaredZipInflatedSize`). No new dependency, fully offline, and it
// ENUMERATES every entry from the central directory BEFORE inflating anything, so each member is
// path-/symlink-/extension-/size-checked up front. `zlib.inflateRawSync(..., { maxOutputLength })`
// is the authoritative zip-bomb backstop: it aborts the moment a member's ACTUAL inflated output
// exceeds the per-file cap (not a spoofable declared size). Export writes a minimal STORE-method
// zip the same way (no dependency).
//
// PRIVACY (§22-M1). Every rejection reason here is a FIXED, STRUCTURAL English string — it never
// interpolates a member path, file name, or body text, so a malicious package can never echo its
// content into an IPC error payload, the audit log, or app.log.

import * as zlib from 'node:zlib'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { Db } from '../db'
import {
  SKILL_ID_RE,
  SKILL_SEMVER_RE,
  skillNeedsNewerApp,
  summarizeSkillPermissions,
  type SkillManifest
} from '../../../shared/skill-manifest'
import type { SkillInfo, SkillPreview } from '../../../shared/types'
import { parseSkillManifestFromDir } from './manifest'
import { resolveSkillLimits, type SkillLimits } from './limits'
import {
  getSkill,
  getSkillsByDeclaredId,
  reconcileSkills,
  setSkillEnabled,
  skillInstallId,
  type SkillRecord
} from './registry'

// ---- structural rejection messages (content-free — §22-M1) --------------------------

/** Fixed English reasons. NONE interpolate attacker-supplied names/paths/content. */
export const SKILL_IMPORT_ERRORS = {
  notFound: 'The selected skill could not be found.',
  notZipOrFolder: 'A skill must be a .skill.zip file or a folder containing SKILL.md.',
  unreadableZip: 'The skill package could not be read as a valid zip archive.',
  encryptedZip: 'The skill package uses an unsupported (encrypted or ZIP64) zip format.',
  unsupportedCompression: 'The skill package uses an unsupported compression method.',
  pathTraversal: 'The package contains a file whose path escapes the package folder.',
  absolutePath: 'The package contains a file with an absolute or drive-letter path.',
  symlink: 'The package contains a symbolic link, which is not allowed.',
  tooDeep: 'The package nests folders more deeply than allowed.',
  pathTooLong: 'The package contains a file path that is too long.',
  tooManyFiles: 'The package contains more files than allowed.',
  tooLarge: 'The package is larger than the allowed size.',
  fileTooLarge: 'A file in the package is larger than the allowed size.',
  badExtension: 'The package contains a file type that is not allowed.',
  nestedArchive: 'The package contains an embedded archive, which is not allowed.',
  noSkillMd: 'The package does not contain a SKILL.md file.',
  invalidManifest: 'The skill manifest is invalid.',
  idMismatch: 'The skill id is not a valid name.',
  downgradeBlocked:
    'A newer version of this skill is already installed. Turn on developer mode to install an older version.',
  appReadOnly: 'App-provided skills cannot be changed or deleted.',
  locked: 'Unlock the workspace to manage skills.'
} as const

/** Thrown by the installer; `message` is always one of the structural strings above. */
export class SkillImportError extends Error {}

/**
 * Reverse map a structural error MESSAGE back to its stable key (for renderer localization, I2 —
 * the renderer maps the code to localized copy instead of showing the English string). Built once
 * from `SKILL_IMPORT_ERRORS`; an unrecognized message → 'unknown'.
 */
const ERROR_MESSAGE_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(SKILL_IMPORT_ERRORS).map(([code, msg]) => [msg, code])
)
export function skillImportErrorCode(message: string): string {
  return ERROR_MESSAGE_TO_CODE[message] ?? 'unknown'
}

// ---- allowlists / signatures (skills plan §6.3 / §9.2) -------------------------------

/** §6.3 file-type allowlist (lowercased extensions). */
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv'])

/** Leading magic bytes of archive containers (§6.3/§22-E2 — a zip renamed `.csv` must be caught). */
function looksLikeArchive(buf: Buffer): boolean {
  if (buf.length >= 4) {
    // PK\x03\x04 (zip local) / PK\x05\x06 (empty zip) / PK\x07\x08 (spanned)
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
      return true
    }
    // xz: FD 37 7A 58 5A 00 ; zstd: 28 B5 2F FD
    if (buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a && buf[3] === 0x58) return true
    if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) return true
  }
  // gzip: 1F 8B
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return true
  // tar: "ustar" at offset 257
  if (buf.length >= 262 && buf.toString('latin1', 257, 262) === 'ustar') return true
  return false
}

// ---- the built-in zip reader (central directory → inflate per member) ----------------

interface ZipEntry {
  /** Raw name as stored in the central directory (forward slashes per the zip spec). */
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  /** UNIX mode from the external-attributes high word (0 when the entry wasn't unix-authored). */
  unixMode: number
  isDir: boolean
}

const SIG_EOCD = 0x06054b50
const SIG_CDH = 0x02014b50
const SIG_LFH = 0x04034b50

/**
 * Parse the central directory of a zip buffer into entries. Throws SkillImportError with a
 * structural reason on anything malformed, encrypted, or ZIP64 (skill packages are small text;
 * we deliberately do not support those formats). Reading the central directory FIRST is what lets
 * us validate every member before inflating a single byte.
 */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const minEocd = 22
  if (buf.length < minEocd) throw new SkillImportError(SKILL_IMPORT_ERRORS.unreadableZip)
  let eocd = -1
  const scanFrom = Math.max(0, buf.length - (minEocd + 0xffff))
  for (let i = buf.length - minEocd; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new SkillImportError(SKILL_IMPORT_ERRORS.unreadableZip)

  const totalEntries = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  // A 0xFFFFFFFF marker anywhere structural means ZIP64 — refuse (unsupported).
  if (cdOffset === 0xffffffff || cdOffset >= buf.length) {
    throw new SkillImportError(SKILL_IMPORT_ERRORS.encryptedZip)
  }

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CDH) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.unreadableZip)
    }
    const gpFlag = buf.readUInt16LE(p + 8)
    if (gpFlag & 0x0001) throw new SkillImportError(SKILL_IMPORT_ERRORS.encryptedZip) // bit 0 = encrypted
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const externalAttr = buf.readUInt32LE(p + 38)
    const localHeaderOffset = buf.readUInt32LE(p + 42)
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.encryptedZip) // ZIP64 sizes — unsupported
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      unixMode: (externalAttr >>> 16) & 0xffff,
      isDir: name.endsWith('/')
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Locate one entry's compressed data range by reading its local file header. */
function entryDataRange(buf: Buffer, e: ZipEntry): { start: number; end: number } {
  const off = e.localHeaderOffset
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG_LFH) {
    throw new SkillImportError(SKILL_IMPORT_ERRORS.unreadableZip)
  }
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const start = off + 30 + nameLen + extraLen
  const end = start + e.compressedSize
  if (end > buf.length) throw new SkillImportError(SKILL_IMPORT_ERRORS.unreadableZip)
  return { start, end }
}

/**
 * Inflate one member, bounding the ACTUAL output to `maxFileBytes` (the authoritative zip-bomb
 * backstop — a lying declared size cannot get past `maxOutputLength`). Store (0) and deflate (8)
 * are the only methods a skill package legitimately uses; anything else is refused.
 */
function inflateEntry(buf: Buffer, e: ZipEntry, maxFileBytes: number): Buffer {
  const { start, end } = entryDataRange(buf, e)
  const slice = buf.subarray(start, end)
  if (e.method === 0) {
    if (slice.length > maxFileBytes) throw new SkillImportError(SKILL_IMPORT_ERRORS.fileTooLarge)
    return Buffer.from(slice)
  }
  if (e.method === 8) {
    try {
      return zlib.inflateRawSync(slice, { maxOutputLength: maxFileBytes })
    } catch {
      // ERR_BUFFER_TOO_LARGE (zip bomb) or a corrupt stream both land here.
      throw new SkillImportError(SKILL_IMPORT_ERRORS.fileTooLarge)
    }
  }
  throw new SkillImportError(SKILL_IMPORT_ERRORS.unsupportedCompression)
}

// ---- per-member structural validation (before any write) -----------------------------

/** Normalize a stored member name to forward slashes and reject path attacks (skills plan §9.2). */
function safeRelPath(rawName: string, limits: SkillLimits): string {
  const name = rawName.replace(/\\/g, '/')
  if (name.length > limits.maxPathLen) throw new SkillImportError(SKILL_IMPORT_ERRORS.pathTooLong)
  // Absolute / drive-letter / UNC.
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.startsWith('//')) {
    throw new SkillImportError(SKILL_IMPORT_ERRORS.absolutePath)
  }
  const segments = name.split('/').filter((s) => s !== '')
  if (segments.some((s) => s === '..')) throw new SkillImportError(SKILL_IMPORT_ERRORS.pathTraversal)
  if (segments.some((s) => s === '.')) throw new SkillImportError(SKILL_IMPORT_ERRORS.pathTraversal)
  if (segments.length > limits.maxDepth) throw new SkillImportError(SKILL_IMPORT_ERRORS.tooDeep)
  // Node's own absolute check (catches platform quirks the regex misses).
  if (isAbsolute(name)) throw new SkillImportError(SKILL_IMPORT_ERRORS.absolutePath)
  return segments.join('/')
}

/** Is this member a symlink? (UNIX S_IFLNK in the external-attrs mode word.) */
function isSymlinkEntry(e: ZipEntry): boolean {
  return (e.unixMode & 0o170000) === 0o120000
}

/** A validated, in-memory member ready to write (the whole tree is held before anything lands). */
interface StagedFile {
  relPath: string
  data: Buffer
}

/**
 * Strip a single common top-level folder if every entry shares it (skills plan §6.1 — a
 * `.skill.zip` may be zipped at the `<skill-id>/` level OR with the files at the archive root;
 * the importer normalizes to the latter).
 */
function stripCommonPrefix(paths: string[]): (p: string) => string {
  if (paths.length === 0) return (p) => p
  const first = paths[0].split('/')[0]
  if (!first) return (p) => p
  const allShare = paths.every((p) => {
    const parts = p.split('/')
    return parts.length > 1 && parts[0] === first
  })
  return allShare ? (p) => p.split('/').slice(1).join('/') : (p) => p
}

// ---- staging: validate a whole source into in-memory StagedFiles ---------------------

/** Read a `.skill.zip` from disk into validated StagedFiles (nothing written yet). */
function stageZip(zipPath: string, limits: SkillLimits): StagedFile[] {
  let buf: Buffer
  try {
    // Cap the raw archive read — a legitimate (text) skill compresses well below the total cap.
    const size = statSync(zipPath).size
    if (size > limits.maxTotalBytes) throw new SkillImportError(SKILL_IMPORT_ERRORS.tooLarge)
    buf = readFileSync(zipPath)
  } catch (e) {
    if (e instanceof SkillImportError) throw e
    throw new SkillImportError(SKILL_IMPORT_ERRORS.unreadableZip)
  }

  const entries = readCentralDirectory(buf)
  const fileEntries = entries.filter((e) => !e.isDir)
  if (fileEntries.length > limits.maxFiles) throw new SkillImportError(SKILL_IMPORT_ERRORS.tooManyFiles)

  // Cheap early bomb reject on the DECLARED sizes (the spoofable half — the maxOutputLength
  // inflate below is the authoritative backstop).
  let declaredTotal = 0
  for (const e of fileEntries) declaredTotal += e.uncompressedSize
  if (declaredTotal > limits.maxTotalBytes) throw new SkillImportError(SKILL_IMPORT_ERRORS.tooLarge)

  // Validate every member's PATH + symlink/extension up front (enumerate-before-extract).
  for (const e of entries) {
    if (isSymlinkEntry(e)) throw new SkillImportError(SKILL_IMPORT_ERRORS.symlink)
    const rel = safeRelPath(e.name, limits)
    if (!e.isDir && rel !== '' && !ALLOWED_EXTENSIONS.has(extname(rel).toLowerCase())) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.badExtension)
    }
  }

  const rels = fileEntries.map((e) => safeRelPath(e.name, limits)).filter((r) => r !== '')
  const strip = stripCommonPrefix(rels)

  const staged: StagedFile[] = []
  let actualTotal = 0
  for (const e of fileEntries) {
    const rel0 = safeRelPath(e.name, limits)
    if (rel0 === '') continue
    const data = inflateEntry(buf, e, limits.maxFileBytes)
    actualTotal += data.length
    if (actualTotal > limits.maxTotalBytes) throw new SkillImportError(SKILL_IMPORT_ERRORS.tooLarge)
    if (looksLikeArchive(data)) throw new SkillImportError(SKILL_IMPORT_ERRORS.nestedArchive)
    const rel = strip(rel0)
    if (rel === '') continue
    staged.push({ relPath: rel, data })
  }
  return staged
}

/** Read a skill FOLDER into validated StagedFiles (the same checks as a zip, applied to disk). */
function stageFolder(folderPath: string, limits: SkillLimits): StagedFile[] {
  const staged: StagedFile[] = []
  let total = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new SkillImportError(SKILL_IMPORT_ERRORS.tooDeep)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      // Reject symlinks the same way the zip path does (no "safe handling" in v1).
      if (entry.isSymbolicLink()) throw new SkillImportError(SKILL_IMPORT_ERRORS.symlink)
      const rel = relative(folderPath, abs).replace(/\\/g, '/')
      if (rel.length > limits.maxPathLen) throw new SkillImportError(SKILL_IMPORT_ERRORS.pathTooLong)
      if (entry.isDirectory()) {
        walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) throw new SkillImportError(SKILL_IMPORT_ERRORS.symlink) // sockets/fifos etc.
      if (!ALLOWED_EXTENSIONS.has(extname(rel).toLowerCase())) {
        throw new SkillImportError(SKILL_IMPORT_ERRORS.badExtension)
      }
      if (staged.length + 1 > limits.maxFiles) throw new SkillImportError(SKILL_IMPORT_ERRORS.tooManyFiles)
      const size = statSync(abs).size
      if (size > limits.maxFileBytes) throw new SkillImportError(SKILL_IMPORT_ERRORS.fileTooLarge)
      total += size
      if (total > limits.maxTotalBytes) throw new SkillImportError(SKILL_IMPORT_ERRORS.tooLarge)
      const data = readFileSync(abs)
      if (looksLikeArchive(data)) throw new SkillImportError(SKILL_IMPORT_ERRORS.nestedArchive)
      staged.push({ relPath: rel, data })
    }
  }
  walk(folderPath, 1)
  return staged
}

/** Classify the import source and produce its validated tree. Throws on any structural failure. */
function stageSource(source: string, limits: SkillLimits): { kind: 'zip' | 'folder'; files: StagedFile[] } {
  let st
  try {
    st = lstatSync(source)
  } catch {
    throw new SkillImportError(SKILL_IMPORT_ERRORS.notFound)
  }
  if (st.isSymbolicLink()) throw new SkillImportError(SKILL_IMPORT_ERRORS.symlink)
  if (st.isDirectory()) return { kind: 'folder', files: stageFolder(source, limits) }
  if (st.isFile()) return { kind: 'zip', files: stageZip(source, limits) }
  throw new SkillImportError(SKILL_IMPORT_ERRORS.notZipOrFolder)
}

/** Write a validated tree into a fresh dir, re-asserting traversal containment per file. */
function writeStaged(files: StagedFile[], destDir: string): void {
  const root = destDir.endsWith(sep) ? destDir : destDir + sep
  for (const f of files) {
    const abs = join(destDir, f.relPath)
    // Belt-and-braces: after resolution the path must still sit inside destDir.
    if (abs !== destDir && !abs.startsWith(root)) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.pathTraversal)
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.data)
  }
}

/** Post-write defence-in-depth: no extracted entry may be a symlink (skills plan §9.2). */
function assertNoSymlinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (lstatSync(abs).isSymbolicLink()) throw new SkillImportError(SKILL_IMPORT_ERRORS.symlink)
    if (entry.isDirectory()) assertNoSymlinks(abs)
  }
}

// ---- semver compare (skills plan §6.5/§9.3) ------------------------------------------

/** -1 / 0 / 1 for a<b / a==b / a>b over MAJOR.MINOR.PATCH (both already SKILL_SEMVER_RE-valid). */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

// ---- shared deps ---------------------------------------------------------------------

export interface SkillInstallerDeps {
  appSkillsDir: string
  userSkillsDir: string
  limits?: SkillLimits
  /** Injectable clock for deterministic tests. */
  now?: () => string
  /** The running app version, for the §6.5 minAppVersion gate. Absent ⇒ treated as compatible. */
  appVersion?: string
}

/**
 * Project a registry record to the IPC `SkillInfo` shape (adds the structural summary + dup flag).
 * `appVersion` drives the §6.5 compatibility flag — absent ⇒ compatible (the legacy/test default).
 */
export function recordToInfo(record: SkillRecord, duplicateId: boolean, appVersion = ''): SkillInfo {
  const minAppVersion = record.manifest.compatibility.minAppVersion ?? null
  return {
    installId: record.installId,
    id: record.id,
    title: record.title,
    description: record.manifest.description,
    version: record.version,
    kind: record.kind,
    author: record.manifest.author,
    language: record.manifest.language,
    source: record.source,
    trustedLevel: record.trustedLevel,
    enabled: record.enabled,
    warningAck: record.warningAck,
    unavailable: record.unavailableAt !== null,
    incompatible: skillNeedsNewerApp(minAppVersion ?? undefined, appVersion),
    minAppVersion,
    permissions: record.manifest.permissions,
    permissionSummary: summarizeSkillPermissions(record.manifest.permissions),
    duplicateId,
    // Tool-reserved signal (skills plan §13/§22-D1): the frontmatter declared Tier-2 tools (even
    // for an instruction stub, whose effective allowedTools stays []). The tools don't execute in
    // v1, but the detail view shows the honest "tools arrive with Tier-2" note off this flag.
    reservesTools: record.manifest.reservesTools ?? false,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt
  }
}

/** Build a SkillInfo for a record, computing duplicateId from the DB. */
export function skillInfo(db: Db, record: SkillRecord, appVersion = ''): SkillInfo {
  const dup = getSkillsByDeclaredId(db, record.id).length > 1
  return recordToInfo(record, dup, appVersion)
}

// ---- preview (no write; OQ-2 lean-yes) -----------------------------------------------

/**
 * Validate an import source FULLY in a transient staging dir and report what WOULD happen, without
 * persisting anything (skills plan §16/OQ-2). The single validation truth — the renderer never
 * re-validates. A structural failure returns `ok: false` with content-free reasons (§22-M1).
 */
export function previewSkillPackage(
  db: Db,
  source: string,
  deps: SkillInstallerDeps,
  opts: { developerMode?: boolean } = {}
): SkillPreview {
  const limits = deps.limits ?? resolveSkillLimits()
  const base: SkillPreview = {
    ok: false,
    sourceKind: 'zip',
    permissionSummary: summarizeSkillPermissions({
      documents: 'selected_only',
      network: 'denied',
      filesystem: 'skill_resources_only'
    }),
    errors: [],
    errorCodes: [],
    notes: []
  }
  // A failed preview carrying ONE structural reason + its stable code (for renderer localization, I2).
  const fail = (message: string, notes: string[] = []): SkillPreview => ({
    ...base,
    errors: [message],
    errorCodes: [skillImportErrorCode(message)],
    notes
  })

  let staged: { kind: 'zip' | 'folder'; files: StagedFile[] }
  try {
    staged = stageSource(source, limits)
  } catch (e) {
    return fail(e instanceof SkillImportError ? e.message : SKILL_IMPORT_ERRORS.unreadableZip)
  }
  base.sourceKind = staged.kind

  // Validate the SKILL.md by materializing the staged tree in a throwaway temp dir.
  const tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-skill-preview-'))
  try {
    writeStaged(staged.files, tmp)
    if (!existsSync(join(tmp, 'SKILL.md'))) return fail(SKILL_IMPORT_ERRORS.noSkillMd)
    const parsed = parseSkillManifestFromDir(tmp, { limits })
    if (!parsed.ok || !parsed.manifest) {
      return fail(SKILL_IMPORT_ERRORS.invalidManifest, parsed.notes)
    }
    const m = parsed.manifest
    if (!SKILL_ID_RE.test(m.id) || !SKILL_SEMVER_RE.test(m.version)) {
      return fail(SKILL_IMPORT_ERRORS.idMismatch, parsed.notes)
    }

    // Collision / version analysis against the installed skills sharing this id.
    const siblings = getSkillsByDeclaredId(db, m.id)
    const existingUser = siblings.find((s) => s.source === 'user') ?? null
    const existingApp = siblings.find((s) => s.source === 'app') ?? null
    let isUpgrade = false
    let isReplace = false
    let isDowngrade = false
    if (existingUser) {
      const cmp = compareSemver(m.version, existingUser.version)
      isUpgrade = cmp > 0
      isReplace = cmp === 0
      isDowngrade = cmp < 0
    }
    const downgradeBlocked = isDowngrade && !opts.developerMode

    return {
      ok: true,
      sourceKind: staged.kind,
      id: m.id,
      title: m.title,
      description: m.description,
      version: m.version,
      kind: m.kind,
      author: m.author,
      permissions: m.permissions,
      permissionSummary: summarizeSkillPermissions(m.permissions),
      collision: Boolean(existingUser || existingApp),
      collisionWith: existingApp ? 'app' : existingUser ? 'user' : null,
      installedVersion: existingUser?.version ?? null,
      isUpgrade,
      isReplace,
      isDowngrade,
      downgradeBlocked,
      errors: [],
      notes: parsed.notes
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---- import (validate → place into user-skills/<id>/ → reconcile + DS7) ---------------

export interface ImportResult {
  info: SkillInfo
  /** Files placed on disk (for the ids/counts-only audit event — never the names). */
  fileCount: number
}

/**
 * Import a skill from a `.skill.zip` or folder (skills plan §9, revised §0). Validates the WHOLE
 * tree in a staging dir, then atomically places it at `user-skills/<manifest.id>/` (folder name ==
 * id, the ratified S3 rule), reconciles the row, and applies DS7 (a deliberate view-import installs
 * ENABLED with a persistent warning). A failed/partial import DELETES the staging dir and persists
 * nothing — a plain cleanup, not a shred (§0). Downgrade is refused unless developer mode (DS15).
 */
export function importSkill(
  db: Db,
  source: string,
  deps: SkillInstallerDeps,
  opts: { developerMode?: boolean } = {}
): ImportResult {
  const limits = deps.limits ?? resolveSkillLimits()
  const now = deps.now ?? (() => new Date().toISOString())

  // 1) Validate the whole source into memory (throws structurally on any problem).
  const staged = stageSource(source, limits)

  // 2) Materialize + validate the manifest in a staging dir under user-skills/ (same filesystem
  //    as the final destination), then place it at user-skills/<id>/ (folder name == id).
  mkdirSync(deps.userSkillsDir, { recursive: true })
  const stagingDir = mkdtempSync(join(deps.userSkillsDir, '.skill-import-'))
  let manifestId: string
  try {
    writeStaged(staged.files, stagingDir)
    assertNoSymlinks(stagingDir)
    if (!existsSync(join(stagingDir, 'SKILL.md'))) throw new SkillImportError(SKILL_IMPORT_ERRORS.noSkillMd)
    const parsed = parseSkillManifestFromDir(stagingDir, { limits })
    if (!parsed.ok || !parsed.manifest) throw new SkillImportError(SKILL_IMPORT_ERRORS.invalidManifest)
    const manifest: SkillManifest = parsed.manifest
    if (!SKILL_ID_RE.test(manifest.id) || !SKILL_SEMVER_RE.test(manifest.version)) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.idMismatch)
    }
    manifestId = manifest.id

    // 3) Collision / version policy (skills plan §9.3 — against the existing USER skill of this id).
    const existingUser = getSkillsByDeclaredId(db, manifest.id).find((s) => s.source === 'user') ?? null
    if (existingUser) {
      const cmp = compareSemver(manifest.version, existingUser.version)
      if (cmp < 0 && !opts.developerMode) {
        throw new SkillImportError(SKILL_IMPORT_ERRORS.downgradeBlocked) // DS15 footgun guard
      }
    }

    // 4) Place at user-skills/<id>/ via ATOMIC renames (the staging dir is a mkdtemp on the SAME
    //    filesystem as the destination). Move any existing user folder ASIDE first, then rename
    //    staging into place, then drop the backup — so a mid-place failure can NEVER leave the user
    //    with neither the old nor a valid new skill (M1). The prior `rmSync(finalDir)` + `cpSync`
    //    could destroy the working install and then leave a half-copied folder if the copy threw
    //    partway. On a placement failure the backup is restored. The `.skill-backup-*` name fails
    //    SKILL_ID_RE, so reconcile skips a crash-leftover backup the same way it skips staging.
    const finalDir = join(deps.userSkillsDir, manifest.id)
    let backupDir: string | null = null
    if (existsSync(finalDir)) {
      backupDir = join(deps.userSkillsDir, `.skill-backup-${manifest.id}`)
      rmSync(backupDir, { recursive: true, force: true }) // clear any stale crash leftover
      renameSync(finalDir, backupDir)
    }
    try {
      renameSync(stagingDir, finalDir)
    } catch (e) {
      // Placement failed — restore the prior install so the user is never left with neither.
      if (backupDir && !existsSync(finalDir)) renameSync(backupDir, finalDir)
      throw e
    }
    if (backupDir) rmSync(backupDir, { recursive: true, force: true })
  } finally {
    // A successful rename already consumed the staging dir; on the failure paths it may still exist.
    // `force: true` makes this a no-op when it is already gone (cleanup, not a shred).
    rmSync(stagingDir, { recursive: true, force: true })
  }

  // 5) Reconcile so the row exists (a new user skill inserts DISABLED), then apply DS7. The folder
  //    is named by id, so the install id is deterministic — no re-discovery needed.
  reconcileSkills(db, {
    appSkillsDir: deps.appSkillsDir,
    userSkillsDir: deps.userSkillsDir,
    limits,
    now,
    appVersion: deps.appVersion
  })
  const installId = skillInstallId('user', manifestId)
  const record = getSkill(db, installId)
  if (!record) throw new SkillImportError(SKILL_IMPORT_ERRORS.invalidManifest)
  applyImportEnableState(db, record, now(), deps.appVersion ?? '')

  const finalRecord = getSkill(db, installId)
  if (!finalRecord) throw new SkillImportError(SKILL_IMPORT_ERRORS.invalidManifest)
  return { info: skillInfo(db, finalRecord, deps.appVersion ?? ''), fileCount: staged.files.length }
}

/**
 * DS7 + DS12 enable policy for a freshly-imported user skill. A deliberate view-import installs
 * ENABLED with the persistent warning (warning_ack stays 0) — UNLESS a higher-precedence (app)
 * skill of the same id is already active, in which case the import coexists DISABLED so it cannot
 * silently shadow trusted product content (trust-first precedence, §9.3). When it does enable,
 * one-active-per-id is enforced by disabling any same-id sibling that was enabled.
 */
function applyImportEnableState(db: Db, record: SkillRecord, now: string, appVersion: string): void {
  // §6.5 gate: a skill needing a newer app is installed but kept DISABLED (it cannot shape a turn
  // or run a tool until the app is updated) — it still coexists/lists, just never enabled here.
  if (skillNeedsNewerApp(record.manifest.compatibility.minAppVersion, appVersion)) {
    setSkillEnabled(db, record.installId, false, now)
    db.prepare('UPDATE skills SET warning_ack = 0, updated_at = ? WHERE install_id = ?').run(now, record.installId)
    return
  }
  const siblings = getSkillsByDeclaredId(db, record.id).filter((s) => s.installId !== record.installId)
  const enabledApp = siblings.find((s) => s.source === 'app' && s.enabled)
  if (enabledApp) {
    // Coexist disabled + warned; the trusted app skill stays effective.
    setSkillEnabled(db, record.installId, false, now)
    db.prepare('UPDATE skills SET warning_ack = 0, updated_at = ? WHERE install_id = ?').run(now, record.installId)
    return
  }
  // Enable + warn (warning_ack = 0 until acknowledged, DS7). One active per id: disable siblings.
  setSkillEnabled(db, record.installId, true, now)
  db.prepare('UPDATE skills SET warning_ack = 0, updated_at = ? WHERE install_id = ?').run(now, record.installId)
  for (const s of siblings) {
    if (s.enabled) setSkillEnabled(db, s.installId, false, now)
  }
}

// ---- export (`.skill.zip` via a STORE-method writer; skills plan §9.5) ----------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** The package tree to export: SKILL.md + the four optional subdirs ONLY (excludes manifest.json). */
const EXPORT_SUBDIRS = ['examples', 'schemas', 'prompts', 'resources']

/** Collect {name, data} for the export, relative to the skill folder (skills plan §9.5). */
function collectExportFiles(skillDir: string): Array<{ name: string; data: Buffer }> {
  const out: Array<{ name: string; data: Buffer }> = []
  const skillMd = join(skillDir, 'SKILL.md')
  if (existsSync(skillMd)) out.push({ name: 'SKILL.md', data: readFileSync(skillMd) })
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const abs = join(dir, entry.name)
      const rel = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile() && ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out.push({ name: rel, data: readFileSync(abs) })
      }
    }
  }
  for (const sub of EXPORT_SUBDIRS) walk(join(skillDir, sub), sub)
  return out
}

/** Build a minimal STORE-method (uncompressed) zip buffer — valid, dependency-free, offline. */
function buildStoreZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(SIG_LFH, 0)
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0, 6) // flags
    lfh.writeUInt16LE(0, 8) // method 0 = store
    lfh.writeUInt16LE(0, 10) // time
    lfh.writeUInt16LE(0, 12) // date
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(f.data.length, 18) // compressed
    lfh.writeUInt32LE(f.data.length, 22) // uncompressed
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28) // extra len
    locals.push(lfh, nameBuf, f.data)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(SIG_CDH, 0)
    cdh.writeUInt16LE(20, 4) // version made by
    cdh.writeUInt16LE(20, 6) // version needed
    cdh.writeUInt16LE(0, 8) // flags
    cdh.writeUInt16LE(0, 10) // method
    cdh.writeUInt16LE(0, 12) // time
    cdh.writeUInt16LE(0, 14) // date
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(f.data.length, 20)
    cdh.writeUInt32LE(f.data.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt16LE(0, 30) // extra
    cdh.writeUInt16LE(0, 32) // comment
    cdh.writeUInt16LE(0, 34) // disk #
    cdh.writeUInt16LE(0, 36) // internal attrs
    cdh.writeUInt32LE(0, 38) // external attrs
    cdh.writeUInt32LE(offset, 42) // local header offset
    centrals.push(cdh, nameBuf)
    offset += lfh.length + nameBuf.length + f.data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const localBuf = Buffer.concat(locals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4) // disk #
  eocd.writeUInt16LE(0, 6) // cd start disk
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16) // cd offset = end of locals
  eocd.writeUInt16LE(0, 20) // comment len
  return Buffer.concat([localBuf, centralBuf, eocd])
}

/**
 * Export a skill as a `.skill.zip` written to `destPath` (skills plan §9.5). EXCLUDES the
 * manifest.json cache, run history, and any caches — includes SKILL.md + the
 * examples/schemas/prompts/resources tree only. Resolves the source folder from the registry
 * record (app or user). Returns the byte count written (for an ids/counts-only audit).
 */
export function exportSkill(db: Db, installId: string, destPath: string, deps: SkillInstallerDeps): number {
  const record = getSkill(db, installId)
  if (!record) throw new SkillImportError(SKILL_IMPORT_ERRORS.notFound)
  const baseDir = record.source === 'app' ? deps.appSkillsDir : deps.userSkillsDir
  const skillDir = join(baseDir, record.path)
  if (!existsSync(join(skillDir, 'SKILL.md'))) throw new SkillImportError(SKILL_IMPORT_ERRORS.notFound)
  const files = collectExportFiles(skillDir)
  const zip = buildStoreZip(files)
  writeFileSync(destPath, zip)
  return zip.length
}

// ---- delete (app-level ref-clear sweep; skills plan §9.4 / §22-C3) -------------------

export interface DeleteResult {
  deleted: boolean
}

/**
 * Delete a USER skill (skills plan §9.4, revised §0 — a plain delete, not a shred). There is
 * intentionally NO foreign key into `skills` (§22-C3), so refs are cleared by an app-level sweep:
 * in ONE transaction we clear `conversations.active_skill_id` + `messages.skill_id` pointing at
 * this install id and delete the row, mirroring `deleteConversation`. Then the on-disk folder is
 * removed. App-shipped skills are read-only and refuse deletion (the built-in-collection
 * precedent). The delete-during-active-stream race is covered by the documented rule "a stamp
 * whose skill vanished mid-turn resolves to NULL" (S6 reads the glyph through the row, which is
 * gone) — the txn keeps a reader from ever seeing a row-deleted-but-refs-present half state.
 */
export function deleteSkill(db: Db, installId: string, deps: SkillInstallerDeps): DeleteResult {
  const record = getSkill(db, installId)
  if (!record) return { deleted: false }
  if (record.source === 'app') throw new SkillImportError(SKILL_IMPORT_ERRORS.appReadOnly)

  const folder = join(deps.userSkillsDir, record.path)

  db.exec('BEGIN')
  try {
    db.prepare('UPDATE conversations SET active_skill_id = NULL WHERE active_skill_id = ?').run(installId)
    db.prepare('UPDATE messages SET skill_id = NULL WHERE skill_id = ?').run(installId)
    db.prepare('DELETE FROM skills WHERE install_id = ?').run(installId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  // The DB no longer references the skill; remove its plain folder (best-effort cleanup).
  try {
    rmSync(folder, { recursive: true, force: true })
  } catch {
    /* a transiently-locked file leaves an orphan folder; reconcile re-discovers it (disabled). */
  }
  return { deleted: true }
}
