import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { totalmem } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  isRealSha256,
  validateManifest,
  type ModelManifest,
  type ModelRole
} from '../../shared/manifest'
import type {
  GpuDevice,
  HardwareProfile,
  MemoryClass,
  ModelDownloadInfo,
  ModelInfo,
  ModelState,
  ModelVerifyProgress
} from '../../shared/types'
import { tMain } from './i18n'
import { log } from './logging'
import { perfMark, perfMs } from './perf'
import { recordChecksumRead } from './read-speed'
import type { Db } from './db'
import { getSettings, updateSettings } from './settings'
import { SLOW_TOKENS_PER_SECOND } from '../../shared/performance-rules'

// Model manager (spec §7.4): discover manifests, verify checksums, compute model
// states, recommend by hardware profile, and select the active chat/embedding model.
// All offline — manifests are local YAML; weights are local files. No network.

/**
 * Runtime → formats this app can actually run (the spec §7.4 `unsupported` gate).
 * Support is a PAIR check — a manifest claiming `whisper_cpp` with `gguf` (or
 * `llama_cpp` with `ggml`) is still unsupported, never a silent pass.
 *
 * This is the CANONICAL support table. `drive.ts` verifyDriveModels (the sell gate) and
 * the self-contained `verify-models.{ps1,sh}` scripts re-spell the SAME pairs (asserted by
 * script-drift.test.ts M-A1) — so a bundled whisper weight (ggml/whisper_cpp) verifies by
 * SHA-256 on every path instead of being falsely reported UNSUPPORTED (which would fail the
 * ship gate for any drive that bundles Whisper).
 */
export const SUPPORTED_RUNTIME_FORMATS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['llama_cpp', new Set(['gguf'])],
  ['llama.cpp', new Set(['gguf'])],
  ['whisper_cpp', new Set(['ggml'])]
])

/** The §7.4 support gate as a predicate: is this (runtime, format) pair one the app ships +
 *  verifies? The single source of truth both `computeInstallState` and `verifyDriveModels` use. */
export function isSupportedRuntimeFormat(runtime: string, format: string): boolean {
  return SUPPORTED_RUNTIME_FORMATS.get(runtime)?.has(format) ?? false
}
const MANIFEST_EXTENSIONS = new Set(['.yaml', '.yml'])
/**
 * Reserved filenames under `model-manifests/` that are NOT model manifests.
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
 * them under resources; the drive launchers set HILBERTRAUM_MANIFESTS_DIR to the drive's copy
 * (one source of truth with the verify/fetch scripts). A set-but-missing override
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

/**
 * Resolve one manifest by id from `manifestsDir`. Never throws — no dir, no id, no match,
 * or an unreadable dir all read as null (the `resolveModelByRole` precedent).
 */
export function findManifestById(
  manifestsDir: string | null,
  modelId: string | null
): ModelManifest | null {
  if (!manifestsDir || !modelId) return null
  try {
    const { manifests } = discoverManifests(manifestsDir)
    return manifests.find((m) => m.manifest.id === modelId)?.manifest ?? null
  } catch {
    return null
  }
}

/**
 * The context window a chat-runtime start launches with (llama-server's `--ctx-size`):
 * the user's context-size pick (AI Model screen) wins; automatic (null) = the model's
 * recommended window, falling back to the legacy setting for a manifest without one
 * (`recommended_context_tokens: 0`) — or when no manifest resolves at all. This is the
 * ONE spelling of that precedence: `startModelRuntime` launches with it, and the
 * no-runtime doc-task budget fallback mirrors it (full-audit 2026-07-10 BE-5 — the two
 * used to be spelled independently and disagreed, so with no runtime up the tree-build
 * size gate planned against the legacy 4096 default instead of the 32k+ window the next
 * start would actually use, over-marking documents `tree_status='pending'`).
 */
export function launchContextTokens(
  settings: { contextTokens: number; contextTokensOverride?: number | null },
  manifest: Pick<ModelManifest, 'recommendedContextTokens'> | null
): number {
  return (
    settings.contextTokensOverride ?? (manifest?.recommendedContextTokens || settings.contextTokens)
  )
}

/**
 * Stream a file through SHA-256 (large GGUF files never fully buffer in memory).
 * `onProgress` (optional) receives the running byte count, throttled to at most one call
 * per `PROGRESS_CHUNK_BYTES` (so the 64 KB read chunks of a multi-GB weight don't flood
 * IPC) — plus a final exact-total call. Used to drive the first-run verification bar.
 */
export function sha256File(
  filePath: string,
  onProgress?: (bytesHashed: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    let hashed = 0
    let lastReported = 0
    stream.on('error', reject)
    stream.on('data', (chunk) => {
      hash.update(chunk)
      hashed += chunk.length
      if (onProgress && hashed - lastReported >= PROGRESS_CHUNK_BYTES) {
        lastReported = hashed
        onProgress(hashed)
      }
    })
    stream.on('end', () => {
      if (onProgress && hashed !== lastReported) onProgress(hashed)
      resolve(hash.digest('hex'))
    })
  })
}

/** Throttle granularity for `sha256File` progress callbacks (64 MB). */
const PROGRESS_CHUNK_BYTES = 64 * 1024 * 1024

export interface ChecksumResult {
  exists: boolean
  /** null when there is no real expected hash to compare against (placeholder). */
  matched: boolean | null
  actual: string | null
}

// ---- checksum cache -----------------------------------------------------------------
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

// ---- checksum instrumentation (#106) -------------------------------------------------
// A real multi-GB hash is the dominant pre-start cost on slow media, and whichever path
// hashes FIRST (the unlock auto-start, a Models-screen visit, the runtime start, or the
// download verify) was invisible: `install_state_done` only covers the start path, and
// app.log had no line at all. One mark pair + one plain log line per PHYSICAL hash, fired
// at the single choke point where hashing actually happens — never at the (many) cache
// traversals above it.

/** Identity for a checksum instrumentation record. The perf-log content rule
 *  (services/perf.ts) allows model/backend ids but never file names or paths, so the
 *  file is named by its manifest slot, not its basename. */
export interface ChecksumLabel {
  modelId: string | null
  file: 'weight' | 'mmproj' | 'extra' | 'download' | null
}

/** Monotonic id pairing `checksum_start`/`checksum_done` marks: concurrent hashes of
 *  DIFFERENT files interleave in the log, so the pair carries a shared seq. */
let hashSeq = 0

