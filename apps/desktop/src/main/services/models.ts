import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  isRealSha256,
  validateManifest,
  type ModelManifest,
  type ModelRole
} from '../../shared/manifest'
import type { HardwareProfile, ModelInfo, ModelState } from '../../shared/types'
import type { Db } from './db'
import { getSettings, updateSettings } from './settings'

// Model manager (spec §7.4): discover manifests, verify checksums, compute model
// states, recommend by hardware profile, and select the active chat/embedding model.
// All offline — manifests are local YAML; weights are local files. No network.

const SUPPORTED_RUNTIMES = new Set(['llama_cpp', 'llama.cpp'])
const SUPPORTED_FORMATS = new Set(['gguf'])
const MANIFEST_EXTENSIONS = new Set(['.yaml', '.yml'])
/**
 * Reserved filenames under `model-manifests/` that are NOT model manifests (Phase 12).
 * `runtime-sources.yaml` describes the llama.cpp sidecar builds, not a model, and would
 * fail `validateManifest` — skip it during model discovery (it has its own validator).
 */
const RESERVED_MANIFEST_FILES = new Set(['runtime-sources.yaml', 'runtime-sources.yml'])

export interface DiscoveredManifest {
  manifest: ModelManifest
  sourceFile: string
}

export interface DiscoveryResult {
  manifests: DiscoveredManifest[]
  /** One human-readable line per file that failed to parse/validate. */
  errors: string[]
}

/**
 * Find the `model-manifests/` directory by walking up from a starting dir.
 * Manifests are committed to git, so they sit at the repo/app root. Packaging places
 * them under resources; the drive launchers set PAID_MANIFESTS_DIR to the drive's copy
 * (one source of truth with the verify/fetch scripts, M21). A set-but-missing override
 * falls back to the walk-up instead of blanking the model list.
 */
export function resolveManifestsDir(startDir: string, override?: string): string | null {
  const env = override?.trim()
  if (env && existsSync(env)) return env

  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'model-manifests')
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Recursively collect manifest file paths under a directory. */
function collectManifestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectManifestFiles(full))
    } else if (
      MANIFEST_EXTENSIONS.has(extname(entry.name)) &&
      !RESERVED_MANIFEST_FILES.has(entry.name.toLowerCase())
    ) {
      out.push(full)
    }
  }
  return out
}

function extname(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

/** Discover + parse + validate every manifest under `manifestsDir`. */
export function discoverManifests(manifestsDir: string): DiscoveryResult {
  const manifests: DiscoveredManifest[] = []
  const errors: string[] = []
  const seenIds = new Map<string, string>()

  for (const file of collectManifestFiles(manifestsDir)) {
    let raw: unknown
    try {
      raw = parseYaml(readFileSync(file, 'utf8'))
    } catch (err) {
      errors.push(`${file}: YAML parse error — ${String(err)}`)
      continue
    }
    const result = validateManifest(raw)
    if (!result.ok || !result.manifest) {
      errors.push(`${file}: ${result.errors.join('; ')}`)
      continue
    }
    const dup = seenIds.get(result.manifest.id)
    if (dup) {
      errors.push(`${file}: duplicate id "${result.manifest.id}" (also in ${dup})`)
      continue
    }
    seenIds.set(result.manifest.id, file)
    manifests.push({ manifest: result.manifest, sourceFile: file })
  }
  return { manifests, errors }
}

/** Stream a file through SHA-256 (large GGUF files never fully buffer in memory). */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export interface ChecksumResult {
  exists: boolean
  /** null when there is no real expected hash to compare against (placeholder). */
  matched: boolean | null
  actual: string | null
}

// ---- checksum cache (H5, audit round 4) -------------------------------------------
// `listModels` runs on every Models-screen visit AND every Chat-screen mount. Without a
// cache that re-hashed every multi-GB GGUF on the drive each time — minutes of USB I/O
// per navigation. Hash once per (path, size, mtime); a changed/replaced file re-hashes.
// Limitation (accepted): a same-size, mtime-preserving in-place tamper is not re-detected
// within a session — the ship-time gates (verify-models --strict / assertCommercialDrive)
// always hash fully, and mtime can be forged by an attacker anyway.

interface CachedHash {
  size: number
  mtimeMs: number
  actual: string
}

const hashCache = new Map<string, CachedHash>()

/** Test visibility: how many full-file hashes were actually computed. */
export const checksumCacheStats = { computed: 0 }

/** Drop all cached hashes (tests / an explicit re-verify). */
export function clearChecksumCache(): void {
  hashCache.clear()
}

/** SHA-256 of a file, cached by (path, size, mtimeMs). */
async function sha256FileCached(filePath: string): Promise<string> {
  const st = statSync(filePath)
  const hit = hashCache.get(filePath)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.actual
  const actual = await sha256File(filePath)
  checksumCacheStats.computed += 1
  hashCache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, actual })
  return actual
}

/** Verify a weight file against its expected SHA-256 (cached by size+mtime). */
export async function verifyChecksum(filePath: string, expected: string): Promise<ChecksumResult> {
  if (!existsSync(filePath)) return { exists: false, matched: null, actual: null }
  const actual = await sha256FileCached(filePath)
  if (!isRealSha256(expected)) return { exists: true, matched: null, actual }
  return { exists: true, matched: actual === expected, actual }
}

/**
 * Absolute path of a manifest's weight file. `local_path` is relative to the drive root.
 * A manifest on a prepared drive lives in a user-writable location, so we reject a
 * `local_path` that escapes the drive root (`..`/absolute) before it could become a
 * `llama-server --model` argument pointing at an arbitrary file.
 */
