import type {
  CoverageInfo,
  EvidenceFreshnessComparison,
  EvidenceReviewFreshness,
  EvidenceSourceFreshness,
  EvidenceSourceFreshnessState,
  EvidenceSourceSnapshot
} from '../../../shared/types'
import { prepareCached, type Db } from '../db'
import { parseCoverage } from '../chat'
import { parseSourceSnapshots } from '../evidence-reviews'
import { sha256Of } from '../assets'

// Evidence-review freshness engine (EP-1 plan §9.1, spec §21.2/§18.4/§15.4–15.5): compare
// one review's FROZEN snapshot against the CURRENT workspace, from STORED facts ONLY —
//   - document existence: the snapshotted `documentId` against the `documents` row
//     (unresolved-identity snapshots are NEVER compared — they stay 'unverifiable', which
//     can never escalate to 'changed'; plan §14 P3 watch-out, binding);
//   - document content: the snapshotted `documentSha256` against the CURRENT stored
//     `documents.sha256` — spec §21.2 hard rule: NO re-hashing, no file I/O against source
//     documents, ever (ingestion maintains the stored hash; a freshness check must stay
//     cheap and offline);
//   - answer text: `messages.content` against `answer_snapshot` (exact — the snapshot was
//     taken verbatim);
//   - coverage: the SEMANTIC fields of `messages.coverage_json` against
//     `coverage_snapshot_json` (see `canonicalCoverage`).
// No model call, no network, no sidecar anywhere on this path (spec FR-2/FR-12 — the
// integration tests pin it with the runtime tripwire + real offline guard).
//
// `outdated` (spec §18.4) is POSITIVE drift only: answer/coverage changed, or ≥1 source
// hash changed (§15.5). A DELETED source marks that source 'missing' but does not flip the
// overlay — spec §25.2/§28.7 treat deletion as an unavailability warning (export succeeds
// with the missing-source warning), reserving Outdated + the acknowledge gate (§28.6) for
// content that CHANGED under the review. 'unverifiable' flips nothing: unknown is not
// drift. The overlay is DERIVED — never stored — so it can never erase `status: 'ready'`.
//
// Acknowledge (spec §15.5/§21.3/§28.6): the user explicitly accepts the CURRENT drift.
// Persisted as `evidence_reviews.freshness_ack_json` = { acknowledgedAt, fingerprint }
// where the fingerprint canonicalizes the drift facts INCLUDING the observed current
// values (the CURRENT stored sha of a changed source; a hash of the current answer text /
// canonical coverage when those changed) — so the acknowledge lapses on ANY later drift
// change: another source changes, a changed source changes AGAIN (sha ff→ee after the
// user acknowledged aa→ff — the in-place re-ingest path makes this real), a second answer
// edit, a changed source that recovers and then changes to something new, or a changed
// source that is later deleted. State-literal-only fingerprints would treat all of those
// as "the same drift" and silently keep a stale acknowledge alive (P4 review FIX-1).
// 'missing'/'unverifiable' facts carry state literals only — no observed value exists —
// and a NEW deletion still lapses the acknowledge because it ADDS a fact. The fingerprint
// holds hashes only (never text) and lives inside the review's own encrypted row.
// Acknowledging never rewrites `status`, `completed_at` or even `updated_at` (§18.4:
// outdated is an overlay; the acknowledge is lifecycle metadata, not a review edit —
// which is also why the READY write-guard does not apply to it).

interface FreshnessReviewRow {
  id: string
  message_id: string
  answer_snapshot: string
  source_snapshot_json: string | null
  coverage_snapshot_json: string | null
  freshness_ack_json: string | null
}

interface MessageCompareRow {
  content: string
  coverage_json: string | null
}

interface DocumentHashRow {
  id: string
  sha256: string | null
}

/**
 * The coverage fields freshness compares (spec §21.2 "coverage metadata matches"), as one
 * canonical string. SEMANTIC fields only: `nodeIds` (display-internal provenance plumbing)
 * and unknown extra keys are excluded — they carry no claim the review presents, and a
 * plumbing-only difference must not flag a review outdated. Key order is fixed, so the
 * comparison is stable regardless of stored JSON shape.
 */
