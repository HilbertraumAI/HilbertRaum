// Model manifest schema + validator (spec §3.3 / §7.4; see docs/model-policy.md).
//
// A manifest is a small YAML file under `model-manifests/` describing one model.
// Manifests are committed to git; model *weights* are not. The app reads these to
// discover, verify (SHA-256), recommend, and select models with NO code changes —
// so the schema lives in `shared/` and is the single source of truth for the shape.
//
// Parsing uses the pure-JS `yaml` package (boring, reliable, offline). The validator
// is hand-written so every field gets a precise, user-facing error message.

import type { HardwareProfile } from './types'

export type ModelRole = 'chat' | 'embeddings' | 'reranker' | 'transcriber' | 'vision'

export interface LicenseReview {
  status: 'pending' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  notes: string
}

/**
 * Optional download metadata. When present, the `fetch-models` script (and
 * the canonical `services/assets.ts`) know where to fetch the weight from and what to
 * verify it against. Validated only when the `download` block is present, so every
 * existing manifest stays valid without it.
 */
export interface DownloadSpec {
  /** Upstream URL for the weight (e.g. a Hugging Face `?download=true` link). */
  url: string
  /**
   * Expected SHA-256 (lower-case hex) of the downloaded file. May be a placeholder
   * until a real drive is built; when it is a real hash it MUST equal the top-level
   * `sha256` (they describe the same file).
   */
  sha256: string
  /** Expected size in bytes (informational; for progress + a sanity check). */
  sizeBytes: number | null
  /** URL of the model license, shown at the license-acceptance prompt. */
  licenseUrl: string | null
}

/**
 * The multimodal projector sub-block for a `role: vision` model (image-understanding plan
 * §8.1). A vision model is TWO files: the language GGUF (the top-level `local_path`/`sha256`/
 * `download`) plus this CLIP/`mmproj` projector that `llama-server --mmproj` loads. Validated
 * only when present, and REQUIRED when `role: vision` (so an older build that doesn't know
 * `vision` simply treats the manifest as `unsupported` — forward-compatible, like
 * `supports_tools`). Its own `download` block lets the two-job downloader (DIST-1) fetch the
 * projector with the same atomic single-file machinery as the GGUF.
 */
export interface MmprojSpec {
  /** Path of the projector file relative to the DRIVE ROOT (e.g. `models/vision/x-mmproj.gguf`). */
  localPath: string
  /** Expected SHA-256 (lower-case hex). May be a placeholder until a real drive is built. */
  sha256: string
  /** Optional upstream source for the projector (the second `DownloadJob` of a vision model). */
  download?: DownloadSpec
}

/** A fully-validated manifest. Field names are camelCased from the YAML snake_case. */
export interface ModelManifest {
  id: string
  displayName: string
  family: string
  role: ModelRole
  format: string
  runtime: string
  license: string
  sizeOnDiskGb: number
  recommendedMinRamGb: number
  recommendedRamGb: number
  recommendedContextTokens: number
  /**
   * Whether the model has a native thinking/reasoning mode the runtime can toggle per
   * request (gates the Deep answer mode in the UI). Optional in YAML
   * (`supports_thinking_mode`), defaulting to false — Deep is never offered for a
   * model that did not declare it.
   */
  supportsThinkingMode: boolean
  /** Path of the weight file relative to the DRIVE ROOT (e.g. `models/chat/x.gguf`). */
  localPath: string
  /** Expected SHA-256 (lower-case hex). May be a placeholder until a real drive is built. */
  sha256: string
  /** Hardware profiles this model is recommended for (legacy/no-RAM-known picker). */
  recommendedProfiles: HardwareProfile[]
  /**
   * Recommendation tiebreak: higher = preferred among models that fit the
   * machine's RAM. Encodes the model-benchmark verdict so the RAM-best-fit picker is
   * quality-aware instead of biggest-disk-wins (model-benchmarks.md §6.2). Optional in YAML
   * (`recommendation_rank`), default 0.
   */
  recommendationRank: number
  licenseReview: LicenseReview
  /** Optional download metadata. Absent on manifests with no upstream source. */
  download?: DownloadSpec
  /**
   * Informational input modalities (`input_modalities`, e.g. `[text, image]` for a vision
   * model). Default `[]` when omitted; never load-bearing — capability comes from `role` +
   * `mmproj`, not this list. Parsed so it round-trips rather than being silently dropped.
   */
  inputModalities?: string[]
  /**
   * The multimodal projector (`mmproj`) sub-block. Present (and required) only for
   * `role: vision` models (image-understanding plan §8.1). See {@link MmprojSpec}.
   */
  mmproj?: MmprojSpec
}

export interface ValidationResult {
  ok: boolean
  manifest?: ModelManifest
  errors: string[]
}

const ROLES: ModelRole[] = ['chat', 'embeddings', 'reranker', 'transcriber', 'vision']
const PROFILES: HardwareProfile[] = ['TINY', 'LITE', 'BALANCED', 'PRO', 'UNKNOWN']
const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const

