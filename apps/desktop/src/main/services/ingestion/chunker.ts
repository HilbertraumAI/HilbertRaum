import type { ExtractedSegment } from './parsers'

// Chunker (spec §7.7). Splits a document's extracted segments into overlapping,
// fixed-size chunks ready for embedding and retrieval.
//
// Token counting is an APPROXIMATION, but it must never wildly UNDER-count: every
// context budget in the app (chunk size, summary/translation/compare windows, the RAG
// context cap) is derived from `approxTokenCount`, and an under-count lets the assembled
// prompt overflow the model's context window — the server then rejects it with HTTP 400
// (`exceed_context_size_error`). A naive whitespace-word count does exactly that for text
// WITHOUT spaces — CJK/Thai, or PDF/extraction runs with no word breaks — where a whole
// paragraph collapses to "1 word". So `approxTokenCount` counts space-less scripts
// per-character and charges long no-space runs by length, biased to slightly OVER-count
// (over-filling never 400s; under-filling does). Windowing (`windowByTokens`) likewise
// hard-cuts space-less runs by character instead of leaving them whole — and (RAG-N2) slices
// them small enough that consecutive windows still OVERLAP for space-less scripts (a single
// window-sized slice can never be stepped back into, so CJK/Thai chunks used to get zero
// overlap). A real tokenizer can still replace these without changing the chunk-metadata shape.
//
// Chunking is done WITHIN each segment, so a chunk never straddles a page or section
// boundary — every chunk inherits exactly one `pageNumber`/`sectionLabel` from its
// source segment (spec §7.7 chunk metadata). Overlap is applied within a segment only.
//
// PACKING: consecutive segments with the SAME (pageNumber, sectionLabel) are
// coalesced before windowing. Parsers like DOCX emit one segment per paragraph (no
// labels at all); without packing, every paragraph became its own tiny chunk —
// retrieval quality collapsed and a >1000-paragraph document silently hit the
// maxChunks cap. Coalescing preserves the never-cross-a-boundary invariant exactly,
// because only label-identical neighbours are merged.

export interface ChunkDefaults {
  chunkSizeTokens: number
  chunkOverlapTokens: number
  maxChunks: number
}

/**
 * The single source of truth for the per-document chunk cap (whole-document-analysis
 * plan C2). It is referenced by `CHUNK_DEFAULTS.maxChunks`, the over-cap upload gate in
 * `processDocument`, the (future) coverage math, and the test fixtures — change it in one
 * place. A document that would exceed this is REJECTED at index time (plan C1), never
 * silently truncated, so every indexed document is the WHOLE document (`fully_chunked`).
 */
export const MAX_CHUNKS_PER_DOCUMENT = 1000

/** Spec §7.7 chunking defaults. */
export const CHUNK_DEFAULTS: ChunkDefaults = {
  chunkSizeTokens: 500,
  chunkOverlapTokens: 80,
  maxChunks: MAX_CHUNKS_PER_DOCUMENT
}

export type ChunkOptions = Partial<ChunkDefaults>

/** One produced chunk; maps directly onto the `chunks` table columns (spec §8). */
export interface DocumentChunk {
  chunkIndex: number
  text: string
  pageNumber: number | null
  sectionLabel: string | null
  tokenCount: number
}

/** Split text into whitespace-delimited words. NB: this is a plain word split, NOT a
 * token estimate — for budgeting use `approxTokenCount`, which also handles space-less
 * scripts. Kept for callers that genuinely want words (e.g. keyword search). */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0)
}

// Scripts whose real tokenizers split roughly per-character AND that carry no whitespace
// word boundaries: Hiragana/Katakana, CJK ext-A, CJK unified, compatibility ideographs,
// Hangul syllables, half/fullwidth forms, Thai. Counted ~1 token/char (a safe over-count).
const SPACELESS_SCRIPT_RE =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯＀-￯฀-๿]/g
/** Average characters per token for BPE text — used to charge ABNORMALLY long runs. */
const CHARS_PER_TOKEN = 4
/**
 * A whitespace word up to this many characters counts as one token (the long-standing
 * word≈token estimate, which is fine for ordinary prose in any space-separated language).
 * Only words LONGER than this — a glued no-space PDF run, base64, a giant URL — are
 * charged by length, so the estimate can't collapse a huge run to a single token.
 */
