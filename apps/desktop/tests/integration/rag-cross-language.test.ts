import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Db } from '../../src/main/services/db'
import { type Embedder, MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import {
  generateGroundedAnswer,
  ragSettingsFrom,
  retrieve,
  type RagRetrievalSettings
} from '../../src/main/services/rag'
import {
  TRANSLATE_MAX_QUESTION_CHARS,
  TRANSLATE_RESPONSE_SCHEMA,
  TRANSLATE_TIMEOUT_MS,
  makeQueryTranslator,
  type QueryTranslator
} from '../../src/main/services/rag/cross-language'
import { appendMessage, createConversation, listMessages } from '../../src/main/services/chat'
import { readLogTail } from '../../src/main/services/logging'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import type { Reranker } from '../../src/main/services/reranker'
import { detectPassageLanguage, detectQuestionLanguage } from '../../src/main/services/zim/question-language'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { openFreshDb } from '../helpers/db-fixtures'
import { seedEmbeddedDoc } from '../helpers/doc-fixtures'
import { archiveCandidate, testArm } from '../helpers/zim-retrieval-fixtures'

// #1003 (follow-ups wave 7, owner call G-2; docs/rag-design.md §20): a German question over English
// documents is translated by the turn's chat model, and the passage search runs again on the
// question and its translation. Through the real `retrieve()` / `generateGroundedAnswer()` over real
// node:sqlite (vectors + FTS5), with the mock embedder and a scripted runtime.

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)
/** Every seeded chunk is a vector candidate, so a small scope's top fused candidates are all of its chunks. */
const ALL_CANDIDATES: RagRetrievalSettings = { ...SETTINGS, minSimilarity: -1 }

const DE_NOTICE = 'Wann müssen wir kündigen?'
const EN_NOTICE = 'When must we give notice?'

/** Twelve English lease clauses. None holds a word of `EN_NOTICE` (or of the German question). */
const EN_CLAUSES = [
  'The monthly base rent is 4,200 euros, payable in advance on the first working day of each month.',
  'The tenant pays a security deposit of three monthly rents into a blocked account.',
  'The landlord provides six key cards for the main entrance and the parking garage.',
  'The tenant is responsible for minor repairs up to 150 euros per case.',
  'Operating costs are settled once a year against the advance payments.',
  'The premises may only be used as offices for a design studio.',
  'The tenant takes out liability insurance with a sum insured of five million euros.',
  'Subletting of up to a third of the area requires the consent of the landlord.',
  'The landlord may enter the premises after an announcement of two working days.',
  'Each parking space in the garage costs 120 euros per month.',
  'The courts of Hamburg have jurisdiction for all disputes arising from this lease.',
  'The lease begins on 1 January 2026 and runs for a fixed term of five years.'
]
/** The English notice clause: only the translation's "must", "give" and "notice" reach it. */
const EN_NOTICE_CLAUSE = 'The tenant must give notice of termination in writing by 31 December 2030.'

const DE_CLAUSES = [
  'Die monatliche Grundmiete beträgt 4.200 Euro und ist im Voraus zu zahlen.',
  'Der Mieter zahlt eine Kaution von drei Monatsmieten auf ein Sperrkonto.',
  'Der Vermieter stellt sechs Schlüsselkarten für den Haupteingang zur Verfügung.',
  'Die Kündigung muss bis zum 31. Dezember 2030 schriftlich erfolgen.',
  'Der Mieter trägt Kleinreparaturen bis zu 150 Euro je Fall.'
]
/** A chunk with no function word in either language: its language reads as null. */
const LETTERHEAD = 'Okonkwo Design Studio GmbH, Hamburg-Altona'
/** Chunks with no function word in either language (a letterhead, an account line, a signature block): each reads as null. */
const UNREADABLE = [LETTERHEAD, 'IBAN DE89 3704 0044 0532 0130 00', 'Signed: Anna Keller, Max Huber']
/** A German address in an English lease: no function word, one umlaut. The question rule would read it as German. */
const GERMAN_ADDRESS = 'Müller Bau GmbH, Königstraße 5, 70173 Stuttgart'
/**
 * A German question of 32 words in 147 characters (inside `TRANSLATE_MAX_QUESTION_CHARS`): on its own it fills the
 * keyword pass's 32-word query, and none of its words or numbers occurs in the notice clause.
 */
