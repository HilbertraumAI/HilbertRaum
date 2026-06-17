import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Skills plan §12.2/§16 (S11b) — the app-orchestrated tool-run IPC: listRunnableTools →
// startSkillRun → getSkillRun. Proves the run starts from a user action (DS4), surfaces ids/counts
// only, and that the channel LOGS NOTHING content-bearing (a sentinel in a transaction never reaches
// the audit). Mirrors the registerSkillsIpc test harness (mocked electron + the invoke helper).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerSkillsIpc } from '../../src/main/ipc/registerSkillsIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createAuditRecorder, listAuditEvents } from '../../src/main/services/audit'
import { createSkillRegistry } from '../../src/main/services/skills/registry'
import { createConversation } from '../../src/main/services/chat'
import type { AppContext } from '../../src/main/services/context'
import type { RunnableTool, SkillRunState, StartSkillRunResult } from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const SENTINEL = 'XTOOLRUN_SENTINEL_secret_payee_77777'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-toolrun-'))
}

function writeBankSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'bank-statement')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: bank-statement',
    'title: Bank statement',
    'description: Reads statements.',
    'version: 1.0.0',
    'allowedTools: [extract_transactions]',
    '---',
    'Quote the printed figures.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

function seedDocWithChunks(db: Db, text: string): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
     VALUES (?, 'Statement', 'indexed', 'application/pdf', ?, ?)`
  ).run(docId, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, 0, ?, 'p', 1, ?)`
  ).run(randomUUID(), docId, text, now)
  return docId
}

interface Harness {
  db: Db
  conversationId: string
  skillInstallId: string
}

function makeHarness(statementText: string): Harness {
  const root = tempDir()
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeBankSkill(appSkillsDir)
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const audit = createAuditRecorder(() => db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir })
  const ctx = {
    db,
    workspace: { isUnlocked: () => true },
    isDev: false,
    audit,
    skills
  } as unknown as AppContext
  registerSkillsIpc(ctx)
  const docId = seedDocWithChunks(db, statementText)
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  return { db, conversationId: conv.id, skillInstallId: 'app:bank-statement' }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function pollUntilTerminal(runHandle: string): Promise<SkillRunState> {
  for (let i = 0; i < 50; i++) {
    const { result } = await invoke(handlers, IPC.getSkillRun, runHandle)
    const state = result as SkillRunState | null
    if (state && state.state !== 'running') return state
    await flush()
  }
  throw new Error('run did not terminate')
}

beforeEach(() => ipcState.handlers.clear())

describe('skills tool-run IPC (S11b)', () => {
  it('listRunnableTools surfaces the wired read-only tool for the bank skill in scope', async () => {
    const { skillInstallId, conversationId } = makeHarness('EUR\n2026-01-02 Grocery -45,90')
    const { result } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, conversationId)
    expect(result).toEqual<RunnableTool[]>([{ name: 'extract_transactions', requiresConfirmation: false }])
  })

  it('listRunnableTools is empty with no in-scope document', async () => {
    const { skillInstallId } = makeHarness('EUR\n2026-01-02 Grocery -45,90')
    // An unknown conversation resolves to no scope → nothing to run against (empty-tolerant).
    const { result } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, 'no-such-conversation')
    expect(result).toEqual([])
  })

  it('startSkillRun → getSkillRun runs end-to-end and reports the count only', async () => {
    const { skillInstallId, conversationId } = makeHarness(
      'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'
    )
    const { result: startRaw } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'extract_transactions',
      conversationId
    })
    const start = startRaw as StartSkillRunResult
    expect(start.started).toBe(true)
    if (!start.started) throw new Error('expected started')
    expect(start.run.state).toBe('running')
    const final = await pollUntilTerminal(start.run.runHandle)
    expect(final.state).toBe('done')
    expect(final.transactionCount).toBe(2)
  })

  it('refuses an unwired tool with a friendly, content-free error', async () => {
    const { skillInstallId, conversationId } = makeHarness('EUR\n2026-01-02 Grocery -45,90')
    const { result } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'summarize_cashflow',
      conversationId
    })
    expect((result as StartSkillRunResult).started).toBe(false)
  })

  it('logs nothing: a secret in a transaction never reaches the audit (ids/counts only)', async () => {
    const { db, skillInstallId, conversationId } = makeHarness(`EUR\n2026-01-02 ${SENTINEL} -12,00`)
    const { result: startRaw } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'extract_transactions',
      conversationId
    })
    const start = startRaw as StartSkillRunResult
    if (!start.started) throw new Error('expected started')
    await pollUntilTerminal(start.run.runHandle)
    // The audit recorded the run lifecycle (started/done) but NEVER the transaction content.
    const auditText = listAuditEvents(db, { limit: 5000 })
      .map((e) => `${e.type} ${e.message} ${JSON.stringify(e.metadata)}`)
      .join('\n')
    expect(auditText).toContain('skill_run_started')
    expect(auditText).toContain('skill_run_done')
    expect(auditText).not.toContain(SENTINEL)
    // …and the run state the renderer polls carries no content either.
    const { result: stateRaw } = await invoke(handlers, IPC.getSkillRun, start.run.runHandle)
    expect(JSON.stringify(stateRaw)).not.toContain(SENTINEL)
  })
})
