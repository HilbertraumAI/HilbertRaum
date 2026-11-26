#!/usr/bin/env node
// Writes config/kit-support.txt, the month a Kit's support period ends (app-update plan W-17, G-13 (b); F-13,
// docs/app-updates.md §8.4): build-commercial-drive's last writing block calls it, right before the drive-release record.
// Only the Kit builder writes the stamp, once per Kit; prepare-drive and the app never do.
//
//   node scripts/lib/write-kit-support.mjs --target <drive root> --support-end <YYYY-MM> [--check]
//
// The stamp: the month as YYYY-MM (ASCII digits, a month 01-12, never trimmed) and one LF, 8 bytes, no byte-order mark,
// created exclusively. Written once: the same month already there in these bytes is kept and the file left untouched;
// another month is refused (unsold stock is re-stamped by deleting the file on purpose, W-33), and so is a file that is
// no month in these bytes, a link or a folder: it is never replaced. A support end before this computer's current UTC
// month is refused as a typing error; there is no upper bound, so the month is echoed in words for the owner to read.
//
// --check (the builder runs it before step 1, a dry run too) does everything but the write: it echoes the month in words
// and refuses what the write would refuse, so a build that could not finish stops before any download (#769). A target
// or a config/ that is not there yet passes: step 1 lays the drive out.
//
// One definition: the format is the app's own module apps/desktop/src/main/services/updates/kit-support.ts, loaded
// through Node's type stripping (Node 22.18 or later, 23.6 or later), so the reader release 1 ships and this writer
// share one month rule and one read. A Node without type stripping is refused with one line, and so is a module that
// cannot be loaded. Node may warn that the module's package.json names no module type: `node --no-warnings` silences it.
// Every line of the helper's own starts with "kit-support.txt:".
//
// Exit codes: 0 written or kept (with --check: nothing written, the month echoed) · 1 refused or failed: nothing written,
// an existing stamp untouched; or, said as such, the stamp was written but could not be read back as written · 2 usage,
// or a support end that is no month or is before this month.

import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerTsSiblingImports } from './ts-sibling-imports.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FORMAT = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'services', 'updates', 'kit-support.ts')
const NAME = 'kit-support.txt'
const USAGE = `${NAME}: usage: node scripts/lib/write-kit-support.mjs --target <drive root> --support-end <YYYY-MM> [--check]`
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** A refusal: its message is the reason, printed as the helper's one line. */
class Refusal extends Error {}

/** `{ target, supportEnd, check }`, or null for a usage error. A value is never empty and never starts with `--`. */
function parseArgs(argv) {
  let target = null
  let supportEnd = null
  let check = false
  const valueAt = (i) => (typeof argv[i] === 'string' && argv[i] !== '' && !argv[i].startsWith('--') ? argv[i] : null)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--target' && target === null && valueAt(i + 1) !== null) target = argv[++i]
    else if (arg === '--support-end' && supportEnd === null && valueAt(i + 1) !== null) supportEnd = argv[++i]
    else if (arg === '--check' && !check) check = true
    else return null
  }
  return target === null || supportEnd === null ? null : { target, supportEnd, check }
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

/** This computer's current month in UTC, as YYYY-MM. */
function currentMonth() {
  const now = new Date()
  return `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** A month in words, from its own digits (never a locale): `2031-12` is `December 2031`. */
const inWords = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`

/** Creates the stamp exclusively and flushes it; on any failure after the create removes the file it made. */
function createStamp(path, text) {
  let fd
  try {
    fd = openSync(path, 'wx')
  } catch (err) {
    throw new Refusal(`writing config/kit-support.txt failed (${errorCode(err)})`)
  }
  try {
    const bytes = Buffer.from(text, 'latin1')
    for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done, bytes.length - done)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* the write failed already */
      }
    }
    try {
      unlinkSync(path)
    } catch {
      /* already gone */
    }
    throw new Refusal(`writing config/kit-support.txt failed (${errorCode(err)})`)
  }
}

/** Checks the stamp for `month` on the drive at `root` and, unless `check`, writes it. Returns the exit code. */
function stamp(ks, root, month, check) {
  let target
  try {
    target = statSync(root)
  } catch {
    target = null
  }
  // Before step 1 a target, or its config/, that is not there yet is a drive step 1 will lay out.
  if (target === null && check) {
    console.log(`${NAME}: support ends ${inWords(month)} (${month})`)
    return 0
  }
  if (!target?.isDirectory()) throw new Refusal('the target is not a folder')
  const config = lstatOrNull(join(root, 'config'))
  if (!config?.isDirectory() && !(config === null && check)) throw new Refusal('config/ is not a folder (missing, a file or a link)')

  const existing = ks.readKitSupport(root)
  const path = join(root, ...ks.KIT_SUPPORT_REL.split('/'))
  const text = ks.formatKitSupport(month)
  if (existing.kind === 'unreadable') {
    throw new Refusal(`config/kit-support.txt is there but cannot be read as one month (${existing.code ?? 'error'}); look at it by hand`)
  }
  if (existing.kind === 'damaged') {
    throw new Refusal(`config/kit-support.txt is there but cannot be read as one month (${existing.fault}); look at it by hand`)
  }
  if (existing.kind === 'month') {
    if (existing.month !== month) {
      throw new Refusal(
        `this drive's support end is already ${existing.month}; refusing to change it to ${month}. It is written once per Kit. ` +
          'To re-stamp unsold stock, delete config/kit-support.txt on purpose and run again'
      )
    }
    let bytes
    try {
      bytes = readFileSync(path)
    } catch (err) {
      throw new Refusal(`config/kit-support.txt is there but cannot be read as one month (${errorCode(err)}); look at it by hand`)
    }
    if (!bytes.equals(Buffer.from(text, 'latin1'))) {
      throw new Refusal(`config/kit-support.txt holds ${month}, but not as the builder writes it (YYYY-MM and one line feed); look at it by hand`)
    }
    console.log(check ? `${NAME}: support ends ${inWords(month)} (${month}, already on this drive)` : `${NAME}: ${month} (kept)`)
    return 0
  }
  if (check) {
    console.log(`${NAME}: support ends ${inWords(month)} (${month})`)
    return 0
  }
  createStamp(path, text)
  const back = ks.readKitSupport(root)
  if (back.kind !== 'month' || back.month !== month) {
    console.error(`${NAME}: config/kit-support.txt was written but could not be read back as written; check the drive`)
    return 1
  }
  console.log(`${NAME}: ${month}`)
  return 0
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return 2
  }
  if (!process.features?.typescript) {
    console.error(`${NAME}: this Node (${process.version}) has no type stripping, so it cannot load the format module; use Node 22.18 or later; nothing written`)
    return 1
  }
  let ks
  try {
    registerTsSiblingImports()
    ks = await import(pathToFileURL(FORMAT).href)
  } catch (err) {
    console.error(`${NAME}: the format module could not be loaded (${errorCode(err)}); nothing written`)
    return 1
  }
  if (!ks.isSupportMonth(args.supportEnd)) {
    console.error(`${NAME}: the support end must be a month as YYYY-MM (for example 2031-12); nothing written`)
    return 2
  }
  const now = currentMonth()
  if (args.supportEnd < now) {
    console.error(`${NAME}: the support end ${args.supportEnd} is before this month (${now} by this computer's clock); nothing written`)
    return 2
  }
  try {
    return stamp(ks, resolve(args.target), args.supportEnd, args.check)
  } catch (err) {
    console.error(err instanceof Refusal ? `${NAME}: ${err.message}; nothing written` : `${NAME}: failed (${errorCode(err)}); nothing written`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
