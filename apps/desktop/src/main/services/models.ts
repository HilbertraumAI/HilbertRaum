import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { totalmem } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  isRealSha256,
  validateManifest,
  type ModelManifest,
  type ModelRole
} from '../../shared/manifest'
import type { HardwareProfile, ModelDownloadInfo, ModelInfo, ModelState } from '../../shared/types'
import type { Db } from './db'
import { getSettings, updateSettings } from './settings'

// Model manager (spec §7.4): discover manifests, verify checksums, compute model
// states, recommend by hardware profile, and select the active chat/embedding model.
// All offline — manifests are local YAML; weights are local files. No network.

/**
 * Runtime → formats this app can actually run (the spec §7.4 `unsupported` gate).
 * Phase 36 added the whisper.cpp transcriber family (GGML `.bin` weights), so support
 * is a PAIR check — a manifest claiming `whisper_cpp` with `gguf` (or `llama_cpp` with
 * `ggml`) is still unsupported, never a silent pass.
 */
const SUPPORTED_RUNTIME_FORMATS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['llama_cpp', new Set(['gguf'])],
  ['llama.cpp', new Set(['gguf'])],
  ['whisper_cpp', new Set(['ggml'])]
])
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

// ---- checksum cache (H5, audit round 4; persisted post-MVP) -----------------------
// `listModels` runs on every Models-screen visit AND every Chat-screen mount. Without a
// cache that re-hashed every multi-GB GGUF on the drive each time — minutes of USB I/O
// per navigation. Hash once per (path, size, mtime); a changed/replaced file re-hashes.
// Two tiers: an in-memory map (L1) plus an optional injected persistent store (L2,
// `AppSettings.checksumCache`) so a restarted app does not re-hash unchanged weights.
// Limitation (accepted): a same-size, mtime-preserving in-place tamper is not re-detected
// while the cache entry lives — the Models screen's "Verify checksum" forces a real
// re-hash, the ship-time gates (verify-models --strict / assertCommercialDrive) always
// hash fully, and mtime can be forged by an attacker anyway.

export interface CachedHash {
  size: number
  mtimeMs: number
  actual: string
}

/** Persistent (L2) hash cache. `createSettingsHashStore` is the production impl. */
export interface HashStore {
  get(path: string): CachedHash | null
  set(path: string, entry: CachedHash): void
  delete(path: string): void
}

const hashCache = new Map<string, CachedHash>()

/** Test visibility: how many full-file hashes were actually computed. */
export const checksumCacheStats = { computed: 0 }

/** Drop all in-memory cached hashes (tests / an explicit re-verify). */
export function clearChecksumCache(): void {
  hashCache.clear()
}

/** Drop one file's cached hash everywhere — the "Verify checksum" forced re-hash. */
export function invalidateChecksum(filePath: string, store?: HashStore): void {
  hashCache.delete(filePath)
  store?.delete(filePath)
}

/** HashStore over `AppSettings.checksumCache` (settings rows live inside the DB). */
export function createSettingsHashStore(db: Db): HashStore {
  return {
    get(path) {
      const entry = getSettings(db).checksumCache[path]
      return entry ? { size: entry.size, mtimeMs: entry.mtimeMs, actual: entry.sha256 } : null
    },
    set(path, entry) {
      const cache = { ...getSettings(db).checksumCache }
      cache[path] = { size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.actual }
      updateSettings(db, { checksumCache: cache })
    },
    delete(path) {
      const cache = { ...getSettings(db).checksumCache }
      if (path in cache) {
        delete cache[path]
        updateSettings(db, { checksumCache: cache })
      }
    }
  }
}

/** SHA-256 of a file, cached by (path, size, mtimeMs) — memory first, then `store`. */
async function sha256FileCached(filePath: string, store?: HashStore): Promise<string> {
  const st = statSync(filePath)
  const hit = hashCache.get(filePath)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.actual
  const persisted = store?.get(filePath)
  if (persisted && persisted.size === st.size && persisted.mtimeMs === st.mtimeMs) {
    hashCache.set(filePath, persisted)
    return persisted.actual
  }
  const actual = await sha256File(filePath)
  checksumCacheStats.computed += 1
  const entry: CachedHash = { size: st.size, mtimeMs: st.mtimeMs, actual }
  hashCache.set(filePath, entry)
  store?.set(filePath, entry)
  return actual
}

