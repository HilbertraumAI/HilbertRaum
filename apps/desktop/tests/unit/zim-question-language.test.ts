import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  GERMAN_STOP_WORDS,
  ENGLISH_STOP_WORDS,
  detectQuestionLanguage
} from '../../src/main/services/zim/question-language'
import { resolveArchiveLanguagePhrase } from '../../src/main/services/zim/expand'

// #486 (`docs/rag-design.md` §17 D-Z24): `detectQuestionLanguage` is a small, offline,
// dependency-free guess at a question's language, gating the conditional archive-language
// phrase in `expand.ts`'s planner prompt. It was measured offline against a 200-question
// German/English development bank (200 of 200 agreements with the bank's own labels) — not a
// general-purpose classifier, and never shown to a user. The two word lists below are frozen
// verbatim and are never re-tuned.

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('the frozen word lists', () => {
  it('the German list has 62 words, the English list has 56', () => {
    expect(GERMAN_STOP_WORDS.size).toBe(62)
    expect(ENGLISH_STOP_WORDS.size).toBe(56)
  })

  it('the two lists are disjoint', () => {
    const intersection = [...GERMAN_STOP_WORDS].filter((w) => ENGLISH_STOP_WORDS.has(w))
    expect(intersection).toEqual([])
  })

  it('five words common to both languages sit in neither list ("in", "an", "am", "so", "also")', () => {
    for (const word of ['in', 'an', 'am', 'so', 'also']) {
      expect(GERMAN_STOP_WORDS.has(word)).toBe(false)
      expect(ENGLISH_STOP_WORDS.has(word)).toBe(false)
    }
  })
})

describe('detectQuestionLanguage', () => {
  it('reads a plainly German question as "de"', () => {
    expect(detectQuestionLanguage('Welche Länder stoßen am meisten CO2 aus?')).toBe('de')
  })

  it('reads a plainly English question as "en"', () => {
    expect(detectQuestionLanguage('Which countries emit the most CO2?')).toBe('en')
  })

  it('breaks a tie toward German when the question carries an umlaut or ß', () => {
    // "Größe" alone gives zero list-word hits either way; the umlaut breaks the tie.
    expect(detectQuestionLanguage('Größe?')).toBe('de')
    expect(detectQuestionLanguage('Straße?')).toBe('de')
  })

  it('resolves null on an empty or wholly undecidable string', () => {
    expect(detectQuestionLanguage('')).toBeNull()
    expect(detectQuestionLanguage('Vulkanismus Wattenmeer 1234')).toBeNull()
  })

  it('resolves null on a genuine 0-0 tie with no umlaut to break it', () => {
    expect(detectQuestionLanguage('Kork Wattenmeer')).toBeNull()
  })

  it('the deliberate asymmetry: German-leaning homographs count only as German', () => {
    // "die", "war", "hat", "man", "was" sit in the German list only (module header, "deliberate
    // asymmetry"): a bare one of them, with no English list-word to outweigh it, reads as German.
    expect(detectQuestionLanguage('die')).toBe('de')
    expect(detectQuestionLanguage('was')).toBe('de')
  })
})

// Frozen fixtures for the pack-language phrase (`resolveArchiveLanguagePhrase`, `expand.ts`):
// the same cases measured offline before this port, reproduced here as regression fixtures.
// The base phrase-less prompt's own sha256 is `basePlanPromptSha256` below; every other case's
// expected sha256 is `sha256(basePrompt.replaceAll('in the language of the question', 'in ' +
// phrase))`. This exercises `resolveArchiveLanguagePhrase` directly (its own caller,
// `buildPlanMessages`, is covered separately in `zim-expand.test.ts`).
const BASE_PLAN_PROMPT =
  'Prepare a short Wikipedia search plan, not an answer, in the language of the question. ' +
  'Infer the intended subject from the original question. ' +
  'titles: up to three likely article titles or genuine aliases, in the language of the ' +
  'question; queries: up to two concise full-text search queries of 2-4 important words, ' +
  'in the language of the question, targeting all requested relations. Preserve entity ' +
  'distinctions, negations, dates, units and exclusions. Do not invent a private fact or ' +
  'supply guessed answer facts as search terms. An announced future event may already be ' +
  'documented. Return JSON only.'

const basePlanPromptSha256 = 'cc49153888d10bd513ebbca6d386fd7eff1ee460f30f3dbe23b581d6cd57bbe5'

interface PhraseCase {
  name: string
  input: Array<string | null> | undefined
  expectedSha256: string
  expectDegraded: boolean
  expectTruncated: boolean
}

const PHRASE_CASES: PhraseCase[] = [
  { name: 'empty array', input: [], expectedSha256: basePlanPromptSha256, expectDegraded: true, expectTruncated: false },
  { name: 'null element only', input: [null], expectedSha256: basePlanPromptSha256, expectDegraded: true, expectTruncated: false },
  { name: 'unmapped code', input: ['xx'], expectedSha256: basePlanPromptSha256, expectDegraded: true, expectTruncated: false },
  {
    name: 'single German',
    input: ['de'],
    expectedSha256: 'a02b218a3e69829a79b83032dfb91ed6dbc151939c70cae6a80af4dd22501e8a',
    expectDegraded: false,
    expectTruncated: false
  },
  {
    name: 'duplicate German entries dedupe to one',
    input: ['de', 'de'],
    expectedSha256: 'a02b218a3e69829a79b83032dfb91ed6dbc151939c70cae6a80af4dd22501e8a',
    expectDegraded: false,
    expectTruncated: false
  },
  {
    name: 'German and English',
    input: ['de', 'en'],
    expectedSha256: '428201125a4cde746f10190d4df749d056cd64d0e0e65cfa83bef6b5496b3477',
    expectDegraded: false,
    expectTruncated: false
  },
  {
    name: 'German, English and French',
    input: ['de', 'en', 'fr'],
    expectedSha256: 'fb746da5c5460c2768b3f0b0e4d24a00b390745f06c075e1fe6daf14b52da40b',
    expectDegraded: false,
    expectTruncated: false
  },
  {
    name: 'a fourth language is truncated, not named',
    input: ['de', 'en', 'fr', 'es'],
    expectedSha256: 'fb746da5c5460c2768b3f0b0e4d24a00b390745f06c075e1fe6daf14b52da40b',
    expectDegraded: false,
    expectTruncated: true
  },
  {
    name: 'a region subtag is dropped before lookup (DE-AT -> German)',
    input: ['DE-AT'],
    expectedSha256: 'a02b218a3e69829a79b83032dfb91ed6dbc151939c70cae6a80af4dd22501e8a',
    expectDegraded: false,
    expectTruncated: false
  },
  {
    name: 'order is preserved on first appearance (English, German)',
    input: ['en', 'de'],
    expectedSha256: '8477d24b39b0a12e1880638959f3492792548767883eea8282aff7342945f33a',
    expectDegraded: false,
    expectTruncated: false
  }
]

describe('resolveArchiveLanguagePhrase — frozen fixtures', () => {
  it.each(PHRASE_CASES)('$name', ({ input, expectedSha256, expectDegraded, expectTruncated }) => {
    const { phrase, truncated } = resolveArchiveLanguagePhrase(input as readonly string[] | undefined)
    expect(phrase === null).toBe(expectDegraded)
    expect(truncated).toBe(expectTruncated)
    const composed = phrase ? BASE_PLAN_PROMPT.replaceAll('in the language of the question', `in ${phrase}`) : BASE_PLAN_PROMPT
    expect(sha256(composed)).toBe(expectedSha256)
  })
})
