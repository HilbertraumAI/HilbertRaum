// Authoring source for the Phase-29 grounded-QA benchmark set
// (model-benchmarks.md §2 / D19). Run with:  node eval/build.mjs
//
// This script IS the source of truth; `corpus_de_en.jsonl` and `rag_de_en.jsonl` are
// GENERATED from it. Keeping the data structured here (instead of hand-writing 100 JSONL
// lines) lets the builder VALIDATE every answerable item — its `gold_doc` must exist and at
// least one accepted gold span must be present (normalized) in that document's text. A
// broken item fails the build loudly instead of silently scoring every model as wrong.
//
// All passages are ORIGINAL prose authored for this benchmark → license-clean by
// construction (hard rule: no copyrighted eval data). Content is German/English PARALLEL
// pairs (same facts both languages, so per-model DE−EN gap is measurable — D18) plus
// German-only civic/everyday items, weighted ~60 DE / 40 EN with ~15% unanswerable.
//
// `normalize` here MUST match tests/eval/score.ts `normalizeText` (NFC + lowercase + strip
// punctuation + collapse whitespace, umlauts/ß KEPT). If you change one, change both.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DIR = dirname(fileURLToPath(import.meta.url))
const normalize = (s) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const present = (text, spans) => {
  const hay = ' ' + normalize(text) + ' '
  return spans.some((s) => hay.includes(' ' + normalize(s) + ' '))
}

// --- Corpus: title -> { lang, chunks[] } ------------------------------------------------
// 7 parallel DE/EN document pairs (office + civic/everyday) + 2 German-only civic docs.
// Distractors are deliberate: several docs mention "30 days", several mention amounts, so
// citation-correctness and abstention are non-trivial.

