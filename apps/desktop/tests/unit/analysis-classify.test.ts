import { describe, it, expect } from 'vitest'
import {
  CLASSIFY_MAX_TOKENS,
  CLASSIFY_NONE,
  buildClassifyMessages,
  classifyResponseSchema,
  classifySkillPointer,
  type ClassifyCandidate
} from '../../src/main/services/analysis/classify'
import { MockRuntime } from '../../src/main/services/runtime/mock'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// Issue #80 (wave R80; STR-1 §5.2) — the constrained skill-pointer classifier. The contract under
// test: ONE grammar-constrained call at temperature 0 over an enum of gated skill ids + a
// mandatory `none`; EVERY fault (no runtime, no candidates, prose/off-list/truncated reply,
// timeout, abort, runaway output) returns null — silent degrade, no retry, no throw. The
// MockRuntime leg is the load-bearing invariant: the mock ignores `responseSchema` and replies
// prose, so mock/dev mode ALWAYS takes the degrade path — byte-identical behaviour to a build
// without the classifier.

const CANDIDATES: ClassifyCandidate[] = [
  { installId: 'app:bank-statement', title: 'Bank Statement Analysis' },
  { installId: 'app:invoice', title: 'Invoice Analysis' }
]

interface ScriptedRuntime extends ModelRuntime {
  calls: number
  options: Array<RuntimeChatOptions | undefined>
  messages: ChatMessage[][]
}

/** A runtime that replies with a fixed token list (default: one valid JSON pick). */
function scripted(replies: string[] = ['{"skill":"app:bank-statement"}']): ScriptedRuntime {
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

const deps = (runtime: ModelRuntime | null, signal = new AbortController().signal) => ({
  runtime,
  signal
})

describe('classifyResponseSchema — the D55 enum contract', () => {
  it('is one object whose skill field enumerates the candidate ids + the mandatory none', () => {
    const schema = classifyResponseSchema(CANDIDATES)
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['skill'])
    expect(schema.properties?.skill?.enum).toEqual(['app:bank-statement', 'app:invoice', CLASSIFY_NONE])
  })

  it('none is present even over an empty candidate list (the enum can never be empty)', () => {
    expect(classifyResponseSchema([]).properties?.skill?.enum).toEqual([CLASSIFY_NONE])
  })
})

describe('classifySkillPointer — the single bounded call', () => {
  it('returns the picked candidate and pins the call shape (temp 0, schema, budget, prompt)', async () => {
    const rt = scripted()
    const picked = await classifySkillPointer('kategorisiere alle transaktionen', CANDIDATES, deps(rt))
    expect(picked).toEqual({ installId: 'app:bank-statement', title: 'Bank Statement Analysis' })
    expect(rt.calls).toBe(1)
    const o = rt.options[0]
    expect(o?.temperature).toBe(0)
    expect(o?.maxTokens).toBe(CLASSIFY_MAX_TOKENS)
    expect(o?.responseSchemaName).toBe('skill_pointer')
    expect(o?.responseSchema?.properties?.skill?.enum).toEqual([
      'app:bank-statement',
      'app:invoice',
      CLASSIFY_NONE
    ])
    // The prompt still DESCRIBES the shape (llama-server never injects the schema into the
    // prompt) and prefers `none`; the question rides the user turn only (content stays content).
    const [system, user] = rt.messages[0]
    expect(system.content).toContain('"none"')
    expect(system.content).toContain('app:bank-statement')
    expect(system.content).toContain('Bank Statement Analysis')
    expect(user.content).toContain('kategorisiere alle transaktionen')
  })

  it('a "none" reply returns null (the honest drop target)', async () => {
    expect(await classifySkillPointer('q', CANDIDATES, deps(scripted([`{"skill":"${CLASSIFY_NONE}"}`])))).toBeNull()
  })

  it('a parse failure returns null WITHOUT a retry — single-shot by design', async () => {
    const rt = scripted(['sorry, no structured output here'])
    expect(await classifySkillPointer('q', CANDIDATES, deps(rt))).toBeNull()
    expect(rt.calls).toBe(1)
  })

  it('an off-list id and a JSON reply without a skill field both return null', async () => {
    expect(await classifySkillPointer('q', CANDIDATES, deps(scripted(['{"skill":"app:not-a-candidate"}'])))).toBeNull()
    expect(await classifySkillPointer('q', CANDIDATES, deps(scripted(['{"other":true}'])))).toBeNull()
  })

  it('no runtime and no candidates each return null with ZERO model calls', async () => {
    expect(await classifySkillPointer('q', CANDIDATES, deps(null))).toBeNull()
    const rt = scripted()
    expect(await classifySkillPointer('q', [], deps(rt))).toBeNull()
    expect(rt.calls).toBe(0)
  })

  it('a pre-aborted signal returns null with zero calls; an abort mid-stream returns null', async () => {
    const rt = scripted()
    const aborted = new AbortController()
    aborted.abort()
    expect(await classifySkillPointer('q', CANDIDATES, deps(rt, aborted.signal))).toBeNull()
    expect(rt.calls).toBe(0)

    // Abort between tokens: the accumulated prefix must NOT be parsed as a pick.
    const ctrl = new AbortController()
    const midAbort: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        yield '{"skill":'
        ctrl.abort()
        if (options?.signal?.aborted) return
        yield '"app:bank-statement"}'
      }
    }
    expect(await classifySkillPointer('q', CANDIDATES, deps(midAbort, ctrl.signal))).toBeNull()
  })

  it('a runtime that hangs is cut off by the wall-clock bound (null, no throw)', async () => {
    const hanging: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        // Never yields until the (inner) signal aborts — the timeout must fire and degrade.
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve()
          options?.signal?.addEventListener('abort', () => resolve())
        })
      }
    }
    const t0 = Date.now()
    expect(await classifySkillPointer('q', CANDIDATES, { ...deps(hanging), timeoutMs: 30 })).toBeNull()
    expect(Date.now() - t0).toBeLessThan(5_000) // bounded — never the vitest budget
  })

  it('a throwing runtime degrades to null (dead sidecar mid-turn)', async () => {
    const throwing: ModelRuntime = {
      ...scripted(),
      // eslint-disable-next-line require-yield
      async *chatStream(): AsyncGenerator<string> {
        throw new Error('HTTP 500: llama-server gone')
      }
    }
    expect(await classifySkillPointer('q', CANDIDATES, deps(throwing))).toBeNull()
  })

  it('a runaway reply past the char cap is dropped (L-2 posture), not accumulated', async () => {
    const runaway: ModelRuntime = {
      ...scripted(),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        for (;;) {
          if (options?.signal?.aborted) return
          yield 'x'.repeat(64)
        }
      }
    }
    expect(await classifySkillPointer('q', CANDIDATES, deps(runaway))).toBeNull()
  })

  it('MOCK INVARIANT: under the real MockRuntime the classification always degrades to null', async () => {
    // The MockRuntime ignores `responseSchema` and echoes prose — unparseable here by
    // construction. This is the tested guarantee that mock/dev mode behaves byte-identically
    // to a build without the classifier (issue #80 owner decision 2).
    const mock = new MockRuntime({ modelId: 'mock-model', modelPath: 'x', contextTokens: 4096 })
    await mock.start()
    expect(await classifySkillPointer('categorize all transactions', CANDIDATES, deps(mock))).toBeNull()
  })

  it('buildClassifyMessages lists every candidate with id AND title', () => {
    const [system] = buildClassifyMessages('q', CANDIDATES)
    for (const c of CANDIDATES) {
      expect(system.content).toContain(c.installId)
      expect(system.content).toContain(c.title)
    }
  })
})
