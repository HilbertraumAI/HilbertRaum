// Real-layout fixture corpus (skills-remediation T1, audit §7 rec 1) — the SINGLE committed home for the
// incident-class extractor fixtures. Every recent wrong-figure incident (INVOICE-TOTALS-1, the HVB
// zero-transactions class, the §5.3 NBSP/Unicode family) was a REAL-LAYOUT feature that post-hoc synthetic
// fixtures (built to match the parser) never carried. These fixtures reproduce those layouts as CONSTRUCTED
// German/Austrian/Swiss statements and invoices — never real user documents — so the real extractors are
// exercised against the shapes that actually broke in the field.
//
// The corpus is fed to the REAL `extractTransactionsWithStats`/`extractStatementBalances` (bank) and
// `extractInvoice` (invoice) exactly as the production tool calls them (see extractor-realworld.test.ts).
// It is the input to BOTH T1 tests: the real-world assertion suite (figures parse correctly) and the
// output-snapshot / version-bump guard (any output change without an extractor version bump fails).
//
// The special characters are written as \u ESCAPES on purpose — an NBSP, a narrow NBSP, a U+2212 minus, or
// a Swiss U+2019 apostrophe is invisible in an editor and a git normalization or a copy-paste can silently
// turn it into ASCII, which would quietly defeat the very incident class the fixture guards. The escapes are
// self-documenting and byte-stable.

// ---- The invisible incident-class characters (the R1 normalization side-doors) -------------------------
export const NBSP = "\u00A0" // no-break space thousands separator (the 1 234,56 -> 234,56 truncation)
export const NNBSP = "\u202F" // narrow no-break space (AT/DE typographic grouping)
export const FIGSP = "\u2007" // figure space (monospaced grouping)
export const MINUS = "\u2212" // real minus sign (typographic debit minus, not ASCII hyphen)
export const ENDASH = "\u2013" // en dash (minus look-alike that dropped a debit sign)
export const NBHYPHEN = "\u2011" // non-breaking hyphen (a third minus look-alike)
export const RSQUO = "\u2019" // right single quote (Swiss grouping apostrophe)

/**
 * The canonical incident classes T1 consolidates (audit §7 rec 1 / the R-phase probes). The corpus MUST,
 * as a whole, exercise every one of these — the real-world test asserts the union of the fixtures' declared
 * `incidentClasses` covers this list, so a future edit that drops a class fails loudly.
 */
export const INCIDENT_CLASSES = [
  'nbsp', // NBSP / narrow-NBSP / figure-space thousands grouping (R1, §5.3)
  'u2212', // U+2212 / en-dash / non-breaking-hyphen debit sign (R1, §5.3)
  'summe-labels', // German totals labels: Summe / Summe netto / Endbetrag / Rechnungssumme (R2, §5.4)
  'sepa-rows', // SEPA-Lastschrift / SEPA-Gutschrift transfer boilerplate (R3, §5.5)
  'dd.mm.yy', // two-digit-year dates completed against a document anchor (R5, §5.7)
  'cross-year', // a December row on a January-anchored statement rolls to the previous year (R5, §5.7)
  'wrapped-descriptions', // a payee/purpose that wrapped to the next printed line (R6, §5.7)
  'midline-date', // a mid-line/trailing date read as the AMOUNT by the row money scan (R7, SKA-1)
  'ddmmyy-money-shape', // dd.mm.yy dates money-shaped + invisible to the date scrubs (R7, SKA-2)
  'dot-decimal-geometry', // geometry classifier ate d.dd amounts as dates on CH/UK/US statements (R7, SKA-13)
  'money-bearing-header' // invoice vendor/number header labels swallowed money-bearing lines (R7, SKA-14)
] as const

export type IncidentClass = (typeof INCIDENT_CLASSES)[number]

export interface BankFixture {
  id: string
  kind: 'bank'
  title: string
  /** Which incident classes (+ extra descriptive tags) this fixture exercises. */
  incidentClasses: Array<IncidentClass | string>
  /** What the layout is / why it once broke. */
  note: string
  /** The printed text, one entry per PAGE (a chunk = a page on the real path; wrapped continuations must
   *  sit in the SAME chunk as their booking row — the parser scopes continuation association per chunk). */
  chunks: string[]
}

export interface InvoiceFixture {
  id: string
  kind: 'invoice'
  title: string
  incidentClasses: Array<IncidentClass | string>
  note: string
  chunks: string[]
}

