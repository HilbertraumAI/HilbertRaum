import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type { ModelManifest } from '../../shared/manifest'
import { isRealSha256 } from '../../shared/manifest'
import { sha256File, verifyChecksum, weightPath } from './models'

// Drive preparation logic (spec §6 / §12 — Phase 11).
//
// This module is the CANONICAL, unit-tested reference for what `prepare-drive` and
// `verify-models` do: which directories a prepared drive contains, the exact shape of
// the `config/{drive,policy,checksums}.json` files, and how a weight file is verified
// against its manifest. The `scripts/prepare-drive.{ps1,sh}` + `scripts/verify-models.
// {ps1,sh}` re-implement the SAME plan natively so a drive can be laid out on a fresh
// machine with no Node/npm (decision: drive-prep must not require a build). Keep the two
// in sync; this file is the source of truth and is exercised by `tests/integration/drive.test.ts`.
//
// LAY OUT WHAT THE CODE READS, not a parallel scheme: the directory names match
// `services/workspace.ts` (`resolvePaths`), the manifests live in a top-level
// `model-manifests/`, and the sidecar OS sub-dirs are `win`/`mac`/`linux` (the keys
// `services/runtime/sidecar.ts` `llamaOsDir` actually resolves — NOT windows/macos/linux).

/** Sidecar OS sub-directory keys under `runtime/llama.cpp/` — must match `llamaOsDir`. */
export const DRIVE_OS_DIRS = ['win', 'mac', 'linux'] as const

/** Drive layout format version stamped into `drive.json`. */
export const DRIVE_FORMAT_VERSION = 1

/**
 * The directory tree a prepared drive contains (relative to the drive root), in the
 * order they are created. `mkdir -p` makes intermediate dirs implicit, but listing the
 * leaves keeps the dry-run plan explicit + testable. These are exactly the dirs the app
 * reads (`workspace`, `models`, `model-manifests`, `runtime/llama.cpp/<os>`, `logs`,
 * `config`) plus `docs/` for the bundled user guide (spec §6).
 */
export const DRIVE_LAYOUT_DIRS: readonly string[] = [
  'workspace',
  'models/chat',
  'models/embeddings',
  'models/reranker',
  'models/transcriber',
  'model-manifests',
  ...DRIVE_OS_DIRS.map((os) => `runtime/llama.cpp/${os}`),
  // Second sidecar family (Phase 36): the whisper.cpp transcriber CLI. Upstream ships
  // a prebuilt Windows build only; the mac/linux dirs exist for the documented
  // source-build provisioning step (drive-layout.md).
  ...DRIVE_OS_DIRS.map((os) => `runtime/whisper.cpp/${os}`),
  'logs',
  'config',
  'docs'
]

/** Absolute directory paths to create for a prepared drive at `rootPath`. */
export function driveLayoutDirs(rootPath: string): string[] {
  return DRIVE_LAYOUT_DIRS.map((rel) => join(rootPath, ...rel.split('/')))
}

// ---- config/drive.json (the prepared-drive marker, spec §6) -----------------------

export interface DriveJson {
  product: string
  drive_format_version: number
  created_at: string
  edition: string
  offline_by_default: boolean
  models_dir: string
  workspace_dir: string
  allow_network_by_default: boolean
}

export interface DriveJsonOptions {
  createdAt?: string
  edition?: string
  /** drive.json `allow_network_by_default` (informational; loadPolicy reads it). */
  allowNetworkByDefault?: boolean
}

/** Build `config/drive.json` — the marker `resolvePaths` keys off (spec §6 example). */
export function buildDriveJson(opts: DriveJsonOptions = {}): DriveJson {
  return {
    product: 'Private AI Drive Lite',
    drive_format_version: DRIVE_FORMAT_VERSION,
    created_at: opts.createdAt ?? new Date().toISOString(),
    edition: opts.edition ?? 'lite',
    offline_by_default: true,
    models_dir: 'models',
    workspace_dir: 'workspace',
    allow_network_by_default: opts.allowNetworkByDefault ?? false
  }
}

// ---- config/policy.json (deny-by-default offline posture, spec §6) ----------------

