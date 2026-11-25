// #873: what `fetch-runtime` does with an engine whose install marker differs from the drive's pin. ONE table drives
// both twins (script-execution.test.ts runs every row on the .ps1 and the .sh leg) and the app's own ordering
// (script-drift.test.ts holds `compareRuntimeVersions` to each row's `order`), so the scripts and the app cannot drift.
// An engine newer than the pin (installed by a newer app, #516 + #842) is kept unless `-Commercial` (a sold drive
// carries its app's pin) or `-AllowDowngrade`; an older one, or one neither side can order, is re-fetched as before.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_ROOT } from './repo-files'

export type MarkerFamily = 'llama_cpp' | 'whisper_cpp' | 'kiwix_tools'

export interface MarkerRow {
  title: string
  family: MarkerFamily
  /** The drive's pin for `family` (the scratch yaml's `version`). */
  pin: string
  /** What the install marker records. */
  marker: { version: string; backend: string }
  /** `-Backend cpu`: the row reads the `cpu/` safety net's marker. */
  cpuNet?: boolean
  /** Flags in camel case; each leg spells them (`-AllowDowngrade`, `--allow-downgrade`). */
  flags: Array<'Commercial' | 'AllowDowngrade'>
  /** `compareRuntimeVersions(marker.version, pin)`: what the app makes of the two. */
  order: -1 | 0 | 1 | null
  /** What the script must do with the present engine. */
  expect: 'skip-newer' | 'refetch' | 'refetch-commercial'
}

export const MARKER_ROWS: readonly MarkerRow[] = [
  { title: 'a newer build is kept', family: 'llama_cpp', pin: 'b9585', marker: { version: 'b99999', backend: 'vulkan' }, flags: [], order: 1, expect: 'skip-newer' },
  // The app's relation ignores the backend too (assets.ts runtimeInstallRelation).
  { title: 'a newer build in another backend is kept', family: 'llama_cpp', pin: 'b9585', marker: { version: 'b99999', backend: 'cpu' }, flags: [], order: 1, expect: 'skip-newer' },
  { title: 'a newer build is replaced in commercial mode', family: 'llama_cpp', pin: 'b9585', marker: { version: 'b99999', backend: 'vulkan' }, flags: ['Commercial'], order: 1, expect: 'refetch-commercial' },
  { title: 'a newer build is replaced when downgrading is allowed', family: 'llama_cpp', pin: 'b9585', marker: { version: 'b99999', backend: 'vulkan' }, flags: ['AllowDowngrade'], order: 1, expect: 'refetch' },
  { title: 'an older build is re-fetched', family: 'llama_cpp', pin: 'b9585', marker: { version: 'b1', backend: 'vulkan' }, flags: [], order: -1, expect: 'refetch' },
  // A build counter cannot be ordered against a dotted release: today's behaviour. Both markers would read as
  // NEWER if a twin compared the numbers and ignored the shapes (99999 > 9585; 5 > 1), so a dropped shape check
  // turns these rows red on that twin's leg.
  { title: 'a dotted version against a build pin is re-fetched (no order)', family: 'llama_cpp', pin: 'b9585', marker: { version: 'v99999', backend: 'vulkan' }, flags: [], order: null, expect: 'refetch' },
  { title: 'a build tag against a dotted pin is re-fetched (no order)', family: 'whisper_cpp', pin: 'v1.8.6', marker: { version: 'b5', backend: 'cpu' }, flags: [], order: null, expect: 'refetch' },
  { title: 'an unordered tag is re-fetched', family: 'llama_cpp', pin: 'b9585', marker: { version: 'nightly', backend: 'vulkan' }, flags: [], order: null, expect: 'refetch' },
  { title: 'a newer voice engine is kept', family: 'whisper_cpp', pin: 'v1.8.6', marker: { version: 'v1.9.0', backend: 'cpu' }, flags: [], order: 1, expect: 'skip-newer' },
  // Numeric, never lexical: '3.10.0' < '3.8.1' as text.
  { title: 'a newer knowledge-pack tools release is kept (numeric order)', family: 'kiwix_tools', pin: '3.8.1', marker: { version: '3.10.0', backend: 'cpu' }, flags: [], order: 1, expect: 'skip-newer' },
  // bash reads 09 as an octal number and errors unless it says 10#.
  { title: 'a newer release with a leading zero is kept', family: 'whisper_cpp', pin: 'v1.8.6', marker: { version: 'v1.09.0', backend: 'cpu' }, flags: [], order: 1, expect: 'skip-newer' },
  // Missing trailing parts count as zero, so v1.8.6.1 is newer than v1.8.6 and v1.8 is older.
  { title: 'a release with one more part is newer', family: 'whisper_cpp', pin: 'v1.8.6', marker: { version: 'v1.8.6.1', backend: 'cpu' }, flags: [], order: 1, expect: 'skip-newer' },
  { title: 'a release with one part fewer is older', family: 'whisper_cpp', pin: 'v1.8.6', marker: { version: 'v1.8', backend: 'cpu' }, flags: [], order: -1, expect: 'refetch' },
  // The case of the tag matters to the app (`/^b(\d+)$/`), so `B99999` has no order there either.
  { title: 'an upper-case build tag is not a build counter', family: 'llama_cpp', pin: 'b9585', marker: { version: 'B99999', backend: 'vulkan' }, flags: [], order: null, expect: 'refetch' },
  { title: 'a newer cpu/ safety net is kept', family: 'llama_cpp', pin: 'b9585', marker: { version: 'b99999', backend: 'cpu' }, cpuNet: true, flags: [], order: 1, expect: 'skip-newer' }
]