export type Fixture = BankFixture | InvoiceFixture

// =====================================================================================================
// BANK STATEMENTS
// =====================================================================================================

/**
 * Austrian Raiffeisen "Mein ELBA"-style statement. Carries, in one realistic layout: NBSP-grouped amounts,
 * U+2212 minus debits, a bare `28.12.` December row on a January-anchored statement (cross-year → previous
 * year), a two-digit-year `06.01.26` row, a wrapped SEPA-Lastschrift payee (NETFLIX on the next line), and
 * dual `Kontostand am` opening/closing balances. The amounts carry no per-row currency code (typical AT
 * layout) — the statement declares EUR once in the header, which the majority-vote currency read picks up.
 */
const bankElba: BankFixture = {
  id: 'bank-at-elba-nbsp-minus',
  kind: 'bank',
  title: 'Raiffeisen Mein ELBA — Kontoauszug (AT)',
  incidentClasses: ['nbsp', 'u2212', 'sepa-rows', 'dd.mm.yy', 'cross-year', 'wrapped-descriptions'],
  note: 'AT statement: NBSP grouping, U+2212 debits, bare December cross-year row, dd.mm.yy row, wrapped SEPA payee, Kontostand am balances.',
  chunks: [
    [
      'Raiffeisenbank — Mein ELBA',
      'Kontoauszug Nr. 1 / 2026',
      'Alle Beträge in EUR',
      `Kontostand am 05.01.2026${NBSP}${NBSP}1${NBSP}000,00`,
      `28.12. Dauerauftrag Miete${NBSP}${NBSP}${MINUS}900,00`,
      `06.01.26 SEPA-Gutschrift Gehalt${NBSP}${NBSP}2${NBSP}500,00`,
      `07.01.2026 SEPA-Lastschrift${NBSP}${NBSP}${MINUS}12,99`,
      'NETFLIX INTERNATIONAL B.V.',
      `15.01.2026 Bankomat Abhebung${NBSP}${NBSP}${MINUS}200,00`,
      `Kontostand am 31.01.2026${NBSP}${NBSP}2${NBSP}387,01`
    ].join('\n')
  ]
}

/**
 * German Sparkasse-style statement with a running balance column. Carries: en-dash (U+2013) minus debits, a
 * narrow-NBSP (U+202F) grouped credit + balances, and a wrapped Lastschrift payee (STADTWERKE on the next
 * line). Every row prints its own dd.mm.yyyy date (no anchor needed) so this fixture isolates the sign /
 * grouping / wrap classes from the date classes.
 */
const bankSparkasse: BankFixture = {
  id: 'bank-de-sparkasse-endash',
  kind: 'bank',
  title: 'Sparkasse — Kontoauszug (DE, Saldo-Spalte)',
  incidentClasses: ['u2212', 'nbsp', 'sepa-rows', 'wrapped-descriptions', 'ambiguous-date-default', 'figure-space', 'nb-hyphen'],
  note: 'DE statement with running balances: en-dash + non-breaking-hyphen debits, narrow-NBSP + figure-space grouping, wrapped SEPA payee; all dates day≤12 so the order defaults day-first (dateOrderInferred=default → the R5 caveat class).',
  chunks: [
    [
      'Sparkasse — Kontoauszug',
      'Buchungen in EUR',
      `01.02.2026 Kartenzahlung REWE${NBSP}${ENDASH}45,90${NBSP}${NBSP}954,10`,
      `02.02.2026 SEPA-Lastschrift${NBSP}${ENDASH}19,99${NBSP}${NBSP}934,11`,
      'STADTWERKE MUENCHEN',
      `05.02.2026 SEPA-Gutschrift Lohn${NBSP}${NNBSP}2${NNBSP}500,00${NBSP}${NBSP}3${NNBSP}434,11`,
      // A non-breaking-hyphen (U+2011) debit sign + a figure-space (U+2007) grouped amount AND balance —
      // exercises the last two normalization side-doors that the other rows don't (R1, §5.3).
      `06.02.2026 Dauerauftrag Sparplan${NBSP}${NBHYPHEN}1${FIGSP}000,00${NBSP}${NBSP}2${FIGSP}434,11`
    ].join('\n')
  ]
}

