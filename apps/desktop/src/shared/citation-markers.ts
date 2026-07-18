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

/**
 * Extract the machine citation labels (`"S1"`, `"S2"`, …) referenced by `text`'s PROSE —
 * markers inside fenced blocks or inline code spans are literals, not citations, exactly as
 * the display rewrite treats them. First-appearance order, deduplicated (repeated markers
 * cite the same source once — spec §13.1).
 */
export function extractCitationMarkers(text: string): string[] {
  if (!text.includes('[S')) return []
  const seen = new Set<string>()
  const labels: string[] = []
  const parts = text.split(CITE_CODE_SPLIT_RE)
  for (let i = 0; i < parts.length; i += 2) {
    // `matchAll` iterates a species-clone of the regex, so the shared `g`-flagged
    // CITE_MARKER_RE instance never carries `lastIndex` state between callers.
    for (const m of parts[i]!.matchAll(CITE_MARKER_RE)) {
      const label = `S${m[1]}`
      if (!seen.has(label)) {
        seen.add(label)
        labels.push(label)
      }
    }
  }
  return labels
}