const WORDY_DE_NOTICE =
  'Wann und wie müssen wir als Mieter von Büro 3, Haus 12, Ring 7, Köln, bis 30. 9. 2029 und an wen kündigen, ' +
  'wenn wir am 1. 7. mit allen raus wollen?'
/** A German question of 219 characters: past `TRANSLATE_MAX_QUESTION_CHARS`, it is not translated. */
const LONG_DE_NOTICE =
  'Bis wann genau müssen wir als Mieter nach dem Vertrag spätestens schriftlich kündigen, wenn wir zum Ende des ' +
  'nächsten Jahres aus den Büroräumen ausziehen und keine Verlängerung wollen, und was müssen wir dabei beachten?'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Point a chunk's stored vector away from `text`, so no vector search for it (or for text that holds it) ranks the chunk. */
async function vectorAwayFrom(db: Db, embedder: MockEmbedder, chunkId: string, text: string): Promise<void> {
  const [v] = await embedder.embed([text])
  db.prepare('UPDATE embeddings SET vector_blob = ? WHERE chunk_id = ?').run(encodeVector(v.map((x) => -x)), chunkId)
}

function chunkIdOfText(db: Db, text: string): string {
  return (db.prepare('SELECT id FROM chunks WHERE text = ?').get(text) as { id: string }).id
}

/**
 * The mock embedder's vectors under the same model id, recording every text it embeds; `fail` may throw
 * for a text (an embedder that dies on the second search). A new instance has its own query cache.
 */
function recordingEmbedder(fail?: (text: string) => Error | null): Embedder & { texts: string[] } {
  const inner = new MockEmbedder()
  const texts: string[] = []
  return {
    id: inner.id,
    dimensions: inner.dimensions,
    texts,
    async embed(batch) {
      texts.push(...batch)
      for (const text of batch) {
        const err = fail?.(text)
        if (err) throw err
      }
      return inner.embed(batch)
    }
  }
}

/** The last cross-language log line: its outcome and duration, and nothing else. */
function lastCrossLanguageLogLine(): string {
  const line = readLogTail(10_000).filter((l) => l.includes('Cross-language passage search')).at(-1)
  if (line === undefined) throw new Error('no cross-language log line')
  return line
}

/** An English lease with the notice clause that only the keyword arm can reach, and only through English words. */
async function seedEnglishLease(db: Db, embedder: MockEmbedder): Promise<string> {
  await seedEmbeddedDoc(db, embedder, 'lease.txt', [...EN_CLAUSES, EN_NOTICE_CLAUSE])
  const gold = chunkIdOfText(db, EN_NOTICE_CLAUSE)
  await vectorAwayFrom(db, embedder, gold, DE_NOTICE)
  return gold
}

interface ScriptedRuntime extends ModelRuntime {
  answerMessages: ChatMessage[][]
  translationCalls: number
}

/** Answers the translation call with `translation` (as JSON) and every other call with a fixed reply. */
function scriptedRuntime(translation: string, onTranslation?: () => void): ScriptedRuntime {
  const rt: ScriptedRuntime = {
    modelId: 'scripted',
    answerMessages: [],
    translationCalls: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    contextWindow: () => 8192,
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      if (options?.responseSchema === TRANSLATE_RESPONSE_SCHEMA) {
        rt.translationCalls += 1
        onTranslation?.()
        if (options.signal?.aborted) return
        yield JSON.stringify({ query: translation })
        return
      }
      rt.answerMessages.push(messages)
      yield 'The notice is due by 31 December 2030 [S1].'
    }
  }
  return rt
}

