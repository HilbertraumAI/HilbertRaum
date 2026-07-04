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
    // Real manifest doc signals so the W2 plausibility gate can tell an invoice from a contract.
    'triggers:',
    '  keywords: [invoice, rechnung, total, vendor]',
    '  mimeTypes: [application/pdf, text/csv]',
    '  filenamePatterns: ["*invoice*", "*rechnung*", "*faktura*", "*bill*"]',
    '---',
    'Quote the printed figures.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

interface Harness {
  db: Db
  conversationId: string
  docId: string
  runtime: ModelRuntime & { calls: number; lastMessages: ChatMessage[] }
  audit: { type: string; meta?: Record<string, unknown> }[]
}

/** Real DB + an ingested single invoice + an ENABLED app:invoice tool skill + the analysis registry,
 *  wired through the real `askDocuments` handler (the production path: stored copy + chunks + embeddings
 *  + fully_chunked). */
async function makeHarness(
  opts: { fullyChunked?: boolean; text?: string; file?: string; extraDoc?: { file: string; text: string } } = {}
): Promise<Harness> {
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
  const docPath = join(root, opts.file ?? 'invoice.txt')
  writeFileSync(docPath, opts.text ?? CLEAN, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })
  if (opts.fullyChunked === false) {
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(doc.id)
  }

  // Optional second in-scope document (for the W2 auto-narrow path): its filename deliberately does NOT
  // match the invoice manifest signals, so exactly ONE candidate (the invoice) narrows the multi-doc scope.
  let extraDocId: string | null = null
  if (opts.extraDoc) {
    const extraPath = join(root, opts.extraDoc.file)
    writeFileSync(extraPath, opts.extraDoc.text, 'utf8')
    const extra = createQueuedDocument(db, extraPath)
    await processDocument(db, storeDir, extra.id, { embedder: createMockEmbedder() })
    extraDocId = extra.id
  }

  // A runtime that records whether it was ever asked to generate (the exhaustive/template path must make
  // ZERO model calls) AND captures the messages it was handed, so a grounded-data turn can assert the
  // model saw the JSON data block + the verbatim rules.
  const runtime = {
    modelId: 'mock',
    calls: 0,
    lastMessages: [] as ChatMessage[],
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[]) {
      runtime.calls++
      runtime.lastMessages = messages
      yield 'Model answer.'
    }
  } as unknown as ModelRuntime & { calls: number; lastMessages: ChatMessage[] }

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
    scope: { collectionIds: [], documentIds: extraDocId ? [doc.id, extraDocId] : [doc.id] }
  })
  return { db, conversationId: conv.id, docId: doc.id, runtime, audit }
}

beforeEach(() => {
  clearSkillAnalysisHandlers()
  inFlightStreams.clear()
})

