import type { Db } from './db'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types'

/** Upper bound on any persisted string[] setting so a buggy/hostile renderer can't bloat the
 *  encrypted settings blob (`skillInfoSeen` is the shipping case; the element-wise validation
 *  below stays generic for future ones). */
const MAX_SETTINGS_ARRAY = 10_000

/** Bounds for the null-default settings keys (BE-1, full-audit 2026-07-10). Their defaults
 *  carry no type information (they are null), so the generic type gate in `updateSettings`
 *  cannot check them — each gets an explicit shape check, and the string ones a length cap in
 *  the SEC-1 bounding style so a buggy/hostile renderer can't bloat the encrypted settings
 *  blob. Generous on purpose: model ids are short slugs; `gpuLastError` is a one-line
 *  timestamped reason (`persistGpuFailure` truncates it to 2 000 chars before it gets here). */
export const MAX_SETTINGS_ID_LENGTH = 512
export const MAX_SETTINGS_ERROR_LENGTH = 4096

/** Serialized-JSON ceiling for the object-valued settings (`checksumCache` map, plus the
 *  `lastBenchmark`/`gpuProbe` result blobs). These are read on start/hot paths and persist into
 *  the encrypted settings blob; the shape gates in `updateSettings` check only the top-level type,
 *  so a buggy/hostile renderer could otherwise bloat the blob without bound (CODE-16,
 *  full-audit 2026-07-11). 256 KB dwarfs a real benchmark/probe blob and a large checksum map
 *  (~120 B/entry ⇒ ~2 000 weights) — an over-cap payload is dropped, SEC-1 bounding style. */
export const MAX_SETTINGS_OBJECT_BYTES = 256 * 1024

/** Floor for `contextTokens` (HIGH_BUG vuln-scan-2026-06-21). The doc-task window budget is
 *  derived from this; below this floor the summary-tree builder's per-level node summaries can
 *  exceed a single budget window and the build cannot reduce. 2048 always fits >= 2 node
 *  summaries (each <= SUMMARY_OUTPUT_TOKENS) plus the prompt/output reserve in one reduce
 *  window. A renderer-supplied value below it is clamped UP, never dropped. */
const MIN_CONTEXT_TOKENS = 2048

/** Ceiling for the user's `contextTokensOverride` (AI Model screen context-size picker). The KV
 *  cache grows linearly with the window, so very large picks cost real memory — but a hard 32k
 *  cap dead-ended long-document workflows (deep index, whole-doc summaries) on models whose
 *  native window is far larger (issue #43: Qwen3.5 is 262k native). 128k covers every preset
 *  the UI offers; the picker pairs the big rungs with an honest memory warning instead of a
 *  silent cap, and a start that doesn't fit falls down the GPU ladder to CPU or fails with a
 *  friendly error rather than wedging the app. */
export const MAX_CONTEXT_TOKENS_OVERRIDE = 131_072

// Settings persistence on top of the key/value `settings` table (spec §8).
// Each AppSettings field is stored as its own row so partial updates are clean.
// The table lives inside the workspace database, so on an encrypted workspace the
// settings are encrypted at rest and unreadable before unlock.

export function getSettings(db: Db): AppSettings {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as Array<{
    key: string
    value_json: string
  }>
  const stored: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value_json)
    } catch {
      /* ignore malformed rows */
    }
  }
  // Merge stored values over defaults so new fields always have a value.
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<AppSettings>) }
}

