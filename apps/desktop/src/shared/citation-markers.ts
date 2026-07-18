// Machine citation-marker contract — the ONE regex source for `[S{n}]` semantics.
//
// The grounded RAG prompt bakes machine-stable inline markers `[S1] [S2] …` into the model
// output (GROUNDING_RULES in rag/index.ts) and persists them in `citations_json` — those
// NEVER change. Two independent consumers must agree BYTE-FOR-BYTE on what counts as a
// marker and what counts as literal code:
//   - the renderer's display localization (`displayMap.ts` `localizeCitationMarkers`,
//     DE renders `[Q{n}]`), and
//   - the main-side evidence-review marker extraction (EP-1 plan §6.2, `evidence-pack/
//     segment.ts`) that turns markers into `origin: 'answer_marker'` evidence links.
// A drift between the two would let the review claim "cited by the answer" for text the
// chat UI treats as code (or vice versa) — so both import THESE definitions; neither keeps
// a private copy (EP-1 plan §6.2: same regex source, not a mirrored one).

/**
 * Fence/code split: `text.split(CITE_CODE_SPLIT_RE)` yields prose at EVEN indices and code
 * (fenced ``` / ~~~ blocks — an unclosed trailing fence swallows to end-of-text — and inline
 * single-backtick spans) at ODD indices. Mirrors `normalizeMathDelimiters` in Transcript.tsx.
 */
export const CITE_CODE_SPLIT_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/

/** One inline machine marker: `[S<digits>]`. Capture group 1 = the digits. */
export const CITE_MARKER_RE = /\[S(\d+)\]/g

/** One prose citation marker with its absolute position in the scanned text. */
export interface CitationMarkerOffset {
  /** The machine label, e.g. `"S1"`. */
  label: string
  /** UTF-16 index of the marker's `[` in the WHOLE scanned string. */
  index: number
}

/**
 * Extract every PROSE citation marker with its absolute offset. The prose/code split runs
 * over the WHOLE input exactly like the display rewrite does — this is load-bearing for
 * consumers that later partition the text (the evidence-review segmenter assigns markers
 * to blocks BY OFFSET from this one whole-text pass), because a code region can span a
 * partition boundary (e.g. a mid-line ``` swallows to end-of-text): splitting first and
 * scanning per part would classify such markers differently from the rendered chat.
 * In-order, NOT deduplicated (offsets are positions, not a citation set).
 */
export function extractCitationMarkerOffsets(text: string): CitationMarkerOffset[] {
  if (!text.includes('[S')) return []
  const offsets: CitationMarkerOffset[] = []
  const parts = text.split(CITE_CODE_SPLIT_RE)
  let cursor = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (i % 2 === 0) {
      // `matchAll` iterates a species-clone of the regex, so the shared `g`-flagged
      // CITE_MARKER_RE instance never carries `lastIndex` state between callers.
      for (const m of part.matchAll(CITE_MARKER_RE)) {
        offsets.push({ label: `S${m[1]}`, index: cursor + (m.index ?? 0) })
      }
    }
    cursor += part.length
  }
  return offsets
}

/**
 * Extract the machine citation labels (`"S1"`, `"S2"`, …) referenced by `text`'s PROSE —
 * markers inside fenced blocks or inline code spans are literals, not citations, exactly as
 * the display rewrite treats them. First-appearance order, deduplicated (repeated markers
 * cite the same source once — spec §13.1).
 */
export function extractCitationMarkers(text: string): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const { label } of extractCitationMarkerOffsets(text)) {
    if (!seen.has(label)) {
      seen.add(label)
      labels.push(label)
    }
  }
  return labels
}
