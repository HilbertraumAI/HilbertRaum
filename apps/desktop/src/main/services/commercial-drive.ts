import { accessSync, constants as fsConstants, existsSync, lstatSync, opendirSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { ModelManifest } from '../../shared/manifest'
import {
  isKitPlatform,
  KIT_PLATFORMS,
  type KitPlatform,
  type OcrSources,
  type RuntimeBuild,
  type RuntimeFamily,
  type RuntimeSources
} from '../../shared/runtime-sources'
import { isCommercialPolicy, loadPolicy, readUpdatePolicy } from './policy'
import {
  engineSwapDirs,
  findNeverInstalledFiles,
  markerBinaryKey,
  NESTED_NET_FOLDERS,
  planOcrDownloads,
  planRuntimeDownload,
  readRuntimeMarkerState,
  recordedFilePath,
  requiredInstallFiles,
  RUNTIME_MARKER_FILE,
  sidecarFamilySpec,
  type RuntimeDownloadPlan,
  type SidecarFamilySpec
} from './assets'
import { isMacMetadataName } from './archive-size'
import { manifestFiles, sha256File } from './models'
import { verifyDriveModels, listSkillFolders, type ModelVerifyResult } from './drive'
import { chooseAppVersion, readDriveRelease, rootApps, rootArtifactOf, type DriveSystem, type RootApp } from './updates/drive-release'
import { formatKitSupport, KIT_SUPPORT_REL, readKitSupport } from './updates/kit-support'

// The commercial-drive gate: the final posture assertion (spec §12.2).
//
// `scripts/build-commercial-drive.{ps1,sh}` run the ordered build natively (they orchestrate
// prepare-drive / fetch-* / verify-models; tests/integration/script-orchestration.test.ts runs
// that order) and, for the verdict, CALL this assertion through the built
// `out/tools/assert-commercial-drive.mjs` (src/main/tools) — SELLABLE is printed only from its
// result (#233, #234). `assertCommercialDrive` is the gate that decides "is this drive actually
// sellable?" and reuses loadPolicy + verifyDriveModels rather than duplicating that logic.
//
// A sellable drive MUST ship the commercial posture (encryption required, plaintext off,
// models must verify, NETWORK DENIED — spec §12.2), contain NO user data, and carry the
// app artifact + launcher for every platform it is sold for. The assertion FAILS LOUDLY
// if any of that is violated.
//
// What a never-updated Kit runs for its whole support period is what this gate lets through, so since the app-update
// wave (T3.8, W-33's M1 half) it also reads what release 1 reads on every Kit: the Kit's reserved update key in
// policy.json, the release record `config/drive-release.json` (T3.3a's frozen reader, its `app_version` judged by the
// root-app classifier the record's writer uses) and the support end `config/kit-support.txt` (the builder's bytes); and
// it refuses a started Kit (`updates/`), an engine file no marker records, an extracted `.app` and a read-only root app.
// No problem line holds bytes of a file: only fixed names, a validated version, an errno or fault token, file names.

/**
 * Distribution-level license/attribution artifacts every prepared drive carries at its
 * ROOT (LIC-1, full-audit 2026-07-12b): the app's own GPL-3.0-or-later license text, the
 * bundled-npm-package notices, and the GENERATED drive-wide notices (runtime binaries +
 * model weights + the GPLv3 source-availability statement — regenerated with
 * `node scripts/generate-drive-notices.mjs` from model-manifests/ + licenses/).
 * `prepare-drive.{ps1,sh}` copy all three from the repo root; `assertCommercialDrive`
 * below (and the build-commercial-drive scripts' native cross-check) fails a drive where
 * any is missing or empty. `tests/integration/script-drift.test.ts` pins the four
 * scripts' literals to this list.
 */
export const DRIVE_LICENSE_ARTIFACTS = [
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'DRIVE-NOTICES.md'
] as const

/**
 * The folders a used workspace writes into, which a sold drive ships EMPTY (spec §12.2, #893).
 * Every entry directly in one is user data: a file, or a link (named, never followed), as
 * `<dir>/<name>`; a non-empty folder as `<dir>/<name>/*`. An empty folder is fine: the Kit build
 * lays out `workspace/` and `logs/` empty, and the app creates `documents/`, `images/` and
 * `zim-transient/` on first use and may leave them empty. A rule rather than a list of names:
 * the vault, the logger and the knowledge-pack service write about twenty names, several of them
 * plaintext (the decrypt temp, `.recovery`, the password-change journal, `zim-transient/`,
 * `logs/app.log` in dev mode), and a list missed each new one. `updates/` (app-update W-33, T3.8):
 * every start on a prepared drive appends to `updates/update.log` (F-11), so a Kit that was started
 * before it shipped fails (a test start belongs on a copy); an empty `updates/` passes like the
 * others (the T3.8 sheet's Q2). `build-commercial-drive.{ps1,sh}`
 * re-state the rule in their native pre-flight; `tests/integration/script-drift.test.ts` pins
 * both scripts' literals to this list and to `USER_DATA_CONFIG_FILES`.
 */
export const USER_DATA_DIRS = ['workspace', 'logs', 'updates'] as const

/**
 * The `config/` files only a used workspace leaves (#893): the vault descriptor and the
 * working-copy-lost marker (#875), each exact or with a suffix (`workspace.json.tmp`). Matched
 * without case, as the existence check before #893 matched them on a case-insensitive drive
 * (where the app would read `Workspace.json` as its descriptor).
 */
export const USER_DATA_CONFIG_FILES = ['workspace.json', 'working-copy-lost.json'] as const

// ---- The final "is this drive sellable?" assertion ---------------------------------

/** What a kit must carry at its root per platform it is sold for (#233). */
export interface KitPlatformSpec {
  /** The double-click launcher for that OS (`launchers/`). */
  launcher: string
  /** The release artifact name for a given app version: the name the gate's lines expect. */
  artifact: (version: string) => string
}

/**
 * Per-platform artifact + launcher names — the same names the launchers glob for on the
 * drive root and the release workflow uploads. Which root entry IS an app, and which version its
 * name carries, is the root-app classifier's (`rootArtifactOf`, updates/drive-release.ts, T3.8):
 * `artifact(v)` only spells the expected name, and commercial-drive.test.ts holds the two together.
 * A Kit carries the macOS app as its zip; an extracted `*.app` folder is refused (T3.8, owner
 * 2026-11-26: it carries no version, so the record cannot name it).
 */
export const KIT_PLATFORM_SPECS: Record<KitPlatform, KitPlatformSpec> = {
  'win-x64': {
    launcher: 'Start HilbertRaum.cmd',
    artifact: (v) => `HilbertRaum-${v}-portable.exe`
  },
  'mac-arm64': {
    launcher: 'Start HilbertRaum.command',
    artifact: (v) => `HilbertRaum-${v}-mac-arm64.app.zip`
  },
  'linux-x64': {
    launcher: 'start-hilbertraum.sh',
    artifact: (v) => `HilbertRaum-${v}.AppImage`
  }
}

/** The Kit platform of each system the root-app classifier names (one fixed map). */
const PLATFORM_OF_SYSTEM: Record<DriveSystem, KitPlatform> = { win32: 'win-x64', darwin: 'mac-arm64', linux: 'linux-x64' }

/** The platform matrix a kit is declared for + the app version being built (#233). */
export interface CommercialGateOptions {
  platforms: KitPlatform[]
  appVersion: string
  /**
   * #339 P8-1: build families beyond the two grandfathered positionals (`runtimeSources` =
   * llama_cpp, `whisperSources` = whisper_cpp), keyed by yaml family name. Every FUTURE family
   * goes here; the positionals are frozen. The code-side spec (`SIDECAR_FAMILY_SPECS`) decides
   * whether a family is required (`runtimeCurrent` / `runtimeHashed`) or optional
   * (`optionalRuntimesConsistent`). A null entry is "not declared on this drive".
   */
  families?: Partial<Record<RuntimeFamily, RuntimeSources | null>>
}

interface FoundAppArtifact {
  name: string
  /** The platform the root-app classifier gives the name; null for a name it gives none (refused). */
  platform: KitPlatform | null
  /** The version the name carries by the classifier; null for none (always null for a folder). */
  version: string | null
  size: number
  isDir: boolean
  /** No one may write the file (on Windows the read-only attribute). Always false for a folder. */
  readOnly: boolean
}

/**
 * Every app artifact at the drive root, as the root-app classifier `rootArtifactOf` judges each file (T3.8: one
 * classifier, the one the release record's writer and release 1's version rule use), plus the gate's own stricter
 * looks: any root FOLDER ending `.app` (a hidden one included, which the classifier skips as bash's `*` does) counts as
 * the mac app, and is refused; any other root FILE whose name starts `HilbertRaum-` in any case is kept with no
 * platform, and refused (#233: none unrecognised; the Windows start file finds its app without case, the T3.8 sheet F5).
 * A link is neither (never followed).
 */
function scanAppArtifacts(rootPath: string): FoundAppArtifact[] {
  const found: FoundAppArtifact[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(rootPath, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) {
        found.push({ name: entry.name, platform: 'mac-arm64', version: null, size: 1, isDir: true, readOnly: false })
      }
      continue
    }
    if (!entry.isFile()) continue
    const artifact = rootArtifactOf(entry.name, 'file')
    if (artifact === null && !entry.name.toLowerCase().startsWith('hilbertraum-')) continue
    let size = 0
    let readOnly = false
    try {
      const info = statSync(join(rootPath, entry.name))
      size = info.size
      readOnly = (info.mode & 0o222) === 0
    } catch {
      size = 0
    }
    found.push({
      name: entry.name,
      platform: artifact === null ? null : PLATFORM_OF_SYSTEM[artifact.system],
      version: artifact?.version ?? null,
      size,
      isDir: false,
      readOnly
    })
  }
  return found
}

