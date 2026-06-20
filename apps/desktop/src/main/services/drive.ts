import { dirname, join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import type { ModelManifest } from '../../shared/manifest'
import { isRealSha256 } from '../../shared/manifest'
import { manifestFiles, sha256File, verifyChecksum } from './models'

// Drive preparation logic (spec §6 / §12).
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
  // Skill packages (skills plan §0/§7 — plaintext plain folders, OUTSIDE the encrypted
  // workspace). `app-skills/` is read-only product content (provisioned at drive-build, like
  // model-manifests); the committed repo `app-skills/` tree (e.g. bank-statement/) is COPIED
  // onto the drive by prepare-drive in S9, the same wholesale copy step as model-manifests/.
  // `user-skills/` is the read-write area the Skills view writes to and power users may drop a
  // folder into — it ships EMPTY on a sold drive (commercial-drive asserts both, §14). Both are
  // registered here in S3 (audit A4) so the registry never reads a directory the layout
  // machinery forgot to create.
  'app-skills',
  'user-skills',
  'models/chat',
  'models/embeddings',
  'models/reranker',
  'models/transcriber',
  // Vision (image-understanding) weights: the language GGUF + its mmproj projector
  // (image-understanding plan §8.4). Git-ignored like all weights; opt-in download.
  'models/vision',
  'model-manifests',
  // Committed vision manifests are discovered recursively under model-manifests/; the
  // sub-dir keeps the role's YAML tidy (resolveManifestsDir walks recursively, no code change).
  'model-manifests/vision',
  ...DRIVE_OS_DIRS.map((os) => `runtime/llama.cpp/${os}`),
  // Second sidecar family: the whisper.cpp transcriber CLI. Upstream ships
  // a prebuilt Windows build only; the mac/linux dirs exist for the documented
  // source-build provisioning step (drive-layout.md).
  ...DRIVE_OS_DIRS.map((os) => `runtime/whisper.cpp/${os}`),
  // OCR language files: `<lang>.traineddata.gz`, vendored at drive-build
  // time (runtime-sources.yaml `ocr:` block) — the engine never fetches at runtime.
  'ocr',
  'logs',
  'config',
  'docs'
]

/** Absolute directory paths to create for a prepared drive at `rootPath`. */
export function driveLayoutDirs(rootPath: string): string[] {
  return DRIVE_LAYOUT_DIRS.map((rel) => join(rootPath, ...rel.split('/')))
}

/**
 * Resolve the app-shipped skills directory (skills plan §7.3, the `resolveManifestsDir`
 * precedent). Prefers `<root>/app-skills/` (where `prepare-drive` provisions it); in a dev build
 * the on-drive copy may be absent, so fall back to the committed repo `app-skills/` source dir by
 * walking up from `appPath` — exactly how model manifests resolve in dev. Returns the canonical
 * `<root>/app-skills/` path even when nothing exists yet (discovery tolerates an absent dir),
 * so the result is always a usable path. App skills are read-only and never created here.
 */
export function resolveAppSkillsDir(rootPath: string, appPath?: string): string {
  const onDrive = join(rootPath, 'app-skills')
  if (existsSync(onDrive)) return onDrive
  if (appPath) {
    let dir = appPath
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'app-skills')
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return onDrive
}

/**
 * Resolve the user-installed skills directory (skills plan §0/§7) — always `<root>/user-skills/`.
 * It is a single read-write location (no dev/repo fallback: user skills are user-created, never
 * committed). Pure resolution; the registry creates it on demand at reconcile time.
 */
export function resolveUserSkillsDir(rootPath: string): string {
  return join(rootPath, 'user-skills')
}

/**
 * List the skill folder names under a skills directory (a sub-directory that contains a
 * `SKILL.md`). Used to (a) compute what `prepare-drive` copies from the repo `app-skills/`
 * source and (b) assert a sold drive ships at least one trusted product skill
 * (`assertCommercialDrive`). Returns `[]` for an absent/unreadable directory — discovery
 * tolerates an empty skills area. Sorted for stable, testable output.
 */
