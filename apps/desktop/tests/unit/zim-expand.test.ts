import { describe, it, expect } from 'vitest'
import {
  EXPAND_MAX_TOKENS,
  EXPAND_MAX_TERMS,
  EXPAND_MAX_TERM_CHARS,
  EXPAND_RESPONSE_SCHEMA,
  buildExpansionMessages,
  makeQueryExpander,
  parseExpansion
} from '../../src/main/services/zim/expand'
import { MockRuntime } from '../../src/main/services/runtime/mock'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// #340 L3-b (D-Z20) — the question → concept expansion the knowledge-pack arm calls once per ask.
// The contract under test: `parseExpansion` sanitises a model reply against the SAME content-word
// / stop-word / frame-word rules `query-rewrite.ts` uses for the plain pattern (so an expansion can
// never re-introduce a word the plain rewrite would have stripped); `makeQueryExpander` wraps ONE
// grammar-constrained, temperature-0 call with its own wall-clock bound and degrades to null on
// every failure except the ask's own abort, which is rethrown — mirroring `classify.ts`'s
// `classifySkillPointer` (issue #80), the precedent module for this shape.

interface ScriptedRuntime extends ModelRuntime {
  calls: number
  options: Array<RuntimeChatOptions | undefined>
  messages: ChatMessage[][]
}

