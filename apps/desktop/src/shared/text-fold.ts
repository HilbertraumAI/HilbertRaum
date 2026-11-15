// The app's one text fold, shared by the interface's text filters (the Documents name filter, the AI
// Model search, the review evidence filter) and the keyword-search query (`main/services/fts.ts`):
// second UI-languages wave owner call G-5, 2026-11-13 (one fold, so I, ı, İ and i match each other in
// every interface language and on every OS); open-issues wave owner call G-8 (#818): NFC first, and
// the search query lowers the same way.
//
// Why not `toLocaleLowerCase()`: without an argument it lowers in the runtime's default locale,
// not the app's UI language. Under a Turkish default locale "Invoice" lowers to "ınvoice", and a
// typed "inv" finds nothing (shown in Node and jsdom; `--lang=tr-TR` did not reproduce it). Plain
// `toLowerCase()` never reads a locale, but it keeps the Turkish letters apart: "ı" stays dotless,
// and "İ" lowers to "i" followed by U+0307 (combining dot above).
//
// Why NFC first: a letter can be stored as one code point or as a base letter followed by a
// combining mark (macOS stores file names decomposed: "Gro" + U+0308 + "ße.pdf"). Composing both
// sides first makes the two spellings of a letter one string, so a typed "größ" finds that file.
// NFC changes nothing in text that is already composed, which is how keyboards type and how
// English and German text arrives, so that text folds exactly as `toLowerCase()` folds it (no
// accent stripping).

/** The dotless ı (U+0131): `foldCase` turns it into "i", `lowerCaseNfc` keeps it. */
export const DOTLESS_I = String.fromCharCode(0x0131)
const I_WITH_DOT_ABOVE = 'i' + String.fromCharCode(0x0307)

/**
 * `text` composed (NFC) and lowered without a locale, with the U+0307 that `toLowerCase()` leaves
 * after a capital dotted İ dropped, so "İstanbul" lowers to "istanbul". The dotless ı stays as it
 * is: the keyword index keeps it apart from "i" (`buildFtsMatchQuery` spells it both ways instead).
 */
export function lowerCaseNfc(text: string): string {
  return text.normalize('NFC').toLowerCase().replaceAll(I_WITH_DOT_ABOVE, 'i')
}

/** `text` folded for a case-insensitive substring match: `lowerCaseNfc`, then ı as "i" too. Fold
 *  both sides: the query and the text. */
export function foldCase(text: string): string {
  return lowerCaseNfc(text).replaceAll(DOTLESS_I, 'i')
}