export function weightPath(rootPath: string, manifest: ModelManifest): string {
  const full = join(rootPath, manifest.localPath)
  const base = resolve(rootPath)
  const resolved = resolve(full)
  // A bare drive root (e.g. `D:\`) already ends in the separator, so `base + sep` would
  // double it (`D:\\`) and reject every legitimate path. Only append a separator when the
  // base does not already end in one.
  const prefix = base.endsWith(sep) ? base : base + sep
  if (resolved !== base && !resolved.startsWith(prefix)) {
    throw new Error(`Manifest local_path escapes the drive root: ${manifest.localPath}`)
  }
  return full
}

export interface InstallStateOptions {
  /** When true, skip checksum verification for placeholder/dev hashes. */
  developerMode: boolean
}

/**
 * Compute the install-level model state (spec §7.4): unsupported | missing |
 * checksum_failed | installed. Runtime states (ready/running) are layered on later.
 */
export async function computeInstallState(
  manifest: ModelManifest,
  rootPath: string,
  opts: InstallStateOptions
): Promise<ModelState> {
  if (!SUPPORTED_RUNTIMES.has(manifest.runtime) || !SUPPORTED_FORMATS.has(manifest.format)) {
    return 'unsupported'
  }
  const path = weightPath(rootPath, manifest)
  if (!existsSync(path)) return 'missing'

  // A placeholder hash can never verify, so hashing the (multi-GB) file would be pure
  // wasted I/O — decide from the manifest alone. Outside developer mode an unverifiable
  // file is treated as a checksum failure (spec §7.4 gate); in developer mode it counts
  // as installed.
  if (!isRealSha256(manifest.sha256)) {
    return opts.developerMode ? 'installed' : 'checksum_failed'
  }

  const check = await verifyChecksum(path, manifest.sha256)
  if (check.matched === false) return 'checksum_failed'
  return 'installed'
}

/** Recommend a model id for a hardware profile + role (spec §7.3). */
export function recommendModelId(
  manifests: ModelManifest[],
  profile: HardwareProfile,
  role: ModelRole = 'chat'
): string | null {
  const match = manifests.find((m) => m.role === role && m.recommendedProfiles.includes(profile))
  return match?.id ?? null
}

function toModelInfo(
  manifest: ModelManifest,
  state: ModelState,
  recommended: boolean,
  startableAsMock: boolean
): ModelInfo {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    family: manifest.family,
    role: manifest.role,
    format: manifest.format,
    runtime: manifest.runtime,
    license: manifest.license,
    sizeOnDiskGb: manifest.sizeOnDiskGb,
    recommendedMinRamGb: manifest.recommendedMinRamGb,
    recommendedRamGb: manifest.recommendedRamGb,
    recommendedContextTokens: manifest.recommendedContextTokens,
    localPath: manifest.localPath,
    state,
    recommended,
    startableAsMock
  }
}

export interface BuildModelListOptions {
  manifestsDir: string
  rootPath: string
  profile: HardwareProfile
  developerMode: boolean
  /** Model id currently loaded in a running runtime, if any. */
  runningModelId?: string | null
}

export interface ModelListResult {
  models: ModelInfo[]
  manifestErrors: string[]
}

/** Discover manifests and compute the full ModelInfo[] for the Models screen. */
export async function buildModelList(opts: BuildModelListOptions): Promise<ModelListResult> {
  const { manifests, errors } = discoverManifests(opts.manifestsDir)
  const recommendedChat = recommendModelId(manifests.map((m) => m.manifest), opts.profile, 'chat')
  const recommendedEmbed = recommendModelId(
    manifests.map((m) => m.manifest),
    opts.profile,
    'embeddings'
  )

  const models: ModelInfo[] = []
  for (const { manifest } of manifests) {
    let state = await computeInstallState(manifest, opts.rootPath, {
      developerMode: opts.developerMode
    })
    if (opts.runningModelId && manifest.id === opts.runningModelId && state === 'installed') {
      state = 'running'
    }
    const recommended =
      manifest.id === recommendedChat || manifest.id === recommendedEmbed
    // Zero-weights first run (H6/M10): a missing CHAT model may start the built-in mock
    // when the caller's (policy-gated) developer leniency is on. Computed here so the
    // renderer renders an affordance the MAIN process actually allows.
    const startableAsMock =
      state === 'missing' && manifest.role === 'chat' && opts.developerMode
    models.push(toModelInfo(manifest, state, recommended, startableAsMock))
  }
  return { models, manifestErrors: errors }
}

export interface SelectResult {
  activeModelId: string | null
  activeEmbeddingModelId: string | null
}

/**
 * Persist the selected active model to settings. Chat models set `activeModelId`;
 * embedding models set `activeEmbeddingModelId`. Throws if the id is unknown.
 */
export function selectModel(db: Db, manifestsDir: string, modelId: string): SelectResult {
  const { manifests } = discoverManifests(manifestsDir)
  const found = manifests.find((m) => m.manifest.id === modelId)
  if (!found) throw new Error(`Unknown model id: ${modelId}`)

  const patch =
    found.manifest.role === 'embeddings'
      ? { activeEmbeddingModelId: modelId }
      : { activeModelId: modelId }
  updateSettings(db, patch)
  const s = getSettings(db)
  return { activeModelId: s.activeModelId, activeEmbeddingModelId: s.activeEmbeddingModelId }
}
