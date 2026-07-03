import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// SKILLS real-model smoke (skills-remediation T1, audit §7 rec 5) — the autonomous stand-in for the manual
// GUI smoke of the three complaint flows (bank statement, invoice, meeting minutes). The vitest suite
// proves the LOGIC against the mock runtime; NO skill path is otherwise ever exercised against a real model
// — the same test-blindness class that shipped RUNTIME-5/6 (vision salad) and INVOICE-TOTALS-1 (green tests
// on synthetic fixtures). This drives the REAL production answer paths — the invoice/bank third mode
// (grounded-data: the model narrates the verified extract) and the whole-document minutes — against a real
// local llama.cpp model, and asserts STRUCTURE + FIGURES (the deterministic totals echo rides under the
// model answer; the extract count is the parser's, not the model's), never prose/wording.
//
// GATED, opt-in: it spawns a multi-GB model (RAM + minutes) so it NEVER runs in the normal suite. Point it
// at a local chat GGUF and run:
//   SKILLS_SMOKE_MODEL=D:/models/chat/qwen3.5-4b-ud-q4kxl.gguf npx vitest run tests/e2e-model/skills-smoke.test.ts
//   (PowerShell:  $env:SKILLS_SMOKE_MODEL="D:/models/chat/…gguf"; npx vitest run tests/e2e-model/skills-smoke.test.ts)
// Overrides (defaults target the D: drive): HILBERTRAUM_LLAMA_BIN, SKILLS_SMOKE_ROOT.
// describe.runIf keeps it COLLECTED (FullSuiteGuard) but SKIPPED with no model path set — nothing in the
// default `npm test` needs a model or the network. Docs: model-benchmarks.md §10.

const MODEL_PATH = process.env.SKILLS_SMOKE_MODEL
const RUN = typeof MODEL_PATH === 'string' && MODEL_PATH.length > 0
const ROOT_PATH = process.env.SKILLS_SMOKE_ROOT ?? 'D:/'
const LLAMA_BIN = process.env.HILBERTRAUM_LLAMA_BIN ?? 'D:/runtime/llama.cpp/win/llama-server.exe'
// The product default context (the flagship de-AT turn users hit); small fixtures never truncate at 4096.
const CONTEXT_TOKENS = 4096

// Deep main services may import electron transitively (logging/app paths); stub it for the node run.
vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {},
  app: { getVersion: () => '0.0.0-test', getPath: () => tmpdir(), isPackaged: false }
}))

import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, getSettings } from '../../src/main/services/settings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { appendMessage, createConversation, type TurnSkill } from '../../src/main/services/chat'
import { generateGroundedAnswer, generateGroundedDataAnswer, ragSettingsFrom } from '../../src/main/services/rag'
import { RuntimeManager, type ModelRuntime } from '../../src/main/services/runtime'
import { createSelectingRuntimeFactory } from '../../src/main/services/runtime/factory'
import {
  BANK_STATEMENT_INSTALL_ID,
  bankStatementAnalysisHandler
} from '../../src/main/services/skills/analysis/bank-statement'
import { INVOICE_INSTALL_ID, invoiceAnalysisHandler } from '../../src/main/services/skills/analysis/invoice'
import type { SkillAnalysisContext, SkillAnalysisResult } from '../../src/main/services/skills/analysis/types'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { RetrievalScope } from '../../src/shared/types'
import { BANK_FIXTURES, INVOICE_FIXTURES } from '../fixtures/real-layouts/corpus'

const tr = (key: MessageKey, params?: MessageParams): string => t('de', key, params)

// --- Fixtures --------------------------------------------------------------------------------------------
// Bank + invoice reuse the committed real-layout corpus (one bank, one invoice). The minutes transcript is
// inline (a whole-document instruction skill, no extractor); it ENDS with its decision + action so a tail
// hit proves whole-document coverage (the same design as the Wave-3 real-model harness).

const BANK_FIXTURE = BANK_FIXTURES[0] // Raiffeisen ELBA — NBSP / U+2212 / cross-year / wrapped SEPA payee
const INVOICE_FIXTURE = INVOICE_FIXTURES[0] // Steuerkanzlei — Steuerberatung stays an item; net/tax/gross