const ONE_TOKEN_WORD_CHARS = 16

/**
 * Approximate MODEL-token count for a string (see the module note). Space-less-script
 * characters (CJK/Thai/…) count ~1 token each; an ordinary whitespace word counts as one
 * token; only an over-long no-space run is charged `ceil(len / CHARS_PER_TOKEN)`. The
 * estimate is unchanged for normal prose and merely refuses to under-count space-less or
 * glued text — the case that let document prompts overflow the context (HTTP 400).
 */
export function approxTokenCount(text: string): number {
  const spaceless = text.match(SPACELESS_SCRIPT_RE)?.length ?? 0
  let tokens = spaceless
  // Strip the space-less chars (already counted) before the word pass so they don't
  // also inflate a surrounding word's length.
  const rest = text.replace(SPACELESS_SCRIPT_RE, ' ')
  for (const word of rest.split(/\s+/)) {
    if (word.length === 0) continue
    tokens += word.length <= ONE_TOKEN_WORD_CHARS ? 1 : Math.ceil(word.length / CHARS_PER_TOKEN)
  }
  return tokens
}

/**
 * Approx token cost of a single whitespace-free WORD (ING-10, perf audit 2026-06-18).
 * A word has no internal whitespace, so when it contains no space-less-script char it is
 * exactly ONE token group: `len <= ONE_TOKEN_WORD_CHARS ? 1 : ceil(len / CHARS_PER_TOKEN)` —
 * byte-identical to `approxTokenCount(word)` but skipping its `replace()` + `split()` passes
 * (the per-word path runs once per word across a whole document). A word that DOES contain a
 * space-less char (mixed-script, rare) falls back to the full counter so the estimate stays
 * exactly the same. The single `match()` here is the same one `approxTokenCount` runs first.
 */
function wordTokenCount(word: string): number {
  if (word.match(SPACELESS_SCRIPT_RE) === null) {
    return word.length <= ONE_TOKEN_WORD_CHARS ? 1 : Math.ceil(word.length / CHARS_PER_TOKEN)
  }
  return approxTokenCount(word)
}

/** Greatest common divisor (non-negative inputs). Sizes character slices so an over-long
 * space-less run packs into windows that fill to exactly `cap` and overlap by exactly
 * `overlap` tokens — e.g. gcd(500, 80) = 20 (see `atomize` / `windowByTokens`). The production
 * config is always 500/80 (CHUNK_DEFAULTS) ⇒ 20-char slices; a hypothetical overlap coprime with
 * `cap` would degrade to 1-char slices (more atoms, still O(n) and correct) — no current caller
 * passes such a value (every windowByTokens call uses overlap 0 or CHUNK_DEFAULTS.chunkOverlapTokens). */
function gcd(a: number, b: number): number {
  let x = Math.max(0, Math.floor(a))
  let y = Math.max(0, Math.floor(b))
  while (y > 0) {
    ;[x, y] = [y, x % y]
  }
  return x
}

/** One atom of text for windowing: a substring plus its approx token cost. `glued` marks a
 * character-slice piece that continues the previous atom with NO separating whitespace, so the
 * window assembler re-joins it without a space — the raw substring is reproduced exactly. */
interface TokenAtom {
  text: string
  tokens: number
  glued: boolean
}

/**
 * Split `text` into atoms (whitespace words), hard-cutting any single word longer than `cap`
 * tokens into character pieces that each fit — so a space-less run yields MANY atoms instead of
 * one giant one. Each atom's text is a raw substring (no characters inserted).
 *
 * Slice size (RAG-N2): with `overlap = 0` the pieces are `cap` chars each (one per window — they
 * concatenate back losslessly). With `overlap > 0` they are `gcd(cap, overlap)` chars each, small
 * enough that the windower's whole-atom step-back can re-include ~`overlap` tokens of the previous
 * window; a single `cap`-sized slice can never be stepped back into (`back + cap <= overlap` is
 * never true), which is why space-less chunks formerly had ZERO overlap. Every slice but the first
 * of a run is `glued`, so the assembler re-joins the pieces with no separating space.
 */
