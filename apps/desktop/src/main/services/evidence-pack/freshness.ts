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
// where the fingerprint canonicalizes the drift facts — if the drift CHANGES after the
// acknowledge (another source changes, a changed source is later deleted, …), the stored
// fingerprint no longer matches and the acknowledge honestly lapses (a new warning demands
// a new acknowledge). Acknowledging never rewrites `status`, `completed_at` or even
// `updated_at` (§18.4: outdated is an overlay; the acknowledge is lifecycle metadata, not
// a review edit — which is also why the READY write-guard does not apply to it).

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

function sourceFreshnessState(
  db: Db,
  s: EvidenceSourceSnapshot
): EvidenceSourceFreshnessState {
  // BINDING (plan §14 P3 watch-out): an unresolved identity has nothing to compare —
  // it can only ever be 'unverifiable', never 'changed' and never 'missing'.
  if (s.identity !== 'resolved' || !s.documentId) return 'unverifiable'
  const row = prepareCached(db, 'SELECT id, sha256 FROM documents WHERE id = ?').get(
    s.documentId
  ) as DocumentHashRow | undefined
  if (!row) return 'missing'
  switch (compareStoredHashes(s.documentSha256, row.sha256)) {
    case 'match':
      return 'unchanged'
    case 'mismatch':
      return 'changed'
    default:
      return 'unverifiable'
  }
}

/**
 * Canonical fingerprint of every NON-'unchanged' freshness fact, stored inside the
 * acknowledge record so a LATER drift change (new source changed, changed→missing, …)
 * lapses the acknowledge. Content-free: source KEYS (machine labels like "S1") + state
 * literals only — it lives inside the review's own encrypted row and never reaches logs
 * or audit anyway.
 */
export function freshnessFingerprint(
  fresh: Pick<EvidenceReviewFreshness, 'answerState' | 'coverageState' | 'sources'>
): string {
  const parts: string[] = []
  if (fresh.answerState && fresh.answerState !== 'unchanged') parts.push(`answer=${fresh.answerState}`)
  if (fresh.coverageState && fresh.coverageState !== 'unchanged') {
    parts.push(`coverage=${fresh.coverageState}`)
  }
  for (const s of fresh.sources ?? []) {
    if (s.state !== 'unchanged') parts.push(`src:${s.key}=${s.state}`)
  }
  parts.sort()
  return parts.join(';')
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

/**
 * Compute one review's freshness verdict (spec §21.2) from stored facts only. Null on an
 * unknown review id. Cheap by construction: one review read, one message read, one indexed
 * `documents` lookup per resolved source — no hashing, no file reads, no model, no network.
 */
export function computeEvidenceReviewFreshness(
  db: Db,
  reviewId: string
): EvidenceReviewFreshness | null {
  const row = prepareCached(
    db,
    `SELECT id, message_id, answer_snapshot, source_snapshot_json, coverage_snapshot_json,
            freshness_ack_json
       FROM evidence_reviews WHERE id = ?`
  ).get(reviewId) as FreshnessReviewRow | undefined
  if (!row) return null

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
  const coverageState: EvidenceFreshnessComparison = !msg
    ? 'unverifiable'
    : canonicalCoverage(parseCoverage(msg.coverage_json) ?? null) ===
        canonicalCoverage(parseCoverage(row.coverage_snapshot_json) ?? null)
      ? 'unchanged'
      : 'changed'

  const sources: EvidenceSourceFreshness[] = parseSourceSnapshots(row.source_snapshot_json).map(
    (s) => ({ key: s.key, state: sourceFreshnessState(db, s) })
  )

  const outdated =
    answerState === 'changed' ||
    coverageState === 'changed' ||
    sources.some((s) => s.state === 'changed')

  // The acknowledge stands only while the drift it recorded IS the drift computed now.
  let acknowledgedAt: string | null = null
  if (outdated) {
    const ack = parseFreshnessAck(row.freshness_ack_json)
    if (ack && ack.fingerprint === freshnessFingerprint({ answerState, coverageState, sources })) {
      acknowledgedAt = ack.acknowledgedAt
    }
  }

  return { reviewId: row.id, outdated, answerState, coverageState, sources, acknowledgedAt }
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
  const fresh = computeEvidenceReviewFreshness(db, reviewId)
  if (!fresh) return null
  if (!fresh.outdated) return fresh
  const acknowledgedAt = new Date().toISOString()
  const record: StoredFreshnessAck = {
    acknowledgedAt,
    fingerprint: freshnessFingerprint(fresh)
  }
  prepareCached(db, 'UPDATE evidence_reviews SET freshness_ack_json = ? WHERE id = ?').run(
    JSON.stringify(record),
    reviewId
  )
  return { ...fresh, acknowledgedAt }
}