function fakeReranker(): Reranker & { queries: string[] } {
  const queries: string[] = []
  return {
    id: 'fake-reranker',
    queries,
    // Keeps the fused order: the first candidate scores highest.
    async rerank(query, documents) {
      queries.push(query)
      return documents.map((_d, index) => ({ index, score: -index }))
    }
  }
}

describe('cross-language search: a German question over an English document (#1003)', () => {
  it('a translation whose English word only the keyword arm matches brings the notice clause into the citations', async () => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    const gold = await seedEnglishLease(db, embedder)
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: DE_NOTICE })
    const runtime = scriptedRuntime(EN_NOTICE)

    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, DE_NOTICE, ALL_CANDIDATES)

    // Without the step the German words match no English chunk and the clause's vector points away
    // from the question, so the twelve other clauses fill every slot.
    expect(msg.citations?.map((c) => c.chunkId)).toContain(gold)
    expect(runtime.translationCalls).toBe(1)
  })

  it('the pack arm, the reranker, the grounded prompt and the stored messages keep the original question', async () => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    const gold = await seedEnglishLease(db, embedder)
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: DE_NOTICE })
    const runtime = scriptedRuntime(EN_NOTICE)
    const reranker = fakeReranker()
    const armQuestions: string[] = []

    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, DE_NOTICE, ALL_CANDIDATES, {
      reranker,
      externalArm: async (question) => {
        armQuestions.push(question)
        return testArm()
      }
    })

    expect(runtime.translationCalls).toBe(1)
    expect(msg.citations?.map((c) => c.chunkId)).toContain(gold) // the translated search ran
    expect(armQuestions).toEqual([DE_NOTICE])
    expect(reranker.queries).toEqual([DE_NOTICE])
    expect(runtime.answerMessages).toHaveLength(1)
    const prompt = runtime.answerMessages[0].map((m) => m.content).join('\n')
    expect(prompt).toContain(DE_NOTICE)
    expect(prompt).not.toContain(EN_NOTICE)
    const stored = listMessages(db, conv.id)
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', DE_NOTICE],
      ['assistant', 'The notice is due by 31 December 2030 [S1].']
    ])
  })

  it("the search keeps the question's own number: a translation that drops it still finds the bill the number names", async () => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    const bill = 'Bill 4711: move-in costs, payable within thirty days of receipt.'
    await seedEmbeddedDoc(db, embedder, 'lease.txt', [...EN_CLAUSES, bill])
    const question = 'Wann ist die Rechnung 4711 fällig?'
    const translation = 'Invoice due date?'
    // The bill holds no word of the translation, and its vector points away from it: only the
    // question's own "4711" can find it. (No clause holds a word of the translation either, so
    // none of them is lifted into both arms' lists above the bill.)
    await vectorAwayFrom(db, embedder, chunkIdOfText(db, bill), translation)
    const translate = vi.fn<QueryTranslator>(async () => translation)

    const r = await retrieve(db, embedder, question, ALL_CANDIDATES, null, null, undefined, null, translate)

    expect(translate).toHaveBeenCalledTimes(1)
    expect(r.chunks.map((c) => c.text)).toContain(bill)
  })

  it('an abort during the translation call rejects the ask with AbortError, and no answer is generated', async () => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    await seedEnglishLease(db, embedder)
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: DE_NOTICE })
    const ask = new AbortController()
    const runtime = scriptedRuntime(EN_NOTICE, () => ask.abort())

    await expect(
      generateGroundedAnswer(db, runtime, embedder, conv.id, DE_NOTICE, ALL_CANDIDATES, { signal: ask.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtime.translationCalls).toBe(1)
    expect(runtime.answerMessages).toHaveLength(0)
    expect(listMessages(db, conv.id).map((m) => m.role)).toEqual(['user'])
  })
})

