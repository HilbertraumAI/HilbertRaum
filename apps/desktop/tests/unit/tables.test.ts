import { describe, it, expect } from 'vitest'
import { tableToCsv, type TableSpec } from '../../src/main/services/tables'

// The generic tabular serializer (result-tables plan §3, D59/D60): columns are data, not code.
// The bank wiring (its column set, fixed-dp money, csvField on the description, the category presence gate) is pinned in
// skills-bank-statement-tool.test.ts via `transactionsToCsv`, whose rows compare lines after trimEnd(). These tests pin the
// generic contract every table relies on: the exact bytes including the trailing \r\n, blank null/undefined/missing
// cells in EVERY column kind, and csvField on labels and on strings in numeric columns.

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

  it('serializes null/undefined cells as empty fields in every column kind — absent, never invented', () => {
    const csv = tableToCsv(
      spec([
        { name: null, price: null, qty: undefined },
        { name: undefined, price: 1, qty: 2 }
      ])
    )
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[1]).toBe(',,')
    expect(lines[2]).toBe(',1.00,2')
  })

  it('missing row keys serialize blank; extra row fields are not emitted', () => {
    // `name` (text) and `qty` (integer) are both missing from the row.
    const csv = tableToCsv(spec([{ price: 1, stray: 'never emitted' }]))
    expect(csv.trimEnd().split('\r\n')[1]).toBe(',1.00,')
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
