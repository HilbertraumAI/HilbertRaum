import { describe, it, expect } from 'vitest'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import {
  ENRICH_BATCH_SIZE,
  ENRICH_UNKNOWN,
  enrichBatchSchema,
  enrichRows,
  parseTableRequest,
  tableRequestSchema,
  wantsExtraColumns
} from '../../src/main/services/skills/enricher'
import type { TransactionInput } from '../../src/main/services/skills/tools/bank-statement'

// The derived-column enricher (result-tables plan §5, Phase 3): the TableRequest parse contract,
// the per-batch grammar schemas, the fill/unknown/blank honesty rules, and the batching bound.

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
      yield reply(call)
    }
  }
}

function row(description: string, amount: number): TransactionInput {
  return { date: '2026-03-01', description, amount, currency: 'EUR' }
}

const sig = (): AbortSignal => new AbortController().signal

describe('wantsExtraColumns (the deterministic pre-gate)', () => {
  it('fires on column-shaped asks (DE + EN), not on plain format/category asks', () => {
    expect(wantsExtraColumns('als CSV mit einer Spalte Empfänger')).toBe(true)
    expect(wantsExtraColumns('as CSV with a payee column')).toBe(true)
    expect(wantsExtraColumns('mit Unterkategorie als CSV')).toBe(true)
    expect(wantsExtraColumns('show me the statement as CSV')).toBe(false)
    expect(wantsExtraColumns('Kategorisiere in Miete, Kinder und Sonstiges als CSV')).toBe(false)
  })
})

describe('parseTableRequest', () => {
  it('returns validated columns from the schema-forced reply', async () => {
    const runtime = scriptedRuntime(() =>
      JSON.stringify({
        derivedColumns: [{ name: 'Empfänger', description: 'wer das Geld erhielt' }]
      })
    )
    const cols = await parseTableRequest('als CSV mit einer Spalte Empfänger', { runtime, signal: sig() })
    expect(cols).toEqual([{ name: 'Empfänger', description: 'wer das Geld erhielt' }])
  })

  it('an empty list is a VALID outcome; unparseable prose is null', async () => {
    expect(
      await parseTableRequest('x', { runtime: scriptedRuntime(() => '{"derivedColumns":[]}'), signal: sig() })
    ).toEqual([])
    expect(
      await parseTableRequest('x', { runtime: scriptedRuntime(() => 'sure, here you go!'), signal: sig() })
    ).toBeNull()
  })

  it('rejects the WHOLE request when a column shadows a fixed one or fails the name shape (D65)', async () => {
    const shadowing = scriptedRuntime(() =>
      JSON.stringify({ derivedColumns: [{ name: 'Empfänger' }, { name: 'Betrag' }] })
    )
    expect(await parseTableRequest('x', { runtime: shadowing, signal: sig() })).toBeNull()
    const junk = scriptedRuntime(() => JSON.stringify({ derivedColumns: [{ name: '::' }] }))
    expect(await parseTableRequest('x', { runtime: junk, signal: sig() })).toBeNull()
  })

  it('the parse schema bounds the request (≤4 columns, short names)', () => {
    const schema = tableRequestSchema() as never as {
      properties: { derivedColumns: { maxItems: number; items: { properties: { name: { maxLength: number } } } } }
    }
    expect(schema.properties.derivedColumns.maxItems).toBe(4)
    expect(schema.properties.derivedColumns.items.properties.name.maxLength).toBe(40)
  })
})

describe('enrichRows', () => {
  const PAYEE = { name: 'Payee', description: 'who received the money' }

  it('fills every requested column per row; "unknown" serializes as a BLANK cell', async () => {
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime((call) => {
      const lines = call.messages[1].content.split('\n').filter((l) => /^\d+\t/.test(l))
      const assignments = lines.map((l) => {
        const [idx, , ...rest] = l.split('\t')
        const desc = rest.join('\t')
        return {
          index: Number(idx),
          values: { Payee: desc.includes('REWE') ? 'REWE' : ENRICH_UNKNOWN }
        }
      })
      return JSON.stringify({ assignments })
    }, calls)
    const filled = await enrichRows([row('REWE Markt', -45.9), row('Gehalt', 2500)], [PAYEE], {
      runtime,
      signal: sig()
    })
    expect(filled).toEqual([{ Payee: 'REWE' }, { Payee: '' }]) // unknown → blank, never a guess
    // The enum-free value property is length-capped in the batch grammar.
    const schema = calls[0].options?.responseSchema as never as {
      properties: { assignments: { items: { properties: { values: { properties: Record<string, { maxLength?: number }> } } } } }
    }
    expect(schema.properties.assignments.items.properties.values.properties.Payee.maxLength).toBe(60)
  })

  it('an enum column drops an off-enum value to blank (mock runtimes ignore the grammar)', async () => {
    const runtime = scriptedRuntime(() =>
      JSON.stringify({ assignments: [{ index: 0, values: { Art: 'Sonstiges' } }] })
    )
    const filled = await enrichRows([row('X', -1)], [{ name: 'Art', enumValues: ['Fix', 'Variabel'] }], {
      runtime,
      signal: sig()
    })
    expect(filled).toEqual([{ Art: '' }])
    // The enum schema carries the unknown drop target.
    const schema = enrichBatchSchema([{ name: 'Art', enumValues: ['Fix', 'Variabel'] }]) as never as {
      properties: { assignments: { items: { properties: { values: { properties: Record<string, { enum: string[] }> } } } } }
    }
    expect(schema.properties.assignments.items.properties.values.properties.Art.enum).toEqual([
      'Fix',
      'Variabel',
      ENRICH_UNKNOWN
    ])
  })

  it('an unparseable batch retries once, then drops to blanks (the categorizer posture)', async () => {
    const calls: Array<{ messages: ChatMessage[] }> = []
    const runtime = scriptedRuntime(() => 'not json', calls as never)
    const filled = await enrichRows([row('X', -1)], [PAYEE], { runtime, signal: sig() })
    expect(filled).toEqual([{ Payee: '' }])
    expect(calls).toHaveLength(2) // one retry, then honest blanks
  })

  it('batches past ENRICH_BATCH_SIZE and maps batch-local indices back globally', async () => {
    const calls: Array<{ messages: ChatMessage[] }> = []
    const runtime = scriptedRuntime((call) => {
      const lines = call.messages[1].content.split('\n').filter((l) => /^\d+\t/.test(l))
      return JSON.stringify({
        assignments: lines.map((l) => ({
          index: Number(l.split('\t')[0]),
          values: { Payee: l.split('\t')[2] } // echo the description back as the value
        }))
      })
    }, calls as never)
    const rows = Array.from({ length: ENRICH_BATCH_SIZE + 2 }, (_, i) => row(`P${i}`, -1))
    const filled = await enrichRows(rows, [PAYEE], { runtime, signal: sig() })
    expect(calls).toHaveLength(2)
    expect(filled[0]).toEqual({ Payee: 'P0' })
    expect(filled[ENRICH_BATCH_SIZE]).toEqual({ Payee: `P${ENRICH_BATCH_SIZE}` }) // second batch, global index
    expect(filled[ENRICH_BATCH_SIZE + 1]).toEqual({ Payee: `P${ENRICH_BATCH_SIZE + 1}` })
  })
})
