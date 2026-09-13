import { describe, it, expect } from 'vitest'
import {
  PLAN_MAX_QUERIES,
  PLAN_MAX_STRING_CHARS,
  PLAN_MAX_TERMS,
  PLAN_MAX_TITLES,
  PLAN_MAX_TOKENS,
  PLAN_RESPONSE_SCHEMA,
  PLAN_TIMEOUT_MS,
  buildPlanMessages,
  makeQueryExpander,
  parsePlan
} from '../../src/main/services/zim/expand'
import { EXTERNAL_RETRIEVAL_DEADLINE_MS } from '../../src/main/services/zim/arm'
import { MockRuntime } from '../../src/main/services/runtime/mock'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// Phase 4 PR-A (`docs/rag-design.md` §17 "Discovery port") — the search PLAN the knowledge-pack
// arm's discovery routes are built around: `parsePlan` defensively parses a model reply into
// route F's `{titles, queries, terms}` shape (`prototype.mjs`'s own `interpret()` parse:
// malformed JSON or a non-object degrades to an EMPTY plan, never null, never throws);
// `makeQueryExpander` wraps ONE grammar-constrained, temperature-0 call with its own wall-clock
// bound and degrades the WHOLE CALL to null on every failure except the ask's own abort, which
// is rethrown — mirroring the expander this replaces and `classify.ts`'s `classifySkillPointer`
// (issue #80), the precedent module for this shape.

interface ScriptedRuntime extends ModelRuntime {
  calls: number
  options: Array<RuntimeChatOptions | undefined>
  messages: ChatMessage[][]
}