function canonicalCoverage(c: CoverageInfo | null): string {
  if (!c) return 'none'
  return JSON.stringify({
    mode: c.mode ?? null,
    chunksCovered: c.chunksCovered ?? null,
    chunksTotal: c.chunksTotal ?? null,
    treeStatus: c.treeStatus ?? null,
    treeLevels: c.treeLevels ?? null,
    tier: c.tier ?? null,
    truncated: c.truncated ?? null,
    unparsedChunks: c.unparsedChunks ?? null,
    fullyChunked: c.fullyChunked ?? null
  })
}

/** Stored-hash comparison shared with the source-context handler: both present → equal?,
 *  either absent → 'unknown' (never a claim). */
export function compareStoredHashes(
  snapshotSha: string | null | undefined,
  currentSha: string | null | undefined
): 'match' | 'mismatch' | 'unknown' {
  if (!snapshotSha || !currentSha) return 'unknown'
  return snapshotSha === currentSha ? 'match' : 'mismatch'
}

/** One source's verdict + the observed CURRENT stored hash when there is one (the
 *  fingerprint's value component for 'changed'; null otherwise). */
function sourceVerdict(
  db: Db,
  s: EvidenceSourceSnapshot
): { state: EvidenceSourceFreshnessState; currentSha: string | null } {
  // BINDING (plan §14 P3 watch-out): an unresolved identity has nothing to compare —
  // it can only ever be 'unverifiable', never 'changed' and never 'missing'.
  if (s.identity !== 'resolved' || !s.documentId) return { state: 'unverifiable', currentSha: null }
  const row = prepareCached(db, 'SELECT id, sha256 FROM documents WHERE id = ?').get(
    s.documentId
  ) as DocumentHashRow | undefined
  if (!row) return { state: 'missing', currentSha: null }
  switch (compareStoredHashes(s.documentSha256, row.sha256)) {
    case 'match':
      return { state: 'unchanged', currentSha: row.sha256 }
    case 'mismatch':
      return { state: 'changed', currentSha: row.sha256 }
    default:
      return { state: 'unverifiable', currentSha: null }
  }
}

/** Short digest of an observed current value for the fingerprint (never the text itself). */
function valueDigest(value: string): string {
  return sha256Of(value).slice(0, 16)
}

/** Sorted canonical join of the drift facts — deterministic regardless of source order. */
function driftFingerprint(parts: string[]): string {
  return [...parts].sort().join(';')
}

interface StoredFreshnessAck {
  acknowledgedAt: string
  fingerprint: string
}

/** Tolerant parse of `freshness_ack_json` (the parseCitations idiom): malformed → null
 *  (reads as "never acknowledged" — the safe direction; a broken record never unlocks the
 *  export gate). */
export function parseFreshnessAck(json: string | null): StoredFreshnessAck | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    const a = v as Record<string, unknown>
    if (typeof a.acknowledgedAt !== 'string' || typeof a.fingerprint !== 'string') return null
    return { acknowledgedAt: a.acknowledgedAt, fingerprint: a.fingerprint }
  } catch {
    return null
  }
}

/** Verdict + the canonical drift fingerprint it fingerprints to (internal — the wire
 *  shape never carries the fingerprint; only the ack record stores it). */
interface FreshnessComputation {
  fresh: EvidenceReviewFreshness
  fingerprint: string
}

/**
 * One pass over the stored facts: the freshness verdict AND its drift fingerprint. The
 * fingerprint canonicalizes every NON-'unchanged' fact WITH its observed current value
 * (P4 review FIX-1 — see the module header): `src:{key}=changed:{currentSha}`,
 * `answer=changed:{digest(current content)}`, `coverage=changed:{digest(canonical
 * current)}`; 'missing'/'unverifiable' facts are state literals (no value exists). Sorted,
 * so it is deterministic regardless of source order.
 */
