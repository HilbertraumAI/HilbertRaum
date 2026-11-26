import { readFileSync, existsSync, statSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db'
import { getSettings } from './settings'
import { compareSemver, parseSemver, type Semver } from './updates/version'
import type {
  NetworkPolicy,
  ModelsPolicy,
  PrivacyPolicy,
  PolicyStatus,
  WorkspacePolicy
} from '../../shared/types'

// Privacy / offline policy loader (spec §3.5, §3.6, §6, §7.10) and the update policy reader (F-8).
// Two readers of `config/policy.json`, whose answers for a missing or damaged file differ on purpose.
//
// `loadPolicy` reads `config/policy.json` and `config/drive.json` (both OPTIONAL — developer
// runs fall back to defaults) and merges them over DEFAULT_POLICY, where **update
// checks and telemetry are off** and model downloads are policy-permitted but gated
// behind the user's `allowNetwork` setting (default ON) plus a per-download confirmation
// (architecture.md "In-app model downloader"). It is pure + resilient and FAIL-SAFE: a
// missing or malformed file degrades to safe defaults plus a warning, never a throw, and
// on a provisioned drive a packaged build's defaults are STRICT_POLICY (M-4).
//
// `readUpdatePolicy` (after loadPolicy, below) reads the `updates` keys that decide whether a
// signed update may be installed. A missing or damaged file keeps the install ALLOWED and is
// reported as "unreadable" ("none" on a root that never had one), with no warning (G-14's
// exception; docs/app-updates.md §8.1). The two differ because loadPolicy's keys guard model
// integrity and the network ceiling, which a lost file must never loosen, while an `updates`
// block is a management control, not a security boundary: a damaged policy must never block
// the signed repair.
//
// Policy precedence (LOCKED): a (future signed) policy.json is AUTHORITATIVE — it can
// only RESTRICT, never expand, what the user setting permits. The effective network
// permission is therefore `policyCeiling ∧ userSetting`: a policy that forbids network
// keeps the app offline even if the user toggles the setting on; the toggle can only
// enable what the policy already allows. Telemetry is always off (no toggle).

/**
 * Default policy. **Update checks + telemetry are off and have no user toggle.**
 * `allowModelDownloads` is true: with no policy file the spec §3.6 user Settings toggle
 * ("Allow internet access for model downloads…") is the effective gate for the in-app
 * downloader. That toggle now defaults ON (DEFAULT_SETTINGS.allowNetwork) so downloads work
 * out of the box, and every download still needs an explicit per-download confirmation. A
 * `policy.json` that writes `allow_model_downloads: false` (a drive builder's hand-edit —
 * `prepare-drive` writes `true` in BOTH its postures, full-audit 2026-07-10 DOC-101)
 * restricts this unconditionally — policy only restricts, never expands. Workspace/model
 * defaults are developer-friendly (dev with no policy file: plaintext workspace +
 * unverified models allowed) — a commercial `policy.json` tightens these.
 */
export const DEFAULT_POLICY: PrivacyPolicy = {
  network: {
    allowModelDownloads: true,
    allowUpdateChecks: false,
    allowTelemetry: false,
    // Local API: policy-permitted in dev (the setting is still default-off behind the
    // consent dialog — D3); a policy.json can write allow_local_api: false to kill it.
    allowLocalApi: true
  },
  workspace: {
    encryptionRequired: false,
    allowPlaintextDevMode: true
  },
  models: {
    allowUnverifiedModels: true,
    requireManifest: true,
    requireSha256Match: false
  }
}

/**
 * Strict commercial posture (security audit M-4 / M-6). A PACKAGED build with a
 * **missing or malformed** `policy.json` must fail CLOSED to this — not to the
 * dev-friendly `DEFAULT_POLICY` — so a corrupted/absent policy on a removable drive
 * cannot silently loosen model-integrity enforcement (it would otherwise let an
 * unverified weight run). Encryption is required, plaintext is off, models must verify,
 * and all network is denied. A real shipped drive still writes its own `policy.json`
 * (the prepare-drive commercial posture); this is only the safe fallback. The merge
 * still uses this as the base for a packaged build, so a partial/junk file leaves the
 * unspecified fields at the strict value rather than at the dev default.
 */
export const STRICT_POLICY: PrivacyPolicy = {
  network: {
    allowModelDownloads: false,
    allowUpdateChecks: false,
    allowTelemetry: false,
    // Fail closed with everything else: a provisioned drive that lost its policy must
    // not expose the model to other local processes.
    allowLocalApi: false
  },
  workspace: {
    encryptionRequired: true,
    allowPlaintextDevMode: false
  },
  models: {
    allowUnverifiedModels: false,
    requireManifest: true,
    requireSha256Match: true
  }
}

/**
 * Standalone-install posture (issue #93). A packaged build whose config dir carries
 * NEITHER `policy.json` NOR the prepared-drive marker `drive.json` is not a drive that
 * lost its policy — it is the app-data fallback root of a portable/GitHub-release install
 * that `prepare-drive` never touched, so there was never a policy to fail closed TO.
 * Failing closed there (`STRICT_POLICY`) permanently disabled the in-app downloader the
 * release notes point users to: the policy is the ceiling, so the Settings toggle could
 * never re-enable it. This posture relaxes ONLY the downloads ceiling — model downloads
 * are policy-permitted (still behind the `allowNetwork` setting + the per-download
 * confirmation, and every download is SHA-256-verified against its manifest); update
 * checks + telemetry stay off, and the workspace/models blocks stay at the STRICT value
 * (encryption required, no plaintext, no unverified weights) so M-4/M-6 model-integrity
 * enforcement is untouched.
 */
const STANDALONE_POLICY: PrivacyPolicy = {
  network: {
    allowModelDownloads: true,
    allowUpdateChecks: false,
    allowTelemetry: false,
    // O3 (owner-ratified 2026-08-18): a standalone install may enable the local API —
    // it is the user's own machine, the setting is default-off behind the consent
    // dialog, and without this the feature would be policy-dead on every
    // GitHub-release install (the policy is the ceiling; the toggle can't exceed it).
    allowLocalApi: true
  },
  workspace: STRICT_POLICY.workspace,
  models: STRICT_POLICY.models
}

/** Coerce an unknown JSON value to a boolean only when it is genuinely a boolean. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Merge a parsed (snake_case) `policy.json` object over a base policy. Every field is
 * taken from the file only when it is a real boolean; otherwise the base value wins, so
 * partial or junk files can only ever leave you at the safe default.
 */
function mergePolicyObject(base: PrivacyPolicy, raw: unknown): PrivacyPolicy {
  const obj = asObject(raw)
  const net = asObject(obj.network)
  const ws = asObject(obj.workspace)
  const models = asObject(obj.models)

  const network: NetworkPolicy = {
    allowModelDownloads: bool(net.allow_model_downloads, base.network.allowModelDownloads),
    allowUpdateChecks: bool(net.allow_update_checks, base.network.allowUpdateChecks),
    allowTelemetry: bool(net.allow_telemetry, base.network.allowTelemetry),
    // `allow_local_api` is NEWER than the drives already in the field. A `policy.json`
    // written before the local-API wave has no such key, and inheriting a packaged build's
    // STRICT base would have silently denied the feature on EVERY existing drive — a posture
    // nobody chose (owner decision 2026-08-18, verified against a real 2026-06-30 drive).
    // So the three cases are deliberately different:
    //   absent            → "not yet decided": inherit the permissive DEFAULT, like a
    //                       standalone install does. The setting is still default-off behind
    //                       the consent dialog, so this permits, it does not enable.
    //   explicit boolean  → that value wins (`prepare-drive` writes an explicit `false` for
    //                       commercial drives, so a deliberate deny is unaffected).
    //   present but junk  → the (possibly STRICT) base — garbage must never fail OPEN.
    // A malformed FILE never reaches here at all: `parsePolicy` returns the base for those,
    // so the M-4 fail-closed rule is unchanged.
    allowLocalApi:
      net.allow_local_api === undefined
        ? DEFAULT_POLICY.network.allowLocalApi
        : bool(net.allow_local_api, base.network.allowLocalApi)
  }
  const workspace: WorkspacePolicy = {
    encryptionRequired: bool(ws.encryption_required, base.workspace.encryptionRequired),
    allowPlaintextDevMode: bool(ws.allow_plaintext_dev_mode, base.workspace.allowPlaintextDevMode)
  }
  const modelsPolicy: ModelsPolicy = {
    allowUnverifiedModels: bool(models.allow_unverified_models, base.models.allowUnverifiedModels),
    requireManifest: bool(models.require_manifest, base.models.requireManifest),
    requireSha256Match: bool(models.require_sha256_match, base.models.requireSha256Match)
  }
  return { network, workspace, models: modelsPolicy }
}

/**
 * Parse a `policy.json` string into an effective policy (merged over `base`, default
 * `DEFAULT_POLICY`). Malformed JSON → `base` + an `onWarn` note; never throws. A packaged
 * build passes `STRICT_POLICY` as the base so a malformed file fails CLOSED (M-4).
 */
/**
 * The commercial posture in one predicate: encryption required, plaintext off, models
 * must verify. The sell gate (`assertCommercialDrive`) and the pre-spawn binary verifier
 * key on the same three fields (#234).
 */
export function isCommercialPolicy(policy: PrivacyPolicy): boolean {
  return (
    policy.workspace.encryptionRequired &&
    !policy.workspace.allowPlaintextDevMode &&
    policy.models.requireSha256Match
  )
}

export function parsePolicy(
  contents: string,
  onWarn?: (msg: string) => void,
  base: PrivacyPolicy = DEFAULT_POLICY
): PrivacyPolicy {
  try {
    return mergePolicyObject(base, JSON.parse(contents))
  } catch (err) {
    onWarn?.(`Ignoring malformed policy.json (${err instanceof Error ? err.message : String(err)})`)
    return base
  }
}

/** Options shared by the policy loaders. */
export interface PolicyLoadOptions {
  /**
   * Whether this is a developer build (`!app.isPackaged`). A packaged build (`isDev:
   * false`) fails CLOSED to `STRICT_POLICY` when a PROVISIONED config dir's `policy.json`
   * is missing/malformed (M-4); an unprovisioned dir (neither `policy.json` nor
   * `drive.json` — the standalone app-data fallback) gets `STANDALONE_POLICY` instead
   * (issue #93). A dev build keeps the permissive `DEFAULT_POLICY`. Defaults to `true`
   * (dev) so the canonical reference + unit callers that do not pass it keep the
   * historical behaviour; the production call sites pass the real value.
   */
  isDev?: boolean
}

/** The base/fallback policy for a build type: strict when packaged, dev-friendly in dev. */
function basePolicyFor(opts: PolicyLoadOptions = {}): PrivacyPolicy {
  return opts.isDev === false ? STRICT_POLICY : DEFAULT_POLICY
}

export interface LoadedPolicy {
  policy: PrivacyPolicy
  policyFilePresent: boolean
  driveFilePresent: boolean
  /** drive.json `allow_network_by_default` (informational; default false). */
  allowNetworkByDefault: boolean
}

// F-30 (audit 2026-07-16) — mtime/size-keyed cache for the parsed policy. `getAppStatus` and
// `getPolicy` call `buildPolicyStatus → loadPolicy` on every invocation, and `TranslateScreen` polls
// `getAppStatus` every 4 s for a whole (minutes-to-hours) translation — each call `readFileSync` +
// `JSON.parse`'d policy.json AND drive.json synchronously off the portable drive. This caches the
// merged result per config dir, keyed by each file's `(mtimeMs, size)` signature (plus `isDev`, which
// selects the fail-closed base): a `stat` per call replaces the two reads, and a re-read happens ONLY
// when a signature shows a change — so a live policy edit is still picked up (an admin tightening the
// policy is never masked), while the steady-state poll does no drive reads. A missing file is a
// distinct `absent` signature, so create/delete of either file invalidates too. Bounded: at most one
// entry per config dir (overwritten on change), and in the app there is exactly one config dir.
interface PolicyCacheEntry {
  sig: string
  loaded: LoadedPolicy
  /**
   * Warnings from this read that no caller has heard yet (#752). The read that fills the cache may
   * pass no `onWarn`, and every later reader hits the cache, so each warning is held for the first
   * reader that can hear it, and told once: the 4 s status poll must not repeat it in the log.
   */
  unheard: string[]
}
const policyCache = new Map<string, PolicyCacheEntry>()

function tellUnheard(entry: PolicyCacheEntry, onWarn?: (msg: string) => void): void {
  if (onWarn) entry.unheard.splice(0).forEach((msg) => onWarn(msg))
}

/** `(mtimeMs, size)` of a file, or `absent` if it is missing/unstatable (F-30 cache key part). */
function fileSignature(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'absent'
  }
}

