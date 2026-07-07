import type { LocatedEntity } from '../../../src/main/services/skills/tools/redaction-locate'
import type { LocatedEdit } from '../../../src/main/services/skills/tools/document-edit-locate'

// Gold-set locate-pass fixtures for redaction + targeted edits (beta-feedback-2026-07 Phase 10 close-out;
// architecture.md "Skills — design record" §21/§22, plan §13). These are SYNTHETIC, lawyer-shaped German
// documents (a Vollmacht / power of attorney, a Mandantenbrief / client letter) — NEVER real user data,
// same rule as `tests/fixtures/real-layouts/corpus.ts`. Each case carries the exact model locate reply a
// scripted (mock) runtime replays, so the whole verify+sweep / verify+splice pipeline runs DETERMINISTICALLY
// in CI with no model. The REAL-model pass over these same documents is a PAID_* manual harness
// (model-benchmarks.md §12) — this corpus is the offline stand-in that pins the pipeline's structural
// guarantees (verbatim verify, every-occurrence sweep, occurrence precision, drop-unverifiable, and the
// Phase-9 same-format DOCX round-trip), never the model's judgement quality.
//
// PRIVACY: the strings below are invented. The pipeline treats detected values as CONTENT (never logged),
// which the privacy-guard suite proves separately; here we only assert the transform's coverage + counts.

/** One redaction gold case: a document, the model's proposed entities, and the expected outcome. The
 *  document text (and the DOCX `<w:t>` layer, via `makeDocx`) is `paragraphs.join('\n')`. */
export interface RedactionGoldCase {
  id: string
  title: string
  /** The user's scope directive that rides into the locate prompt (D73 steerability). */
  instruction: string
  paragraphs: string[]
  /** What a (scripted or real) model PROPOSES for the locate pass — includes at least one entry that must
   *  be dropped (not present verbatim), to exercise the D75 drop-unverifiable path. */
  located: LocatedEntity[]
  /** Strings that MUST be absent from the redacted output (verified entity spans + the regex floor). */
  mustMask: string[]
  /** Strings that MUST survive verbatim (kept scope — e.g. a city — or never proposed). */
  mustKeep: string[]
  /** Deterministic regex-floor matches (email/url/iban/card/date/phone) over this document. */
  expectedFloor: number
  /** Confirmed located-entity OCCURRENCES masked (≥ distinct confirmed entities when a name repeats). */
  expectedEntityOccurrences: number
  /** Proposals dropped as unverifiable (not present verbatim / too short). */
  expectedDropped: number
}

/** One targeted-edit gold case: a document, the model's proposed occurrence-anchored edits, and the exact
 *  edited text (byte-identical outside the edited spans, D58). */
export interface EditGoldCase {
  id: string
  title: string
  instruction: string
  paragraphs: string[]
  edits: LocatedEdit[]
  /** The full edited text layer (`paragraphs.join('\n') + '\n'` — the DOCX layer's trailing newline). */
  expectedText: string
  expectedApplied: number
  expectedDropped: number
}

// ---- Redaction gold cases ----