// App-update wave T2.10 (W-62, F-24): the golden install markers, the second table beside MARKER_ROWS. Release 1 reads
// every marker a later release leaves on a drive with three readers: the app's `readRuntimeMarkerState` (and the
// pre-spawn check built on it) and both `fetch-runtime` twins. `tests/fixtures/readers/f24-markers/vectors.json` holds the
// vectors with each reader's verdict, written from W-62's lists: assets.test.ts runs the app's readers over them,
// script-execution.test.ts both twins. A vector's bytes are its `parts` joined; base64 carries the bytes (a NUL, a
// byte-order mark, a raw control byte) the repo's hygiene nets refuse in a committed text file.

export type MarkerPart = { text: string } | { base64: string } | { repeat: string; times: number }
export type TwinVerdict = 'skip' | 'keep' | 'refetch'
export interface MarkerGolden {
  name: string
  class: 'accepted' | 'damaged' | 'script-only refusal' | 'absent'
  parts: MarkerPart[]
  /** No file at the marker path (round 2). */
  absent?: true
  /** A folder at the marker path (round 2). */
  folder?: true
  /** Files this vector adds to the copy, name to text, beside the copy's own (round 3: a name holding a comma). */
  files?: Record<string, string>
  /** `readRuntimeMarkerState(dir).kind`. */
  app: 'marker' | 'damaged' | 'absent'
  /** The marker's own version and backend, when `app` is `marker`. */
  version?: string
  backend?: string
  /** `verifyBinaryBeforeSpawn` for the program, with verification enforced. */
  preSpawn: 'ok' | 'skip-legacy' | 'marker-damaged' | 'missing' | 'mismatch'
  /** What a dry run of each twin does with the present copy: read it as the pinned install, or fetch it again. */
  twins: { default: TwinVerdict; commercial: TwinVerdict }
  /** The .sh twin's verdict, where it differs from the .ps1 twin's (round 2). */
  sh?: { default: TwinVerdict; commercial: TwinVerdict }
  /** The drive's pin for this vector (default: the copy's version). */
  pin?: string
  /** `utf8`: the .sh twin runs under a UTF-8 locale for this vector. */
  shLocale?: 'utf8'
  why: string
}
/** Round 2: the version relation of an installed engine against the pin (F-24). */
export interface MarkerRelation {
  name: string
  /** What the copy's marker records; absent: the copy has no marker file (round 3). */
  marker?: { version: string; backend: string }
  pin: string
  /** `compareRuntimeVersions(marker.version, pin)`; absent with no marker, which has no version to order. */
  order?: -1 | 0 | 1 | null
  /** `runtimeInstallRelation`. */
  relation: 'older' | 'current' | 'newer' | 'unknown'
  /** `runtimeInstallCurrent` (the install skip: version and backend equal). */
  installCurrent: boolean
  /** The twins on a drive pinned to `pin` (the copy's backend) holding the copy with that marker. */
  twins: { default: TwinVerdict; commercial: TwinVerdict }
  why: string
}
export interface MarkerGoldenSet {
  /** The engine copy every vector is the marker of: its pin fields and its files' bytes. */
  copy: { family: 'llama_cpp'; version: string; backend: string; os: 'win'; arch: string; extractTo: string; files: Record<string, string>; sha256: Record<string, string> }
  /** What every writer records for `copy`. */
  record: { version: string; backend: string; os: string; arch: string; binaries: Record<string, string> }
  vectors: MarkerGolden[]
  relations: MarkerRelation[]
}

export const MARKER_GOLDENS: MarkerGoldenSet = JSON.parse(
  readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f24-markers', 'vectors.json'), 'utf8')
) as MarkerGoldenSet

/** A golden vector's bytes. */
export function markerBytes(vector: MarkerGolden): Buffer {
  return Buffer.concat(
    vector.parts.map((part) =>
      'text' in part ? Buffer.from(part.text, 'utf8') : 'base64' in part ? Buffer.from(part.base64, 'base64') : Buffer.from(part.repeat.repeat(part.times), 'utf8')
    )
  )
}