export interface CommercialAssertion {
  ok: boolean
  /** Human-readable reasons the drive is NOT sellable (empty when ok). */
  problems: string[]
  checks: {
    /** Encryption required + plaintext off + models must verify. */
    policyCommercial: boolean
    /** The drive never PHONES HOME on its own: no update checks, no telemetry. Model
     *  downloads are an explicit, user-initiated, per-download-confirmed action and are
     *  PERMITTED on a sold drive, so they do not count as a network violation here. */
    networkDenied: boolean
    /**
     * The Kit's `updates` block (app-update U1 (b), F-8; T3.8): `policy.json` carries `"updates": {"allow_online_check":
     * true}` as the Kit builders write it (own keys only; a missing or unreadable file fails it), and release 1's install
     * keys read as valid (`readUpdatePolicy` never answers `invalid`, which would block every import on the Kit for
     * good; an administrator's deliberate `allow_user_install: false` passes). Release 1 acts on no value of
     * `allow_online_check`; the network ceiling (`networkDenied`) is untouched by it.
     */
    kitUpdatesKey: boolean
    /**
     * At least one model is bundled, and every model the drive SHIPS is present + SHA-256
     * VERIFIED (no placeholder/mismatch/missing file). A model ships when it is bundled
     * (`bundled_on_preconfigured_drive`) or has any file on the drive (#766). A model with no
     * file on the drive is the in-app download catalog and is not checked here.
     */
    weightsVerified: boolean
    /**
     * Every model the drive ships has `license_review.status` `approved` (spec §13): preloading
     * is redistribution. NOT overridable by `--accept-license` — that flag is a user's license
     * acceptance at download time, not a substitute for the review a SOLD drive needs. A
     * catalog-only model is not preloaded, so its own in-app license gate applies instead (#766).
     */
    licensesApproved: boolean
    /**
     * No user data present (a sold drive ships empty — spec §12.2): nothing but empty folders
     * directly in `workspace/`, `logs/` and `updates/` (a started Kit, T3.8), and no `config/workspace.json*` or
     * `config/working-copy-lost.json*` (#893; `USER_DATA_DIRS`, `USER_DATA_CONFIG_FILES`).
     * Fail closed: one of those folders, or a folder in one of the first three, that cannot be
     * listed, and a file where one of the four folders belongs, fail it too; only a missing one passes.
     */
    noUserData: boolean
    /**
     * Every pinned runtime build's install marker matches the runtime-sources.yaml pin
     * (version + backend). True when no `runtimeSources` were passed (the
     * check is opt-in; the native scripts cross-check it too). Covers BOTH sidecar
     * families when `whisperSources` is also passed.
     */
    runtimeCurrent: boolean
    /**
     * Every pinned runtime build's marker records the binary's SHA-256 AND the on-disk
     * bytes still match it (#234). Opt-in like `runtimeCurrent`. A hashless (legacy)
     * marker fails here, not in `runtimeCurrent`. #998: so does any further file the marker
     * records (an install since #998 records every file) that is missing, modified or
     * outside its folder. T3.8 (T3.12 review 1 M-2): and any file in the folder that the marker does
     * not record, by exactly the walk an install records (`installedFileKeys`: never the marker, the
     * `cpu/` net and its swap folders, or macOS metadata), so a marker that records only the required
     * files passes only over a folder that holds only those.
     */
    runtimeHashed: boolean
    /**
     * An OPTIONAL runtime family (kiwix_tools, #339 P8-1) is either FULLY provisioned — every
     * declared executable and required runtime file present, the marker current, every hash
     * recorded and still matching — or ENTIRELY absent. A half-installed optional family fails
     * the drive: the app would spawn it. True when no optional family is passed, and true for a
     * Kit that deliberately ships without knowledge-pack tools. Never folds into
     * `runtimeCurrent` / `runtimeHashed`, which keep their exact meaning for the required
     * families.
     */
    optionalRuntimesConsistent: boolean
    /**
     * A COPYLEFT sidecar family that is present on the drive carries its complete
     * corresponding source (#339 P8-4, owner ruling 2026-09-06). Fail-closed and
     * MARKER-INDEPENDENT: any declared executable of `kiwix_tools` existing under any
     * platform's extract dir — a hand-placed bundle included — requires the yaml's
     * `source_bundle` directory with every pinned archive present, hash-matching, and a
     * non-empty SOURCES.md beside them. True when no such binary is on the drive (a Kit may
     * deliberately ship none) and true for a complete bundle. Named for kiwix_tools because
     * it is the only family with a `source_bundle` today.
     */
    kiwixSourceBundle: boolean
    /**
     * Every pinned OCR language file is present + sha256-verified (opt-in:
     * true when no `ocrSources` were passed).
     */
    ocrAssetsVerified: boolean
    /**
     * At least one trusted product skill is provisioned under `app-skills/` (skills plan S9 /
     * §7.3). A sold drive ships product skills like the bank-statement stub. (Integrity of those
     * skills is the accepted §22-M2 residual: trust is by drive location, not signature.)
     */
    appSkillsPresent: boolean
    /**
     * `user-skills/` is empty (skills plan S9 / §14): a sellable drive ships only trusted product
     * skills and no user-installed ones — the same "ships empty" rule as the workspace.
     */
    userSkillsEmpty: boolean
    /**
     * Every root license/attribution artifact (`DRIVE_LICENSE_ARTIFACTS`) is present and
     * non-empty (LIC-1, full-audit 2026-07-12b): the approved reviews record "ship the
     * LICENSE/NOTICE attribution with the drive", the MIT binaries require their notice
     * in all copies, and the app's own GPL text + source statement ride the same files.
     */
    licenseArtifactsPresent: boolean
    /**
     * `opts.platforms` names at least one known platform (no duplicates) and
     * `opts.appVersion` is set (#233). False when the gate is called without them — the
     * app cannot be checked against an undeclared kit, so the drive is not sellable.
     */
    platformMatrixDeclared: boolean
    /**
     * Exactly one non-empty app artifact per declared platform, named for `appVersion`,
     * none for an undeclared platform, none unrecognised (#233). One extra artifact —
     * an older build left beside the new one — fails the drive. T3.8: judged by the root-app
     * classifier; an extracted `.app` folder, a name that carries no version and a read-only app
     * (W-33: release 1's start file would read it as running at every start) fail it too.
     */
    appArtifactsPresent: boolean
    /** The launcher file of every declared platform is present + non-empty at the root. */
    launchersPresent: boolean
    /**
     * T3.8 (W-33's M1 half, W-20): `config/drive-release.json` reads as a record (the frozen F-13 reader) whose valid
     * `app_version` is the one version the root's apps carry by the classifier (`chooseAppVersion`'s "single").
     * Checked whether or not a platform matrix was declared.
     */
    releaseRecordCurrent: boolean
    /**
     * T3.8 (W-17, G-13): `config/kit-support.txt` reads as a month (`readKitSupport`, F-13) and its bytes are the
     * builder's (`formatKitSupport`: the month and one line feed). Its range is the ship-time check's (P11c).
     */
    supportEndStamped: boolean
  }
  /** The per-weight verification detail of every model the Kit ships (for surfacing which failed). */
  modelResults: ModelVerifyResult[]
}

