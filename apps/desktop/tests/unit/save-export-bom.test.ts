import { describe, it, expect } from 'vitest'
import { bomFor } from '../../src/main/ipc/save-export'

// invoice-hardening-2026-07-04 P4 — the UTF-8 BOM on plain-text exports. A user's exported German
// transcript opened in a CP1252-defaulting Windows viewer rendered mojibake ("ausschlieÃlich"); the BOM
// makes legacy editors detect UTF-8. It must ride ONLY .md/.txt — a BOM breaks strict JSON parsers (the
// audit-log export) and is wrong for .log tooling.
describe('bomFor (P4 — plain-text export BOM)', () => {
  it('prefixes .md and .txt (case-insensitive)', () => {
    expect(bomFor('C:/exports/chat.md')).toBe('\ufeff')
    expect(bomFor('C:/exports/chat.TXT')).toBe('\ufeff')
  })

  it('never prefixes JSON / log / CSV exports', () => {
    expect(bomFor('C:/exports/audit.json')).toBe('')
    expect(bomFor('C:/exports/app.log')).toBe('')
    expect(bomFor('C:/exports/items.csv')).toBe('')
  })
})
