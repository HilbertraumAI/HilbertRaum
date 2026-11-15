// Shared FTS5 query sanitization: conversation search and hybrid retrieval use the
// SAME sanitizer — one set of rules for what user text can reach a MATCH expression.

import { DOTLESS_I, lowerCaseNfc } from '../../shared/text-fold'

/** Most input tokens forwarded into an FTS MATCH query (bounds query cost). */
const MAX_QUERY_TOKENS = 32

/**
 * The other spellings under which the index can hold `token` when it holds the dotless ı. Stored
 * text takes three shapes, and unicode61 lowers I to "i" but keeps ı: as typed («ısı»), with a
 * capital first letter («Isı», stored `isı`) and in capitals («ISI», stored `isi`). So, in that
 * order: the first ı as "i" when the token starts with ı and holds another (capital first letter),
 * then every ı as "i" (capitals). A token whose only ı is its first letter gets one spelling (the
 * two coincide); a token with no ı gets none. Open-issues wave owner call of 2026-11-14 (#818).
 */
function dotlessISpellings(token: string): string[] {
  if (!token.includes(DOTLESS_I)) return []
  const capitals = token.replaceAll(DOTLESS_I, 'i')
  const capitalFirst = token.startsWith(DOTLESS_I) ? 'i' + token.slice(DOTLESS_I.length) : capitals
  return capitalFirst === capitals ? [capitals] : [capitalFirst, capitals]
}

/**
 * Sanitize natural-language text into an FTS5 MATCH query: extract word tokens,
 * quote each as a phrase, OR them together. FTS5 operator syntax in user text
 * (`"` `-` `NEAR` `*` parentheses) can never reach MATCH raw. Returns null when the
 * text yields no tokens (→ the search is skipped).
 *
 * The text is lowered with the shared `lowerCaseNfc` (open-issues wave owner call G-8, #818): NFC
 * first, so a letter typed with a separate accent mark becomes its one-code-point form, and a
 * capital dotted İ lowers to a plain "i" (plain `toLowerCase()` leaves "i" + U+0307, and the mark
 * split «İstanbul» into "i" and "stanbul"). A word starts with a letter or digit and keeps the marks
 * inside it (owner call of 2026-11-14): a mark with no one-code-point form, such as the Russian
 * stress mark on the е of «привет» (е + U+0301), stays in the phrase, and unicode61 drops it as it
 * does in the stored text, so the word is not cut at the mark; a mark at the start of a word is
 * dropped, so no phrase is only a mark. The index's default `unicode61` tokenizer stores I and İ
 * as "i" but keeps the dotless ı, so a word holding ı also gets its stored spellings
 * (`dotlessISpellings`). The typed words come first and the extra spellings after them, word by
 * word and never repeated, at most `MAX_QUERY_TOKENS` phrases in all. ı is never folded away, so a
 * typed «ısı» still finds a stored «ısı»; a typed «isi» does not find it (no spelling adds an ı).
 * A question that is already composed (NFC) and holds no ı, no İ and no combining mark gives the
 * same MATCH string as before #818.
 */
export function buildFtsMatchQuery(question: string): string | null {
  const tokens = lowerCaseNfc(question).match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []
  if (tokens.length === 0) return null
  const phrases = tokens.slice(0, MAX_QUERY_TOKENS)
  const seen = new Set(phrases)
  for (const token of tokens) {
    if (phrases.length >= MAX_QUERY_TOKENS) break
    for (const spelling of dotlessISpellings(token)) {
      if (phrases.length >= MAX_QUERY_TOKENS) break
      if (seen.has(spelling)) continue
      seen.add(spelling)
      phrases.push(spelling)
    }
  }
  return phrases.map((t) => `"${t}"`).join(' OR ')
}