/** A look into one folder for the user-data rule: its entries, or why there are none to read. */
type UserDataListing =
  | { kind: 'entries'; entries: Dirent[] }
  | { kind: 'absent' }
  | { kind: 'not-a-folder' }
  | { kind: 'unreadable' }

/** Only a missing path (ENOENT) is "nothing there"; any other failure is a look the gate could not take. */
const lookFailed = (e: unknown): { kind: 'absent' } | { kind: 'unreadable' } =>
  (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }

/**
 * Lists `dir`, failing closed (#893): a file where the folder belongs, and a folder this process
 * cannot list or enter (the native pre-flights test the same read + enter rights), are reported,
 * never read as empty. A link to a folder is followed here, as the app follows it.
 */
function listForUserData(dir: string): UserDataListing {
  try {
    if (!statSync(dir).isDirectory()) return { kind: 'not-a-folder' }
    accessSync(dir, fsConstants.R_OK | fsConstants.X_OK)
    return { kind: 'entries', entries: readdirSync(dir, { withFileTypes: true }) }
  } catch (e) {
    return lookFailed(e)
  }
}

/** Whether the folder `dir` holds anything, from its first entry alone (a folder of thousands is not read). */
function firstEntryOf(dir: string): 'empty' | 'held' | 'absent' | 'unreadable' {
  try {
    accessSync(dir, fsConstants.R_OK | fsConstants.X_OK)
    const handle = opendirSync(dir)
    try {
      return handle.readSync() === null ? 'empty' : 'held'
    } finally {
      handle.closeSync()
    }
  } catch (e) {
    return lookFailed(e).kind
  }
}

/**
 * Artifacts that mean a workspace has already been USED (must be absent on a sold drive): the
 * `USER_DATA_DIRS` / `USER_DATA_CONFIG_FILES` rule (#893), each list sorted so the problem order is
 * stable. `present` names what is there; `unreadable` what the gate could not look into:
 * `<dir>/` for a folder it cannot list, `<dir> (not a folder)` for a file where the folder belongs.
 */
function userDataArtifacts(rootPath: string): { present: string[]; unreadable: string[] } {
  const present: string[] = []
  const unreadable: string[] = []
  const look = (dir: string): Dirent[] => {
    const listing = listForUserData(join(rootPath, dir))
    if (listing.kind === 'not-a-folder') unreadable.push(`${dir} (not a folder)`)
    if (listing.kind === 'unreadable') unreadable.push(`${dir}/`)
    return listing.kind === 'entries' ? listing.entries : []
  }
  // A created workspace leaves the DB in some state (plaintext, `.enc`, the decrypt and encrypt
  // temps, a lock's `.recovery`, a password change's staged copy and journal), and a crash can
  // leave the WAL/SHM sidecars (plaintext DB pages) that `cleanSidecars` normally shreds — this
  // final ship gate does not rely on shredStalePlaintext having run. Stored documents, images and
  // knowledge-pack transients live in sub-folders; the logs in logs/. Any of it means the drive
  // was already initialised, not factory-fresh. A Dirent describes the entry itself, so a link or
  // junction is not a directory here: it is named, and its target is never read.
  for (const dir of USER_DATA_DIRS) {
    for (const e of look(dir)) {
      if (!e.isDirectory()) {
        present.push(`${dir}/${e.name}`)
        continue
      }
      const held = firstEntryOf(join(rootPath, dir, e.name))
      if (held === 'held') present.push(`${dir}/${e.name}/*`)
      else if (held === 'unreadable') unreadable.push(`${dir}/${e.name}/`)
    }
  }
  for (const e of look('config')) {
    const name = e.name.toLowerCase()
    if (USER_DATA_CONFIG_FILES.some((f) => name === f || name.startsWith(`${f}.`))) present.push(`config/${e.name}`)
  }
  return { present: present.sort(), unreadable: unreadable.sort() }
}

/**
 * The staged-swap leftovers beside the install folder `extractTo` (#986): its `.new` and `.old` siblings
 * that exist (a link of that name counts), drive-relative with `/`. Empty for a folder the swap cannot have
 * (one that is the drive root).
 */
function engineSwapLeftovers(rootPath: string, extractTo: string): string[] {
  let dirs: { staging: string; previous: string }
  try {
    dirs = engineSwapDirs(rootPath, extractTo)
  } catch {
    return []
  }
  const there = (p: string): boolean => {
    try {
      lstatSync(p)
      return true
    } catch {
      return false
    }
  }
  return [dirs.staging, dirs.previous].filter(there).map((p) => relative(resolve(rootPath), p).split(sep).join('/'))
}

/** #1028: the gate's line for an install marker that is there but could not be read just now (`code`: its errno code). */
function unreadableMarkerLine(label: string, extractTo: string, code: string | null): string {
  return (
    `${label}: the .hilbertraum-runtime.json install marker under ${extractTo} could not be read ` +
    `(${code ?? 'read failed'}) — check the drive, then run the gate again`
  )
}

