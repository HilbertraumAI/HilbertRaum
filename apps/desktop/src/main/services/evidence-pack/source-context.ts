import type { EvidenceSourceContext } from '../../../shared/types'
import { prepareCached, type Db } from '../db'
import { parseSourceSnapshots } from '../evidence-reviews'
import { CHUNK_DEFAULTS } from '../ingestion/chunker'
import { compareStoredHashes } from './freshness'

// Source-in-context (EP-1 plan §9.3, D-5, spec §10.2.4): resolve one snapshotted source to
// the STORED extracted text around its persisted excerpt, entirely main-side.
//
// Security boundary (spec §19/§22.10): the renderer passes the REVIEW id + the source KEY
// only — the document id is read from the review's OWN snapshot, so the renderer can never
// point this handler at an arbitrary document, and unknown review/key inputs read as null.
// Unresolved-identity sources return null too: there is no document to read (the card
// already says "cannot be verified", and inventing context would be a false claim).
//
// Content source (D-5: "extracted text around the citation, existing preview limits; no
// page-image rendering"): the `chunks` table — the extraction ingestion already persisted —
// NEVER a re-read/re-parse/re-OCR of the source file (that is the preview pipeline's heavy
// path; a context peek must stay cheap, and §21.2's no-re-hashing spirit applies: stored
// facts only). Resolution ladder for the excerpt:
//   1. the snapshotted `sourceChunkId`, verified to belong to the snapshotted document
//      (a stale/foreign chunk id must never leak another document's text);
//   2. else a stored-text search for the persisted snippet (SQLite `instr` over the
//      document's chunks — the snippet is `truncateSnippet(chunk.text)`, i.e. the trimmed
//      chunk text or its '…'-terminated prefix, so containment finds it when the stored
//      extraction still holds it);
//   3. not found (document re-imported/re-chunked, content changed, or no snippet
//      persisted) → `located: false` — the modal shows the persisted excerpt with honest
//      "could not locate" copy instead of guessed context.
// The context window is the located chunk ± one neighbor, capped to CONTEXT_WINDOW_CHARS
// per side with surrogate-safe boundaries (the F-15 rule: a slice must never cut an astral
// pair in half). Consecutive chunks of the SAME segment share a deliberately duplicated run
// (the chunker re-includes the previous window's tail), which is stripped once per boundary
// before the join — see `sharedRunLength` (AUD-08).

/** Max stored-text characters returned on each side of the located excerpt. */
export const CONTEXT_WINDOW_CHARS = 1200

interface ChunkRow {
  id: string
  document_id: string
  chunk_index: number
  text: string
  page_number: number | null
  section_label: string | null
}

interface DocumentRow {
  id: string
  title: string
  sha256: string | null
}

/** The snippet as stored may be a '…'-terminated prefix (truncateSnippet); the needle for
 *  containment search is the prefix without that marker. Null when nothing usable. */
function snippetNeedle(snippet: string | null): string | null {
  if (!snippet) return null
  const needle = snippet.endsWith('…') ? snippet.slice(0, -1) : snippet
  return needle.length > 0 ? needle : null
}

/** Generous upper bound on the chunk-overlap size in CHARACTERS: the chunker re-includes at
 *  most `chunkOverlapTokens` tokens, and one approx-token is at most 16 characters of a
 *  whitespace word — 20 leaves slack for the joining spaces. Bounds the shared-run scan so it
 *  stays linear AND a coincidental long match cannot reach far past the real overlap. (The
 *  same bound the whole-document read uses for the identical measurement.) */
const MAX_OVERLAP_CHARS_PER_TOKEN = 20

/** Length of the longest suffix of `tail` that is also a PREFIX of `head` (byte-exact). KMP:
 *  build the prefix function of `head`, then run `tail` through that automaton and read off
 *  the match length at `tail`'s end. O(head+tail), no separator sentinel, so it makes no
 *  assumption about which characters extracted text may contain. */
