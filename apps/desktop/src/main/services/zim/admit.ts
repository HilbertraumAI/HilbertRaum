import { norm } from './head-noun'

// The article admission gate (route F's `admitArticle`, ported as a pure function — Phase 4
// PR-A, `docs/rag-design.md` §17 "Discovery port (Phase 4 PR-A)"). A small set of
// topic-conflict heuristics that refuse an article whose TITLE/lead text plainly names a
// different sense of an ambiguous word than the question asked about (an equipment article
// for a biology question, a novel for a biology question, a mythology article for an
// astronomy question, diving gear for a vertebrate-anatomy question, heraldry for a
// human-anatomy question) — never a claim that an admitted article IS relevant, only that
// nothing here rules it out ("not-a-semantic-certificate").
//
// Deliberately NOT ported: `prototype.mjs`'s precondition on the research resolver's own
// identity fields (`archiveId`/`archiveVersion`/`canonical`/`htmlSha`) — the product's
// `ZimArticle` (`html.ts`) carries no such fields; they were an integrity check on the
// RESEARCH harness's own resolver cache, not part of the topic-conflict semantics being
// ported here.
//
// TWO WINDOWS (F3, review 2026-09-14). Route F's `admitArticle` (`prototype.mjs` line 6) does
// not evaluate every predicate against the same slice of the article: `lead` is `norm(a.blocks
// .filter(b=>b.kind==='prose').slice(0,2)…)` — the first two PROSE blocks only — and feeds
// `title`/`fiction`/the topic-conflict pairs, while `explicitBiology` (the one predicate that
// EXISTS to rescue a biology article from the fiction trap) is `a.blocks.some(...)` — the WHOLE
// article. An earlier port fed both from one bounded window (the arm's first ~20 segments,
// ~4,000 chars), which widens the trap route F never intended past its two-block lead while
// narrowing the escape hatch below route F's unbounded scan — verified to reject gold articles
// route F admits (a real cephalopod article with a "Populärkultur"/"Rezeption" section, both
// inside AND past that window). `admitArticle` now takes the narrow lead and the wide body
// text as two separate arguments so a caller cannot collapse them back into one by accident.
//
// STOP-WORD UNIVERSE (F5, review 2026-09-14). `tokens()` below is `retrieval-v3.mjs`'s own
// ~50-word `stop` set and token rule (`[\p{L}\p{N}]+`, length > 2), ported for THIS predicate
// only — not `query-rewrite.ts`'s ~340-word STOP_WORDS + FRAME_WORDS, which is a much larger
// set built for the `/search` pattern rewrite, not for this gate's lexical-overlap escape
// (`lex(lead, tokens(q)) < 2`, below). A larger stop set here would make the escape MISS more
// often (fewer surviving question tokens to match), which is stricter than route F, not a
// harmless reuse — despite the intuition that reusing one "content word" notion is always the
// safer choice.

/** `retrieval-v3.mjs`'s own stop-word set for `tokens()` (not `query-rewrite.ts`'s — see F5
 *  above): short, mostly function words in German and English plus a few frame words the
 *  research harness's OWN admission predicate was tuned against. Deliberately not the product's
 *  larger STOP_WORDS/FRAME_WORDS list. */
const ADMIT_STOP_WORDS = new Set<string>(
  (
    'der die das dem den des ein eine einer eines und oder aber ist sind war waren werden wurde ' +
    'wer was wie warum welche welcher welches nenne name which what why how when where the and ' +
    'for from with about of in on to alle all bitte erklare erkläre compare vergleich vergleiche'
  ).split(' ')
)

export type AdmissionReason =
  | 'equipment-sense-for-biological-question'
  | 'explicit-literary-topic-without-requested-biological-evidence'
  | 'explicit-different-sense'
  | 'no-explicit-topic-conflict; not-a-semantic-certificate'

export interface AdmissionResult {
  admitted: boolean
  reason: AdmissionReason
  route: string
}

/** Distinct lowercase content-word tokens of > 2 chars — `retrieval-v3.mjs`'s own `tokens()`
 *  (F5): `norm(s).match(/[\p{L}\p{N}]+/gu)`, filtered against `ADMIT_STOP_WORDS`, not the
 *  product's `query-rewrite.ts` token rule/stop lists (deliberately narrower, see the file
 *  header). */
function tokens(s: string): string[] {
  const out = new Set<string>()
  for (const m of norm(s).matchAll(/[\p{L}\p{N}]+/gu)) {
    const tok = m[0]
    if (tok.length <= 2) continue
    if (ADMIT_STOP_WORDS.has(tok)) continue
    out.add(tok)
  }
  return [...out]
}

/** How many of `terms` occur (as a substring) in the normalised `text`. */
function lex(text: string, terms: readonly string[]): number {
  const hay = norm(text)
  let n = 0
  for (const t of terms) if (hay.includes(t)) n++
  return n
}

/**
 * Decide whether a fetched article is admitted for one question, given the question, the
 * article's title, and TWO windows of its body text (F3): `leadText` — route F's own lead, the
 * first two PROSE segments only — feeds the title/fiction/topic-conflict-pair checks exactly as
 * `prototype.mjs` does, and `wideText` — the full segment list, or as much of it as the caller
 * has (route F scans the whole article) — feeds ONLY the `explicitBiology` escape hatch, so it
 * can rescue an article the narrow trap would otherwise refuse. Pure; never touches the network.
 */
export function admitArticle(
  question: string,
  title: string,
  leadText: string,
  wideText: string,
  route: string
): AdmissionResult {
  const q = norm(question)
  const t = norm(title)
  const lead = norm(leadText)
  const wide = norm(wideText)
  const titleAndLead = `${t} ${lead}`

  const biology =
    /herz|heart|kiemen|gill|wirbeltier|vertebrate|tierart|animal species|cephalopod|kopffuss|octopus|oktopus|krake/.test(
      q
    )
  const fiction =
    /bestseller|roman|novel|fiction|literaturpreis|bucher des|bücher des|spielfilm|computerspiel|geschicklichkeitsspiel/.test(
      titleAndLead
    )
  const explicitBiology =
    /kiemenherz|systemherz|branchial heart|systemic heart|blutkreislauf|blood circulat|cephalopod|kopffusser/.test(
      wide
    )

  if (biology && /atemregler|tauchausrustung|diving regulator/.test(titleAndLead)) {
    return { admitted: false, reason: 'equipment-sense-for-biological-question', route }
  }
  if (biology && fiction && !explicitBiology) {
    return { admitted: false, reason: 'explicit-literary-topic-without-requested-biological-evidence', route }
  }

  const pairs: Array<[RegExp, RegExp]> = [
    [/planet|rotation|orbital/, /mytholog|gottin|goddess/],
    [/wirbeltier|animal species|tierart/, /atemregler|tauchausrustung/],
    [/menschlichen korper|human heart/, /heraldik|heraldry/]
  ]
  for (const [wanted, wrong] of pairs) {
    if (wanted.test(q) && wrong.test(titleAndLead) && lex(lead, tokens(q)) < 2) {
      return { admitted: false, reason: 'explicit-different-sense', route }
    }
  }

  return { admitted: true, reason: 'no-explicit-topic-conflict; not-a-semantic-certificate', route }
}
