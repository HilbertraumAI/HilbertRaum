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
// behind the default-off user setting plus a per-download confirmation (Phase 18,
// wave-1 decision D3 (architecture.md "In-app model downloader")). The module is pure + resilient: a missing or malformed file degrades
// to safe defaults plus a warning, never a throw.
//
// Policy precedence (LOCKED): a (future signed) policy.json is AUTHORITATIVE — it can
// only RESTRICT, never expand, what the user setting permits. The effective network
// permission is therefore `policyCeiling ∧ userSetting`: a policy that forbids network
// keeps the app offline even if the user toggles the setting on; the toggle can only
// enable what the policy already allows. Telemetry is always off (no toggle).

/**
 * Default policy. **Update checks + telemetry are off and have no user toggle.**
 * `allowModelDownloads` is true since Phase 18 (wave-1 decision D3 (architecture.md "In-app model downloader"), resolved (a)): with no
 * policy file the spec §3.6 user Settings toggle ("Allow internet access for model
 * downloads…", default OFF) is the effective gate for the in-app downloader — the app
 * still ships offline because the SETTING defaults to off and every download needs an
 * explicit per-download confirmation. A `policy.json` that writes
 * `allow_model_downloads: false` (the commercial prepare-drive posture) restricts this
 * unconditionally — policy only restricts, never expands. Workspace/model defaults are
 * developer-friendly (dev with no policy file: plaintext workspace + unverified models
 * allowed) — a commercial `policy.json` tightens these. Encryption enforcement is Phase 9.
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
 * Parse a `policy.json` string into an effective policy (merged over DEFAULT_POLICY).
 * Malformed JSON → DEFAULT_POLICY + an `onWarn` note; never throws.
 */
export function parsePolicy(contents: string, onWarn?: (msg: string) => void): PrivacyPolicy {
  try {
    return mergePolicyObject(DEFAULT_POLICY, JSON.parse(contents))
  } catch (err) {
    onWarn?.(`Ignoring malformed policy.json (${err instanceof Error ? err.message : String(err)})`)
    return DEFAULT_POLICY
  }
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
export function loadPolicy(configDir: string, onWarn?: (msg: string) => void): LoadedPolicy {
  let policy = DEFAULT_POLICY
  let policyFilePresent = false
  let driveFilePresent = false
  let allowNetworkByDefault = false

  const policyPath = join(configDir, 'policy.json')
  if (existsSync(policyPath)) {
    try {
      policy = parsePolicy(readFileSync(policyPath, 'utf8'), onWarn)
      policyFilePresent = true
    } catch (err) {
      onWarn?.(`Could not read policy.json (${err instanceof Error ? err.message : String(err)})`)
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
  onWarn?: (msg: string) => void
): PolicyStatus {
  const loaded = loadPolicy(configDir, onWarn)
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