function overlapLength(head: string, tail: string): number {
  const pi = new Array<number>(head.length).fill(0)
  for (let i = 1; i < head.length; i += 1) {
    let j = pi[i - 1]
    while (j > 0 && head[i] !== head[j]) j = pi[j - 1]
    if (head[i] === head[j]) j += 1
    pi[i] = j
  }
  let k = 0 // length of the `head`-prefix matched at the current position of `tail`
  for (let i = 0; i < tail.length; i += 1) {
    while (k > 0 && tail[i] !== head[k]) k = pi[k - 1]
    if (tail[i] === head[k]) k += 1
    if (k === head.length) k = pi[k - 1] // full head matched mid-tail — keep looking for longer
  }
  return k
}

/**
 * AUD-08 — the size of the run the chunker duplicated across ONE same-segment boundary.
 *
 * Consecutive windows of a segment overlap by ~`chunkOverlapTokens` (80) tokens of byte-exact
 * DUPLICATED text: the chunker re-includes the previous window's tail so retrieval never
 * splits a fact across a boundary. Joining stored chunks to build a reading context therefore
 * prints that run twice — several hundred characters on the shipped 500/80 configuration — in
 * the one modal whose job is to show what the document really says. Matching is on CHARACTERS
 * (not whitespace words) so it is correct for space-less scripts and glued PDF runs, and the
 * scan is bounded to the known overlap size so a coincidental long match cannot eat real text.
 */
function sharedRunLength(prev: string, next: string): number {
  const cap = CHUNK_DEFAULTS.chunkOverlapTokens * MAX_OVERLAP_CHARS_PER_TOKEN
  const tail = prev.length > cap ? prev.slice(prev.length - cap) : prev
  const head = next.length > cap ? next.slice(0, cap) : next
  return overlapLength(head, tail)
}

/** True when two consecutive chunks belong to the same coalesced segment (same page +
 *  section) — the only case where the chunker introduces overlap. Adjacent segments sharing
 *  labels are merged before chunking, so equal labels on order-adjacent chunks mean one
 *  segment, hence a real overlap; different labels mean genuinely repeated document text,
 *  which must survive verbatim. */
function sameSegment(
  a: { page_number: number | null; section_label: string | null },
  b: { page_number: number | null; section_label: string | null }
): boolean {
  return (
    (a.page_number ?? null) === (b.page_number ?? null) &&
    (a.section_label ?? null) === (b.section_label ?? null)
  )
}

/** Move a slice boundary off a surrogate-pair split (shrink inward — never widen past the
 *  window): a boundary between a high and low surrogate steps one unit toward the match. */
function alignBoundary(text: string, offset: number, direction: 1 | -1): number {
  if (offset <= 0 || offset >= text.length) return offset
  const before = text.charCodeAt(offset - 1)
  const at = text.charCodeAt(offset)
  if (before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff) {
    return offset + direction
  }
  return offset
}

/**
 * Resolve the stored context for one review source (see module header). Null = unknown
 * review, unknown key, or an unresolved-identity source.
 */