const DOCS = {
  // 1. Master services agreement (parallel)
  'Acme Master Services Agreement.pdf': {
    lang: 'en',
    chunks: [
      'Acme shall invoice the Client monthly. Undisputed invoices are due net thirty days from the invoice date; overdue amounts accrue interest at one percent per month.',
      "Except for breaches of confidentiality, each party's total aggregate liability under this Agreement shall not exceed one million US dollars.",
      'Either party may terminate this Agreement for convenience upon sixty days written notice, or immediately for an uncured material breach.',
      'This Agreement is governed by the laws of the State of Delaware, without regard to its conflict-of-laws principles.'
    ]
  },
  'Acme Rahmenvertrag.pdf': {
    lang: 'de',
    chunks: [
      'Acme stellt dem Kunden monatlich eine Rechnung. Unbestrittene Rechnungen sind innerhalb von dreißig Tagen ab Rechnungsdatum zur Zahlung fällig; überfällige Beträge werden mit einem Prozent pro Monat verzinst.',
      'Mit Ausnahme von Verletzungen der Vertraulichkeit ist die gesamte Haftung jeder Partei aus diesem Vertrag auf eine Million US-Dollar begrenzt.',
      'Jede Partei kann diesen Vertrag mit einer Frist von sechzig Tagen schriftlich ordentlich kündigen oder bei einer nicht behobenen wesentlichen Vertragsverletzung fristlos.',
      'Dieser Vertrag unterliegt dem Recht des Bundesstaates Delaware, ohne Berücksichtigung seiner Kollisionsnormen.'
    ]
  },
  // 2. Invoice (parallel)
  'Globex Invoice INV-2024-001.pdf': {
    lang: 'en',
    chunks: [
      'Invoice number INV-2024-001 was issued on 12 March 2024 by Globex Corporation to the Client for consulting services rendered in February 2024.',
      'The total amount due is 940 euro, payable within 30 days by bank transfer to the account listed in the footer. A late fee of 2 percent applies after the due date.',
      'VAT at 19 percent is included in the total. The purchase order reference is PO-7785.'
    ]
  },
  'Globex Rechnung RE-2024-001.pdf': {
    lang: 'de',
    chunks: [
      'Die Rechnung mit der Nummer RE-2024-001 wurde am 12. März 2024 von der Globex Corporation an den Kunden für im Februar 2024 erbrachte Beratungsleistungen ausgestellt.',
      'Der fällige Gesamtbetrag beträgt 940 Euro und ist innerhalb von 30 Tagen per Banküberweisung auf das im Fußbereich genannte Konto zu zahlen. Nach Fälligkeit fällt eine Mahngebühr von 2 Prozent an.',
      'Im Gesamtbetrag sind 19 Prozent Mehrwertsteuer enthalten. Die Bestellreferenz lautet PO-7785.'
    ]
  },
  // 3. Employee handbook (parallel)
  'Employee Handbook.docx': {
    lang: 'en',
    chunks: [
      'Full-time employees accrue twenty paid vacation days per year, accruing monthly and carrying over up to five days into the next year.',
      'Employees may work remotely up to three days per week with manager approval; core collaboration hours are 10:00 to 15:00 local time.',
      'Submit receipts within thirty days; travel and client-meal expenses are reimbursed at actual cost with manager approval.',
      'The probationary period for new employees is six months, during which the notice period is two weeks.'
    ]
  },
  'Mitarbeiterhandbuch.docx': {
    lang: 'de',
    chunks: [
      'Vollzeitbeschäftigte erwerben zwanzig bezahlte Urlaubstage pro Jahr; der Anspruch entsteht monatlich und bis zu fünf Tage können ins Folgejahr übertragen werden.',
      'Mitarbeitende dürfen mit Zustimmung der Führungskraft bis zu drei Tage pro Woche im Homeoffice arbeiten; die Kernarbeitszeit liegt zwischen 10:00 und 15:00 Uhr Ortszeit.',
      'Belege sind innerhalb von dreißig Tagen einzureichen; Reise- und Bewirtungskosten werden mit Zustimmung der Führungskraft zum tatsächlichen Betrag erstattet.',
      'Die Probezeit für neue Mitarbeitende beträgt sechs Monate; während dieser Zeit beträgt die Kündigungsfrist zwei Wochen.'
    ]
  },
  // 4. Security whitepaper (parallel)
  'Security Whitepaper.pdf': {
    lang: 'en',
    chunks: [
      'All customer data is encrypted at rest with AES-256 and in transit with TLS 1.3; encryption keys are rotated annually and stored in a hardware security module.',
      'Data residency: customer data is stored exclusively in the customer-selected region and is never replicated outside it without explicit written consent.',
      'Backups are taken every 24 hours and retained for 90 days. The recovery point objective is one hour.',
      'Access requires multi-factor authentication; administrative sessions time out after 15 minutes of inactivity.'
    ]
  },
  'Sicherheits-Whitepaper.pdf': {
    lang: 'de',
    chunks: [
      'Alle Kundendaten werden im Ruhezustand mit AES-256 und bei der Übertragung mit TLS 1.3 verschlüsselt; die Schlüssel werden jährlich rotiert und in einem Hardware-Sicherheitsmodul gespeichert.',
      'Datenresidenz: Kundendaten werden ausschließlich in der vom Kunden gewählten Region gespeichert und ohne ausdrückliche schriftliche Zustimmung niemals außerhalb repliziert.',
      'Sicherungen werden alle 24 Stunden erstellt und 90 Tage aufbewahrt. Das Recovery Point Objective beträgt eine Stunde.',
      'Der Zugriff erfordert eine Mehr-Faktor-Authentifizierung; administrative Sitzungen werden nach 15 Minuten Inaktivität automatisch beendet.'
    ]
  },
  // 5. Municipal waste-collection notice (parallel, civic)
  'Waste Collection Notice.pdf': {
    lang: 'en',
    chunks: [
      'Residual waste is collected every two weeks on Wednesdays. Please place bins at the curb by 6:00 a.m.',
      'Paper and cardboard are collected on the first Monday of each month. Glass must be taken to the public recycling points on Maple Street.',
      'Bulky-waste pickup can be booked by phone at least five working days in advance; up to three items are collected free of charge per year.'
    ]
  },
  'Müllabfuhr Hinweisblatt.pdf': {
    lang: 'de',
    chunks: [
      'Der Restmüll wird alle zwei Wochen mittwochs abgeholt. Bitte stellen Sie die Tonnen bis 6:00 Uhr an den Straßenrand.',
      'Papier und Karton werden am ersten Montag jedes Monats abgeholt. Glas ist zu den öffentlichen Sammelstellen in der Ahornstraße zu bringen.',
      'Die Sperrmüllabholung kann telefonisch mit einer Frist von mindestens fünf Werktagen angemeldet werden; bis zu drei Gegenstände werden pro Jahr kostenlos abgeholt.'
    ]
  },
  // 6. Coffee-machine user manual (parallel, everyday)
  'Coffee Machine User Manual.pdf': {
    lang: 'en',
    chunks: [
      'Descale the machine every two months using the supplied descaling solution. Run two full water cycles afterwards.',
      'The water tank holds 1.8 liters. Use filtered water to reduce limescale.',
      'If the red light blinks, the drip tray is full; empty it and reinsert. The machine switches off automatically after 20 minutes of inactivity.',
      'The warranty covers manufacturing defects for two years from the date of purchase.'
    ]
  },
  'Kaffeemaschine Bedienungsanleitung.pdf': {
    lang: 'de',
    chunks: [
      'Entkalken Sie die Maschine alle zwei Monate mit der mitgelieferten Entkalkerlösung. Lassen Sie anschließend zwei volle Wasserdurchläufe laufen.',
      'Der Wassertank fasst 1,8 Liter. Verwenden Sie gefiltertes Wasser, um Kalkablagerungen zu verringern.',
      'Wenn die rote Leuchte blinkt, ist die Abtropfschale voll; leeren Sie sie und setzen Sie sie wieder ein. Die Maschine schaltet sich nach 20 Minuten Inaktivität automatisch ab.',
      'Die Garantie deckt Herstellungsfehler für zwei Jahre ab Kaufdatum ab.'
    ]
  },
  // 7. Travel-insurance terms (parallel, civic)
  'Travel Insurance Terms.pdf': {
    lang: 'en',
    chunks: [
      'Coverage begins on the departure date and ends on the return date stated in the policy. The maximum trip length is 90 days.',
      'Medical expenses are covered up to 100,000 euro. The deductible per claim is 50 euro.',
      'Claims must be reported within 14 days of the incident. Lost-baggage claims require a written report from the carrier.',
      'Cancellation due to illness is reimbursed at 80 percent of the prepaid trip cost.'
    ]
  },
  'Reiseversicherung Bedingungen.pdf': {
    lang: 'de',
    chunks: [
      'Der Versicherungsschutz beginnt am Abreisetag und endet am in der Police genannten Rückreisetag. Die maximale Reisedauer beträgt 90 Tage.',
      'Heilbehandlungskosten sind bis zu 100.000 Euro abgedeckt. Der Selbstbehalt pro Schadensfall beträgt 50 Euro.',
      'Schäden sind innerhalb von 14 Tagen nach dem Ereignis zu melden. Bei Gepäckverlust ist eine schriftliche Bescheinigung des Beförderers erforderlich.',
      'Eine Stornierung wegen Krankheit wird mit 80 Prozent der vorausbezahlten Reisekosten erstattet.'
    ]
  },
  // German-only civic/everyday docs (drive the 20 DE-only items)
  'Hausordnung.pdf': {
    lang: 'de',
    chunks: [
      'Die Nachtruhe gilt von 22:00 bis 6:00 Uhr. In dieser Zeit sind Lärm und laute Musik zu vermeiden.',
      'Das Treppenhaus ist aus Brandschutzgründen freizuhalten; Fahrräder gehören in den Fahrradkeller.',
      'Die Waschküche darf werktags von 7:00 bis 20:00 Uhr genutzt werden; sonntags ist sie geschlossen.',
      'Mülltonnen sind am Abend vor der Abholung bereitzustellen. Sondermüll darf nicht in den Hausmüll.'
    ]
  },
  'Volkshochschule Kursprogramm.pdf': {
    lang: 'de',
    chunks: [
      'Der Kurs "Italienisch für Anfänger" beginnt am 15. September 2024 und umfasst zwölf Termine. Die Gebühr beträgt 96 Euro.',
      'Die Anmeldung ist bis spätestens eine Woche vor Kursbeginn online oder im Büro möglich. Eine Ermäßigung von 50 Prozent gilt für Studierende.',
      'Der Unterricht findet dienstags von 18:30 bis 20:00 Uhr in Raum 204 statt. Bitte bringen Sie das Lehrbuch zur ersten Stunde mit.',
      'Bei weniger als sechs Anmeldungen kann der Kurs abgesagt werden; die Gebühr wird in diesem Fall vollständig erstattet.'
    ]
  }
}