/**
 * Begin one `checksum_start`/`checksum_done` mark + log pair around a real full-file
 * hash. Shared by `sha256FileCached` (the cached model-weight path) and the download
 * manager's verify-after-download (the one model-weight hash that bypasses the cache).
 * `end` never throws (perfMark and log both swallow their own failures).
 */
export function beginChecksumInstrumentation(
  label: ChecksumLabel,
  bytes: number | null
): { end: (ok: boolean) => void } {
  const seq = ++hashSeq
  const t0 = performance.now()
  perfMark('checksum_start', { seq, modelId: label.modelId, file: label.file, bytes })
  return {
    end: (ok: boolean): void => {
      const ms = perfMs(t0)
      perfMark('checksum_done', { seq, modelId: label.modelId, file: label.file, bytes, ms, ok })
      // The issue asks for visibility WITHOUT the opt-in perf log: one app.log line per
      // real hash. app.log may carry model ids and byte counts (never chat/doc content).
      log.info('Model checksum hashed', { modelId: label.modelId, file: label.file, bytes, ms, ok })
      // #108: a completed full-file hash of a COLD file is also an honest
      // sequential-read sample. The 'download' verify is excluded: it hashes the .part
      // the app just WROTE, whose pages are still cache-resident (fsync flushes but
      // does not evict — the F-35 mechanism), so it would record hash-CPU speed as a
      // media figure and suppress the #110 warning on the exact slow-stick fresh
      // install the feature targets.
      if (ok && bytes != null && label.file !== 'download') {
        recordChecksumRead(bytes, ms, label.modelId)
      }
    }
  }
}

/**
 * In-flight full-file hashes keyed by absolute path (#106). Concurrent callers — the
 * unlock auto-start racing a Models-screen mount, or the Models screen's status poll
 * kicking off a full `listModels` every 2.5 s while a cold start is mid-hash — used to
 * EACH start their own multi-GB read of the SAME file (`hashCache.set` only lands after
 * the await, so every overlapping caller missed). Joiners now share the one physical
 * hash: progress sinks are multicast, each joiner still writes its own L2 store, and
 * `checksumCacheStats.computed` counts physical hashes only.
 */
const inFlightHashes = new Map<
  string,
  {
    promise: Promise<string>
    sinks: Set<(bytesHashed: number) => void>
    /** The LEADER's stat identity — joiners persist exactly this entry (see below). */
    size: number
    mtimeMs: number
  }
>()

/** Drop all in-memory cached hashes (tests / an explicit re-verify). */
export function clearChecksumCache(): void {
  hashCache.clear()
}

/** Drop one file's cached hash everywhere — the "Verify checksum" forced re-hash. */
export function invalidateChecksum(filePath: string, store?: HashStore): void {
  hashCache.delete(filePath)
  store?.delete(filePath)
}

/**
 * Seed the checksum cache with a hash ALREADY computed for `filePath` (e.g. the in-app
 * downloader just SHA-256-verified the bytes it wrote). Keyed by the file's current
 * (size, mtimeMs) like every cache entry, so the next `computeInstallState` reports
 * `installed` WITHOUT re-hashing the multi-GB weight — this removes the invisible
 * post-download "Checking…" gap where the Models card briefly looked un-downloaded
 * (audit FE, download→verify UX). A no-op if the file has vanished.
 */
export function primeChecksum(filePath: string, actual: string, store?: HashStore): void {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(filePath)
  } catch {
    return // file moved/removed before we could prime — the next verify hashes normally
  }
  const entry: CachedHash = { size: st.size, mtimeMs: st.mtimeMs, actual }
  hashCache.set(filePath, entry)
  store?.set(filePath, entry)
}

/**
 * Drive-relative, OS-stable cache KEY for an absolute weight path (CODE-15, full-audit
 * 2026-07-11). The checksum cache was keyed by absolute path, so moving the drive between
 * machines (`E:\…` → `F:\…`, or `/Volumes/…` ↔ a Windows letter) forced a full multi-GB
 * re-hash and left the old absolute keys as permanent orphans in the settings blob. Keying by
 * the path RELATIVE to the drive root (with forward slashes, matching a manifest's own
 * `local_path`) makes the key independent of the mount point. A path that escapes the root
 * (should never happen — weight paths are `safeDrivePath`-guarded) or a store created without a
 * root falls back to the absolute path verbatim, so behaviour never silently changes.
 */
