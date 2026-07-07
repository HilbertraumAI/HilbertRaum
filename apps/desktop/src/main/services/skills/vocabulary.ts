import { wordIncludes } from './tools/money'

// W5 — the ONE canonical bilingual trigger vocabulary per app skill (audit §3.2/§4.1/§4.2/§8.3).
//
// Before W5 each skill carried TWO independent, drifting keyword lists: the SKILL.md `triggers.keywords`
// (which drives the deterministic SUGGESTION scorer, `selector.ts`) and a private routing array inside its
// analysis handler (`isAnalysisShaped`, the whole-doc keyword lists, `REDACTION_KEYWORDS`). Nobody kept
// them in step, so a term could ROUTE but never be SUGGESTED (bank's 6-keyword manifest vs its ~45-term
// routing gate — the German under-fire class) or be SUGGESTED but never ROUTE ("Summarize this meeting"
// earned the offer, then produced minutes from ~2-4 top-k chunks). And both lists matched by raw
// `question.includes(term)`, so `net` ⊂ "Netflix", `bill` ⊂ "billboard", `sum` ⊂ "assume" fired confident
// wrong answers in both directions (four shipped incidents traced to that one mechanism).
//
// This module single-sources the vocabulary. Each entry declares:
//   - `term`  the bilingual trigger (lower-cased on match; stored as authored for readability),
//   - `lang`  'en' | 'de' (documentation + corpus balance; not a runtime gate),
//   - `match` HOW the ROUTING gate matches: 'word' = word-boundary (`wordIncludes`, so `net` never hits
//             "Netflix"); 'phrase' = a multi-word literal matched by substring; 'stem' = a single-token
//             substring — for German compound roots, so `rechnung` routes "Rechnungsposten" and `frist`
//             routes "Kündigungsfrist" (under an ALREADY-ACTIVE skill, recall beats a bare word — §8.2),
//   - `use`   WHICH consumer(s) read it: 'suggest' (the manifest/offer only), 'route' (the handler gate
//             only), or 'both'.
//
// The two consumers read the term differently ON PURPOSE. The ROUTING gates consume the `route|both`
// entries via `routeMatch` below, honouring `match` (so German compounds route). The SUGGESTION scorer
// consumes the SKILL.md `triggers.keywords` — a parity test pins that list to exactly the `suggest|both`
// terms here — and ALWAYS infers word-vs-phrase from whitespace (`selector.countKeywordHits`), never `match`.
// So an OFFER on a single-token German noun stays word-anchored (precision: "Rechnung" offers, "Rechnungs-"
// compounds don't), while ROUTING the SAME active skill is deliberately broader. The only structural rule
// (consistency test): whitespace ⟺ `phrase` (a multi-word term can't be word/stem, and vice versa).
//
// Privacy: a question is CONTENT (audit §6) — matched here, NEVER logged. This module returns booleans and
// static term lists only; nothing writes question text to any sink.

export type VocabLang = 'en' | 'de'
export type VocabMatch = 'word' | 'phrase' | 'stem'
export type VocabUse = 'suggest' | 'route' | 'both'

export interface VocabEntry {
  term: string
  lang: VocabLang
  match: VocabMatch
  use: VocabUse
}

/** The nine bundled app skills that carry a canonical vocabulary (the routing + suggestion label space). */
export type SkillVocabId =
  | 'bank-statement'
  | 'invoice'
  | 'meeting-protocol'
  | 'contract-brief'
  | 'share-safe-review'
  | 'deadline-obligation-finder'
  | 'what-changed'
  | 'document-redaction'
  | 'document-edit'

export const APP_VOCAB_SKILL_IDS: readonly SkillVocabId[] = [
  'bank-statement',
  'invoice',
  'meeting-protocol',
  'contract-brief',
  'share-safe-review',
  'deadline-obligation-finder',
  'what-changed',
  'document-redaction',
  'document-edit'
]

/**
 * The default ROUTE match type from a term's SHAPE: a term with whitespace is a `phrase` (substring); a
 * single token is a `word` (word-boundary). The whitespace ⟺ phrase rule is the module invariant. A German
 * compound root passes an explicit `stem` to route by substring instead (see the constructors).
 */
export function deriveMatch(term: string): 'word' | 'phrase' {
  return /\s/.test(term) ? 'phrase' : 'word'
}

