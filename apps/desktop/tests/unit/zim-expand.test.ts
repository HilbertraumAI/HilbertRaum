import { describe, it, expect } from 'vitest'
import {
  PLAN_MAX_QUERIES,
  PLAN_MAX_STRING_CHARS,
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
// arm's discovery routes are built around: `parsePlan` defensively parses a model reply into a
// `{titles, queries}` shape (route F's own `{titles, queries, terms}` minus `terms`, dropped by
// F1 part 1 — see the file header of `expand.ts`; `prototype.mjs`'s own `interpret()` parse:
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
function scripted(replies: string[] = ['{"titles":["Vulkanismus"],"queries":[]}']): ScriptedRuntime {
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

describe('parsePlan — defensively parsing the model reply (route F interpret() semantics, minus terms — F1 part 1)', () => {
  it('a well-formed reply yields titles + queries', () => {
    const result = parsePlan('{"titles":["Vulkanismus","Wattenmeer"],"queries":["Vulkan Ausbruch"]}')
    expect(result).toEqual({
      titles: ['Vulkanismus', 'Wattenmeer'],
      queries: ['Vulkan Ausbruch']
    })
  })

  it('a <think> block before the JSON is stripped (chat.ts stripThinkBlocks)', () => {
    const result = parsePlan('<think>the user wants volcanoes</think>{"titles":["Vulkanismus"],"queries":[]}')
    expect(result).toEqual({ titles: ['Vulkanismus'], queries: [] })
  })

  it('a "terms" field in the reply is simply ignored — the schema no longer requests it (F1 part 1)', () => {
    const result = parsePlan('{"titles":["Vulkanismus"],"queries":[],"terms":["Höhe","Lage"]}')
    expect(result).toEqual({ titles: ['Vulkanismus'], queries: [] })
  })

  it('malformed JSON degrades to an EMPTY plan — never null, never throws', () => {
    expect(parsePlan('not json at all')).toEqual({ titles: [], queries: [] })
    expect(parsePlan('{"titles": [oops}')).toEqual({ titles: [], queries: [] })
    expect(parsePlan('')).toEqual({ titles: [], queries: [] })
  })

  it('non-object JSON ([], "x", 42) all yield an empty plan', () => {
    expect(parsePlan('[]')).toEqual({ titles: [], queries: [] })
    expect(parsePlan('"x"')).toEqual({ titles: [], queries: [] })
    expect(parsePlan('42')).toEqual({ titles: [], queries: [] })
  })

  it('a missing field degrades to [] for that field only', () => {
    expect(parsePlan('{"titles":["A"]}')).toEqual({ titles: ['A'], queries: [] })
    expect(parsePlan('{"queries":["a b"]}')).toEqual({ titles: [], queries: ['a b'] })
  })

  it('non-string entries are dropped; valid string entries among them still survive', () => {
    const result = parsePlan(JSON.stringify({ titles: [123, { a: 1 }, null, 'Vulkanismus'], queries: [] }))
    expect(result.titles).toEqual(['Vulkanismus'])
  })

  it('each field is capped at its own PLAN_MAX_* count, keeping the first entries in order', () => {
    const titles = ['A', 'B', 'C', 'D', 'E']
    const queries = ['q1', 'q2', 'q3']
    const result = parsePlan(JSON.stringify({ titles, queries }))
    expect(PLAN_MAX_TITLES).toBe(3)
    expect(PLAN_MAX_QUERIES).toBe(2)
    expect(result.titles).toEqual(titles.slice(0, PLAN_MAX_TITLES))
    expect(result.queries).toEqual(queries.slice(0, PLAN_MAX_QUERIES))
  })

  it('a string longer than PLAN_MAX_STRING_CHARS is dropped whole, never cut to fit (route F: x.length<=140)', () => {
    expect(PLAN_MAX_STRING_CHARS).toBe(140)
    const tooLong = 'a'.repeat(PLAN_MAX_STRING_CHARS + 1)
    const result = parsePlan(JSON.stringify({ titles: [tooLong, 'Kork'], queries: [] }))
    expect(result.titles).toEqual(['Kork'])
  })

  it('an empty or whitespace-only string is dropped', () => {
    const result = parsePlan(JSON.stringify({ titles: ['', '   ', 'Kork'], queries: [] }))
    expect(result.titles).toEqual(['Kork'])
  })

  it('entries are trimmed', () => {
    const result = parsePlan(JSON.stringify({ titles: ['  Kork  '], queries: [] }))
    expect(result.titles).toEqual(['Kork'])
  })

  it('does NOT filter plan strings against the plain pattern\'s content-word lists (unlike the expander this replaces) — a plan title/query is used directly', () => {
    // "Liste" is a FRAME word for the plain `/search` pattern rewrite (query-rewrite.ts), but a
    // plan title naming a real "Liste der …" article must survive unfiltered.
    const result = parsePlan(JSON.stringify({ titles: ['Liste der Vulkane'], queries: ['Liste Vulkane'] }))
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
    expect(parsePlan(text)).toEqual({ titles: [], queries: [] })
  })
})

describe('buildPlanMessages — the per-call prompt', () => {
  it('is two messages: a system message naming JSON and both fields, and the question verbatim', () => {
    const question = 'Welche Länder stoßen am meisten CO2 aus?'
    const messages = buildPlanMessages(question)
    expect(messages).toHaveLength(2)
    const [system, user] = messages
    expect(system.role).toBe('system')
    expect(system.content).toContain('JSON')
    expect(system.content).toContain('titles')
    expect(system.content).toContain('queries')
    // F1 part 1 (review 2026-09-14): route F's own "terms" field/sentence is dropped — never
    // consumed, pure output-token cost. See the file header of `expand.ts`. (The prompt still
    // legitimately says "search terms" in prose, so check for the field-listing shape instead.)
    expect(system.content).not.toContain('relation/attribute terms')
    expect(system.content).not.toMatch(/\bterms:\s/)
    // F7 (review 2026-09-14): the prompt never mentions history — the arm never has any at this
    // layer, so route F's "and its conversation history" clause was dead text.
    expect(system.content).not.toContain('history')
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
    const rt = scripted(['{"titles":["Vulkan', 'ismus"],"querie', 's":[]}'])
    const expander = makeQueryExpander(rt)
    expect(expander).not.toBeNull()
    const result = await expander!('Was ist das?')
    expect(result).toEqual({ titles: ['Vulkanismus'], queries: [] })
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
    expect(await expander!('Was ist das?')).toEqual({ titles: [], queries: [] })
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
        yield '["Vulkanismus"],"queries":[]}'
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
      queries: []
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

  it('PLAN_TIMEOUT_MS is unchanged at 12 s', () => {
    expect(PLAN_TIMEOUT_MS).toBe(12_000)
  })
})

// F1 (review 2026-09-14): PLAN_MAX_TOKENS sits at a PROVISIONAL 220 through this commit only so
// run M can measure the untruncated planner-reply-length distribution on core200 (`docs/
// rag-design.md` §17 F1 record). It is not yet a design pin — the #423 pairing this branch owes
// (`PLAN_TIMEOUT_MS` and `PLAN_MAX_TOKENS`/`PLAN_SLOWEST_MEASURED_TOKENS_PER_SEC` constraining
// each other, mirroring master's `EXPAND_TIMEOUT_MS`/`EXPAND_MAX_TOKENS`/
// `EXPAND_SLOWEST_MEASURED_TOKENS_PER_SEC`) is restored in the cap-decision commit that follows
// run M, once the cap is set by the ruled formula from the measured p99.
