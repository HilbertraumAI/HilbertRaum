// The case fold of the interface's text filters: the Documents name filter, the AI Model search
// and the review evidence filter (second UI-languages wave owner call G-5, 2026-11-13: one shared
// fold, so I, ı, İ and i match each other in every interface language and on every OS).
//
// Why not `toLocaleLowerCase()`: without an argument it lowers in the runtime's default locale,
// which in the renderer is Chromium's (the OS language or `--lang`), not the app's UI language. On
// a Turkish system "Invoice" lowers to "ınvoice", and a typed "inv" finds nothing. Plain
// `toLowerCase()` never reads a locale, but it keeps the Turkish letters apart: "ı" stays dotless,
// and "İ" lowers to "i" followed by U+0307 (combining dot above). The fold lowers without a
// locale, then turns both back into a plain "i". Nothing else changes (no accent stripping), so
// English and German text folds exactly as `toLowerCase()` folds it.

const DOTLESS_I = String.fromCharCode(0x0131)
const I_WITH_DOT_ABOVE = 'i' + String.fromCharCode(0x0307)

/** `text` folded for a case-insensitive substring match. Fold both sides: the query and the text. */
export function foldCase(text: string): string {
  return text.toLowerCase().replaceAll(DOTLESS_I, 'i').replaceAll(I_WITH_DOT_ABOVE, 'i')
}
