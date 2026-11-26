#!/usr/bin/env node
// Writes config/drive-release.json, the record of what a drive was built with (app-update plan W-20; F-13,
// docs/app-updates.md §8.5 and table B.11 in §5.10): the last writing step of build-commercial-drive, and of
// prepare-drive when node is on PATH.
//
//   node scripts/lib/write-drive-release.mjs --target <drive root> [--dry-run]
//
// The record: `format` 1; `app_version` by W-20's rule for a writer that did not place the apps itself (the one
// version when exactly one app per system is at the root and all carry it; otherwise an existing record's value that a
// root app still carries; otherwise the field is omitted, which means no constraint); `systems`, the systems with an
// app at the root; `files`, the path and sha256 of the root apps, the start files and every regular file under
// runtime/ (links never followed, macOS litter `._*` and `.DS_Store` left out), sorted by path; then every other field
// of an existing record, kept in its order. The bytes depend on the tree alone (no clock, host, locale, working folder
// or spelling of the target), so both builder twins write the same record by running this one helper.
//
// One definition: the read, the version check, the root-name rule and the serializer are the app's own module
// apps/desktop/src/main/services/updates/drive-release.ts, loaded through Node's type stripping (Node 22.18 or later,
// 23.6 or later; ts-sibling-imports resolves its extension-less import of ./version). A Node without type stripping is
// refused with one line, and so is a reader that cannot be loaded (a partial checkout, a Node without module hooks).
// Node may print a MODULE_TYPELESS_PACKAGE_JSON warning when it loads the module (that package.json names no module
// type): harmless, and `node --no-warnings` silences it. Every line of the helper's own starts with "drive-release.json".
//
// Never written through or over a link: a link or a folder at config/ or at the record's name is refused. The record
// goes to config/drive-release.json.tmp first, is flushed to the disk, then renamed over the old one.
//
// Exit codes: 0 written (with --dry-run: computed and printed, nothing written) · 1 refused or failed: nothing written,
// an existing record untouched, no temporary file left; or, said as such, the record was written but could not be read
// back as written (the old one is replaced then) · 2 usage.

import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerTsSiblingImports } from './ts-sibling-imports.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const READER = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'services', 'updates', 'drive-release.ts')
const NAME = 'drive-release.json'
const USAGE = `${NAME}: usage: node scripts/lib/write-drive-release.mjs --target <drive root> [--dry-run]`

/** A refusal: its message is the reason, printed as the helper's one line. */
class Refusal extends Error {}

/** `{ target, dryRun }`, or null for a usage error. */
function parseArgs(argv) {
  let target = null
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--target' && target === null && typeof value === 'string' && value !== '' && !value.startsWith('--')) {
      target = value
      i++
    } else if (arg === '--dry-run' && !dryRun) dryRun = true
    else return null
  }
  return target === null ? null : { target, dryRun }
}

/** An errno token of a failure, never its message (which names a path). */
function errorCode(err) {
  const code = err?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : 'error'
}

/** `lstat`, or null when nothing is at the path. */
function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null
    throw err
  }
}

