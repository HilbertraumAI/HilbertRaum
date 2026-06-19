import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Full-doc-skills Phase 4 (§3.2, D49) — the CHAT wiring for the SECOND adopter: `askDocuments` routes
// an `app:invoice` analysis-shaped question to the invoice whole-document handler (deterministic
// exhaustive answer + honest `extract` coverage, NO model call). Proves the seam generalizes beyond
// bank-statement with no change to the chat router. Drives the real IPC handler with a faked transport.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  app: { getVersion: () => '0.0.0-test' }
}))

import { IPC } from '../../src/shared/ipc'
import type { Message } from '../../src/shared/types'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { createSkillRegistry } from '../../src/main/services/skills/registry'
import { createConversation } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerBuiltinSkillAnalysisHandlers, clearSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { AppContext } from '../../src/main/services/context'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'
import { t } from '../../src/shared/i18n'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const INVOICE_INSTALL_ID = 'app:invoice'

// A clean invoice: 2 line items (100,00 + 20,00 = 120,00 net), 20% VAT (24,00), gross 144,00.
const CLEAN = [
  'Invoice number INV-001',
  'Vendor Acme GmbH',
  'Invoice date 2026-01-15',
  'Widget 2 50,00 100,00',
  'Gadget 1 20,00 20,00',
  'Net total 120,00 EUR',
  'VAT 20% 24,00 EUR',
  'Gross total 144,00 EUR'
].join('\n')

function writeInvoiceSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'invoice')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: invoice',
    'title: Invoice Analysis',
    'description: Reads invoices.',
    'version: 1.0.0',
    'kind: tool',
    'allowedTools: [extract_invoice, validate_invoice_totals, export_invoice_csv]',
    '---',
    'Quote the printed figures.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

interface Harness {
  db: Db
  conversationId: string
  docId: string
  runtime: ModelRuntime & { calls: number }
  audit: { type: string; meta?: Record<string, unknown> }[]
}

/** Real DB + an ingested single invoice + an ENABLED app:invoice tool skill + the analysis registry,
 *  wired through the real `askDocuments` handler (the production path: stored copy + chunks + embeddings
 *  + fully_chunked). */
async function makeHarness(opts: { fullyChunked?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-raginvoice-'))
  const workspacePath = join(root, 'workspace')
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeInvoiceSkill(appSkillsDir)

  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir, appVersion: '0.0.0-test' })
  skills.reconcile() // installs app:invoice ENABLED

  const storeDir = documentsDir(workspacePath)
  const docPath = join(root, 'invoice.txt')
  writeFileSync(docPath, CLEAN, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })
  if (opts.fullyChunked === false) {
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(doc.id)
  }

  // A runtime that records whether it was ever asked to generate — the exhaustive path must make ZERO
  // model calls (grounding rule: deterministic copy, never the model).
  const runtime = {
    modelId: 'mock',
    calls: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(_messages: ChatMessage[]) {
      runtime.calls++
      yield 'Model answer.'
    }
  } as unknown as ModelRuntime & { calls: number }

  const audit: { type: string; meta?: Record<string, unknown> }[] = []
  const ctx = {
    paths: { rootPath: root, workspacePath },
    get db() {
      return db
    },
    workspace: { isUnlocked: () => true, documentCipher: () => null, beginDocumentWork: () => () => {} },
    runtime: { active: () => runtime, activeModelId: () => runtime.modelId },
    embedder: createMockEmbedder(),
    reranker: null,
    ocrEngine: undefined,
    manifestsDir: null,
    isDev: true,
    audit: (type: string, _message: string, meta?: Record<string, unknown>) => audit.push({ type, meta }),
    skills
  } as unknown as AppContext

  registerBuiltinSkillAnalysisHandlers()
  registerRagIpc(ctx)
  const conv = createConversation(db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds: [doc.id] }
  })
  return { db, conversationId: conv.id, docId: doc.id, runtime, audit }
}

beforeEach(() => {
  clearSkillAnalysisHandlers()
  inFlightStreams.clear()
})

describe('askDocuments — invoice analysis routing (full-doc-skills Phase 4)', () => {
  it('exhaustive path: a fully-chunked invoice gets the deterministic whole-document answer', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what are the invoice totals?',
      INVOICE_INSTALL_ID
    )
    const msg = result as Message

    // The deterministic figures — count + net/tax/gross — read from the extracted invoice (NO model).
    expect(msg.content).toContain(t('en', 'skills.invoiceAnalysis.count', { count: 2 }))
    expect(msg.content).toContain('120.00')
    expect(msg.content).toContain('24.00')
    expect(msg.content).toContain('144.00')
    expect(h.runtime.calls).toBe(0)

    // Honest extract coverage, fully chunked → the meter may say "whole document" (D48).
    expect(msg.coverage?.mode).toBe('extract')
    expect(msg.coverage?.fullyChunked).toBe(true)
    // Real source citations behind the figures (M2).
    expect(msg.citations && msg.citations.length).toBeGreaterThan(0)
    // The re-routed turn carries the skill glyph + provenance (A1): explicit pick ⇒ autoFired false.
    expect(msg.skillId).toBe(INVOICE_INSTALL_ID)
    expect(msg.autoFired).toBe(false)

    // The whole-document tools auto-ran; export NEVER did (export stays confirm-gated).
    const toolNames = h.audit.map((e) => e.meta?.toolName)
    expect(toolNames).toContain('extract_invoice')
    expect(toolNames).toContain('validate_invoice_totals')
    expect(toolNames).not.toContain('export_invoice_csv')
  })

  it('refuse path: a not-fully-chunked invoice is refused — fixed message, no model, no partial answer', async () => {
    const h = await makeHarness({ fullyChunked: false })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what is the gross total?',
      INVOICE_INSTALL_ID
    )
    const msg = result as Message

    expect(msg.content).toBe(t('en', 'skills.analysis.refusePartial'))
    expect(msg.content).not.toContain(t('en', 'skills.invoiceAnalysis.count', { count: 2 }))
    expect(h.runtime.calls).toBe(0)
    expect(msg.coverage).toBeUndefined()
    expect(msg.skillId).toBe(INVOICE_INSTALL_ID)
    // No tool ever ran (the precondition gate is BEFORE the auto-run).
    const runs = h.db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(0)
  })

  it('relevance path is byte-unchanged for an off-topic question (no handler fire)', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'who wrote this letter?',
      INVOICE_INSTALL_ID
    )
    const msg = result as Message

    expect(msg.coverage).toBeUndefined()
    expect(msg.content).not.toContain(t('en', 'skills.invoiceAnalysis.count', { count: 2 }))
    const runs = h.db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(0)
  })
})
