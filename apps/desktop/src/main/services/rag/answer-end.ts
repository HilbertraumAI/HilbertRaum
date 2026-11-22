// #996 B (follow-ups wave 7): does a model answer END mid-sentence?
//
// `continueUntilComplete` (whole-doc-tree.ts) asks this after a reply was cut at its output ceiling and a
// continuation pass then finished with a clean 'stop'. The finish reason alone said "complete", and one
// stored 4B Contract Brief ended "… unless the lease provides otherwise or" with no cut stamp. A true here
// gives that answer the stamp of the pass that was cut (rag-design.md §14.10).
//
// Only the last line is judged, against the answer's OWN style: a last line that ends in a word reads as cut
// only when most of the answer's earlier long lines end with a terminator, so a list, a signature, a URL or a
// date in an answer written without full stops stays complete. A last character that leaves the sentence open
// ("," ":" "(" …) is cut whatever the style. Citation markers are set aside first: "… otherwise or [S1]" is
// judged by "… otherwise or". Evaluated over 413 stored real answers (follow-ups waves 4–6, research lane G of
// wave 7), the rule flagged 4, each genuinely cut, and no complete answer.

/** An emoji at the very end: a pictograph or a keycap (a digit, U+FE0F, U+20E3), with skin-tone modifiers,
 *  variation selectors and zero-width-joiner sequences. */
