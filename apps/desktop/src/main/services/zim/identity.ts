import { closeSync, openSync, readSync } from 'node:fs'
import type { KnowledgePackCollision } from '../../../shared/types'

// ZIM ARCHIVE IDENTITY and the SERVING-NAME MAP (#301 P3b, findings M5 and L4; plan §9.17 (d)).
//
// Two upstream facts this module reproduces exactly, because approximating either of them is
// what the two findings are:
//
// 1. IDENTITY (M5). A pack's identity is the UUID at bytes 8–23 of the archive's 80-byte
//    header, NOT its file name. `resolvePackFile` used to take the first candidate that
//    existed, so a stranger's `wikipedia_de.zim` sitting in the drive's `zim/` folder hid the
//    user's correctly registered external file: the arm then filtered `books.id=<UUID of A>`
//    against archive B and got zero hits forever while the panel said "available". Every
//    resolve costs ONE 80-byte read and answers "is this file the archive that row means?".
//    This is IDENTITY checking, never authenticity: nothing here proves the bytes are intact.
//
// 2. SERVING NAMES (L4). kiwix-serve does not serve a book under its file stem. libkiwix
//    ≥ 14 slugifies the path, so `Wikipédia DE.zim` is served as `wikipedia_de` and the
//    viewer's filename-stem route 404s (or, worse, reads a DIFFERENT book that happens to
//    slugify to the same name). `servingNameFor` is a line-by-line transcription of libkiwix
//    14.1.0 `Book::getHumanReadableIdFromPath()` (`src/book.cpp`), and `computeServedSet`
//    reproduces `HumanReadableNameMapper`'s collision rule (`name_mapper.cpp`, pinned commit
//    74f664ea) so we can EXCLUDE the losers from the served library instead of letting the
//    server silently pick one of two books for a name.

/** `0x044D495A` little-endian at offset 0 — the ZIM magic (plan §2.4). */
export const ZIM_MAGIC = 0x044d495a
/** The header is 80 bytes; a file with fewer is not a ZIM archive we can identify. */
export const ZIM_HEADER_BYTES = 80
/** The 16 raw UUID bytes live at 8–23 (plan §2.4). */
const UUID_OFFSET = 8
const UUID_BYTES = 16

/** Why a header could not yield an identity. Reason CODES only — never a path (sentinel rule). */
export type ZimHeaderErrorReason = 'short' | 'magic' | 'unreadable'

export class ZimHeaderError extends Error {
  readonly reason: ZimHeaderErrorReason
  constructor(reason: ZimHeaderErrorReason) {
    super(`The file is not a readable ZIM archive (header: ${reason})`)
    this.name = 'ZimHeaderError'
    this.reason = reason
  }
}

/**
 * Format the 16 raw UUID bytes as `8-4-4-4-12` lowercase hex IN BYTE ORDER.
 *
 * Deliberately NOT a Windows-GUID field swap (plan §2.4, openZIM `src/uuid.cpp`): libzim
 * writes and libkiwix reports the bytes in order, so swapping the first three fields would
 * produce an id that matches no `books.id` the server ever answers to.
 */
export function formatZimUuid(bytes: Uint8Array): string {
  if (bytes.length < UUID_BYTES) throw new ZimHeaderError('short')
  const hex: string[] = []
  for (let i = 0; i < UUID_BYTES; i++) hex.push(bytes[i]!.toString(16).padStart(2, '0'))
  const h = hex.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * Read one archive's identity from its header. Exactly 80 bytes are read; fewer ⇒ `'short'`,
 * a wrong magic ⇒ `'magic'`, any filesystem error ⇒ `'unreadable'`. The descriptor is closed
 * in a `finally` on every path (plan §2.4 "close descriptors on every path") — the reconcile
 * calls this once per file per pass, so a leaked handle would pin a removable drive.
 */
export function readZimHeader(path: string): { uuid: string } {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
  } catch {
    throw new ZimHeaderError('unreadable')
  }
  try {
    const buf = Buffer.alloc(ZIM_HEADER_BYTES)
    let read: number
    try {
      read = readSync(fd, buf, 0, ZIM_HEADER_BYTES, 0)
    } catch {
      throw new ZimHeaderError('unreadable')
    }
    if (read < ZIM_HEADER_BYTES) throw new ZimHeaderError('short')
    if (buf.readUInt32LE(0) !== ZIM_MAGIC) throw new ZimHeaderError('magic')
    return { uuid: formatZimUuid(buf.subarray(UUID_OFFSET, UUID_OFFSET + UUID_BYTES)) }
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* the identity (or the error) is already decided; a failed close must not mask it */
    }
  }
}