// --- Items -------------------------------------------------------------------------------
// Parallel pairs: one entry produces a DE item and an EN item sharing a `pair` stem.
// `de`/`en` carry {q, a[]}; `goldDe`/`goldEn` are the gold doc titles.

const PAIRS = [
  // 1. contract
  {
    pair: 'contract-liability', type: 'numeric', goldDe: 'Acme Rahmenvertrag.pdf', goldEn: 'Acme Master Services Agreement.pdf',
    de: { q: 'Wie hoch ist die Haftungsobergrenze im Vertrag mit Acme?', a: ['eine Million US-Dollar', '1.000.000 US-Dollar', 'eine Million'] },
    en: { q: 'What is the cap on each party’s liability in the Acme agreement?', a: ['one million US dollars', 'one million', '1,000,000'] }
  },
  {
    pair: 'contract-payment', type: 'numeric', goldDe: 'Acme Rahmenvertrag.pdf', goldEn: 'Acme Master Services Agreement.pdf',
    de: { q: 'Innerhalb welcher Frist sind unbestrittene Rechnungen laut Rahmenvertrag fällig?', a: ['dreißig Tagen', 'dreißig Tage', '30 Tagen'] },
    en: { q: 'Within how many days are undisputed invoices due under the master agreement?', a: ['thirty days', '30 days', 'thirty'] }
  },
  {
    pair: 'contract-termination', type: 'numeric', goldDe: 'Acme Rahmenvertrag.pdf', goldEn: 'Acme Master Services Agreement.pdf',
    de: { q: 'Welche Kündigungsfrist gilt für eine ordentliche Kündigung des Rahmenvertrags?', a: ['sechzig Tagen', 'sechzig Tage', '60 Tagen'] },
    en: { q: 'How much written notice is required to terminate the agreement for convenience?', a: ['sixty days', '60 days', 'sixty'] }
  },
  {
    pair: 'contract-law', type: 'entity', goldDe: 'Acme Rahmenvertrag.pdf', goldEn: 'Acme Master Services Agreement.pdf',
    de: { q: 'Welches Recht ist auf den Rahmenvertrag anwendbar?', a: ['Delaware'] },
    en: { q: 'Which state’s law governs the agreement?', a: ['Delaware'] }
  },
  {
    pair: 'contract-interest', type: 'numeric', goldDe: 'Acme Rahmenvertrag.pdf', goldEn: 'Acme Master Services Agreement.pdf',
    de: { q: 'Wie werden überfällige Beträge laut Rahmenvertrag verzinst?', a: ['einem Prozent pro Monat', 'ein Prozent pro Monat', '1 Prozent pro Monat'] },
    en: { q: 'What interest accrues on overdue amounts under the agreement?', a: ['one percent per month', '1 percent per month'] }
  },
  {
    pair: 'contract-penalty', type: 'unanswerable', unanswerable: true,
    de: { q: 'Welche Vertragsstrafe gilt bei verspäteter Lieferung laut Rahmenvertrag?', a: [] },
    en: { q: 'What is the penalty for late delivery under the agreement?', a: [] }
  },
  // 2. invoice
  {
    pair: 'invoice-total', type: 'numeric', goldDe: 'Globex Rechnung RE-2024-001.pdf', goldEn: 'Globex Invoice INV-2024-001.pdf',
    de: { q: 'Wie hoch ist der fällige Gesamtbetrag der Globex-Rechnung?', a: ['940 Euro', '940'] },
    en: { q: 'What is the total amount due on the Globex invoice?', a: ['940 euro', '940'] }
  },
  {
    pair: 'invoice-date', type: 'date', goldDe: 'Globex Rechnung RE-2024-001.pdf', goldEn: 'Globex Invoice INV-2024-001.pdf',
    de: { q: 'An welchem Datum wurde die Globex-Rechnung ausgestellt?', a: ['12. März 2024', '12. März'] },
    en: { q: 'On what date was the Globex invoice issued?', a: ['12 March 2024', '12 March'] }
  },
  {
    pair: 'invoice-vat', type: 'numeric', goldDe: 'Globex Rechnung RE-2024-001.pdf', goldEn: 'Globex Invoice INV-2024-001.pdf',
    de: { q: 'Wie hoch ist der im Gesamtbetrag enthaltene Mehrwertsteuersatz?', a: ['19 Prozent', '19%'] },
    en: { q: 'What VAT rate is included in the invoice total?', a: ['19 percent', '19%'] }
  },
  {
    pair: 'invoice-po', type: 'entity', goldDe: 'Globex Rechnung RE-2024-001.pdf', goldEn: 'Globex Invoice INV-2024-001.pdf',
    de: { q: 'Wie lautet die Bestellreferenz auf der Globex-Rechnung?', a: ['PO-7785'] },
    en: { q: 'What is the purchase order reference on the Globex invoice?', a: ['PO-7785'] }
  },
  {
    pair: 'invoice-latefee', type: 'numeric', goldDe: 'Globex Rechnung RE-2024-001.pdf', goldEn: 'Globex Invoice INV-2024-001.pdf',
    de: { q: 'Wie hoch ist die Mahngebühr nach Fälligkeit der Globex-Rechnung?', a: ['2 Prozent', '2%'] },
    en: { q: 'What late fee applies after the invoice due date?', a: ['2 percent', '2%'] }
  },
  {
    pair: 'invoice-discount', type: 'unanswerable', unanswerable: true,
    de: { q: 'Welcher Skonto gilt bei früher Zahlung der Globex-Rechnung?', a: [] },
    en: { q: 'What early-payment discount applies to the Globex invoice?', a: [] }
  },
  // 3. HR
  {
    pair: 'hr-vacation', type: 'numeric', goldDe: 'Mitarbeiterhandbuch.docx', goldEn: 'Employee Handbook.docx',
    de: { q: 'Wie viele bezahlte Urlaubstage erhalten Vollzeitbeschäftigte pro Jahr?', a: ['zwanzig', '20'] },
    en: { q: 'How many paid vacation days do full-time employees accrue per year?', a: ['twenty', '20'] }
  },
  {
    pair: 'hr-remote', type: 'numeric', goldDe: 'Mitarbeiterhandbuch.docx', goldEn: 'Employee Handbook.docx',
    de: { q: 'An wie vielen Tagen pro Woche ist Homeoffice erlaubt?', a: ['drei Tage pro Woche', 'drei Tage', 'drei'] },
    en: { q: 'How many days per week may employees work remotely?', a: ['three days per week', 'three days', 'three'] }
  },
  {
    pair: 'hr-corehours', type: 'span', goldDe: 'Mitarbeiterhandbuch.docx', goldEn: 'Employee Handbook.docx',
    de: { q: 'Wann liegt die Kernarbeitszeit?', a: ['10:00 und 15:00', '10:00 bis 15:00'] },
    en: { q: 'What are the core collaboration hours?', a: ['10:00 to 15:00'] }
  },
  {
    pair: 'hr-probation', type: 'numeric', goldDe: 'Mitarbeiterhandbuch.docx', goldEn: 'Employee Handbook.docx',
    de: { q: 'Wie lange dauert die Probezeit für neue Mitarbeitende?', a: ['sechs Monate', '6 Monate'] },
    en: { q: 'How long is the probationary period for new employees?', a: ['six months', '6 months'] }
  },
  {
    pair: 'hr-carryover', type: 'numeric', goldDe: 'Mitarbeiterhandbuch.docx', goldEn: 'Employee Handbook.docx',
    de: { q: 'Wie viele Urlaubstage können ins Folgejahr übertragen werden?', a: ['fünf Tage', 'fünf', '5 Tage'] },
    en: { q: 'How many vacation days can be carried over into the next year?', a: ['five days', 'five', '5 days'] }
  },
  {
    pair: 'hr-sick', type: 'unanswerable', unanswerable: true,
    de: { q: 'Wie viele bezahlte Krankheitstage gibt es laut Handbuch pro Jahr?', a: [] },
    en: { q: 'How many paid sick days per year does the handbook grant?', a: [] }
  },
  // 4. security
  {
    pair: 'security-rest', type: 'entity', goldDe: 'Sicherheits-Whitepaper.pdf', goldEn: 'Security Whitepaper.pdf',
    de: { q: 'Mit welchem Verfahren werden Daten im Ruhezustand verschlüsselt?', a: ['AES-256'] },
    en: { q: 'What algorithm encrypts customer data at rest?', a: ['AES-256'] }
  },
  {
    pair: 'security-tls', type: 'entity', goldDe: 'Sicherheits-Whitepaper.pdf', goldEn: 'Security Whitepaper.pdf',
    de: { q: 'Welche TLS-Version wird bei der Übertragung verwendet?', a: ['TLS 1.3'] },
    en: { q: 'Which TLS version protects data in transit?', a: ['TLS 1.3'] }
  },
  {
    pair: 'security-backup', type: 'numeric', goldDe: 'Sicherheits-Whitepaper.pdf', goldEn: 'Security Whitepaper.pdf',
    de: { q: 'Wie lange werden Sicherungen aufbewahrt?', a: ['90 Tage'] },
    en: { q: 'How long are backups retained?', a: ['90 days'] }
  },
  {
    pair: 'security-timeout', type: 'numeric', goldDe: 'Sicherheits-Whitepaper.pdf', goldEn: 'Security Whitepaper.pdf',
    de: { q: 'Nach welcher Inaktivitätsdauer werden administrative Sitzungen beendet?', a: ['15 Minuten'] },
    en: { q: 'After how long do administrative sessions time out?', a: ['15 minutes'] }
  },
  {
    pair: 'security-rotation', type: 'span', goldDe: 'Sicherheits-Whitepaper.pdf', goldEn: 'Security Whitepaper.pdf',
    de: { q: 'Wie oft werden die Verschlüsselungsschlüssel rotiert?', a: ['jährlich'] },
    en: { q: 'How often are encryption keys rotated?', a: ['annually'] }
  },
  {
    pair: 'security-antivirus', type: 'unanswerable', unanswerable: true,
    de: { q: 'Welches Antivirenprodukt wird auf den Endgeräten eingesetzt?', a: [] },
    en: { q: 'Which antivirus product is deployed on endpoints?', a: [] }
  },
  // 5. waste
  {
    pair: 'waste-residual', type: 'span', goldDe: 'Müllabfuhr Hinweisblatt.pdf', goldEn: 'Waste Collection Notice.pdf',
    de: { q: 'In welchem Rhythmus wird der Restmüll abgeholt?', a: ['alle zwei Wochen'] },
    en: { q: 'How often is residual waste collected?', a: ['every two weeks'] }
  },
  {
    pair: 'waste-curfew', type: 'span', goldDe: 'Müllabfuhr Hinweisblatt.pdf', goldEn: 'Waste Collection Notice.pdf',
    de: { q: 'Bis zu welcher Uhrzeit müssen die Tonnen bereitstehen?', a: ['6:00 Uhr', '6:00'] },
    en: { q: 'By what time must bins be placed at the curb?', a: ['6:00 a.m.', '6:00'] }
  },
  {
    pair: 'waste-glass', type: 'entity', goldDe: 'Müllabfuhr Hinweisblatt.pdf', goldEn: 'Waste Collection Notice.pdf',
    de: { q: 'Wohin ist Glas zu bringen?', a: ['Ahornstraße'] },
    en: { q: 'Where must glass be taken?', a: ['Maple Street'] }
  },
  {
    pair: 'waste-bulky-notice', type: 'numeric', goldDe: 'Müllabfuhr Hinweisblatt.pdf', goldEn: 'Waste Collection Notice.pdf',
    de: { q: 'Mit welcher Vorlauffrist ist Sperrmüll anzumelden?', a: ['fünf Werktagen', 'fünf Werktage', '5 Werktagen'] },
    en: { q: 'How far in advance must bulky-waste pickup be booked?', a: ['five working days', '5 working days'] }
  },
  {
    pair: 'waste-bulky-free', type: 'numeric', goldDe: 'Müllabfuhr Hinweisblatt.pdf', goldEn: 'Waste Collection Notice.pdf',
    de: { q: 'Wie viele Sperrmüllgegenstände werden pro Jahr kostenlos abgeholt?', a: ['drei Gegenstände', 'drei', '3'] },
    en: { q: 'How many bulky items are collected free of charge per year?', a: ['three items', 'three', '3'] }
  },
  {
    pair: 'waste-extracost', type: 'unanswerable', unanswerable: true,
    de: { q: 'Was kostet eine zusätzliche Restmülltonne pro Monat?', a: [] },
    en: { q: 'How much does an extra residual-waste bin cost per month?', a: [] }
  },
  // 6. coffee
  {
    pair: 'coffee-descale', type: 'span', goldDe: 'Kaffeemaschine Bedienungsanleitung.pdf', goldEn: 'Coffee Machine User Manual.pdf',
    de: { q: 'In welchem Abstand sollte die Maschine entkalkt werden?', a: ['alle zwei Monate'] },
    en: { q: 'How often should the machine be descaled?', a: ['every two months'] }
  },
  {
    pair: 'coffee-tank', type: 'numeric', goldDe: 'Kaffeemaschine Bedienungsanleitung.pdf', goldEn: 'Coffee Machine User Manual.pdf',
    de: { q: 'Wie viel Wasser fasst der Tank?', a: ['1,8 Liter'] },
    en: { q: 'How much water does the tank hold?', a: ['1.8 liters'] }
  },
  {
    pair: 'coffee-redlight', type: 'synthesis', goldDe: 'Kaffeemaschine Bedienungsanleitung.pdf', goldEn: 'Coffee Machine User Manual.pdf',
    de: { q: 'Was bedeutet es, wenn die rote Leuchte blinkt?', a: ['Abtropfschale voll', 'Abtropfschale ist voll', 'Abtropfschale'] },
    en: { q: 'What does a blinking red light indicate?', a: ['drip tray is full', 'drip tray'] }
  },
  {
    pair: 'coffee-autooff', type: 'numeric', goldDe: 'Kaffeemaschine Bedienungsanleitung.pdf', goldEn: 'Coffee Machine User Manual.pdf',
    de: { q: 'Nach welcher Zeit schaltet sich die Maschine automatisch ab?', a: ['20 Minuten'] },
    en: { q: 'After how long does the machine switch off automatically?', a: ['20 minutes'] }
  },
  {
    pair: 'coffee-warranty', type: 'numeric', goldDe: 'Kaffeemaschine Bedienungsanleitung.pdf', goldEn: 'Coffee Machine User Manual.pdf',
    de: { q: 'Wie lange gilt die Garantie ab Kaufdatum?', a: ['zwei Jahre', '2 Jahre'] },
    en: { q: 'How long is the warranty from the date of purchase?', a: ['two years', '2 years'] }
  },
  {
    pair: 'coffee-grind', type: 'unanswerable', unanswerable: true,
    de: { q: 'Welche Mahlstärke wird für Espresso empfohlen?', a: [] },
    en: { q: 'What grind size is recommended for espresso?', a: [] }
  },
  // 7. insurance (4 answerable, no unanswerable)
  {
    pair: 'insurance-triplen', type: 'numeric', goldDe: 'Reiseversicherung Bedingungen.pdf', goldEn: 'Travel Insurance Terms.pdf',
    de: { q: 'Wie lang ist die maximale Reisedauer laut Versicherungsbedingungen?', a: ['90 Tage'] },
    en: { q: 'What is the maximum trip length under the policy?', a: ['90 days'] }
  },
  {
    pair: 'insurance-medical', type: 'numeric', goldDe: 'Reiseversicherung Bedingungen.pdf', goldEn: 'Travel Insurance Terms.pdf',
    de: { q: 'Bis zu welchem Betrag sind Heilbehandlungskosten abgedeckt?', a: ['100.000 Euro'] },
    en: { q: 'Up to what amount are medical expenses covered?', a: ['100,000 euro'] }
  },
  {
    pair: 'insurance-deductible', type: 'numeric', goldDe: 'Reiseversicherung Bedingungen.pdf', goldEn: 'Travel Insurance Terms.pdf',
    de: { q: 'Wie hoch ist der Selbstbehalt pro Schadensfall?', a: ['50 Euro'] },
    en: { q: 'What is the deductible per claim?', a: ['50 euro'] }
  },
  {
    pair: 'insurance-cancel', type: 'numeric', goldDe: 'Reiseversicherung Bedingungen.pdf', goldEn: 'Travel Insurance Terms.pdf',
    de: { q: 'Zu welchem Anteil wird eine Stornierung wegen Krankheit erstattet?', a: ['80 Prozent', '80%'] },
    en: { q: 'At what percentage is illness-related cancellation reimbursed?', a: ['80 percent', '80%'] }
  }
]