export interface PolicyJson {
  network: {
    allow_model_downloads: boolean
    allow_update_checks: boolean
    allow_telemetry: boolean
  }
  workspace: {
    encryption_required: boolean
    allow_plaintext_dev_mode: boolean
  }
  models: {
    allow_unverified_models: boolean
    require_manifest: boolean
    require_sha256_match: boolean
  }
}

export interface PolicyJsonOptions {
  /**
   * `true` → a developer-friendly drive (plaintext workspace + unverified models
   * allowed). Default `false` → the commercial posture (spec §6 example): encryption
   * required, no plaintext, models must verify. Network stays OFF either way
   * (deny-by-default is the non-negotiable offline guarantee).
   */
  dev?: boolean
}

/**
 * Build `config/policy.json`. Network is ALWAYS denied by default (the offline
 * guarantee — `services/policy.ts` resolves effective network as policy ∧ user setting,
 * so this ceiling keeps the app offline). Workspace + model strictness depends on `dev`.
 * The snake_case shape is exactly what `parsePolicy`/`mergePolicyObject` accept.
 */
export function buildPolicyJson(opts: PolicyJsonOptions = {}): PolicyJson {
  const dev = opts.dev ?? false
  return {
    network: {
      allow_model_downloads: false,
      allow_update_checks: false,
      allow_telemetry: false
    },
    workspace: {
      encryption_required: !dev,
      allow_plaintext_dev_mode: dev
    },
    models: {
      allow_unverified_models: dev,
      require_manifest: true,
      require_sha256_match: !dev
    }
  }
}

// ---- config/checksums.json (per-weight expected hashes, from verify-models) -------

export type ModelVerifyStatus =
  | 'verified' // present + real expected hash + matches
  | 'unverified_placeholder' // present but the manifest carries REPLACE_WITH_REAL_HASH
  | 'mismatch' // present + real expected hash + does NOT match
  | 'missing' // weight file absent
  | 'unsupported' // runtime/format the app cannot load

export interface ModelVerifyResult {
  id: string
  localPath: string
  status: ModelVerifyStatus
  /** The manifest's expected SHA-256 (may be the placeholder). */
  expected: string
  /** The computed SHA-256 of the present file, or null when absent. */
  actual: string | null
  sizeBytes: number | null
}

const SUPPORTED_RUNTIMES = new Set(['llama_cpp', 'llama.cpp'])
const SUPPORTED_FORMATS = new Set(['gguf'])

/**
 * Verify each manifest's weight against its `sha256`, mirroring `services/models.ts`
 * `verifyChecksum`/`isRealSha256` so the script + the app agree. Honest reporting (no
 * developer-mode gate): a placeholder hash is `unverified_placeholder` (NOT a pass and
 * NOT a hard fail); a real-hash mismatch is `mismatch` (a fail).
 */
export async function verifyDriveModels(
  rootPath: string,
  manifests: ModelManifest[]
): Promise<ModelVerifyResult[]> {
  const out: ModelVerifyResult[] = []
  for (const manifest of manifests) {
    const path = weightPath(rootPath, manifest)
    if (!SUPPORTED_RUNTIMES.has(manifest.runtime) || !SUPPORTED_FORMATS.has(manifest.format)) {
      out.push({
        id: manifest.id,
        localPath: manifest.localPath,
        status: 'unsupported',
        expected: manifest.sha256,
        actual: null,
        sizeBytes: null
      })
      continue
    }
    const check = await verifyChecksum(path, manifest.sha256)
    let status: ModelVerifyStatus
    if (!check.exists) status = 'missing'
    else if (!isRealSha256(manifest.sha256)) status = 'unverified_placeholder'
    else status = check.matched ? 'verified' : 'mismatch'
    out.push({
      id: manifest.id,
      localPath: manifest.localPath,
      status,
      expected: manifest.sha256,
      actual: check.actual,
      sizeBytes: check.exists ? safeSize(path) : null
    })
  }
  return out
}

function safeSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

export interface ChecksumsJson {
  drive_format_version: number
  generated_at: string
  algorithm: 'sha256'
  entries: Array<{
    id: string
    local_path: string
    sha256: string | null
    size_bytes: number | null
    present: boolean
  }>
}