/**
 * Load + merge the policy from a config directory. Both `policy.json` and `drive.json`
 * are optional; either being absent or malformed falls back to safe defaults. Pure with
 * respect to its inputs aside from reading those two files; never throws. The parsed result
 * is cached per config dir keyed by each file's mtime/size (F-30) — a live edit still re-reads.
 */
export function loadPolicy(
  configDir: string,
  onWarn?: (msg: string) => void,
  opts: PolicyLoadOptions = {}
): LoadedPolicy {
  const policyPath = join(configDir, 'policy.json')
  const drivePath = join(configDir, 'drive.json')
  const sig = `${opts.isDev === false ? 0 : 1}|${fileSignature(policyPath)}|${fileSignature(drivePath)}`
  const cached = policyCache.get(configDir)
  if (cached && cached.sig === sig) {
    tellUnheard(cached, onWarn)
    return cached.loaded
  }

  // Fail-closed base for a packaged build (M-4): a missing/malformed/unreadable
  // policy.json degrades to STRICT_POLICY, not the dev-friendly DEFAULT_POLICY.
  // M-4's scope is a PROVISIONED config dir — one carrying policy.json (even malformed;
  // the file is provisioning intent) or the prepared-drive marker drive.json (the same
  // file `findPreparedDriveRoot` keys off). A packaged build whose config dir has
  // NEITHER is the app-data fallback root of a standalone install and gets
  // STANDALONE_POLICY instead (issue #93) — downloads permitted, everything else strict.
  const provisioned = existsSync(policyPath) || existsSync(drivePath)
  const base = opts.isDev === false && !provisioned ? STANDALONE_POLICY : basePolicyFor(opts)
  let policy = base
  let policyFilePresent = false
  let driveFilePresent = false
  let allowNetworkByDefault = false
  const unheard: string[] = []

  if (existsSync(policyPath)) {
    try {
      policy = parsePolicy(readFileSync(policyPath, 'utf8'), (msg) => unheard.push(msg), base)
      policyFilePresent = true
    } catch (err) {
      unheard.push(`Could not read policy.json (${err instanceof Error ? err.message : String(err)})`)
      // An unreadable file is treated like a malformed one — keep the (possibly strict) base.
      policy = base
    }
  }

  if (existsSync(drivePath)) {
    try {
      const drive = asObject(JSON.parse(readFileSync(drivePath, 'utf8')))
      allowNetworkByDefault = bool(drive.allow_network_by_default, false)
      driveFilePresent = true
    } catch (err) {
      unheard.push(`Ignoring malformed drive.json (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  const loaded: LoadedPolicy = { policy, policyFilePresent, driveFilePresent, allowNetworkByDefault }
  const entry: PolicyCacheEntry = { sig, loaded, unheard }
  policyCache.set(configDir, entry)
  tellUnheard(entry, onWarn)
  return loaded
}

// ---- The update policy keys (F-8: frozen in release 1; docs/app-updates.md §8.1) ------------------------------------
//
// `updates.allow_user_install` and `updates.max_version` decide whether a signed update may be installed. Release 1 is
// the oldest version ever sold on a Kit and reads them for ever, so what an absent key, `true`, `false`, junk, a missing
// file and a damaged file mean can never change after it ships (the golden: tests/fixtures/readers/f8-policy/). They have
// their own reader, not a `PrivacyPolicy` field (P3 entry decision 6): their missing-file case is the opposite of
// loadPolicy's. A missing or damaged policy.json keeps the signed import ALLOWED (G-14: a blocked import is a management
// control, not a security boundary, and a damaged policy must not block the signed repair) and is shown as unreadable, so
// an admin's typo that lifted a block is visible; a junk VALUE, by contrast, blocks (an admin's edit, shown as invalid).
// `updates.allow_online_check` is a reserved name the Kit builders write `true`; release 1 reads no value of it, and
// nothing here or in loadPolicy, resolveNetwork or the status line ever ORs it into the network ceiling.

/** Whether the policy lets an update be installed: `managed` is `false` (UPD-POLICY-MANAGED), `invalid` junk (UPD-POLICY-INVALID). */
export type UpdateInstallPolicy = 'allowed' | 'managed' | 'invalid'

/** What became of policy.json: `none` on a root that never had one, `unreadable` when missing on a prepared drive or damaged (UPD-POLICY-UNREADABLE). */
export type UpdatePolicyFile = 'read' | 'none' | 'unreadable'

/** The update policy, as tokens only: no message, so nothing of the file can reach a log line (F-11). */
export interface UpdatePolicy {
  install: UpdateInstallPolicy
  /** The `updates.max_version` cap; `null` when there is none, and whenever `install` is not `allowed`. */
  maxVersion: Semver | null
  file: UpdatePolicyFile
}

/** The verdict for one update: `above-max` is a version above `updates.max_version` (UPD-ABOVE-MAX-VERSION). */
export type UpdateInstallVerdict = UpdateInstallPolicy | 'above-max'

/** A policy.json larger than this is never read whole, and reads as unreadable (O-4: the drive-release record's cap). */
const UPDATE_POLICY_MAX_BYTES = 1_048_576

/** Read only; on macOS and Linux also O_NONBLOCK, as the drive-release reader opens, so a named pipe put at the name
 *  after the stat opens at once (the descriptor check then refuses it) instead of waiting for a writer, and the main
 *  process with it (T3.7's review, F8-2). No O_NOFOLLOW: a link at the name is followed, as decided. Windows has no
 *  such flag: O_RDONLY alone is the `'r'` this reader opened with before. */
const UPDATE_POLICY_OPEN_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0))

/** The bytes of policy.json, `'missing'`, or `'damaged'` (a folder, a read error, over the cap). Follows a link, as loadPolicy does. */
function readUpdatePolicyBytes(policyPath: string): Buffer | 'missing' | 'damaged' {
  let fd: number
  try {
    // A stat before the open: opening a FIFO planted at the name would wait for a writer, and the main process with it.
    // One swapped in after the stat opens non-blocking on macOS and Linux and fails the descriptor check below.
    if (!statSync(policyPath).isFile()) return 'damaged'
    fd = openSync(policyPath, UPDATE_POLICY_OPEN_FLAGS)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'damaged'
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > UPDATE_POLICY_MAX_BYTES) return 'damaged'
    // One byte past the size the stat gave: a file that grew while it was read reads as damaged, and is never read whole.
    const buf = Buffer.alloc(st.size + 1)
    let length = 0
    for (let n = 1; n > 0 && length < buf.length; length += n) n = readSync(fd, buf, length, buf.length - length, null)
    return length === buf.length ? 'damaged' : buf.subarray(0, length)
  } catch {
    return 'damaged'
  } finally {
    try {
      closeSync(fd)
    } catch {
      // nothing to do: the verdict is already known
    }
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Read the update policy from `<configDir>/policy.json`, from the disk at every call (never through loadPolicy's F-30
 * cache: an admin's edit must count at the import, the hand-off and "Finish update" without a restart, even one that
 * keeps the file's size and mtime). Never throws, never logs, and returns tokens only.
 */
export function readUpdatePolicy(configDir: string): UpdatePolicy {
  const unreadable: UpdatePolicy = { install: 'allowed', maxVersion: null, file: 'unreadable' }
  const bytes = readUpdatePolicyBytes(join(configDir, 'policy.json'))
  if (bytes === 'missing') {
    // O-1: a prepared drive (drive.json there) lost its policy; a root with neither file never had one.
    return existsSync(join(configDir, 'drive.json')) ? unreadable : { install: 'allowed', maxVersion: null, file: 'none' }
  }
  if (bytes === 'damaged') return unreadable
  let doc: unknown
  try {
    // O-2: exactly one leading byte-order mark is skipped (Windows PowerShell 5.1 writes one); a second is not JSON.
    const text = bytes.toString('utf8')
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return unreadable
  }
  if (!isPlainObject(doc)) return unreadable // O-3: not a policy file
  const read = (install: UpdateInstallPolicy, maxVersion: Semver | null = null): UpdatePolicy => ({ install, maxVersion, file: 'read' })
  // Own keys only: JSON.parse keeps `__proto__` as an ordinary key, and no prototype may answer for a missing one.
  if (!Object.hasOwn(doc, 'updates')) return read('allowed')
  const updates = doc.updates
  if (!isPlainObject(updates)) return read('invalid') // a present `updates` that is not an object is junk
  // `false` blocks whatever else the block says (managed before invalid); any other non-boolean is junk and blocks too.
  // Never `bool(value, base)`: every base this key could have is "allowed", so junk would fail open.
  const allow = Object.hasOwn(updates, 'allow_user_install') ? updates.allow_user_install : true
  if (allow === false) return read('managed')
  if (allow !== true) return read('invalid')
  if (!Object.hasOwn(updates, 'max_version')) return read('allowed')
  const cap = parseSemver(updates.max_version)
  return cap === null ? read('invalid') : read('allowed', cap)
}

/**
 * The policy's verdict on an update of `version` (record §3.6 item 2): `managed` and `invalid` come before the version is
 * known; a cap allows versions up to it in SemVer 2.0.0 order, and a version that does not parse is above any cap (O-12).
 */
export function updateInstallVerdict(policy: UpdatePolicy, version: string): UpdateInstallVerdict {
  if (policy.install !== 'allowed') return policy.install
  if (policy.maxVersion === null) return 'allowed'
  const v = parseSemver(version)
  return v !== null && compareSemver(v, policy.maxVersion) <= 0 ? 'allowed' : 'above-max'
}

/**
 * Effective checksum leniency (spec §7.4): "developer" is the user toggle OR a dev build — but the drive POLICY is
 * authoritative and can only restrict. On a commercial drive (`require_sha256_match: true` /
 * `allow_unverified_models: false`) unverified weights are rejected no matter what the toggle says; this also disables
 * the chat mock fallback. One rule for every model role (#913): the chat start gate and the AI Model screen
 * (`registerModelIpc`), the images status (`vision/status.ts`) and the start check the other roles run before they
 * spawn (`main/index.ts`). The policy is read only for a developer: for anyone else the answer is no.
 */
export function developerLeniency(
  ctx: { paths: { configPath: string }; isDev: boolean },
  developerModeSetting: boolean
): boolean {
  if (!developerModeSetting && !ctx.isDev) return false
  const { policy } = loadPolicy(ctx.paths.configPath, undefined, { isDev: ctx.isDev })
  return policy.models.allowUnverifiedModels && !policy.models.requireSha256Match
}

export interface EffectiveNetwork {
  /** Does the policy permit ANY network (model downloads or update checks)? */
  networkAllowedByPolicy: boolean
  /** Effective permission = policy ceiling ∧ user setting. */
  networkAllowed: boolean
  /** `!networkAllowed`. */
  offlineMode: boolean
}

/**
 * Resolve the effective network permission. The policy is the ceiling; the user setting
 * is the switch. Network is allowed only when BOTH agree (spec §3.6 precedence rule).
 */
export function resolveNetwork(
  policy: PrivacyPolicy,
  allowNetworkSetting: boolean
): EffectiveNetwork {
  const networkAllowedByPolicy =
    policy.network.allowModelDownloads || policy.network.allowUpdateChecks
  const networkAllowed = networkAllowedByPolicy && allowNetworkSetting
  return { networkAllowedByPolicy, networkAllowed, offlineMode: !networkAllowed }
}

/**
 * Build the full `PolicyStatus` returned by the `getPolicy()` IPC. Combines the loaded
 * policy with the user's `allowNetwork` setting to derive the network flags the UI uses
 * to distinguish "off by choice" from "disabled by policy". Telemetry is always off.
 */
export function buildPolicyStatus(
  configDir: string,
  allowNetworkSetting: boolean,
  onWarn?: (msg: string) => void,
  opts: PolicyLoadOptions = {}
): PolicyStatus {
  const loaded = loadPolicy(configDir, onWarn, opts)
  const net = resolveNetwork(loaded.policy, allowNetworkSetting)
  return {
    policy: loaded.policy,
    policyFilePresent: loaded.policyFilePresent,
    driveFilePresent: loaded.driveFilePresent,
    allowNetworkSetting,
    networkAllowedByPolicy: net.networkAllowedByPolicy,
    networkAllowed: net.networkAllowed,
    offlineMode: net.offlineMode,
    telemetryAllowed: false
    // No localApiAllowedByPolicy copy field (review 2026-08-18): `PolicyStatus.policy`
    // already carries `network.allowLocalApi` — the Settings card reads it there. A 1:1
    // copy would let fixtures set the same fact twice, inconsistently.
  }
}

/** What `currentPolicyStatus` reads: the drive's config dir, the build, and the workspace. */
export interface PolicyStatusSources {
  paths: { configPath: string }
  isDev: boolean
  workspace: { isUnlocked(): boolean }
  /** The live workspace DB; read only while the workspace is unlocked. */
  readonly db: Db
}

/**
 * The effective network state right now, as the app reports it: the policy file read from disk
 * (the ceiling) ∧ the user's `allowNetwork` setting, with a locked workspace reading as off — its
 * setting is unreadable until the unlock. `getPolicy` returns it to the Privacy screen, and the
 * offline tripwire asks it at every remote connect (#758), so the tripwire records a connection
 * opened exactly while the app says it is offline (it sees sockets as they open, not each request on
 * a kept-alive one).
 */
export function currentPolicyStatus(src: PolicyStatusSources, onWarn?: (msg: string) => void): PolicyStatus {
  const allowNetwork = src.workspace.isUnlocked() ? getSettings(src.db).allowNetwork : false
  return buildPolicyStatus(src.paths.configPath, allowNetwork, onWarn, { isDev: src.isDev })
}

// localApiEffectivelyEnabled lives in shared/local-api.ts (review 2026-08-18): the
// renderer cannot import main services, so a main-side helper would have forced the P4
// Settings card to re-spell the policy∧setting rule by hand.
