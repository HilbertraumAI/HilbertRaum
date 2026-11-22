import { afterEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TRANSLATE_MAX_TOKENS,
  TRANSLATE_RESPONSE_SCHEMA,
  TRANSLATE_TIMEOUT_MS,
  crossLanguageSearch,
  makeQueryTranslator,
  type CrossLanguageSearchTexts
} from '../../src/main/services/rag/cross-language'
import { buildFtsMatchQuery } from '../../src/main/services/fts'
import { readLogTail } from '../../src/main/services/logging'
import { MockRuntime } from '../../src/main/services/runtime/mock'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// #1003 (docs/rag-design.md §20): the one bounded translation call of the cross-language passage
// search, the `zim/expand.ts` `makeQueryExpander` pattern. Every failure resolves null (the search
// then stays today's); the ask's own abort is rethrown. The gate and the search itself are pinned
// through `retrieve()` in tests/integration/rag-cross-language.test.ts.

const QUESTION = 'Wann müssen wir kündigen?'

/**
 * The system prompt measured as "prompt v2" (X0, then held out in X1), byte for byte, "a English" slip
 * included. Its numbers in rag-design §20 hold only for this string: a change needs a new measurement.
 */
const MEASURED_SYSTEM_PROMPT =
  "Translate the user's German question into English, for a search in English documents. Use the words a English " +
  'document on the subject would use. Do not answer the question and do not add anything to it. Keep every name, ' +
  'number, date, amount and unit exactly as written. query: the English translation of the question. Return JSON only.'

interface ScriptedRuntime extends ModelRuntime {
  calls: number
  options: Array<RuntimeChatOptions | undefined>
  messages: ChatMessage[][]
}

/** A runtime that replies with a fixed token list (default: one valid translation). */
function scripted(replies: string[] = ['{"query":"When must we give notice?"}']): ScriptedRuntime {
  const rt: ScriptedRuntime = {
    modelId: 'scripted',
    calls: 0,
    options: [],
    messages: [],
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(msgs: ChatMessage[], options?: RuntimeChatOptions) {
      rt.calls += 1
      rt.options.push(options)
      rt.messages.push(msgs)
      for (const token of replies) {
        if (options?.signal?.aborted) return
        yield token
      }
    }
  }
  return rt
}

afterEach(() => {
  vi.useRealTimers()
})

