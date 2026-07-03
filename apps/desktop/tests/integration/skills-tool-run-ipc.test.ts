import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Skills plan §12.2/§16 (S11b) — the app-orchestrated tool-run IPC: listRunnableTools →
// startSkillRun → getSkillRun. Proves the run starts from a user action (DS4), surfaces ids/counts
// only, and that the channel LOGS NOTHING content-bearing (a sentinel in a transaction never reaches
// the audit). Mirrors the registerSkillsIpc test harness (mocked electron + the invoke helper).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
// Mutable save-dialog result so a test can drive the export CSV write (default = user cancelled), plus
// the LAST save-dialog options (U5 / §6.2) so a test can assert the per-export title/filter/extension.
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
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    // Called as showSaveDialog(options) in tests (no focused window). Capture the options so a test can
    // assert the dialog the user would see, then return the mutable result.
    showSaveDialog: async (...args: unknown[]) => {
      dialogState.lastSaveOptions = (args.length > 1 ? args[1] : args[0]) as SaveDialogOptions
      return dialogState.saveResult
    }
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerSkillsIpc } from '../../src/main/ipc/registerSkillsIpc'
import {
  buildToolRunner,
  resolveInScopeDocumentIds,
  runnableToolNames,
  runnableToolsForSkill,
  toSkillToolAudit
} from '../../src/main/services/skills/tool-runs'
import type { DocTaskManager } from '../../src/main/services/doctasks'
import { IPC } from '../../src/shared/ipc'
import { t, type MessageKey } from '../../src/shared/i18n'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createAuditRecorder, listAuditEvents } from '../../src/main/services/audit'
import { createSkillRegistry, getSkill } from '../../src/main/services/skills/registry'
import { createConversation } from '../../src/main/services/chat'
import type { AppContext } from '../../src/main/services/context'
import type { RunnableTool, RunnableToolSet, SkillRunState, StartSkillRunResult } from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const SENTINEL = 'XTOOLRUN_SENTINEL_secret_payee_77777'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-toolrun-'))
}

function writeBankSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'bank-statement')
  mkdirSync(d, { recursive: true })
  // S11c: kind:'tool' so the declared allowedTools become effective (the SL-1 parser path).
  const lines = [
    '---',
    'id: bank-statement',
    'title: Bank statement',
    'description: Reads statements.',
    'version: 1.0.0',
    'kind: tool',
    'allowedTools: [extract_transactions, validate_statement_balances, categorize_transactions, summarize_cashflow, export_transactions_csv]',
    '---',
    'Quote the printed figures.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

function writeRedactionSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'document-redaction')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: document-redaction',
    'title: Document redaction',
    'description: Redacts personal data.',
    'version: 1.0.0',
    'kind: tool',
    'allowedTools: [redact_document]',
    '---',
    'Best-effort redaction; review the copy.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

function writeInvoiceSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'invoice')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: invoice',
    'title: Invoice',
    'description: Reads invoices.',
    'version: 1.0.0',
    'kind: tool',
    'allowedTools: [extract_invoice, validate_invoice_totals, export_invoice_csv, export_invoice_json, export_invoice_xml]',
    '---',
    'Quote the printed figures.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

const INVOICE_TEXT = [
  'Invoice',
  'Vendor: ACME Supplies GmbH',
  'Invoice Number: INV-2026-0042',
  'Invoice Date: 2026-03-15',
  'Currency EUR',
  '',
  'Widget A               2     12,50        25,00',
  '',
  'Net Total              25,00',
  'Gross Total            25,00'
].join('\n')