export function updateSettings(db: Db, patch: Partial<AppSettings>): AppSettings {
  const now = new Date().toISOString()
  const upsert = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    // The patch crosses the IPC boundary from the renderer: persist only KNOWN settings
    // keys. `null` is accepted ONLY for keys whose default is null (that is how e.g. the
    // active model is cleared) — anywhere else it would shadow a non-nullable default
    // (`checksumCache: null` broke every checksum reader — BE-1, full-audit 2026-07-10).
    // Non-null values must match the default's primitive type; the null-default keys carry
    // no type information in DEFAULT_SETTINGS, so each gets an explicit shape check
    // (bounded string / plain object; `contextTokensOverride` has its own clamp below).
    // Unknown/mistyped entries are dropped.
    if (!(key in DEFAULT_SETTINGS)) continue
    const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]
    if (value === null) {
      if (def !== null) continue
    } else if (def !== null) {
      if (typeof value !== typeof def) continue
    } else if (key === 'activeModelId' || key === 'activeEmbeddingModelId') {
      if (typeof value !== 'string' || value.length > MAX_SETTINGS_ID_LENGTH) continue
    } else if (key === 'gpuLastError') {
      if (typeof value !== 'string' || value.length > MAX_SETTINGS_ERROR_LENGTH) continue
    } else if (key === 'lastBenchmark' || key === 'gpuProbe') {
      if (typeof value !== 'object' || Array.isArray(value)) continue
    }
    // Bound the object-valued settings (CODE-16, full-audit 2026-07-11). `checksumCache` has a
    // non-null object default, so an ARRAY slips through the generic `typeof value !== typeof def`
    // gate above (arrays report `object`) — reject it here; the null-default `lastBenchmark`/
    // `gpuProbe` pair reject arrays above, so this re-check is harmless for them. Then cap the
    // SERIALIZED size of all three (SEC-1 bounding style) so a renderer can't bloat the encrypted
    // blob these start-hot readers touch. `value === null` (a legitimate clear of the null-default
    // pair) is accepted upstream and never reaches here.
    if ((key === 'lastBenchmark' || key === 'gpuProbe' || key === 'checksumCache') && value !== null) {
      if (typeof value !== 'object' || Array.isArray(value)) continue
      if (JSON.stringify(value).length > MAX_SETTINGS_OBJECT_BYTES) continue
    }
    // Array-typed defaults (any future `string[]` setting) pass the
    // `typeof === 'object'` check above, so validate them element-wise: require an actual
    // array, keep only string elements, and cap the length (SEC-1) — mirroring the
    // `safeIdArray`/`parseDocumentScope` pattern so a non-array/oversized renderer value is
    // never persisted verbatim into the encrypted blob.
    let toStore: unknown = value
    if (Array.isArray(def)) {
      if (!Array.isArray(value)) continue
      toStore = (value as unknown[]).filter((x) => typeof x === 'string').slice(0, MAX_SETTINGS_ARRAY)
    }
    // Enum-valued keys get an exact-value check (a renderer bug must not persist junk
    // like `gpuMode: 'banana'` — readers treat anything !== 'auto' as off, which fails
    // safe, but junk must not be stored either).
    // contextTokens floor: clamp UP a too-small value so the doc-task budget can never drop
    // below a single summary's size (else the tree builder cannot reduce — HIGH_BUG). A
    // non-finite value falls back to the floor rather than persisting NaN.
    if (key === 'contextTokens') {
      const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : MIN_CONTEXT_TOKENS
      toStore = Math.max(MIN_CONTEXT_TOKENS, n)
    }
    // contextTokensOverride: null = automatic (model default) and stores as-is. A number is
    // clamped into [MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS_OVERRIDE] — the same tree-builder
    // floor as contextTokens (the override becomes the doc-task window when it launches the
    // runtime) plus a RAM-safety ceiling. The default is null, so the generic type check above
    // passes ANY value for this key — reject non-numeric junk here instead of storing it.
    if (key === 'contextTokensOverride' && value !== null) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      toStore = Math.min(MAX_CONTEXT_TOKENS_OVERRIDE, Math.max(MIN_CONTEXT_TOKENS, Math.floor(value)))
    }
    if (key === 'gpuMode' && value !== 'auto' && value !== 'off') continue
    if (key === 'theme' && value !== 'system' && value !== 'light' && value !== 'dark') continue
    if (key === 'uiLanguage' && value !== 'system' && value !== 'en' && value !== 'de') continue
    upsert.run(key, JSON.stringify(toStore), now)
  }
  return getSettings(db)
}

/** Seed defaults on first run (writes only when the table is empty; keys added in
 *  later versions are filled at read time by `getSettings`'s defaults merge). */
export function seedSettings(db: Db): AppSettings {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }
  if (existing.n === 0) {
    return updateSettings(db, DEFAULT_SETTINGS)
  }
  return getSettings(db)
}
