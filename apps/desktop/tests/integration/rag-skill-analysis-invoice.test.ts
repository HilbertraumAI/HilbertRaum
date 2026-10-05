import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import { createConversation } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { Db } from '../../src/main/services/db'
import { t } from '../../src/shared/i18n'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { writeSkillPackage } from '../helpers/skill-fixtures'
import { recordingRuntime, type RecordingRuntime } from '../helpers/scripted-runtime'
import { ingestTextFile, makeRagAskContext, makeSkillsWorld } from '../helpers/skills-world'

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
  writeSkillPackage(appSkillsDir, {
    id: 'invoice',
    title: 'Invoice Analysis',
    description: 'Reads invoices.',
    kind: 'tool',
    allowedTools: ['extract_invoice', 'validate_invoice_totals', 'export_invoice_csv'],
    // Real manifest doc signals so the W2 plausibility gate can tell an invoice from a contract.
    triggers: {
      keywords: ['invoice', 'rechnung', 'total', 'vendor'],
      mimeTypes: ['application/pdf', 'text/csv'],
      filenamePatterns: ['*invoice*', '*rechnung*', '*faktura*', '*bill*']
    },
    body: 'Quote the printed figures.'
  })
}

interface Harness {
  db: Db
  conversationId: string
  docId: string
  runtime: RecordingRuntime
  audit: { type: string; meta?: Record<string, unknown> }[]
}

/** Real DB + an ingested single invoice + an ENABLED app:invoice tool skill + the analysis registry,
 *  wired through the real `askDocuments` handler (the production path: stored copy + chunks + embeddings
 *  + fully_chunked). */
async function makeHarness(
  opts: { fullyChunked?: boolean; text?: string; file?: string; extraDoc?: { file: string; text: string } } = {}
): Promise<Harness> {
  const w = makeSkillsWorld('raginvoice', {
    seedApp: writeInvoiceSkill,
    appVersion: '0.0.0-test',
    reconcile: true // installs app:invoice ENABLED
  })
  const { db } = w

  const docId = await ingestTextFile(w, opts.file ?? 'invoice.txt', opts.text ?? CLEAN, {
    fullyChunked: opts.fullyChunked
  })

  // Optional second in-scope document (for the W2 auto-narrow path): its filename deliberately does NOT
  // match the invoice manifest signals, so exactly ONE candidate (the invoice) narrows the multi-doc scope.
  let extraDocId: string | null = null
  if (opts.extraDoc) {
    extraDocId = await ingestTextFile(w, opts.extraDoc.file, opts.extraDoc.text)
  }

  // A runtime that records whether it was ever asked to generate (the exhaustive/template path must make
  // ZERO model calls) AND captures the messages it was handed, so a grounded-data turn can assert the
  // model saw the JSON data block + the verbatim rules.
  const runtime = recordingRuntime('Model answer.')

  const { ctx, audit } = makeRagAskContext(w, runtime)

  registerBuiltinSkillAnalysisHandlers()
  registerRagIpc(ctx)
  const conv = createConversation(db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds: extraDocId ? [docId, extraDocId] : [docId] }
  })
  return { db, conversationId: conv.id, docId, runtime, audit }
}

beforeEach(() => {
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

  it('A4 (SKA-7 structural): a NON-vocabulary question over a signal-matching invoice inverts to grounded-data', async () => {
    // Pre-A4 an on-topic-but-vocabulary-miss question over an active invoice skill fell to raw top-k. Now,
    // because the document matches the invoice skill's manifest signals (`invoice.txt` / `*invoice*`), the
    // gate INVERTS: the handler answers from the VERIFIED extract (grounded-data) — post-W6 it honestly
    // declines an off-data question rather than doing top-k arithmetic. (The bank analogue is pinned in
    // rag-skill-analysis.test.ts; here the harness already ships invoice doc signals.)
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'who wrote this letter?',
      INVOICE_INSTALL_ID
    )
    const msg = result as Message

    // The handler ran (grounded-data over the JSON), NOT the relevance path.
    expect(msg.coverage?.mode).toBe('extract')
    expect(h.runtime.calls).toBe(1)
    const lastTurn = h.runtime.lastMessages[h.runtime.lastMessages.length - 1]
    expect(lastTurn.content).toContain('Invoice (JSON):')
    expect(msg.skillId).toBe(INVOICE_INSTALL_ID)
  })

  it('A4: a NON-vocabulary question over a NON-invoice doc (no signal, no prior extraction) keeps relevance', async () => {
    // The doc matches none of the invoice manifest signals (a plain letter) and was never extracted → the
    // phrasing gate stands (the W2 plausibility posture, inverted): the ordinary relevance path answers and
    // the invoice extractor is never force-run.
    const h = await makeHarness({ fullyChunked: true, file: 'letter.txt', text: 'Dear Sir, thank you for your correspondence regarding the matter at hand.' })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'who wrote this letter?',
      INVOICE_INSTALL_ID
    )
    const msg = result as Message

    expect(msg.coverage?.mode).not.toBe('extract')
    expect(msg.content).not.toContain(t('en', 'skills.invoiceAnalysis.count', { count: 2 }))
    const runs = h.db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(0)
  })

  it('refuse path: a not-fully-chunked invoice is refused — fixed message, no model, no partial answer', async () => {
    // The D45 gate keys on the handler's mode, so this is the invoice handler's own proof: an exhaustive
    // handler never answers from a legacy, partly-indexed document (the bank twin is in rag-skill-analysis).
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
    expect(h.runtime.calls).toBe(0)
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
})
