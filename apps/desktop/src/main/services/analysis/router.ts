import type { ExtractRecordType } from '../../../shared/types'

// The task router (whole-document-analysis plan §4.4, Phase 3) — a PURE function that maps a
// free-text question (or an explicit task button) to an answer engine. No DB, no model, no
// I/O: the caller passes the facts (does a ready deep index exist? is there extracted data in
// scope? how many documents are in scope?) and gets back an engine choice.
//
// Honesty rules it enforces (H7/M7):
//   - "list every / how many" AND the aggregation/categorization verbs (issue #37 —
//     "categorize / group by / sum per category", DE "kategorisiere / gruppiere / Summe pro
//     Kategorie") route to COVERAGE-EXTRACT (never top-k relevance) — but ONLY when there is
//     precomputed extracted data in scope; otherwise it falls back to LABELLED relevance
//     (we must not claim a complete "0 items" list with no precomputed table), marked
//     `fallback: 'coverage'` so the caller leads with the "build the deep index" hint (#38).
//   - A coverage trigger maps the user's "{X}" to one of the fixed extract types via a closed
//     synonym table — the 0-query-call guarantee holds only for a mapped, pre-extracted type.
//     Issue #641: a PLAIN list/count trigger whose "{X}" maps to no type ("list all the
//     abbreviations", "how many pages") never reaches the listing — the `generic` table is "any
//     other salient item", never a list of X. Only an aggregation ask keeps the `generic`
//     default (its #54 shape hint says what the list is).
//   - Issue #641: an EXPLAIN intent (explain / describe / "what does X mean", EN + DE) is never
//     a list request, even when it carries a quantifier ("Erkläre … inkl. aller Abkürzungen") —
//     the listing engine cannot explain. Both #641 cases fall back to LABELLED relevance
//     (`fallback: 'partial'`): the answer may miss items, but a deep index would not help.
//   - Issue #644: a quantifier (all / every / each, alle / jede / sämtliche) is a list request only
//     at the head of a request ("Alle Fristen?", "Kannst du mir alle Fristen nennen?"); inside a
//     question it modifies the question ("Welche Frist gilt für alle Mieter?" → labelled relevance).
//     A yes/no question ("Gilt die Frist für alle Mieter?", "Does the contract list all the
//     deadlines?") asks for a verdict, not a list: an ordinary answer, unless it is a polite request
//     ("Can you list …", "Kannst du … auflisten?").
//   - Fixed precedence: explicit button > compare (needs 2 docs) > coverage-extract >
//     tree-summary > relevance. A compare classified without 2 docs, or any low-confidence
//     classification, falls back to relevance — never an empty result from a stray trigger word.

export type RouteEngine = 'coverage-extract' | 'tree-summary' | 'compare' | 'relevance'

/** An explicit task button the renderer already exposes (bypasses classification). */
export type ExplicitTaskType = 'summary' | 'translate' | 'compare'

export interface RouteInput {
  /** Set when the user pressed an explicit task button (highest precedence). */
  taskType?: ExplicitTaskType
  question: string
  /** Documents in the resolved scope — compare needs at least 2. */
  documentCount?: number
  /** A ready deep-index tree exists in scope (enables tree-summary). */
  treeAvailable: boolean
  /** Precomputed structured-extract data exists in scope (enables coverage-extract). */
  extractAvailable: boolean
}

export interface RouteDecision {
  engine: RouteEngine
  /** The mapped extract type when `engine === 'coverage-extract'`. */
  recordType?: ExtractRecordType
  /**
   * `high` when the classification confidently picked a non-relevance engine; `low` when a
   * trigger fired but the precondition was missing (no extract data / no second doc) and we
   * fell back to relevance. The caller labels a low-confidence relevance answer "not
   * exhaustive" (the Phase-2 meter), never an empty "no items".
   */
  confidence: 'high' | 'low'
  /**
   * WHY a low-confidence decision fell back to relevance (issues #37/#38): `coverage` = a
   * whole-document trigger (list/count over a typed {X}, or aggregate) fired but no extract
   * data exists in scope — the caller may lead the answer with the "build the deep index" hint
   * (#641: only when retrieval actually left sections out); `compare` = a compare intent
   * without two documents; `partial` (#641) = a list/count trigger the listing cannot serve (an
   * explain request, or an untyped {X}) — the caller may label a partial answer, but must not
   * recommend the deep index. Absent on every high-confidence decision.
   */
  fallback?: 'coverage' | 'compare' | 'partial'
}