function driveRelKey(rootPath: string | undefined, absPath: string): string {
  if (!rootPath) return absPath
  const rel = relative(rootPath, absPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return absPath
  return rel.split(sep).join('/')
}

/**
 * HashStore over `AppSettings.checksumCache` (settings rows live inside the DB).
 *
 * Lock-aware (BE-2, full-audit 2026-07-10): takes a GETTER, not a raw handle — the stores are
 * created once at IPC registration, and locking an encrypted workspace CLOSES the DB handle a
 * multi-hour download job would otherwise still hold; the getter resolves the LIVE handle per
 * call. Every operation additionally catches DB errors (locked/closed workspace) and degrades
 * to a store-local in-memory fallback: the persistent cache is an optimization, and a store
 * fault must never throw into a caller's job/state machinery (a verified download that finished
 * while the workspace was locked must still report success). The fallback is consulted ONLY
 * when the DB is unreachable — a live DB read always wins, so cross-instance invalidations
 * ("Verify checksum") are never shadowed by a stale local entry.
 *
 * Keyed by drive-RELATIVE path (CODE-15, full-audit 2026-07-11) when `rootPath` is supplied, so
 * a drive-letter move re-hashes nothing. Callers still pass the absolute path (its size+mtime
 * is the validity check, unchanged); the store derives the relative key. Pre-migration entries
 * were keyed absolutely — on a relative-key miss the store lazily adopts a legacy absolute-key
 * entry (rewrites it under the relative key, drops the orphan), so old caches migrate as they
 * are read/written without a forced re-hash.
 */
export function createSettingsHashStore(getDb: () => Db, rootPath?: string): HashStore {
  const fallback = new Map<string, CachedHash>()
  const keyFor = (path: string): string => driveRelKey(rootPath, path)
  return {
    get(path) {
      const key = keyFor(path)
      try {
        // Read-side belt (BE-1, full-audit 2026-07-10): a row corrupted to `checksumCache: null`
        // before the settings write gate rejected it must degrade to a cache miss, not throw out
        // of every checksum reader; the next set() rewrites a healthy object over it.
        const db = getDb()
        const cache = getSettings(db).checksumCache ?? {}
        let entry = cache[key]
        if (!entry && key !== path && cache[path]) {
          // Lazy migration (CODE-15): a legacy absolute-key entry survives a drive move — adopt it
          // under the relative key and drop the absolute orphan so it re-hashes nothing and the
          // stale key is cleaned as it is read. Best-effort — the read below still serves the value
          // even if the write can't land (locked/closed workspace).
          entry = cache[path]
          try {
            const next = { ...cache }
            next[key] = entry
            delete next[path]
            updateSettings(db, { checksumCache: next })
          } catch {
            /* migrate is best-effort; the value is still returned below */
          }
        }
        return entry ? { size: entry.size, mtimeMs: entry.mtimeMs, actual: entry.sha256 } : null
      } catch {
        return fallback.get(path) ?? null
      }
    },
    set(path, entry) {
      fallback.set(path, entry)
      const key = keyFor(path)
      try {
        const db = getDb()
        const cache = { ...getSettings(db).checksumCache }
        cache[key] = { size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.actual }
        // Drop any legacy absolute-key twin so the blob never carries both (CODE-15 orphan cleanup).
        if (key !== path && path in cache) delete cache[path]
        updateSettings(db, { checksumCache: cache })
      } catch {
        /* workspace locked/closed — the in-memory fallback above keeps the session served */
      }
    },
    delete(path) {
      fallback.delete(path)
      const key = keyFor(path)
      try {
        const db = getDb()
        const cache = { ...getSettings(db).checksumCache }
        let changed = false
        if (key in cache) {
          delete cache[key]
          changed = true
        }
        // Also evict a legacy absolute-key twin (CODE-15) so a forced re-hash starts fully clean.
        if (key !== path && path in cache) {
          delete cache[path]
          changed = true
        }
        if (changed) updateSettings(db, { checksumCache: cache })
      } catch {
        /* workspace locked/closed — nothing persisted is reachable to delete right now */
      }
    }
  }
}

/**
 * SHA-256 of a file, cached by (path, size, mtimeMs) — memory first, then `store`.
 * `onProgress` fires only on a real cache MISS (a cache hit does no I/O), so callers can
 * weight the verification bar by the bytes actually hashed. Concurrent calls for the
 * same path share ONE physical hash (single-flight, #106); a real hash emits one
 * `checksum_start`/`checksum_done` mark pair + one app.log line via
 * `beginChecksumInstrumentation`.
 */
async function sha256FileCached(
  filePath: string,
  store?: HashStore,
  onProgress?: (bytesHashed: number) => void,
  label?: ChecksumLabel
): Promise<string> {
  const st = statSync(filePath)
  const hit = hashCache.get(filePath)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.actual
  const persisted = store?.get(filePath)
  if (persisted && persisted.size === st.size && persisted.mtimeMs === st.mtimeMs) {
    hashCache.set(filePath, persisted)
    return persisted.actual
  }
  // Join an in-flight hash of the same file instead of starting a second concurrent
  // multi-GB read. The joiner still persists to ITS store (the leader may have been
  // created with a different/no store) — but the entry it writes is the LEADER's
  // (leader-stat key + leader digest): keying the leader's digest under the joiner's
  // own, later stat would mint a live-keyed entry whose hash was never computed for
  // that content if the file is replaced mid-hash. The leader's entry stays honestly
  // stale-keyed in that race, exactly like a pre-single-flight hash.
  const inFlight = inFlightHashes.get(filePath)
  if (inFlight) {
    if (onProgress) inFlight.sinks.add(onProgress)
    const actual = await inFlight.promise
    store?.set(filePath, { size: inFlight.size, mtimeMs: inFlight.mtimeMs, actual })
    return actual
  }
  const sinks = new Set<(bytesHashed: number) => void>()
  if (onProgress) sinks.add(onProgress)
  const instrumentation = beginChecksumInstrumentation(
    label ?? { modelId: null, file: null },
    st.size
  )
  const run = (async (): Promise<string> => {
    const actual = await sha256File(filePath, (b) => {
      for (const sink of sinks) sink(b)
    })
    // Count + cache only a COMPLETED physical hash (a throwing hash increments nothing,
    // matching the pre-#106 behaviour `install_state_done.cacheHit` depends on).
    checksumCacheStats.computed += 1
    const entry: CachedHash = { size: st.size, mtimeMs: st.mtimeMs, actual }
    hashCache.set(filePath, entry)
    store?.set(filePath, entry)
    return actual
  })()
  inFlightHashes.set(filePath, { promise: run, sinks, size: st.size, mtimeMs: st.mtimeMs })
  try {
    const actual = await run
    instrumentation.end(true)
    return actual
  } catch (err) {
    instrumentation.end(false)
    throw err
  } finally {
    inFlightHashes.delete(filePath)
  }
}

/**
 * Is there a LIVE cached hash (L1 memory or L2 store) for this file, matching its current
 * size+mtime? RT-3 uses this so the lazy/chat path still serves a cached checksum for free
 * (honest state) and only SKIPS the multi-GB hash for genuinely un-cached weights.
 */
function cachedHashFor(filePath: string, store?: HashStore): boolean {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(filePath)
  } catch {
    return false
  }
  const hit = hashCache.get(filePath)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return true
  const persisted = store?.get(filePath)
  return !!persisted && persisted.size === st.size && persisted.mtimeMs === st.mtimeMs
}

/** Verify a weight file against its expected SHA-256 (cached by size+mtime). `label`
 *  identifies a real hash in the #106 instrumentation (marks + app.log). */
export async function verifyChecksum(
  filePath: string,
  expected: string,
  store?: HashStore,
  onProgress?: (bytesHashed: number) => void,
  label?: ChecksumLabel
): Promise<ChecksumResult> {
  if (!existsSync(filePath)) return { exists: false, matched: null, actual: null }
  const actual = await sha256FileCached(filePath, store, onProgress, label)
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
  return safeDrivePath(rootPath, manifest.localPath)
}

/**
 * Absolute path of a vision model's mmproj projector file (image-understanding plan §8.2).
 * Same drive-root escape guard as `weightPath` (the projector path also becomes a
 * `llama-server --mmproj` argument). Throws if the manifest carries no `mmproj` block.
 */
export function mmprojPath(rootPath: string, manifest: ModelManifest): string {
  if (!manifest.mmproj) throw new Error(`Model "${manifest.id}" has no mmproj projector`)
  return safeDrivePath(rootPath, manifest.mmproj.localPath)
}