/** The errno code of a failure (`EPERM`, …), validated as one: never the message, which names a path. */
function errnoToken(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : null
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The largest policy.json the Kit-key reader takes into memory (the update policy reader's cap). */
const POLICY_MAX_BYTES = 1_048_576

/**
 * Whether `<configDir>/policy.json` carries the Kit's reserved update key exactly as the Kit builders write it (U1 (b),
 * T3.8): an own `updates` object holding an own `allow_online_check` that is `true`. Never throws: a missing, unreadable
 * or damaged file carries no key. Read here, not through policy.ts: release 1 reads no value of the key, and no reader
 * of policy.ts may ever feed it into the network ceiling. One leading byte-order mark is read past, as both of
 * policy.ts's readers do.
 */
function hasKitUpdatesKey(configDir: string): boolean {
  let doc: unknown
  try {
    const path = join(configDir, 'policy.json')
    const info = statSync(path)
    if (!info.isFile() || info.size > POLICY_MAX_BYTES) return false
    const text = readFileSync(path, 'utf8')
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return false
  }
  if (!isPlainObject(doc) || !Object.hasOwn(doc, 'updates')) return false
  const updates = doc.updates
  return isPlainObject(updates) && Object.hasOwn(updates, 'allow_online_check') && updates.allow_online_check === true
}

/** Whether an own `updates` block of `<configDir>/policy.json` is an object (a non-object one is the Kit-key line's). */
function updatesBlockIsObject(configDir: string): boolean {
  try {
    const text = readFileSync(join(configDir, 'policy.json'), 'utf8')
    const doc: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    return isPlainObject(doc) && Object.hasOwn(doc, 'updates') && isPlainObject(doc.updates)
  } catch {
    return false
  }
}

/** Whether `path`, a link, resolves to a regular file (`runtime-download.ts` recordedKind: an install records only such a link). */
function linkResolvesToFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * T3.8 (W-33; T3.12 review 1 M-2, Δ-61): the files in the engine copy at `dir` that its marker's map does not record,
 * `markerBinaryKey` form, sorted by code unit, by exactly the walk an install records (`installedFileKeys` in
 * runtime-download.ts and the two fetch-runtime twins), so a copy any of the three installers wrote passes, whatever
 * its archive held: regular files and links that resolve to a file, at any depth; never the marker or, at the top, the
 * `cpu/` net and its swap folders (`NESTED_NET_FOLDERS`: copies with their own markers, which report for themselves),
 * never macOS metadata (`isMacMetadataName`). Also skipped: another build's own folder nested here (`otherCopies`), and
 * a name the #729 check already reported (`reported`). Names are compared byte for byte with the map's keys. Fails
 * closed: a folder that cannot be listed is returned in `unlistable` (with its errno token), never read as empty.
 */
function unrecordedEngineFiles(
  dir: string,
  recorded: Readonly<Record<string, string>>,
  otherCopies: readonly string[],
  reported: readonly string[]
): { unrecorded: string[]; unlistable: Array<{ rel: string; code: string | null }> } {
  const unrecorded: string[] = []
  const unlistable: Array<{ rel: string; code: string | null }> = []
  const skip = new Set(otherCopies.map((d) => resolve(d)))
  const walk = (current: string, rel: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (err) {
      unlistable.push({ rel, code: errnoToken(err) })
      return
    }
    for (const entry of entries) {
      if (!rel && (entry.name === RUNTIME_MARKER_FILE || NESTED_NET_FOLDERS.includes(entry.name))) continue
      const key = rel ? `${rel}/${entry.name}` : entry.name
      if (isMacMetadataName(key)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!skip.has(resolve(full))) walk(full, key)
        continue
      }
      const isFile = entry.isFile() || (entry.isSymbolicLink() && linkResolvesToFile(full))
      if (isFile && !Object.hasOwn(recorded, key) && !reported.includes(key)) unrecorded.push(key)
    }
  }
  walk(dir, '')
  return { unrecorded: unrecorded.sort(), unlistable }
}

/** How the gate's lines name the record helper: the builder's own call, the target spelled as the operator's drive root. */
const WRITE_RECORD = 'node --no-warnings scripts/lib/write-drive-release.mjs --target <drive root>'

/** What the gate adds to a user-data line for an entry in `updates/` (T3.8): the drive was started, and the way out. */
const STARTED_DRIVE = ' — this drive was started: delete the updates/ folder (a test start belongs on a copy, never on the Kit)'

/**
 * T3.8 (W-33's M1 half, W-20): the problem with the drive's release record, or null when it is current. The record is
 * read by the frozen F-13 reader; "the version the root's apps carry" is the helper's own rule, `chooseAppVersion`
 * called with no existing value, so only "single" can answer. The record is not compared with `--app-version` here: an
 * artifact of another version already has its own line, and then this one names the mismatch with the apps.
 */
function releaseRecordProblem(rootPath: string): string | null {
  const read = readDriveRelease(rootPath)
  if (read.kind === 'absent') {
    return `config/drive-release.json is missing — write it: ${WRITE_RECORD}, then run the check again (-VerifyOnly / --verify-only writes nothing)`
  }
  if (read.kind === 'unreadable') {
    return `config/drive-release.json could not be read (${read.code ?? 'read failed'}) — check the drive, then run the gate again`
  }
  if (read.kind === 'damaged') {
    // The helper refuses to write over something that is no regular file (a folder or a link), so that one goes first.
    const first = read.fault === 'not-a-file' ? 'delete what is at that name, then ' : ''
    return `config/drive-release.json is damaged (${read.fault}) — ${first}write it again: ${WRITE_RECORD}`
  }
  if (read.appVersion.state !== 'valid') {
    return (
      'config/drive-release.json records no app version — the apps were copied onto the drive after the record was ' +
      `written: write it again: ${WRITE_RECORD}, then run the check again (-VerifyOnly / --verify-only writes nothing)`
    )
  }
  const recorded = read.appVersion.value
  let apps: RootApp[] = []
  try {
    apps = rootApps(rootPath)
  } catch {
    apps = [] // a root that cannot be listed carries no version; the artifact check says why
  }
  const carried = chooseAppVersion(apps, undefined)
  if (carried.value === null) {
    return (
      `config/drive-release.json records app version ${recorded}, but the apps on the drive carry no single version — ` +
      `fix the apps (see above), then write the record again: ${WRITE_RECORD}`
    )
  }
  if (carried.value !== recorded) {
    return `config/drive-release.json records app version ${recorded}, the apps on the drive carry ${carried.value} — write the record again: ${WRITE_RECORD}`
  }
  return null
}

/**
 * T3.8 (W-17, G-13): the problem with the Kit's support end, or null when it is stamped: read by the frozen F-13 reader,
 * then the file's bytes compared with the builder's (`formatKitSupport`), as the builder's own helper compares them, so
 * only its 8 bytes pass (a hand edit's CR LF or byte-order mark reads for the app, never for a sale). No range check: a
 * month too close to dispatch is the ship-time check's (P11c, CF-37). Only the Kit builder writes the stamp, so every
 * way out runs it.
 */
function supportEndProblem(rootPath: string): string | null {
  const read = readKitSupport(rootPath)
  if (read.kind === 'absent') {
    return (
      "config/kit-support.txt is missing — stamp the Kit's support end: run build-commercial-drive with -SupportEnd / " +
      '--support-end <YYYY-MM> (it writes the stamp once per Kit)'
    )
  }
  if (read.kind === 'unreadable') {
    return `config/kit-support.txt could not be read (${read.code ?? 'read failed'}) — check the drive, then run the gate again`
  }
  if (read.kind === 'damaged') {
    return (
      `config/kit-support.txt is not a support end the app can read (${read.fault}) — look at it by hand; to stamp the ` +
      'Kit again, delete the file on purpose and run build-commercial-drive with -SupportEnd / --support-end'
    )
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(join(rootPath, ...KIT_SUPPORT_REL.split('/')))
  } catch (err) {
    return `config/kit-support.txt could not be read (${errnoToken(err) ?? 'read failed'}) — check the drive, then run the gate again`
  }
  if (!bytes.equals(Buffer.from(formatKitSupport(read.month), 'latin1'))) {
    return (
      "config/kit-support.txt holds a month, but not in the builder's bytes (YYYY-MM and one line feed) — delete the " +
      'file on purpose and stamp it again with build-commercial-drive -SupportEnd / --support-end'
    )
  }
  return null
}

/**
 * Assert that a prepared drive is actually SELLABLE (spec §12.2). Reuses `loadPolicy`
 * (the commercial posture) + `verifyDriveModels` (every weight the Kit ships VERIFIED, at
 * least one model bundled, #766) and checks the drive carries no user data. When `runtimeSources` (the yaml pin) is passed, each pinned
 * build's `.hilbertraum-runtime.json` install marker must also match (version + backend)
 * and record the binary's hash. `opts` declares the platforms the kit is sold for and the
 * app version: one artifact + launcher per platform is required (#233); without `opts`
 * the drive is not sellable. Returns a structured result; never throws. Fails loudly:
 * any violated invariant adds a `problems[]` entry and flips `ok` to false.
 */
export async function assertCommercialDrive(
  rootPath: string,
  manifests: ModelManifest[],
  runtimeSources?: RuntimeSources | null,
  whisperSources?: RuntimeSources | null,
  ocrSources?: OcrSources | null,
  opts?: CommercialGateOptions
): Promise<CommercialAssertion> {
  const problems: string[] = []

  // --- Policy posture (reuse loadPolicy) ---
  // Deliberately uses the DEFAULT (dev) base, NOT the packaged STRICT fallback (M-4): the
  // sell gate must FAIL a drive that ships no policy.json. With the strict fallback a
  // missing file would resolve to an encrypted/verified posture and silently pass — here
  // we want a missing/loose policy.json to surface as a problem below.
  const { policy } = loadPolicy(join(rootPath, 'config'))
  const policyCommercial = isCommercialPolicy(policy)
  // "Network denied" for a sold drive means the app never PHONES HOME on its own: no update
  // checks, no telemetry. Model downloads are an explicit, user-initiated, per-download-confirmed
  // action (the drive ships with them permitted so a buyer can add models), so they do NOT count
  // as a network violation.
  const networkDenied =
    !policy.network.allowUpdateChecks &&
    !policy.network.allowTelemetry

  if (!policy.workspace.encryptionRequired) {
    problems.push('policy.json does not require encryption (a sold drive must be encrypted-only)')
  }
  if (policy.workspace.allowPlaintextDevMode) {
    problems.push('policy.json allows a plaintext workspace (must be off on a sold drive)')
  }
  if (!policy.models.requireSha256Match) {
    problems.push('policy.json does not require SHA-256 model verification')
  }
  if (policy.network.allowUpdateChecks) {
    problems.push('policy.json allows update checks (a sold drive must not phone home)')
  }
  if (policy.network.allowTelemetry) {
    problems.push('policy.json allows telemetry (must always be off)')
  }

  // --- The Kit's updates block (T3.8: U1 (b), T3.1 review R1-1; owner 2026-11-26, the T3.8 sheet Q4) ---
  // Every Kit carries `updates.allow_online_check: true` (the Kit builders write it; release 1 reads no value of it), so a
  // drive prepared without the Kit switch, or hand-edited, is no Kit. And install keys release 1 reads as junk would
  // block every import on the Kit for good: refused at sale, while a deliberate `false` (managed) passes. A non-object
  // `updates` block is one cause, so only the first line names it.
  const configDir = join(rootPath, 'config')
  let kitUpdatesKey = true
  if (!hasKitUpdatesKey(configDir)) {
    kitUpdatesKey = false
    problems.push(
      'policy.json does not carry the Kit\'s update key ("updates": { "allow_online_check": true }) — build the drive with ' +
        'build-commercial-drive (its first step writes the Kit policy), never with prepare-drive alone'
    )
  }
  if (readUpdatePolicy(configDir).install === 'invalid' && updatesBlockIsObject(configDir)) {
    kitUpdatesKey = false
    problems.push(
      "policy.json's updates block holds an install key release 1 cannot read (updates.allow_user_install must be true or " +
        'false, updates.max_version a version) — it would refuse every update on this Kit: fix the block, or build the ' +
        'drive again with build-commercial-drive (its first step writes the Kit policy)'
    )
  }

  // --- What the Kit ships (#766, owner call 2026-11-02) ---
  // A Kit preloads its BUNDLED set and lists every other manifest for in-app download. A model
  // ships when it is bundled or has ANY file on the drive: a half-installed or unverifiable
  // preload is a shipped model too. A model with no file on the drive is the catalog, where its
  // own license gate applies at download time.
  const bundled = new Set(manifests.filter((m) => m.bundledOnPreconfiguredDrive).map((m) => m.id))
  const shipped = manifests.filter(
    (m) => bundled.has(m.id) || manifestFiles(rootPath, m).some((f) => existsSync(f.path))
  )

  // --- Every shipped weight VERIFIED (reuse verifyDriveModels) ---
  const modelResults = await verifyDriveModels(rootPath, shipped)
  const unverified = modelResults.filter((r) => r.status !== 'verified')
  for (const r of unverified) {
    problems.push(`weight "${r.id}" is not VERIFIED (status: ${r.status} — ${r.localPath})`)
  }
  if (bundled.size === 0) {
    problems.push(
      'no bundled model (bundled_on_preconfigured_drive: true): a sold drive ships its bundled set pre-loaded'
    )
  }
  const weightsVerified = bundled.size > 0 && unverified.length === 0

  // --- License reviews APPROVED for every shipped model (spec §13) ---
  // `--accept-license` lets a builder download a weight; it must never count as the
  // redistribution review. A sold drive ships only models whose review is `approved`.
  const unapproved = shipped.filter((m) => m.licenseReview.status !== 'approved')
  const licensesApproved = manifests.length > 0 && unapproved.length === 0
  for (const m of unapproved) {
    problems.push(
      `model "${m.id}" license_review.status is "${m.licenseReview.status}" — a sold drive ` +
        'requires an approved review (spec §13); --accept-license does not override this' +
        // A drive built before #766 carries such a weight; the fix is deleting it, not the review.
        (bundled.has(m.id)
          ? ''
          : '. It is not bundled and ships only because a file of it is on the drive: delete that, ' +
            'and the Kit lists the model for in-app download instead')
    )
  }

  // --- No user data (spec §12.2) ---
  const userData = userDataArtifacts(rootPath)
  const noUserData = userData.present.length === 0 && userData.unreadable.length === 0
  for (const path of userData.present) {
    problems.push(`user data present on a drive meant to ship empty: ${path}${path.startsWith('updates/') ? STARTED_DRIVE : ''}`)
  }
  for (const path of userData.unreadable) {
    problems.push(`user data unreadable on a drive meant to ship empty: ${path}`)
  }

  // --- Root license/attribution artifacts present + non-empty (LIC-1, 2026-07-12b) ---
  // A sold drive ships MIT binaries (llama.cpp/whisper.cpp — the notice must accompany
  // copies), Apache-2.0 weights/traineddata (every approved review note records "ship the
  // LICENSE/NOTICE attribution with the drive"), and the GPL app itself — all discharged
  // by the three root files prepare-drive copies. Missing OR empty fails the sell gate.
  let licenseArtifactsPresent = true
  for (const rel of DRIVE_LICENSE_ARTIFACTS) {
    let present = false
    try {
      const p = join(rootPath, rel)
      present = existsSync(p) && statSync(p).size > 0
    } catch {
      present = false
    }
    if (!present) {
      licenseArtifactsPresent = false
      problems.push(
        `license/attribution artifact missing or empty at the drive root: ${rel} — ` +
          're-run prepare-drive (it copies LICENSE + THIRD-PARTY-NOTICES.md + DRIVE-NOTICES.md)'
      )
    }
  }

  // --- Runtime install markers match the yaml pin (opt-in) ---
  // The marker is what fetch-runtime writes after a verified extraction; a missing or
  // stale marker means the drive carries the wrong sidecar build (e.g. a CPU-era build
  // after the default moved to vulkan) and must be re-provisioned. The same
  // check runs for the whisper family (binary `whisper-cli`) when its pin is passed.
  let runtimeCurrent = true
  let runtimeHashed = true
  let optionalRuntimesConsistent = true
  let kiwixSourceBundle = true
  // ONE family list, ONE code path (#339 P8-1): the two grandfathered positionals first, then
  // every family the caller passes by name. The CODE spec (`SIDECAR_FAMILY_SPECS`) supplies the
  // required file set — the same one the installer produced — and decides required vs optional.
  const families: Array<{ sources: RuntimeSources; label: string; spec: SidecarFamilySpec }> = []
  const addFamily = (family: RuntimeFamily, sources: RuntimeSources | null | undefined, label: string): void => {
    if (!sources || families.some((f) => f.spec.family === family)) return
    const spec = sidecarFamilySpec(family)
    if (!spec) {
      runtimeCurrent = false
      problems.push(`${label}: unknown runtime family "${family}" — the app cannot verify what it cannot spawn`)
      return
    }
    families.push({ sources, label, spec })
  }
  addFamily('llama_cpp', runtimeSources, 'runtime')
  addFamily('whisper_cpp', whisperSources, 'whisper')
  for (const [family, sources] of Object.entries(opts?.families ?? {})) {
    addFamily(family as RuntimeFamily, sources, family)
  }

  const checkFamily = async ({ sources, label: familyLabel, spec }: (typeof families)[number]): Promise<void> => {
    const optional = spec.optional === true
    const fail = (kind: 'current' | 'hashed', message: string): void => {
      problems.push(message)
      if (optional) optionalRuntimesConsistent = false
      else if (kind === 'current') runtimeCurrent = false
      else runtimeHashed = false
    }
    // Group the builds by extract dir: the two macOS kiwix_tools builds share ONE dir, and a
    // host installs one of them — each dir is checked once, against the build the marker's
    // `arch` names (else the first). Every llama / whisper build is its own group, so their
    // checks are byte-identical to before.
    const groups = new Map<string, RuntimeBuild[]>()
    for (const build of sources.builds) {
      const list = groups.get(build.extractTo) ?? []
      list.push(build)
      groups.set(build.extractTo, list)
    }
    /** Every other group's install dir (absolute) — a nested one is that build's to report. */
    const allExtractDirs = [...groups.keys()].map((d) => join(rootPath, ...d.split('/')))
    const otherExtractDirs = (own: string): string[] => allExtractDirs.filter((d) => resolve(d) !== resolve(own))
    for (const builds of groups.values()) {
      // planRuntimeDownload escape-guards extract_to (the yaml on the DRIVE is
      // user-writable) — a tampered path is a failed check, not a crash.
      const plans: Array<{ build: RuntimeBuild; plan: RuntimeDownloadPlan }> = []
      let planFailed = false
      for (const build of builds) {
        try {
          plans.push({
            build,
            plan: planRuntimeDownload(rootPath, build, sources.version, spec.binaryBase, {
              alsoRequired: spec.alsoRequired,
              declaredExecutables: sources.executables,
              neverInstalled: spec.neverInstalled
            })
          })
        } catch (err) {
          fail('current', `${familyLabel} build ${build.os}/${build.arch} ${build.backend}: ${err instanceof Error ? err.message : String(err)}`)
          planFailed = true
        }
      }
      if (planFailed || plans.length === 0) continue
      // #1028: which of the three a marker that is no marker is — not there, not readable just now, or there but
      // damaged (cut short, garbled) — so the builder is told which, and only a marker that is not there makes an
      // optional family absent.
      const markerState = readRuntimeMarkerState(plans[0]!.plan.extractTo)
      const marker = markerState.kind === 'marker' ? markerState.marker : null
      const { build, plan } = plans.find((p) => marker !== null && p.build.arch === marker.arch) ?? plans[0]!
      const label = `${familyLabel} build ${build.os}/${build.arch} ${build.backend}`
      // #986: an engine install interrupted on this drive leaves `<extract_to>.new` / `.old` beside the
      // install (the app's next start on that OS finishes or rolls back the swap). A Kit must not ship one:
      // it is a second engine copy no check below looks at. Exact names only, as the app's recovery.
      for (const leftover of engineSwapLeftovers(rootPath, plan.extractTo)) {
        fail(
          'current',
          `${label}: ${leftover} is left from an interrupted engine install — start the app on this ` +
            'drive once (it finishes or rolls back the swap) or delete the folder'
        )
      }
      // #729: an executable the family never keeps (`llama-connect`, the `--connect` tunnel) must not
      // ship, wherever it landed under the install dir: an install made before the installers left it
      // out, or a hand-copied one, would convey a program no licence record covers. The other builds'
      // own dirs (the `cpu/` net under `<os>/`) report for themselves.
      const stray = findNeverInstalledFiles(plan.extractTo, spec.neverInstalled ?? [], otherExtractDirs(plan.extractTo))
      if (stray.length > 0) {
        fail('current', `${label}: ${stray.join(', ')} under ${build.extractTo} must not ship — re-run fetch-runtime for this build`)
      }
      const required = requiredInstallFiles(plan)
      const present = required.filter((p) => existsSync(p) && statSync(p).isFile())
      // An optional family that is ENTIRELY absent — no marker, none of its files — is not a
      // defect: a Kit may deliberately ship without the knowledge-pack tools. (#1028: a damaged
      // marker left behind is no absent family.)
      if (optional && markerState.kind === 'absent' && present.length === 0) continue
      if (optional && markerState.kind === 'damaged' && present.length === 0) {
        // #1028 review round 2 (L-7): only a leftover marker, none of the family's files — say which way out fits.
        fail(
          'current',
          `${label}: ${build.extractTo} holds only a damaged .hilbertraum-runtime.json install marker — for a Kit ` +
            'without this family, delete the leftover marker; else re-run fetch-runtime for this build'
        )
        continue
      }
      if (optional && markerState.kind === 'unreadable' && present.length === 0) {
        // #1028 code review (CR-3): a marker that cannot be read just now, and none of the family's files: the read
        // failed, which no missing binary explains.
        fail('current', unreadableMarkerLine(label, build.extractTo, markerState.code))
        continue
      }
      const missing = required.filter((p) => !present.includes(p))
      // A marker alone is not an install: every declared file must exist too (mirrors
      // runtimeInstallCurrent — a half-deleted or half-installed family must fail the gate).
      if (missing.length > 0) {
        const names = missing.map((p) => basename(p))
        fail(
          'current',
          missing.length === 1 && missing[0] === plan.binaryPath
            ? `${label}: ${spec.binaryBase} binary missing under ${build.extractTo} — run fetch-runtime for this build`
            : `${label}: missing under ${build.extractTo}: ${names.join(', ')} — run fetch-runtime for this build`
        )
        continue
      }
      if (!marker) {
        fail(
          'current',
          markerState.kind === 'damaged'
            ? `${label}: the .hilbertraum-runtime.json install marker under ${build.extractTo} is cut short or ` +
                'damaged — re-run fetch-runtime for this build; if it reports the engine already installed, delete ' +
                'the engine folder first'
            : markerState.kind === 'unreadable'
              ? unreadableMarkerLine(label, build.extractTo, markerState.code)
              : `${label}: no .hilbertraum-runtime.json ` +
                `install marker under ${build.extractTo} — run fetch-runtime for this build`
        )
        continue
      }
      if (marker.version !== sources.version || marker.backend !== build.backend) {
        fail(
          'current',
          `${label}: installed ` +
            `${marker.version}/${marker.backend} does not match the pinned ` +
            `${sources.version}/${build.backend} — re-run fetch-runtime`
        )
        continue
      }
      // Version + backend match — now require the marker to carry EVERY file's SHA-256 and
      // each to MATCH the on-disk bytes (#234). A sold drive must ship these hashes so the app
      // can re-verify each executable before spawn; a hashless marker (an older fetch-runtime,
      // or an unverified archive) fails the gate and must be re-fetched.
      for (const p of required) {
        const name = basename(p)
        const expected = marker.binaries?.[markerBinaryKey(plan.extractTo, p)]
        if (!expected) {
          fail(
            'hashed',
            `${label}: install marker records no SHA-256 for ${name} — re-run ` +
              'fetch-runtime --commercial so the binary can be re-verified before spawn'
          )
        } else if ((await sha256File(p)).toLowerCase() !== expected.toLowerCase()) {
          fail(
            'hashed',
            `${label}: ${name} does not match the SHA-256 recorded in the install ` +
              'marker — the binary or the marker was modified after install; re-run fetch-runtime --commercial'
          )
        }
      }
      // #998: every further file the copy's own marker records (installs since #998 record every file the
      // archive put there: the DLLs and the backends loaded at run time) must still be there, inside the
      // install folder, with the bytes recorded. What is recorded is verified here; T3.8's walk below fails a
      // file the map leaves out. A key under another build's own folder (the `cpu/` net under `<os>/`) is that
      // build's to report.
      const requiredKeys = new Set(required.map((p) => markerBinaryKey(plan.extractTo, p)))
      const nested = otherExtractDirs(plan.extractTo).map((d) => resolve(d))
      for (const [key, expected] of Object.entries(marker.binaries ?? {})) {
        if (requiredKeys.has(key)) continue
        const file = recordedFilePath(plan.extractTo, key)
        if (file === null) {
          fail('hashed', `${label}: the install marker records ${key}, which is not inside ${build.extractTo} — re-run fetch-runtime --commercial`)
          continue
        }
        if (nested.some((d) => file === d || file.startsWith(`${d}${sep}`))) continue
        let isFile = false
        try {
          isFile = statSync(file).isFile()
        } catch {
          isFile = false
        }
        if (!isFile) {
          fail('hashed', `${label}: ${key} is recorded in the install marker but missing under ${build.extractTo} — re-run fetch-runtime --commercial`)
        } else if ((await sha256File(file)).toLowerCase() !== expected.toLowerCase()) {
          fail(
            'hashed',
            `${label}: ${key} does not match the SHA-256 recorded in the install marker — the file or the ` +
              'marker was modified after install; re-run fetch-runtime --commercial'
          )
        }
      }
      // T3.8 (W-33; T3.12 review 1 M-2, Δ-61): and every file in the folder is in the map (`unrecordedEngineFiles`: the
      // walk an install records), so a library copied in by hand, or left from a killed download, never ships unseen by
      // the pre-spawn check. Only over a map that hashes every required file: a map without one has its own line above,
      // never also a list of the folder. fetch-runtime --commercial skips a copy whose map hashes the required files
      // (the T3.8 sheet F1), so the way out is deleting, never a re-run.
      if (required.every((p) => marker.binaries?.[markerBinaryKey(plan.extractTo, p)])) {
        const walk = unrecordedEngineFiles(plan.extractTo, marker.binaries ?? {}, otherExtractDirs(plan.extractTo), stray)
        for (const folder of walk.unlistable) {
          fail(
            'hashed',
            `${label}: ${build.extractTo}/${folder.rel ? `${folder.rel}/` : ''} could not be listed (${folder.code ?? 'read failed'}) — ` +
              'check the drive, then run the gate again'
          )
        }
        const names = walk.unrecorded
        if (names.length > 0) {
          const counted = names.length === 1 ? `1 file under ${build.extractTo} is` : `${names.length} files under ${build.extractTo} are`
          const listed = names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '')
          fail(
            'hashed',
            `${label}: ${counted} not recorded in the install marker: ${listed} — delete what does not belong to the ` +
              `engine; for an engine installed by an older fetch-runtime, delete ${build.extractTo} and run ` +
              'build-commercial-drive again (fetch-runtime skips an engine it finds installed)'
          )
        }
      }
    }
  }

  /**
   * The corresponding-source bundle of a COPYLEFT family (#339 P8-4, owner ruling
   * 2026-09-06). Invariant: no executable of the family on the drive ⇒ not applicable ⇒ pass,
   * and nothing under the bundle dir is even read. Presence is FILE-based, never marker-based —
   * a hand-placed, marker-less bundle conveys the binaries just the same — and counts only the
   * executables (`plan.binaryPaths`): a stray ICU DLL is not "shipping kiwix-tools". With a
   * binary present the yaml must declare the bundle, the directory must exist, every pinned
   * archive must be there with a matching SHA-256, and a non-empty SOURCES.md must sit beside
   * them. Extra files in the directory are neither a failure nor a warning: the duty is "the
   * source is there", and `source/` is on no spawn or launcher path. One cause, one message.
   */
  const checkSourceBundle = async ({ sources, label: familyLabel, spec }: (typeof families)[number]): Promise<void> => {
    const L = `${familyLabel} source bundle`
    const fail = (message: string): void => {
      problems.push(message)
      kiwixSourceBundle = false
    }
    let present = false
    for (const build of sources.builds) {
      let plan: RuntimeDownloadPlan
      try {
        plan = planRuntimeDownload(rootPath, build, sources.version, spec.binaryBase, {
          alsoRequired: spec.alsoRequired,
          declaredExecutables: sources.executables,
          neverInstalled: spec.neverInstalled
        })
      } catch {
        continue // checkFamily already reported the tampered path
      }
      if (plan.binaryPaths.some((p) => existsSync(p) && statSync(p).isFile())) {
        present = true
        break
      }
    }
    if (!present) return
    const bundle = sources.sourceBundle
    if (!bundle) {
      if (spec.family !== 'kiwix_tools') return // no copyleft duty is declared for this family
      fail(
        `${L}: the drive's runtime-sources.yaml declares no source_bundle for ${familyLabel} while its ` +
          'binaries are on this drive — a Kit that conveys these copyleft binaries must pin their ' +
          'complete corresponding source; re-run prepare-drive to copy the current manifests, or ship no kiwix-tools'
      )
      return
    }
    const dir = join(rootPath, ...bundle.dir.split('/'))
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      fail(
        `${L}: ${bundle.dir}/ is missing while ${familyLabel} binaries are on this drive — a preloaded ` +
          'Kit conveying these copyleft binaries must carry their complete corresponding source; run ' +
          'build-commercial-drive with --kiwix-source-dir <archive dir>, or ship no kiwix-tools'
      )
      return
    }
    for (const file of bundle.files) {
      const p = join(dir, file.name)
      if (!existsSync(p) || !statSync(p).isFile()) {
        fail(
          `${L}: ${file.name} missing from ${bundle.dir}/ — re-run build-commercial-drive with ` +
            '--kiwix-source-dir <archive dir> (it copies and re-verifies every pinned archive)'
        )
      } else if ((await sha256File(p)).toLowerCase() !== file.sha256.toLowerCase()) {
        fail(
          `${L}: ${file.name} does not match the SHA-256 pinned in runtime-sources.yaml — the archive was ` +
            'modified or is the wrong release; re-copy it from the pinned upstream URL'
        )
      }
    }
    const record = join(dir, 'SOURCES.md')
    if (!existsSync(record) || !statSync(record).isFile() || statSync(record).size === 0) {
      fail(
        `${L}: SOURCES.md missing or empty in ${bundle.dir}/ — regenerate the bundle with ` +
          'scripts/install-kiwix-source-bundle.mjs (it records each component, version, grant, SHA-256 and upstream URL)'
      )
    }
  }
  for (const family of families) {
    await checkFamily(family)
    await checkSourceBundle(family)
  }

  // --- OCR language files present + verified (opt-in) ---
  // Plain files: the hash IS the install state (no marker — mirrors planOcrDownloads).
  let ocrAssetsVerified = true
  if (ocrSources) {
    const ocrTasks = await planOcrDownloads(rootPath, ocrSources)
    for (const t of ocrTasks) {
      if (t.status !== 'present-verified') {
        ocrAssetsVerified = false
        problems.push(
          `ocr file "${t.lang}" is not present+verified (${t.relPath}; status: ${t.status}) — ` +
            'run fetch-runtime --family ocr'
        )
      }
    }
  }

  // --- App skills provisioned + user-skills empty (skills plan S9 / §7.3, §14) ---
  // A sellable drive ships trusted PRODUCT skills under app-skills/ (e.g. the bank-statement
  // stub) and NO user skills — user-skills/ is the read-write area a buyer fills, so it must be
  // empty at ship time (the same "ships empty" rule as workspace/). Trust of app-skills/ is by
  // LOCATION on a writable drive, not a signature — the accepted §22-M2 residual (documented in
  // security-model.md / known-limitations.md), the same residual as the engine binary.
  const appSkillsPresent = listSkillFolders(join(rootPath, 'app-skills')).length > 0
  if (!appSkillsPresent) {
    problems.push(
      'no app skills provisioned (a sold drive ships trusted product skills under app-skills/)'
    )
  }
  let userSkillsEmpty = true
  try {
    const userDir = join(rootPath, 'user-skills')
    const userEntries = existsSync(userDir) ? readdirSync(userDir) : []
    if (userEntries.length > 0) {
      userSkillsEmpty = false
      for (const name of userEntries) {
        problems.push(`user skill present on a drive meant to ship empty: user-skills/${name}`)
      }
    }
  } catch {
    /* unreadable → treat as empty; the policy/weight/app-skill gates still apply */
  }

  // --- App artifact + launcher per declared platform (#233) ---
  // A kit is sold for a declared set of platforms; each needs exactly one release
  // artifact of the version being built and its launcher at the drive root. An artifact
  // of an undeclared platform, an unrecognised name, or a second artifact of one platform
  // (an older build beside the new one) fails the drive.
  let platformMatrixDeclared = true
  const declared: KitPlatform[] = []
  if (!opts || !Array.isArray(opts.platforms) || opts.platforms.length === 0) {
    platformMatrixDeclared = false
    problems.push(
      `no platform matrix declared — name the platforms this kit is sold for (${KIT_PLATFORMS.join(', ')}); ` +
        'the app artifacts and launchers cannot be checked without it'
    )
  } else {
    for (const p of opts.platforms) {
      if (!isKitPlatform(p)) {
        platformMatrixDeclared = false
        problems.push(`unknown platform "${String(p)}" (known: ${KIT_PLATFORMS.join(', ')})`)
      } else if (declared.includes(p)) {
        platformMatrixDeclared = false
        problems.push(`platform "${p}" declared more than once`)
      } else {
        declared.push(p)
      }
    }
    if (typeof opts.appVersion !== 'string' || opts.appVersion.trim() === '') {
      platformMatrixDeclared = false
      problems.push('no app version declared — the app artifacts cannot be checked without it')
    }
  }
  let appArtifactsPresent = false
  let launchersPresent = false
  if (platformMatrixDeclared) {
    appArtifactsPresent = true
    launchersPresent = true
    const version = opts!.appVersion.trim()
    const found = scanAppArtifacts(rootPath)
    for (const a of found) {
      if (a.isDir) {
        // T3.8 (owner 2026-11-26, the T3.8 sheet Q1; reverses #233's earlier acceptance, which predates the record): a
        // Kit carries the macOS app as its zip (exFAT cannot hold the bundle's links; the start file unpacks it). A
        // folder carries no version, so the record cannot name it and the signed payload cannot verify it.
        appArtifactsPresent = false
        problems.push(
          `app artifact "${a.name}" is an extracted app folder — a Kit carries ${KIT_PLATFORM_SPECS['mac-arm64'].artifact(version)} ` +
            `(the start file unpacks it): replace the folder by the zip, then write the record again: ${WRITE_RECORD}`
        )
      }
      if (a.platform === null) {
        appArtifactsPresent = false
        problems.push(
          `app artifact "${a.name}" is not a release artifact of any platform (expected ` +
            `${KIT_PLATFORMS.map((p) => KIT_PLATFORM_SPECS[p].artifact('<version>')).join(', ')})`
        )
      } else if (!declared.includes(a.platform)) {
        appArtifactsPresent = false
        problems.push(
          `app artifact "${a.name}" is for ${a.platform}, a platform this kit is not declared for ` +
            `(declared: ${declared.join(', ')}) — remove it or declare the platform`
        )
      }
      if (a.platform !== null && a.readOnly) {
        // W-33 (Δ-37, T1.11 P3-3): release 1's Windows start file tells a running app by opening it for writing
        // (docs/app-updates.md §5.6), so a read-only app reads "in flight" at every start: the launch counter never
        // counts and a broken new version never falls back. prepare-drive refuses the same.
        appArtifactsPresent = false
        problems.push(
          `app artifact "${a.name}" is read-only — clear the read-only attribute (attrib -r on Windows, chmod u+w on ` +
            "macOS or Linux): with it set, release 1's start file reads the app as running at every start, and its " +
            'launch counter never counts'
        )
      }
    }
    for (const p of declared) {
      const spec = KIT_PLATFORM_SPECS[p]
      const mine = found.filter((a) => a.platform === p)
      if (mine.length === 0) {
        appArtifactsPresent = false
        problems.push(`${p}: no app artifact at the drive root (expected ${spec.artifact(version)})`)
      } else if (mine.length > 1) {
        appArtifactsPresent = false
        problems.push(
          `${p}: more than one app artifact at the drive root (${mine.map((a) => a.name).join(', ')}) — ` +
            'a drive must carry exactly one; delete the others'
        )
      } else if (!mine[0].isDir) {
        // A folder has its own line above.
        const a = mine[0]
        if (a.size === 0) {
          appArtifactsPresent = false
          problems.push(`${p}: app artifact "${a.name}" is zero bytes`)
        }
        if (a.version === null) {
          appArtifactsPresent = false
          problems.push(`${p}: app artifact "${a.name}" carries no version in its name (expected ${spec.artifact(version)})`)
        } else if (a.version !== version) {
          appArtifactsPresent = false
          problems.push(`${p}: app artifact "${a.name}" is version ${a.version}, the kit is being built as ${version}`)
        }
      }
      let launcherOk = false
      try {
        const lp = join(rootPath, spec.launcher)
        launcherOk = existsSync(lp) && statSync(lp).size > 0
      } catch {
        launcherOk = false
      }
      if (!launcherOk) {
        launchersPresent = false
        problems.push(`${p}: launcher "${spec.launcher}" missing or empty at the drive root — re-run build-commercial-drive`)
      }
    }
  }

  // --- The release record and the support end (T3.8: W-33's M1 half, W-20, W-17) ---
  // After the apps, which the record's lines refer to, and whether or not a platform matrix was declared.
  const recordProblem = releaseRecordProblem(rootPath)
  if (recordProblem !== null) problems.push(recordProblem)
  const stampProblem = supportEndProblem(rootPath)
  if (stampProblem !== null) problems.push(stampProblem)

  return {
    ok: problems.length === 0,
    problems,
    checks: {
      policyCommercial,
      networkDenied,
      kitUpdatesKey,
      weightsVerified,
      licensesApproved,
      noUserData,
      runtimeCurrent,
      runtimeHashed,
      optionalRuntimesConsistent,
      kiwixSourceBundle,
      ocrAssetsVerified,
      appSkillsPresent,
      userSkillsEmpty,
      licenseArtifactsPresent,
      platformMatrixDeclared,
      appArtifactsPresent,
      launchersPresent,
      releaseRecordCurrent: recordProblem === null,
      supportEndStamped: stampProblem === null
    },
    modelResults
  }
}
