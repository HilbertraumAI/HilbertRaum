import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Result-tables plan §4 (Phase 2): the per-message result-table artifact + the message-level
// "Export CSV" IPC. Proves the store round-trip and its caps, the listMessages hasResultTable
// flag, the FK-cascade purge on conversation delete, and the export handler end-to-end against
// a mocked save dialog (write, cancel); the table-less message → null-before-the-dialog row is
// chat-ipc.test.ts's T-8 row. The audit carries ids/counts only.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
const saveDialog = await vi.hoisted(async () => (await import('../helpers/save-dialog')).saveDialogFake())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: saveDialog.showSaveDialog },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { IPC } from '../../src/shared/ipc'
import type { Db } from '../../src/main/services/db'
import { appendMessage, createConversation, deleteConversation, listMessages } from '../../src/main/services/chat'
import { loadResultTable, saveResultTable } from '../../src/main/services/tables/store'
import type { TableSpec } from '../../src/main/services/tables'
import type { AppContext } from '../../src/main/services/context'
import { openFreshDb, tempRoot } from '../helpers/db-fixtures'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { workspaceStandIn } from '../helpers/workspace-stand-in'

const handlers = ipcState.handlers as unknown as IpcHandlers

function makeCtx(db: Db, audit?: (type: string, msg: string, meta?: Record<string, unknown>) => void): AppContext {
  return {
    trustedSenders: ANY_SENDER,
    db,
    workspace: workspaceStandIn(),
    runtime: { active: () => null, activeModelId: () => null },
    audit
  } as unknown as AppContext
}

const TABLE: TableSpec = {
  columns: [
    { key: 'date', label: 'date' },
    { key: 'description', label: 'description' },
    { key: 'amount', label: 'amount', kind: 'money' },
    { key: 'category', label: 'category' }
  ],
  rows: [
    { date: '2026-01-02', description: '=EVIL()', amount: -45.9, category: 'Lebensmittel' },
    { date: '2026-01-03', description: 'Salary', amount: 2500, category: 'Sonstiges' }
  ]
}

/** Seed a conversation + assistant message carrying TABLE; returns ids. */
function seedMessageWithTable(db: Db): { conversationId: string; messageId: string } {
  const conv = createConversation(db, {})
  const msg = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'here is your CSV' })
  expect(saveResultTable(db, { messageId: msg.id, conversationId: conv.id, table: TABLE, source: 'test' })).toBe(true)
  return { conversationId: conv.id, messageId: msg.id }
}

beforeEach(() => {
  ipcState.handlers.clear()
  saveDialog.reset()
})

describe('result-table store (Phase 2)', () => {
  it('round-trips a table and flags ONLY the carrying message in listMessages', () => {
    const db = openFreshDb('rtables')
    const { conversationId, messageId } = seedMessageWithTable(db)
    const plain = appendMessage(db, { conversationId, role: 'assistant', content: 'no table here' })

    expect(loadResultTable(db, messageId)).toEqual(TABLE)
    expect(loadResultTable(db, plain.id)).toBeNull()

    const listed = listMessages(db, conversationId)
    expect(listed.find((m) => m.id === messageId)?.hasResultTable).toBe(true)
    expect(listed.find((m) => m.id === plain.id)?.hasResultTable).toBeUndefined()
  })

  it('persists a table at the 10,000-row ceiling and refuses 10,001 rows, no rows or no columns (the answer is never blocked)', () => {
    const db = openFreshDb('rtables')
    const conv = createConversation(db, {})
    const atCap = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'at the ceiling' })
    const refused = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'refused tables' })
    const rows = (n: number): Array<{ date: string }> => Array.from({ length: n }, () => ({ date: 'x' }))
    // The shipped bound as a literal (CONTRIBUTING: pin the bound that ships; the result-tables record §4 names 10 000).
    expect(
      saveResultTable(db, { messageId: atCap.id, conversationId: conv.id, table: { columns: TABLE.columns, rows: rows(10_000) } })
    ).toBe(true)
    expect(loadResultTable(db, atCap.id)?.rows).toHaveLength(10_000)
    for (const table of [
      { columns: TABLE.columns, rows: rows(10_001) },
      { columns: TABLE.columns, rows: [] },
      { columns: [], rows: rows(1) }
    ]) {
      expect(saveResultTable(db, { messageId: refused.id, conversationId: conv.id, table })).toBe(false)
    }
    expect(loadResultTable(db, refused.id)).toBeNull()
  })

  it('purges with the conversation (messages delete → FK cascade)', () => {
    const db = openFreshDb('rtables')
    const { conversationId } = seedMessageWithTable(db)
    expect((db.prepare('SELECT COUNT(*) AS n FROM result_tables').get() as { n: number }).n).toBe(1)
    expect(deleteConversation(db, conversationId)).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS n FROM result_tables').get() as { n: number }).n).toBe(0)
  })
})

