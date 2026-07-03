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

/** The eight bundled app skills that carry a canonical vocabulary (the routing + suggestion label space). */
export type SkillVocabId =
  | 'bank-statement'
  | 'invoice'
  | 'meeting-protocol'
  | 'contract-brief'
  | 'share-safe-review'
  | 'deadline-obligation-finder'
  | 'what-changed'
  | 'document-redaction'

export const APP_VOCAB_SKILL_IDS: readonly SkillVocabId[] = [
  'bank-statement',
  'invoice',
  'meeting-protocol',
  'contract-brief',
  'share-safe-review',
  'deadline-obligation-finder',
  'what-changed',
  'document-redaction'
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
  route('zusammenfass', 'de', 'stem') // Zusammenfassung / zusammenfassen
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
  route('wie viele', 'de')
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

/** The single source of truth: skill id → its canonical bilingual vocabulary. */
export const SKILL_VOCABULARY: Record<SkillVocabId, VocabEntry[]> = {
  'bank-statement': BANK_STATEMENT,
  invoice: INVOICE,
  'meeting-protocol': MEETING_PROTOCOL,
  'contract-brief': CONTRACT_BRIEF,
  'share-safe-review': SHARE_SAFE_REVIEW,
  'deadline-obligation-finder': DEADLINE_OBLIGATION,
  'what-changed': WHAT_CHANGED,
  'document-redaction': DOCUMENT_REDACTION
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