// --- Language-aware classification regexes (EN + DE) ---
//
// German-morphology rules for EVERY regex below (full-audit 2026-07-10 BE-3; AGGREGATION_RE got
// this right from the start and is the template):
//   - Verb/noun STEMS (auflist, zähl, zusammenfass, vergleich, unterschied, …) sit in their own
//     alternation group with NO trailing \b — the stems only appear inflected (Auflistung,
//     Zähle, Zusammenfassung, Vergleiche, Unterschiede, …) and a trailing boundary can never
//     match mid-word. Complete German words (liste, jede[rsn]?, summe pro, …) stay \b-bounded.
//   - Stems KEEP the leading \b: every stem starts with an ASCII letter, and the leading
//     boundary is what stops e.g. \bzähl from firing inside "erzählen" (the r→z position is
//     word→word, not a boundary).
//   - JS \b is ASCII-defined, so it must never sit adjacent to a non-ASCII initial:
//     \büberblick can never match "Überblick" (the position before "Ü" is not a JS word
//     boundary) — überblick therefore carries no boundary at all.

// The list/count triggers, in two halves (#644). A list or count VERB asks for a list wherever it
// stands; a QUANTIFIER does only at the head of a request (`listRequestShape` below).
const LIST_VERB_RE = /\b(list|enumerate|how many|how much|count)\b|\b(wie ?viele?|liste)\b|\b(auflist|aufzähl|zähl)/i
const QUANTIFIERS = String.raw`every|each|all of (?:the|them)|all the|jede[rsn]?|alle[rsn]?|sämtliche[rsn]?`
const QUANTIFIER_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${QUANTIFIERS})(?![\p{L}\p{N}])`, 'iu')
const HEAD_QUANTIFIER_RE = new RegExp(String.raw`^(?:${QUANTIFIERS})(?![\p{L}\p{N}])`, 'iu')
// Aggregation/categorization verbs (issue #37): "categorize the expenses, sum per category" is a
// whole-document task by nature — no top-k short of "all chunks" yields a correct total. These
// route to coverage exactly like the list/count triggers above: coverage-extract when extract
// data exists, else the LABELLED low-confidence relevance fallback (never a silent top-k sum).
// German verb stems (kategorisier/gruppier/summier/aufschlüssel/aufsummier) deliberately have no
// trailing boundary so inflections match (kategorisiere, Gruppierung, aufgeschlüsselt, …).
const AGGREGATION_RE =
  /\b(categori[sz]e|categori[sz]ation|group(ed)? by|break ?down|sum per|total per|per category|itemi[sz]e|tally)\b|\b(kategorisier|gruppier|summier|aufschlüssel|aufgeschlüsselt|aufsummier)|\b(summe pro|gesamtsumme|pro kategorie|nach kategorie)\b/i
// "zusammenfassen" is separable: an imperative splits it ("Fasse das Dokument zusammen"), so a
// fass(e|t|en)…zusammen alternative catches the split shape alongside the compound stem.
const SUMMARY_RE =
  /\b(summar(?:y|ise|ize|ies)|overview|tl;?dr|gist|whole document|entire document)\b|\b(ganzes? dokument)\b|\b(zusammenfass|fass(?:e|t|en)?\b.*?\bzusammen\b)|überblick/i
const COMPARE_RE =
  /\b(compare|comparison|difference|differences|versus|vs\.?|diff)\b|\b(vergleich|unterschied)/i
// Issue #641: an explain/describe intent. "Erkläre was in diesem Arztbrief steht inkl. aller
// Abkürzungen" matched the alle[rsn]? quantifier above and, once a deep index existed, got the
// listing engine's item dump instead of an explanation. The quantifier here modifies an explain
// request; the request itself is for prose. German forms are listed word by word (the #582
// lesson: a bare stem catches unrelated words), and the German alternatives use letter
// lookarounds instead of \b — JS \b is ASCII-defined, so it never sits next to "ä" ("erklär",
// "erläuter"). Verbs only: a noun is usually a list column or a document part ("every payment
// with its description", "die Erklärung des Vermieters" — the landlord's declaration).
const EXPLAIN_RE =
  /\b(explain|explains|explaining|describe|describes|describing|clarify|interpret|walk me through)\b|\bwhat (?:do|does|did)\b[^.?!]*\b(?:mean|say)\b|\bwhat(?:['’]s| is) (?:meant|in)\b|\bstands? for\b|(?<![\p{L}\p{N}])(erkläre|erklär|erklären|erklärt|erklärst|erläutere|erläuter|erläutern|erläutert|erläuterst|beschreibe|beschreib|beschreiben|beschreibt|beschreibst|was bedeutet|was bedeuten|was heißt|was heisst|was heißen|was meint|was steht|was stehen|wofür steht|wofür stehen|worum geht|gemeint)(?![\p{L}\p{N}])/iu
// #641: question words and modal verbs among the type synonyms ("when", "who", "must", "wann",
// "wer", "muss") pick the TYPE of a list, but they never name a thing to list: "Welche
// Abkürzungen muss ich kennen? Liste alle auf" is not a request for obligations. The typed-{X}
// gate ignores them.
const TYPE_CUE_WORDS_RE = /\b(who|when|must|shall|wer|wann|muss)\b|(?<![\p{L}\p{N}])müssen(?![\p{L}\p{N}])/giu

// #644: the finite verbs a yes/no question opens with. English asks with an auxiliary or modal;
// German puts any finite verb first, so its list is the common auxiliaries and modals plus the
// verbs a question about a contract, a letter or a statement tends to open with. A verb missing
// here costs only the label: the question still never gets the listing (no list verb, no head
// quantifier), it gets the labelled answer instead of the plain one.
const YES_NO_VERBS = new Set(
  (
    'is are was were am do does did has have had will would shall should can could may might must ' +
    "isn't aren't wasn't weren't don't doesn't didn't hasn't haven't hadn't won't wouldn't shouldn't can't couldn't mustn't " +
    'ist sind war waren wäre wären bin bist seid hat haben hatte hatten hätte hätten habe hast habt ' +
    'wird werden wurde wurden würde würden wirst werde kann kannst können konnte konnten könnte könnten ' +
    'muss musst müssen musste mussten müsste müssten darf darfst dürfen durfte durften dürfte dürften ' +
    'soll sollst sollen sollte sollten will willst wollen wollte wollten mag möchte möchten ' +
    'gilt gelten galt galten gibt gab gäbe steht stehen gehört gehören betrifft betreffen ' +
    'enthält enthalten bekommt bekommen erhält erhalten zahlt zahlen zahlte zahlten bezahlt endet enden ' +
    'läuft laufen beginnt beginnen braucht brauchen liegt liegen stimmt stimmen trifft treffen umfasst ' +
    'umfassen deckt decken haftet haften fällt fallen passt passen reicht reichen regelt verlangt zählt'
  ).split(' ')
)
// "was" and "am" are German too ("Was sind alle Fristen?", "Am Monatsende …"): they open a yes/no
// question only before an English subject ("Was every payment on time?", "Am I liable for all costs?").
const ENGLISH_ONLY_BEFORE_SUBJECT = new Set(['was', 'am'])
const ENGLISH_SUBJECTS = new Set(
  'the a this that these those there it i we you he she they my your our their his her its every each all any anything everything'.split(' ')
)
// Words a request or a question may open with before its first real word ("Please, can you …", "Hallo,
// gilt die Frist …?", "And all the payments were on time?"). Skipped wherever an opener may stand.
const FILLERS = new Set('please kindly ok okay so now also and then hey hi hello well bitte und dann noch hallo nun ja'.split(' '))
// A polite request opens like a yes/no question but asks for the thing: a modal before "you" ("Can you
// list every deadline?", "Kannst du mir alle Fristen nennen?"), before "I / we / man" when the asker
// asks to see or get the thing ("Can I see all the deadlines?", "Kann ich alle Fristen sehen?" — but
// "Kann ich alle Zahlungen zurückfordern?" is a yes/no question), or one of the fixed phrases. Matched
// before the yes/no verbs.
const POLITE_MODALS = new Set('can could would will may might kannst könntest können könnten kann könnte würdest würden würde magst darf dürfen dürfte'.split(' '))
const ADDRESSEES = new Set('you u du sie ihr'.split(' '))
const SELF_SUBJECTS = new Set('i we ich wir man'.split(' '))
const SELF_REQUEST_VERBS = new Set('see view get have sehen ansehen anschauen einsehen bekommen erhalten haben'.split(' '))
const POLITE_PHRASES = [
  'is it possible to', 'would it be possible to', 'do you know', 'would you mind', 'is there a list of',
  'ist es möglich', 'wäre es möglich', 'weißt du', 'wissen sie', 'gibt es eine liste', 'gibt es eine aufstellung'
].map((s) => s.split(' '))
// The words a request may open with before the thing it asks for ("Zeig mir alle Zahlungen", "What are all
// the deadlines?", "Bitte nenne mir sämtliche Fristen"). Stripped repeatedly from the head of a sentence,
// longest first; what follows is the head the quantifier must stand at. List verbs need no entry: one asks
// for a list wherever it stands ("Erstelle eine Liste aller Fristen" — "Liste" counts as the word "list"
// does). A request verb missing here costs the listing, not the answer: the request
// gets the labelled written answer (#641's direction), never the listing for a question.
const REQUEST_OPENERS = [
  'i need', 'we need', 'i want', 'i would like', "i'd like", 'give me', 'give us', 'give', 'show me', 'show us', 'show',
  'tell me', 'tell us', 'tell', 'get me', 'get', 'see', 'view', 'have', 'name', 'find', 'provide', 'extract', 'pull out',
  'pull', 'collect', 'gather', 'identify', 'display', 'print', 'retrieve', 'highlight', 'output', 'compile', 'fetch',
  'share', 'write down', 'write out', 'note', 'mark', 'make', 'create', 'listing',
  'what are', 'what were', "what're", 'which are', 'which were', 'who are', 'who were', 'when are', 'when were',
  'where are', 'where were', 'me', 'us',
  'ich brauche', 'wir brauchen', 'ich möchte', 'ich will', 'ich hätte gern', 'ich hätte gerne', 'zeig', 'zeige',
  'zeigen sie', 'gib', 'geben sie', 'nenn', 'nenne', 'nennen sie', 'sag', 'sage', 'sagen sie', 'mir sagen', 'uns sagen',
  'finde', 'finden sie', 'such', 'suche', 'suchen sie', 'sammle', 'sammeln sie', 'listen sie', 'zählen sie',
  'extrahiere', 'extrahier', 'extrahieren sie', 'ermittle', 'ermitteln sie', 'schreib', 'schreibe', 'schreiben sie',
  'führe', 'führ', 'führen sie', 'stelle', 'stell', 'stellen sie', 'markiere', 'markieren sie', 'liefere',
  'liefern sie', 'hole', 'hol', 'erstelle', 'erstell', 'erstellen sie', 'mach', 'mache', 'eine aufstellung', 'mir', 'uns', 'was sind', 'was waren', 'welche sind', 'welche waren', 'wer sind', 'wer waren',
  'wann sind', 'wo sind', 'wie lauten', 'wie heißen'
]
  .map((s) => s.split(' '))
  .sort((a, b) => b.length - a.length)
// After a polite opener or a request verb, "whether / if / ob" embeds a yes/no question ("Can you tell
// me whether all the payments were on time?"). "ob" needs no opener; a bare "if" opens a condition.
const EMBEDDED_YES_NO = new Set(['whether', 'ob'])
// Words that start a relative or subordinate clause after a quantifier ("every deadline that is binding"):
// a verb behind one belongs to the clause, not to a statement asked as a question.
const CLAUSE_WORDS = new Set('that which who whom whose where when if whether because'.split(' '))
// A period ends a sentence only after a word of four letters or more that is not one of these.
const ABBREVIATIONS = new Set('inkl bzw ggf evtl ziff incl approx resp vgl usw etc'.split(' '))

/** The lower-cased words of one sentence (letters and digits; an apostrophe stays inside a word). */
function sentenceWords(sentence: string): string[] {
  return sentence.toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}]+(?:'\p{L}+)?/gu) ?? []
}

/** The question's sentences. A sentence ends at ? ! ; : and at a period before a capital, except after a
 *  number ("ab dem 1. Mai"), a short word ("lt. Vertrag", "z. B.") or a listed abbreviation ("inkl.
 *  Verlängerung"). A line break alone ends none ("Gilt die Frist\nfür alle Mieter?"). */
function sentencesOf(question: string): string[] {
  const sentences: string[] = []
  let from = 0
  for (const m of question.matchAll(/[?!;:]+|\.(?=\s+\p{Lu})/gu)) {
    if (m[0] === '.') {
      const word = /\p{L}+$/u.exec(question.slice(from, m.index))?.[0] ?? ''
      if (word.length < 4 || ABBREVIATIONS.has(word.toLowerCase())) continue
    }
    sentences.push(question.slice(from, m.index + m[0].length))
    from = m.index + m[0].length
  }
  sentences.push(question.slice(from))
  return sentences
}

/** `at` moved past any filler words. */
function pastFillers(words: readonly string[], at: number): number {
  while (FILLERS.has(words[at] ?? '')) at++
  return at
}

/** The length of the longest opener at `words[at]`, or 0 (`openers` sorted longest first). */
function openerAt(words: readonly string[], at: number, openers: readonly string[][]): number {
  return openers.find((o) => o.every((w, k) => words[at + k] === w))?.length ?? 0
}

/** The length of the polite request opener at `words[at]`, or 0. */
function politeOpenerAt(words: readonly string[], at: number, sentence: string): number {
  const phrase = openerAt(words, at, POLITE_PHRASES)
  if (phrase > 0) return phrase
  if (!POLITE_MODALS.has(words[at] ?? '')) return 0
  const subject = words[at + 1] ?? ''
  if (ADDRESSEES.has(subject)) return 2
  const asksToSeeOrGet =
    LIST_VERB_RE.test(sentence) ||
    SELF_REQUEST_VERBS.has(words[pastFillers(words, at + 2)] ?? '') ||
    SELF_REQUEST_VERBS.has(words[words.length - 1] ?? '')
  return SELF_SUBJECTS.has(subject) && asksToSeeOrGet ? 2 : 0
}

/** Is `words[at]` the finite verb a yes/no question opens with? */
function yesNoVerbAt(words: readonly string[], at: number): boolean {
  const verb = words[at] ?? ''
  return YES_NO_VERBS.has(verb) && (!ENGLISH_ONLY_BEFORE_SUBJECT.has(verb) || ENGLISH_SUBJECTS.has(words[at + 1] ?? ''))
}

/** A claim about the quantified items, asked or stated ("Jede Zahlung ist am Ersten fällig?", "Each payment
 *  is due on the 1st, right?"): a finite verb after the quantifier, before any comma or clause word. "Alle
 *  Fristen, die gelten?" and "Every deadline that is binding?" stay requests. */
function isClaim(sentence: string): boolean {
  const fromQuantifier = sentence.slice(QUANTIFIER_RE.exec(sentence)?.index ?? 0).split(',')[0] ?? ''
  for (const word of sentenceWords(fromQuantifier).slice(1)) {
    if (CLAUSE_WORDS.has(word)) return false
    if (YES_NO_VERBS.has(word)) return true
  }
  return false
}

/** One sentence's shape for #644: is it a yes/no question, and does a quantifier head its request? */
function sentenceShape(sentence: string): { yesNo: boolean; headQuantifier: boolean } {
  const words = sentenceWords(sentence)
  let at = pastFillers(words, 0)
  const polite = politeOpenerAt(words, at, sentence)
  if (polite === 0 && yesNoVerbAt(words, at)) return { yesNo: true, headQuantifier: false }
  let stripped = polite > 0
  at = pastFillers(words, at + polite)
  for (let n = openerAt(words, at, REQUEST_OPENERS); n > 0; n = openerAt(words, at, REQUEST_OPENERS)) {
    at = pastFillers(words, at + n)
    stripped = true
  }
  const head = words[at] ?? ''
  if (EMBEDDED_YES_NO.has(head) || (stripped && head === 'if')) return { yesNo: true, headQuantifier: false }
  if (!HEAD_QUANTIFIER_RE.test(words.slice(at).join(' '))) return { yesNo: false, headQuantifier: false }
  return isClaim(sentence) ? { yesNo: true, headQuantifier: false } : { yesNo: false, headQuantifier: true }
}

/**
 * #644: what a question's list/count triggers ask for. `list` — a list or count verb, or a quantifier at
 * the head of a request, in a sentence that is not a yes/no question (`listSentence` is that sentence);
 * `modifier` — a quantifier inside some other question ("When is each payment due?"), which the listing
 * cannot answer; null — no trigger, or every trigger sits in a yes/no question, which asks for a verdict.
 * Judged sentence by sentence ("Ich habe einen Mietvertrag. Gilt die Frist für alle Mieter?").
 */
function listRequestShape(question: string): { shape: 'list' | 'modifier' | null; listSentence?: string } {
  let modifier = false
  for (const sentence of sentencesOf(question)) {
    const listVerb = LIST_VERB_RE.test(sentence)
    if (!listVerb && !QUANTIFIER_RE.test(sentence)) continue
    const { yesNo, headQuantifier } = sentenceShape(sentence)
    if (yesNo) continue
    if (listVerb || headQuantifier) return { shape: 'list', listSentence: sentence }
    modifier = true
  }
  return { shape: modifier ? 'modifier' : null }
}

/** Closed-vocabulary synonym table: a user's "{X}" → an extracted type (plan §4.2 step 4). #644: no
 *  word with a common second sense — "terms" (medical terms), "names" (names of the medications),
 *  "Daten" (data) — so such an ask is untyped and gets the labelled answer, not the wrong list. */
const TYPE_SYNONYMS: Array<{ type: ExtractRecordType; re: RegExp }> = [
  {
    type: 'date',
    re: /\b(deadline|deadlines|due date|due dates|due|date|dates|when)\b|\b(frist|fristen|termin|termine|datum|fälligkeit|wann)\b/i
  },
  {
    type: 'amount',
    re: /\b(cost|costs|fee|fees|price|prices|amount|amounts|payment|payments|money|sum|sums|expense|expenses|spending|income|revenue)\b|\b(kosten|betrag|beträge|gebühr|gebühren|preis|preise|summe|summen|zahlung|zahlungen|ausgabe|ausgaben|einnahme|einnahmen|umsatz|umsätze)\b/i
  },
  {
    type: 'party',
    re: /\b(who|part(?:y|ies)|signator(?:y|ies)|person|people|persons|organi[sz]ation|organi[sz]ations|company|companies)\b|\b(wer|partei|parteien|person|personen|unternehmen|firma|firmen|organisation|organisationen)\b/i
  },
  {
    type: 'obligation',
    re: /\b(obligation|obligations|must|shall|clause|clauses|requirement|requirements|dut(?:y|ies))\b|\b(pflicht|pflichten|klausel|klauseln|muss|müssen|anforderung|anforderungen|verpflichtung|verpflichtungen|bedingung|bedingungen)\b/i
  }
]

/**
 * Did the #37 aggregation lexicon (categorize / group by / sum per …) fire — as opposed to a
 * plain list/count trigger? Pure, issue #54: the coverage-extract listing engine can only GROUP
 * BY value with counts, so an aggregation-shaped ask served by it gets an answer of the WRONG
 * SHAPE (a frequency list, not the requested categories/sums). The listing renderer uses this
 * to lead such an answer with an honest shape hint + the bank-statement-skill pointer instead
 * of presenting the list as if it were what was asked for.
 */
export function isAggregationShaped(question: string): boolean {
  return AGGREGATION_RE.test(question ?? '')
}

/** The extract type a question's "{X}" names, or null when no synonym matches (#641). #644: the
 *  synonym that comes FIRST in the question wins, not the first table row — the thing asked for is
 *  named before what it is asked with ("List all payments and their due dates" lists payments). */
function matchedRecordType(question: string): ExtractRecordType | null {
  let first: { type: ExtractRecordType; at: number } | null = null
  for (const { type, re } of TYPE_SYNONYMS) {
    const at = question.search(re)
    if (at >= 0 && (first === null || at < first.at)) first = { type, at }
  }
  return first?.type ?? null
}

/** The question without its #641 type cue words (who / when / must …, wer / wann / muss …). */
function withoutTypeCueWords(question: string): string {
  return question.replace(TYPE_CUE_WORDS_RE, ' ')
}

// #644: the modal verbs among the cue words. "who" / "when" can name what a list is of ("List who paid
// each fee"); "must" never does ("How many tenants must pay a fee?" asks about fees, not obligations), so
// it decides the type only when nothing else is named.
const MODAL_CUE_WORDS_RE = /\b(must|shall|muss)\b|(?<![\p{L}\p{N}])müssen(?![\p{L}\p{N}])/giu

/** The extract type a text names first, a modal cue word only when nothing else is named. */
function namedRecordType(text: string): ExtractRecordType | null {
  return matchedRecordType(text.replace(MODAL_CUE_WORDS_RE, ' ')) ?? matchedRecordType(text)
}

/** Map a free-text "list every {X}" to the closed extract type set (default `generic`). */
export function mapQuestionToRecordType(question: string): ExtractRecordType {
  return namedRecordType(question) ?? 'generic'
}

/** Classify a question / explicit button into an engine choice (pure; plan §4.4). */
export function routeQuestion(input: RouteInput): RouteDecision {
  const q = input.question ?? ''
  const docs = input.documentCount ?? 0

  // 1. Explicit task buttons win outright.
  if (input.taskType === 'compare') {
    return docs >= 2
      ? { engine: 'compare', confidence: 'high' }
      : { engine: 'relevance', confidence: 'low', fallback: 'compare' }
  }
  if (input.taskType === 'summary' || input.taskType === 'translate') {
    // Summarize/translate are served by their own task pipelines, not rag:ask — but for a
    // routed summary, prefer the tree when present (degrades to the capped path otherwise).
    return input.taskType === 'summary' && input.treeAvailable
      ? { engine: 'tree-summary', confidence: 'high' }
      : { engine: 'relevance', confidence: 'low' }
  }

  const wantsCompare = COMPARE_RE.test(q)
  // #641: a plain list/count trigger counts only for a list request about a TYPED thing. An
  // explain request that carries a quantifier, or a "{X}" no extract type covers, never gets
  // the listing — it could only print the unrelated `generic` table (step 4b labels it instead).
  // An aggregation ask stays coverage whatever its {X} (#37: never a silent top-k sum).
  // #644: and only a list REQUEST — a list verb, or a quantifier at the head of the request — whose
  // own sentence names the typed thing ("Gilt die Frist für alle Mieter? Liste alle Abkürzungen auf"
  // is an untyped list request; the other sentence's "Frist" does not type it).
  const { shape: triggerShape, listSentence } = listRequestShape(q)
  const listTrigger = triggerShape === 'list'
  const namesTypedThing = listSentence !== undefined && matchedRecordType(withoutTypeCueWords(listSentence)) !== null
  const wantsListing = listTrigger && !EXPLAIN_RE.test(q) && namesTypedThing
  const wantsCoverage = wantsListing || AGGREGATION_RE.test(q)
  const wantsSummary = SUMMARY_RE.test(q)

  // 2. Compare (needs two documents). A compare intent without 2 docs is low-confidence and
  //    falls back to labelled relevance (plan §4.4) — it does NOT fall through to coverage.
  if (wantsCompare) {
    return docs >= 2
      ? { engine: 'compare', confidence: 'high' }
      : { engine: 'relevance', confidence: 'low', fallback: 'compare' }
  }

  // 3. Coverage-extract ("list every / how many" over a typed {X} + the #37 aggregation verbs):
  //    only when there IS precomputed extracted data — otherwise we cannot honestly claim a
  //    complete list, so fall back to relevance, marked `fallback: 'coverage'` so the caller can
  //    lead the answer with the actionable "build the deep index" hint (#38) instead of a silent
  //    partial sum.
  if (wantsCoverage) {
    if (input.extractAvailable) {
      return {
        engine: 'coverage-extract',
        // #644: the type the list request itself names first ("What must every tenant pay? List all
        // the fees" lists fees; "List when every payment is due" lists dates), else the question's.
        recordType: (listSentence !== undefined ? namedRecordType(listSentence) : null) ?? mapQuestionToRecordType(q),
        confidence: 'high'
      }
    }
    return { engine: 'relevance', confidence: 'low', fallback: 'coverage' }
  }

  // 4. Tree-summary ("summarize / overview / whole document") when a deep index is ready.
  if (wantsSummary && input.treeAvailable) {
    return { engine: 'tree-summary', confidence: 'high' }
  }

  // 4b. #641: a list/count trigger the listing cannot serve (an explain request, an untyped {X})
  //     — LABELLED relevance: the caller may say the answer can miss items, but never recommends
  //     the deep index, which would not answer it either. #644: a quantifier inside a question
  //     ("When is each payment due?") is labelled the same way: the answer covers several items.
  if (triggerShape === 'list' || triggerShape === 'modifier') {
    return { engine: 'relevance', confidence: 'low', fallback: 'partial' }
  }

  // 5. Everything else → relevance RAG (the existing retrieve path, byte-unchanged). #644: so is a
  //    yes/no question whatever triggers it carries — it asks for a verdict, not a list.
  return { engine: 'relevance', confidence: 'high' }
}