/** A file's sha256 in lower-case hex, read in 1 MiB pieces. */
function sha256Of(path) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1 << 20)
  const fd = openSync(path, 'r')
  try {
    for (let n = readSync(fd, buffer, 0, buffer.length, null); n > 0; n = readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** macOS litter a copy to exFAT leaves (W-25): AppleDouble files and Finder's folder settings. */
const isLitter = (name) => name.startsWith('._') || name === '.DS_Store'

/** Every regular file under runtime/, as `runtime/<…>` with `/`. A link (or a runtime/ that is one) is never followed. */
function runtimeFiles(root) {
  const top = join(root, 'runtime')
  if (!lstatOrNull(top)?.isDirectory()) return []
  const found = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isLitter(entry.name)) continue
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/${entry.name}`)
      else if (entry.isFile()) found.push(`${rel}/${entry.name}`)
    }
  }
  walk(top, 'runtime')
  return found
}

/** Writes `text` to `<final>.tmp`, flushes it, renames it over `final`; on any failure removes the temporary file. */
function writeAtomically(final, text) {
  const tmp = `${final}.tmp`
  const left = lstatOrNull(tmp)
  if (left && !left.isFile()) throw new Refusal('config/drive-release.json.tmp is not a regular file')
  if (left) unlinkSync(tmp) // left behind by an interrupted run
  let fd
  try {
    fd = openSync(tmp, 'wx')
  } catch (err) {
    throw new Refusal(`writing the record failed (${errorCode(err)})`)
  }
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, final)
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* the write failed already */
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* never made, or already gone */
    }
    throw new Refusal(`writing the record failed (${errorCode(err)})`)
  }
}

const OMITTED = { 'no-app': 'omitted (no app at the root)', 'no-single-version': 'omitted (no single version)' }

/** Computes the record for the drive at `root` and writes it (unless `dryRun`). Returns the exit code. */
function writeRecord(dr, root, dryRun) {
  let target
  try {
    target = statSync(root)
  } catch {
    target = null
  }
  if (!target?.isDirectory()) throw new Refusal('the target is not a folder')
  const config = join(root, 'config')
  if (!lstatOrNull(config)?.isDirectory()) throw new Refusal('config/ is not a folder (missing, a file or a link)')
  if (!lstatOrNull(join(config, 'drive.json'))?.isFile()) throw new Refusal('not a prepared drive (config/drive.json is missing)')

  const existing = dr.readDriveReleaseFile(root)
  if (existing.kind === 'unreadable') throw new Refusal(`the existing record cannot be read just now (${existing.code ?? 'error'})`)
  if (existing.kind === 'damaged' && existing.fault === 'not-a-file') {
    throw new Refusal('config/drive-release.json is not a regular file (a folder or a link)')
  }
  if (existing.kind === 'damaged') console.error(`${NAME}: the existing record is damaged (${existing.fault}); writing a fresh one`)
  const fields = existing.kind === 'object' ? existing.fields : {}
  const kept = Object.entries(fields) // own fields, an own __proto__ included; the serializer drops the owned ones
  const existingAppVersion = Object.hasOwn(fields, 'app_version') ? fields.app_version : undefined

  const apps = dr.rootApps(root)
  const choice = dr.chooseAppVersion(apps, existingAppVersion)
  const systems = dr.rootSystems(apps)
  const paths = [
    ...apps.filter((app) => app.kind === 'file').map((app) => app.name),
    ...dr.START_FILE_NAMES.filter((name) => lstatOrNull(join(root, name))?.isFile()),
    ...runtimeFiles(root)
  ].sort() // UTF-16 code units, never a locale: the same order on every system
  const files = paths.map((path) => ({ path, sha256: sha256Of(join(root, ...path.split('/'))) }))
  const text = dr.serializeDriveRelease({ appVersion: choice.value, systems, files }, kept)
  if (text === null) throw new Refusal(`the record would be over ${dr.DRIVE_RELEASE_MAX_BYTES} bytes`)

  const appVersion = choice.value === null ? OMITTED[choice.why] : choice.why === 'kept' ? `${choice.value} (kept)` : choice.value
  const summary = `app_version=${appVersion} systems=${systems.length > 0 ? systems.join(',') : 'none'} files=${files.length}`
  if (dryRun) {
    console.log(`${NAME} (dry run, nothing written): ${summary}`)
    return 0
  }
  writeAtomically(join(config, 'drive-release.json'), text)
  const back = dr.readDriveRelease(root)
  if (back.kind !== 'record' || dr.driveAppVersion(back) !== choice.value) {
    console.error(`${NAME}: the record was written but could not be read back as written; check the drive`)
    return 1
  }
  console.log(`${NAME}: ${summary}`)
  return 0
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return 2
  }
  if (!process.features?.typescript) {
    console.error(`${NAME}: this Node (${process.version}) has no type stripping, so it cannot load the reader; use Node 22.18 or later; nothing written`)
    return 1
  }
  let dr
  try {
    registerTsSiblingImports()
    dr = await import(pathToFileURL(READER).href)
  } catch (err) {
    console.error(`${NAME}: the reader could not be loaded (${errorCode(err)}); nothing written`)
    return 1
  }
  try {
    return writeRecord(dr, resolve(args.target), args.dryRun)
  } catch (err) {
    console.error(err instanceof Refusal ? `${NAME}: ${err.message}; nothing written` : `${NAME}: failed (${errorCode(err)}); nothing written`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
