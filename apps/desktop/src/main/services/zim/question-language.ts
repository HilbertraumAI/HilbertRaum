/**
 * A small, offline, dependency-free guess at whether a question is written in German or
 * English — the gate for {@link import('./expand').buildPlanMessages}'s conditional
 * archive-language phrase (see that file's header and `docs/rag-design.md` §17 D-Z24, #486).
 * It is NOT a general-purpose language classifier and is never shown to a user: it exists to
 * decide, for exactly one prompt phrase, whether the question's own language plausibly
 * differs from a knowledge pack's declared one.
 *
 * Provenance: measured offline on a 200-question German/English development bank — 200 of 200
 * agreements with the bank's own language labels. That bank is small, AI-authored and cleanly
 * worded; real user questions are messier (short, mixed-language, code-switched, or lacking
 * any of the counted words), and this detector is expected to do worse on them. A question it
 * cannot read confidently resolves to `null`, which leaves the prompt exactly as it always was
 * — the safe, silent default, never a guess passed on to the model.
 *
 * Method: NFC-normalise, lower-case, split on runs of non-letters, and count how many tokens
 * fall in each of two frozen, disjoint word lists (common German vs. common English function
 * words). The language with the higher count wins; on a tie, a German umlaut/ß anywhere in the
 * question breaks it toward German; otherwise the question is unresolved. The two lists share
 * no word, and five words that are common to both languages in this frame ("in", "an", "am",
 * "so", "also") are deliberately in neither list, so they never count as evidence either way.
 *
 * Deliberate asymmetry: a handful of German words that also look like English words in
 * isolation ("die", "war", "hat", "man", "was") are kept in the German list only. Misreading a
 * German question as English would fire the substitution where it must never fire (the packs'
 * own language is assumed German in the product's shipped configuration, so a wrongly-detected
 * "English" German question could change a prompt that has to stay untouched); misreading an
 * English question as German only misses a chance to fire it, which costs nothing beyond the
 * gain the mechanism would otherwise have bought. The detector is biased toward the
 * recoverable mistake.
 *
 * Second caller (#1003, follow-ups wave 7, `docs/rag-design.md` §20): the cross-language passage
 * search (`rag/cross-language.ts`) reads the question with this function and each top fused passage
 * with `detectPassageLanguage` below (the same count, no umlaut tie-break). It translates the
 * question only when the question reads as German, no passage as German and a strict majority of
 * the passages as English (a passage it cannot read does not block, but it is not English, so it
 * counts against that majority). On chunk text the count read all 16 documents of the bilingual
 * eval corpus and all 19 chunks of a long English lease correctly. The question-side bias is the
 * safe one there: a question it cannot read keeps today's search. It costs one thing the other
 * way: an English question with a German-looking word ("Who was Hans Müller?": "was" counts as
 * German, the umlaut breaks the tie) reads as German and pays one translation call; when the
 * model hands it back unchanged, the search stays as it was.
 */

/** Common German function words the detector counts. Frozen; never re-tuned. */
export const GERMAN_STOP_WORDS: ReadonlySet<string> = new Set([
  'der', 'die', 'das', 'dem', 'den', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'und', 'oder', 'nicht', 'ist', 'sind', 'war', 'waren', 'wird', 'werden', 'wurde', 'wurden',
  'hat', 'haben', 'hatte', 'kann', 'können', 'auch', 'noch', 'nur', 'mit', 'für', 'von', 'vom',
  'zum', 'zur', 'über', 'unter', 'zwischen', 'durch', 'gegen', 'ohne', 'wie', 'wer', 'wo',
  'wann', 'warum', 'was', 'welche', 'welcher', 'welches', 'sich', 'seine', 'ihre', 'diese',
  'dieser', 'dieses', 'viele', 'gibt', 'es', 'man', 'beim'
])

/** Common English function words the detector counts. Frozen; never re-tuned. */
export const ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'and', 'or', 'of', 'to', 'for', 'from', 'by', 'with', 'is', 'are', 'were',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'that', 'this',
  'these', 'those', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'would',
  'should', 'not', 'than', 'then', 'there', 'between', 'about', 'after', 'before', 'during',
  'many', 'much', 'most', 'into', 'on', 'at', 'as', 'be', 'been', 'it', 'its'
])

const UMLAUT_RE = /[äöüßÄÖÜ]/

/**
 * Guess whether `question` is German or English, or `null` when the detector cannot tell.
 * Pure and synchronous; the same input always returns the same output. See the module header
 * for the method, its provenance and its deliberate asymmetry.
 */
export function detectQuestionLanguage(question: string): 'de' | 'en' | null {
  const { deCount, enCount } = countStopWords(question)
  if (deCount > enCount) return 'de'
  if (enCount > deCount) return 'en'
  if (UMLAUT_RE.test(question)) return 'de'
  return null
}

/**
 * The same count for a PASSAGE (#1003 review round 2, the cross-language gate), without the umlaut
 * tie-break: German only when it holds more German than English function words, English only the
 * other way round, `null` on a tie. The tie-break suits a question; on a passage it read a German
 * address or letterhead in an English lease («Müller Bau GmbH, Königstraße 5») as German and closed
 * the gate for that lease. `detectQuestionLanguage` (the question side, and the pack planner) is
 * unchanged.
 */
export function detectPassageLanguage(passage: string): ReturnType<typeof detectQuestionLanguage> {
  const { deCount, enCount } = countStopWords(passage)
  if (deCount > enCount) return 'de'
  if (enCount > deCount) return 'en'
  return null
}

/** NFC-normalise, lower-case, split on runs of non-letters, and count each list's words (the method above). */
function countStopWords(text: string): { deCount: number; enCount: number } {
  const tokens = text.normalize('NFC').toLowerCase().split(/[^\p{L}]+/u).filter((t) => t.length > 0)
  let deCount = 0
  let enCount = 0
  for (const token of tokens) {
    if (GERMAN_STOP_WORDS.has(token)) deCount++
    if (ENGLISH_STOP_WORDS.has(token)) enCount++
  }
  return { deCount, enCount }
}