const MINUTES_TRANSCRIPT_DE = [
  'Wöchentliches Produkt-Sync — Rohtranskript. Anwesend: Mara (PM), Tobias (Eng), Dana (Support).',
  '[00:01] Tobias: Version 2.4 ist feature-complete, aber es gibt einen Absturz bei leerem Arbeitsbereich.',
  '[00:03] Mara: Wir liefern 2.4 NICHT aus, bis der Absturz behoben ist. Die langsame Suche verschieben wir auf 2.5.',
  '[00:12] Dana: Der Support-Rückstand liegt bei 140 Tickets, gestiegen von 90.',
  '[00:18] Mara: Entscheidung: 2.4 bleibt blockiert bis zum Crash-Fix; langsame Suche auf 2.5 verschoben.',
  '[00:19] Mara: Aktionspunkt: Dana schickt mir die aktualisierten Ticket-Zahlen am Freitag.'
].join('\n\n')

const MINUTES_SKILL: TurnSkill = {
  installId: 'app:meeting-protocol',
  title: 'Besprechungsprotokoll',
  body: 'Produce structured minutes with these sections: 1. Short summary; 2. Attendees; 3. Decisions; 4. Action items (owner + deadline); 5. Open questions. Separate what was DECIDED from what was merely discussed. Work only from the source.'
}

// --- Harness ---------------------------------------------------------------------------------------------

let runtime: ModelRuntime
let manager: RuntimeManager
const embedder = createMockEmbedder()

interface Ws {
  db: Db
  root: string
  workspacePath: string
}
function freshWorkspace(): Ws {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-skills-smoke-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return { db, root, workspacePath }
}

/** Seed one chunk per fixture PAGE (a chunk = a page on the real path), so the analysis handler extracts
 *  EXACTLY what the real-layout snapshot pins — the smoke never depends on the ingestion chunker's splits. */
