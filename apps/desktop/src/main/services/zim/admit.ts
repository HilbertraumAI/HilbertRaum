import { TOKEN_RE, isContentWord } from './query-rewrite'
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

/** Distinct lowercase content-word tokens of >= 3 chars — reuses the plain search rewrite's
 *  own token rule and stop/frame-word lists (`query-rewrite.ts`), so this never invents a
 *  second notion of "content word". */
function tokens(s: string): string[] {
  const out = new Set<string>()
  for (const m of s.matchAll(TOKEN_RE)) {
    const tok = m[0].replace(/-+$/, '')
    if (tok.length < 3) continue
    if (!isContentWord(tok)) continue
    out.add(tok.toLowerCase())
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
 * article's title, and a bounded slice of its body text (the "lead" — see `arm.ts`'s caller
 * for how much text it hands in). Pure; never touches the network.
 */
export function admitArticle(question: string, title: string, bodyText: string, route: string): AdmissionResult {
  const q = norm(question)
  const t = norm(title)
  const lead = norm(bodyText)
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
      lead
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
