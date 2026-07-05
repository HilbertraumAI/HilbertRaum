import { describe, it, expect } from 'vitest'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import {
  CATEGORIZER_CATEGORIES,
  CATEGORIZER_BATCH_SIZE,
  buildBatchPrompt,
  batchOutputSchema,
  categorizeTransactions,
  parseRequestedCategories,
  parseTaxonomyCsv,
  parseTaxonomyFileRef,
  prefilterCategory
} from '../../src/main/services/skills/categorizer'
import { categorizeRow, type TransactionInput } from '../../src/main/services/skills/tools/bank-statement'

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

describe('categorizer — deterministic categorizeRow agrees with the prefilter (audit C-1)', () => {
  it('a coincidental substring neither prefilters NOR deterministically categorizes by the keyword', () => {
    // The two paths must agree: 'fee'⊂'coffee', 'atm'⊂'atmos', 'lohn'⊂'mühlohn' fire NEITHER rule.
    const cases: Array<[string, string]> = [
      ['Coffee Fellows', 'Fees'],
      ['ATMOS Sportswear', 'Cash'],
      ['Baeckerei Muehlohn', 'Income']
    ]
    for (const [desc, keywordCategory] of cases) {
      expect(prefilterCategory(row(desc, -4.2))).toBeNull()
      expect(categorizeRow(row(desc, -4.2))).not.toBe(keywordCategory)
    }
  })

  it('a real keyword as its own word both prefilters AND categorizes the same way', () => {
    expect(prefilterCategory(row('Monatliche Gebühr', -3.5))).toBe('Fees')
    expect(categorizeRow(row('Monatliche Gebühr', -3.5))).toBe('Fees')
  })
})