function atomize(text: string, cap: number, overlap = 0): TokenAtom[] {
  const maxAtom = Math.max(1, Math.floor(cap))
  const sliceChars = overlap > 0 ? Math.max(1, gcd(maxAtom, overlap)) : maxAtom
  const atoms: TokenAtom[] = []
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue
    const tokens = wordTokenCount(word)
    if (tokens <= maxAtom) {
      atoms.push({ text: word, tokens, glued: false })
      continue
    }
    // Over-long word (no whitespace to break on): cut by character. A `sliceChars`-char slice is
    // ≤ sliceChars ≤ maxAtom tokens (≤ 1 token/char), so every piece fits a window.
    let i = 0
    while (i < word.length) {
      let end = Math.min(word.length, i + sliceChars)
      // F-24 (audit 2026-07-16): never cut between the halves of a surrogate pair — at a WINDOW
      // boundary the cut becomes the stored chunk-text boundary, and an unaligned cut left one chunk
      // ending in a lone high surrogate and the next starting with the lone low one (U+FFFD after
      // every downstream UTF-8 conversion). RETRACT the cut one code unit (the pair moves whole into
      // the next piece — a shorter piece can only cost fewer tokens, so the window budget still
      // holds); EXTEND instead only in the degenerate sliceChars=1 case where retracting would empty
      // the piece (a 2-unit pair is ≤ 1 approx token, so it still fits any window). Boundary-only:
      // BMP text hits identical cut positions, so non-astral chunk output is byte-identical.
      if (end < word.length && isHighSurrogate(word.charCodeAt(end - 1)) && isLowSurrogate(word.charCodeAt(end))) {
        end = end - 1 > i ? end - 1 : end + 1
      }
      const piece = word.slice(i, end)
      atoms.push({ text: piece, tokens: approxTokenCount(piece), glued: i > 0 })
      i = end
    }
  }
  return atoms
}

/** UTF-16 surrogate-half classifiers for the F-24 pair-aligned cut (code UNITS, not code points). */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/**
 * Split `text` into consecutive windows, each at most `size` approx tokens, overlapping
 * by ~`overlap` tokens. Windows are content-preserving substrings (words re-joined by a
 * single space, like the pre-existing chunker; a space-less run is character-sliced with
 * nothing inserted). Unlike a raw word split, this never yields a window larger than the
 * budget for text without spaces — the bug that let document prompts overflow the model
 * context. With `overlap = 0` it is a plain non-overlapping split; with `overlap > 0` even a
 * space-less run gets ~`overlap` shared tokens between consecutive windows (RAG-N2).
 */
export function windowByTokens(text: string, size: number, overlap = 0): string[] {
  const sz = Math.max(1, Math.floor(size))
  const ov = Math.max(0, Math.min(Math.floor(overlap), sz - 1))
  const atoms = atomize(text, sz, ov)
  if (atoms.length === 0) return []

  const windows: string[] = []
  let i = 0
  while (i < atoms.length) {
    let j = i
    let sum = 0
    // Always take at least one atom (it fits — atomize capped each at `sz`).
    while (j < atoms.length && (sum === 0 || sum + atoms[j].tokens <= sz)) {
      sum += atoms[j].tokens
      j += 1
    }
    windows.push(assembleAtoms(atoms, i, j))
    if (j >= atoms.length) break
    // Step the next window back to re-include ~`ov` tokens, but advance at least one atom.
    let start = j
    let back = 0
    while (start > i + 1 && back + atoms[start - 1].tokens <= ov) {
      start -= 1
      back += atoms[start].tokens
    }
    i = start
  }
  return windows
}