describe('cross-language search: the second search (#1003)', () => {
  it('a German question of 32 words still reaches the keyword pass with its translation (the translation goes first)', async () => {
    const db = openFreshDb('rag-xlang')
    const seeder = new MockEmbedder()
    await seedEmbeddedDoc(db, seeder, 'lease.txt', [...EN_CLAUSES, EN_NOTICE_CLAUSE])
    await vectorAwayFrom(db, seeder, chunkIdOfText(db, EN_NOTICE_CLAUSE), WORDY_DE_NOTICE)
    const embedder = recordingEmbedder()
    const translate = vi.fn<QueryTranslator>(async () => EN_NOTICE)

    const r = await retrieve(db, embedder, WORDY_DE_NOTICE, ALL_CANDIDATES, null, null, undefined, null, translate)

    // The keyword pass keeps the first 32 words of its text: with the question first, the German words
    // fill them all and "notice" never reaches the query.
    expect(r.chunks.map((c) => c.text)).toContain(EN_NOTICE_CLAUSE)
    // The vectors still search the question, then its translation (the measured order).
    expect(translate).toHaveBeenCalledTimes(1)
    expect(embedder.texts).toEqual([WORDY_DE_NOTICE, `${WORDY_DE_NOTICE} ${EN_NOTICE}`])
  })

  it('a second search that fails keeps the first search, and the log says so without any text', async () => {
    const db = openFreshDb('rag-xlang')
    const seeder = new MockEmbedder()
    await seedEnglishLease(db, seeder)
    const today = await retrieve(db, seeder, DE_NOTICE, ALL_CANDIDATES)
    const embedder = recordingEmbedder((text) => (text.includes(EN_NOTICE) ? new Error('embedder down') : null))

    const withFailure = await retrieve(
      db, embedder, DE_NOTICE, ALL_CANDIDATES, null, null, undefined, null, async () => EN_NOTICE
    )

    expect(embedder.texts).toEqual([DE_NOTICE, `${DE_NOTICE} ${EN_NOTICE}`]) // the second search ran, and threw
    expect(withFailure).toEqual(today)
    const line = lastCrossLanguageLogLine()
    expect(line).toContain('"outcome":"search-failed"')
    expect(line).not.toContain('embedder down')
    expect(line).not.toContain('notice')
  })

  it('a second search that finds nothing keeps the first search (a similarity floor the joined text misses)', async () => {
    const db = openFreshDb('rag-xlang')
    const seeder = new MockEmbedder()
    const docId = await seedEmbeddedDoc(db, seeder, 'lease.txt', EN_CLAUSES.slice(0, 6))
    // Every clause's vector is the question's own: the question alone clears a 0.9 floor, the question
    // joined with its translation does not, and no clause holds a word of either.
    const [toward] = await seeder.embed([DE_NOTICE])
    db.prepare('UPDATE embeddings SET vector_blob = ? WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(
      encodeVector(toward),
      docId
    )
    const floor = { ...SETTINGS, minSimilarity: 0.9 }
    const today = await retrieve(db, seeder, DE_NOTICE, floor)
    const embedder = recordingEmbedder()

    const withEmpty = await retrieve(db, embedder, DE_NOTICE, floor, null, null, undefined, null, async () => EN_NOTICE)

    expect(today.chunks).toHaveLength(6) // premise: the first search finds every clause
    expect(embedder.texts).toEqual([DE_NOTICE, `${DE_NOTICE} ${EN_NOTICE}`]) // the second search ran
    expect(withEmpty).toEqual(today)
    expect(lastCrossLanguageLogLine()).toContain('"outcome":"empty"')
  })

  it('a question longer than TRANSLATE_MAX_QUESTION_CHARS is not translated: no call, the search as it was', async () => {
    const db = openFreshDb('rag-xlang')
    const seeder = new MockEmbedder()
    await seedEmbeddedDoc(db, seeder, 'lease.txt', [...EN_CLAUSES, EN_NOTICE_CLAUSE])
    const today = await retrieve(db, seeder, LONG_DE_NOTICE, ALL_CANDIDATES)
    const translate = vi.fn<QueryTranslator>(async () => EN_NOTICE)

    const withGate = await retrieve(db, seeder, LONG_DE_NOTICE, ALL_CANDIDATES, null, null, undefined, null, translate)

    expect(Array.from(LONG_DE_NOTICE).length).toBeGreaterThan(TRANSLATE_MAX_QUESTION_CHARS) // premise
    expect(Array.from(WORDY_DE_NOTICE).length).toBeLessThanOrEqual(TRANSLATE_MAX_QUESTION_CHARS) // the row above
    expect(translate).not.toHaveBeenCalled()
    expect(withGate).toEqual(today)
    expect(lastCrossLanguageLogLine()).toContain('"outcome":"skipped"')
  })

  it('an abort during the second search still rejects with AbortError', async () => {
    const db = openFreshDb('rag-xlang')
    await seedEnglishLease(db, new MockEmbedder())
    const aborted = (): Error => Object.assign(new Error('cancelled'), { name: 'AbortError' })
    const embedder = recordingEmbedder((text) => (text.includes(EN_NOTICE) ? aborted() : null))

    await expect(
      retrieve(db, embedder, DE_NOTICE, ALL_CANDIDATES, null, null, undefined, null, async () => EN_NOTICE)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a translation that only repeats the question (case and spaces aside) runs no second search', async () => {
    const db = openFreshDb('rag-xlang')
    const seeder = new MockEmbedder()
    await seedEnglishLease(db, seeder)
    const today = await retrieve(db, seeder, DE_NOTICE, ALL_CANDIDATES)
    const embedder = recordingEmbedder()
    const echo = `  ${DE_NOTICE.toUpperCase().replace(' ', '   ')} `

    const withEcho = await retrieve(db, embedder, DE_NOTICE, ALL_CANDIDATES, null, null, undefined, null, async () => echo)

    expect(embedder.texts).toEqual([DE_NOTICE])
    expect(withEcho).toEqual(today)
    expect(lastCrossLanguageLogLine()).toContain('"outcome":"unchanged"')
  })

  it('an English question that reads as German, handed back without its question mark, runs no second search', async () => {
    // "was" counts as German and the umlaut breaks the tie: the question side reads it as German, so the gate opens
    // over English passages. The model returns the question minus its punctuation: a repeat, not a translation.
    const question = 'Who was Hans Müller?'
    const db = openFreshDb('rag-xlang')
    const seeder = new MockEmbedder()
    await seedEmbeddedDoc(db, seeder, 'lease.txt', EN_CLAUSES.slice(0, 6))
    const today = await retrieve(db, seeder, question, ALL_CANDIDATES)
    const embedder = recordingEmbedder()
    const translate = vi.fn<QueryTranslator>(async () => 'Who was Hans Müller')

    const withEcho = await retrieve(db, embedder, question, ALL_CANDIDATES, null, null, undefined, null, translate)

    expect(detectQuestionLanguage(question)).toBe('de') // premise
    expect(translate).toHaveBeenCalledTimes(1)
    expect(embedder.texts).toEqual([question])
    expect(withEcho).toEqual(today)
    expect(lastCrossLanguageLogLine()).toContain('"outcome":"unchanged"')
  })
})


describe('cross-language search: the gate (#1003)', () => {
  async function seedDoc(db: Db, embedder: MockEmbedder, chunks: string[]): Promise<void> {
    await seedEmbeddedDoc(db, embedder, `${randomUUID()}.txt`, chunks)
  }

  // The candidate rule: none of the top six reads as German, and a strict majority of all six reads as English;
  // a passage whose language reads as null (a table, a letterhead, an address) does not block, but it counts
  // against the majority. Passages are read without the question's umlaut tie-break.
  it.each([
    ['a German question whose top passages all read as English', EN_CLAUSES.slice(0, 6)],
    ['a short English document with one chunk whose language reads as null (a letterhead)', [...EN_CLAUSES.slice(0, 5), LETTERHEAD]],
    ['an English lease with a German address chunk (an umlaut, no function word)', [...EN_CLAUSES.slice(0, 5), GERMAN_ADDRESS]]
  ])('translated once, with the question as asked: %s', async (_title, chunks) => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    await seedDoc(db, embedder, chunks)
    const translate = vi.fn<QueryTranslator>(async () => EN_NOTICE)

    const r = await retrieve(db, embedder, DE_NOTICE, ALL_CANDIDATES, null, null, undefined, null, translate)

    expect(r.chunks.length).toBe(chunks.length) // premise: every passage is a top candidate
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate).toHaveBeenCalledWith(DE_NOTICE, undefined)
  })

  // Each row: no translation call, and the result is exactly the one without a translator.
  it.each([
    ['an English question over German passages (the reverse direction is not built)', EN_NOTICE, DE_CLAUSES],
    ['a German question over German passages', DE_NOTICE, DE_CLAUSES],
    ['an English question over English passages', EN_NOTICE, EN_CLAUSES.slice(0, 6)],
    ['a German question over a short English document with one German chunk', DE_NOTICE, [...EN_CLAUSES.slice(0, 5), DE_CLAUSES[3]]],
    ['a German question over passages only half of which read as English (no strict majority)', DE_NOTICE, [...EN_CLAUSES.slice(0, 3), ...UNREADABLE]],
    ['a question whose language reads as null over English passages', 'Miete?', EN_CLAUSES.slice(0, 6)]
  ])('no translation: %s', async (_title, question, chunks) => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    await seedDoc(db, embedder, chunks)
    const translate = vi.fn<QueryTranslator>(async () => EN_NOTICE)

    const today = await retrieve(db, embedder, question, ALL_CANDIDATES)
    const withGate = await retrieve(db, embedder, question, ALL_CANDIDATES, null, null, undefined, null, translate)

    expect(today.chunks.length).toBe(chunks.length) // premise: every passage is a top candidate
    expect(translate).not.toHaveBeenCalled()
    expect(withGate).toEqual(today)
  })

  it('premise: the gate rows read their passages as the language they are written in', () => {
    expect(detectQuestionLanguage(DE_NOTICE)).toBe('de')
    expect(detectQuestionLanguage(LONG_DE_NOTICE)).toBe('de')
    expect(detectQuestionLanguage(WORDY_DE_NOTICE)).toBe('de')
    // The address: German by the question rule (the umlaut tie-break), unreadable as a passage.
    expect(detectQuestionLanguage(GERMAN_ADDRESS)).toBe('de')
    expect(detectPassageLanguage(GERMAN_ADDRESS)).toBeNull()
    expect(DE_CLAUSES.map(detectPassageLanguage)).toEqual(Array(5).fill('de'))
    expect(detectQuestionLanguage(EN_NOTICE)).toBe('en')
    expect(detectQuestionLanguage('Miete?')).toBeNull()
    expect(UNREADABLE.map(detectQuestionLanguage)).toEqual([null, null, null])
    expect([...EN_CLAUSES, EN_NOTICE_CLAUSE].map(detectQuestionLanguage)).toEqual(Array(13).fill('en'))
    expect(DE_CLAUSES.map(detectQuestionLanguage)).toEqual(Array(5).fill('de'))
  })

  it('a packs-only ask is byte-identical: English documents in the workspace and English pack passages, no translation call', async () => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    await seedEnglishLease(db, embedder)
    const scope = { documentIds: null, collectionIds: null, packIds: ['pack-1'], noDocuments: true as const }
    const arm = async (): Promise<ReturnType<typeof testArm>> =>
      testArm(archiveCandidate(0, EN_CLAUSES[0]), archiveCandidate(1, EN_NOTICE_CLAUSE))
    const translate = vi.fn<QueryTranslator>(async () => EN_NOTICE)

    const today = await retrieve(db, embedder, DE_NOTICE, ALL_CANDIDATES, scope, null, undefined, arm)
    const withGate = await retrieve(db, embedder, DE_NOTICE, ALL_CANDIDATES, scope, null, undefined, arm, translate)

    expect(today.chunks.map((c) => c.sourceKind)).toEqual(['archive', 'archive'])
    expect(translate).not.toHaveBeenCalled()
    expect(withGate).toEqual(today)
  })
})