export const REDACTION_GOLD: RedactionGoldCase[] = [
  {
    id: 'vollmacht',
    title: 'Vollmacht — names + address + IBAN/email/phone/date, keep the city',
    instruction: 'Personal names and street addresses; keep city names.',
    paragraphs: [
      'VOLLMACHT',
      'Die Vollmachtgeberin Dr. Maria Huber, wohnhaft Ringstraße 12, 1010 Wien,',
      'bevollmächtigt hiermit Herrn Johann Berger, alle Rechtsgeschäfte zu führen.',
      'Kontoverbindung: IBAN AT61 1904 3002 3457 3201.',
      'Kontakt: maria.huber@example.at, Telefon +43 660 1234567.',
      'Wien, am 2026-03-15. Dr. Maria Huber'
    ],
    located: [
      { text: 'Maria Huber', category: 'name', line: 2 }, // appears twice → sweep masks both (D75)
      { text: 'Johann Berger', category: 'name', line: 3 },
      { text: 'Ringstraße 12', category: 'address', line: 2 },
      { text: 'Stefan Wolf', category: 'name', line: 2 } // NOT in the document → dropped (D75)
    ],
    mustMask: [
      'Maria Huber',
      'Johann Berger',
      'Ringstraße 12',
      'AT61 1904 3002 3457 3201',
      'maria.huber@example.at',
      '2026-03-15'
    ],
    mustKeep: ['Wien', 'VOLLMACHT', 'bevollmächtigt'], // the city stays (steered scope)
    expectedFloor: 4, // email + IBAN + phone + date
    expectedEntityOccurrences: 4, // Maria Huber ×2 + Johann Berger ×1 + Ringstraße 12 ×1
    expectedDropped: 1 // Stefan Wolf
  },
  {
    id: 'mandantenbrief',
    title: 'Client letter — names + address + IBAN/email/phone; a mis-cased proposal is dropped',
    instruction: 'Personal names and street addresses.',
    paragraphs: [
      'Sehr geehrte Frau Bauer,',
      'in der Sache Klein ./. Gruber übersende ich Ihnen die Unterlagen.',
      'Meine Mandantin Frau Elisabeth Klein, Hauptstraße 5, 4020 Linz.',
      'Rückfragen an kanzlei@example.at oder unter +43 732 987654.',
      'Honorar bitte auf IBAN AT48 3200 0000 1234 5678 überweisen.',
      'Mit freundlichen Grüßen, Dr. Franz Gruber'
    ],
    located: [
      { text: 'Elisabeth Klein', category: 'name', line: 3 },
      { text: 'Hauptstraße 5', category: 'address', line: 3 },
      { text: 'Franz Gruber', category: 'name', line: 6 },
      { text: 'elisabeth Klein', category: 'name', line: 3 } // wrong case ⇒ not verbatim ⇒ dropped (D75)
    ],
    mustMask: [
      'Elisabeth Klein',
      'Hauptstraße 5',
      'kanzlei@example.at',
      '+43 732 987654',
      'AT48 3200 0000 1234 5678'
    ],
    mustKeep: ['Bauer', 'Linz', 'Unterlagen'], // Frau Bauer not proposed; the city stays
    expectedFloor: 3, // email + phone + IBAN
    expectedEntityOccurrences: 3, // Elisabeth Klein + Hauptstraße 5 + Franz Gruber
    expectedDropped: 1 // 'elisabeth Klein' (case drift)
  }
]

// ---- Targeted-edit gold cases ----

export const EDIT_GOLD: EditGoldCase[] = [
  {
    id: 'vollmacht-agreement',
    title: 'Vollmachtgeber → Vollmachtgeberin (incl. the article), but not the defined-term line',
    instruction:
      'Ändere Vollmachtgeber zu Vollmachtgeberin und den Artikel entsprechend, außer in der Begriffsdefinition.',
    paragraphs: [
      'Der Vollmachtgeber erteilt dem Bevollmächtigten Vollmacht.',
      'Der Vollmachtgeber kann diese Vollmacht jederzeit widerrufen.',
      'Begriff: Vollmachtgeber ist die vollmachterteilende Person.'
    ],
    edits: [
      { line: 1, find: 'Der Vollmachtgeber', occurrence: 1, replace: 'Die Vollmachtgeberin' },
      { line: 2, find: 'Der Vollmachtgeber', occurrence: 1, replace: 'Die Vollmachtgeberin' },
      { line: 1, find: 'Vollmachtnehmer', occurrence: 1, replace: 'X' } // absent ⇒ dropped (D75)
    ],
    // Line 3's "Vollmachtgeber" is untouched — occurrence anchoring, not a sweep (D76 precision).
    expectedText:
      'Die Vollmachtgeberin erteilt dem Bevollmächtigten Vollmacht.\n' +
      'Die Vollmachtgeberin kann diese Vollmacht jederzeit widerrufen.\n' +
      'Begriff: Vollmachtgeber ist die vollmachterteilende Person.\n',
    expectedApplied: 2,
    expectedDropped: 1
  }
]