/** Re-join atoms `[i, j)` into one window. A `glued` atom (a non-first character slice of an
 * over-long run) is appended with NO separating space so its raw substring is reproduced exactly;
 * every other atom is space-joined (the pre-existing whitespace-word behavior). */
function assembleAtoms(atoms: TokenAtom[], i: number, j: number): string {
  let out = atoms[i].text
  for (let k = i + 1; k < j; k += 1) {
    out += (atoms[k].glued ? '' : ' ') + atoms[k].text
  }
  return out
}

/** The leading prefix of `text` that fits in `maxTokens` approx tokens (the rest is
 * dropped). Content-preserving. Used where a single block must be clamped to a budget. */
export function truncateToApproxTokens(text: string, maxTokens: number): string {
  return windowByTokens(text, maxTokens, 0)[0] ?? ''
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/** Merge consecutive segments that share the same page/section labels (see module note). */
function coalesceSegments(segments: ExtractedSegment[]): ExtractedSegment[] {
  const out: ExtractedSegment[] = []
  // ING-9 (perf audit 2026-06-18): accumulate each group's parts in a string[] and `join`
  // ONCE when the group ends, instead of `prev.text = prev.text + '\n\n' + segment.text` per
  // member (an O(total chars) reallocation per group — accumulate-by-concat). Byte-identical:
  // `[a, b, c].join('\n\n')` === `a + '\n\n' + b + '\n\n' + c`.
  let parts: string[] = []
  const flush = (): void => {
    if (out.length > 0 && parts.length > 1) out[out.length - 1].text = parts.join('\n\n')
  }
  for (const segment of segments) {
    const prev = out[out.length - 1]
    if (
      prev &&
      (prev.pageNumber ?? null) === (segment.pageNumber ?? null) &&
      (prev.sectionLabel ?? null) === (segment.sectionLabel ?? null)
    ) {
      parts.push(segment.text)
    } else {
      flush()
      out.push({ ...segment })
      parts = [segment.text]
    }
  }
  flush()
  return out
}

/**
 * Chunk extracted segments into overlapping windows. Each window is at most
 * `chunkSizeTokens` tokens; consecutive windows overlap by `chunkOverlapTokens`.
 * The global chunk count is capped at `maxChunks` (spec §7.7 MVP guard).
 *
 * NOTE (whole-document-analysis plan C1/M13): this function still STOPS at `maxChunks`
 * as a memory guard, but it is no longer the honesty boundary. `processDocument` passes
 * `maxChunks = MAX_CHUNKS_PER_DOCUMENT + 1` and REJECTS the document when the result
 * exceeds the real cap — *before* the destructive chunk replacement — so an over-cap
 * document is failed with a friendly "split it" message instead of being silently
 * truncated to its beginning. Callers that pass no `maxChunks` keep the legacy
 * truncate-at-1000 behaviour (tests only).
 */
export function chunkSegments(
  segments: ExtractedSegment[],
  options: ChunkOptions = {}
): DocumentChunk[] {
  const size = Math.max(1, Math.floor(options.chunkSizeTokens ?? CHUNK_DEFAULTS.chunkSizeTokens))
  // Overlap must be < size, otherwise the window never advances.
  const overlap = clampInt(options.chunkOverlapTokens ?? CHUNK_DEFAULTS.chunkOverlapTokens, 0, size - 1)
  const maxChunks = Math.max(0, Math.floor(options.maxChunks ?? CHUNK_DEFAULTS.maxChunks))

  const chunks: DocumentChunk[] = []
  let index = 0

  for (const segment of coalesceSegments(segments)) {
    const pageNumber = segment.pageNumber ?? null
    const sectionLabel = segment.sectionLabel ?? null

    // `windowByTokens` handles overlap AND space-less text (no one-giant-chunk); it
    // already stops at the segment end, so there is no redundant tail window to guard.
    for (const text of windowByTokens(segment.text, size, overlap)) {
      if (index >= maxChunks) return chunks
      chunks.push({
        chunkIndex: index,
        text,
        pageNumber,
        sectionLabel,
        tokenCount: approxTokenCount(text)
      })
      index += 1
    }
  }

  return chunks
}
