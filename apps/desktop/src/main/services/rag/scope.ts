// Filename auto-scope (post-MVP UX fix): when a documents-mode question names an
// indexed file by its filename and the conversation has NO explicit "ask selected
// documents" scope, restrict retrieval to the named file(s) so other documents are not
// surfaced as sources.
//
// Why this exists: document retrieval is corpus-wide by default — the question text is
// only ever a semantic/keyword query, so "analyze contract.pdf" runs hybrid search over
// ALL indexed documents and the top-K can include weakly-related chunks from other files
// (generic words like "analyze"/"summary" even inflate other docs' keyword rank). Users
// reasonably expect naming a file to focus on it. This is a CONSERVATIVE heuristic: it
// only ever narrows (never widens) and only when no explicit scope is set; a wrong guess
// is visible (the toast + the cited file) and the user can rephrase or set scope manually.

/** Minimum normalized length for a filename form to be matchable (avoids 1–2 char noise). */
const MIN_FORM_LEN = 3

/**
 * Single generic words that must NOT, on their own, trigger a scope — a file literally
 * named "Document.pdf" should not capture every "analyze this document" question. Only
 * filters forms that EQUAL one of these; a multi-word form that merely contains one
 * (e.g. "annual report") is unaffected.
 */
const GENERIC_FORMS = new Set([
  'document',
  'documents',
  'file',
  'files',
  'doc',
  'docs',
  'pdf',
  'text',
  'note',
  'notes',
  'page',
  'pages',
  'data'
])

export interface ScopeableDoc {
  id: string
  title: string
}

export interface DetectedScope {
  ids: string[]
  titles: string[]
}

/** Lowercase, collapse every non-alphanumeric run to a single space, trim. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Drop a trailing file extension (".pdf", ".docx", …) so the bare name also matches. */
function stem(title: string): string {
  return title.replace(/\.[a-z0-9]{1,8}$/i, '')
}

/**
 * Detect which indexed documents a question names by filename. Returns the matched
 * documents (ids + titles) or null when none match confidently.
 *
 * A document matches when one of its filename forms — the full title or its
 * extension-stripped stem, each normalized — appears in the normalized question as a
 * whole token sequence (space-delimited on both sides). Single generic words are ignored
 * (see GENERIC_FORMS). When the question would match EVERY indexed document it provides no
 * narrowing, so it is treated as no match (a non-specific query, not a file reference).
 */
export function detectFilenameScope(
  question: string,
  docs: ScopeableDoc[]
): DetectedScope | null {
  // Pad so an includes() check is a token-boundary match on both sides.
  const haystack = ` ${normalize(question)} `
  if (haystack.trim() === '' || docs.length === 0) return null

  const matched: ScopeableDoc[] = []
  for (const doc of docs) {
    const forms = new Set<string>()
    for (const raw of [doc.title, stem(doc.title)]) {
      const n = normalize(raw)
      if (n.length >= MIN_FORM_LEN && !GENERIC_FORMS.has(n)) forms.add(n)
    }
    if ([...forms].some((f) => haystack.includes(` ${f} `))) matched.push(doc)
  }

  if (matched.length === 0) return null
  // Matching the whole corpus is not a file reference — it narrows nothing.
  if (matched.length === docs.length && docs.length > 1) return null

  return { ids: matched.map((m) => m.id), titles: matched.map((m) => m.title) }
}