/**
 * Austrian Volksbank-style statement whose PERIOD lines and balance lines carry the date shapes that used
 * to be read as MONEY (R7, skills-audit-2026-07-03): a standalone period line (`01.03.2026 bis 31.03.2026`
 * — SKA-1's invented "bis" transaction), its dd.mm.yy twin (`15.03.26 bis 31.03.26` → invented 3103.26),
 * and dd.mm.yy TRAILING dates on the opening/closing balance lines (`per 01.03.26` → opening 103.26,
 * `per 31.03.26` → closing 3103.26 — SKA-2). Correct read: 3 rows, droppedRowCount 0, opening 1000 +
 * (−19,15 + 250 − 100) = closing 1130,85 (the tie proves no row was invented).
 */
const bankDdmmyy: BankFixture = {
  id: 'bank-at-ddmmyy-period-balance',
  kind: 'bank',
  title: 'Volksbank — Kontoauszug (AT, dd.mm.yy Perioden-/Saldozeilen)',
  incidentClasses: ['midline-date', 'ddmmyy-money-shape', 'dd.mm.yy'],
  note: 'AT statement: standalone period line (4-digit + dd.mm.yy variants) must not invent a transaction; dd.mm.yy trailing dates on balance lines must not become the balances.',
  chunks: [
    [
      'Volksbank — Kontoauszug Nr. 3/2026',
      'Alle Beträge in EUR',
      '01.03.2026 bis 31.03.2026',
      'Anfangssaldo 1.000,00 EUR per 01.03.26',
      '02.03.2026 Kartenzahlung REWE -19,15',
      '05.03.26 SEPA-Gutschrift Miete Anteil 250,00',
      '10.03.2026 Dauerauftrag Sparen -100,00',
      '15.03.26 bis 31.03.26 Zinsperiode',
      'Endsaldo 1.130,85 EUR per 31.03.26'
    ].join('\n')
  ]
}

// =====================================================================================================
// INVOICES
// =====================================================================================================

/**
 * Austrian tax-advisor invoice — the INVOICE-TOTALS / label-theft class (audit §5.2 CRITICAL, R2). The line
 * `Steuerberatung Jänner 500,00 EUR` used to be stolen into `taxTotal` by a bare `steuer` prefix match;
 * it must stay a LINE ITEM. Also carries NBSP grouping and the extended German totals labels (Summe netto /
 * USt / Rechnungssumme inkl. USt), with the totals block printed AFTER the items (last-block-wins).
 */
const invoiceSteuer: InvoiceFixture = {
  id: 'invoice-at-steuerberatung',
  kind: 'invoice',
  title: 'Steuerkanzlei — Rechnung (AT)',
  incidentClasses: ['summe-labels', 'nbsp', 'r2-label-theft'],
  note: 'AT invoice: Steuerberatung line item must NOT become taxTotal; Summe netto / USt / Rechnungssumme labels; NBSP grouping.',
  chunks: [
    [
      'STEUERKANZLEI MUSTER GmbH',
      'Rechnung Nr. 2026-014',
      'Rechnungsdatum 15.03.2026',
      'Fällig 14.04.2026',
      '',
      'Pos  Leistung                         Betrag',
      `Steuerberatung Jänner${NBSP}${NBSP}500,00 EUR`,
      `Netto-Miete Objekt 3${NBSP}${NBSP}1${NBSP}000,00 EUR`,
      '',
      `Summe netto${NBSP}${NBSP}1${NBSP}500,00 EUR`,
      `Steuer 20%${NBSP}${NBSP}300,00 EUR`,
      `Rechnungssumme inkl. USt${NBSP}${NBSP}1${NBSP}800,00 EUR`
    ].join('\n')
  ]
}

/**
 * Swiss-style invoice: U+2019 apostrophe grouping (`2'400.00`), a `.`-decimal / `'`-grouped amount, a
 * wrapped line-item description (Onsite-Workshop on the next line, money-less), and a `Summe` gross label.
 * Isolates the Swiss-apostrophe normalization + the wrapped line-item-description class.
 */
const invoiceSwiss: InvoiceFixture = {
  id: 'invoice-ch-summe-apostrophe',
  kind: 'invoice',
  title: 'Muster AG — Rechnung (CH)',
  incidentClasses: ['summe-labels', 'wrapped-descriptions', 'swiss-apostrophe'],
  note: 'CH invoice: U+2019 apostrophe grouping, wrapped line-item description, Summe gross label.',
  chunks: [
    [
      'Muster AG',
      'Rechnung 2026-77',
      'Rechnungsdatum 03.02.2026',
      '',
      `Beratung Projekt Alpha${NBSP}${NBSP}2${RSQUO}400.00 CHF`,
      'Onsite-Workshop Zürich',
      `Lizenz Jahresabo${NBSP}${NBSP}600.00 CHF`,
      '',
      `Summe${NBSP}${NBSP}3${RSQUO}000.00 CHF`
    ].join('\n')
  ]
}

