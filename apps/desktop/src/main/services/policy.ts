import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  NetworkPolicy,
  ModelsPolicy,
  PrivacyPolicy,
  PolicyStatus,
  WorkspacePolicy
} from '../../shared/types'

// Privacy / offline policy loader (spec §3.5, §3.6, §6, §7.10).
//
// Reads `config/policy.json` and `config/drive.json` (both OPTIONAL — developer
// runs fall back to defaults) and merges them over DEFAULT_POLICY, where **update
// checks and telemetry are off** and model downloads are policy-permitted but gated
// behind the default-off user setting plus a per-download confirmation
// (architecture.md "In-app model downloader"). The module is pure + resilient: a
// missing or malformed file degrades to safe defaults plus a warning, never a throw.
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
 * `policy.json` that writes `allow_model_downloads: false` (the commercial prepare-drive
 * posture) restricts this unconditionally — policy only restricts, never expands. Workspace/model
 * defaults are developer-friendly (dev with no policy file: plaintext workspace +
 * unverified models allowed) — a commercial `policy.json` tightens these.
 */
export const DEFAULT_POLICY: PrivacyPolicy = {
  network: {
    allowModelDownloads: true,
    allowUpdateChecks: false,
    allowTelemetry: false
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
    allowTelemetry: false
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
export function mergePolicyObject(base: PrivacyPolicy, raw: unknown): PrivacyPolicy {
  const obj = asObject(raw)
  const net = asObject(obj.network)
  const ws = asObject(obj.workspace)
  const models = asObject(obj.models)

  const network: NetworkPolicy = {
    allowModelDownloads: bool(net.allow_model_downloads, base.network.allowModelDownloads),
    allowUpdateChecks: bool(net.allow_update_checks, base.network.allowUpdateChecks),
    allowTelemetry: bool(net.allow_telemetry, base.network.allowTelemetry)
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
   * false`) fails CLOSED to `STRICT_POLICY` when `policy.json` is missing/malformed (M-4);
   * a dev build keeps the permissive `DEFAULT_POLICY`. Defaults to `true` (dev) so the
   * canonical reference + unit callers that do not pass it keep the historical behaviour;
   * the production call sites pass the real value.
   */
  isDev?: boolean
}

/** The base/fallback policy for a build type: strict when packaged, dev-friendly in dev. */
export function basePolicyFor(opts: PolicyLoadOptions = {}): PrivacyPolicy {
  return opts.isDev === false ? STRICT_POLICY : DEFAULT_POLICY
}

export interface LoadedPolicy {
  policy: PrivacyPolicy
  policyFilePresent: boolean
  driveFilePresent: boolean
  /** drive.json `allow_network_by_default` (informational; default false). */
  allowNetworkByDefault: boolean
}

/**
 * Load + merge the policy from a config directory. Both `policy.json` and `drive.json`
 * are optional; either being absent or malformed falls back to safe defaults. Pure with
 * respect to its inputs aside from reading those two files; never throws.
 */
export function loadPolicy(
  configDir: string,
  onWarn?: (msg: string) => void,
  opts: PolicyLoadOptions = {}
): LoadedPolicy {
  // Fail-closed base for a packaged build (M-4): a missing/malformed/unreadable
  // policy.json degrades to STRICT_POLICY, not the dev-friendly DEFAULT_POLICY.
  const base = basePolicyFor(opts)
  let policy = base
  let policyFilePresent = false
  let driveFilePresent = false
  let allowNetworkByDefault = false

  const policyPath = join(configDir, 'policy.json')
  if (existsSync(policyPath)) {
    try {
      policy = parsePolicy(readFileSync(policyPath, 'utf8'), onWarn, base)
      policyFilePresent = true
    } catch (err) {
      onWarn?.(`Could not read policy.json (${err instanceof Error ? err.message : String(err)})`)
      // An unreadable file is treated like a malformed one — keep the (possibly strict) base.
      policy = base
    }
  }

  const drivePath = join(configDir, 'drive.json')
  if (existsSync(drivePath)) {
    try {
      const drive = asObject(JSON.parse(readFileSync(drivePath, 'utf8')))
      allowNetworkByDefault = bool(drive.allow_network_by_default, false)
      driveFilePresent = true
    } catch (err) {
      onWarn?.(`Ignoring malformed drive.json (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  return { policy, policyFilePresent, driveFilePresent, allowNetworkByDefault }
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
  }
}