// A USER-imported `kind:'tool'` skill (dropped into user-skills/) that DECLARES the same Tier-2
// tools an app skill would. Its TITLE carries a sentinel so the SEC-1 refusal can be asserted
// content-free. The SEC-1 gate means it must run NONE of these even when enabled.
const USER_SKILL_TITLE_SENTINEL = 'XUSERSKILL_SENTINEL_imported_title_99999'
function writeUserToolSkill(userSkillsDir: string): void {
  const d = join(userSkillsDir, 'imported-bank')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: imported-bank',
    `title: ${USER_SKILL_TITLE_SENTINEL}`,
    'description: A user-imported tool skill.',
    'version: 1.0.0',
    'kind: tool',
    'allowedTools: [extract_transactions, export_transactions_csv]',
    '---',
    'Quote the printed figures.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

function seedDocWithChunks(db: Db, text: string, opts: { title?: string; createdAt?: string } = {}): string {
  const now = opts.createdAt ?? new Date().toISOString()
  const docId = randomUUID()
  // A REAL stored .txt copy: the run seam re-extracts VERBATIM segments from the stored file via
  // extractDocumentPreview (the faithful content reach the IPC injects) — NOT the newline-collapsed,
  // overlapping `chunks`. TxtParser returns the file as one newline-preserving segment, so the
  // line-oriented extractor sees the rows exactly as written. (The chunk row is still seeded so the
  // doc is "indexed"; it is no longer the content source.)
  const storedPath = join(mkdtempSync(join(tmpdir(), 'hilbertraum-toolrun-doc-')), 'document.txt')
  writeFileSync(storedPath, text, 'utf8')
  db.prepare(
    `INSERT INTO documents (id, title, stored_path, status, mime_type, created_at, updated_at)
     VALUES (?, ?, ?, 'indexed', 'text/plain', ?, ?)`
  ).run(docId, opts.title ?? 'document.txt', storedPath, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, 0, ?, 'p', 1, ?)`
  ).run(randomUUID(), docId, text, now)
  return docId
}

// A bank-skill harness scoped to SEVERAL indexed documents (U-1 multi-doc targeting). Distinct,
// ascending `created_at` makes `resolveInScopeDocumentIds` order deterministic = the seed order, so
// `docIds[0]` is the first seeded document (the default target). Returns the ids in that order.
function makeMultiDocHarness(texts: string[]): Harness & { docIds: string[] } {
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
    paths: { workspacePath: root },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    isDev: false,
    audit,
    skills,
    ocrEngine: undefined
  } as unknown as AppContext
  registerSkillsIpc(ctx)
  const docIds = texts.map((text, i) =>
    seedDocWithChunks(db, text, { createdAt: `2026-01-0${i + 1}T00:00:00.000Z` })
  )
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: docIds } })
  return { db, conversationId: conv.id, skillInstallId: 'app:bank-statement', docIds }
}

interface Harness {
  db: Db
  conversationId: string
  skillInstallId: string
}

function makeHarness(statementText: string, opts: { title?: string } = {}): Harness {
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
    paths: { workspacePath: root },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    isDev: false,
    audit,
    skills,
    ocrEngine: undefined
  } as unknown as AppContext
  registerSkillsIpc(ctx)
  const docId = seedDocWithChunks(db, statementText, { title: opts.title })
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  return { db, conversationId: conv.id, skillInstallId: 'app:bank-statement' }
}

function makeRedactionHarness(docText: string): Harness {
  const root = tempDir()
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeRedactionSkill(appSkillsDir)
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const audit = createAuditRecorder(() => db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir })
  const ctx = {
    db,
    paths: { workspacePath: root },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    isDev: false,
    audit,
    skills,
    ocrEngine: undefined
  } as unknown as AppContext
  registerSkillsIpc(ctx)
  const docId = seedDocWithChunks(db, docText)
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  return { db, conversationId: conv.id, skillInstallId: 'app:document-redaction' }
}

function makeInvoiceHarness(invoiceText: string): Harness {
  const root = tempDir()
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeInvoiceSkill(appSkillsDir)
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const audit = createAuditRecorder(() => db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir })
  const ctx = {
    db,
    paths: { workspacePath: root },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    isDev: false,
    audit,
    skills,
    ocrEngine: undefined
  } as unknown as AppContext
  registerSkillsIpc(ctx)
  const docId = seedDocWithChunks(db, invoiceText)
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  return { db, conversationId: conv.id, skillInstallId: 'app:invoice' }
}

// A harness whose runnable skill is a USER-imported `kind:'tool'` skill, force-enabled to model the
// worst case (a drop-in installs DISABLED per DS19; a zip import installs enabled-with-warning per
// DS7 — either way an ENABLED user tool skill). The SEC-1 gate must still refuse it every Tier-2 tool.
function makeUserSkillHarness(statementText: string): Harness {
  const root = tempDir()
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeUserToolSkill(userSkillsDir)
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const audit = createAuditRecorder(() => db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir })
  const ctx = {
    db,
    paths: { workspacePath: root },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    isDev: false,
    audit,
    skills,
    ocrEngine: undefined
  } as unknown as AppContext
  registerSkillsIpc(ctx)
  const docId = seedDocWithChunks(db, statementText)
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  skills.list() // reconcile disk→DB (the user skill installs DISABLED)
  db.prepare('UPDATE skills SET enabled = 1 WHERE install_id = ?').run('user:imported-bank') // force-enable
  return { db, conversationId: conv.id, skillInstallId: 'user:imported-bank' }
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

beforeEach(() => {
  ipcState.handlers.clear()
  dialogState.saveResult = { canceled: true }
  dialogState.lastSaveOptions = undefined
})

/** Run a tool to a terminal state via the IPC channels (returns the final ids/counts-only state). */
async function runTool(
  skillInstallId: string,
  conversationId: string,
  toolName: string,
  confirmed?: boolean
): Promise<SkillRunState> {
  const { result: startRaw } = await invoke(handlers, IPC.startSkillRun, {
    skillInstallId,
    toolName,
    conversationId,
    confirmed
  })
  const start = startRaw as StartSkillRunResult
  if (!start.started) throw new Error('expected the run to start')
  return pollUntilTerminal(start.run.runHandle)
}

describe('skills tool-run IPC (S11b)', () => {
  it('listRunnableTools surfaces all five wired tools (export confirm-gated) in declared order', async () => {
    const { skillInstallId, conversationId } = makeHarness('EUR\n2026-01-02 Grocery -45,90')
    const { result } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, conversationId)
    expect((result as RunnableToolSet).tools).toEqual<RunnableTool[]>([
      { name: 'extract_transactions', requiresConfirmation: false },
      { name: 'validate_statement_balances', requiresConfirmation: false },
      { name: 'categorize_transactions', requiresConfirmation: false },
      { name: 'summarize_cashflow', requiresConfirmation: false },
      { name: 'export_transactions_csv', requiresConfirmation: true }
    ])
    // U-1: the single in-scope target id rides along (ids only — no title crosses the IPC).
    expect((result as RunnableToolSet).documentIds).toHaveLength(1)
  })

  it('listRunnableTools is empty with no in-scope document', async () => {
    const { skillInstallId } = makeHarness('EUR\n2026-01-02 Grocery -45,90')
    // An unknown conversation resolves to no scope → nothing to run against (empty-tolerant).
    const { result } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, 'no-such-conversation')
    expect(result).toEqual({ tools: [], documentIds: [] })
  })

  it('excludes an enabled-but-incompatible skill from listRunnableTools AND startSkillRun (§6.5/M1 airtight)', async () => {
    // The third use-site: a tool skill that needs a far newer app than the test app (0.0.0-test).
    // Reconcile installs it disabled; we then force-enable it to simulate a SKILL.md edited on disk
    // upward AFTER it was enabled (reconcile preserves the enabled flag). The use-site gate must
    // still exclude it — both from the runnable list and from being startable.
    const root = tempDir()
    const appSkillsDir = join(root, 'app-skills')
    const userSkillsDir = join(root, 'user-skills')
    mkdirSync(appSkillsDir, { recursive: true })
    mkdirSync(userSkillsDir, { recursive: true })
    const skillDir = join(appSkillsDir, 'bank-statement')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'id: bank-statement',
        'title: Bank statement',
        'description: Reads statements.',
        'version: 1.0.0',
        'kind: tool',
        'allowedTools: [extract_transactions]',
        'compatibility:',
        '  minAppVersion: 99.0.0',
        '---',
        'Quote the printed figures.'
      ].join('\n'),
      'utf8'
    )
    const db = openDatabase(join(root, 'test.sqlite'))
    seedSettings(db)
    const audit = createAuditRecorder(() => db)
    const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir })
    const ctx = {
      db,
      paths: { workspacePath: root },
      workspace: { isUnlocked: () => true, documentCipher: () => null },
      isDev: false,
      audit,
      skills,
      ocrEngine: undefined
    } as unknown as AppContext
    registerSkillsIpc(ctx)
    const docId = seedDocWithChunks(db, 'EUR\n2026-01-02 Grocery -45,90')
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })

    // Drive the disk reconcile once (installs disabled), then force-enable to model the stale flag.
    skills.list()
    db.prepare('UPDATE skills SET enabled = 1 WHERE install_id = ?').run('app:bank-statement')

    const { result: tools } = await invoke(handlers, IPC.listRunnableTools, 'app:bank-statement', conv.id)
    expect(tools).toEqual({ tools: [], documentIds: [] }) // incompatible → no runnable tools even though enabled

    const { result: startRaw } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId: 'app:bank-statement',
      toolName: 'extract_transactions',
      conversationId: conv.id
    })
    expect((startRaw as StartSkillRunResult).started).toBe(false) // refuses to run
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

  it('a second extract REPLACES the prior statement (no duplicate bank_statements accumulate)', async () => {
    // Regression: the run-bar "Extract transactions" button re-extracts with `replaceExisting`, matching
    // the chat analysis + categorize paths. Without it, repeated clicks accumulated duplicate
    // bank_statements rows and `latestBankStatementId` (newest wins) could serve the chat a DIFFERENT
    // extraction than the one just shown — the divergence behind the "45 rows then 22 rows" report.
    const { db, skillInstallId, conversationId } = makeHarness(
      'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'
    )
    expect((await runTool(skillInstallId, conversationId, 'extract_transactions')).state).toBe('done')
    expect((await runTool(skillInstallId, conversationId, 'extract_transactions')).state).toBe('done')
    const statements = db.prepare('SELECT COUNT(*) AS n FROM bank_statements').get() as { n: number }
    expect(statements.n).toBe(1) // replaced, not accumulated
    // The prior statement's rows went with it (FK-ordered delete), so only the fresh 2 survive.
    const txs = db.prepare('SELECT COUNT(*) AS n FROM bank_transactions').get() as { n: number }
    expect(txs.n).toBe(2)
  })

  it('a DOWNSTREAM run-bar run re-extracts a STALE statement from faithful segments, not the chunks (R3 / §5.6)', async () => {
    // The production gap behind audit §5.6: after a version bump (figures were mis-read) the Validate/
    // Summarize/Export buttons must re-extract before serving rows — and that re-extraction MUST read the
    // faithful stored-file SEGMENTS, not the newline-collapsed `chunks`. This exercises the FULL IPC path
    // (startSkillRun → buildToolRunner → seam), so it also proves `tool-runs.ts` forwards the segment
    // reader to the downstream dispatch: revert that forwarding and the re-extraction reads the corrupted
    // chunk below → ZERO rows → this test fails.
    const { db, skillInstallId, conversationId } = makeHarness(
      'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'
    )
    expect((await runTool(skillInstallId, conversationId, 'extract_transactions')).state).toBe('done')
    const docId = (db.prepare('SELECT id FROM documents LIMIT 1').get() as { id: string }).id
    const staleId = (db.prepare('SELECT id FROM bank_statements WHERE document_id = ?').get(docId) as { id: string }).id

    // Force the statement stale AND corrupt the chunk: if the downstream re-extraction fell back to the
    // chunk-table reader (segments NOT forwarded), it would read this garbage and persist zero rows.
    db.prepare('UPDATE bank_statements SET extractor_version = NULL WHERE id = ?').run(staleId)
    db.prepare("UPDATE chunks SET text = 'no transactions in this chunk' WHERE document_id = ?").run(docId)

    expect((await runTool(skillInstallId, conversationId, 'validate_statement_balances')).state).toBe('done')

    // Re-extracted in place: a NEW id, stamped fresh, with BOTH faithful rows from the stored-file segments.
    const stmts = db.prepare('SELECT id, extractor_version AS v FROM bank_statements WHERE document_id = ?').all(docId) as Array<{ id: string; v: number | null }>
    expect(stmts).toHaveLength(1) // replaceExisting — no accumulation
    expect(stmts[0].id).not.toBe(staleId)
    expect(stmts[0].v).not.toBeNull() // stamped at the current extractor version (no longer stale)
    const txs = db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE statement_id = ?').get(stmts[0].id) as { n: number }
    expect(txs.n).toBe(2) // read from the faithful segments — the corrupted chunk fallback would give 0
  })

  it('refuses a tool the skill does not declare with a friendly, content-free error', async () => {
    const { skillInstallId, conversationId } = makeHarness('EUR\n2026-01-02 Grocery -45,90')
    // count_selected_documents is registered but NOT in the skill's allowedTools → unavailable.
    const { result } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'count_selected_documents',
      conversationId
    })
    expect((result as StartSkillRunResult).started).toBe(false)
  })

  it('keeps count_selected_documents as a registry-only canary: registered but NOT wired to a run seam (X-2)', () => {
    // X-2 decision (audit 2026-06-26): the reference tool is kept as the gate's test-only canary. It is
    // registered (the gate tests run it end-to-end) but deliberately exposes NO live capability — it has
    // no dispatch case in `buildToolRunner`. This test gives that decision teeth in BOTH directions: if
    // the tool were dropped from the registry the listing test breaks; if it were ever wired to a run
    // seam (turning it into a live capability) this assertion breaks.
    const { db, skillInstallId, conversationId } = makeHarness('EUR\n2026-01-02 Grocery -45,90')
    const documentId = resolveInScopeDocumentIds(db, conversationId)[0]
    const runner = buildToolRunner(
      db,
      'count_selected_documents',
      { skillInstallId, conversationId, documentId },
      toSkillToolAudit()
    )
    expect(runner).toBeNull()
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

// SEC-1 (backend-audit 2026-06-27, Phase 6 — TEST-8): Tier-2 tools run for APP skills only. A
// user-imported `kind:'tool'` skill may DECLARE allowedTools (kept for a future per-tool grant UI)
// but runs NONE of them — the gate is at the runnable-tools surface (`skillCanRunTools`), enforced at
// `runnableToolNames` (so listRunnableTools + the run bar offer nothing) and again at `startSkillRun`
// (so a forged IPC call is refused, friendly + content-free). App skills are completely unaffected.
describe('skills tool-run IPC — SEC-1 trust gate (user kind:tool skills cannot run Tier-2 tools)', () => {
  const STATEMENT = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10'

  it('runnableToolNames/runnableToolsForSkill return [] for an enabled user kind:tool skill (gate at the source)', () => {
    const { db } = makeUserSkillHarness(STATEMENT)
    const record = getSkill(db, 'user:imported-bank')!
    // Sanity: it really is a user tool skill that DECLARED tools (so [] is the gate, not an empty list).
    expect(record.source).toBe('user')
    expect(record.kind).toBe('tool')
    expect(record.manifest.allowedTools.length).toBeGreaterThan(0)
    expect(record.enabled).toBe(true)
    // …yet it runs nothing.
    expect(runnableToolNames(record, '0.0.0-test')).toEqual([])
    expect(runnableToolsForSkill(record, '0.0.0-test')).toEqual([])
  })

  it('listRunnableTools offers nothing for a user kind:tool skill (the run bar never shows a tool)', async () => {
    const { skillInstallId, conversationId } = makeUserSkillHarness(STATEMENT)
    const { result } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, conversationId)
    expect(result).toEqual({ tools: [], documentIds: [] })
  })

  it('startSkillRun for a user kind:tool skill is refused — friendly, content-free, nothing audited', async () => {
    const { db, skillInstallId, conversationId } = makeUserSkillHarness(STATEMENT)
    const { result } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'extract_transactions',
      conversationId
    })
    const start = result as StartSkillRunResult
    expect(start.started).toBe(false)
    if (start.started) throw new Error('expected refusal')
    expect('error' in start && start.error).toBeTruthy()
    // Content-free: the refusal interpolates no skill title/id/path (the imported title's sentinel
    // must not leak into the IPC payload).
    expect(JSON.stringify(start)).not.toContain(USER_SKILL_TITLE_SENTINEL)
    expect(JSON.stringify(start)).not.toContain('imported-bank')
    // Nothing ran → no run lifecycle reached the audit (the refusal returns before runController.start).
    const auditText = listAuditEvents(db, { limit: 5000 })
      .map((e) => `${e.type} ${e.message} ${JSON.stringify(e.metadata)}`)
      .join('\n')
    expect(auditText).not.toContain('skill_run_started')
    expect(auditText).not.toContain('skill_run_done')
    expect(auditText).not.toContain(USER_SKILL_TITLE_SENTINEL)
  })

  it('an APP skill with the SAME tools is unaffected — still runnable (proves the gate keys on source)', async () => {
    // makeHarness installs the bank skill under app-skills/ (source 'app'); it must keep offering tools.
    const { skillInstallId, conversationId } = makeHarness(STATEMENT)
    const { result } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, conversationId)
    expect((result as RunnableToolSet).tools.length).toBeGreaterThan(0)
    // And it runs end-to-end (the gate did not narrow app skills).
    const final = await runTool(skillInstallId, conversationId, 'extract_transactions')
    expect(final.state).toBe('done')
  })
})

// U-1 — multi-document scope: the target is visible/choosable, the chosen id is validated MAIN-side,
// and a document TITLE never crosses the IPC (the renderer maps ids→names locally).
describe('skills tool-run IPC — multi-document targeting (U-1)', () => {
  const ONE_TXN = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10'
  const TWO_TXN = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'
  const TITLE_SENTINEL = 'XDOCTITLE_SENTINEL_secret_filename_88888'

  it('listRunnableTools returns ALL in-scope target ids (ids only) in resolution order', async () => {
    const { skillInstallId, conversationId, docIds } = makeMultiDocHarness([ONE_TXN, TWO_TXN])
    const { result } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, conversationId)
    expect((result as RunnableToolSet).documentIds).toEqual(docIds)
    expect((result as RunnableToolSet).tools.length).toBeGreaterThan(0)
  })

  it('defaults to the first in-scope document when no documentId is chosen', async () => {
    const { skillInstallId, conversationId } = makeMultiDocHarness([ONE_TXN, TWO_TXN])
    const final = await runTool(skillInstallId, conversationId, 'extract_transactions')
    expect(final.state).toBe('done')
    expect(final.transactionCount).toBe(1) // docIds[0] has one transaction
    // The target count stays honest at 1 (a single-doc tool), never implying "all N".
    expect(final.documentCount).toBe(1)
  })

  it('runs on the CHOSEN in-scope document when a documentId is supplied', async () => {
    const { skillInstallId, conversationId, docIds } = makeMultiDocHarness([ONE_TXN, TWO_TXN])
    const { result: startRaw } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'extract_transactions',
      conversationId,
      documentId: docIds[1] // the SECOND document (two transactions)
    })
    const start = startRaw as StartSkillRunResult
    if (!start.started) throw new Error('expected the run to start')
    const final = await pollUntilTerminal(start.run.runHandle)
    expect(final.state).toBe('done')
    expect(final.transactionCount).toBe(2) // proves it targeted docIds[1], not docIds[0]
    expect(final.documentCount).toBe(1)
  })

  it('REFUSES an out-of-scope documentId when the scope is AMBIGUOUS (>1 in-scope doc)', async () => {
    // With several in-scope documents the run cannot silently pick one for the user — a stale/forged id
    // is refused (never trusted past the scope filter) so they re-choose.
    const { skillInstallId, conversationId } = makeMultiDocHarness([ONE_TXN, TWO_TXN])
    const { result } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'extract_transactions',
      conversationId,
      documentId: randomUUID() // a well-formed id that is NOT in scope
    })
    const start = result as StartSkillRunResult
    expect(start.started).toBe(false)
    if (start.started) throw new Error('expected refusal')
    expect('error' in start && start.error).toBeTruthy()
  })

  it('gracefully falls back to the single in-scope document when a STALE id is supplied (no error)', async () => {
    // Regression: a target left over from a conversation switch (the run bar briefly held another chat's
    // "…(1).pdf") must NOT hard-fail with "that document isn't in this chat's documents" when the choice
    // is unambiguous — with exactly one in-scope document the run proceeds against it. The out-of-scope id
    // is never run (only ever falls back to the known in-scope doc), so the untrusted-id posture holds.
    const { skillInstallId, conversationId } = makeHarness(ONE_TXN)
    const { result: startRaw } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'extract_transactions',
      conversationId,
      documentId: randomUUID() // a stale / out-of-scope id
    })
    const start = startRaw as StartSkillRunResult
    expect(start.started).toBe(true)
    if (!start.started) throw new Error('expected the run to start on the single in-scope doc')
    const final = await pollUntilTerminal(start.run.runHandle)
    expect(final.state).toBe('done')
    expect(final.transactionCount).toBe(1) // ran against the single in-scope document
  })

  it('never leaks a document TITLE through listRunnableTools or the run state (content-free)', async () => {
    // The document's TITLE carries a sentinel; the IPC must surface only its id/counts.
    const { skillInstallId, conversationId } = makeHarness(ONE_TXN, { title: TITLE_SENTINEL })
    const { result: toolsRaw } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, conversationId)
    expect(JSON.stringify(toolsRaw)).not.toContain(TITLE_SENTINEL)
    const final = await runTool(skillInstallId, conversationId, 'extract_transactions')
    const { result: stateRaw } = await invoke(handlers, IPC.getSkillRun, final.runHandle)
    expect(JSON.stringify(stateRaw)).not.toContain(TITLE_SENTINEL)
  })
})

// U-2 — a read-only "Extract transactions" click must NOT silently start the LLM categorizer in the
// background. The Phase-33 auto-offer that enqueued a `categorize` doctask on extract is removed; the
// categorize is now an explicit one-tap follow-up on the run-bar result row (SkillRunBar.test.tsx).
describe('skills tool-run IPC — extract does not auto-categorize (U-2)', () => {
  const STATEMENT = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'

  it('an extract with rows enqueues NO categorize doctask (the model pass is user-initiated)', async () => {
    const { db, skillInstallId, conversationId } = makeHarness(STATEMENT)
    const docId = resolveInScopeDocumentIds(db, conversationId)[0]
    // A docTasks spy that records every enqueue. The old auto-offer would have started a 'categorize'
    // here (synchronously, inside the runner) whenever rows>0 and no categorize was already pending —
    // so this spy would catch a regression. The runner is exercised directly: the CI IPC ctx wires no
    // doctask lane, so the auto-offer could only be observed through the dispatch with one supplied.
    const enqueued: Array<{ kind: string }> = []
    const docTasks = {
      startDocTask: (req: { kind: string }) => {
        enqueued.push(req)
        return { jobId: 'job-1' }
      },
      hasPendingKind: () => false
    } as unknown as DocTaskManager
    const runner = buildToolRunner(
      db,
      'extract_transactions',
      { skillInstallId, conversationId, documentId: docId },
      toSkillToolAudit(),
      { docTasks, readDocumentSegments: async () => [{ text: STATEMENT, page: 1, index: 0 }] }
    )!
    const outcome = await runner({ signal: new AbortController().signal, onProgress: () => {} })
    expect(outcome.ok).toBe(true)
    expect(outcome.transactionCount).toBe(2) // rows WERE extracted (the old auto-offer's rows>0 guard would have fired)
    // …yet the LLM categorizer was never started on its own — nothing reached the doctask lane.
    expect(enqueued).toHaveLength(0)
  })
})

describe('skills export_transactions_csv IPC (S11c)', () => {
  it('confirm-gates the export: refuses without confirmation, asking for it', async () => {
    const { skillInstallId, conversationId } = makeHarness('Statement EUR\n2026-01-02 Grocery -45,90 1.954,10')
    await runTool(skillInstallId, conversationId, 'extract_transactions')
    const { result } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'export_transactions_csv',
      conversationId
    })
    expect(result).toEqual({ started: false, needsConfirmation: true })
  })

  it('confirmed + a chosen path → writes the CSV and reports "saved N rows" (content-free)', async () => {
    const { skillInstallId, conversationId } = makeHarness(
      'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'
    )
    await runTool(skillInstallId, conversationId, 'extract_transactions')
    const out = join(tempDir(), 'export.csv')
    dialogState.saveResult = { canceled: false, filePath: out }
    const final = await runTool(skillInstallId, conversationId, 'export_transactions_csv', true)
    expect(final.state).toBe('done')
    expect(final.transactionCount).toBe(2)
    // The CSV really landed on disk with the rows (content-class — that is correct).
    expect(existsSync(out)).toBe(true)
    const csv = readFileSync(out, 'utf8')
    expect(csv).toMatch(/^date,valueDate,description,amount,currency,balanceAfter,sourcePage/)
    expect(csv).toContain('Grocery')
    expect(csv).toContain('Salary')
    // …but the run state the renderer polls is ids/counts only — no figures/paths.
    const { result: stateRaw } = await invoke(handlers, IPC.getSkillRun, final.runHandle)
    expect(JSON.stringify(stateRaw)).not.toContain('Grocery')
    expect(JSON.stringify(stateRaw)).not.toContain(out)
  })

  it('export content never reaches the audit log (sentinel, ids/counts only)', async () => {
    const { db, skillInstallId, conversationId } = makeHarness(`Statement EUR\n2026-01-02 ${SENTINEL} -12,00 1.000,00`)
    await runTool(skillInstallId, conversationId, 'extract_transactions')
    const out = join(tempDir(), 'export.csv')
    dialogState.saveResult = { canceled: false, filePath: out }
    await runTool(skillInstallId, conversationId, 'export_transactions_csv', true)
    // The secret IS in the user-chosen CSV (correct) but never in the audit stream.
    expect(readFileSync(out, 'utf8')).toContain(SENTINEL)
    const auditText = listAuditEvents(db, { limit: 5000 })
      .map((e) => `${e.type} ${e.message} ${JSON.stringify(e.metadata)}`)
      .join('\n')
    expect(auditText).toContain('skill_run_done')
    expect(auditText).not.toContain(SENTINEL)
  })

  it('a cancelled save persists no file and reports it calmly', async () => {
    const { skillInstallId, conversationId } = makeHarness('Statement EUR\n2026-01-02 Grocery -45,90 1.954,10')
    await runTool(skillInstallId, conversationId, 'extract_transactions')
    dialogState.saveResult = { canceled: true } // user dismissed the save dialog
    const final = await runTool(skillInstallId, conversationId, 'export_transactions_csv', true)
    // A dismissed dialog is a CANCEL, not a failure (B1) — the run reports it calmly, with no
    // failure copy (the renderer shows the calm "cancelled" row, not a red error).
    expect(final.state).toBe('cancelled')
    expect(final.error).toBeUndefined()
  })
})

describe('skills redact_document IPC (S11d)', () => {
  const SECRET_EMAIL = 'leak.source@example.com'

  it('listRunnableTools surfaces the single redaction tool, confirm-gated', async () => {
    const { skillInstallId, conversationId } = makeRedactionHarness(`Contact ${SECRET_EMAIL} today.`)
    const { result } = await invoke(handlers, IPC.listRunnableTools, skillInstallId, conversationId)
    expect((result as RunnableToolSet).tools).toEqual<RunnableTool[]>([
      { name: 'redact_document', requiresConfirmation: true }
    ])
  })

  it('confirm-gates the redaction: refuses without confirmation, asking for it', async () => {
    const { skillInstallId, conversationId } = makeRedactionHarness(`Contact ${SECRET_EMAIL} today.`)
    const { result } = await invoke(handlers, IPC.startSkillRun, {
      skillInstallId,
      toolName: 'redact_document',
      conversationId
    })
    expect(result).toEqual({ started: false, needsConfirmation: true })
  })

  it('confirmed + a chosen path → writes the redacted copy and reports the count (content-free)', async () => {
    const { skillInstallId, conversationId } = makeRedactionHarness(
      `Contact ${SECRET_EMAIL} on 2026-03-15 about IBAN AT61 1904 3002 3457 3201.`
    )
    const out = join(tempDir(), 'redacted.txt')
    dialogState.saveResult = { canceled: false, filePath: out }
    const final = await runTool(skillInstallId, conversationId, 'redact_document', true)
    expect(final.state).toBe('done')
    expect(final.resultKind).toBe('redacted')
    expect(final.transactionCount).toBeGreaterThanOrEqual(3)
    // The redacted copy really landed on disk WITH the personal data masked out (the privacy point).
    expect(existsSync(out)).toBe(true)
    const redacted = readFileSync(out, 'utf8')
    expect(redacted).toContain('[EMAIL]')
    expect(redacted).not.toContain(SECRET_EMAIL)
    // …and the polled run state is ids/counts only — no figures/paths/secret.
    const { result: stateRaw } = await invoke(handlers, IPC.getSkillRun, final.runHandle)
    expect(JSON.stringify(stateRaw)).not.toContain(SECRET_EMAIL)
    expect(JSON.stringify(stateRaw)).not.toContain(out)
  })
})

// U5 (audit §6.2) — each export gets its OWN save-dialog metadata (title / filter label / extension),
// instead of the ONE hardcoded CSV dialog that used to serve every export. That drift gave redaction's
// "Save redacted copy" an "Export transactions" title with a `.csv` filter fighting `redacted.txt` on
// Windows. These assert the OPTIONS the dialog would show (the user-visible surface): the save result
// stays "cancelled" (the default), but showSaveDialog is called — and its options captured — regardless.
describe('skills export save-dialog metadata (U5 / §6.2)', () => {
  const tEn = (key: MessageKey): string => t('en', key)
  const firstFilter = (): { name: string; extensions: string[] } | undefined =>
    dialogState.lastSaveOptions?.filters?.[0]

  it('bank CSV export → the CSV dialog (title + .csv filter)', async () => {
    const { skillInstallId, conversationId } = makeHarness('Statement EUR\n2026-01-02 Grocery -45,90 1.954,10')
    await runTool(skillInstallId, conversationId, 'extract_transactions')
    await runTool(skillInstallId, conversationId, 'export_transactions_csv', true)
    expect(dialogState.lastSaveOptions?.title).toBe(tEn('main.dialog.exportCsv'))
    expect(firstFilter()).toEqual({ name: tEn('main.dialog.filterCsv'), extensions: ['csv'] })
  })

  it('redaction export → the "Save redacted copy" dialog with a .txt filter, NOT the CSV dialog (the §6.2 example)', async () => {
    const { skillInstallId, conversationId } = makeRedactionHarness('Contact leak.source@example.com today.')
    await runTool(skillInstallId, conversationId, 'redact_document', true)
    expect(dialogState.lastSaveOptions?.title).toBe(tEn('main.dialog.exportRedacted'))
    expect(dialogState.lastSaveOptions?.title).not.toBe(tEn('main.dialog.exportCsv')) // the drift this fixes
    expect(firstFilter()).toEqual({ name: tEn('main.dialog.filterText'), extensions: ['txt'] })
  })

  it('invoice JSON export → the JSON dialog (.json, not .csv)', async () => {
    const { skillInstallId, conversationId } = makeInvoiceHarness(INVOICE_TEXT)
    await runTool(skillInstallId, conversationId, 'extract_invoice')
    await runTool(skillInstallId, conversationId, 'export_invoice_json', true)
    expect(dialogState.lastSaveOptions?.title).toBe(tEn('main.dialog.exportJson'))
    expect(firstFilter()).toEqual({ name: tEn('main.dialog.filterJson'), extensions: ['json'] })
  })

  it('invoice XML export → the XML dialog (.xml, not .csv)', async () => {
    const { skillInstallId, conversationId } = makeInvoiceHarness(INVOICE_TEXT)
    await runTool(skillInstallId, conversationId, 'extract_invoice')
    await runTool(skillInstallId, conversationId, 'export_invoice_xml', true)
    expect(dialogState.lastSaveOptions?.title).toBe(tEn('main.dialog.exportXml'))
    expect(firstFilter()).toEqual({ name: tEn('main.dialog.filterXml'), extensions: ['xml'] })
  })
})