/** A runtime that replies with a fixed token list (default: one valid JSON expansion). */
function scripted(replies: string[] = ['{"concepts":["Vulkanismus"],"listTitle":""}']): ScriptedRuntime {
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

/** Collect a `ModelRuntime`'s full streamed reply for a question, so a test can feed the REAL
 *  mock reply text into `parseExpansion` rather than a hand-typed stand-in. */
async function collect(runtime: ModelRuntime, question: string): Promise<string> {
  let text = ''
  for await (const token of runtime.chatStream(buildExpansionMessages(question))) text += token
  return text
}

describe('parseExpansion — sanitising the model reply', () => {
  it('a well-formed reply yields concepts + listTitle', () => {
    const result = parseExpansion(
      '{"concepts":["Vulkanismus","Wattenmeer"],"listTitle":"Liste der Vulkane"}',
      'Was ist das?'
    )
    expect(result).toEqual({ concepts: ['Vulkanismus', 'Wattenmeer'], listTitle: 'Liste der Vulkane' })
  })

  it('a <think> block before the JSON is stripped (chat.ts stripThinkBlocks)', () => {
    const result = parseExpansion(
      '<think>the user wants a list of volcanoes</think>{"concepts":["Vulkanismus"],"listTitle":""}',
      'Was ist das?'
    )
    expect(result).toEqual({ concepts: ['Vulkanismus'], listTitle: null })
  })

  it('function and frame words never survive, standalone', () => {
    // "die" (function word), "welche" (function word), "Rolle" (frame word) — none is a content
    // word by query-rewrite.ts's own lists, so parseExpansion drops all three regardless of the
    // question, leaving nothing: the whole reply degrades to null.
    const result = parseExpansion('{"concepts":["die","welche","Rolle"],"listTitle":""}', 'Was ist das?')
    expect(result).toBeNull()
  })

  it('a word already in the plain pattern is dropped case-insensitively; a frame word is dropped regardless', () => {
    // Question's plain pattern (searchPattern) keeps "Länder stoßen meisten CO2" ("welche"/"am"/
    // "aus" strip as function words). "Länder" duplicates the pattern (case-insensitive) and is
    // dropped; "CO2-Emission" is new vocabulary and survives. "Liste" is ALSO offered by the model
    // here, but query-rewrite.ts's FRAME_WORDS list (shared via `isContentWord`) treats "liste" as
    // a German frame word ("zeige, liste, nenne …") — it is filtered at the content-word stage,
    // before the pattern-overlap check ever runs, so it never survives either. See the report for
    // this discrepancy against the task's worked example.
    const question = 'Welche Länder stoßen am meisten CO2 aus?'
    const result = parseExpansion('{"concepts":["Länder","CO2-Emission","Liste"],"listTitle":""}', question)
    expect(result).toEqual({ concepts: ['CO2-Emission'], listTitle: null })
  })

  it('duplicate concepts are dropped, case-insensitively, keeping the first occurrence', () => {
    const result = parseExpansion(
      '{"concepts":["Vulkanismus","vulkanismus","VULKANISMUS"],"listTitle":""}',
      'Was ist das?'
    )
    expect(result).toEqual({ concepts: ['Vulkanismus'], listTitle: null })
  })

  it('multi-word strings are tokenised per-word: frame and stop words inside them still drop', () => {
    // "Liste" (frame word) and "der" (stop word) both drop out of the single multi-word item;
    // "Länder" is a content word and, for THIS question, is not already in the plain pattern.
    const result = parseExpansion('{"concepts":["Liste der Länder"],"listTitle":""}', 'Was sind Volkswirtschaften?')
    expect(result).toEqual({ concepts: ['Länder'], listTitle: null })
  })

  it('the term cap keeps the first EXPAND_MAX_TERMS distinct valid words, in order', () => {
    const eight = [
      'Fotosynthese',
      'Quantenmechanik',
      'Bibliothek',
      'Vulkanismus',
      'Handelsabkommen',
      'Wattenmeer',
      'Seidenstraße',
      'Klimaanlage'
    ]
    const result = parseExpansion(JSON.stringify({ concepts: eight, listTitle: '' }), 'Was ist das?')
    expect(EXPAND_MAX_TERMS).toBe(6)
    expect(result?.concepts).toEqual(eight.slice(0, EXPAND_MAX_TERMS))
  })

  it('a term longer than EXPAND_MAX_TERM_CHARS is dropped whole, never cut to fit', () => {
    const tooLong = 'a'.repeat(EXPAND_MAX_TERM_CHARS + 1)
    const result = parseExpansion(
      JSON.stringify({ concepts: [tooLong], listTitle: 'Liste der Beispiele' }),
      'Was ist das?'
    )
    expect(tooLong.length).toBe(41)
    expect(result?.concepts).toEqual([])
    // Not truncated to EXPAND_MAX_TERM_CHARS — dropped outright.
    expect(result?.concepts).not.toContain(tooLong.slice(0, EXPAND_MAX_TERM_CHARS))
    expect(result?.listTitle).toBe('Liste der Beispiele')
  })

  it('listTitle is trimmed and inner whitespace collapsed', () => {
    const result = parseExpansion(
      JSON.stringify({ concepts: [], listTitle: '  Liste   der   Flüsse  ' }),
      'Was ist das?'
    )
    expect(result?.listTitle).toBe('Liste der Flüsse')
  })

  it('an empty listTitle yields null', () => {
    const result = parseExpansion(
      JSON.stringify({ concepts: ['Vulkanismus'], listTitle: '' }),
      'Was ist das?'
    )
    expect(result?.listTitle).toBeNull()
  })

  it('a listTitle over EXPAND_MAX_TITLE_CHARS (81) yields null', () => {
    const title = `${'a'.repeat(80)} b` // 82 chars total, well past the 80-char cap
    const result = parseExpansion(JSON.stringify({ concepts: ['Vulkanismus'], listTitle: title }), 'Was ist das?')
    expect(title.length).toBeGreaterThanOrEqual(81)
    expect(result?.listTitle).toBeNull()
  })

  it('a digits-only listTitle yields null (no letter)', () => {
    const result = parseExpansion(
      JSON.stringify({ concepts: ['Vulkanismus'], listTitle: '1234567890' }),
      'Was ist das?'
    )
    expect(result?.listTitle).toBeNull()
  })

  it('non-object JSON ([], "x", 42) all yield null', () => {
    expect(parseExpansion('[]', 'Was ist das?')).toBeNull()
    expect(parseExpansion('"x"', 'Was ist das?')).toBeNull()
    expect(parseExpansion('42', 'Was ist das?')).toBeNull()
  })

  it('non-JSON prose — the mock runtime\'s own reply — yields null', async () => {
    const mock = new MockRuntime({ modelId: 'mock-model', modelPath: 'x', contextTokens: 4096 })
    await mock.start()
    const text = await collect(mock, 'Welche Länder stoßen am meisten CO2 aus?')
    expect(parseExpansion(text, 'Welche Länder stoßen am meisten CO2 aus?')).toBeNull()
  })

  it('an all-empty reply ({ concepts: [], listTitle: "" }) yields null', () => {
    expect(parseExpansion('{"concepts":[],"listTitle":""}', 'Was ist das?')).toBeNull()
  })

  it('non-string concept entries are ignored; valid string entries among them still survive', () => {
    const result = parseExpansion(
      JSON.stringify({ concepts: [123, { a: 1 }, null, 'Vulkanismus'], listTitle: '' }),
      'Was ist das?'
    )
    expect(result).toEqual({ concepts: ['Vulkanismus'], listTitle: null })
  })
})

describe('buildExpansionMessages — the per-call prompt', () => {
  it('is two messages: a system message naming JSON and both fields, and the question verbatim', () => {
    const question = 'Welche Länder stoßen am meisten CO2 aus?'
    const messages = buildExpansionMessages(question)
    expect(messages).toHaveLength(2)
    const [system, user] = messages
    expect(system.role).toBe('system')
    expect(system.content).toContain('JSON')
    expect(system.content).toContain('concepts')
    expect(system.content).toContain('listTitle')
    expect(user.role).toBe('user')
    expect(user.content).toBe(question)
  })
})

describe('makeQueryExpander — the one bounded call', () => {
  it('returns null (no expander) when the runtime is null or undefined', () => {
    expect(makeQueryExpander(null)).toBeNull()
    expect(makeQueryExpander(undefined)).toBeNull()
  })

  it('parses a JSON reply streamed in pieces and pins the call shape', async () => {
    const rt = scripted(['{"concepts":["Vulkan', 'ismus"],"list', 'Title":""}'])
    const expander = makeQueryExpander(rt)
    expect(expander).not.toBeNull()
    const result = await expander!('Was ist das?')
    expect(result).toEqual({ concepts: ['Vulkanismus'], listTitle: null })
    expect(rt.calls).toBe(1)
    const o = rt.options[0]
    expect(o?.mode).toBe('fast')
    expect(o?.temperature).toBe(0)
    expect(o?.maxTokens).toBe(EXPAND_MAX_TOKENS)
    expect(o?.responseSchema).toBe(EXPAND_RESPONSE_SCHEMA)
    expect(o?.signal).toBeDefined()
  })

  it('a prose reply (no JSON) resolves null', async () => {
    const rt = scripted(['sorry, no structured output here'])
    const expander = makeQueryExpander(rt)
    expect(await expander!('Was ist das?')).toBeNull()
  })

  it('a throwing runtime resolves null', async () => {
    const throwing: ModelRuntime = {
      ...scripted(),
      // eslint-disable-next-line require-yield
      async *chatStream(): AsyncGenerator<string> {
        throw new Error('HTTP 500: llama-server gone')
      }
    }
    const expander = makeQueryExpander(throwing)
    expect(await expander!('Was ist das?')).toBeNull()
  })

  it('a runtime that never ends is cut off by the injected timeout: null, well under 4s, its signal aborted', async () => {
    let sawAbort = false
    const hanging: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            sawAbort = true
            return resolve()
          }
          options?.signal?.addEventListener('abort', () => {
            sawAbort = true
            resolve()
          })
        })
      }
    }
    const expander = makeQueryExpander(hanging, { timeoutMs: 50 })
    const t0 = Date.now()
    const result = await expander!('Was ist das?')
    expect(result).toBeNull()
    expect(Date.now() - t0).toBeLessThan(3_000) // well under EXPAND_TIMEOUT_MS (6000ms)
    expect(sawAbort).toBe(true)
  })

  it('a reply longer than EXPAND_MAX_TOKENS * 8 chars resolves null (runaway output dropped)', async () => {
    const runaway: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        for (;;) {
          if (options?.signal?.aborted) return
          yield 'x'.repeat(EXPAND_MAX_TOKENS * 8 + 1)
        }
      }
    }
    const expander = makeQueryExpander(runaway)
    expect(await expander!('Was ist das?')).toBeNull()
  })

  it('an already-aborted ask signal rejects with AbortError, with zero model calls', async () => {
    const rt = scripted()
    const expander = makeQueryExpander(rt)
    const controller = new AbortController()
    controller.abort()
    await expect(expander!('Was ist das?', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(rt.calls).toBe(0)
  })

  it('the ask signal aborting mid-stream rejects with AbortError — never resolves null', async () => {
    const ctrl = new AbortController()
    const midAbort: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        yield '{"concepts":'
        ctrl.abort()
        if (options?.signal?.aborted) return
        yield '["Vulkanismus"],"listTitle":""}'
      }
    }
    const expander = makeQueryExpander(midAbort)
    await expect(expander!('Was ist das?', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('MOCK INVARIANT: under the real MockRuntime the expansion always degrades to null', async () => {
    const mock = new MockRuntime({ modelId: 'mock-model', modelPath: 'x', contextTokens: 4096 })
    await mock.start()
    const expander = makeQueryExpander(mock)
    expect(await expander!('Welche Länder stoßen am meisten CO2 aus?')).toBeNull()
  })
})