/** Verify a weight file against its expected SHA-256 (cached by size+mtime). */
export async function verifyChecksum(
  filePath: string,
  expected: string,
  store?: HashStore
): Promise<ChecksumResult> {
  if (!existsSync(filePath)) return { exists: false, matched: null, actual: null }
  const actual = await sha256FileCached(filePath, store)
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
  /** Optional persistent hash cache (L2) so unchanged weights are hashed once ever. */
  hashStore?: HashStore
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
  if (!SUPPORTED_RUNTIME_FORMATS.get(manifest.runtime)?.has(manifest.format)) {
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

  const check = await verifyChecksum(path, manifest.sha256, opts.hashStore)
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

/**
 * Total RAM of this machine in whole GB. Rounded (not floored) so a "16 GB" machine
 * reporting 15.9 GiB usable still counts as 16 — a min-RAM-16 model must not be flagged
 * unusable on the exact hardware it was sized for.
 */
export function machineRamGb(): number {
  return Math.round(totalmem() / 1024 ** 3)
}

/**
 * RAM-best-fit recommendation (post-MVP): the LARGEST model whose comfortable RAM
 * (`recommended_ram_gb`) fits this machine; if nothing fits comfortably, the lightest
 * model that at least meets its minimum (`recommended_min_ram_gb`); else null. Replaces
 * the profile-table lookup as the primary recommendation — "which model?" is a RAM
 * question first, and this can never recommend a model the RAM gate disables.
 *
 * QUALITY-AWARE TIEBREAK (Phase 29, model-benchmarks.md §6.2): among models that tie on the
 * capacity fit (same comfortable RAM, or same minimum), prefer the higher
 * `recommendationRank` — the benchmark verdict — BEFORE falling back to disk size. Without
 * ranks (all 0) this is exactly the old biggest-disk behaviour, so legacy callers are
 * unchanged; with ranks the picker stops recommending a benchmark loser (e.g. Granite) over a
 * winner (Ministral) just because it is larger on disk.
 */
export function recommendModelIdByRam(
  manifests: ModelManifest[],
  ramGb: number,
  role: ModelRole = 'chat'
): string | null {
  if (!Number.isFinite(ramGb) || ramGb <= 0) return null
  const candidates = manifests.filter((m) => m.role === role)

  const comfortable = candidates
    .filter((m) => m.recommendedRamGb <= ramGb)
    .sort(
      (a, b) =>
        b.recommendedRamGb - a.recommendedRamGb ||
        b.recommendationRank - a.recommendationRank ||
        b.sizeOnDiskGb - a.sizeOnDiskGb
    )
  if (comfortable.length > 0) return comfortable[0].id

  const runnable = candidates
    .filter((m) => m.recommendedMinRamGb <= ramGb)
    .sort(
      (a, b) =>
        a.recommendedMinRamGb - b.recommendedMinRamGb ||
        b.recommendationRank - a.recommendationRank ||
        a.sizeOnDiskGb - b.sizeOnDiskGb
    )
  return runnable[0]?.id ?? null
}

function toModelInfo(
  manifest: ModelManifest,
  state: ModelState,
  recommended: boolean,
  startableAsMock: boolean,
  insufficientRam: boolean
): ModelInfo {
  // Surface the manifest's optional download block (Phase 18): the renderer's
  // per-download confirmation needs size, URL, license link, and whether an explicit
  // license acknowledgement is required (license_review not approved).
  const download: ModelDownloadInfo | undefined = manifest.download
    ? {
        url: manifest.download.url,
        sizeBytes: manifest.download.sizeBytes,
        licenseUrl: manifest.download.licenseUrl,
        licenseApproved: manifest.licenseReview.status === 'approved'
      }
    : undefined
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
    startableAsMock,
    insufficientRam,
    ...(download ? { download } : {})
  }
}

export interface BuildModelListOptions {
  manifestsDir: string
  rootPath: string
  profile: HardwareProfile
  developerMode: boolean
  /** Model id currently loaded in a running runtime, if any. */
  runningModelId?: string | null
  /** Optional persistent hash cache (L2) so unchanged weights are hashed once ever. */
  hashStore?: HashStore
  /**
   * This machine's total RAM in whole GB. When provided, models whose
   * `recommended_min_ram_gb` exceeds it are flagged `insufficientRam`, and the
   * recommendation becomes RAM-best-fit (`recommendModelIdByRam`) instead of the
   * profile-table lookup. Omitted (tests/legacy callers) → old behavior unchanged.
   */
  machineRamGb?: number
}

export interface ModelListResult {
  models: ModelInfo[]
  manifestErrors: string[]
}

/** Discover manifests and compute the full ModelInfo[] for the Models screen. */
export async function buildModelList(opts: BuildModelListOptions): Promise<ModelListResult> {
  const { manifests, errors } = discoverManifests(opts.manifestsDir)
  const all = manifests.map((m) => m.manifest)
  const ram = opts.machineRamGb
  // RAM-best-fit recommendation when the machine RAM is known (it can never point at a
  // RAM-gated model); the profile-table lookup remains the legacy/no-RAM path.
  const recommendedChat =
    ram != null
      ? recommendModelIdByRam(all, ram, 'chat')
      : recommendModelId(all, opts.profile, 'chat')
  const recommendedEmbed =
    ram != null
      ? recommendModelIdByRam(all, ram, 'embeddings')
      : recommendModelId(all, opts.profile, 'embeddings')

  const models: ModelInfo[] = []
  for (const { manifest } of manifests) {
    let state = await computeInstallState(manifest, opts.rootPath, {
      developerMode: opts.developerMode,
      hashStore: opts.hashStore
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
    const insufficientRam = ram != null && manifest.recommendedMinRamGb > ram
    models.push(toModelInfo(manifest, state, recommended, startableAsMock, insufficientRam))
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
 * Reranker/transcriber models are availability-driven (D9/D14: they activate when
 * binary + weights exist) — there is no settings slot for them, and the old
 * role-else-chat fallback would have written a transcriber id into `activeModelId`
 * (the CHAT slot) and broken chat. Refuse with friendly copy instead (Phase 36 fix).
 */
export function selectModel(db: Db, manifestsDir: string, modelId: string): SelectResult {
  const { manifests } = discoverManifests(manifestsDir)
  const found = manifests.find((m) => m.manifest.id === modelId)
  if (!found) throw new Error(`Unknown model id: ${modelId}`)

  if (found.manifest.role !== 'chat' && found.manifest.role !== 'embeddings') {
    throw new Error('This model is used automatically once installed — there is nothing to select.')
  }
  const patch =
    found.manifest.role === 'embeddings'
      ? { activeEmbeddingModelId: modelId }
      : { activeModelId: modelId }
  updateSettings(db, patch)
  const s = getSettings(db)
  return { activeModelId: s.activeModelId, activeEmbeddingModelId: s.activeEmbeddingModelId }
}