/** A runtime that replies with a fixed token list (default: one valid JSON plan). */
function scripted(replies: string[] = ['{"titles":["Vulkanismus"],"queries":[],"terms":[]}']): ScriptedRuntime {
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

describe('parsePlan — defensively parsing the model reply (route F interpret() semantics)', () => {
  it('a well-formed reply yields titles + queries + terms', () => {
    const result = parsePlan(
      '{"titles":["Vulkanismus","Wattenmeer"],"queries":["Vulkan Ausbruch"],"terms":["Höhe","Lage"]}'
    )
    expect(result).toEqual({
      titles: ['Vulkanismus', 'Wattenmeer'],
      queries: ['Vulkan Ausbruch'],
      terms: ['Höhe', 'Lage']
    })
  })

  it('a <think> block before the JSON is stripped (chat.ts stripThinkBlocks)', () => {
    const result = parsePlan('<think>the user wants volcanoes</think>{"titles":["Vulkanismus"],"queries":[],"terms":[]}')
    expect(result).toEqual({ titles: ['Vulkanismus'], queries: [], terms: [] })
  })

  it('malformed JSON degrades to an EMPTY plan — never null, never throws', () => {
    expect(parsePlan('not json at all')).toEqual({ titles: [], queries: [], terms: [] })
    expect(parsePlan('{"titles": [oops}')).toEqual({ titles: [], queries: [], terms: [] })
    expect(parsePlan('')).toEqual({ titles: [], queries: [], terms: [] })
  })

  it('non-object JSON ([], "x", 42) all yield an empty plan', () => {
    expect(parsePlan('[]')).toEqual({ titles: [], queries: [], terms: [] })
    expect(parsePlan('"x"')).toEqual({ titles: [], queries: [], terms: [] })
    expect(parsePlan('42')).toEqual({ titles: [], queries: [], terms: [] })
  })

  it('a missing field degrades to [] for that field only', () => {
    expect(parsePlan('{"titles":["A"]}')).toEqual({ titles: ['A'], queries: [], terms: [] })
    expect(parsePlan('{"queries":["a b"],"terms":["c"]}')).toEqual({ titles: [], queries: ['a b'], terms: ['c'] })
  })

  it('non-string entries are dropped; valid string entries among them still survive', () => {
    const result = parsePlan(JSON.stringify({ titles: [123, { a: 1 }, null, 'Vulkanismus'], queries: [], terms: [] }))
    expect(result.titles).toEqual(['Vulkanismus'])
  })

  it('each field is capped at its own PLAN_MAX_* count, keeping the first entries in order', () => {
    const titles = ['A', 'B', 'C', 'D', 'E']
    const queries = ['q1', 'q2', 'q3']
    const terms = ['t1', 't2', 't3', 't4', 't5', 't6', 't7']
    const result = parsePlan(JSON.stringify({ titles, queries, terms }))
    expect(PLAN_MAX_TITLES).toBe(3)
    expect(PLAN_MAX_QUERIES).toBe(2)
    expect(PLAN_MAX_TERMS).toBe(5)
    expect(result.titles).toEqual(titles.slice(0, PLAN_MAX_TITLES))
    expect(result.queries).toEqual(queries.slice(0, PLAN_MAX_QUERIES))
    expect(result.terms).toEqual(terms.slice(0, PLAN_MAX_TERMS))
  })

  it('a string longer than PLAN_MAX_STRING_CHARS is dropped whole, never cut to fit (route F: x.length<=140)', () => {
    expect(PLAN_MAX_STRING_CHARS).toBe(140)
    const tooLong = 'a'.repeat(PLAN_MAX_STRING_CHARS + 1)
    const result = parsePlan(JSON.stringify({ titles: [tooLong, 'Kork'], queries: [], terms: [] }))
    expect(result.titles).toEqual(['Kork'])
  })

  it('an empty or whitespace-only string is dropped', () => {
    const result = parsePlan(JSON.stringify({ titles: ['', '   ', 'Kork'], queries: [], terms: [] }))
    expect(result.titles).toEqual(['Kork'])
  })

  it('entries are trimmed', () => {
    const result = parsePlan(JSON.stringify({ titles: ['  Kork  '], queries: [], terms: [] }))
    expect(result.titles).toEqual(['Kork'])
  })

  it('does NOT filter plan strings against the plain pattern\'s content-word lists (unlike the expander this replaces) — a plan title/query is used directly', () => {
    // "Liste" is a FRAME word for the plain `/search` pattern rewrite (query-rewrite.ts), but a
    // plan title naming a real "Liste der …" article must survive unfiltered.
    const result = parsePlan(JSON.stringify({ titles: ['Liste der Vulkane'], queries: ['Liste Vulkane'], terms: [] }))
    expect(result.titles).toEqual(['Liste der Vulkane'])
    expect(result.queries).toEqual(['Liste Vulkane'])
  })

  it('non-JSON prose — the mock runtime\'s own reply — yields an empty plan', async () => {
    const mock = new MockRuntime({ modelId: 'mock-model', modelPath: 'x', contextTokens: 4096 })
    await mock.start()
    let text = ''
    for await (const token of mock.chatStream(buildPlanMessages('Welche Länder stoßen am meisten CO2 aus?'))) {
      text += token
    }
    expect(parsePlan(text)).toEqual({ titles: [], queries: [], terms: [] })
  })
})

describe('buildPlanMessages — the per-call prompt', () => {
  it('is two messages: a system message naming JSON and all three fields, and the question verbatim', () => {
    const question = 'Welche Länder stoßen am meisten CO2 aus?'
    const messages = buildPlanMessages(question)
    expect(messages).toHaveLength(2)
    const [system, user] = messages
    expect(system.role).toBe('system')
    expect(system.content).toContain('JSON')
    expect(system.content).toContain('titles')
    expect(system.content).toContain('queries')
    expect(system.content).toContain('terms')
    // Deliberately NOT a hardcoded target language (route F hardcodes German — its one archive
    // IS German Wikipedia; the product's packs are any language, see the file header).
    expect(system.content).toContain('language of the question')
    expect(user.role).toBe('user')
    expect(user.content).toBe(question)
  })
})

describe('makeQueryExpander — the one bounded planner call', () => {
  it('returns null (no planner) when the runtime is null or undefined', () => {
    expect(makeQueryExpander(null)).toBeNull()
    expect(makeQueryExpander(undefined)).toBeNull()
  })

  it('parses a JSON reply streamed in pieces and pins the call shape', async () => {
    const rt = scripted(['{"titles":["Vulkan', 'ismus"],"querie', 's":[],"terms":[]}'])
    const expander = makeQueryExpander(rt)
    expect(expander).not.toBeNull()
    const result = await expander!('Was ist das?')
    expect(result).toEqual({ titles: ['Vulkanismus'], queries: [], terms: [] })
    expect(rt.calls).toBe(1)
    const o = rt.options[0]
    expect(o?.mode).toBe('fast')
    expect(o?.temperature).toBe(0)
    expect(o?.maxTokens).toBe(PLAN_MAX_TOKENS)
    expect(o?.responseSchema).toBe(PLAN_RESPONSE_SCHEMA)
    expect(o?.signal).toBeDefined()
  })

  it('a prose reply (no JSON) resolves the empty plan, not null — the call itself succeeded', async () => {
    const rt = scripted(['sorry, no structured output here'])
    const expander = makeQueryExpander(rt)
    expect(await expander!('Was ist das?')).toEqual({ titles: [], queries: [], terms: [] })
  })

  it('a throwing runtime resolves null (the CALL failed)', async () => {
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

  it('a runtime that never ends is cut off by the injected timeout: null, well under the real bound, its signal aborted', async () => {
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
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(sawAbort).toBe(true)
  })

  it('a reply longer than PLAN_MAX_TOKENS * 8 chars resolves null (runaway output dropped)', async () => {
    const runaway: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        for (;;) {
          if (options?.signal?.aborted) return
          yield 'x'.repeat(PLAN_MAX_TOKENS * 8 + 1)
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
        yield '{"titles":'
        ctrl.abort()
        if (options?.signal?.aborted) return
        yield '["Vulkanismus"],"queries":[],"terms":[]}'
      }
    }
    const expander = makeQueryExpander(midAbort)
    await expect(expander!('Was ist das?', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('MOCK INVARIANT: under the real MockRuntime the planner call resolves the empty plan (its reply is never JSON)', async () => {
    const mock = new MockRuntime({ modelId: 'mock-model', modelPath: 'x', contextTokens: 4096 })
    await mock.start()
    const expander = makeQueryExpander(mock)
    expect(await expander!('Welche Länder stoßen am meisten CO2 aus?')).toEqual({
      titles: [],
      queries: [],
      terms: []
    })
  })
})

// The planner's wall-clock bound is UNCHANGED from the expander it replaces (#423) — still one
// call per ask, still inside the arm's per-ask deadline, still leaving the packs a share of it.
describe('the planner bound stays inside the arm\'s per-ask deadline (#423, unchanged by the discovery port)', () => {
  it('leaves the packs at least a third of the deadline', () => {
    expect(EXTERNAL_RETRIEVAL_DEADLINE_MS - PLAN_TIMEOUT_MS).toBeGreaterThanOrEqual(
      EXTERNAL_RETRIEVAL_DEADLINE_MS / 3
    )
  })

  it('PLAN_TIMEOUT_MS is unchanged at 12 s and PLAN_MAX_TOKENS matches route F\'s interpret() (220)', () => {
    expect(PLAN_TIMEOUT_MS).toBe(12_000)
    expect(PLAN_MAX_TOKENS).toBe(220)
  })
})