describe('askDocuments — invoice analysis routing (full-doc-skills Phase 4)', () => {
  it('template path: a summary-shaped question gets the deterministic whole-document answer + Details', async () => {
    // W3: a SUMMARY-shaped ask ("give me a summary…") keeps the deterministic template (0 model calls).
    // A bare "what are the totals?" now routes to grounded-data (see below) — the template is reserved for
    // the high-stakes summary/reconcile/list shapes, so this test drives the template with a summary ask.
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'give me a summary of this invoice',
      INVOICE_INSTALL_ID
    )
    const msg = result as Message

    // The deterministic figures — count + net/tax/gross — read from the extracted invoice (NO model).
    expect(msg.content).toContain(t('en', 'skills.invoiceAnalysis.count', { count: 2 }))
    expect(msg.content).toContain('120.00')
    expect(msg.content).toContain('24.00')
    expect(msg.content).toContain('144.00')
    expect(h.runtime.calls).toBe(0)

    // W3 Details block: the loaded header fields (vendor, invoice number) now surface on the template too.
    expect(msg.content).toContain(t('en', 'skills.invoiceAnalysis.detailsHeading'))
    expect(msg.content).toContain('Acme GmbH')
    expect(msg.content).toContain('INV-001')

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

  it('grounded-data path: a vendor question streams a model answer over the JSON + deterministic postscript', async () => {
    // W3 (audit §3.1/§8.1): "who is the vendor?" is neither a format nor a summary shape, so instead of
    // the wrong totals template it streams a MODEL answer that narrates the verified extract, with the
    // parsed totals echoed deterministically beneath it.
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, 'who is the vendor?', INVOICE_INSTALL_ID)
    const msg = result as Message

    // The model WAS called (this is the whole point of the third mode), and its answer is persisted.
    expect(h.runtime.calls).toBe(1)
    expect(msg.content).toContain('Model answer.')

    // The prompt the model saw carried the serialized JSON data block + the strict verbatim rule.
    const lastTurn = h.runtime.lastMessages[h.runtime.lastMessages.length - 1]
    expect(lastTurn.role).toBe('user')
    expect(lastTurn.content).toContain('Invoice (JSON):')
    expect(lastTurn.content).toContain('"vendor": "Acme GmbH"')
    expect(lastTurn.content).toContain('quote them EXACTLY')
    expect(lastTurn.content).toContain('Do NOT do arithmetic')

    // The grounded-data SYSTEM prompt drops the "[S1]" excerpt-citation rule (this turn has no numbered
    // excerpts) and instead forbids inline [S] markers — no dangling-citation invitation (review finding).
    const systemTurn = h.runtime.lastMessages[0]
    expect(systemTurn.role).toBe('system')
    expect(systemTurn.content).not.toContain('Cite sources inline')
    expect(systemTurn.content).toContain('Do NOT add inline [S1]')

    // The deterministic figure echo (postscript) is appended verbatim UNDER the model answer, and it
    // matches the PARSED totals exactly (net 120 / tax 24 / gross 144) — a model misquote is contradicted.
    expect(msg.content).toContain('120.00')
    expect(msg.content).toContain('24.00')
    expect(msg.content).toContain('144.00')
    expect(msg.content).toContain(t('en', 'skills.invoiceAnalysis.figureEchoNet', { value: '120.00 EUR' }))
    expect(msg.content.indexOf('Model answer.')).toBeLessThan(msg.content.indexOf('120.00'))

    // Honest extract coverage + citations pass straight through from the handler; the skill fence rode the
    // turn so the row is stamped.
    expect(msg.coverage?.mode).toBe('extract')
    expect(msg.citations && msg.citations.length).toBeGreaterThan(0)
    expect(msg.skillId).toBe(INVOICE_INSTALL_ID)

    // The read-only tools still auto-ran (validation feeds the data block); export never did.
    const toolNames = h.audit.map((e) => e.meta?.toolName)
    expect(toolNames).toContain('extract_invoice')
    expect(toolNames).toContain('validate_invoice_totals')
    expect(toolNames).not.toContain('export_invoice_csv')
  })

  it('grounded-data path: an explanatory "warum stimmen die Summen nicht?" is NOT the byte-identical template', async () => {
    // W3 why-guard (audit §3.1 / W4 follow-up): a "summe"-bearing question that ASKS WHY routes to
    // grounded-data (the template can only print figures, never explain) — no repeat byte-identical template.
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'warum stimmen die Summen nicht?',
      INVOICE_INSTALL_ID
    )
    const msg = result as Message

    expect(h.runtime.calls).toBe(1)
    expect(msg.content).toContain('Model answer.')
    // NOT the deterministic template's headline count line.
    expect(msg.content).not.toContain(t('en', 'skills.invoiceAnalysis.count', { count: 2 }))
  })

  it('format path is unchanged: "as JSON" still serializes deterministically (no model)', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, 'give me this invoice as JSON', INVOICE_INSTALL_ID)
    const msg = result as Message

    expect(h.runtime.calls).toBe(0)
    expect(msg.content).toContain('```json')
    expect(msg.content).toContain('"vendor": "Acme GmbH"')
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

  it('W2 plausibility gate: a zero-content read on a NON-invoice falls through to the grounded path', async () => {
    // The invoice skill is sticky but a plain contract is in scope: the extractor finds no line items or
    // totals, and the doc matches none of the invoice's manifest signals — so instead of the misleading
    // "I read the whole invoice but couldn't find any line items or totals", the LLM answers the actual
    // question via the ordinary grounded path (audit §4.5).
    const h = await makeHarness({
      file: 'service-contract.txt',
      text:
        'This service agreement covers the total scope of work agreed between the provider and the ' +
        'client. Either party may end the agreement with notice; no amounts are stated in this clause.'
    })
    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, 'what is the total?', INVOICE_INSTALL_ID)
    const msg = result as Message

    expect(msg.content).not.toBe(t('en', 'skills.invoiceAnalysis.empty'))
    expect(msg.content).toContain('Model answer.')
    expect(h.runtime.calls).toBe(1)
    expect(msg.coverage?.mode).not.toBe('extract')
  })

  it('W2 scope-notice rides the grounded-data path: narrow → notice → model answer → totals postscript', async () => {
    // Two docs in scope, only ONE an invoice (the other's filename matches no invoice signal). A vendor
    // question (grounded-data) auto-narrows to the invoice, and the honest narrow-scope notice must LEAD
    // the streamed + persisted answer, ahead of the model answer and the deterministic totals postscript.
    const h = await makeHarness({
      fullyChunked: true,
      extraDoc: { file: 'meeting-notes.txt', text: 'Team sync notes: we discussed the roadmap and next steps.' }
    })
    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, 'who is the vendor?', INVOICE_INSTALL_ID)
    const msg = result as Message

    expect(h.runtime.calls).toBe(1)
    const title = (h.db.prepare('SELECT title FROM documents WHERE id = ?').get(h.docId) as { title: string }).title
    const notice = t('en', 'skills.analysis.scopeNarrowed', { title, count: 1 })
    expect(msg.content).toContain(notice)
    // Order: scope notice first, then the model answer, then the deterministic figure echo.
    expect(msg.content.indexOf(notice)).toBeLessThan(msg.content.indexOf('Model answer.'))
    expect(msg.content.indexOf('Model answer.')).toBeLessThan(msg.content.indexOf('144.00'))
  })

  it('summary routing is WORD-anchored: "bestimmen" is grounded-data, "stimmen die Summen?" is the template', async () => {
    // The reconcile stem is word-anchored (\\bstimm(en|t)\\b), so an unrelated verb like "bestimmen" no
    // longer over-fires to the template (review finding): it routes to grounded-data (1 model call).
    const h1 = await makeHarness({ fullyChunked: true })
    const r1 = (await invoke(handlers, IPC.askDocuments, h1.conversationId, 'kannst du die rechnungsposten bestimmen?', INVOICE_INSTALL_ID)).result as Message
    expect(h1.runtime.calls).toBe(1)
    expect(r1.content).toContain('Model answer.')

    // "Stimmen die Summen?" is a genuine reconcile ask → the deterministic template (0 model calls).
    const h2 = await makeHarness({ fullyChunked: true })
    const r2 = (await invoke(handlers, IPC.askDocuments, h2.conversationId, 'stimmen die Summen?', INVOICE_INSTALL_ID)).result as Message
    expect(h2.runtime.calls).toBe(0)
    expect(r2.content).toContain(t('en', 'skills.invoiceAnalysis.count', { count: 2 }))
  })
})