/**
 * German trade invoice exercising the phantom-item guard (audit §5.2, R2): `Zwischensumme` and `Endbetrag`
 * are SUMMARY lines and must NOT become line items, while a `${ENDASH}20,00` discount row stays a real
 * (negative) line item. Carries the `Endbetrag` gross label + an en-dash credit.
 */
const invoicePhantom: InvoiceFixture = {
  id: 'invoice-de-endbetrag-phantom',
  kind: 'invoice',
  title: 'Handwerk Meier — Rechnung (DE)',
  incidentClasses: ['summe-labels', 'u2212', 'phantom-guard'],
  note: 'DE invoice: Endbetrag gross label; Zwischensumme/Endbetrag must NOT become phantom line items; en-dash credit line.',
  chunks: [
    [
      'Handwerk Meier',
      'Rechnung R-2026-5',
      'Rechnungsdatum 20.02.2026',
      '',
      'Material                              120,00 EUR',
      'Arbeitszeit                           150,00 EUR',
      `Rabatt                                ${ENDASH}20,00 EUR`,
      '',
      'Zwischensumme                         250,00 EUR',
      'Endbetrag                             250,00 EUR'
    ].join('\n')
  ]
}

/**
 * German invoice whose header-label lines carry MONEY (R7, skills-audit-2026-07-03 SKA-14) and whose
 * dates print dd.mm.yy (SKA-2). `Rechnung Nr. … über 390,00 EUR` (a number label) and `From … to …
 * Hosting 49,00 EUR` ("from" is a vendor label) used to be consumed as headers: the figure vanished,
 * droppedRowCount stayed 0, and vendor/invoiceNumber captured garbage tails — now both stay LINE ITEMS
 * (their descriptions keep the untouched mid-line dates byte-exact, the SKA-1 same-length-scrub pin).
 * `Datum: 15.03.26` is a HEADER date (was the phantom item {description: "Datum:", lineTotal: 1503.26})
 * and `Gesamtbetrag 390,00 EUR per 30.06.26` reads gross 390 (was 3006.26).
 */
const invoiceMoneyHeaders: InvoiceFixture = {
  id: 'invoice-de-ddmmyy-money-headers',
  kind: 'invoice',
  title: 'Webhosting Alpen — Rechnung (DE, money-bearing Header-Zeilen)',
  incidentClasses: ['money-bearing-header', 'ddmmyy-money-shape', 'midline-date'],
  note: 'DE invoice: money-bearing vendor/number label lines stay line items; dd.mm.yy header/totals dates are scrubbed, not read as figures.',
  chunks: [
    [
      'Webhosting Alpen GmbH',
      'Rechnung Nr. 2026-14 vom 03.05.2026 über 390,00 EUR',
      'Datum: 15.03.26',
      '',
      'From 01.06.2026 to 30.06.2026 Hosting 49,00 EUR',
      'Serverpflege Juni 276,00 EUR',
      '',
      'Summe netto 325,00 EUR',
      'MwSt. 20% 65,00 EUR',
      'Gesamtbetrag 390,00 EUR per 30.06.26'
    ].join('\n')
  ]
}

// =====================================================================================================
// GEOMETRY STATEMENTS (positioned words — run through the REAL `reconstructPage`, then the extractors)
// =====================================================================================================

/** A positioned word for a geometry fixture — mirrors `LayoutWord` (pdf-layout.ts) structurally so this
 *  fixtures module needs no import from `src` (`w` is unused by clustering today). */
export interface GeometryWord {
  str: string
  x: number
  y: number
  w: number
}

export interface GeometryBankFixture {
  id: string
  kind: 'bank-geometry'
  title: string
  incidentClasses: Array<IncidentClass | string>
  note: string
  /** Positioned words, one entry per PAGE — the test feeds them through the REAL `reconstructPage`
   *  (year/column resolution included) and then the bank extractors, the full geometry pipeline. */
  pages: GeometryWord[][]
}

