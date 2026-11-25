// Folder links a drive can carry, for the rows that put one where the app meets a folder (T2.16 fix round:
// vault-start-links, zim-transients). Moved here from vault-start-links.test.ts in round 2, when the knowledge-pack sweep
// got the same containment test, so both suites make the links one way.
//
// R1 B-1: a Windows junction whose target is not of the form `\??\X:\…` (a volume GUID path, or a
// `\\?\GLOBALROOT\Device\HarddiskVolumeN\…` path) reads as a plain folder to Node's `lstat` and to the JS `realpathSync`.
// Junctions need no privilege; the volume's GUID comes from `mountvol <root> /L`, and its device number is found by
// trying each one against a marker file (both read-only). Every junction made here points at a folder the caller names;
// remove one with `unlinkFolder` (the link only), never by a recursive removal through it.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { tempRoot } from './db-fixtures'

const isWindows = process.platform === 'win32'

/** Makes a link at `link` to the folder `target`. */
export type FolderLink = (target: string, link: string) => void

/** The `\\?\Volume{…}\` root of the volume `path` lies on (`mountvol <root> /L`, read-only, no privilege), or null. */
function volumeGuidRoot(path: string): string | null {
  try {
    const root = execFileSync('mountvol', [parse(path).root, '/L'], { encoding: 'utf8' }).trim()
    return /^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(root) ? root : null
  } catch {
    return null
  }
}

/**
 * The `\\?\GLOBALROOT\Device\HarddiskVolumeN\` root of the volume the temp folder lies on, or null: each number is tried
 * with a junction to a marker folder in a temp root of its own, and the one whose junction lists the marker wins. Each
 * junction is removed (`rmdirSync`: the link only) right after its look, and points at a sibling, never at an ancestor.
 */
function deviceRootOfTemp(): string | null {
  const root = tempRoot('folder-links-device')
  const target = join(root, 'target')
  const marker = `marker-${randomBytes(6).toString('hex')}`
  mkdirSync(target)
  writeFileSync(join(target, marker), '')
  const tail = target.slice(parse(target).root.length)
  for (let n = 1; n <= 32; n++) {
    const device = `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume${n}\\`
    const link = join(root, 'J')
    try {
      symlinkSync(`${device}${tail}`, link, 'junction')
    } catch {
      continue
    }
    try {
      if (readdirSync(link).includes(marker)) return device
    } catch {
      /* another volume, or none at this number */
    } finally {
      rmdirSync(link)
    }
  }
  return null
}

/** Can this account make `make` links to a folder? (A Windows symbolic link needs Developer Mode or the privilege.) */
export function canLink(make: FolderLink): boolean {
  const root = tempRoot('folder-links-can')
  try {
    mkdirSync(join(root, 'target'))
    make(join(root, 'target'), join(root, 'link'))
    return true
  } catch {
    return false
  } finally {
    unlinkFolder(join(root, 'link'))
  }
}

const GUID_ROOT = isWindows ? volumeGuidRoot(tmpdir()) : null
const DEVICE_ROOT = isWindows ? deviceRootOfTemp() : null

/** A junction to `target` spelled under `root` (a volume GUID or device root of the same volume). */
const junctionUnder =
  (root: string | null): FolderLink =>
  (target, link) => {
    if (root === null) throw new Error('no such root on this machine')
    symlinkSync(`${root}${target.slice(parse(target).root.length)}`, link, 'junction')
  }

/** R1 B-1's two junction forms that Node reads as plain folders, where this machine can make them:
 *  `[label, make, canMakeHere]`. Windows only. */
export const UNSEEN_JUNCTIONS: Array<[string, FolderLink, boolean]> = isWindows
  ? [
      ['a junction to a volume GUID path', junctionUnder(GUID_ROOT), GUID_ROOT !== null],
      ['a junction to a \\Device path', junctionUnder(DEVICE_ROOT), DEVICE_ROOT !== null]
    ]
  : []

/** A symbolic link to a folder (everywhere; on Windows only with the privilege). */
export const dirSymlink: FolderLink = (target, link) => symlinkSync(target, link, 'dir')

/** Every folder link a drive can carry, where this machine can make it: the junction forms on Windows (no privilege
 *  needed), and a symbolic link to a folder everywhere (elsewhere `symlinkSync` ignores the kind, so it is run once). */
export const FOLDER_LINKS: Array<[string, FolderLink, boolean]> = [
  ...(isWindows ? [['a junction', (t: string, l: string) => symlinkSync(t, l, 'junction'), true] as [string, FolderLink, boolean]] : []),
  ...UNSEEN_JUNCTIONS,
  ['a symbolic link', dirSymlink, canLink(dirSymlink)]
]

/** Removes the link at `link` itself (never what it reaches), when there is one. */
export function unlinkFolder(link: string): void {
  try {
    rmdirSync(link)
  } catch {
    /* gone already */
  }
}
