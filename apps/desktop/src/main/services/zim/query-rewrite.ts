// The question → `/search` pattern rewrite (#340 L3; rag-design §17 D-Z18).
//
// WHY. kiwix-serve hands the pattern to libzim's Xapian query parser (libzim 9.4.0
// `search.cpp`): default operator AND, STEM_ALL with the archive's stemmer, the archive's own
// stopper, and NO boolean / phrase / wildcard flags. So every word of a natural-language
// question that the archive's stopper does not drop is ANDed into the query — and the pinned
// German Wikipedia archives stop almost nothing ("welche", "rolle", "spielt" all return hits on
// their own). Measured on the real climate pack (2026-09-06, ten German questions): the raw
// question found the expected article in 6 of 9 answerable cases; dropping function words
// alone reached 7 of 9 (AND still kept "rolle spielt", "funktioniert"); dropping the
// question-FRAME words too reached 9 of 9 and was never worse. That is this module.
//
// WHAT. `searchPattern(question)` keeps the question's content words — in their original
// spelling and order, so Xapian's stemmer and hyphen handling see exactly what the user typed
// (`CO2-Konzentration`, `1850`) — and drops (a) function words and (b) question-frame words,
// from CONSERVATIVE German + English lists applied together (only words that are function or
// frame words in one language and not content words in the other; the question's language is
// not known here). The ORIGINAL question stays the reranker's and the prompt's query — the
// rewrite only decides which articles Xapian is asked for. When nothing survives the strip the
// raw question is used unchanged. A `retry` pattern (the kept terms of five or more
// characters) lets the arm ask once more when the first search finds nothing at all: with AND
// semantics one short generic word can still zero a query, and one extra ~100 ms request is
// cheaper than a "not found" the archive would have answered.

/** German + English function words (articles, pronouns, prepositions, auxiliaries, …). */
const STOP_WORDS = new Set<string>(
  (
    'der die das dem den des ein eine einer eines einem einen und oder aber sondern denn ist sind ' +
    'war waren wird werden wurde wurden hat haben hatte hatten kann können könnte könnten muss ' +
    'müssen soll sollen sollte darf dürfen mag mögen ich du er sie es wir ihr mich dich sich uns ' +
    'euch mir dir ihm ihnen mein meine meinen meinem dein deine sein seine seinen seinem unser ' +
    'unsere euer eure nicht kein keine keinen keinem auch noch nur schon sehr mehr als wie was wer ' +
    'wo wann warum wieso weshalb welche welcher welches welchen welchem wem wen wessen bei beim im ' +
    'in ins am an auf aus für mit nach von vom zu zum zur über unter vor hinter zwischen durch ' +
    'gegen ohne um bis seit ob dass daß da doch so dann also etwa ja nein man dies diese dieser ' +
    'dieses diesen diesem jene jener jenes hier dort damit dafür davon dazu darauf daran darin ' +
    'dabei wenn weil falls sowie bzw ' +
    'the a an and or but nor is are was were be been being has have had do does did can could ' +
    'should would may might will shall must i you he she it we they me him her us them my your ' +
    'his its our their not no also only very more most than as what who whom whose which where ' +
    'when why how that this these those there here at by for from in into of on to with without ' +
    'about over under between through during before after up down out off again further then ' +
    'once all any both each few other some such own same so too just if because while until yet'
  ).split(/\s+/)
)

/** Words that FRAME a question without naming its subject ("Welche Rolle spielt …", "Wie
 *  funktioniert …", "What is the difference between …"). Content-neutral in a Wikipedia ask. */
const FRAME_WORDS = new Set<string>(
  (
    'rolle rollen spielt spielen spielte funktioniert funktionieren bedeutet bedeuten heißt heisst ' +
    'erkläre erklären erklär beschreibe beschreiben unterschied unterschiede vergleich vergleiche ' +
    'vergleichen hoch groß gross viel viele gibt geben passiert geschieht entsteht entstehen ' +
    'wichtig bitte nenne nennen zeige zeigen liste sag sage sagen fasse zusammen zusammenfassen ' +
    'kurz genau eigentlich überhaupt ' +
    'explain explains describe describes tell role roles play plays played work works working ' +
    'mean means meaning meant difference differences differ compare comparison happen happens ' +
    'happened important please list give gives name names define definition high much many ' +
    'kind kinds type types sort sorts way ways use used uses purpose'
  ).split(/\s+/)
)

/** The shortest kept term the zero-hit retry keeps (D-Z18). */
export const RETRY_MIN_TERM_CHARS = 5

export interface SearchRewrite {
  /** The pattern to send first: the question's content words, original spelling and order. */
  pattern: string
  /** A narrower pattern to try ONCE when `pattern` finds nothing, or null when it would be the
   *  same query (or empty): the kept terms of `RETRY_MIN_TERM_CHARS` or more characters. */
  retry: string | null
  /** True when the strip changed the question (false = the raw question is the pattern). */
  rewritten: boolean
}

/** Tokens: letters/digits with inner hyphens (`CO2-Konzentration`), no trailing hyphen. */
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}-]*/gu

export function searchPattern(question: string): SearchRewrite {
  const raw = question.trim()
  const kept: string[] = []
  const seen = new Set<string>()
  for (const m of raw.matchAll(TOKEN_RE)) {
    const token = m[0].replace(/-+$/, '')
    if (token === '') continue
    const key = token.toLowerCase()
    if (STOP_WORDS.has(key) || FRAME_WORDS.has(key) || seen.has(key)) continue
    seen.add(key)
    kept.push(token)
  }
  if (kept.length === 0) return { pattern: raw, retry: null, rewritten: false }
  const pattern = kept.join(' ')
  const longer = kept.filter((t) => t.length >= RETRY_MIN_TERM_CHARS)
  const retry = kept.length >= 2 && longer.length > 0 && longer.length < kept.length ? longer.join(' ') : null
  return { pattern, retry, rewritten: pattern !== raw }
}