describe('chat:exportMessageTable IPC (Phase 2)', () => {
  it('writes the persisted table as CSV via the save dialog, with an ids/counts-only audit', async () => {
    const db = openFreshDb('rtables')
    const { messageId } = seedMessageWithTable(db)
    const events: Array<{ type: string; message: string; meta?: Record<string, unknown> }> = []
    registerChatIpc(makeCtx(db, (type, message, meta) => events.push({ type, message, meta })))

    const outPath = join(tempRoot('rtables-out'), 'export.csv')
    saveDialog.result = { canceled: false, filePath: outPath }
    const { result } = await invoke(handlers, IPC.exportMessageTable, messageId)
    expect(result).toBe(outPath)

    const csv = readFileSync(outPath, 'utf8')
    expect(csv.startsWith('\ufeff')).toBe(true) // UTF-8 BOM on .csv (audit F-10, D-A 2026-07-17 — Excel-friendly)
    const lines = csv.replace(/^\ufeff/, '').trimEnd().split('\r\n')
    expect(lines[0]).toBe('date,description,amount,category')
    expect(lines[1]).toBe("2026-01-02,'=EVIL(),-45.90,Lebensmittel") // formula-neutralized text cell
    expect(lines[2]).toBe('2026-01-03,Salary,2500.00,Sonstiges')

    // Dialog metadata: the CSV filter + a .csv default name.
    expect(saveDialog.lastOptions?.filters?.[0]?.extensions).toEqual(['csv'])
    expect(saveDialog.lastOptions?.defaultPath).toMatch(/\.csv$/)

    // Audit: exactly one event, id + row count only — never a column/row/path (the sentinel description stays
    // out). Every audited string is searched RAW: JSON doubles Windows backslashes, so a JSON search for the path
    // could never match on Windows.
    expect(events.map((e) => e.type)).toEqual(['message_table_exported'])
    const evt = events[0]!
    expect(evt.meta).toEqual({ messageId, rows: 2 })
    for (const s of [evt.type, evt.message, ...Object.values(evt.meta ?? {}).map(String)]) {
      expect(s).not.toContain('EVIL')
      expect(s).not.toContain(outPath)
    }
  })

  it('a cancelled dialog returns null, writes nothing and audits nothing', async () => {
    const db = openFreshDb('rtables')
    const { messageId } = seedMessageWithTable(db)
    const events: string[] = []
    registerChatIpc(makeCtx(db, (type) => events.push(type)))
    const dir = tempRoot('rtables-out')
    // The dialog still reports a path: `canceled` must be the guard that stops the write.
    saveDialog.result = { canceled: true, filePath: join(dir, 'export.csv') }
    const { result } = await invoke(handlers, IPC.exportMessageTable, messageId)
    expect(result).toBeNull()
    expect(readdirSync(dir)).toEqual([])
    expect(events).toEqual([])
  })
})