/** 64 lower-case hex chars. Used to tell a real hash from a placeholder. */
const SHA256_RE = /^[a-f0-9]{64}$/

export function isRealSha256(value: string): boolean {
  return SHA256_RE.test(value)
}

/**
 * True only for an `https://` URL (case-insensitive scheme). Download URLs must be TLS:
 * cleartext `http://` leaks which model is fetched and is downgrade-friendly (L-2). Shared
 * by the manifest validator and the asset planners so the rule has one definition.
 */
export function isHttpsUrl(value: string): boolean {
  return /^https:\/\//i.test(value.trim())
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate a `download:`-shaped sub-block (url/sha256/size_bytes/license_url), collecting
 * errors. Shared by the top-level `download` block and the `mmproj.download` block so the
 * rules (https-only URL, L-2; a real download hash must equal the real FILE hash) have one
 * definition. `fileSha` is the hash of the file this block fetches (the top-level `sha256`
 * for `download`, the `mmproj.sha256` for `mmproj.download`); `label` prefixes every message.
 */
function validateDownloadSubBlock(
  dl: unknown,
  fileSha: string,
  errors: string[],
  label: 'download' | 'mmproj.download'
): DownloadSpec | undefined {
  if (!isObject(dl)) {
    errors.push(`"${label}" must be a mapping (url/sha256/size_bytes/license_url)`)
    return undefined
  }
  const url = dl['url']
  if (typeof url !== 'string' || url.trim() === '') {
    errors.push(`"${label}.url" is required and must be a non-empty string`)
  } else if (!isHttpsUrl(url)) {
    // L-2: cleartext http:// leaks which model is fetched and is downgrade-friendly.
    errors.push(`"${label}.url" must be an https:// URL`)
  }
  const dlShaRaw = dl['sha256']
  if (typeof dlShaRaw !== 'string' || dlShaRaw.trim() === '') {
    errors.push(`"${label}.sha256" is required and must be a string (hash or placeholder)`)
  }
  const dlSha = typeof dlShaRaw === 'string' ? dlShaRaw.trim().toLowerCase() : ''
  // A real download hash must equal the real expected hash of the same file.
  if (isRealSha256(dlSha) && isRealSha256(fileSha) && dlSha !== fileSha) {
    errors.push(
      label === 'download'
        ? '"download.sha256" must equal the top-level "sha256" when both are real hashes'
        : '"mmproj.download.sha256" must equal the "mmproj.sha256" when both are real hashes'
    )
  }
  const sizeRaw = dl['size_bytes']
  let sizeBytes: number | null = null
  if (sizeRaw !== undefined && sizeRaw !== null) {
    if (typeof sizeRaw !== 'number' || !Number.isFinite(sizeRaw) || sizeRaw < 0) {
      errors.push(`"${label}.size_bytes" must be a non-negative number when present`)
    } else {
      sizeBytes = sizeRaw
    }
  }
  const licenseUrlRaw = dl['license_url']
  if (licenseUrlRaw !== undefined && licenseUrlRaw !== null && typeof licenseUrlRaw !== 'string') {
    errors.push(`"${label}.license_url" must be a string when present`)
  }
  return {
    url: typeof url === 'string' ? url.trim() : '',
    sha256: dlSha,
    sizeBytes,
    licenseUrl: typeof licenseUrlRaw === 'string' ? licenseUrlRaw.trim() : null
  }
}

/**
 * Validate a parsed YAML object into a ModelManifest, collecting all errors.
 * Pure (no I/O) so it is trivial to unit-test.
 */
export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = []
  if (!isObject(raw)) {
    return { ok: false, errors: ['manifest must be a YAML mapping (key: value pairs)'] }
  }

  const str = (key: string, snake: string): string => {
    const v = raw[snake]
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`"${snake}" is required and must be a non-empty string`)
      return ''
    }
    return v.trim()
  }

  const num = (snake: string): number => {
    const v = raw[snake]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`"${snake}" is required and must be a non-negative number`)
      return 0
    }
    return v
  }

  const id = str('id', 'id')
  const displayName = str('displayName', 'display_name')
  const family = str('family', 'family')
  const roleRaw = str('role', 'role')
  if (roleRaw && !ROLES.includes(roleRaw as ModelRole)) {
    errors.push(`"role" must be one of: ${ROLES.join(', ')}`)
  }
  const format = str('format', 'format')
  const runtime = str('runtime', 'runtime')
  const license = str('license', 'license')
  const sizeOnDiskGb = num('size_on_disk_gb')
  const recommendedMinRamGb = num('recommended_min_ram_gb')
  const recommendedRamGb = num('recommended_ram_gb')
  const recommendedContextTokens = num('recommended_context_tokens')
  const localPath = str('localPath', 'local_path')
  const sha256 = str('sha256', 'sha256').toLowerCase()

  // Optional capability flag: must be a boolean when present.
  let supportsThinkingMode = false
  const stm = raw['supports_thinking_mode']
  if (stm !== undefined) {
    if (typeof stm !== 'boolean') {
      errors.push('"supports_thinking_mode" must be a boolean when present')
    } else {
      supportsThinkingMode = stm
    }
  }

  // Optional: which hardware profiles this model targets.
  let recommendedProfiles: HardwareProfile[] = []
  const rp = raw['recommended_profiles']
  if (rp !== undefined) {
    if (!Array.isArray(rp) || !rp.every((p) => typeof p === 'string' && PROFILES.includes(p as HardwareProfile))) {
      errors.push(`"recommended_profiles" must be a list of: ${PROFILES.join(', ')}`)
    } else {
      recommendedProfiles = rp as HardwareProfile[]
    }
  }

  // Optional recommendation tiebreak: higher = preferred among models that fit.
  let recommendationRank = 0
  const rr = raw['recommendation_rank']
  if (rr !== undefined) {
    if (typeof rr !== 'number' || !Number.isFinite(rr)) {
      errors.push('"recommendation_rank" must be a number when present')
    } else {
      recommendationRank = rr
    }
  }

  // Required license-review gate (spec §7.4 / model-policy.md).
  const lr = raw['license_review']
  let licenseReview: LicenseReview = {
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    notes: ''
  }
  if (!isObject(lr)) {
    errors.push('"license_review" block is required (status/reviewed_by/reviewed_at/notes)')
  } else {
    const status = lr['status']
    if (typeof status !== 'string' || !REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number])) {
      errors.push(`"license_review.status" must be one of: ${REVIEW_STATUSES.join(', ')}`)
    }
    licenseReview = {
      status: (REVIEW_STATUSES as readonly string[]).includes(String(status))
        ? (status as LicenseReview['status'])
        : 'pending',
      reviewedBy: typeof lr['reviewed_by'] === 'string' ? (lr['reviewed_by'] as string) : null,
      reviewedAt: typeof lr['reviewed_at'] === 'string' ? (lr['reviewed_at'] as string) : null,
      notes: typeof lr['notes'] === 'string' ? (lr['notes'] as string) : ''
    }
  }

  // Optional download block. Validated only when present, so existing
  // manifests with no `download:` stay valid.
  let download: DownloadSpec | undefined
  if (raw['download'] !== undefined) {
    download = validateDownloadSubBlock(raw['download'], sha256, errors, 'download')
  }

  // Optional informational input modalities (e.g. [text, image] for a vision model).
  let inputModalities: string[] | undefined
  const im = raw['input_modalities']
  if (im !== undefined) {
    if (!Array.isArray(im) || !im.every((x) => typeof x === 'string')) {
      errors.push('"input_modalities" must be a list of strings when present')
    } else {
      inputModalities = im as string[]
    }
  }

  // Optional multimodal projector block (image-understanding plan §8.1). Validated only when
  // present, and REQUIRED when `role: vision`. Unknown to older builds → those treat the
  // manifest as `unsupported` (forward-compatible), exactly like a new role.
  let mmproj: MmprojSpec | undefined
  const mp = raw['mmproj']
  if (mp !== undefined) {
    if (!isObject(mp)) {
      errors.push('"mmproj" must be a mapping (local_path/sha256/download)')
    } else {
      const mpLocalRaw = mp['local_path']
      let mpLocal = ''
      if (typeof mpLocalRaw !== 'string' || mpLocalRaw.trim() === '') {
        errors.push('"mmproj.local_path" is required and must be a non-empty string')
      } else {
        mpLocal = mpLocalRaw.trim()
      }
      const mpShaRaw = mp['sha256']
      if (typeof mpShaRaw !== 'string' || mpShaRaw.trim() === '') {
        errors.push('"mmproj.sha256" is required and must be a string (hash or placeholder)')
      }
      const mpSha = typeof mpShaRaw === 'string' ? mpShaRaw.trim().toLowerCase() : ''
      let mpDownload: DownloadSpec | undefined
      if (mp['download'] !== undefined) {
        mpDownload = validateDownloadSubBlock(mp['download'], mpSha, errors, 'mmproj.download')
      }
      mmproj = { localPath: mpLocal, sha256: mpSha, ...(mpDownload ? { download: mpDownload } : {}) }
    }
  }
  if (roleRaw === 'vision' && mmproj === undefined) {
    errors.push('"mmproj" projector block is required when role is "vision"')
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    errors: [],
    manifest: {
      id,
      displayName,
      family,
      role: roleRaw as ModelRole,
      format,
      runtime,
      license,
      sizeOnDiskGb,
      recommendedMinRamGb,
      recommendedRamGb,
      recommendedContextTokens,
      supportsThinkingMode,
      localPath,
      sha256,
      recommendedProfiles,
      recommendationRank,
      licenseReview,
      ...(download ? { download } : {}),
      ...(inputModalities ? { inputModalities } : {}),
      ...(mmproj ? { mmproj } : {})
    }
  }
}