// German-only items (20): civic/everyday emphasis + a few extra facts on the parallel DE docs.
const DE_ONLY = [
  // Hausordnung (5 answerable + 1 unanswerable)
  { id: 'de-hausordnung-nachtruhe-start', type: 'span', gold: 'Hausordnung.pdf', q: 'Ab welcher Uhrzeit beginnt die Nachtruhe?', a: ['22:00'] },
  { id: 'de-hausordnung-nachtruhe-end', type: 'span', gold: 'Hausordnung.pdf', q: 'Bis wann gilt die Nachtruhe?', a: ['6:00 Uhr', '6:00'] },
  { id: 'de-hausordnung-fahrrad', type: 'entity', gold: 'Hausordnung.pdf', q: 'Wo sind Fahrräder abzustellen?', a: ['Fahrradkeller'] },
  { id: 'de-hausordnung-waschen-ende', type: 'span', gold: 'Hausordnung.pdf', q: 'Bis zu welcher Uhrzeit darf die Waschküche werktags genutzt werden?', a: ['20:00 Uhr', '20:00'] },
  { id: 'de-hausordnung-sonntag', type: 'span', gold: 'Hausordnung.pdf', q: 'Wann ist die Waschküche sonntags nutzbar?', a: ['geschlossen'] },
  { id: 'de-hausordnung-miete', type: 'unanswerable', unanswerable: true, gold: null, q: 'Wie hoch ist die monatliche Miete laut Hausordnung?', a: [] },
  // Volkshochschule (6 answerable + 2 unanswerable)
  { id: 'de-vhs-beginn', type: 'date', gold: 'Volkshochschule Kursprogramm.pdf', q: 'Wann beginnt der Italienischkurs für Anfänger?', a: ['15. September 2024', '15. September'] },
  { id: 'de-vhs-gebuehr', type: 'numeric', gold: 'Volkshochschule Kursprogramm.pdf', q: 'Wie hoch ist die Kursgebühr?', a: ['96 Euro', '96'] },
  { id: 'de-vhs-ermaessigung', type: 'numeric', gold: 'Volkshochschule Kursprogramm.pdf', q: 'Welche Ermäßigung gilt für Studierende?', a: ['50 Prozent', '50%'] },
  { id: 'de-vhs-zeit', type: 'span', gold: 'Volkshochschule Kursprogramm.pdf', q: 'Zu welcher Uhrzeit findet der Unterricht dienstags statt?', a: ['18:30 bis 20:00 Uhr', '18:30 bis 20:00'] },
  { id: 'de-vhs-raum', type: 'entity', gold: 'Volkshochschule Kursprogramm.pdf', q: 'In welchem Raum findet der Kurs statt?', a: ['Raum 204', '204'] },
  { id: 'de-vhs-mindest', type: 'numeric', gold: 'Volkshochschule Kursprogramm.pdf', q: 'Ab wie wenigen Anmeldungen kann der Kurs abgesagt werden?', a: ['sechs Anmeldungen', 'sechs', '6'] },
  { id: 'de-vhs-lehrbuch', type: 'unanswerable', unanswerable: true, gold: null, q: 'Welches Lehrbuch wird im Italienischkurs verwendet?', a: [] },
  { id: 'de-vhs-parkplatz', type: 'unanswerable', unanswerable: true, gold: null, q: 'Gibt es an der Volkshochschule kostenlose Parkplätze?', a: [] },
  // Extra DE facts on the parallel DE docs (6 answerable)
  { id: 'de-contract-confidentiality', type: 'entity', gold: 'Acme Rahmenvertrag.pdf', q: 'Wovon gilt die Haftungsbegrenzung im Rahmenvertrag als Ausnahme?', a: ['Vertraulichkeit'] },
  { id: 'de-invoice-issuer', type: 'entity', gold: 'Globex Rechnung RE-2024-001.pdf', q: 'Wer hat die Rechnung RE-2024-001 ausgestellt?', a: ['Globex Corporation', 'Globex'] },
  { id: 'de-hr-probation-notice', type: 'numeric', gold: 'Mitarbeiterhandbuch.docx', q: 'Wie lang ist die Kündigungsfrist während der Probezeit?', a: ['zwei Wochen', '2 Wochen'] },
  { id: 'de-security-backupfreq', type: 'span', gold: 'Sicherheits-Whitepaper.pdf', q: 'In welchem Abstand werden Sicherungen erstellt?', a: ['alle 24 Stunden', '24 Stunden'] },
  { id: 'de-waste-paper', type: 'span', gold: 'Müllabfuhr Hinweisblatt.pdf', q: 'An welchem Tag werden Papier und Karton abgeholt?', a: ['ersten Montag jedes Monats', 'ersten Montag'] },
  { id: 'de-insurance-baggage', type: 'span', gold: 'Reiseversicherung Bedingungen.pdf', q: 'Was ist bei einem Gepäckverlust erforderlich?', a: ['schriftliche Bescheinigung des Beförderers', 'schriftliche Bescheinigung'] }
]

