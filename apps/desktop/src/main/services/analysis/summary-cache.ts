import type { Db } from '../db'
import { log } from '../logging'

// Summary-cache eviction (backend-audit-2026-06-27 DATA-3 / MAINT-3).
//
// `summary_cache` (db.ts) maps a tree group's content hash → its computed summary so a
// rebuild — or a different document with identical boilerplate — skips the chat call. It
// carries NO document_id and deliberately survives node/tree/document deletion (no FK ever
// prunes it), so on a long-lived portable drive it grew without bound: the audit's DATA-3.
//
// Policy (kept deliberately cheap — a low-priority housekeeping item): a ROW-COUNT cap.
// When the table exceeds the cap we delete the OLDEST rows (by `created_at`) back down to it —
// an age-ordered, LRU-ish cap (we don't track last-access, so creation time is the proxy).
// It is a CACHE: an evicted row only costs a future re-summarize, never data loss. Called
// opportunistically once per tree build (amortizing the COUNT over the whole build, not per
// row inserted) — see `buildTree`.
//
// Privacy / offline posture: `summary_text` is content-class. Eviction deletes ROWS only — it
// never reads, logs, or audits the text. The only thing surfaced is the integer evicted-row
// count (content-free diagnostics), and the local log line carries counts only. No telemetry.

/**
 * Default row cap. Sized so a very large library stays fully cached (a 1000-chunk document
 * builds at most a few thousand cache rows) while the table can never grow without bound.
 * Override with `HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS` (a positive integer) for tuning/tests.
 */
export const SUMMARY_CACHE_MAX_ROWS = 50_000

/** Session-cumulative count of evicted rows — the content-free diagnostics counter (DATA-3). */
let evictedThisSession = 0

/** How many `summary_cache` rows eviction has pruned this session (diagnostics; never reset). */
export function summaryCacheEvictedThisSession(): number {
  return evictedThisSession
}

/** Resolve the effective cap: an explicit override, else the env tuning knob, else the default. */
function resolveMaxRows(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override)
  }
  const env = Number(process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS)
  if (Number.isFinite(env) && env > 0) return Math.floor(env)
  return SUMMARY_CACHE_MAX_ROWS
}

/**
 * Prune `summary_cache` down to `maxRows` by deleting the OLDEST rows (`created_at` ascending,
 * `content_hash` as a stable tiebreak). Returns the number of rows evicted (0 when at/under the
 * cap). Cheap: one COUNT, then a single bounded DELETE only when over the cap — so the common
 * warm-but-under-cap build pays just the COUNT. Never throws on a content error: it touches no
 * summary text, only row counts.
 */
export function evictSummaryCache(db: Db, maxRows?: number): number {
  const cap = resolveMaxRows(maxRows)
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM summary_cache').get() as { n: number }
  if (n <= cap) return 0
  const excess = n - cap
  const res = db
    .prepare(
      `DELETE FROM summary_cache WHERE rowid IN (
         SELECT rowid FROM summary_cache ORDER BY created_at ASC, content_hash ASC LIMIT ?
       )`
    )
    .run(excess)
  const evicted = Number(res.changes ?? 0)
  if (evicted > 0) {
    evictedThisSession += evicted
    // Counts only (no content): the local diagnostics surface for the eviction policy.
    log.info('Summary cache pruned', { evicted, kept: cap, sessionTotal: evictedThisSession })
  }
  return evicted
}