describe('cross-language search: a failed call keeps today\'s search (#1003)', () => {
  const failing: Array<[string, () => ModelRuntime]> = [
    [
      'a call that throws',
      () => ({
        ...scriptedRuntime(EN_NOTICE),
        // eslint-disable-next-line require-yield
        async *chatStream(): AsyncGenerator<string> {
          throw new Error('HTTP 500: llama-server gone')
        }
      })
    ],
    [
      'a malformed reply',
      () => ({
        ...scriptedRuntime(EN_NOTICE),
        async *chatStream() {
          yield '{"query": "When must we give'
        }
      })
    ]
  ]

  it.each(failing)('%s: the result is exactly the one without a translator', async (_title, make) => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    await seedEnglishLease(db, embedder)

    const today = await retrieve(db, embedder, DE_NOTICE, ALL_CANDIDATES)
    const withFailure = await retrieve(
      db, embedder, DE_NOTICE, ALL_CANDIDATES, null, null, undefined, null, makeQueryTranslator(make())
    )

    expect(withFailure).toEqual(today)
  })

  it('a call that never ends: past TRANSLATE_TIMEOUT_MS the result is exactly the one without a translator', async () => {
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    await seedEnglishLease(db, embedder)
    const today = await retrieve(db, embedder, DE_NOTICE, ALL_CANDIDATES)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let reached = (): void => {}
    const callStarted = new Promise<void>((resolve) => {
      reached = resolve
    })
    const hanging: ModelRuntime = {
      ...scriptedRuntime(EN_NOTICE),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        reached()
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve()))
      }
    }

    const pending = retrieve(db, embedder, DE_NOTICE, ALL_CANDIDATES, null, null, undefined, null, makeQueryTranslator(hanging))
    // The bound starts with the call; a search that never makes the call settles on its own.
    await Promise.race([callStarted, pending])
    await vi.advanceTimersByTimeAsync(TRANSLATE_TIMEOUT_MS)

    expect(await pending).toEqual(today)
  })
})