// --- Assemble + validate -----------------------------------------------------------------

const corpus = []
for (const [doc, { lang, chunks }] of Object.entries(DOCS)) {
  chunks.forEach((text, index) => corpus.push({ doc, lang, index, text }))
}
const docText = (title) =>
  corpus.filter((c) => c.doc === title).map((c) => c.text).join(' ')

const items = []
for (const p of PAIRS) {
  const unanswerable = p.type === 'unanswerable'
  items.push({
    id: `de-${p.pair}`, lang: 'de', pair: p.pair, question: p.de.q, answer: p.de.a,
    unanswerable, gold_doc: unanswerable ? null : p.goldDe, type: p.type
  })
  items.push({
    id: `en-${p.pair}`, lang: 'en', pair: p.pair, question: p.en.q, answer: p.en.a,
    unanswerable, gold_doc: unanswerable ? null : p.goldEn, type: p.type
  })
}
for (const d of DE_ONLY) {
  items.push({
    id: d.id, lang: 'de', question: d.q, answer: d.a,
    unanswerable: !!d.unanswerable, gold_doc: d.gold ?? null, type: d.type
  })
}

// Validation — fail loudly on a broken item.
const problems = []
const docTitles = new Set(Object.keys(DOCS))
for (const it of items) {
  if (it.unanswerable) {
    if (it.gold_doc !== null || it.answer.length !== 0) problems.push(`${it.id}: unanswerable must have null gold_doc + empty answer`)
    continue
  }
  if (!it.gold_doc || !docTitles.has(it.gold_doc)) { problems.push(`${it.id}: gold_doc missing/unknown (${it.gold_doc})`); continue }
  if (it.answer.length === 0) { problems.push(`${it.id}: answerable item has no gold spans`); continue }
  if (!present(docText(it.gold_doc), it.answer)) {
    problems.push(`${it.id}: no gold span present in ${it.gold_doc} -> ${JSON.stringify(it.answer)}`)
  }
}
if (problems.length) {
  console.error('VALIDATION FAILED:\n' + problems.join('\n'))
  process.exit(1)
}

writeFileSync(join(DIR, 'corpus_de_en.jsonl'), corpus.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
writeFileSync(join(DIR, 'rag_de_en.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8')

const de = items.filter((i) => i.lang === 'de').length
const en = items.filter((i) => i.lang === 'en').length
const unans = items.filter((i) => i.unanswerable).length
console.log(`corpus: ${corpus.length} chunks across ${docTitles.size} documents`)
console.log(`items:  ${items.length} total | ${de} de / ${en} en | ${unans} unanswerable (${((unans / items.length) * 100).toFixed(0)}%)`)
console.log('OK — all answerable gold spans present in their gold_doc.')
