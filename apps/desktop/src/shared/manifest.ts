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

export type ModelRole = 'chat' | 'embeddings' | 'reranker'

export interface LicenseReview {
  status: 'pending' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  notes: string
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
  /** Path of the weight file relative to the `models/` directory. */
  localPath: string
  /** Expected SHA-256 (lower-case hex). May be a placeholder until a real drive is built. */
  sha256: string
  /** Hardware profiles this model is recommended for (drives §7.3 recommendation). */
  recommendedProfiles: HardwareProfile[]
  licenseReview: LicenseReview
}

export interface ValidationResult {
  ok: boolean
  manifest?: ModelManifest
  errors: string[]
}

const ROLES: ModelRole[] = ['chat', 'embeddings', 'reranker']
const PROFILES: HardwareProfile[] = ['TINY', 'LITE', 'BALANCED', 'PRO', 'UNKNOWN']
const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const

/** 64 lower-case hex chars. Used to tell a real hash from a placeholder. */
const SHA256_RE = /^[a-f0-9]{64}$/

export function isRealSha256(value: string): boolean {
  return SHA256_RE.test(value)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
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
      localPath,
      sha256,
      recommendedProfiles,
      licenseReview
    }
  }
}