function computeFreshness(db: Db, reviewId: string): FreshnessComputation | null {
  const row = prepareCached(
    db,
    `SELECT id, message_id, answer_snapshot, source_snapshot_json, coverage_snapshot_json,
            freshness_ack_json
       FROM evidence_reviews WHERE id = ?`
  ).get(reviewId) as FreshnessReviewRow | undefined
  if (!row) return null

  const parts: string[] = []

  // Answer + coverage vs the live message row. The row is normally guaranteed by the FK
  // (deleting the message CASCADE-deletes the review), so 'unverifiable' is a defensive
  // arm for FK-off/corrupt stores — honest "cannot compare", never drift.
  const msg = prepareCached(db, 'SELECT content, coverage_json FROM messages WHERE id = ?').get(
    row.message_id
  ) as MessageCompareRow | undefined
  const answerState: EvidenceFreshnessComparison = !msg
    ? 'unverifiable'
    : msg.content === row.answer_snapshot
      ? 'unchanged'
      : 'changed'
  if (answerState === 'changed') parts.push(`answer=changed:${valueDigest(msg!.content)}`)
  else if (answerState === 'unverifiable') parts.push('answer=unverifiable')

  const currentCoverage = msg ? canonicalCoverage(parseCoverage(msg.coverage_json) ?? null) : null
  const coverageState: EvidenceFreshnessComparison = !msg
    ? 'unverifiable'
    : currentCoverage === canonicalCoverage(parseCoverage(row.coverage_snapshot_json) ?? null)
      ? 'unchanged'
      : 'changed'
  if (coverageState === 'changed') parts.push(`coverage=changed:${valueDigest(currentCoverage!)}`)
  else if (coverageState === 'unverifiable') parts.push('coverage=unverifiable')

  const sources: EvidenceSourceFreshness[] = parseSourceSnapshots(row.source_snapshot_json).map(
    (s) => {
      const verdict = sourceVerdict(db, s)
      if (verdict.state === 'changed') {
        parts.push(`src:${s.key}=changed:${verdict.currentSha ?? ''}`)
      } else if (verdict.state !== 'unchanged') {
        parts.push(`src:${s.key}=${verdict.state}`)
      }
      return { key: s.key, state: verdict.state }
    }
  )

  const outdated =
    answerState === 'changed' ||
    coverageState === 'changed' ||
    sources.some((s) => s.state === 'changed')
  const fingerprint = driftFingerprint(parts)

  // The acknowledge stands only while the drift it recorded IS the drift observed now —
  // same facts AND same current values (a re-change of an already-changed fact lapses it).
  let acknowledgedAt: string | null = null
  if (outdated) {
    const ack = parseFreshnessAck(row.freshness_ack_json)
    if (ack && ack.fingerprint === fingerprint) acknowledgedAt = ack.acknowledgedAt
  }

  return {
    fresh: { reviewId: row.id, outdated, answerState, coverageState, sources, acknowledgedAt },
    fingerprint
  }
}

/**
 * Compute one review's freshness verdict (spec §21.2) from stored facts only. Null on an
 * unknown review id. Cheap by construction: one review read, one message read, one indexed
 * `documents` lookup per resolved source — no re-hashing of documents, no file reads, no
 * model, no network (the only hashing is the tiny in-memory value digest inside the drift
 * fingerprint — never a source file).
 */
export function computeEvidenceReviewFreshness(
  db: Db,
  reviewId: string
): EvidenceReviewFreshness | null {
  return computeFreshness(db, reviewId)?.fresh ?? null
}

/**
 * Record the user's explicit acknowledge of the CURRENT drift (spec §15.5/§21.3/§28.6).
 * Null on an unknown review. A non-outdated review is a NO-OP (there is nothing to
 * acknowledge — no phantom record is written). Writes ONLY `freshness_ack_json`: never
 * `status`, never `completed_at`, never `updated_at` (§18.4 — the overlay must not touch
 * the review's own lifecycle stamps), which is also why the READY write-guard deliberately
 * does not apply here (acknowledging is not a decision edit).
 */
export function acknowledgeEvidenceReviewFreshness(
  db: Db,
  reviewId: string
): EvidenceReviewFreshness | null {
  const result = computeFreshness(db, reviewId)
  if (!result) return null
  if (!result.fresh.outdated) return result.fresh
  const acknowledgedAt = new Date().toISOString()
  const record: StoredFreshnessAck = { acknowledgedAt, fingerprint: result.fingerprint }
  prepareCached(db, 'UPDATE evidence_reviews SET freshness_ack_json = ? WHERE id = ?').run(
    JSON.stringify(record),
    reviewId
  )
  return { ...result.fresh, acknowledgedAt }
}
