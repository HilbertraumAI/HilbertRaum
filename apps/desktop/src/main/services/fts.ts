// Shared FTS5 query sanitization: conversation search and hybrid retrieval use the
// SAME sanitizer — one set of rules for what user text can reach a MATCH expression.

/** Most input tokens forwarded into an FTS MATCH query (bounds query cost). */
const MAX_QUERY_TOKENS = 32

/**
 * Sanitize natural-language text into an FTS5 MATCH query: extract word tokens,
 * quote each as a phrase, OR them together. FTS5 operator syntax in user text
 * (`"` `-` `NEAR` `*` parentheses) can never reach MATCH raw. Returns null when the
 * text yields no tokens (→ the search is skipped).
 */
export function buildFtsMatchQuery(question: string): string | null {
  const tokens = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length === 0) return null
  return tokens
    .slice(0, MAX_QUERY_TOKENS)
    .map((t) => `"${t}"`)
    .join(' OR ')
}