describe('makeQueryTranslator: the one bounded translation call (#1003)', () => {
  it('no runtime, no translator (retrieve then keeps its one search)', () => {
    expect(makeQueryTranslator(null)).toBeNull()
    expect(makeQueryTranslator(undefined)).toBeNull()
  })

  it('sends the measured prompt with the question as the user turn, in the fast mode, and returns the translation', async () => {
    const rt = scripted(['{"query":"When must', ' we give notice?"}'])
    const translate = makeQueryTranslator(rt)

    expect(await translate!(QUESTION)).toBe('When must we give notice?')
    expect(rt.calls).toBe(1)
    expect(rt.messages[0]).toEqual([
      { role: 'system', content: MEASURED_SYSTEM_PROMPT },
      { role: 'user', content: QUESTION }
    ])
    const o = rt.options[0]
    expect(o?.mode).toBe('fast')
    expect(o?.temperature).toBe(0)
    expect(o?.maxTokens).toBe(TRANSLATE_MAX_TOKENS)
    expect(TRANSLATE_MAX_TOKENS).toBe(96) // the cap the held-out check ran with
    expect(o?.responseSchema).toBe(TRANSLATE_RESPONSE_SCHEMA)
    expect(o?.signal).toBeDefined()
    expect(o?.auxiliary).toBe(true) // #39: a search step, not the turn's answer
  })

  it('a <think> block is stripped and runs of whitespace collapse', async () => {
    const translate = makeQueryTranslator(scripted(['<think>x</think>{"query":"  When must\\n we   give notice? "}']))
    expect(await translate!(QUESTION)).toBe('When must we give notice?')
  })

  it.each([
    ['prose, not JSON', 'Sorry, I cannot help with that.'],
    ['JSON cut off by the token cap', '{"query":"When must we'],
    ['an array', '["When must we give notice?"]'],
    ['no query field', '{"translation":"When must we give notice?"}'],
    ['a query that is not a string', '{"query":42}'],
    ['an empty query', '{"query":"   "}'],
    ['a query over 300 characters', JSON.stringify({ query: 'x'.repeat(301) })]
  ])('%s resolves null (the search stays today\'s)', async (_title, reply) => {
    const translate = makeQueryTranslator(scripted([reply]))
    expect(await translate!(QUESTION)).toBeNull()
  })

  it('a throwing runtime resolves null', async () => {
    const throwing: ModelRuntime = {
      ...scripted(),
      // eslint-disable-next-line require-yield
      async *chatStream(): AsyncGenerator<string> {
        throw new Error('HTTP 500: llama-server gone')
      }
    }
    expect(await makeQueryTranslator(throwing)!(QUESTION)).toBeNull()
  })

  it('a runtime that never ends is cut off at TRANSLATE_TIMEOUT_MS: pending just short of it, null just past it, its signal aborted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let sawAbort = false
    const hanging: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        await new Promise<void>((resolve) => {
          const end = (): void => {
            sawAbort = true
            resolve()
          }
          if (options?.signal?.aborted) end()
          else options?.signal?.addEventListener('abort', end)
        })
      }
    }
    let settled = false
    const pending = makeQueryTranslator(hanging)!(QUESTION).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(TRANSLATE_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    expect(sawAbort).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await pending).toBeNull()
    expect(sawAbort).toBe(true)
  })

  it('a reply longer than TRANSLATE_MAX_TOKENS * 8 characters resolves null and its request is aborted (it never runs on to the cap)', async () => {
    let request: AbortSignal | undefined
    const runaway: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        request = options?.signal
        for (;;) {
          if (options?.signal?.aborted) return
          yield 'x'.repeat(TRANSLATE_MAX_TOKENS * 8 + 1)
        }
      }
    }
    expect(await makeQueryTranslator(runaway)!(QUESTION)).toBeNull()
    expect(request?.aborted).toBe(true)
  })

  it('an already-aborted ask rejects with AbortError, with no model call', async () => {
    const rt = scripted()
    const ask = new AbortController()
    ask.abort()
    await expect(makeQueryTranslator(rt)!(QUESTION, ask.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(rt.calls).toBe(0)
  })

  it('the ask aborting mid-stream rejects with AbortError, never null', async () => {
    const ask = new AbortController()
    const midAbort: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        yield '{"query":'
        ask.abort()
        if (options?.signal?.aborted) return
        yield '"When must we give notice?"}'
      }
    }
    await expect(makeQueryTranslator(midAbort)!(QUESTION, ask.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('under the mock runtime (dev mode) the call resolves null: its reply is never JSON, so the search stays as it is', async () => {
    const mock = new MockRuntime({ modelId: 'mock-model', modelPath: 'x', contextTokens: 4096 })
    await mock.start()
    expect(await makeQueryTranslator(mock)!(QUESTION)).toBeNull()
    expect(mock.warmedUp()).toBe(false) // #39: the translation is no first answer; the warm-up hint stays armed
  })
})

describe('crossLanguageSearch: the texts of the second search (#1003)', () => {
  // The keyword pass keeps the first 32 words of its text (fts.ts MAX_QUERY_TOKENS), so it gets the
  // translation first; the vectors keep the measured order. For a joined text of at most 32 words the
  // two orders give the same keyword query, so the measured numbers still hold: every German eval
  // question with its English twin as the translation (22 words at most), as every measured question did.
  it('the vectors search the question then the translation; the keyword query is the same phrases in the other order', async () => {
    const rows = readFileSync(join(__dirname, '../../../../eval/rag_de_en.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { lang: string; pair: string; question: string })
    const twins = new Map(rows.filter((r) => r.lang === 'en').map((r) => [r.pair, r.question]))
    const pairs = rows.filter((r) => r.lang === 'de' && twins.has(r.pair)).map((r) => [r.question, twins.get(r.pair)!] as const)
    expect(pairs.length).toBeGreaterThanOrEqual(30)
    const phrases = (text: string): string[] => (buildFtsMatchQuery(text) ?? '').split(' OR ').sort()

    for (const [question, translation] of pairs) {
      const search = vi.fn(async (texts: CrossLanguageSearchTexts) => texts)
      const texts = await crossLanguageSearch(question, ['The tenant pays the rent.'], async () => translation, search)

      expect(texts).toEqual({ vectorText: `${question} ${translation}`, keywordText: `${translation} ${question}` })
      expect(phrases(texts!.vectorText).length).toBeLessThanOrEqual(32) // premise: it fits
      expect(phrases(texts!.keywordText)).toEqual(phrases(texts!.vectorText))
    }
  })
})

describe('crossLanguageSearch: what the log line says (#1003)', () => {
  const lastLine = (): string => readLogTail(10_000).filter((l) => l.includes('Cross-language passage search')).at(-1) ?? ''
  const english = ['The tenant pays the rent.']

  it('the duration is the translation call only, not the second search after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-22T10:00:00.000Z'))
    const result = await crossLanguageSearch(
      QUESTION,
      english,
      async () => {
        vi.setSystemTime(new Date('2026-11-22T10:00:00.250Z')) // the call takes 250 ms
        return 'When must we give notice?'
      },
      async (texts) => {
        vi.setSystemTime(new Date('2026-11-22T10:00:05.000Z')) // the second search takes 4.75 s
        return texts
      }
    )

    expect(result).not.toBeNull()
    expect(lastLine()).toContain('{"outcome":"translated","durationMs":250}')
  })

  it('a second search that throws is its own outcome, not a failed call', async () => {
    const result = await crossLanguageSearch(
      QUESTION,
      english,
      async () => 'When must we give notice?',
      async () => {
        throw new Error('embedder down')
      }
    )

    expect(result).toBeNull()
    expect(lastLine()).toContain('"outcome":"search-failed"')
    expect(lastLine()).not.toContain('embedder down')
  })
})