describe('categorizer — transfer boilerplate is demoted from the confident prefilter (R3 / audit §5.5)', () => {
  // `sepa`/`überweisung` describe the payment RAILS, not the merchant; most de-AT rows carry them, so
  // they must NOT veto the model. The prefilter returns null (→ ask the model) while `categorizeRow`
  // (the deterministic NO-model fallback) still labels them 'Transfer' when no runtime is loaded.
  const boilerplate = [
    'SEPA-Lastschrift NETFLIX INTERNATIONAL',
    'SEPA-Dauerauftrag Miete Objekt 3',
    'SEPA Gutschrift Arztpraxis Dr. Huber',
    'Überweisung an Max Mustermann'
  ]

  it('prefilterCategory sends transfer-boilerplate rows to the model (returns null)', () => {
    for (const desc of boilerplate) {
      expect(prefilterCategory(row(desc, -12.99))).toBeNull()
    }
  })

  it('categorizeRow (no-model fallback) still labels the same rows Transfer', () => {
    for (const desc of boilerplate) {
      expect(categorizeRow(row(desc, -12.99))).toBe('Transfer')
    }
  })

  it('SKA-44 (R9): the English `transfer` keyword is demoted too — an EN transfer row reaches the model', () => {
    // R3 demoted only the de-AT pair; the EN `transfer` twin has the same rails-not-merchant semantics
    // ("TRANSFER TO NETFLIX…" is a Netflix charge), so it now goes to the LLM batch instead of being
    // pre-filtered into 'Transfer'. The deterministic no-model fallback still labels it Transfer.
    for (const desc of ['TRANSFER TO NETFLIX INTERNATIONAL B.V.', 'Bank transfer to savings']) {
      expect(prefilterCategory(row(desc, -100))).toBeNull()
      expect(categorizeRow(row(desc, -100))).toBe('Transfer')
    }
  })

  it('SKA-44: with a runtime, the EN transfer row is IN the model batch and takes the richer bucket', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(
      validReplyFor((desc) => (desc.includes('NETFLIX') ? 'Shopping' : 'Uncategorized')),
      calls
    )
    const rows = [row('Kontoführung Gebühr', -3.5), row('TRANSFER TO NETFLIX INTERNATIONAL', -12.99)]
    const { assignments, modelAssisted } = await categorizeTransactions(rows, {
      runtime,
      signal: new AbortController().signal
    })
    expect(modelAssisted).toBe(true)
    expect(assignments).toEqual([
      { index: 0, category: 'Fees' }, // confident keyword — still prefiltered, never sent
      { index: 1, category: 'Shopping' } // the EN transfer row reached the model (pre-R9: vetoed to 'Transfer')
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].messages[1].content).toContain('NETFLIX')
  })

  it('with a runtime, a SEPA row reaches the model and gets its richer category (not Transfer)', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(
      validReplyFor((desc) => (desc.includes('NETFLIX') ? 'Shopping' : 'Uncategorized')),
      calls
    )
    // A confident Gebühr row is prefiltered; the SEPA-Netflix row is NOT (it must go to the model).
    const rows = [row('Kontoführung Gebühr', -3.5), row('SEPA-Lastschrift NETFLIX INTERNATIONAL', -12.99)]
    const { assignments, modelAssisted } = await categorizeTransactions(rows, {
      runtime,
      signal: new AbortController().signal
    })
    expect(modelAssisted).toBe(true)
    expect(assignments).toEqual([
      { index: 0, category: 'Fees' }, // prefiltered — never sent to the model
      { index: 1, category: 'Shopping' } // routed to the model, which chose a richer bucket than 'Transfer'
    ])
    expect(calls).toHaveLength(1)
    const sent = calls[0].messages[1].content
    expect(sent).toContain('NETFLIX') // the SEPA row WAS sent to the model
    expect(sent).not.toContain('Gebühr') // the confident row was NOT
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

  it('retries a batch ONCE on an unparseable (truncated) reply, then succeeds (audit L-1)', async () => {
    let n = 0
    const runtime = scriptedRuntime((call) => {
      n += 1
      // First reply is TRUNCATED mid-JSON (a verbose batch overran the token budget) → JSON.parse throws.
      if (n === 1) return '{"assignments":[{"index":0,"category":"Sho'
      // The single retry returns a clean, complete reply.
      return validReplyFor(() => 'Shopping')(call)
    })
    const rows = [row('Amazon', -20), row('Zalando', -50)]
    const { assignments } = await categorizeTransactions(rows, { runtime, signal: new AbortController().signal })
    expect(n).toBe(2) // initial attempt + exactly one retry
    expect(assignments.every((a) => a.category === 'Shopping')).toBe(true)
  })

  it('does not retry past one attempt — a persistently unparseable reply drops to Uncategorized (audit L-1)', async () => {
    let n = 0
    const runtime = scriptedRuntime(() => {
      n += 1
      return 'still prose, not JSON'
    })
    const rows = [row('Amazon', -20), row('Zalando', -50)]
    const { assignments } = await categorizeTransactions(rows, { runtime, signal: new AbortController().signal })
    expect(n).toBe(2) // one initial + one retry, then give up
    expect(assignments.every((a) => a.category === 'Uncategorized')).toBe(true)
  })

  it('drops a batch whose reply blows the output char cap, without retrying (audit L-2)', async () => {
    // A looping runtime that ignores maxTokens streams far more than the char cap → the batch is bounded
    // and dropped to Uncategorized rather than accumulating output unbounded into memory.
    let n = 0
    const runtime = scriptedRuntime(() => {
      n += 1
      return 'x '.repeat(100_000)
    })
    const rows = [row('Amazon', -20), row('Zalando', -50)]
    const { assignments } = await categorizeTransactions(rows, { runtime, signal: new AbortController().signal })
    expect(n).toBe(1) // a runaway reply is NOT retried (that would just repeat the cost)
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

// The exact batch boundary + empty input (audit T-1). The 25-row test above BRACKETS the boundary but
// does not NAIL the off-by-one: exactly CATEGORIZER_BATCH_SIZE rows must stay ONE call, and the empty
// case must not call the model at all. `Shop N` never prefilters (no Fees/Income/Transfer/Cash keyword),
// so every row is genuinely model-bound — the call count IS the batch count.
describe('categorizeTransactions — batch boundary & empty input (audit T-1)', () => {
  it('exactly 20 model-bound rows → ONE call; 21 → two (pins the off-by-one at the boundary)', async () => {
    expect(CATEGORIZER_BATCH_SIZE).toBe(20) // the boundary the two counts below bracket

    const callsAt: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtimeAt = scriptedRuntime(validReplyFor(() => 'Shopping'), callsAt)
    const rowsAt = Array.from({ length: 20 }, (_, i) => row(`Shop ${i}`, -i - 1))
    const at = await categorizeTransactions(rowsAt, { runtime: runtimeAt, signal: new AbortController().signal })
    expect(callsAt).toHaveLength(1) // a full batch is NOT split — a batch-size off-by-one would make this 2
    expect(at.assignments).toHaveLength(20)
    expect(at.assignments.every((a) => a.category === 'Shopping')).toBe(true)

    const callsPast: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtimePast = scriptedRuntime(validReplyFor(() => 'Shopping'), callsPast)
    const rowsPast = Array.from({ length: 21 }, (_, i) => row(`Shop ${i}`, -i - 1))
    await categorizeTransactions(rowsPast, { runtime: runtimePast, signal: new AbortController().signal })
    expect(callsPast).toHaveLength(2) // one past the boundary spills into a second batch
  })

  it('a single model-bound row is exactly one model call', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(validReplyFor(() => 'Shopping'), calls)
    const { assignments } = await categorizeTransactions([row('Shop 0', -1)], {
      runtime,
      signal: new AbortController().signal
    })
    expect(calls).toHaveLength(1)
    expect(assignments).toEqual([{ index: 0, category: 'Shopping' }])
  })

  it('an empty input makes NO model call and returns an empty result (modelAssisted false)', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    // The reply throws if reached — but `calls` is appended BEFORE the reply runs, so an empty `calls`
    // proves chatStream was never entered. The empty-input guard returns before any batch loop.
    const runtime = scriptedRuntime(() => {
      throw new Error('the model must not be consulted for an empty input')
    }, calls)
    const { assignments, modelAssisted } = await categorizeTransactions([], {
      runtime,
      signal: new AbortController().signal
    })
    expect(assignments).toEqual([])
    expect(modelAssisted).toBe(false) // dropping the rows>0 guard would flip this to true (teeth)
    expect(calls).toHaveLength(0)
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

// ---- Custom category sets from the prompt (result-tables plan, Phase 1.5) ----

describe('parseRequestedCategories', () => {
  it('parses a German list and cuts the trailing export clause', () => {
    expect(
      parseRequestedCategories('Kategorisiere alle Transaktionen in Miete, Lebensmittel, Kinder und Sonstiges und exportiere als CSV')
    ).toEqual(['Miete', 'Lebensmittel', 'Kinder', 'Sonstiges'])
  })

  it('parses an English list ("categorize into … and give me a CSV")', () => {
    expect(
      parseRequestedCategories('categorize the transactions into rent, groceries, kids and other and give me a CSV')
    ).toEqual(['rent', 'groceries', 'kids', 'other'])
  })

  it('cuts an "als CSV" tail without a verb ("… und Sonstiges als CSV")', () => {
    expect(parseRequestedCategories('Kategorisiere in Miete, Kinder als CSV')).toEqual(['Miete', 'Kinder'])
  })

  it('returns null without a categorize stem, or with fewer than two labels', () => {
    expect(parseRequestedCategories('Liste alles in Miete, Kinder auf')).toBeNull() // no stem
    expect(parseRequestedCategories('Kategorisiere die Buchungen in diesem Auszug')).toBeNull() // 1 token
    expect(parseRequestedCategories('Kategorisiere alle Transaktionen und gib sie als CSV aus')).toBeNull()
  })

  it('rejects the WHOLE parse on a bad token (never silently categorizes into garbage)', () => {
    // A swallowed clause exceeds the 4-word/label-shape bound → null, not a partial list.
    expect(
      parseRequestedCategories('Kategorisiere in Miete, zeige mir dann bitte alle einzelnen Buchungen an')
    ).toBeNull()
    expect(parseRequestedCategories('categorize into csv, json')).toBeNull() // format words are not labels
  })

  it('dedupes case-insensitively keeping the first casing', () => {
    expect(parseRequestedCategories('Kategorisiere in Miete, miete, Kinder')).toEqual(['Miete', 'Kinder'])
  })
})

describe('categorizeTransactions — custom category set (Phase 1.5)', () => {
  it('constrains the enum to the custom labels + Uncategorized and skips the prefilter', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(
      validReplyFor((desc) => (desc.includes('REWE') ? 'Lebensmittel' : 'Sonstiges')),
      calls
    )
    // 'Salary' would be prefiltered (Income) on the FIXED taxonomy — with a custom set it must go
    // to the model instead (Income is not one of the user's labels).
    const rows = [row('REWE Markt', -45.9), row('Salary', 2500)]
    const { assignments, modelAssisted } = await categorizeTransactions(rows, {
      runtime,
      signal: new AbortController().signal,
      categories: ['Lebensmittel', 'Sonstiges']
    })
    expect(modelAssisted).toBe(true)
    expect(assignments).toEqual([
      { index: 0, category: 'Lebensmittel' },
      { index: 1, category: 'Sonstiges' }
    ])
    expect(calls).toHaveLength(1) // both rows in one batch — no prefilter skimmed Salary off
    const schema = calls[0].options?.responseSchema as any
    expect(schema.properties.assignments.items.properties.category.enum).toEqual([
      'Lebensmittel',
      'Sonstiges',
      'Uncategorized'
    ])
    expect(calls[0].messages[0].content).toContain('- Lebensmittel')
    expect(calls[0].messages[0].content).not.toContain('Groceries') // fixed taxonomy absent
  })

  it('drops an off-set label (even a FIXED-taxonomy one) to Uncategorized', async () => {
    const runtime = scriptedRuntime(validReplyFor(() => 'Groceries')) // valid in the fixed set, not here
    const { assignments } = await categorizeTransactions([row('REWE Markt', -45.9)], {
      runtime,
      signal: new AbortController().signal,
      categories: ['Lebensmittel', 'Sonstiges']
    })
    expect(assignments).toEqual([{ index: 0, category: 'Uncategorized' }])
  })

  it('with no runtime a custom set returns every row Uncategorized (never rule labels)', async () => {
    const { assignments, modelAssisted } = await categorizeTransactions([row('Gehalt', 2500)], {
      runtime: null,
      signal: new AbortController().signal,
      categories: ['Lebensmittel', 'Sonstiges']
    })
    expect(modelAssisted).toBe(false)
    expect(assignments).toEqual([{ index: 0, category: 'Uncategorized' }]) // NOT 'Income'
  })
})

// ---- Taxonomy CSV referenced from the prompt (result-tables plan, Phase 1.6) ----

describe('parseTaxonomyFileRef', () => {
  it('finds a bare .csv token after a categorize stem (DE + EN)', () => {
    expect(parseTaxonomyFileRef('Kategorisiere nach den Kategorien in taxonomie.csv als CSV')).toBe('taxonomie.csv')
    expect(parseTaxonomyFileRef('categorize the transactions using my-buckets.csv')).toBe('my-buckets.csv')
  })

  it('prefers a quoted name (spaces allowed inside quotes)', () => {
    expect(parseTaxonomyFileRef('Kategorisiere nach „meine Kategorien 2026.csv“ bitte')).toBe(
      'meine Kategorien 2026.csv'
    )
  })

  it('returns null without a categorize stem or without a .csv token', () => {
    expect(parseTaxonomyFileRef('fasse taxonomie.csv zusammen')).toBeNull() // no categorize stem
    expect(parseTaxonomyFileRef('Kategorisiere alle Transaktionen als CSV')).toBeNull() // "als CSV" ≠ a filename
  })

  it('reduces a FULL PATH to its basename (Unix, Windows, quoted) — the library stores titles, not paths', () => {
    expect(
      parseTaxonomyFileRef('Kategorisiere nach /home/vldmr/Dokumente/HVB/taxonomie.csv bitte')
    ).toBe('taxonomie.csv')
    expect(parseTaxonomyFileRef("Kategorisiere nach '/home/vldmr/Dokumente/HVB/taxonomie.csv'")).toBe(
      'taxonomie.csv'
    )
    expect(parseTaxonomyFileRef('categorize using C:\\Users\\v\\Dokumente\\buckets.csv')).toBe('buckets.csv')
  })
})

describe('parseTaxonomyCsv', () => {
  it('parses labels + keyword glosses (DE semicolon CSV), skipping the header row', () => {
    expect(
      parseTaxonomyCsv('Kategorie;Stichworte\nLebensmittel;REWE, Supermarkt\nKinder;Schule, Kita\nSonstiges')
    ).toEqual([
      { name: 'Lebensmittel', gloss: 'REWE, Supermarkt' },
      { name: 'Kinder', gloss: 'Schule, Kita' },
      { name: 'Sonstiges' }
    ])
  })

  it('parses a plain one-label-per-line list (no delimiter, no header) and skips # comments', () => {
    expect(parseTaxonomyCsv('# meine Kategorien\nMiete\nReisen\n\nSonstiges')).toEqual([
      { name: 'Miete' },
      { name: 'Reisen' },
      { name: 'Sonstiges' }
    ])
  })

  it('rejects the WHOLE file on one invalid label, and rejects a single-label list', () => {
    expect(parseTaxonomyCsv('Miete\nDies ist keine Kategorie sondern ein ganzer Satz mit vielen Wörtern')).toBeNull()
    expect(parseTaxonomyCsv('Kategorie;Stichworte\nMiete;Wohnung')).toBeNull() // one label after the header
  })

  it('dedupes labels case-insensitively keeping the first', () => {
    expect(parseTaxonomyCsv('Miete\nmiete\nKinder')).toEqual([{ name: 'Miete' }, { name: 'Kinder' }])
  })

  it('accepts real-world label shapes in a FILE (slash, ampersand, plus, dot) — wider than inline', () => {
    expect(parseTaxonomyCsv('Kfz/Auto\nEssen & Trinken\nVers. + Vorsorge')).toEqual([
      { name: 'Kfz/Auto' },
      { name: 'Essen & Trinken' },
      { name: 'Vers. + Vorsorge' }
    ])
  })
})

describe('categorizeTransactions — taxonomy glosses reach the model prompt (Phase 1.6)', () => {
  it('lists each custom label with its gloss; the enum stays names-only', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(validReplyFor(() => 'Kinder'), calls)
    await categorizeTransactions([row('KITA Beitrag', -120)], {
      runtime,
      signal: new AbortController().signal,
      categories: [
        { name: 'Kinder', gloss: 'Schule, Kita, Taschengeld' },
        { name: 'Sonstiges' }
      ]
    })
    const system = calls[0].messages[0].content
    expect(system).toContain('- Kinder (Schule, Kita, Taschengeld)')
    expect(system).toContain('- Sonstiges')
    const schema = calls[0].options?.responseSchema as any
    expect(schema.properties.assignments.items.properties.category.enum).toEqual([
      'Kinder',
      'Sonstiges',
      'Uncategorized'
    ])
  })
})
