import { t, UI_LANGUAGE_CODES, type MessageKey } from '../../../shared/i18n'
import { lowerCaseNfc } from '../../../shared/text-fold'

// #809 (open-issues wave owner call G-11): the document-mode example chips (`ChatScreen.tsx`) fill the composer
// with a catalog question in the interface language, while the router's and the skill classifier's words are
// English and German. So the two chips the router serves are recognised in every registered catalog (i18n record
// §3.3 rule 3, like the bank skill's routed questions): read at run time, never copied, composed, lowered and
// trimmed on both sides, and without the sentence end either side may close with (`chipText`). The summarize
// chip, by its whole text, is a summary ask. The every-mention chip is recognised by its FRAME, the text around
// its quoted example word, whatever stands in the quotes ("Busca cada mención de «fianza»"), and gets the
// labelled answer the English and German chips get by their own words (router step 4b); a catalog value with no
// quoted segment is recognised by its whole text.
// #834 (follow-ups wave 4): the same frame keeps the every-mention chip off the single-fact path of a
// whole-document skill (`isNeedleShaped`), so it is one class in every language. Shared here by the router
// (`analysis/router.ts`) and the classifier (`skills/vocabulary.ts`); pure, no DB, no model.

// The sentence ends stripped from the end of a chip and of a question: the catalogs close their sentences with
// ".", "…" and "?", and a user may add "!" ("Resume este documento.", "Résumez ce document !").
const SENTENCE_END = '.!?…'

/** `text` composed, lowered and trimmed, without the sentence end (and the spaces) it closes with. */
function chipText(text: string): string {
  const lowered = lowerCaseNfc(text).trim()
  let end = lowered.length
  while (end > 0 && (SENTENCE_END.includes(lowered[end - 1]!) || /\s/u.test(lowered[end - 1]!))) end--
  return lowered.slice(0, end)
}

const catalogValues = (key: MessageKey): string[] => UI_LANGUAGE_CODES.map((code) => chipText(t(code, key)))
const SUMMARIZE_CHIPS = new Set(catalogValues('chat.example.summarize'))
// An opening quote and the quotes that close it: ' ', „ “ (German) or „ ” (Polish), « », “ ”.
const CLOSING_QUOTES: Readonly<Record<string, string>> = { "'": "'", '„': '“”', '«': '»', '“': '”' }

/** A catalog value's text up to and including its opening quote and from its closing quote on, or null when
 *  it quotes nothing. An apostrophe inside a word ("tenant's") opens no quote, and an opening quote that no
 *  quote closes gives way to the next one. */
function quoteFrame(value: string): { before: string; after: string } | null {
  for (let i = 0; i < value.length; i++) {
    const closers = CLOSING_QUOTES[value[i]!]
    if (closers === undefined || /\p{L}/u.test(value[i - 1] ?? '')) continue
    for (let j = i + 1; j < value.length; j++) {
      if (closers.includes(value[j]!)) return { before: value.slice(0, i + 1), after: value.slice(j) }
    }
  }
  return null
}

const MENTION_CHIPS = catalogValues('chat.example.indemnity').map((value) => quoteFrame(value) ?? value)

/** Is the question one of the catalogs' summarize chips? */
export function isSummarizeChip(question: string): boolean {
  return SUMMARIZE_CHIPS.has(chipText(question))
}

/** Is the question one of the catalogs' every-mention chips, with any text in its quotes? */
export function isMentionChip(question: string): boolean {
  const q = chipText(question)
  return MENTION_CHIPS.some((chip) => {
    if (typeof chip === 'string') return q === chip
    const inQuotes = q.slice(chip.before.length, q.length - chip.after.length)
    return q.startsWith(chip.before) && q.endsWith(chip.after) && inQuotes.trim() !== ''
  })
}