/**
 * Join a manifest-relative path onto the drive root, rejecting one that escapes the root
 * (`..`/absolute) before it could become a `llama-server --model`/`--mmproj` argument
 * pointing at an arbitrary file. Shared by `weightPath` + `mmprojPath`.
 */
function safeDrivePath(rootPath: string, relPath: string): string {
  const full = join(rootPath, relPath)
  const base = resolve(rootPath)
  const resolved = resolve(full)
  // A bare drive root (e.g. `D:\`) already ends in the separator, so `base + sep` would
  // double it (`D:\\`) and reject every legitimate path. Only append a separator when the
  // base does not already end in one.
  const prefix = base.endsWith(sep) ? base : base + sep
  if (resolved !== base && !resolved.startsWith(prefix)) {
    throw new Error(`Manifest path escapes the drive root: ${relPath}`)
  }
  return full
}

/**
 * One verifiable file a manifest carries (the GGUF, a vision model's mmproj projector, or an
 * `extra` file the manifest's `files:` list declares — e.g. shards 2..N of a GGUF shard set).
 */
export interface ManifestFile {
  /** Absolute, escape-guarded path on the drive. */
  path: string
  /** Expected SHA-256 (lower-case hex; may be a placeholder). */
  sha: string
  /** Drive-relative path (forward slashes) for honest reporting (which file failed). */
  localPath: string
  /** Which manifest slot this file fills — labels the #106 checksum instrumentation. */
  kind: 'weight' | 'mmproj' | 'extra'
}

/**
 * The verifiable weight files a manifest carries: always the language GGUF, plus the mmproj
 * projector for a `role: vision` model (image-understanding plan §8.2), plus every ADDITIONAL
 * required file the manifest's `files:` list declares (#310). Install state requires ALL of
 * them present + verified. Each entry has its own expected hash; the checksum cache keys by
 * (path, size, mtime) per file so each is hashed once like the GGUF. Exported so the
 * drive-build verify side (`verifyDriveModels`/`buildChecksumsJson`, DIST-2) iterates exactly
 * the same set the install side does — a drive can never half-pass with only the first file.
 */
export function manifestFiles(rootPath: string, manifest: ModelManifest): ManifestFile[] {
  const files: ManifestFile[] = [
    {
      path: weightPath(rootPath, manifest),
      sha: manifest.sha256,
      localPath: manifest.localPath,
      kind: 'weight'
    }
  ]
  if (manifest.mmproj) {
    files.push({
      path: mmprojPath(rootPath, manifest),
      sha: manifest.mmproj.sha256,
      localPath: manifest.mmproj.localPath,
      kind: 'mmproj'
    })
  }
  // #310: the rest of a multi-file weight, in declaration order, through the same drive-root
  // escape guard as the weight and the projector.
  for (const extra of manifest.files ?? []) {
    files.push({
      path: safeDrivePath(rootPath, extra.localPath),
      sha: extra.sha256,
      localPath: extra.localPath,
      kind: 'extra'
    })
  }
  return files
}

export interface InstallStateOptions {
  /** When true, skip checksum verification for placeholder/dev hashes. */
  developerMode: boolean
  /** Optional persistent hash cache (L2) so unchanged weights are hashed once ever. */
  hashStore?: HashStore
  /**
   * Optional per-file hashing progress (running byte count). Fires only when this model's
   * weight is actually hashed (a real, present, non-cached file); drives the first-run bar.
   */
  onProgress?: (bytesHashed: number) => void
  /**
   * RT-3 lazy verification: when true, a present weight with a real expected hash is
   * reported `installed` WITHOUT hashing it. Used on the chat path (`buildModelList`'s
   * lazy mode) to report the inactive models for display without paying minutes of USB
   * I/O to SHA-256 every multi-GB GGUF on a cold cache. The §7.4 verification gate is
   * NOT relaxed: `startModelRuntime` re-verifies the model it actually launches, and the
   * Models-screen visit + the ship-time gates (verify-models --strict /
   * assertCommercialDrive) still hash fully. A cached hash is still used when present.
   */
  skipHash?: boolean
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
  if (!isSupportedRuntimeFormat(manifest.runtime, manifest.format)) {
    return 'unsupported'
  }
  // A model can be several files (GGUF + mmproj; GGUF + the `files:` list's shards, #310);
  // install state requires EVERY one present + verified (image-understanding plan §8.2).
  // A single-file model has exactly one entry, so this loop is byte-identical for it.
  const files = manifestFiles(rootPath, manifest)
  for (const f of files) {
    if (!existsSync(f.path)) return 'missing'
  }

  // A placeholder hash can never verify, so hashing the (multi-GB) file would be pure
  // wasted I/O — decide from the manifest alone. Outside developer mode an unverifiable
  // file is treated as a checksum failure (spec §7.4 gate); in developer mode it counts
  // as installed. With two files, any placeholder hash short-circuits the same way.
  if (files.some((f) => !isRealSha256(f.sha))) {
    return opts.developerMode ? 'installed' : 'checksum_failed'
  }

  // RT-3: on the lazy (chat) path, report a present weight as installed without hashing —
  // unless a live cache hit can answer for ALL files for free. The start gate re-verifies the
  // launched model, so an unhashed-but-present non-active model is display-only here.
  if (opts.skipHash && !files.every((f) => cachedHashFor(f.path, opts.hashStore))) {
    return 'installed'
  }

  // Verify each file, accumulating the progress byte offset across files so the first-run
  // bar advances monotonically (a cached file contributes 0 bytes and fires no progress).
  let hashedBase = 0
  for (const f of files) {
    const willHash = isRealSha256(f.sha) && !cachedHashFor(f.path, opts.hashStore)
    const check = await verifyChecksum(
      f.path,
      f.sha,
      opts.hashStore,
      willHash && opts.onProgress ? (b) => opts.onProgress!(hashedBase + b) : undefined,
      { modelId: manifest.id, file: f.kind }
    )
    if (check.matched === false) return 'checksum_failed'
    if (willHash) {
      try {
        hashedBase += statSync(f.path).size
      } catch {
        /* file vanished mid-verify — the next existsSync pass will report it missing */
      }
    }
  }
  return 'installed'
}

/**
 * Will `computeInstallState` actually hash this weight (a real, present, non-cached file
 * with a real expected hash)? Used by `buildModelList`'s pre-pass to compute the
 * verification bar's byte denominator WITHOUT hashing — a cheap `statSync` + cache lookup.
 * Returns the file size to hash, or `0` when the file will be skipped (missing, cached,
 * placeholder hash, unsupported).
 */