// K's gate check (#1003): with the WHOLE bilingual eval corpus in scope, as tests/manual/model-eval.test.ts
// asks it, the gate fires on none of the 100 questions, so the eval's retrieval stays comparable.
describe('cross-language search: the bilingual eval set never opens the gate (#1003)', () => {
  it('no question of eval/rag_de_en.jsonl is translated with every corpus document in scope', async () => {
    const evalDir = join(__dirname, '../../../../eval')
    const corpus = readFileSync(join(evalDir, 'corpus_de_en.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { doc: string; index: number; text: string })
    const questions = readFileSync(join(evalDir, 'rag_de_en.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { question: string }).question)
    expect(questions.length).toBeGreaterThanOrEqual(100)
    const db = openFreshDb('rag-xlang')
    const embedder = new MockEmbedder()
    const byDoc = new Map<string, Array<{ index: number; text: string }>>()
    for (const c of corpus) byDoc.set(c.doc, [...(byDoc.get(c.doc) ?? []), c])
    for (const [title, chunks] of byDoc) {
      await seedEmbeddedDoc(db, embedder, title, [...chunks].sort((a, b) => a.index - b.index).map((c) => c.text))
    }
    const translate = vi.fn<QueryTranslator>(async () => 'translated')

    const fired: string[] = []
    for (const question of questions) {
      translate.mockClear()
      await retrieve(db, embedder, question, SETTINGS, null, null, undefined, null, translate)
      if (translate.mock.calls.length > 0) fired.push(question)
    }

    expect(fired).toEqual([])
  })
})