// Compact constructors. All three default the ROUTE match to the term's shape (`deriveMatch`); a
// single-token German compound ROOT passes an explicit `stem` so the routing gate substring-matches its
// compounds (`rechnung` → "Rechnungsposten") — safe because routing runs only under an already-active
// skill (§8.2). The `match` never changes the OFFER: the suggestion scorer word/phrase-infers from the
// manifest string itself, so a `both`-`stem` German noun still OFFERS word-anchored (precision).
const both = (term: string, lang: VocabLang, match?: VocabMatch): VocabEntry => ({
  term,
  lang,
  match: match ?? deriveMatch(term),
  use: 'both'
})
const suggest = (term: string, lang: VocabLang, match?: VocabMatch): VocabEntry => ({
  term,
  lang,
  match: match ?? deriveMatch(term),
  use: 'suggest'
})
const route = (term: string, lang: VocabLang, match?: VocabMatch): VocabEntry => ({
  term,
  lang,
  match: match ?? deriveMatch(term),
  use: 'route'
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The canonical per-skill vocabularies. `both`/`suggest` terms (the discriminating, unambiguous nouns and
// domain phrases) drive the OFFER and are mirrored into SKILL.md; `route` terms add the ambiguous-but-safe
// tokens (`total`, `sum`, `net`, `bill`, `statement`, `minutes`…) + German stems that are only ever matched
// once the skill is already active (audit §8.2), so they never over-suggest.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const BANK_STATEMENT: VocabEntry[] = [
  // suggest+route — the terms that clearly signal a statement (bilingual; word-boundary matched).
  both('bank statement', 'en'),
  both('statement period', 'en'),
  both('transaction', 'en'),
  both('transactions', 'en'),
  both('IBAN', 'en'),
  both('cashflow', 'en'),
  both('cash flow', 'en'),
  both('kontoauszug', 'de', 'stem'), // routes "Kontoauszugs"/"Kontoauszug-…"; offers word-anchored
  both('kontostand', 'de'),
  both('saldo', 'de'),
  both('buchung', 'de', 'stem'), // routes "Buchungen"/"Buchungsdatum"
  both('buchungen', 'de'),
  both('umsatz', 'de'),
  both('umsätze', 'de'),
  both('überweisung', 'de', 'stem'), // routes "Überweisungen"/"SEPA-Überweisung"; offers word-anchored
  both('geldfluss', 'de'),
  both('transaktion', 'de'),
  both('transaktionen', 'de'),
  // route-only — accounting verbs/nouns too generic to OFFER on, but correct once the bank skill is active.
  // `net` (Netflix), `balance`/`statement` (work-life balance / mission statement) stay OUT of `suggest`.
  route('balance', 'en'),
  route('balances', 'en'),
  route('reconcile', 'en'),
  route('reconciliation', 'en'),
  route('total', 'en'),
  route('totals', 'en'),
  route('sum', 'en'),
  route('summary', 'en'),
  route('summarize', 'en'),
  route('summarise', 'en'),
  route('spend', 'en'),
  route('spending', 'en'),
  route('spent', 'en'),
  route('income', 'en'),
  route('expense', 'en'),
  route('expenses', 'en'),
  route('deposit', 'en'),
  route('withdrawal', 'en'),
  route('net', 'en'),
  route('statement', 'en'),
  route('overview', 'en'),
  route('how much', 'en'),
  route('how many', 'en'),
  route('betrag', 'de'),
  route('beträge', 'de'),
  route('summe', 'de', 'stem'), // routes "Summe"/"Summen"/"Gesamtsumme" once the bank skill is active
  route('ausgabe', 'de'),
  route('ausgaben', 'de'),
  route('einnahme', 'de'),
  route('einnahmen', 'de'),
  route('abgleich', 'de'),
  route('gesamtwert', 'de'),
  route('zusammenfass', 'de', 'stem'), // Zusammenfassung / zusammenfassen
  // SKA-7 (W7, audit §3.2/§8.2) — the core German money phrasings the bank routing vocabulary missed, so
  // with the bank skill ACTIVE they fell to raw top-k + 4B arithmetic ("Wie viel habe ich ausgegeben?",
  // "Wer hat die höchste Zahlung bekommen?", "Wofür habe ich am meisten bezahlt?"). Route-only — recall is
  // safe under an already-active skill (§8.2) and these never touch the suggestion offer / SKILL.md keywords.
  route('wie viel', 'de'),
  route('wie viele', 'de'),
  route('zahlung', 'de', 'stem'), // routes "Zahlung"/"Zahlungen"/"Zahlungseingang"
  route('bezahlt', 'de'),
  route('ausgegeben', 'de'),
  route('payment', 'en'),
  // SKA-7 rider (W7) — bare separable imperatives ("Fasse das zusammen", "Liste das auf") at least REACH
  // the handler on their leading verb (A4 supersedes with the structural inversion; cheap now, and the
  // handler's SKA-9 separable-summary regex then keeps them on the D56-gated template). Route-only.
  route('fasse', 'de'),
  route('fass', 'de'),
  route('liste', 'de')
]

const INVOICE: VocabEntry[] = [
  both('invoice', 'en'),
  both('invoices', 'en'),
  both('billing', 'en'),
  both('net amount', 'en'),
  both('gross amount', 'en'),
  both('subtotal', 'en'),
  both('line item', 'en'),
  both('line items', 'en'),
  both('invoice number', 'en'),
  both('vendor', 'en'),
  both('rechnung', 'de', 'stem'), // routes "Rechnungsposten"/"Rechnungssumme"; offers word-anchored
  both('rechnungen', 'de'),
  both('faktura', 'de'),
  both('rechnungsnummer', 'de'),
  both('rechnungsbetrag', 'de'),
  both('gesamtbetrag', 'de'),
  both('gesamtwert', 'de'),
  both('mehrwertsteuer', 'de'),
  both('umsatzsteuer', 'de'),
  both('netto', 'de'),
  both('brutto', 'de'),
  both('zwischensumme', 'de'),
  both('lieferant', 'de'),
  both('positionen', 'de'),
  // route-only — the ambiguous tokens (`total`/`sum`/`tax`/`gross`/`bill`, `steuer` ⊂ "Steuerberatung",
  // `betrag`/`summe`/`position`) resolve correctly once an invoice question already owns the turn.
  route('total', 'en'),
  route('totals', 'en'),
  route('sum', 'en'),
  route('tax', 'en'),
  route('gross', 'en'),
  route('net total', 'en'),
  route('amount due', 'en'),
  route('bill', 'en'),
  route('how much', 'en'),
  route('how many', 'en'),
  route('reconcil', 'en', 'stem'), // reconcile / reconciles / reconciled / reconciliation
  route('betrag', 'de'),
  route('beträge', 'de'),
  route('summe', 'de', 'stem'), // routes "Summe"/"Summen"/"Zwischensumme" once the invoice skill is active
  // 'steuer' as a STEM (not a bare word): under an already-active invoice skill recall beats precision
  // (§8.2), so "Steuern"/"Steuerbetrag"/"Steuersatz" route; the R2 extraction-side `steuer` ⊂ "Steuerberatung"
  // concern is an EXTRACTION worry, not a routing one (a Steuerberatung question routing to invoice
  // grounded-data is harmless once the invoice skill owns the turn).
  route('steuer', 'de', 'stem'),
  route('mwst', 'de'),
  route('position', 'de'),
  route('wie viel', 'de'),
  route('wie viele', 'de'),
  // SKA-7 (W7, audit §3.2/§8.2) — a due-date ask must reach the invoice handler: today only the deadline
  // skill knows "fällig", so "Wann ist sie fällig?" fell through with the invoice skill active. `fällig` as
  // a STEM routes "fällig"/"Fälligkeit"/"fällige"; `due` word-bounded (safe under an already-active skill).
  route('fällig', 'de', 'stem'),
  route('due', 'en'),
  // SKA-7 rider (W7) — bare separable imperatives ("Fasse die Rechnung zusammen", "Liste die Positionen
  // auf") reach the handler on their leading verb (mirrors the bank rider; A4 supersedes). Route-only.
  route('fasse', 'de'),
  route('fass', 'de'),
  route('liste', 'de')
]

const MEETING_PROTOCOL: VocabEntry[] = [
  both('meeting minutes', 'en'),
  both('meeting notes', 'en'),
  both('meeting protocol', 'en'),
  both('meeting transcript', 'en'),
  both('meeting', 'en'), // the incident term: "Summarize this meeting" must both OFFER and ROUTE (§4.1)
  both('action item', 'en'),
  both('action items', 'en'),
  both('agenda', 'en'),
  both('protokoll', 'de', 'stem'), // routes "Protokolls"/"Meetingprotokoll"
  both('besprechungsprotokoll', 'de'),
  both('sitzungsprotokoll', 'de'),
  both('besprechung', 'de'),
  both('sitzung', 'de'),
  both('tagesordnung', 'de'),
  both('aktionspunkte', 'de'),
  both('beschluss', 'de'), // umlaut breaks the substring, so singular + plural are both offered
  both('beschlüsse', 'de'),
  both('entscheidung', 'de'), // SKA-45 (W7): the singular gap — each form appears in its own right
  both('entscheidungen', 'de'),
  both('aufgabe', 'de'),
  both('aufgaben', 'de'),
  both('notizen', 'de'),
  // route-only — `minutes` (⊂ "a few minutes") and `decisions` stay OUT of the offer; safe under an
  // active meeting skill ("give me the minutes"). "Summarize this meeting" also routes via `meeting`.
  route('minutes', 'en'),
  route('decisions', 'en'),
  route('decisions made', 'en'),
  route('write minutes', 'en'),
  route('formal minutes', 'en'),
  route('minutes from this meeting', 'en'),
  route('summarize meeting', 'en'),
  route('summarise meeting', 'en'),
  route('gesprächsprotokoll', 'de'),
  route('meetingprotokoll', 'de'),
  route('offene punkte', 'de'),
  route('zusammenfassung der besprechung', 'de')
]

const CONTRACT_BRIEF: VocabEntry[] = [
  both('contract', 'en'),
  both('agreement', 'en'),
  both('lease', 'en'),
  both('contract brief', 'en'),
  both('contract summary', 'en'),
  both('terms and conditions', 'en'),
  both('key terms', 'en'),
  both('termination clause', 'en'),
  both('renewal clause', 'en'),
  both('liability clause', 'en'),
  both('indemnity', 'en'),
  both('vertrag', 'de', 'stem'), // routes "Vertragslaufzeit"/"Vertragsbeginn"; offers word-anchored
  both('vereinbarung', 'de'),
  both('mietvertrag', 'de'),
  both('dienstleistungsvertrag', 'de'),
  both('agb', 'de'),
  both('vertragsübersicht', 'de'),
  both('vertragsanalyse', 'de'),
  both('kündigung', 'de'),
  both('haftung', 'de'),
  // route-only — the multi-word review verbs (fire once contract-brief is active).
  route('review contract', 'en'),
  route('summarize contract', 'en'),
  route('summarise contract', 'en'),
  route('before signing', 'en'),
  route('contract risks', 'en'),
  route('vertrag zusammenfassen', 'de'),
  route('vertrag prüfen', 'de'),
  route('vor der unterschrift', 'de'),
  route('wichtige klauseln', 'de'),
  route('pflichten im vertrag', 'de'),
  route('risiken im vertrag', 'de'),
  route('verlängerung', 'de')
]

const SHARE_SAFE_REVIEW: VocabEntry[] = [
  both('safe to share', 'en'),
  both('share-safe', 'en'),
  both('review before sharing', 'en'),
  both('privacy review', 'en'),
  both('disclosure review', 'en'),
  both('sensitive information', 'en'),
  both('confidential information', 'en'),
  both('metadata', 'en'),
  both('sicher teilen', 'de'),
  both('vor dem teilen prüfen', 'de'),
  both('sensible daten', 'de'),
  both('personenbezogene daten', 'de'),
  both('vertrauliche informationen', 'de'),
  both('datenschutz prüfen', 'de'),
  both('metadaten', 'de'),
  // route-only — broader share phrasings, fired once the review skill is active.
  route('before sharing', 'en'),
  route('remove private information', 'en'),
  route('metadata warning', 'en'),
  route('personal data', 'en'),
  route('private informationen', 'de'),
  route('weitergeben', 'de'),
  route('veröffentlichen', 'de')
]

const DEADLINE_OBLIGATION: VocabEntry[] = [
  both('deadline', 'en'),
  both('deadlines', 'en'),
  both('due date', 'en'),
  both('due dates', 'en'),
  both('notice period', 'en'),
  both('renewal date', 'en'),
  both('cancellation deadline', 'en'),
  both('obligation', 'en'),
  both('obligations', 'en'),
  both('payment date', 'en'),
  both('payment dates', 'en'),
  both('frist', 'de', 'stem'), // routes "Kündigungsfrist"/"Zahlungsfrist"/"Fristen"
  both('fristen', 'de'),
  both('fälligkeit', 'de'),
  both('fälligkeiten', 'de'),
  both('stichtag', 'de'),
  both('kündigungsfrist', 'de'),
  both('zahlungsfrist', 'de'),
  both('pflicht', 'de', 'stem'), // routes "Pflichten"/"(Ver)pflichtung(en)"
  both('pflichten', 'de'),
  both('verpflichtung', 'de'),
  both('verpflichtungen', 'de'),
  both('wiedervorlage', 'de'),
  // route-only — the imperative "what must I do?" phrasings.
  route('duties', 'en'),
  route('what do i have to do', 'en'),
  route('by when', 'en'),
  route('action required', 'en'),
  route('must do', 'en'),
  route('shall do', 'en'),
  route('required to', 'en'),
  route('bis wann', 'de'),
  route('verlängerung', 'de'),
  route('muss ich', 'de'),
  route('müssen wir', 'de')
]

const WHAT_CHANGED: VocabEntry[] = [
  both('what changed', 'en'),
  both('what has changed', 'en'),
  both('compare versions', 'en'),
  both('compare documents', 'en'),
  both('version difference', 'en'),
  both('differences between', 'en'),
  both('changed between', 'en'),
  both('redline', 'en'),
  both('revision', 'en'),
  both('updated terms', 'en'),
  both('compare contract', 'en'),
  both('was hat sich geändert', 'de'),
  both('änderung', 'de'), // SKA-45 (W7): the singular gap — each form appears in its own right
  both('änderungen', 'de'),
  both('unterschiede', 'de'),
  both('versionen vergleichen', 'de'),
  both('dokumente vergleichen', 'de'),
  both('alte version', 'de'),
  both('neue version', 'de'),
  both('gegenüberstellung', 'de'),
  both('vertragsänderung', 'de'),
  both('aktualisierte bedingungen', 'de'),
  // route-only — the bare compare imperatives, fired once what-changed is active over two docs.
  route('compare the two', 'en'),
  route('difference between', 'en'),
  route('old and new', 'en'),
  route('compare these', 'en'),
  route('unterschied zwischen', 'de'),
  route('vergleiche', 'de'),
  route('vergleich', 'de')
]

const DOCUMENT_REDACTION: VocabEntry[] = [
  // The action VERBS + strong PII phrases — both OFFER and ROUTE (word-boundary, so `datenschutz` never
  // hits "Datenschutzerklärung", nor `schwärzen` a compound).
  both('redact', 'en'),
  both('redaction', 'en'),
  both('anonymize', 'en'),
  both('anonymise', 'en'),
  both('anonymized', 'en'),
  both('anonymised', 'en'),
  both('remove personal data', 'en'),
  both('mask personal data', 'en'),
  both('anonymisieren', 'de'),
  both('anonymisierung', 'de'),
  both('anonymisiere', 'de'),
  both('pseudonymisieren', 'de'),
  both('schwärzen', 'de'),
  both('schwärzung', 'de'),
  both('schwärze', 'de'),
  both('geschwärzt', 'de'),
  both('personenbezogene daten', 'de'),
  both('personenbezogene daten entfernen', 'de'),
  // suggest-only PII-CONTENT topics — the informational dry-run (`isInformationalPiiQuestion`, `PII_TOPIC_RE`)
  // recognises these ("what sensitive data is in here?" reports per-category counts), so they align with the
  // handler and stay auto-fire-eligible. Word-matched, so a compound never trips the bare term.
  // U4/§4.4: the pure LEGAL/topic words `datenschutz`/`dsgvo`/`gdpr` were DROPPED here — the handler acts on
  // NEITHER `routeMatch` NOR `PII_TOPIC_RE` for them ("Was regelt die DSGVO?" is a question about the LAW,
  // not the document), so keeping them as manifest keywords let redaction auto-fire a wrong-flavoured fence.
  // Aligning the manifest to the handler = removing them (the audit's "take the drop").
  suggest('sensitive data', 'en'),
  suggest('sensible daten', 'de')
]

const DOCUMENT_EDIT: VocabEntry[] = [
  // The unambiguous find-and-replace phrases + strong edit verbs — both OFFER and ROUTE (word-boundary,
  // so `rename` never trips a compound, `ersetze` never a longer word). These are Phase 8's targeted-edit
  // intents (#23): "replace X with Y everywhere it refers", not a general "rewrite this".
  both('find and replace', 'en'),
  both('search and replace', 'en'),
  both('replace all', 'en'),
  both('replace every', 'en'),
  both('rename', 'en'),
  both('suchen und ersetzen', 'de'),
  both('ersetzen', 'de'),
  both('ersetze', 'de'),
  both('umbenennen', 'de'),
  // route-only — the ambiguous-but-safe edit verbs (fire once the document-edit skill is active). `replace`
  // alone (⊂ "irreplaceable"? — word-bounded, so no), `change`/`swap` are too generic to OFFER on.
  route('replace', 'en'),
  route('change all', 'en'),
  route('change every', 'en'),
  route('substitute', 'en'),
  route('swap', 'en'),
  route('correct every', 'en'),
  route('austauschen', 'de'),
  route('ändere', 'de'),
  route('ändern', 'de'),
  route('durchgängig ersetzen', 'de'),
  route('ersetze durch', 'de')
]

/** The single source of truth: skill id → its canonical bilingual vocabulary. */
export const SKILL_VOCABULARY: Record<SkillVocabId, VocabEntry[]> = {
  'bank-statement': BANK_STATEMENT,
  invoice: INVOICE,
  'meeting-protocol': MEETING_PROTOCOL,
  'contract-brief': CONTRACT_BRIEF,
  'share-safe-review': SHARE_SAFE_REVIEW,
  'deadline-obligation-finder': DEADLINE_OBLIGATION,
  'what-changed': WHAT_CHANGED,
  'document-redaction': DOCUMENT_REDACTION,
  'document-edit': DOCUMENT_EDIT
}

/** Does ONE vocabulary entry match an already-lower-cased question? Word entries are boundary-matched
 *  (`wordIncludes`); phrase + stem entries are substring-matched. The single matching primitive both
 *  consumers share. */
export function entryMatches(entry: VocabEntry, lowerQuestion: string): boolean {
  const term = entry.term.toLowerCase()
  return entry.match === 'word' ? wordIncludes(lowerQuestion, term) : lowerQuestion.includes(term)
}

/** The `route|both` entries a routing gate consumes for a skill (empty for an unknown id). */
export function routeEntries(skillId: string): VocabEntry[] {
  const vocab = SKILL_VOCABULARY[skillId as SkillVocabId]
  return vocab ? vocab.filter((e) => e.use === 'route' || e.use === 'both') : []
}

/** The `suggest|both` TERMS mirrored into a skill's SKILL.md `triggers.keywords` (the parity contract). */
export function suggestTerms(skillId: string): string[] {
  const vocab = SKILL_VOCABULARY[skillId as SkillVocabId]
  return vocab ? vocab.filter((e) => e.use === 'suggest' || e.use === 'both').map((e) => e.term) : []
}

/** True when the question matches ANY of the skill's routing vocabulary (audit §3.2 — the word-boundary
 *  gate that replaces the drifting per-handler `question.includes` arrays). Deterministic, no model. The
 *  `skillId` is typed `SkillVocabId` (not `string`) so a mis-wired handler — `routeMatch('invoice', …)` in
 *  the bank gate, a typo, a renamed skill — is a COMPILE error, closing the one gap the runtime drift test
 *  can't (it would just see empty route entries → always-false). */
export function routeMatch(skillId: SkillVocabId, question: string): boolean {
  const q = question.toLowerCase()
  return routeEntries(skillId).some((e) => entryMatches(e, q))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A3 (audit §6.3/§8.2) — the SKILL-INDEPENDENT shape classifiers the INVERTED whole-doc gate uses.
//
// Before A3 an analysis skill only reached its whole-doc engine when the question matched that skill's
// per-language `routeMatch` vocabulary — so every phrasing gap silently degraded a whole-document ask to
// top-k-with-fence (the recurring incident class). A3 inverts it: with an analysis-mode skill explicitly
// active over a matching fully-chunked scope, the whole-doc engine is the DEFAULT. Keywords now play only
// two NARROW roles, and both are skill-agnostic (no per-skill list):
//   (a) `isSmallTalk` OPTS OUT clearly off-topic chatter (greetings/thanks/assistant-meta) — a "hi"/"danke"
//       over a document must NOT spend a whole-document read; it keeps the ordinary relevance path.
//   (b) `isNeedleShaped` classifies a targeted single-fact lookup vs a whole-document DELIVERABLE — the
//       chat path uses it ONLY to send a needle to top-k WHEN the whole-doc read would truncate and no
//       deep-index tree exists (a needle past the truncation cut would be missed; top-k finds it anywhere).
//
// Both are deliberately conservative. `isSmallTalk` can never fire on a real document question (a question
// with any content word is not all-filler and matches no whole-question chit-chat form). `isNeedleShaped`
// requires an unambiguous lookup interrogative AND the absence of any deliverable verb, because a false
// needle (a summary sent to top-k) is worse than a false deliverable (a truncated whole read, still honest
// via W1's in-prompt notice). Privacy: the question is CONTENT — matched here, NEVER logged.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Collapse a question to lowercase alnum(+German umlaut/ß) word tokens — the small-talk normalizer.
 *  Apostrophes are DROPPED (not split on) so a contraction stays one token ("how's" → "hows"). */
function smallTalkTokens(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/['’‘´`]/g, '')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0)
}

/** Greeting / thanks / closing / acknowledgement tokens (EN+DE). A question whose EVERY token is one of
 *  these is pure chatter — it carries no document ask, so it opts OUT of the whole-doc engine. */
const SMALL_TALK_WORDS = new Set<string>([
  // greetings
  'hi', 'hii', 'hiya', 'hey', 'heya', 'hello', 'yo', 'sup', 'howdy', 'there',
  'hallo', 'hallöchen', 'servus', 'moin', 'na',
  // thanks (incl. the "thank you" pair — both tokens are fillers, so "thank you" is chatter but
  // "thank you, now summarize it" is not: 'summarize'/'it' are not fillers)
  'thanks', 'thank', 'you', 'thx', 'ty', 'cheers', 'please', 'pls',
  'danke', 'dankeschön', 'merci', 'vielen', 'dank', 'bitte',
  // SKA-11 (W7, audit §3.3) — top-frequency thanks/ack INTENSIFIERS + acknowledgement fillers the detector
  // missed, each miss spending a full whole-document model read on a pleasantry ("thank you very much",
  // "thanks a lot!", "danke dir!", "danke schön", "vielen lieben dank", "perfect, thanks", "sounds good",
  // "all good, thanks!"). SAFE against the never-fires-on-real-questions invariant: a real document question
  // always carries a non-filler content word, so no all-filler set here can swallow one ("ist das gut?" →
  // 'ist'/'das' aren't fillers → not small talk). Verified by the extended guard test.
  'very', 'much', 'so', 'a', 'lot', 'sounds', 'all', 'good', 'perfect', 'sure',
  'dir', 'dich', 'schön', 'lieben', 'gut', 'sehr', 'genau', 'perfekt',
  // closings / acknowledgements
  'bye', 'goodbye', 'cya', 'ok', 'okay', 'okey', 'k', 'cool', 'great', 'nice', 'awesome', 'lol', 'haha',
  'tschüss', 'tschau', 'ciao', 'passt', 'alles', 'klar', 'super'
])

/** Whole-question chit-chat / assistant-meta forms (EN+DE), compared against the NORMALIZED full question
 *  (so "how are you going to fix X" — a real ask — never matches "how are you"). */
const SMALL_TALK_EXACT = new Set<string>([
  'how are you', 'how are you doing', 'how are you today', 'how is it going', 'hows it going',
  'how do you do', 'whats up', 'who are you', 'what are you', 'what can you do',
  'what can you help with', 'what can you help me with', 'tell me a joke', 'nice to meet you', 'good bot',
  'wie gehts', 'wie geht es', 'wie geht es dir', 'wie geht es ihnen', 'wer bist du', 'was bist du',
  'was kannst du', 'was kannst du tun', 'erzähl mir einen witz', 'schön dich kennenzulernen'
])

/**
 * True when the question is clearly off-topic chatter (greeting / thanks / assistant-meta), so an active
 * analysis skill should NOT default to a whole-document read (A3 opt-out (a), audit §8.2). Conservative by
 * construction: it fires only when the WHOLE question is chatter — every token a filler, or the normalized
 * question is a known chit-chat form — so a genuine document question (which always carries a content word)
 * can never be misclassified. Deterministic; no model; the question is never logged.
 */
export function isSmallTalk(question: string): boolean {
  const tokens = smallTalkTokens(question)
  if (tokens.length === 0) return false
  if (SMALL_TALK_EXACT.has(tokens.join(' '))) return true
  return tokens.every((t) => SMALL_TALK_WORDS.has(t))
}

/** Whole-document DELIVERABLE verbs/phrases (EN+DE): a "process the whole document" ask (summary, minutes,
 *  brief, list-all, compare, review). Their presence VETOES the needle classification — a deliverable is
 *  never downgraded to top-k. Substring-matched (German compounds included). */
const DELIVERABLE_SHAPES: string[] = [
  'summar', 'brief', 'overview', 'recap', 'minutes', 'walk me through', 'key point', 'main point',
  'list all', 'list every', 'all the', 'everything', 'what changed', 'what has changed', 'compare',
  'review', 'gist', 'rundown', 'breakdown', 'analy', 'tl;dr', 'the whole', 'entire document',
  // Whole-document SYNTHESIS nouns that commonly head a "what is the …" ask (which would otherwise trip
  // the `what is the` needle stem). Vetoing them keeps a summary/gist ask on the whole-doc engine — a
  // FALSE deliverable (a truncated whole read, honest via W1's notice) is safer than a false needle (a
  // summary answered from ~5 top-k passages, the exact incident the A3 inversion exists to kill).
  'takeaway', 'bottom line', 'conclusion', 'upshot', 'big picture', 'main idea', 'in a nutshell',
  'in short', 'purpose of', 'point of the', 'point of this', 'message of', 'about this document',
  'what is it about', 'what is this about',
  // SKA-19 (W7, audit §3.3) — more whole-document SYNTHESIS heads that trip the `what is the …` needle stem:
  // "what is the most important point?", "what is the verdict?", "what is the overall picture?" (EN) +
  // "was ist das Wichtigste/die Schlussfolgerung?" (DE). Vetoing them keeps a synthesis ask on the whole-doc
  // engine (a false deliverable is safer than a false needle — the module's own rule).
  'important point', 'key insight', 'verdict', 'overall',
  'zusammenfass', 'überblick', 'protokoll', 'sämtliche', 'liste', 'auflisten',
  'was hat sich geändert', 'vergleich', 'überprüf', 'durchgehen', 'wesentlich', 'analyse', 'ganze dokument',
  'fazit', 'kernaussage', 'kernpunkt', 'quintessenz', 'gesamteindruck', 'inhalt', 'worum geht',
  'wichtigste', 'schlussfolgerung', 'erkenntnis', 'gesamtbild'
]

// SKA-45 (W7, audit §3.4) — the deliverable shapes that must be WORD-anchored, not the old dead
// trailing-space substrings. 'alle ' could never veto a needle when 'alle' ended the question ("sind das
// alle?"); \balle\b matches the bare word without hitting 'alles'/'allen' (word boundary before the 's').
// Linear (word-anchored, no quantifier) per the ReDoS-regression contract.
const DELIVERABLE_SHAPE_RES: readonly RegExp[] = [/\balle\b/]

/** Unambiguous single-fact LOOKUP interrogatives (EN+DE) — a "find this one thing" ask. Kept tight (a false
 *  needle is worse than a false deliverable), substring-matched. */
const NEEDLE_SHAPES: string[] = [
  'how much', 'how many', 'how long', 'when is', 'when does', 'when did', 'when will', 'when do',
  'where is', 'where does', 'where can i', 'find the', 'find a', 'locate', 'look up', 'is there a',
  'are there any', 'does it say', 'does the document', "what's the", 'what is the', 'what was the',
  'wie viel', 'wie viele', 'wie lange', 'wann ist', 'wann muss', 'wann wird', 'wo ist', 'wo steht',
  'gibt es', 'steht im', 'steht in', 'was ist der', 'was ist die', 'was ist das'
]

// SKA-45 (W7, audit §3.4) — the needle shapes that must be WORD-anchored, not the old dead trailing-space
// substrings. 'finde ' could never match when 'finde' ended the question ("wo ich das finde?"); \bfinde\b
// matches the bare imperative without hitting 'finden'/'findest'/'befinde' (word boundary after 'finde').
// Linear (word-anchored, no quantifier) per the ReDoS-regression contract.
const NEEDLE_SHAPE_RES: readonly RegExp[] = [/\bfinde\b/]

/**
 * True when the question is a targeted single-fact LOOKUP rather than a whole-document deliverable (A3
 * classify (b), audit §8.2). Used ONLY to prefer top-k over a TRUNCATED whole-doc read (a needle past the
 * cut would be missed). A deliverable verb vetoes it, so a summary/minutes/compare ask is never a needle.
 * Deterministic; the question is never logged.
 */
export function isNeedleShaped(question: string): boolean {
  const q = question.toLowerCase()
  if (DELIVERABLE_SHAPES.some((s) => q.includes(s)) || DELIVERABLE_SHAPE_RES.some((re) => re.test(q)))
    return false
  return NEEDLE_SHAPES.some((s) => q.includes(s)) || NEEDLE_SHAPE_RES.some((re) => re.test(q))
}