/**
 * Build `config/checksums.json` from the weights actually present on the drive (the
 * verify-models "generate" mode). Captures the real SHA-256 of each present weight so a
 * drive builder can record hashes once. Absent weights are recorded as `present:false`
 * with a null hash. This file is informational — the app still verifies against the
 * manifest `sha256`; checksums.json is a manifest of what was captured.
 */
export async function buildChecksumsJson(
  rootPath: string,
  manifests: ModelManifest[],
  generatedAt: string = new Date().toISOString()
): Promise<ChecksumsJson> {
  const entries: ChecksumsJson['entries'] = []
  for (const manifest of manifests) {
    const path = weightPath(rootPath, manifest)
    const present = existsSync(path)
    entries.push({
      id: manifest.id,
      local_path: manifest.localPath,
      sha256: present ? await sha256File(path) : null,
      size_bytes: present ? safeSize(path) : null,
      present
    })
  }
  return {
    drive_format_version: DRIVE_FORMAT_VERSION,
    generated_at: generatedAt,
    algorithm: 'sha256',
    entries
  }
}

// ---- prepare-drive plan (dry-run is the automatable test) -------------------------

export interface PreparePlanFile {
  /** Path relative to the drive root, using forward slashes. */
  relPath: string
  contents: string
}

export interface PreparePlan {
  rootPath: string
  /** Absolute directories to create (idempotent). */
  dirsToCreate: string[]
  /** Config files to write (relative path + JSON contents). */
  filesToWrite: PreparePlanFile[]
  /** Manifest filenames to copy from the repo `model-manifests/` onto the drive. */
  manifestsToCopy: string[]
  /** Weight destinations the user must populate (resolved from manifests). */
  weightDestinations: string[]
  /** Whether `config/*.json` would be overwritten (they already exist). */
  configWouldOverwrite: boolean
}

export interface PreparePlanOptions extends DriveJsonOptions, PolicyJsonOptions {
  /** Forces config regeneration even if files already exist. */
  force?: boolean
}

const CONFIG_INDENT = 2

/**
 * Compute the full prepare-drive plan WITHOUT touching the filesystem (beyond reading
 * to detect existing config). The dry-run prints this; a real run executes it. Pure
 * enough to unit-test the whole layout + every generated config file.
 */
export function planPrepareDrive(
  rootPath: string,
  manifests: ModelManifest[],
  opts: PreparePlanOptions = {}
): PreparePlan {
  const dirsToCreate = driveLayoutDirs(rootPath)

  const drive = buildDriveJson(opts)
  const policy = buildPolicyJson(opts)
  const filesToWrite: PreparePlanFile[] = [
    { relPath: 'config/drive.json', contents: JSON.stringify(drive, null, CONFIG_INDENT) + '\n' },
    { relPath: 'config/policy.json', contents: JSON.stringify(policy, null, CONFIG_INDENT) + '\n' }
  ]

  const configWouldOverwrite =
    existsSync(join(rootPath, 'config', 'drive.json')) ||
    existsSync(join(rootPath, 'config', 'policy.json'))

  return {
    rootPath,
    dirsToCreate,
    filesToWrite,
    manifestsToCopy: manifests.map((m) => `${m.id}.yaml`),
    weightDestinations: manifests.map((m) => m.localPath),
    configWouldOverwrite
  }
}

/** Render a prepare-drive plan as a human-readable dry-run report. */
export function formatPlan(plan: PreparePlan): string {
  const lines: string[] = []
  lines.push(`Prepare drive at: ${plan.rootPath}`)
  lines.push('')
  lines.push('Directories to create:')
  for (const d of plan.dirsToCreate) lines.push(`  + ${d}`)
  lines.push('')
  lines.push('Config files to write:')
  for (const f of plan.filesToWrite) lines.push(`  + ${f.relPath}`)
  if (plan.configWouldOverwrite) lines.push('  (existing config/*.json present — use --force to overwrite)')
  lines.push('')
  lines.push('Model weights you must add (git-ignored, not provisioned by this script):')
  for (const w of plan.weightDestinations) lines.push(`  · ${w}`)
  lines.push('')
  lines.push('Sidecar binaries you must add: runtime/llama.cpp/{win,mac,linux}/llama-server[.exe]')
  return lines.join('\n')
}