const EMOJI_END = String.raw`(?:\p{Extended_Pictographic}|[0-9#*]\uFE0F?\u20E3)(?:\p{Emoji_Modifier}|\uFE0F|\u20E3|\u200D\p{Extended_Pictographic})*`
/** A sentence terminator (Latin, CJK, Arabic, Devanagari, the Greek question mark U+037E), or an emoji. */
const TERMINAL = new RegExp(String.raw`(?:[.!?…。！？؟।॥\u037E]|${EMOJI_END})$`, 'u')
/** Whitespace, closing brackets and quotes (German »…« and ‹…› close with « and ‹), and emphasis marks. */
const TRAILING_CLOSERS = /[\s)\]»«”“"'’‘›‹*_`]+$/u
/** One citation marker: "[S1]", "[S1, S2]", "[S1,2]", "[S1-S3]", "[S1; S2]". */
const MARKER = String.raw`\[S\d+(?:\s*[-–,;]\s*S?\d+)*\]`
/** What may stand between two markers: spaces, commas, semicolons, or "and" in the interface languages. */
const MARKER_JOIN = String.raw`(?:[\s,;]*|\s+(?:and|und|et|y|e|en|i|и|ve|та|oraz)\s+)`
/** A run of citation markers at the end of a line, with what joins them and what trails them. */
const MARKERS = new RegExp(String.raw`\s*${MARKER}(?:${MARKER_JOIN}${MARKER})*[\s,;]*$`, 'u')
/** A last character that leaves the sentence open. */
const MID = /[,;:\-–—(/&]$/u
/** A last character that is part of a word: a letter (with its combining marks) or a digit. */
const WORD_END = /[\p{L}\p{M}\p{N}]$/u
/** A line (its citation markers set aside) that ends by closing a bracket or a quotation after text, then
 *  optional bold marks; a guillemet may stand after a space, as in French « … ». */
const CLOSED_BRACKET_OR_QUOTE = /\S(?:[)\]”“"’‘]|\s?[»«›‹])\**\s*$/u
/** A last line shorter than this many words is complete (a name, a date, a short phrase) … */
const MIN_LAST_WORDS = 4
/** … and a last list item or "Label: value" line shorter than this many ("- Tenant: Okonkwo Design Studio"). */
const MIN_ITEM_WORDS = 12
/** A list item: "- ", "* ", "+ ", "• ", "1. " or "1) ". */
const LIST_RE = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/
/** A "Label: value" line, the label up to 40 characters and optionally bold ("**Tenant:** …", "Tenant**:** …"). */
const LABEL_RE = /^\s*(?:[-*+•]\s+)?\**[^:|*]{1,40}(?:\**:|:\**)\s+\S/
/** The answer's style: its earlier lines of at least this many words … */
const MIN_STYLE_WORDS = 8
/** … of which there must be at least this many … */
const MIN_STYLE_LINES = 4
/** … and at least this share must end with a terminator, for a last line ending in a word to read as cut. */
const MIN_TERMINATED_SHARE = 0.7

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length
const isItem = (line: string): boolean => LIST_RE.test(line) || LABEL_RE.test(line)
/** A table row, a heading, a bold-only line or a rule: structure, which never takes a terminator. */
const isStructure = (t: string): boolean =>
  t.startsWith('|') ||
  t.endsWith('|') ||
  /^#{1,6}\s/.test(t) ||
  /^\*\*[^*]+\*\*:?$/.test(t) ||
  /^(?:-{3,}|\*{3,}|_{3,})$/.test(t)

/** The answer's style: its earlier lines of at least `MIN_STYLE_WORDS` words (prose, list items, labels), each
 *  without its closers, leaving out code blocks and structure. */
function styleLines(earlier: string[]): string[] {
  const out: string[] = []
  let inFence = false
  for (const raw of earlier) {
    const l = raw.trim()
    if (/^(```|~~~)/.test(l)) {
      inFence = !inFence
      continue
    }
    if (inFence || isStructure(l)) continue
    const c = core(l)
    if (words(c) >= MIN_STYLE_WORDS) out.push(c)
  }
  return out
}

/** A line without its quote marker, trailing citation markers, closers and emphasis. */
function core(line: string): string {
  let s = line.trim().replace(/^>\s*/, '')
  for (let i = 0; i < 3; i++) s = s.replace(MARKERS, '').replace(TRAILING_CLOSERS, '')
  return s
}

/** The line ends with a closed inline code span ("Run the command `npm ci`"): an even number of backticks and
 *  a backtick last, before any emphasis marks. */
function endsInCodeSpan(line: string): boolean {
  return /`[*_]*$/.test(line) && (line.match(/`/g) ?? []).length % 2 === 0
}

/** Most of the line's letters are Greek, where ";" is the question mark. */
function isMostlyGreek(line: string): boolean {
  const letters = (line.match(/\p{L}/gu) ?? []).length
  const greek = (line.match(/\p{Script=Greek}/gu) ?? []).length
  return letters > 0 && greek / letters > 0.5
}

/**
 * True when `text` (an answer as it is stored) ends mid-sentence. Only the last non-empty line is judged:
 *  - inside an open code fence, a table row, a heading, a bold-only line or a rule: complete;
 *  - with its trailing citation markers set aside (a run, joined by spaces, commas, semicolons or "and"), a line
 *    that closes a bracket or a quotation, ends in a closed inline code span, or is a label whose value was the
 *    markers ("Sources: [S1], [S2]"): complete;
 *  - otherwise, after stripping trailing markers, emphasis and closers: a terminator (`. ! ? … 。 ！ ？ ؟ । ॥`,
 *    the Greek question mark, or `;` on a mostly Greek line) or an emoji is complete; a trailing
 *    `, ; : - – — ( / &` is mid; any other last character but a letter or a digit (a symbol: `%`, `€`) is complete;
 *  - a last line of 4 words or more (a list item or "Label: value" line: 12) that ends in a letter or a digit is
 *    mid only in the answer's own terminated style: at least 4 earlier lines of 8 words or more (not table rows,
 *    headings or code), of which at least 70 % end with a terminator. An answer written without full stops (a
 *    list) or with too little text before its last line is complete; so is a shorter last line.
 */
export function endsMidSentence(text: string): boolean {
  const fences = (text.match(/^\s*(```|~~~)/gm) ?? []).length
  if (fences % 2 === 1) return false
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return false
  const t = lines[lines.length - 1]!.trim()
  if (isStructure(t)) return false
  // Set citation markers aside first, so a marker's own "]" never reads as a closing bracket.
  const unmarked = t.replace(MARKERS, '')
  if (unmarked.length < t.length && /:\**$/.test(unmarked)) return false
  if (CLOSED_BRACKET_OR_QUOTE.test(unmarked)) return false
  if (endsInCodeSpan(unmarked)) return false
  const c = core(t)
  if (c.length === 0) return false
  if (TERMINAL.test(c)) return false
  if (c.endsWith(';') && isMostlyGreek(c)) return false
  if (MID.test(c)) return true
  if (!WORD_END.test(c)) return false
  if (words(c) < (isItem(t) ? MIN_ITEM_WORDS : MIN_LAST_WORDS)) return false
  const style = styleLines(lines.slice(0, -1))
  const terminated = style.filter((l) => TERMINAL.test(l)).length
  return style.length >= MIN_STYLE_LINES && terminated / style.length >= MIN_TERMINATED_SHARE
}
