import { describe, it, expect } from 'vitest'
import { tableToCsv, type TableSpec } from '../../src/main/services/tables'

// The generic tabular serializer (result-tables plan §3, D59/D60): columns are data, not code.
// The bank-specific behaviours (fixed-dp money, csvField neutralization, \r\n + trailing newline)
// are pinned in skills-bank-statement-tool.test.ts via `transactionsToCsv`; these tests pin the
// generic contract any future table (invoice, Phase-3 enriched) relies on.

describe('tableToCsv (result-tables Phase 1)', () => {
  const spec = (rows: TableSpec['rows']): TableSpec => ({
    columns: [
      { key: 'name', label: 'name' },
      { key: 'price', label: 'price', kind: 'money' },
      { key: 'qty', label: 'qty', kind: 'integer' }
    ],
    rows
  })

  it('emits header + rows in column order, \\r\\n line ends, trailing newline', () => {
    const csv = tableToCsv(spec([{ name: 'Widget', price: 4.5, qty: 3 }]))
    expect(csv).toBe('name,price,qty\r\nWidget,4.50,3\r\n')
  })

  it('serializes null/undefined cells as empty fields — absent, never invented', () => {
    const csv = tableToCsv(spec([{ name: 'x', price: null, qty: undefined }]))
    expect(csv.trimEnd().split('\r\n')[1]).toBe('x,,')
  })

  it('missing row keys serialize blank; extra row fields are not emitted', () => {
    const csv = tableToCsv(spec([{ name: 'x', price: 1, stray: 'never emitted' }]))
    expect(csv.trimEnd().split('\r\n')[1]).toBe('x,1.00,')
  })

  it('neutralizes formula-shaped text cells AND labels through the shared csvField boundary', () => {
    const csv = tableToCsv({
      columns: [{ key: 'a', label: '=evil' }, { key: 'b', label: 'b' }],
      rows: [{ a: '@cmd', b: 'safe, but quoted' }]
    })
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe("'=evil,b")
    expect(lines[1]).toBe('\'@cmd,"safe, but quoted"')
  })

  it('a string cell in a numeric column is neutralized as text, not coerced', () => {
    const csv = tableToCsv(spec([{ name: 'x', price: '=1+1', qty: '@q' }]))
    expect(csv.trimEnd().split('\r\n')[1]).toBe("x,'=1+1,'@q")
  })
})