function pendingHashBytes(
  manifest: ModelManifest,
  rootPath: string,
  opts: { developerMode: boolean; hashStore?: HashStore }
): number {
  if (!isSupportedRuntimeFormat(manifest.runtime, manifest.format)) return 0
  let files: Array<{ path: string; sha: string }>
  try {
    files = manifestFiles(rootPath, manifest)
  } catch {
    return 0 // an escaping local_path/mmproj path never reaches a hash
  }
  // Any placeholder hash makes `computeInstallState` short-circuit before verifying ANY
  // file — so nothing hashes this pass.
  if (files.some((f) => !isRealSha256(f.sha))) return 0
  let total = 0
  for (const f of files) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(f.path)
    } catch {
      return 0 // a missing file → 'missing' before any verify
    }
    // A live cache hit (memory or store, matching size+mtime) means this file won't hash.
    const hit = hashCache.get(f.path)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) continue
    const persisted = opts.hashStore?.get(f.path)
    if (persisted && persisted.size === st.size && persisted.mtimeMs === st.mtimeMs) continue
    total += st.size
  }
  return total
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
 * Measured-speed signal fed into the picker (model-benchmarks.md §6.5, issue #95): the
 * Diagnostics probe's honest pairing (issue #52) — the measured tok/s AND the model that
 * produced it. Absent/null anywhere → the pure RAM-best-fit path, byte-identical.
 *
 * Basis (#291): since 2026-09-04 the figure is the runtime's decode-only `predicted_per_second`
 * (tokens, prefill excluded) whenever the runtime sent `timings`, else the old prefill-inclusive
 * chunk rate. `SLOW_PICK_TOKENS_PER_SECOND` was calibrated on the chunk basis and deliberately
 * NOT retuned — a decode-only figure reads higher, and the gate is an order-of-magnitude crawl
 * test (model-benchmarks.md §6.5 "Basis note").
 */
export interface PickerSpeedSignal {
  /** Measured tok/s from the loaded-model probe; null when the probe did not run. */
  tokensPerSecond: number | null
  /** Id of the model the probe streamed through; null/unresolvable → no signal. */
  measuredModelId?: string | null
}

/** A loaded-model probe STRICTLY below this steps the recommendation down one size tier
 *  (model-benchmarks.md §6.5). Distinct from `VERY_LOW_TOKENS_PER_SECOND` (3), which steps
 *  the legacy PROFILE down — the two thresholds serve different surfaces on purpose. The value
 *  is `shared/performance-rules.ts`' `SLOW_TOKENS_PER_SECOND` (PR #303 audit N3): the
 *  Performance screen's "Slow" speed rating is this very gate, never a re-typed copy. */
export const SLOW_PICK_TOKENS_PER_SECOND = SLOW_TOKENS_PER_SECOND

/** The comfortable-stage ordering (§6.2): capacity first, then rank, then disk size. */
function comfortableOrder(a: ModelManifest, b: ModelManifest): number {
  return (
    b.recommendedRamGb - a.recommendedRamGb ||
    b.recommendationRank - a.recommendationRank ||
    b.sizeOnDiskGb - a.sizeOnDiskGb
  )
}

/** The stage pool (§6.3 ranked-only guard): ranked fits only, unless nothing ranked fits. */
function preferRanked(fits: ModelManifest[]): ModelManifest[] {
  const ranked = fits.filter((m) => m.recommendationRank > 0)
  return ranked.length > 0 ? ranked : fits
}

/**
 * §6.5 step-down: apply the measured-speed signal to a COMFORTABLE-stage pick. The crawl is
 * a valid signal only when the measured model resolves among the role's candidates with a
 * `recommendedRamGb` at or below the pick's (an oversized loaded model is expected to crawl
 * — the #52 lesson — and must never move the pick). The step re-runs the comfortable stage
 * below the pick's whole capacity band over RANKED models only, so it can never land on a
 * rank-0 model; with no lower ranked tier, the original pick stays.
 *
 * `eligible` (the card path, §6.6 rule C step 3; PR #308 audit R1/R2): when given, the measured
 * model counts only if it is in the pick's eligible pool (fits the card AND passes the RAM
 * floor — a crawl on a model the card cannot hold says nothing about a model it can), and the
 * destination must itself be eligible, else the pick stays. Omitted (the RAM path) → the
 * pre-#308 predicate, byte-identical.
 */
function applySpeedSignal(
  candidates: ModelManifest[],
  pick: ModelManifest,
  signal: PickerSpeedSignal | null | undefined,
  eligible?: (m: ModelManifest) => boolean
): ModelManifest {
  if (!signal) return pick
  const tps = signal.tokensPerSecond
  if (tps == null || tps <= 0 || tps >= SLOW_PICK_TOKENS_PER_SECOND) return pick
  const measured = signal.measuredModelId
    ? candidates.find((m) => m.id === signal.measuredModelId)
    : undefined
  if (!measured) return pick
  if (measured.recommendedRamGb > pick.recommendedRamGb) return pick
  if (eligible && !eligible(measured)) return pick
  const lower = candidates
    .filter((m) => m.recommendationRank > 0 && m.recommendedRamGb < pick.recommendedRamGb)
    .filter((m) => !eligible || eligible(m))
    .sort(comfortableOrder)
  return lower[0] ?? pick
}

/**
 * RAM-best-fit recommendation: the LARGEST model whose comfortable RAM
 * (`recommended_ram_gb`) fits this machine; if nothing fits comfortably, the lightest
 * model that at least meets its minimum (`recommended_min_ram_gb`); else null. Replaces
 * the profile-table lookup as the primary recommendation — "which model?" is a RAM
 * question first, and this can never recommend a model the RAM gate disables.
 *
 * QUALITY-AWARE TIEBREAK (model-benchmarks.md §6.2): among models that tie on the
 * capacity fit (same comfortable RAM, or same minimum), prefer the higher
 * `recommendationRank` — the benchmark verdict — BEFORE falling back to disk size. Without
 * ranks (all 0) this is exactly the old biggest-disk behaviour, so legacy callers are
 * unchanged; with ranks the picker stops recommending a benchmark loser (e.g. Granite) over a
 * winner (Ministral) just because it is larger on disk.
 *
 * RANKED-ONLY GUARD (model-benchmarks.md §6.3, issue #48): within each stage, a rank-0
 * model (never benchmarked, or a benchmark loser — §9 grants ranks only after the local
 * eval) is considered ONLY when no ranked model fits that stage at all. Rank is a
 * within-tier tiebreak, not a cross-tier score, so the capacity-first ordering stays —
 * but a bigger-on-disk, never-evaled model can no longer hijack the recommendation from
 * a benchmarked winner by capacity alone. A role whose catalog carries no ranks at all
 * (e.g. embeddings) is unchanged.
 *
 * SPEED-SIGNAL STEP-DOWN (model-benchmarks.md §6.5, issue #95): an optional measured-speed
 * signal steps a comfortable-stage pick down ONE capacity tier when the probe crawled
 * (strictly under `SLOW_PICK_TOKENS_PER_SECOND`) on a right-sized model (predicate in
 * `applySpeedSignal`). Stateless and single-step: the base pick is recomputed from RAM
 * alone on every call, so downgrades never compound. A runnable-stage (fallback) pick
 * never steps — it is already the lightest honest answer. Omitted signal → prior behavior,
 * byte-identical.
 */
export function recommendModelIdByRam(
  manifests: ModelManifest[],
  ramGb: number,
  role: ModelRole = 'chat',
  speedSignal?: PickerSpeedSignal | null
): string | null {
  if (!Number.isFinite(ramGb) || ramGb <= 0) return null
  const candidates = manifests.filter((m) => m.role === role)

  const comfortable = preferRanked(
    candidates.filter((m) => m.recommendedRamGb <= ramGb)
  ).sort(comfortableOrder)
  if (comfortable.length > 0) {
    return applySpeedSignal(candidates, comfortable[0], speedSignal).id
  }

  const runnable = preferRanked(
    candidates.filter((m) => m.recommendedMinRamGb <= ramGb)
  ).sort(
    (a, b) =>
      a.recommendedMinRamGb - b.recommendedMinRamGb ||
      b.recommendationRank - a.recommendationRank ||
      a.sizeOnDiskGb - b.sizeOnDiskGb
  )
  return runnable[0]?.id ?? null
}

// ---- Graphics-memory-aware pick (model-benchmarks.md §6.6; rule C since the PR #308 audit,
// 2026-09-06 — decisions 1, 2, 4, 7, 10, 11). Raw MiB throughout (decision 7): the probe reports
// MiB, the estimate is in MiB, nothing is rounded to a nominal tier; labels round on their own.

/** llama.cpp's `--fit-target` default: the margin the fit keeps free on the card, MiB. */
export const VRAM_FIT_MARGIN_MIB = 1024
/** Working (compute) buffers the runtime reserves beside the weights, as a share of the weights
 *  (the rig's 27B measured 2.8 GiB on 18.4 GiB of weights at a 2048-token batch, ~15 %). */
export const VRAM_WORKING_SHARE = 0.15
/**
 * The context-cache term for a manifest that carries no `estimated_context_cache_gib`, GiB
 * (8k tokens on a 27B measured 0.5 under an earlier launch; decision 11 makes the figure
 * per-model — the seven decision models carry config-derived values, everything else defaults).
 */
export const VRAM_DEFAULT_CONTEXT_CACHE_GIB = 0.5
/**
 * The idle desktop use a card is assumed to carry when the probe reports no free figure, MiB
 * (decision 10: `budget = freeMb ?? totalMb − 1024`; the public `--list-devices` lines in the
 * audit's D3 table show 0.6–1.5 GiB in use on an idle Windows desktop). NOT the fit margin above
 * — that one is the runtime's own reservation and applies on top of the budget.
 */
export const GRAPHICS_IDLE_ALLOWANCE_MIB = 1024

/**
 * The manifest's decimal "size on disk" (GB, 1e9) as UNROUNDED MiB — the unit the probe reports
 * in. Shared with the Performance screen's pre-start estimate (`placementVerdict`, decision 8) so
 * the two surfaces cannot disagree by a rounding step.
 */
export function weightsMib(m: ModelManifest): number {
  return (m.sizeOnDiskGb * 1e9) / 1024 ** 2
}

/**
 * What the runtime needs on the card to hold EVERY layer of this model, MiB: the weights, the
 * working buffers beside them (15 %), the context cache at the model's recommended window under
 * the app's launch (the manifest's `estimated_context_cache_gib`, else 0.5 GiB), and the fit's
 * own 1 GiB margin. The measured check behind the terms: Gemma 4 12B peaked at 9,720 MiB on the
 * rig (6,653 weights + 2,432 cache + ~635 compute); this reads 11,159 with the margin.
 */
export function estimateGraphicsNeedMib(m: ModelManifest): number {
  const w = weightsMib(m)
  const cacheGib = m.estimatedContextCacheGib ?? VRAM_DEFAULT_CONTEXT_CACHE_GIB
  return w * (1 + VRAM_WORKING_SHARE) + cacheGib * 1024 + VRAM_FIT_MARGIN_MIB
}

/** Would every layer of this model land on a card offering `budgetMib` (see `graphicsBudgetMib`)? */
export function fitsGraphicsMemory(m: ModelManifest, budgetMib: number): boolean {
  return estimateGraphicsNeedMib(m) <= budgetMib
}

/**
 * The graphics-memory BUDGET the fit is judged against (decision 10): the probe's free figure
 * for the budget device — what llama.cpp's own fit targets (`free − margin`) — or, when the probe
 * carries no free figure, the total less the idle-desktop allowance. Null with no device. Both
 * seams (`pickerMemoryFor` for the Models ★, `probeAndPersistGpu` for the benchmark) call this
 * one function so they can never disagree on the figure.
 */
export function graphicsBudgetMib(device: Pick<GpuDevice, 'totalMb' | 'freeMb'> | null | undefined): number | null {
  if (!device) return null
  const free: unknown = device.freeMb
  if (typeof free === 'number' && Number.isFinite(free)) return free
  return device.totalMb - GRAPHICS_IDLE_ALLOWANCE_MIB
}

/** Rule C's fallback order among ELIGIBLE models: rank first, then comfortable tier, then size. */
function eligibleOrder(a: ModelManifest, b: ModelManifest): number {
  return (
    b.recommendationRank - a.recommendationRank ||
    b.recommendedRamGb - a.recommendedRamGb ||
    b.sizeOnDiskGb - a.sizeOnDiskGb
  )
}

/**
 * Graphics-memory-aware recommendation — RULE C (model-benchmarks.md §6.6 as amended by the
 * PR #308 audit, decision 1). On a computer whose next start uses a discrete card:
 *
 *   1. `base` = the RAM pick, computed WITHOUT the speed signal (`recommendModelIdByRam`, its
 *      stage logic untouched — the tier ratifications are the RAM picker's).
 *   2. eligible(m) = fits the card (`fitsGraphicsMemory` at `budgetMib`) AND passes the RAM floor
 *      (`recommended_min_ram_gb` ≤ RAM; the Models screen refuses to start a model over it, and
 *      the pick must never point at a refused model). Unknown RAM keeps the floor open, as the
 *      pre-rule-C card path did. `candidate = base` when base is eligible — the established
 *      recommendation stands wherever the card can hold it (decision 2: the 9B, not Gemma 12B,
 *      where both fit). Otherwise `candidate` = the highest-RANKED eligible model, ties by
 *      comfortable tier then size — ranked models ONLY (a rank-0 model is never the automatic
 *      pick, #326). Otherwise (no ranked model eligible: a small or nearly full card beside a big
 *      catalog) `candidate = base` — the documented no-fit fallback:
 *      the RAM pick partially offloads, which is still the catalog's best answer.
 *   3. The §6.5 speed step-down applies ONCE, to `candidate`, restricted to the eligible pool on
 *      both ends (`applySpeedSignal` with `eligible`): a crawl measured on a model the card cannot
 *      hold never lowers a fitting pick (R2), and the step never lands on a model that fails the
 *      RAM floor or the card (R1). A no-fit fallback therefore never steps — nothing eligible
 *      exists to step to.
 *
 * Unknown / non-positive budget → the RAM path with the signal, exactly as before. Unified and
 * cpu classes never reach this function (`recommendChatModelId`), so their picks are unchanged.
 */
export function recommendModelIdByVram(
  manifests: ModelManifest[],
  budgetMib: number,
  ramGb: number,
  role: ModelRole = 'chat',
  speedSignal?: PickerSpeedSignal | null
): string | null {
  if (!Number.isFinite(budgetMib) || budgetMib <= 0) return recommendModelIdByRam(manifests, ramGb, role, speedSignal)
  const candidates = manifests.filter((m) => m.role === role)
  const ramKnown = Number.isFinite(ramGb) && ramGb > 0
  const eligible = (m: ModelManifest): boolean =>
    fitsGraphicsMemory(m, budgetMib) && (!ramKnown || m.recommendedMinRamGb <= ramGb)

  const baseId = recommendModelIdByRam(manifests, ramGb, role)
  const base = baseId ? candidates.find((m) => m.id === baseId) : undefined
  let candidate: ModelManifest | undefined
  if (base && eligible(base)) {
    candidate = base
  } else {
    // STRICTLY ranked (owner decision 2026-09-06, issue #326): a rank-0 model is never the
    // automatic pick (model-policy.md), so when no RANKED model fits the card the no-fit
    // fallback below applies — the RAM pick, partially offloaded — rather than a rank-0 fit.
    const pool = candidates.filter((c) => c.recommendationRank > 0 && eligible(c)).sort(eligibleOrder)
    candidate = pool[0] ?? base
  }
  if (!candidate) return null
  return applySpeedSignal(candidates, candidate, speedSignal, eligible).id
}

/** What the chat picker needs to know about the computer's memory (benchmark.md "Your model"). */
export interface PickerMemory {
  memoryClass: MemoryClass
  /** Whole GB, as `machineRamGb()` reports it. */
  ramGb: number
  /**
   * The graphics-memory budget of the next start's card in raw MiB — `graphicsBudgetMib` of the
   * budget device (`nextStartMemory`): the probe's free figure, else total − 1024 — or null when
   * there is no card / the figure is unknown (→ the RAM pick).
   */
  budgetMb: number | null
}

/**
 * The chat recommendation for this computer: rule C against the card's budget on a discrete
 * card, by RAM on unified memory (one pool) and on a machine without a usable card.
 */
export function recommendChatModelId(
  manifests: ModelManifest[],
  memory: PickerMemory,
  speedSignal?: PickerSpeedSignal | null
): string | null {
  if (memory.memoryClass === 'discrete' && memory.budgetMb != null && memory.budgetMb > 0) {
    return recommendModelIdByVram(manifests, memory.budgetMb, memory.ramGb, 'chat', speedSignal)
  }
  return recommendModelIdByRam(manifests, memory.ramGb, 'chat', speedSignal)
}

function toModelInfo(
  manifest: ModelManifest,
  state: ModelState,
  recommended: boolean,
  startableAsMock: boolean,
  insufficientRam: boolean
): ModelInfo {
  // Surface the manifest's optional download block: the renderer's per-download
  // confirmation needs size, URL, license link, and whether an explicit license
  // acknowledgement is required (license_review not approved).
  const download: ModelDownloadInfo | undefined = manifest.download
    ? {
        url: manifest.download.url,
        sizeBytes: manifest.download.sizeBytes,
        licenseUrl: manifest.download.licenseUrl,
        licenseApproved: manifest.licenseReview.status === 'approved',
        // #196: a known-dead upstream source. Surfaced so the card explains WHY there is no
        // Download button, instead of offering one that can only end in an HTTP 404.
        ...(manifest.download.withdrawn ? { withdrawn: manifest.download.withdrawn } : {})
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
  /**
   * Measured-speed signal from the persisted Diagnostics benchmark (model-benchmarks.md
   * §6.5, issue #95), fed into the CHAT recommendation only (the probe streams through a
   * chat model; the embeddings pick never moves on it). Absent/null → pure RAM-best-fit,
   * byte-identical to the pre-#95 behavior.
   */
  speedSignal?: PickerSpeedSignal | null
  /**
   * The computer's memory class for the NEXT start and the budget device's graphics-memory
   * budget in raw MiB (`graphicsBudgetMib`: the probe's free figure, else total − 1024; §6.6
   * rule C, PR #308 audit decisions 9/10). On a discrete card the chat pick is rule C against
   * the budget; unified / cpu keep the RAM pick. Omitted → the RAM pick (legacy callers and
   * tests unchanged). Both come from `pickerMemoryFor` in registerModelIpc.ts, the same
   * decision the benchmark makes.
   */
  memoryClass?: MemoryClass
  graphicsBudgetMb?: number | null
  /**
   * Optional verification-progress sink. Called once per model that will be hashed (with
   * a 1-based step index + the byte-weighted overall totals), throttled within a file by
   * `sha256File`, plus a terminal `done` event. `overallBytesTotal === 0` ⇒ nothing to
   * hash this pass (all cached) and NO events are emitted. Omitted ⇒ no overhead.
   */
  onProgress?: (p: ModelVerifyProgress) => void
  /**
   * RT-3 lazy verification (the chat path). When this property is PRESENT, only the model
   * whose id matches is hashed on a cold cache; every other present weight is reported
   * `installed` without hashing (display-only — the start gate re-verifies what it
   * launches). Pass the active model id (or `null` to hash nothing) on the chat path; OMIT
   * the property entirely (the default) on an explicit Models-screen visit to hash the full
   * set. Distinguishes "lazy, no active model" (`null`) from "full hash" (absent).
   */
  onlyVerifyModelId?: string | null
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
  // RAM-gated model); the profile-table lookup remains the legacy/no-RAM path. The §6.5
  // speed signal applies to the chat pick only.
  const recommendedChat =
    ram != null
      ? recommendChatModelId(
          all,
          { memoryClass: opts.memoryClass ?? 'cpu', ramGb: ram, budgetMb: opts.graphicsBudgetMb ?? null },
          opts.speedSignal
        )
      : recommendModelId(all, opts.profile, 'chat')
  const recommendedEmbed =
    ram != null
      ? recommendModelIdByRam(all, ram, 'embeddings')
      : recommendModelId(all, opts.profile, 'embeddings')

  // RT-3 lazy mode: when `onlyVerifyModelId` is present, hash only that model; report every
  // other present weight without hashing. `'onlyVerifyModelId' in opts` distinguishes a
  // provided `null` (lazy, no active model → hash nothing) from an absent property (full).
  const lazyVerify = 'onlyVerifyModelId' in opts
  const skipHashFor = (id: string): boolean => lazyVerify && id !== opts.onlyVerifyModelId

  // Verification-progress pre-pass (no hashing): which models will actually be hashed,
  // and the total bytes — the byte denominator for a determinate first-run bar. Cheap
  // (statSync + cache lookup per weight). Skipped entirely when no sink is wired.
  const willHash = opts.onProgress
    ? manifests.map(({ manifest }) =>
        skipHashFor(manifest.id)
          ? 0
          : pendingHashBytes(manifest, opts.rootPath, {
              developerMode: opts.developerMode,
              hashStore: opts.hashStore
            })
      )
    : []
  const overallBytesTotal = willHash.reduce((a, b) => a + b, 0)
  const hashCount = willHash.filter((b) => b > 0).length
  let completedBytes = 0 // bytes from already-finished models this pass
  let stepIndex = 0 // 1-based step among the models that hash
  // The byte-weighted denominator is only honest when there is work to do; with nothing
  // to hash (everything cached) we emit no events and the renderer shows no bar.
  const emit = opts.onProgress && overallBytesTotal > 0 ? opts.onProgress : undefined
  // Tags every event of THIS pass so the renderer can lock onto one when passes overlap.
  const runId = emit ? randomUUID() : ''

  const models: ModelInfo[] = []
  for (let i = 0; i < manifests.length; i++) {
    const { manifest } = manifests[i]
    const thisHashes = willHash[i] > 0
    if (emit && thisHashes) stepIndex++
    const stepAt = stepIndex // capture for this model's throttled callbacks
    let state: ModelState
    try {
      state = await computeInstallState(manifest, opts.rootPath, {
        developerMode: opts.developerMode,
        hashStore: opts.hashStore,
        skipHash: skipHashFor(manifest.id),
        onProgress:
          emit && thisHashes
            ? (bytesHashed) =>
                emit({
                  runId,
                  modelIndex: stepAt,
                  modelCount: hashCount,
                  modelId: manifest.id,
                  displayName: manifest.displayName,
                  overallBytesHashed: completedBytes + bytesHashed,
                  overallBytesTotal,
                  done: false
                })
            : undefined
      })
    } catch (err) {
      // ONE manifest must never break the whole Models list. validateManifest now rejects an
      // escaping local_path up front, but a manifest that still throws here (e.g. a future
      // safeDrivePath case, or an I/O error) is recorded and SKIPPED rather than rejecting the
      // entire `IPC.listModels` handler — mirroring the pendingHashBytes() pre-pass, which
      // already tolerates the same throw, and discoverManifests' error channel (vuln-scan
      // 2026-06-21 [uncaught-exception-dos]).
      errors.push(`${manifest.id}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (emit && thisHashes) completedBytes += willHash[i]
    if (opts.runningModelId && manifest.id === opts.runningModelId && state === 'installed') {
      state = 'running'
    }
    const recommended =
      manifest.id === recommendedChat || manifest.id === recommendedEmbed
    // Zero-weights first run: a missing CHAT model may start the built-in mock
    // when the caller's (policy-gated) developer leniency is on. Computed here so the
    // renderer renders an affordance the MAIN process actually allows.
    const startableAsMock =
      state === 'missing' && manifest.role === 'chat' && opts.developerMode
    const insufficientRam = ram != null && manifest.recommendedMinRamGb > ram
    models.push(toModelInfo(manifest, state, recommended, startableAsMock, insufficientRam))
  }
  // Terminal event so the bar settles to 100% even if the last throttled callback landed
  // a chunk short of the total.
  if (emit) {
    emit({
      runId,
      modelIndex: hashCount,
      modelCount: hashCount,
      modelId: '',
      displayName: '',
      overallBytesHashed: overallBytesTotal,
      overallBytesTotal,
      done: true
    })
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
 * Reranker/transcriber models are availability-driven (they activate when binary +
 * weights exist) — there is no settings slot for them, and a role-else-chat fallback
 * would write a transcriber id into `activeModelId` (the CHAT slot) and break chat.
 * Refuse with friendly copy instead.
 */
export function selectModel(db: Db, manifestsDir: string, modelId: string): SelectResult {
  const { manifests } = discoverManifests(manifestsDir)
  const found = manifests.find((m) => m.manifest.id === modelId)
  if (!found) throw new Error(`Unknown model id: ${modelId}`)

  if (found.manifest.role !== 'chat' && found.manifest.role !== 'embeddings') {
    throw new Error(tMain('main.models.autoSelected'))
  }
  const patch =
    found.manifest.role === 'embeddings'
      ? { activeEmbeddingModelId: modelId }
      : { activeModelId: modelId }
  updateSettings(db, patch)
  const s = getSettings(db)
  return { activeModelId: s.activeModelId, activeEmbeddingModelId: s.activeEmbeddingModelId }
}