/**
 * libkiwix's `removeAccents` (`src/tools/stringTools.cpp`) is the ICU transliterator
 * `"Lower; NFD; [:M:] remove; NFC"`. In JS that is exactly lowercase → NFD → drop every
 * combining mark → NFC.
 *
 * CAVEAT (recorded, not assumed): ICU `Lower` and JS `toLowerCase()` agree on every name in
 * our fixtures, but they are different implementations of case mapping. Exotic case mappings
 * (Turkish dotted/dotless I, Cherokee, …) are decided by P7's real-tool leg (T19), never here.
 */
function removeAccents(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
}

/**
 * The name kiwix-serve serves an archive under — libkiwix 14.1.0
 * `Book::getHumanReadableIdFromPath()`, step for step:
 *
 *   1. `removeAccents` on the WHOLE path (not the leaf — the directory is stripped AFTER),
 *   2. strip the directory with a greedy "everything up to the last separator" regex —
 *      backslash on `_WIN32`, forward slash everywhere else; our stored paths use the platform
 *      separator via `join`,
 *   3. strip a trailing `.zim` plus any lowercase letters (so `.zim`, `.zimaa`, … all go),
 *   4. every ` ` → `_`,
 *   5. every `+` → `plus`.
 *
 * `platform` is injected (L9's posture) so BOTH separator branches are testable on one OS.
 */
export function servingNameFor(path: string, platform: NodeJS.Platform = process.platform): string {
  let name = removeAccents(path)
  name = platform === 'win32' ? name.replace(/^.*\\/, '') : name.replace(/^.*\//, '')
  name = name.replace(/\.zim[a-z]*$/, '')
  name = name.split(' ').join('_')
  name = name.split('+').join('plus')
  return name
}

/** One pack excluded from the served library because an earlier book already owns its name
 *  (`collidesWith` KEEPS it — the smaller UUID, libkiwix's own first-wins rule). The shared
 *  shape since #340 (D-Z16): `packs:status.excluded` carries it to the panel. */
export type ServingNameCollision = KnowledgePackCollision

export interface ServedNameSet {
  /** pack id → the name kiwix-serve will answer to. Winners only. */
  names: Map<string, string>
  excluded: ServingNameCollision[]
}

/**
 * The exact served set for a list of resolved candidates, by libkiwix's own rule.
 *
 * `HumanReadableNameMapper` (pinned `name_mapper.cpp` 74f664ea) iterates
 * `library.filter(Filter())`, which walks a `std::map<std::string, Book>` — i.e. ASCENDING
 * UUID-STRING order — and `mapName` keeps the FIRST book for a name, logging "Path collision …
 * only '<first>' will be served" for every later one. Date aliases (`_YYYY-MM` stripped) are
 * added only when `withAlias` is true, and kiwix-serve 3.8.1 passes its `--nodatealiases` flag
 * AS `withAlias`; we never pass that flag, so our server has NO aliases and only PRIMARY-name
 * collisions can occur.
 *
 * We therefore compute the winners ourselves and leave the losers OUT of the library XML, so
 * the server never sees a collision at all and the outcome is identical to whichever book
 * libkiwix would have kept. A badge alone would not stop mis-serving (finding M5).
 */
export function computeServedSet(
  candidates: ReadonlyArray<{ id: string; path: string }>,
  platform: NodeJS.Platform = process.platform
): ServedNameSet {
  const names = new Map<string, string>()
  const excluded: ServingNameCollision[] = []
  const owner = new Map<string, string>() // serving name → the pack id that keeps it
  const ordered = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const candidate of ordered) {
    const name = servingNameFor(candidate.path, platform)
    const first = owner.get(name)
    if (first !== undefined) {
      excluded.push({ packId: candidate.id, collidesWith: first })
      continue
    }
    owner.set(name, candidate.id)
    names.set(candidate.id, name)
  }
  return { names, excluded }
}
