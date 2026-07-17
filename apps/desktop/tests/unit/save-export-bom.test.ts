import { describe, it, expect, vi } from 'vitest'

// `save-export.ts` imports { BrowserWindow, dialog } from 'electron' at module top. On CI the
// electron BINARY download is skipped (ELECTRON_SKIP_BINARY_DOWNLOAD=1 in ci.yml), so importing
// the REAL package throws "Electron failed to install correctly" before a single test runs —
// this suite broke master CI from the moment it landed (invoice-hardening merge, bcfa876).
// `bomFor` is pure; mock the transport like every other suite that touches this module.
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) }
}))

import { bomFor } from '../../src/main/ipc/save-export'

// invoice-hardening-2026-07-04 P4 — the UTF-8 BOM on plain-text exports. A user's exported German
// transcript opened in a CP1252-defaulting Windows viewer rendered mojibake ("ausschlieÃlich"); the BOM
// makes legacy editors detect UTF-8. It must ride ONLY .md/.txt — a BOM breaks strict JSON parsers (the
// audit-log export) and is wrong for .log tooling.
// Audit 2026-07-16 F-10 (owner decision D-A, 2026-07-17) extended the BOM to .csv: Excel — the primary
// consumer of a transactions CSV — opens BOM-less UTF-8 in the ANSI code page on double-click, garbling
// every umlaut/ß in payee/description text. Still NEVER on .json/.log.
describe('bomFor (P4 + F-10 — text/CSV export BOM)', () => {
  it('prefixes .md, .txt and .csv (case-insensitive)', () => {
    expect(bomFor('C:/exports/chat.md')).toBe('\ufeff')
    expect(bomFor('C:/exports/chat.TXT')).toBe('\ufeff')
    expect(bomFor('C:/exports/items.csv')).toBe('\ufeff') // F-10 (D-A 2026-07-17): Excel-friendly CSV
  })

  it('never prefixes JSON / log exports', () => {
    expect(bomFor('C:/exports/audit.json')).toBe('')
    expect(bomFor('C:/exports/app.log')).toBe('')
  })
})