export function listSkillFolders(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(dir, name, 'SKILL.md')))
      .sort()
  } catch {
    return []
  }
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
    product: 'HilbertRaum',
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
    // Telemetry has no knob — the app has no telemetry at all, so policy.json does not
    // carry an `allow_telemetry` field (it would only ever be false). `buildPolicyStatus`
    // hardcodes `telemetryAllowed: false`.
    network: {
      allow_model_downloads: false,
      allow_update_checks: false
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

/** Runtimes/formats the app can load. Exported so the drift test (audit M-A1) can assert
 *  the `verify-models.{ps1,sh}` gate literals against this single source of truth. */
export const SUPPORTED_RUNTIMES = new Set(['llama_cpp', 'llama.cpp'])
export const SUPPORTED_FORMATS = new Set(['gguf'])

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
    // DIST-2: a vision model is GGUF + mmproj. Verify EVERY file the install side requires
    // (`manifestFiles`) and fold to ONE per-model row, reporting the FIRST file that is not
    // `verified` so a half-installed vision drive (good GGUF, missing/corrupt projector) can
    // never pass the sell gate. Single-file (non-vision) models keep the old behaviour exactly.
    const files = manifestFiles(rootPath, manifest)
    let chosen: ModelVerifyResult | null = null
    for (const f of files) {
      const check = await verifyChecksum(f.path, f.sha)
      let status: ModelVerifyStatus
      if (!check.exists) status = 'missing'
      else if (!isRealSha256(f.sha)) status = 'unverified_placeholder'
      else status = check.matched ? 'verified' : 'mismatch'
      const result: ModelVerifyResult = {
        id: manifest.id,
        localPath: f.localPath,
        status,
        expected: f.sha,
        actual: check.actual,
        sizeBytes: check.exists ? safeSize(f.path) : null
      }
      // Default to the first file (the GGUF); the FIRST non-`verified` file then wins so the
      // report stably surfaces the least-healthy file (GGUF before mmproj).
      if (chosen === null || (chosen.status === 'verified' && status !== 'verified')) {
        chosen = result
      }
    }
    out.push(chosen as ModelVerifyResult)
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
    // DIST-2: capture EVERY file (GGUF + a vision model's mmproj), one entry per file, so the
    // generated manifest records the projector's hash too — not just the language weight.
    for (const f of manifestFiles(rootPath, manifest)) {
      const present = existsSync(f.path)
      entries.push({
        id: manifest.id,
        local_path: f.localPath,
        sha256: present ? await sha256File(f.path) : null,
        size_bytes: present ? safeSize(f.path) : null,
        present
      })
    }
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
  /**
   * App-skill folder names to copy from the repo `app-skills/` source onto the drive (S9). The
   * whole tree is copied wholesale (like model-manifests/); this lists the discovered skills so a
   * dry-run/test can confirm the bundled product skill is provisioned. Empty when no source dir
   * is supplied (the scripts copy wholesale regardless — drive.ts is the dry-run reference).
   */
  appSkillsToCopy: string[]
  /** Weight destinations the user must populate (resolved from manifests). */
  weightDestinations: string[]
  /** Whether `config/*.json` would be overwritten (they already exist). */
  configWouldOverwrite: boolean
}

export interface PreparePlanOptions extends DriveJsonOptions, PolicyJsonOptions {
  /** Forces config regeneration even if files already exist. */
  force?: boolean
  /**
   * The repo `app-skills/` source directory (resolveAppSkillsDir on a dev clone). When supplied,
   * the plan lists its skill folders as `appSkillsToCopy` (S9). Omitted ⇒ `[]`.
   */
  appSkillsDir?: string
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
    appSkillsToCopy: opts.appSkillsDir ? listSkillFolders(opts.appSkillsDir) : [],
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
  if (plan.appSkillsToCopy.length > 0) {
    lines.push('')
    lines.push('App skills to copy from the repo app-skills/ source:')
    for (const s of plan.appSkillsToCopy) lines.push(`  + app-skills/${s}/`)
  }
  lines.push('')
  lines.push('Model weights you must add (git-ignored, not provisioned by this script):')
  for (const w of plan.weightDestinations) lines.push(`  · ${w}`)
  lines.push('')
  lines.push('Sidecar binaries you must add: runtime/llama.cpp/{win,mac,linux}/llama-server[.exe]')
  return lines.join('\n')
}