function seedStructuredDoc(db: Db, title: string, pages: string[]): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
     VALUES (?, ?, 'indexed', 'application/pdf', ?, ?, ?)`
  ).run(docId, title, now, now, now)
  pages.forEach((text, i) => {
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), docId, i, text, title, i + 1, now)
  })
  return docId
}

function analysisCtx(db: Db, skillInstallId: string, docId: string, question: string): SkillAnalysisContext {
  const scope: RetrievalScope = { collectionIds: [], documentIds: [docId] }
  return { db, scope, question, skillInstallId, conversationId: null, audit: () => {}, tr }
}

/** Drive the invoice/bank THIRD MODE end-to-end: the handler routes to grounded-data (model-free), then the
 *  real model narrates the verified extract with the deterministic figure echo appended verbatim beneath. */
async function runGroundedData(
  label: string,
  handler: typeof bankStatementAnalysisHandler,
  skillInstallId: string,
  docId: string,
  db: Db,
  question: string
): Promise<{ res: SkillAnalysisResult; content: string }> {
  const res = await handler.run!(analysisCtx(db, skillInstallId, docId, question))
  // The routing decision itself is deterministic + model-free — a non-summary/non-format ask must reach the
  // third mode (grounded-data). If this ever regresses, the smoke fails loudly rather than silently testing
  // the template.
  expect(res.mode, `${label}: question must route to grounded-data (the third mode)`).toBe('grounded-data')
  expect(res.dataBlock, `${label}: a serialized verified extract`).toBeTruthy()
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: question })
  const msg = await generateGroundedDataAnswer(db, runtime, conv.id, question, {
    dataBlock: res.dataBlock!,
    postscript: res.postscript ?? '',
    citations: res.citations,
    coverage: res.coverage
  })
  // eslint-disable-next-line no-console
  console.log(`\n===== ${label} =====\n${msg.content}\n`)
  return { res, content: msg.content }
}

beforeAll(async () => {
  if (!RUN) return
  expect(existsSync(MODEL_PATH as string), `model weights at ${MODEL_PATH}`).toBe(true)
  expect(existsSync(LLAMA_BIN), `llama-server at ${LLAMA_BIN}`).toBe(true)
  process.env.HILBERTRAUM_LLAMA_BIN = LLAMA_BIN
  // Force CPU (--device none): robust + deterministic for a harness (no GPU crash-fallback wiring here).
  const factory = createSelectingRuntimeFactory({ rootPath: ROOT_PATH, isDev: true, gpu: { getGpuMode: () => 'off' } })
  manager = new RuntimeManager(factory)
  await manager.start({ modelId: 'skills-smoke', modelPath: MODEL_PATH as string, contextTokens: CONTEXT_TOKENS })
  const active = manager.active()
  expect(active, 'a runtime is active').not.toBeNull()
  runtime = active as ModelRuntime
  expect(runtime.backend, 'real (non-mock) backend').not.toBe('mock')
  // eslint-disable-next-line no-console
  console.log(`\n[skills-smoke] backend=${runtime.backend} ctx=${runtime.contextWindow?.()}\n`)
}, 180_000)

afterAll(async () => {
  await manager?.stop().catch(() => {})
})

describe.runIf(RUN)('skills real-model smoke — bank / invoice / minutes', () => {
  it('BANK: grounded-data narration over the verified statement + deterministic cashflow echo', async () => {
    const ws = freshWorkspace()
    const docId = seedStructuredDoc(ws.db, BANK_FIXTURE.title, BANK_FIXTURE.chunks)
    const question = 'Wofür war die SEPA-Lastschrift an Netflix und wie hoch war sie?'
    const { res, content } = await runGroundedData(
      'BANK', bankStatementAnalysisHandler, BANK_STATEMENT_INSTALL_ID, docId, ws.db, question
    )
    // STRUCTURE: the verified extract the model was handed carries the parsed rows (count is the parser's).
    expect(res.dataBlock).toContain('NETFLIX')
    expect(res.dataBlock).toContain('Dauerauftrag Miete')
    // FIGURES: the deterministic cashflow echo (in/out/net, verbatim) rides UNDER the model answer.
    expect(res.postscript).toBeTruthy()
    expect(content).toContain(res.postscript)
    // The model actually produced a (non-empty) narration above the deterministic echo — not just the echo.
    expect(content.length).toBeGreaterThan((res.postscript ?? '').length + 20)
  }, 300_000)

  it('INVOICE: grounded-data narration over the verified invoice + deterministic totals echo', async () => {
    const ws = freshWorkspace()
    const docId = seedStructuredDoc(ws.db, INVOICE_FIXTURE.title, INVOICE_FIXTURE.chunks)
    const question = 'Wer hat diese Rechnung ausgestellt und bis wann muss ich sie bezahlen?'
    const { res, content } = await runGroundedData(
      'INVOICE', invoiceAnalysisHandler, INVOICE_INSTALL_ID, docId, ws.db, question
    )
    // STRUCTURE: the label theft stays dead — Steuerberatung is a line item in the data the model narrates.
    expect(res.dataBlock).toContain('Steuerberatung')
    // FIGURES: the deterministic net/tax/gross echo (verbatim) rides UNDER the model answer.
    expect(res.postscript).toBeTruthy()
    expect(content).toContain(res.postscript)
    expect(content.length).toBeGreaterThan((res.postscript ?? '').length + 20)
  }, 300_000)

  it('MINUTES: whole-document coverage, capped + not truncated, END-of-transcript items present', async () => {
    const ws = freshWorkspace()
    const p = join(ws.root, 'transcript.txt')
    writeFileSync(p, MINUTES_TRANSCRIPT_DE, 'utf8')
    const doc = createQueuedDocument(ws.db, p)
    await processDocument(ws.db, documentsDir(ws.workspacePath), doc.id, { embedder })
    const question = 'Erstelle ein Besprechungsprotokoll.'
    const conv = createConversation(ws.db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [doc.id] }
    })
    appendMessage(ws.db, { conversationId: conv.id, role: 'user', content: question })
    const settings = ragSettingsFrom(getSettings(ws.db))
    const msg = await generateGroundedAnswer(ws.db, runtime, embedder, conv.id, question, settings, {
      skill: MINUTES_SKILL,
      wholeDocument: { documentId: doc.id }
    })
    // eslint-disable-next-line no-console
    console.log(`\n===== MINUTES =====\n${msg.content}\n`)
    // STRUCTURE: honest whole-document coverage (the small transcript never truncates at 4096).
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    expect(msg.content.length).toBeGreaterThan(80)
    // The tail decision + action (langsame Suche → 2.5, Dana → Freitag) prove the whole document was read.
    const lc = msg.content.toLowerCase()
    expect(lc.includes('2.5') || lc.includes('freitag') || lc.includes('dana')).toBe(true)
  }, 300_000)
})
