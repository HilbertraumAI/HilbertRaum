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
//   - Issue #649: "how much" / "wie viel" ask for an amount, not a list: a lookup ("How much is the
//     monthly fee?") is an ordinary question, a sum ("How much did I pay in fees?", "Wie hoch ist die
//     Summe aller Zahlungen?") joins the aggregation route. "the list" / "der Liste" in a question-word
//     question ("Welche Fristen stehen auf der Liste?") and "zählen zu / zählt als" / "count as" ask for
//     no list.
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
// stands; a QUANTIFIER does only at the head of a request (`listRequestShape` below). #649: "how much" /
// "wie viel" ask for an amount, not a list: a lookup is an ordinary question, a sum is `isSumSentence`'s.
const LIST_VERB_RE = /\b(list|enumerate|how many|count)\b|\b(wie ?viele|liste)\b|\b(auflist|aufzulist|aufzähl|aufzuzähl|zähl)/i
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
// gate ignores them. #644: the modals never name what a list is of either ("How many tenants must pay
// a fee?" asks about fees), so they also decide the type only when nothing else is named.
const MODAL_CUE_WORDS = ['must', 'shall', 'muss', 'müssen']
const wordsRe = (words: readonly string[]): RegExp =>
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${words.join('|')})(?![\p{L}\p{N}])`, 'giu')
const TYPE_CUE_WORDS_RE = wordsRe(['who', 'when', 'wer', 'wann', ...MODAL_CUE_WORDS])
const MODAL_CUE_WORDS_RE = wordsRe(MODAL_CUE_WORDS)

// #644: the finite verbs a yes/no question opens with. English asks with an auxiliary or modal;
// German puts any finite verb first, so its list is the common auxiliaries and modals plus the
// verbs a question about a contract, a letter or a statement tends to open with. A verb missing
// here costs only the label: the question still never gets the listing (no list verb, no head
// quantifier), it gets the labelled answer instead of the plain one.
const EN_YES_NO_VERBS =
  'is are was were am do does did has have had will would shall should can could may might must ' +
  "isn't aren't wasn't weren't don't doesn't didn't hasn't haven't hadn't won't wouldn't shouldn't can't couldn't mustn't"
const DE_YES_NO_VERBS =
  'ist sind war waren wäre wären bin bist seid hat haben hatte hatten hätte hätten habe hast habt ' +
  'wird werden wurde wurden würde würden wirst werde kann kannst können konnte konnten könnte könnten ' +
  'muss musst müssen musste mussten müsste müssten darf darfst dürfen durfte durften dürfte dürften ' +
  'soll sollst sollen sollte sollten will willst wollen wollte wollten mag möchte möchten ' +
  "gilt gelten galt galten gibt gibt's gibts gab gäbe steht stehen gehört gehören betrifft betreffen " +
  'enthält enthalten bekommt bekommen erhält erhalten zahlt zahlen zahlte zahlten bezahlt endet enden ' +
  'läuft laufen beginnt beginnen braucht brauchen liegt liegen stimmt stimmen trifft treffen umfasst ' +
  'umfassen deckt decken haftet haften fällt fallen passt passen reicht reichen regelt verlangt zählt zählen'
const wordSet = (words: string): Set<string> => new Set(words.split(' '))
const YES_NO_VERBS = wordSet(`${EN_YES_NO_VERBS} ${DE_YES_NO_VERBS}`)
// "was" and "am" are German too ("Was sind alle Fristen?", "Am Monatsende …"): they open a yes/no
// question only before an English subject ("Was every payment on time?", "Am I liable for all costs?").
const ENGLISH_ONLY_BEFORE_SUBJECT = wordSet('was am')
const ENGLISH_SUBJECTS = wordSet(
  'the a this that these those there it i we you he she they my your our their his her its every each all any anything everything'
)
// Words a request or a question may open with before its first real word ("Please, can you …", "Alles
// klar, gilt die Frist …?", "And all the payments were on time?"). Skipped wherever an opener may stand;
// a sentence of fillers alone ("Alles klar.", "Danke!") asks nothing.
const FILLERS = [
  'alles klar', 'thank you', 'got it', 'all right', 'please', 'kindly', 'ok', 'okay', 'so', 'now', 'also', 'and',
  'then', 'hey', 'hi', 'hello', 'well', 'thanks', 'great', 'alright', 'perfect', 'bitte', 'und', 'dann', 'noch',
  'hallo', 'nun', 'ja', 'danke', 'gut', 'klar', 'super', 'prima', 'perfekt', ','
]
  .map((s) => s.split(' '))
  .sort((a, b) => b.length - a.length)
// A polite request opens like a yes/no question but asks for the thing ("Can you list every deadline?",
// "Kannst du mir alle Fristen nennen?", "Do you have a list of all the deadlines?"). Its verb is followed
// by the one asked (you / du / Sie / ihr — Sie and ihr only with a plural verb: "Kann sie …" is "can
// she") or by the asker (I / we / man, after a modal), and the sentence asks for something: a list verb,
// a request verb right after that word or as its last word, or "mir / uns" ("Kann ich alle Fristen sehen?",
// "Können Sie mir alle Fristen nennen?"). Without one it is a yes/no question: "Can you deduct all the
// fees?", "Können Sie alle Fristen einhalten?", "Kann ich alle Zahlungen zurückfordern?". Or it is one of
// the fixed phrases. Matched before the yes/no verbs.
const POLITE_MODALS = wordSet('can could would will may might kannst könntest können könnten kann könnte würdest würden würde magst darf dürfen dürfte')
const ADDRESSEES = wordSet('you u du')
const PLURAL_ADDRESSEES = wordSet('sie ihr')
const PLURAL_VERBS = wordSet(
  'können könnten würden dürfen dürften müssen sollen sollten wollen möchten haben hätten hatten sind wären waren ' +
    'werden wurden zählen könnt würdet habt seid wollt sollt dürft'
)
const SELF_SUBJECTS = wordSet('i we ich wir man')
const REQUEST_SIGNALS = wordSet(
  'give show tell list name find get provide send pull extract display print see view have share enumerate count ' +
    'mir uns nennen zeigen geben sagen schicken senden auflisten aufzählen heraussuchen raussuchen zusammenstellen ' +
    'erstellen sehen ansehen anschauen einsehen bekommen erhalten haben ausgeben liefern'
)
const POLITE_PHRASES = [
  'is it possible to', 'would it be possible to', 'do you know', 'would you mind', 'do you mind', 'is there a list of',
  'ist es möglich', 'wäre es möglich', 'weißt du', 'wissen sie', 'gibt es eine liste', 'gibt es eine aufstellung'
].map((s) => s.split(' '))
// The words a request may open with before the thing it asks for ("Zeig mir alle Zahlungen", "What are all
// the deadlines?", "Fasse alle Fristen zusammen"). Stripped repeatedly from the head of a sentence, longest
// first; what follows is the head the quantifier must stand at. List verbs need no entry: one asks for a
// list wherever it stands ("Erstelle eine Liste aller Fristen" — "Liste" counts as the word "list" does).
// When- and where-questions are not requests ("When are all the payments due?" is labelled like "When is
// each payment due?"). A request verb missing here costs the listing, not the answer: the request gets the
// labelled written answer (#641's direction), never the listing for a question.
const REQUEST_OPENERS = [
  'i need', 'we need', 'i want', 'i would like', "i'd like", 'give me', 'give us', 'give', 'show me', 'show us', 'show',
  'tell me', 'tell us', 'tell', 'get me', 'get', 'see', 'view', 'have', 'name', 'find', 'provide', 'extract', 'pull out',
  'pull', 'collect', 'gather', 'identify', 'display', 'print', 'retrieve', 'highlight', 'output', 'compile', 'fetch',
  'share', 'write down', 'write out', 'note', 'mark', 'make', 'create', 'listing', 'summarize', 'summarise',
  'an overview of', 'overview of', 'a summary of', 'what are', 'what were', "what're", 'which are', 'which were',
  'who are', 'who were', 'me', 'us',
  'ich brauche', 'wir brauchen', 'ich möchte', 'ich will', 'ich hätte gern', 'ich hätte gerne', 'zeig', 'zeige',
  'zeigen sie', 'gib', 'geben sie', 'nenn', 'nenne', 'nennen sie', 'sag', 'sage', 'sagen sie', 'mir sagen', 'uns sagen',
  'finde', 'finden sie', 'such', 'suche', 'suchen sie', 'sammle', 'sammeln sie', 'listen sie', 'zählen sie',
  'extrahiere', 'extrahier', 'extrahieren sie', 'ermittle', 'ermitteln sie', 'schreib', 'schreibe', 'schreiben sie',
  'führe', 'führ', 'führen sie', 'stelle', 'stell', 'stellen sie', 'markiere', 'markieren sie', 'liefere',
  'liefern sie', 'hole', 'hol', 'erstelle', 'erstell', 'erstellen sie', 'mach', 'mache', 'fasse', 'fass',
  'eine aufstellung', 'eine übersicht über', 'einen überblick über', 'mir', 'uns', 'was sind', 'was waren',
  'welche sind', 'welche waren', 'wer sind', 'wer waren', 'wie lauten', 'wie heißen'
]
  .map((s) => s.split(' '))
  .sort((a, b) => b.length - a.length)
// "whether / ob" at the head embed a yes/no question ("Ob alle Zahlungen pünktlich waren?", "Can you tell
// me whether …"); "if" does only right after an opener ("Tell me if …"), a bare "if" opens a condition.
const EMBEDDED_YES_NO = wordSet('whether ob')
// A claim about the quantified items ("Jede Zahlung ist pünktlich eingegangen?") has its verb right after
// them, in the quantifier's language. A verb behind a comma or one of these clause words belongs to a
// clause instead ("Every deadline that is binding?"); German "die / das / welche …" only before a
// lower-case word ("Alle Zahlungen die ich erhalten habe?", but "Jede Zahlung an die Vermieterin ist …").
const EN_QUANTIFIER_WORDS = wordSet('every each all')
const EN_CLAUSE_WORDS = wordSet('that which who whom whose where when if whether because')
const DE_CLAUSE_WORDS = wordSet('was wo dass wenn falls ob weil denen deren dessen')
const DE_RELATIVES = wordSet('die das welche welcher welches welchen welchem')
const EN_CLAIM_VERBS = wordSet(EN_YES_NO_VERBS)
const DE_CLAIM_VERBS = wordSet(DE_YES_NO_VERBS)
// A period ends a sentence except after one of these, after a single letter ("z. B."), or after a day
// before a month ("ab dem 1. Mai").
const ABBREVIATIONS = wordSet('inkl bzw ggf evtl ziff incl approx resp vgl usw etc lt gem ca nr abs art bzgl zzgl sog dr prof hr fr str tel vs no st')
const MONTHS = wordSet(
  'januar jan februar feb märz mär april apr mai juni jun juli jul august aug september sep sept oktober okt ' +
    'november nov dezember dez january february march mar may june july october oct december dec'
)

// #649: "list" / "Liste" (and "Aufzählung" / "Auflistung") after a definite article, a demonstrative or a
// possessive, in a question that opens with a question word, asks about a list the document holds ("Welche
// Fristen stehen auf der Liste?", "What is on the list of fees?", "Kannst du mir sagen, was auf der Liste
// steht?"), and so does a list after "which" / "welche…" anywhere ("Auf welcher Liste steht die Frist?"). Any
// other "list" still asks for one: a request ("Zeig mir die Liste der Fristen", "Zeigst du mir die Liste der
// Fristen?"), "a list" / "eine Liste" ("Could you put together a list of all the fees?").
const LIST_NOUNS = wordSet('list liste aufzählung auflistung')
const DEFINITE_DETERMINERS = wordSet(
  'the this that my your our their his her its der die den dem des diese dieser diesen diesem dieses meine meiner ' +
    'meinen meinem deine deiner deinen deinem ihre ihrer ihren ihrem unsere unserer unseren unserem eure eurer euren ' +
    'eurem seine seiner seinen seinem'
)
const INTERROGATIVE_DETERMINERS = wordSet('which what welche welcher welchen welchem welches')
const QUESTION_WORDS = wordSet(
  'what which where who whom whose when why how was welche welcher welches welchen welchem wo wer wen wem wessen wann ' +
    'warum wieso weshalb wie wofür worauf worin wovon womit woran'
)
// A question may open with a preposition before its question word ("Auf welcher Seite der Liste …?").
const PREPOSITIONS = wordSet('auf in an von aus für mit bei nach zu über unter vor on at from for with of to by under')
// #649: "zählen zu / zum / zur / als" and "count as / toward" mean "belong to", not "count" ("Welche Kosten zählen
// zu den Nebenkosten?", "Was zählt als Zahlung?", "Which fees count as operating costs?"), unless "auf" ends the
// clause ("Zähle alle Zahlungen zur Miete auf" is "aufzählen"). A "zähl…" word that is no verb form is a meter
// ("Zähler", "Zählerstand").
const DE_COUNT_VERBS = wordSet('zähl zähle zählst zählt zählen zählte zählten')
// "Zähle alle Zahlungen zur Miete" is a request: the imperative never means "belong to".
const DE_COUNT_IMPERATIVES = wordSet('zähl zähle')
const DE_COUNT_AS_WORDS = wordSet('zu zum zur als')
const EN_COUNT_AS_WORDS = wordSet('as toward towards among against')

// #649: a sum ask wants the total of amounts. The listing cannot add up (#54) and a top-k answer adds up only
// what it read (#37), so a sum takes the aggregation route (`isSumAsk`). Judged per sentence; never with a count
// ("How many payments are there in total?" asks for the list), an explain verb ("Erkläre, wie sich die
// Gesamtmiete zusammensetzt") or in a yes/no question, which asks for a verdict (#644: "Is the total correct on
// page 2?"). Three shapes:
//   - a sum word: "total", "sum of", "add up", "Summe aller", "Gesamtbetrag", "addiere", "zusammenrechnen", or
//     "zusammen" after a reckoning verb ("Rechne alle Zahlungen zusammen");
//   - a totalling word beside a money word ("How much are all the fees together?", "Was kostet alles
//     zusammen?"); alone it is often no sum ("Wer wohnt zusammen in der Wohnung?", "Wie lange läuft der
//     Vertrag insgesamt?");
//   - "how much" / "wie viel" with a pay or spend verb ("How much did I pay in fees?", "Wie viel habe ich für
//     Gebühren bezahlt?"); a lookup has none ("How much is the monthly fee?", "Wie viel kostet der Stellplatz?").
const SUM_WORDS = wordSet(
  'total totals totaled totalled totaling totalling gesamtbetrag gesamtbeträge gesamtkosten gesamtpreis gesamtmiete ' +
    'gesamtausgaben gesamteinnahmen gesamtzahlung gesamtzahlungen addiere addieren addiert addier aufaddieren ' +
    'aufaddiert zusammenrechnen zusammengerechnet zusammenzählen zusammengezählt'
)
// A measure without a money word adds up no amounts ("What is the total area of the flat?", "How long is the
// lease in total?").
const MEASURE_WORDS = wordSet(
  'long lang lange area fläche wohnfläche size größe duration dauer laufzeit term months years weeks days monate ' +
    'monaten jahre jahren wochen tage tagen pages seiten'
)
const SUM_PHRASES = [
  'sum of', 'the sum', 'sum total', 'add up', 'adds up', 'added up', 'adding up', 'add together', 'added together',
  'summe aller', 'summe der', 'summe von', 'summe sämtlicher', 'die summe', 'in summe'
].map((s) => s.split(' '))
const RECKONING_VERBS = wordSet('rechne rechnet rechnen zähle zähl zählt zählen addiere')
const TOTALLING_WORDS = wordSet('altogether together combined insgesamt zusammen')
// "together with", "zusammen mit", "combined with" join two things, they add nothing up.
const NO_TOTAL_BEFORE = wordSet('with mit')
// "Fasse alle Kosten zusammen" summarises them; "Stelle alle Kosten zusammen", "put together a list of all the
// fees" gather them into a list.
const GATHERING_VERBS = wordSet('fasse fass fasst fassen stelle stell stellt stellen trage trag tragt tragen put puts putting')
const MONEY_WORDS = wordSet(
  'much cost costs price prices pay pays paid paying spend spends spent owe owes owed fee fees charge charges rent ' +
    'deposit amount amounts money payment payments expense expenses euro euros eur dollar dollars usd chf viel hoch ' +
    'kostet kosten kostete preis preise zahle zahlst zahlt zahlen zahlte gezahlt bezahle bezahlt bezahlen bezahlte ' +
    'ausgegeben miete kaution geld betrag beträge gebühr gebühren zahlung zahlungen ausgaben einnahmen'
)
const SPEND_VERBS = wordSet(
  'pay pays paid paying spend spends spent owe owes owed charged earned received zahle zahlst zahlt zahlen zahlte ' +
    'zahlten gezahlt bezahle bezahlst bezahlt bezahlen bezahlte bezahlten ausgegeben ausgeben überwiesen verdient ' +
    'eingenommen erhalten schulde schuldest schulden'
)
const HOW_MUCH = [['how', 'much'], ['wie', 'viel'], ['wieviel']]
// "the total number of payments" is a count.
const COUNT_PHRASES = [['how', 'many'], ['wie', 'viele'], ['wieviele'], ['number', 'of'], ['total', 'number'], ['total', 'count'], ['anzahl']]

/** A sentence's words (letters and digits, an apostrophe inside a word) and commas, as written and lower-cased. */
function sentenceTokens(sentence: string): { raw: string[]; words: string[] } {
  const raw = sentence.replace(/’/g, "'").match(/[\p{L}\p{N}]+(?:'\p{L}+)?|,/gu) ?? []
  return { raw, words: raw.map((w) => w.toLowerCase()) }
}

/** The question's sentences. A sentence ends at ? ! ; and at a period before a capital, except after a
 *  listed abbreviation ("lt. Vertrag", "inkl. Verlängerung"), a single letter ("z. B.") or a day before a
 *  month ("ab dem 1. Mai"). A colon ("Liste: alle Fristen", "bis 10:30") or a line break ends none. */
function sentencesOf(question: string): string[] {
  const sentences: string[] = []
  let from = 0
  for (const m of question.matchAll(/[?!;]+|\.(?=\s+\p{Lu})/gu)) {
    if (m[0] === '.') {
      const before = /[\p{L}\p{N}]+$/u.exec(question.slice(from, m.index))?.[0] ?? ''
      const next = /^\s+(\p{L}+)/u.exec(question.slice(m.index + 1))?.[1]?.toLowerCase() ?? ''
      const dayOfMonth = /^\d{1,2}$/.test(before) && MONTHS.has(next)
      if (before.length === 1 || ABBREVIATIONS.has(before.toLowerCase()) || dayOfMonth) continue
    }
    sentences.push(question.slice(from, m.index + m[0].length))
    from = m.index + m[0].length
  }
  sentences.push(question.slice(from))
  return sentences
}

/** The length of the longest opener at `words[at]`, or 0 (`openers` sorted longest first). */
function openerAt(words: readonly string[], at: number, openers: readonly string[][]): number {
  return openers.find((o) => o.every((w, k) => words[at + k] === w))?.length ?? 0
}

/** Does any of `phrases` stand anywhere in `words`? */
function hasPhrase(words: readonly string[], phrases: readonly string[][]): boolean {
  return words.some((_, i) => openerAt(words, i, phrases) > 0)
}

/** #649: does the sentence open with a question word ("Was steht auf der Liste?"), perhaps after a preposition
 *  ("Auf welcher Seite …"), a polite opener or a request verb ("Kannst du mir sagen, was …")? */
function opensWithQuestionWord(words: readonly string[]): boolean {
  let at = pastFillers(words, 0)
  at = pastFillers(words, at + politeOpenerAt(words, at, false))
  for (;;) {
    if (QUESTION_WORDS.has(words[at] ?? '') || (PREPOSITIONS.has(words[at] ?? '') && QUESTION_WORDS.has(words[at + 1] ?? ''))) {
      return true
    }
    const n = openerAt(words, at, REQUEST_OPENERS)
    if (n === 0) return false
    at = pastFillers(words, at + n)
  }
}

/** #649: is `words[i]` a list the question asks about, not for ("auf der Liste" in a question-word question,
 *  "welcher Liste")? */
function isListNounAt(words: readonly string[], i: number, questionWord: boolean): boolean {
  if (!LIST_NOUNS.has(words[i] ?? '')) return false
  const before = words[i - 1] ?? ''
  return INTERROGATIVE_DETERMINERS.has(before) || (questionWord && DEFINITE_DETERMINERS.has(before))
}

/** #649: is `words[i]` a count word that does not count: "count as", "zählt als", "zählen zu", "Zählerstand"? */
function isCountAsAt(words: readonly string[], i: number): boolean {
  const word = words[i] ?? ''
  if (word === 'count') return EN_COUNT_AS_WORDS.has(words[i + 1] ?? '')
  if (!word.startsWith('zähl')) return false
  if (!DE_COUNT_VERBS.has(word)) return true
  if (DE_COUNT_IMPERATIVES.has(word)) return false
  const end = words.indexOf(',', i + 1)
  const clause = words.slice(i + 1, end < 0 ? undefined : end)
  return clause.some((w) => DE_COUNT_AS_WORDS.has(w)) && clause.at(-1) !== 'auf'
}

/** #649: does a list or count verb stand in this sentence (its lower-cased words)? Not a list asked about, not a
 *  "count as". */
function hasListVerb(words: readonly string[]): boolean {
  const questionWord = opensWithQuestionWord(words)
  const verbs = words.map((w, i) => (isListNounAt(words, i, questionWord) || isCountAsAt(words, i) ? ',' : w))
  return LIST_VERB_RE.test(verbs.join(' '))
}

/** `at` moved past any fillers (and commas). */
function pastFillers(words: readonly string[], at: number): number {
  for (let n = openerAt(words, at, FILLERS); n > 0; n = openerAt(words, at, FILLERS)) at += n
  return at
}

/** The length of the polite request opener at `words[at]`, or 0. */
function politeOpenerAt(words: readonly string[], at: number, listVerb: boolean): number {
  const phrase = openerAt(words, at, POLITE_PHRASES)
  if (phrase > 0) return phrase
  const verb = words[at] ?? ''
  const subject = words[at + 1] ?? ''
  if (!POLITE_MODALS.has(verb) && !YES_NO_VERBS.has(verb)) return 0
  const lastWord = words.filter((w) => w !== ',').at(-1) ?? ''
  const asks = listVerb || REQUEST_SIGNALS.has(words[pastFillers(words, at + 2)] ?? '') || REQUEST_SIGNALS.has(lastWord)
  const asked =
    ADDRESSEES.has(subject) ||
    (PLURAL_ADDRESSEES.has(subject) && PLURAL_VERBS.has(verb)) ||
    (SELF_SUBJECTS.has(subject) && POLITE_MODALS.has(verb))
  return asked && asks ? 2 : 0
}

/** Is `words[at]` the finite verb a yes/no question opens with? */
function yesNoVerbAt(words: readonly string[], at: number): boolean {
  const verb = words[at] ?? ''
  return YES_NO_VERBS.has(verb) && (!ENGLISH_ONLY_BEFORE_SUBJECT.has(verb) || ENGLISH_SUBJECTS.has(words[at + 1] ?? ''))
}

/** A claim about the items quantified at `words[at]` ("Jede Zahlung ist am Ersten fällig?", "Each payment
 *  is due on the 1st, right?", "Alle Zahlungen sind am Ersten fällig."): a finite verb of the quantifier's
 *  language, written in lower case, before any comma or clause word. */
function isClaim(raw: readonly string[], words: readonly string[], at: number): boolean {
  const english = EN_QUANTIFIER_WORDS.has(words[at] ?? '')
  for (let i = at + 1; i < words.length; i++) {
    const word = words[i]!
    if (word === ',' || (english ? EN_CLAUSE_WORDS : DE_CLAUSE_WORDS).has(word)) return false
    if (!english && DE_RELATIVES.has(word) && raw[i + 1] !== undefined && raw[i + 1] === words[i + 1]) return false
    if ((english ? EN_CLAIM_VERBS : DE_CLAIM_VERBS).has(word) && raw[i] === word) return true
  }
  return false
}

/** One sentence's kind for #644: `verdict` — a yes/no question or a claim, or fillers alone; `head` — a
 *  request whose head is a quantifier; `other` — neither. `listWord` (#649): the sentence holds a list word of
 *  any sense, which asks for something in a polite request ("Hast du eine Liste aller Fristen?"). */
function sentenceKind(sentence: string, listWord: boolean): 'verdict' | 'head' | 'other' {
  const { raw, words } = sentenceTokens(sentence)
  let at = pastFillers(words, 0)
  if (at >= words.length) return 'verdict'
  const polite = politeOpenerAt(words, at, listWord)
  if (polite === 0 && yesNoVerbAt(words, at)) return 'verdict'
  let stripped = polite > 0
  at = pastFillers(words, at + polite)
  for (let n = openerAt(words, at, REQUEST_OPENERS); n > 0; n = openerAt(words, at, REQUEST_OPENERS)) {
    at = pastFillers(words, at + n)
    stripped = true
  }
  const head = words[at] ?? ''
  if (EMBEDDED_YES_NO.has(head)) return 'verdict'
  // After an opener, a yes/no question asked directly ("Tell me, are all the payments on time?").
  if (stripped && (head === 'if' || yesNoVerbAt(words, at))) return 'verdict'
  if (!HEAD_QUANTIFIER_RE.test(words.slice(at).join(' '))) return 'other'
  // A request ("Show me every payment I have made") is never a claim: its verbs belong to a clause.
  return !stripped && isClaim(raw, words, at) ? 'verdict' : 'head'
}

/**
 * #644: what a question's list/count triggers ask for. `list` — a list or count verb, or a quantifier at
 * the head of a request, in a sentence that is not a yes/no question (`listSentences` are those
 * sentences); `modifier` — a quantifier inside some other question ("When is each payment due?"), which
 * the listing cannot answer; null — no trigger, or every trigger sits in a yes/no question, which asks for
 * a verdict. Judged sentence by sentence ("Ich habe einen Mietvertrag. Gilt die Frist für alle Mieter?").
 */
function listRequestShape(question: string): { shape: 'list' | 'modifier' | null; listSentences: string[] } {
  const listSentences: string[] = []
  let modifier = false
  for (const sentence of sentencesOf(question)) {
    const listWord = LIST_VERB_RE.test(sentence)
    const quantifier = QUANTIFIER_RE.test(sentence)
    if (!listWord && !quantifier) continue
    const kind = sentenceKind(sentence, listWord)
    if (kind === 'verdict') continue
    // #649: a list noun or a "count as" elsewhere in a question asks for nothing ("Welche Fristen stehen auf
    // der Liste?").
    if ((listWord && hasListVerb(sentenceTokens(sentence).words)) || kind === 'head') listSentences.push(sentence)
    else if (quantifier) modifier = true
  }
  return { shape: listSentences.length > 0 ? 'list' : modifier ? 'modifier' : null, listSentences }
}

// The words a list request may consist of without naming what it lists ("Liste alle auf", "List all of
// them"): such a request refers back to the question ("Welche Fristen gelten? Liste alle auf").
const NAMES_NOTHING = wordSet(
  'list liste auflisten aufzählen zähle zähl zählen count enumerate how many much wie viele viel every each all alle aller ' +
    'alles allen sämtliche jede jeder jedes jeden them they those these it its of the a an up out auf sie diese die es ' +
    'ihnen me us mir uns bitte please'
)

/** Does this list request name nothing, so that it refers back to the rest of the question? */
function namesNothing(listSentence: string): boolean {
  const { words } = sentenceTokens(listSentence)
  let at = pastFillers(words, 0)
  for (let n = openerAt(words, at, REQUEST_OPENERS); n > 0; n = openerAt(words, at, REQUEST_OPENERS)) at = pastFillers(words, at + n)
  return words.slice(at).every((w) => w === ',' || NAMES_NOTHING.has(w))
}

/** Closed-vocabulary synonym table: a user's "{X}" → an extracted type (plan §4.2 step 4). #644: no
 *  word with a common second sense — "terms" (medical terms; "terms and conditions" stays), "names"
 *  (names of the medications), "Daten" (data) — so such an ask is untyped and gets the labelled answer,
 *  not the wrong list. */
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
    re: /\b(obligation|obligations|must|shall|clause|clauses|requirement|requirements|dut(?:y|ies)|terms and conditions)\b|\b(pflicht|pflichten|klausel|klauseln|muss|müssen|anforderung|anforderungen|verpflichtung|verpflichtungen|bedingung|bedingungen)\b/i
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
  return AGGREGATION_RE.test(question ?? '') || isSumAsk(question ?? '')
}

/** #649: does this sentence ask for a sum (the shapes at `SUM_WORDS`)? */
function isSumSentence(sentence: string): boolean {
  if (EXPLAIN_RE.test(sentence) || sentenceKind(sentence, LIST_VERB_RE.test(sentence)) === 'verdict') return false
  const { words } = sentenceTokens(sentence)
  if (hasPhrase(words, COUNT_PHRASES)) return false
  const money = words.some((w) => MONEY_WORDS.has(w)) || /[€$]/u.test(sentence)
  if (!money && words.some((w) => MEASURE_WORDS.has(w))) return false
  const sumWord =
    words.some((w) => SUM_WORDS.has(w)) ||
    hasPhrase(words, SUM_PHRASES) ||
    (words.includes('zusammen') && words.some((w) => RECKONING_VERBS.has(w)))
  if (sumWord) return true
  const totalling = words.some(
    (w, i) => TOTALLING_WORDS.has(w) && !NO_TOTAL_BEFORE.has(words[i + 1] ?? '') && !words.some((v) => GATHERING_VERBS.has(v))
  )
  if (totalling && money) return true
  return hasPhrase(words, HOW_MUCH) && words.some((w) => SPEND_VERBS.has(w))
}

/** #649: does the question ask for a sum anywhere? */
function isSumAsk(question: string): boolean {
  return sentencesOf(question).some(isSumSentence)
}

const TYPE_SYNONYMS_ALL = TYPE_SYNONYMS.map(({ type, re }) => ({ type, re: new RegExp(re.source, 'gi') }))
// Synonyms that are no nouns, so they never head a run ("payments due in May" are payments).
const NO_HEAD_SYNONYMS = wordSet('due when who wann wer')

/** The extract type a question's "{X}" names, or null when no synonym matches (#641). #644: the
 *  synonym that comes FIRST in the question wins, not the first table row — the thing asked for is
 *  named before what it is asked with ("List all payments and their due dates" lists payments). Of
 *  nouns written one after another, the last names the thing ("payment deadlines" are deadlines). */
function matchedRecordType(question: string): ExtractRecordType | null {
  const hits = TYPE_SYNONYMS_ALL.flatMap(({ type, re }) =>
    [...question.matchAll(re)].map((m) => ({ type, start: m.index, end: m.index + m[0].length, word: m[0].toLowerCase() }))
  ).sort((a, b) => a.start - b.start || b.end - a.end)
  let first = hits[0]
  for (const next of hits) {
    const adjacent = first !== undefined && next.start >= first.end && /^\s+$/.test(question.slice(first.end, next.start))
    if (adjacent && !NO_HEAD_SYNONYMS.has(next.word)) first = next
  }
  return first?.type ?? null
}

/** The question without its #641 type cue words (who / when / must …, wer / wann / muss …). */
function withoutTypeCueWords(question: string): string {
  return question.replace(TYPE_CUE_WORDS_RE, ' ')
}

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
  // is an untyped list request; the other sentence's "Frist" does not type it). A request that names
  // nothing refers back to the question ("Welche Fristen gelten? Liste alle auf").
  const { shape: triggerShape, listSentences } = listRequestShape(q)
  const listTrigger = triggerShape === 'list'
  const typedRequest = listSentences
    .map((s) => (namesNothing(s) ? q : s))
    .find((s) => matchedRecordType(withoutTypeCueWords(s)) !== null)
  const namesTypedThing = typedRequest !== undefined
  const wantsListing = listTrigger && !EXPLAIN_RE.test(q) && namesTypedThing
  // #649: a sum ask joins the aggregation route; it sums amounts, whatever else it names.
  const sumAsk = isSumAsk(q)
  const wantsCoverage = wantsListing || AGGREGATION_RE.test(q) || sumAsk
  const wantsSummary = SUMMARY_RE.test(q)

  // 2. Compare (needs two documents). A compare intent without 2 docs is low-confidence and
  //    falls back to labelled relevance (plan §4.4) — it does NOT fall through to coverage.
  if (wantsCompare) {
    return docs >= 2
      ? { engine: 'compare', confidence: 'high' }
      : { engine: 'relevance', confidence: 'low', fallback: 'compare' }
  }

  // 3. Coverage-extract ("list every / how many" over a typed {X} + the #37 aggregation verbs + the
  //    #649 sum asks):
  //    only when there IS precomputed extracted data — otherwise we cannot honestly claim a
  //    complete list, so fall back to relevance, marked `fallback: 'coverage'` so the caller can
  //    lead the answer with the actionable "build the deep index" hint (#38) instead of a silent
  //    partial sum.
  if (wantsCoverage) {
    if (input.extractAvailable) {
      return {
        engine: 'coverage-extract',
        // #644: the type the list request itself names first ("When was the lease signed? List all
        // the fees" lists fees; "List when every payment is due" lists dates), else the question's.
        // #649: a sum lists amounts ("How much did I spend in total?" names none).
        recordType: sumAsk
          ? 'amount'
          : ((typedRequest !== undefined ? namedRecordType(typedRequest) : null) ?? mapQuestionToRecordType(q)),
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