const gw = (str: string, x: number, y: number): GeometryWord => ({ str, x, y, w: 8 })

/**
 * Swiss dot-decimal statement (R7, skills-audit-2026-07-03 SKA-13): small `d.dd` amounts (`5.04`,
 * `1.12`) are BOTH date-shaped and money-shaped. The geometry classifier tried date first, dropped them
 * as out-of-column dates, and the reconstructed rows carried only the running BALANCE — balance-as-amount
 * on exactly the path built to prevent it. Correct read: 4 rows with the dot-decimal AMOUNTS (5.04, 1.12,
 * 20.00, 3.50) and their balances; the in-band `7.02` stays a booking DATE (2026-02-07); opening 1,204.40
 * + Σ = closing 1,234.06 ties (proves no row lost its amount).
 */
const geometryDotDecimal: GeometryBankFixture = {
  id: 'bank-ch-geometry-dot-decimal',
  kind: 'bank-geometry',
  title: 'Bank Zuerich — Kontoauszug (CH, dot-decimal geometry)',
  incidentClasses: ['dot-decimal-geometry'],
  note: 'CH geometry statement: d.dd amounts out of the Datum band are MONEY, not dates; an in-band d.dd stays the booking date.',
  pages: [
    [
      // Header band (top quarter): the page year + the statement currency declaration.
      gw('Bank Zuerich Kontoauszug Februar 2026', 40, 800),
      gw('Alle Betraege in CHF', 40, 780),
      // Opening balance (raw non-transaction row; read by the balance gate).
      gw('Anfangssaldo', 40, 760),
      gw('1,204.40', 380, 760),
      gw('CHF', 430, 760),
      // Booking rows: Datum column x=40, description x=100/160, amount x=300, running balance x=380.
      gw('01.02.', 40, 700),
      gw('Gutschrift', 100, 700),
      gw('Zins', 160, 700),
      gw('5.04', 300, 700),
      gw('1,209.44', 380, 700),
      gw('03.02.', 40, 680),
      gw('Gutschrift', 100, 680),
      gw('Rueckverguetung', 160, 680),
      gw('1.12', 300, 680),
      gw('1,210.56', 380, 680),
      gw('05.02.', 40, 660),
      gw('Gutschrift', 100, 660),
      gw('Erstattung', 160, 660),
      gw('20.00', 300, 660),
      gw('1,230.56', 380, 660),
      // An IN-band yearless d.dd booking date (no trailing dot) — must STAY a date under the SKA-13 gate.
      gw('7.02', 40, 640),
      gw('Gutschrift', 100, 640),
      gw('Bonus', 160, 640),
      gw('3.50', 300, 640),
      gw('1,234.06', 380, 640)
    ],
    // Page 2 prints NO year header (exercises the document-level year fallback carry) and a WRAPPED
    // payee continuation whose annotation carries a dotless d.dd (`13.02`) — the continuation must still
    // absorb (legacy classing: the annotation date is dropped, the text glues onto the row above).
    [
      gw('12.02.', 40, 700),
      gw('Gutschrift', 100, 700),
      gw('Ausgleich', 160, 700),
      gw('10.00', 300, 700),
      gw('1,244.06', 380, 700),
      gw('Wert:', 100, 685),
      gw('13.02', 160, 685),
      // Closing balance.
      gw('Schlusssaldo', 40, 600),
      gw('1,244.06', 380, 600),
      gw('CHF', 430, 600)
    ]
  ]
}

/** Every bank fixture, in stable order. */
export const BANK_FIXTURES: BankFixture[] = [bankElba, bankSparkasse, bankDdmmyy]

/** Every invoice fixture, in stable order. */
export const INVOICE_FIXTURES: InvoiceFixture[] = [invoiceSteuer, invoiceSwiss, invoicePhantom, invoiceMoneyHeaders]

/** Every geometry fixture, in stable order (snapshot-keyed on the BANK extractor version — the bump
 *  policy explicitly covers `pdf-layout.ts` reconstruction changes). */
export const GEOMETRY_BANK_FIXTURES: GeometryBankFixture[] = [geometryDotDecimal]

/** The whole plain-text corpus, bank then invoice, stable order (the snapshot + coverage iterate this;
 *  the geometry fixtures ride beside it — the coverage test unions their incident classes too). */
export const ALL_FIXTURES: Fixture[] = [...BANK_FIXTURES, ...INVOICE_FIXTURES]
