import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Result-tables plan §4 (Phase 2): the per-message result-table artifact + the message-level
// "Export CSV" IPC. Proves the store round-trip and its caps, the listMessages hasResultTable
// flag, the FK-cascade purge on conversation delete, and the export handler end-to-end against
// a mocked save dialog (write, cancel, no-table) with an ids/counts-only audit.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
type SaveDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}
const dialogState = vi.hoisted(() => ({
  saveResult: { canceled: true } as { canceled: boolean; filePath?: string },
  lastSaveOptions: undefined as SaveDialogOptions | undefined
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showSaveDialog: async (...args: unknown[]) => {
      dialogState.lastSaveOptions = (args.length > 1 ? args[1] : args[0]) as SaveDialogOptions
      return dialogState.saveResult
    }
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation, deleteConversation, listMessages } from '../../src/main/services/chat'
import {
  MAX_RESULT_TABLE_ROWS,
  loadResultTable,
  saveResultTable
} from '../../src/main/services/tables/store'
import type { TableSpec } from '../../src/main/services/tables'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-rtables-')), 'test.sqlite'))
}

function makeCtx(db: Db, audit?: (type: string, msg: string, meta?: Record<string, unknown>) => void): AppContext {
  return {
    db,
    workspace: { isUnlocked: () => true },
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
  dialogState.saveResult = { canceled: true }
  dialogState.lastSaveOptions = undefined
})

describe('result-table store (Phase 2)', () => {
  it('round-trips a table and flags ONLY the carrying message in listMessages', () => {
    const db = freshDb()
    const { conversationId, messageId } = seedMessageWithTable(db)
    const plain = appendMessage(db, { conversationId, role: 'assistant', content: 'no table here' })

    expect(loadResultTable(db, messageId)).toEqual(TABLE)
    expect(loadResultTable(db, plain.id)).toBeNull()

    const listed = listMessages(db, conversationId)
    expect(listed.find((m) => m.id === messageId)?.hasResultTable).toBe(true)
    expect(listed.find((m) => m.id === plain.id)?.hasResultTable).toBeUndefined()
  })

  it('rejects an empty table and one over the row ceiling (the answer is never blocked)', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const msg = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'x' })
    expect(saveResultTable(db, { messageId: msg.id, conversationId: conv.id, table: { columns: TABLE.columns, rows: [] } })).toBe(false)
    const overCap = {
      columns: TABLE.columns,
      rows: Array.from({ length: MAX_RESULT_TABLE_ROWS + 1 }, () => ({ date: 'x' }))
    }
    expect(saveResultTable(db, { messageId: msg.id, conversationId: conv.id, table: overCap })).toBe(false)
    expect(loadResultTable(db, msg.id)).toBeNull()
  })

  it('purges with the conversation (messages delete → FK cascade)', () => {
    const db = freshDb()
    const { conversationId } = seedMessageWithTable(db)
    expect((db.prepare('SELECT COUNT(*) AS n FROM result_tables').get() as { n: number }).n).toBe(1)
    expect(deleteConversation(db, conversationId)).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS n FROM result_tables').get() as { n: number }).n).toBe(0)
  })
})

describe('chat:exportMessageTable IPC (Phase 2)', () => {
  it('writes the persisted table as CSV via the save dialog, with an ids/counts-only audit', async () => {
    const db = freshDb()
    const { messageId } = seedMessageWithTable(db)
    const events: Array<{ type: string; meta?: Record<string, unknown> }> = []
    registerChatIpc(makeCtx(db, (type, _msg, meta) => events.push({ type, meta })))

    const outPath = join(mkdtempSync(join(tmpdir(), 'hilbertraum-rtables-out-')), 'export.csv')
    dialogState.saveResult = { canceled: false, filePath: outPath }
    const { result } = await invoke(handlers, IPC.exportMessageTable, messageId)
    expect(result).toBe(outPath)

    const csv = readFileSync(outPath, 'utf8')
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe('date,description,amount,category')
    expect(lines[1]).toBe("2026-01-02,'=EVIL(),-45.90,Lebensmittel") // formula-neutralized text cell
    expect(lines[2]).toBe('2026-01-03,Salary,2500.00,Sonstiges')
    expect(csv.startsWith('﻿')).toBe(false) // no BOM on .csv (bomFor is md/txt-only)

    // Dialog metadata: the CSV filter + a .csv default name.
    expect(dialogState.lastSaveOptions?.filters?.[0]?.extensions).toEqual(['csv'])
    expect(dialogState.lastSaveOptions?.defaultPath).toMatch(/\.csv$/)

    // Audit: id + row count only — never a column/row/path (the sentinel description stays out).
    const evt = events.find((e) => e.type === 'message_table_exported')
    expect(evt).toBeTruthy()
    expect(JSON.stringify(evt)).not.toContain('EVIL')
    expect(JSON.stringify(evt)).not.toContain(outPath)
    expect(evt?.meta).toEqual({ messageId, rows: 2 })
  })

  it('a cancelled dialog returns null and writes nothing', async () => {
    const db = freshDb()
    const { messageId } = seedMessageWithTable(db)
    registerChatIpc(makeCtx(db))
    dialogState.saveResult = { canceled: true }
    const { result } = await invoke(handlers, IPC.exportMessageTable, messageId)
    expect(result).toBeNull()
  })

  it('a message without a table returns null WITHOUT opening the save dialog', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const msg = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'plain' })
    registerChatIpc(makeCtx(db))
    dialogState.saveResult = { canceled: false, filePath: join(tmpdir(), 'never.csv') }
    const { result } = await invoke(handlers, IPC.exportMessageTable, msg.id)
    expect(result).toBeNull()
    expect(dialogState.lastSaveOptions).toBeUndefined() // dialog never opened
    expect(existsSync(join(tmpdir(), 'never.csv'))).toBe(false)
  })
})
