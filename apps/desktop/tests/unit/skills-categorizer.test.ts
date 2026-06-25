import { describe, it, expect } from 'vitest'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import {
  CATEGORIZER_CATEGORIES,
  buildBatchPrompt,
  batchOutputSchema,
  categorizeTransactions,
  prefilterCategory
} from '../../src/main/services/skills/categorizer'
import type { TransactionInput } from '../../src/main/services/skills/tools/bank-statement'

// Unit coverage for the bank-statement LLM categorizer (Phase 33). The MockRuntime IGNORES
// `responseSchema` (exactly like the dev mock runtime), so the drop-to-Uncategorized parse + the
// off-list/out-of-range validation are exercised here, plus the deterministic no-runtime fallback.

/** A scripted runtime whose `chatStream` replies with `reply(call)` token-by-token. */
function scriptedRuntime(
  reply: (call: { messages: ChatMessage[]; options?: RuntimeChatOptions }) => string,
  calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
): ModelRuntime {
  return {
    modelId: 'mock',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const call = { messages, options }
      calls.push(call)
      const text = reply(call)
      for (const tok of text.match(/\S+\s*/g) ?? [text]) {
        if (options?.signal?.aborted) return
        yield tok
      }
    }
  }
}

function row(description: string, amount: number, currency = 'EUR'): TransactionInput {
  return { date: '2026-03-01', description, amount, currency }
}

/** Reply that echoes a valid assignment for every batch index, mapping by a description→category fn. */
function validReplyFor(map: (desc: string) => string) {
  return (call: { messages: ChatMessage[] }): string => {
    const user = call.messages[1].content
    const lines = user.split('\n').filter((l) => /^\d+\t/.test(l))
    const assignments = lines.map((l) => {
      const [idx, , ...rest] = l.split('\t')
      const desc = rest.join('\t')
      return { index: Number(idx), category: map(desc) }
    })
    return JSON.stringify({ assignments })
  }
}

describe('categorizer — fixed taxonomy + grammar contract', () => {
  it('the batch schema constrains category to the fixed enum (never an invented label)', () => {
    const schema = batchOutputSchema()
    const catSchema = (schema.properties as any).assignments.items.properties.category
    expect(catSchema.enum).toEqual([...CATEGORIZER_CATEGORIES])
    expect(CATEGORIZER_CATEGORIES).toContain('Uncategorized')
    expect(CATEGORIZER_CATEGORIES).toContain('Groceries')
  })

  it('buildBatchPrompt renders a batch-local index, signed amount, and trimmed description', () => {
    const prompt = buildBatchPrompt([row('REWE Markt', -45.9), row('Gehalt ACME', 2500)])
    expect(prompt).toContain('0\t-45.90 EUR\tREWE Markt')
    expect(prompt).toContain('1\t+2500.00 EUR\tGehalt ACME')
  })
})

describe('categorizer — prefilter', () => {
  it('a confident description rule (Gebühr → Fees) is returned without the model', () => {
    expect(prefilterCategory(row('Kontofuehrung Gebühr', -3.5))).toBe('Fees')
    expect(prefilterCategory(row('Gehalt', 2500))).toBe('Income')
  })
  it('an unmatched description returns null (→ ask the model)', () => {
    expect(prefilterCategory(row('REWE Markt', -45.9))).toBeNull()
  })
  it('matches on WORD boundaries, not raw substrings (a coincidental match never skips the model)', () => {
    // 'fee' ⊂ 'coffee', 'atm' ⊂ 'atmos', 'lohn' ⊂ 'mühlohn' must NOT prefilter — they go to the model.
    expect(prefilterCategory(row('Coffee Fellows', -4.2))).toBeNull()
    expect(prefilterCategory(row('ATMOS Sportswear', -89))).toBeNull()
    expect(prefilterCategory(row('Baeckerei Muehlohn', -3.1))).toBeNull()
    // A real keyword as its own word still matches (boundary, not equality).
    expect(prefilterCategory(row('Monatliche Gebühr Konto', -3.5))).toBe('Fees')
  })
})

describe('categorizeTransactions — model path', () => {
  it('keeps prefilter matches and assigns the rest from the model', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(
      validReplyFor((desc) => (desc.includes('REWE') ? 'Groceries' : 'Shopping')),
      calls
    )
    const rows = [row('Gebühr', -3.5), row('REWE Markt', -45.9), row('Amazon', -20)]
    const { assignments, modelAssisted } = await categorizeTransactions(rows, {
      runtime,
      signal: new AbortController().signal
    })
    expect(modelAssisted).toBe(true)
    expect(assignments).toEqual([
      { index: 0, category: 'Fees' }, // prefiltered (not sent to model)
      { index: 1, category: 'Groceries' },
      { index: 2, category: 'Shopping' }
    ])
    // Only the two non-prefiltered rows were sent to the model (one batch).
    expect(calls).toHaveLength(1)
    const sent = calls[0].messages[1].content
    expect(sent).toContain('REWE Markt')
    expect(sent).toContain('Amazon')
    expect(sent).not.toContain('Gebühr')
    // The grammar contract was passed through.
    expect(calls[0].options?.responseSchema).toBeTruthy()
  })

  it('drops an off-list category and a missing row to Uncategorized', async () => {
    const runtime = scriptedRuntime((call) => {
      // index 0 gets a bogus (off-list) category; index 1 is omitted entirely.
      void call
      return JSON.stringify({ assignments: [{ index: 0, category: 'NotARealCategory' }] })
    })
    const rows = [row('Foo', -1), row('Bar', -2)]
    const { assignments } = await categorizeTransactions(rows, { runtime, signal: new AbortController().signal })
    expect(assignments).toEqual([
      { index: 0, category: 'Uncategorized' },
      { index: 1, category: 'Uncategorized' }
    ])
  })

  it('drops the WHOLE batch to Uncategorized on an unparseable reply (the mock-prose case)', async () => {
    const runtime = scriptedRuntime(() => 'Sure! Here are your categories: groceries and dining.')
    const rows = [row('A', -1), row('B', -2), row('C', -3)]
    const { assignments } = await categorizeTransactions(rows, { runtime, signal: new AbortController().signal })
    expect(assignments.every((a) => a.category === 'Uncategorized')).toBe(true)
  })

  it('batches in groups of 20 (two model calls for 25 model-bound rows)', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(validReplyFor(() => 'Shopping'), calls)
    const rows = Array.from({ length: 25 }, (_, i) => row(`Shop ${i}`, -i - 1))
    const { assignments } = await categorizeTransactions(rows, { runtime, signal: new AbortController().signal })
    expect(calls).toHaveLength(2)
    expect(assignments).toHaveLength(25)
    expect(assignments.every((a) => a.category === 'Shopping')).toBe(true)
  })
})

describe('categorizeTransactions — no runtime', () => {
  it('falls back to the deterministic rule pass (modelAssisted false)', async () => {
    const rows = [row('Gehalt', 2500), row('Unklar', -9.99)]
    const { assignments, modelAssisted } = await categorizeTransactions(rows, {
      runtime: null,
      signal: new AbortController().signal
    })
    expect(modelAssisted).toBe(false)
    expect(assignments[0]).toEqual({ index: 0, category: 'Income' }) // Gehalt rule
    expect(assignments[1]).toEqual({ index: 1, category: 'Spending' }) // negative sign fallback
  })
})
