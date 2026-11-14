// Shared FTS5 query sanitization: conversation search and hybrid retrieval use the
// SAME sanitizer — one set of rules for what user text can reach a MATCH expression.

import { DOTLESS_I, lowerCaseNfc } from '../../shared/text-fold'

/** Most input tokens forwarded into an FTS MATCH query (bounds query cost). */
const MAX_QUERY_TOKENS = 32

/** Most dotless ı a word may hold and still be spelled both ways: 4 gives 2^4 = 16 spellings. */
const MAX_DOTLESS_I_EXPANDED = 4

/**
 * The other spellings of `token` with each dotless ı either kept or written as "i", in a fixed
 * order (bit k of the counter turns the k-th ı into "i"): «ısı» gives «isı», «ısi», «isi». None for a
 * token with no ı, or with more than `MAX_DOTLESS_I_EXPANDED` of them (it stays as typed).
 */
function dotlessIVariants(token: string): string[] {
  const letters = [...token]
  const positions = letters.flatMap((letter, index) => (letter === DOTLESS_I ? [index] : []))
  if (positions.length === 0 || positions.length > MAX_DOTLESS_I_EXPANDED) return []
  const variants: string[] = []
  for (let mask = 1; mask < 1 << positions.length; mask++) {
    const spelled = [...letters]
    positions.forEach((position, bit) => {
      if (mask & (1 << bit)) spelled[position] = 'i'
    })
    variants.push(spelled.join(''))
  }
  return variants
}

/**
 * Sanitize natural-language text into an FTS5 MATCH query: extract word tokens,
 * quote each as a phrase, OR them together. FTS5 operator syntax in user text
 * (`"` `-` `NEAR` `*` parentheses) can never reach MATCH raw. Returns null when the
 * text yields no tokens (→ the search is skipped).
 *
 * The text is lowered with the shared `lowerCaseNfc` (open-issues wave owner call G-8, #818): NFC
 * first, so a word typed with separate accent marks is one token and not cut at each mark, and a
 * capital dotted İ lowers to a plain "i" (plain `toLowerCase()` leaves "i" + U+0307, and the mark
 * split «İstanbul» into "i" and "stanbul"). The index's default `unicode61` tokenizer stores I and İ
 * as "i" but keeps the dotless ı, so «Isı» is stored as `isı` and «ISI» as `isi`: a word holding ı is
 * also spelled with each ı as "i" (2^n spellings; a word with more than four ı stays as typed). The
 * typed words come first and the extra spellings after them, at most `MAX_QUERY_TOKENS` phrases in
 * all. ı is never folded away, so a typed «ısı» still finds a stored «ısı»; a typed «isi» does not
 * find it (no spelling adds an ı). A question that is already composed (NFC) and holds no ı, no İ
 * and no U+0307 gives the same MATCH string as before #818.
 */
export function buildFtsMatchQuery(question: string): string | null {
  const tokens = lowerCaseNfc(question).match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length === 0) return null
  const phrases = tokens.slice(0, MAX_QUERY_TOKENS)
  const seen = new Set(phrases)
  for (const token of tokens) {
    if (phrases.length >= MAX_QUERY_TOKENS) break
    for (const variant of dotlessIVariants(token)) {
      if (phrases.length >= MAX_QUERY_TOKENS) break
      if (seen.has(variant)) continue
      seen.add(variant)
      phrases.push(variant)
    }
  }
  return phrases.map((t) => `"${t}"`).join(' OR ')
}