export function getEvidenceSourceContext(
  db: Db,
  reviewId: string,
  sourceKey: string
): EvidenceSourceContext | null {
  const review = prepareCached(
    db,
    'SELECT id, source_snapshot_json FROM evidence_reviews WHERE id = ?'
  ).get(reviewId) as { id: string; source_snapshot_json: string | null } | undefined
  if (!review) return null
  const source = parseSourceSnapshots(review.source_snapshot_json).find((s) => s.key === sourceKey)
  if (!source) return null
  if (source.identity !== 'resolved' || !source.documentId) return null

  const doc = prepareCached(db, 'SELECT id, title, sha256 FROM documents WHERE id = ?').get(
    source.documentId
  ) as DocumentRow | undefined
  const base: EvidenceSourceContext = {
    reviewId,
    key: source.key,
    documentTitle: doc?.title ?? source.documentTitle,
    availability: doc ? 'available' : 'missing',
    hashState: compareStoredHashes(source.documentSha256, doc?.sha256),
    snippet: source.snippet ?? null,
    located: false,
    before: null,
    match: null,
    after: null,
    pageNumber: source.pageNumber ?? null,
    sectionLabel: source.sectionLabel ?? null
  }
  if (!doc) return base

  const needle = snippetNeedle(source.snippet ?? null)
  if (!needle) return base

  // Ladder step 1: the snapshotted chunk id — accepted ONLY when it belongs to the
  // snapshotted document AND still contains the excerpt (a re-chunked store mints new ids,
  // so a live row with the old id that no longer carries the text is treated as unlocated
  // via the search fallback).
  let chunk: ChunkRow | null = null
  if (source.sourceChunkId) {
    const byId = prepareCached(
      db,
      'SELECT id, document_id, chunk_index, text, page_number, section_label FROM chunks WHERE id = ?'
    ).get(source.sourceChunkId) as ChunkRow | undefined
    if (byId && byId.document_id === source.documentId && byId.text.includes(needle)) {
      chunk = byId
    }
  }
  // Ladder step 2: stored-text containment search across the document's chunks.
  if (!chunk) {
    chunk =
      (prepareCached(
        db,
        `SELECT id, document_id, chunk_index, text, page_number, section_label
           FROM chunks WHERE document_id = ? AND instr(text, ?) > 0
          ORDER BY chunk_index LIMIT 1`
      ).get(source.documentId, needle) as ChunkRow | undefined) ?? null
  }
  if (!chunk) return base

  // Context = the located chunk ± one stored neighbor (bounded below).
  const neighbor = prepareCached(
    db,
    `SELECT id, document_id, chunk_index, text, page_number, section_label
       FROM chunks WHERE document_id = ? AND chunk_index = ? LIMIT 1`
  )
  const prev = neighbor.get(source.documentId, chunk.chunk_index - 1) as ChunkRow | undefined
  const next = neighbor.get(source.documentId, chunk.chunk_index + 1) as ChunkRow | undefined
  // AUD-08: strip the duplicated run once per same-segment boundary, ALWAYS off the
  // NEIGHBOUR and never off the located chunk. The persisted excerpt is a PREFIX of the
  // located chunk's text (it is that text, trimmed and capped), so it sits exactly inside
  // the run shared with the previous chunk — trimming the located chunk's head would delete
  // the very text this modal highlights and shift every offset computed below. Removing the
  // shared run from the PREVIOUS chunk's tail deletes the same characters instead, and
  // removing it from the NEXT chunk's head is the mirror case. Either neighbour may end up
  // empty (it contributed nothing but the duplicate); that simply means no context on that
  // side, which is the honest result.
  const prevText = prev
    ? sameSegment(prev, chunk)
      ? prev.text.slice(0, prev.text.length - sharedRunLength(prev.text, chunk.text)).trimEnd()
      : prev.text
    : ''
  const nextText = next
    ? sameSegment(chunk, next)
      ? next.text.slice(sharedRunLength(chunk.text, next.text)).trimStart()
      : next.text
    : ''
  const prefix = prevText ? `${prevText}\n\n` : ''
  const full = `${prefix}${chunk.text}${nextText ? `\n\n${nextText}` : ''}`
  const matchStart = prefix.length + chunk.text.indexOf(needle)
  const matchEnd = matchStart + needle.length
  const beforeStart = alignBoundary(full, Math.max(0, matchStart - CONTEXT_WINDOW_CHARS), 1)
  const afterEnd = alignBoundary(full, Math.min(full.length, matchEnd + CONTEXT_WINDOW_CHARS), -1)

  return {
    ...base,
    located: true,
    before: full.slice(beforeStart, matchStart),
    match: needle,
    after: full.slice(matchEnd, afterEnd),
    pageNumber: chunk.page_number ?? source.pageNumber ?? null,
    sectionLabel: chunk.section_label ?? source.sectionLabel ?? null
  }
}
