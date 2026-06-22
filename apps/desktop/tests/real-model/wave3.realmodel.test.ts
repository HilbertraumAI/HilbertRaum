import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// REAL-MODEL harness (Wave 3) — drives the ACTUAL whole-doc / compare / tree code paths with a real
// local llama.cpp model from the portable drive, no GUI and no workspace access. It is the autonomous
// stand-in for the manual GUI smoke test: the vitest suite already proves the LOGIC against the mock
// runtime; this proves real-model OUTPUT QUALITY (the sectioned minutes, the tail changes in a compare,
// the tree reduce) in BOTH English and German. The whole-doc/compare/tree paths read chunks IN ORDER
// (not by embedding), so a mock embedder is enough for ingestion — only the CHAT model is real.
//
// GATED: it spawns a multi-GB model (RAM + minutes), so it NEVER runs in the normal suite. Run it with:
//   HILBERTRAUM_REAL_MODEL=1 npx vitest run tests/real-model/wave3.realmodel.test.ts
//   (just the German set:  … tests/real-model/wave3.realmodel.test.ts -t German)
//   (PowerShell:  $env:HILBERTRAUM_REAL_MODEL=1; npx vitest run …)
// Overrides (defaults target the D: drive): HILBERTRAUM_REAL_MODEL_PATH, HILBERTRAUM_LLAMA_BIN.
// describe.runIf keeps it COLLECTED (FullSuiteGuard) but skipped without the flag.

const RUN = process.env.HILBERTRAUM_REAL_MODEL === '1'
const MODEL_PATH =
  process.env.HILBERTRAUM_REAL_MODEL_PATH ?? 'D:/models/chat/qwen3.5-4b-ud-q4kxl.gguf'
const LLAMA_BIN = process.env.HILBERTRAUM_LLAMA_BIN ?? 'D:/runtime/llama.cpp/win/llama-server.exe'
const CONTEXT_TOKENS = 8192

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
import { generateGroundedAnswer, ragSettingsFrom } from '../../src/main/services/rag'
import { answerWholeDocFromTree } from '../../src/main/services/rag/whole-doc-tree'
import { RuntimeManager } from '../../src/main/services/runtime'
import { createSelectingRuntimeFactory } from '../../src/main/services/runtime/factory'
import type { ModelRuntime } from '../../src/main/services/runtime'

// --- Fixtures (inline so the harness is self-contained) ---------------------------------------
// Each transcript ENDS with its decisions/actions (Prometheus→Q3, Dana→Friday/Freitag) so a tail hit
// proves whole-document coverage; each contract pair puts its high-impact changes LATE (liability,
// confidentiality, jurisdiction) so a hit on "Frankfurt" proves both whole versions were read.

const MEETING_TRANSCRIPT_EN = [
  'Weekly Product Sync — raw transcript. Present: Mara (PM), Tobias (Eng), Priya (Design), Dana (Support).',
  '[00:01] Tobias: 2.4 is feature-complete. Two open tickets: a slow-search regression and a crash on empty workspace.',
  '[00:03] Mara: We do NOT ship 2.4 until the empty-workspace crash is fixed. Slow-search slips to 2.5.',
  '[00:08] Priya: Onboarding redesign — open question is whether to auto-import sample docs on first launch.',
  '[00:12] Dana: Support backlog is 140 tickets, up from 90, mostly slow-search and license-activation confusion.',
  '[00:16] Tobias: We should decide on the Prometheus metrics integration. Mara: Let’s park it — not this quarter, revisit in Q3 planning.',
  '[00:18] Mara: Reading back the decisions: (1) 2.4 blocked on the empty-workspace crash; (2) slow-search deferred to 2.5; (3) proceed with auto-importing deletable sample docs, pending Priya’s mockup; (4) Prometheus integration parked until Q3 planning.',
  '[00:19] Mara: Action items: Tobias owns the crash fix by end of week; Priya delivers the sample-docs mockup by Thursday; Dana sends me the updated ticket counts on Friday.'
].join('\n\n')

const MEETING_TRANSCRIPT_DE = [
  'Wöchentliches Produkt-Sync — Rohtranskript. Anwesend: Mara (PM), Tobias (Eng), Priya (Design), Dana (Support).',
  '[00:01] Tobias: 2.4 ist feature-complete. Zwei offene Tickets: eine Langsame-Suche-Regression und ein Absturz bei leerem Arbeitsbereich.',
  '[00:03] Mara: Wir liefern 2.4 NICHT aus, bis der Absturz bei leerem Arbeitsbereich behoben ist. Die langsame Suche wird auf 2.5 verschoben.',
  '[00:08] Priya: Onboarding-Redesign — offene Frage: sollen Beispieldokumente beim ersten Start automatisch importiert werden?',
  '[00:12] Dana: Der Support-Rückstand liegt bei 140 Tickets, gestiegen von 90, hauptsächlich langsame Suche und Verwirrung bei der Lizenzaktivierung.',
  '[00:16] Tobias: Wir sollten über die Prometheus-Metrik-Integration entscheiden. Mara: Parken wir das — nicht dieses Quartal, erneut in der Q3-Planung betrachten.',
  '[00:18] Mara: Ich fasse die Entscheidungen zusammen: (1) 2.4 blockiert durch den Absturz bei leerem Arbeitsbereich; (2) langsame Suche auf 2.5 verschoben; (3) automatischer Import löschbarer Beispieldokumente, vorbehaltlich Priyas Mockup; (4) Prometheus-Integration bis zur Q3-Planung geparkt.',
  '[00:19] Mara: Aktionspunkte: Tobias übernimmt den Crash-Fix bis Ende der Woche; Priya liefert das Beispieldokumente-Mockup bis Donnerstag; Dana schickt mir die aktualisierten Ticket-Zahlen am Freitag.'
].join('\n\n')

const CONTRACT_V1_EN = [
  'SOFTWARE MAINTENANCE AGREEMENT — Version 1 (2025).',
  '5. FEES. 5.2 Invoices are due within thirty (30) days of the invoice date.',
  '6. TERM. 6.1 Initial term of twelve (12) months. 6.2 Auto-renews unless either party gives ninety (90) days written notice of non-renewal.',
  '8. LIABILITY. 8.1 Each party’s total aggregate liability shall not exceed the total fees paid by Customer in the twelve (12) months preceding the claim.',
  '9. CONFIDENTIALITY. 9.2 This obligation survives termination for a period of three (3) years.',
  '10. GOVERNING LAW. 10.2 The exclusive place of jurisdiction for all disputes is Berlin.'
].join('\n\n')

const CONTRACT_V2_EN = [
  'SOFTWARE MAINTENANCE AGREEMENT — Version 2 (2026).',
  '5. FEES. 5.2 Invoices are due within fourteen (14) days of the invoice date.',
  '6. TERM. 6.1 Initial term of twenty-four (24) months. 6.2 Auto-renews unless either party gives sixty (60) days written notice of non-renewal.',
  '8. LIABILITY. 8.1 Each party’s total aggregate liability shall not exceed the total fees paid by Customer in the six (6) months preceding the claim.',
  '9. CONFIDENTIALITY. 9.2 This obligation survives termination for a period of five (5) years.',
  '10. GOVERNING LAW. 10.2 The exclusive place of jurisdiction for all disputes is Frankfurt am Main.'
].join('\n\n')

const CONTRACT_V1_DE = [
  'SOFTWARE-WARTUNGSVERTRAG — Version 1 (2025).',
  '5. ENTGELTE. 5.2 Rechnungen sind innerhalb von dreißig (30) Tagen ab Rechnungsdatum fällig.',
  '6. LAUFZEIT. 6.1 Anfängliche Laufzeit von zwölf (12) Monaten. 6.2 Verlängert sich automatisch, sofern nicht eine Partei mit einer Frist von neunzig (90) Tagen schriftlich kündigt.',
  '8. HAFTUNG. 8.1 Die Gesamthaftung jeder Partei ist auf die in den zwölf (12) Monaten vor dem Anspruch gezahlten Entgelte begrenzt.',
  '9. VERTRAULICHKEIT. 9.2 Diese Pflicht besteht nach Vertragsende für drei (3) Jahre fort.',
  '10. ANWENDBARES RECHT. 10.2 Ausschließlicher Gerichtsstand für alle Streitigkeiten ist Berlin.'
].join('\n\n')

const CONTRACT_V2_DE = [
  'SOFTWARE-WARTUNGSVERTRAG — Version 2 (2026).',
  '5. ENTGELTE. 5.2 Rechnungen sind innerhalb von vierzehn (14) Tagen ab Rechnungsdatum fällig.',
  '6. LAUFZEIT. 6.1 Anfängliche Laufzeit von vierundzwanzig (24) Monaten. 6.2 Verlängert sich automatisch, sofern nicht eine Partei mit einer Frist von sechzig (60) Tagen schriftlich kündigt.',
  '8. HAFTUNG. 8.1 Die Gesamthaftung jeder Partei ist auf die in den sechs (6) Monaten vor dem Anspruch gezahlten Entgelte begrenzt.',
  '9. VERTRAULICHKEIT. 9.2 Diese Pflicht besteht nach Vertragsende für fünf (5) Jahre fort.',
  '10. ANWENDBARES RECHT. 10.2 Ausschließlicher Gerichtsstand für alle Streitigkeiten ist Frankfurt am Main.'
].join('\n\n')

// SKILL.md bodies stay ENGLISH (the project convention — the fence framing is English; only the doc +
// question are German). The system prompt instructs the model to answer in the document's language.
const MEETING_SKILL: TurnSkill = {
  installId: 'app:meeting-protocol',
  title: 'Meeting Minutes',
  body: 'Produce structured minutes with these sections: 1. Short summary; 2. Attendees; 3. Topics; 4. Decisions; 5. Action items (owner + deadline); 6. Open questions. Separate what was DECIDED from what was merely discussed. Work only from the source.'
}
const WHAT_CHANGED_SKILL: TurnSkill = {
  installId: 'app:what-changed',
  title: 'What Changed?',
  body: 'Compare the two versions and report the material changes that matter, in business language: fees/payment, term/renewal, liability, confidentiality, governing law. For each change give old vs new. Work only from the source.'
}
const SUMMARY_SKILL: TurnSkill = {
  installId: 'app:meeting-protocol',
  title: 'Key Points',
  body: 'Summarize the document’s key points as concise bullets. Keep names, numbers, and dates exact.'
}

// --- Harness ---------------------------------------------------------------------------------

let runtime: ModelRuntime
let manager: RuntimeManager
const embedder = createMockEmbedder()

interface Ws {
  db: Db
  root: string
  workspacePath: string
}
function freshWorkspace(): Ws {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-realmodel-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return { db, root, workspacePath }
}
async function ingest(ws: Ws, name: string, text: string): Promise<string> {
  const p = join(ws.root, name)
  writeFileSync(p, text, 'utf8')
  const doc = createQueuedDocument(ws.db, p)
  await processDocument(ws.db, documentsDir(ws.workspacePath), doc.id, { embedder })
  return doc.id
}

/** Wave 2 whole-document minutes for one transcript/question; shared asserts here, tail asserts by caller. */
async function runMinutes(label: string, transcript: string, question: string): Promise<string> {
  const ws = freshWorkspace()
  const docId = await ingest(ws, 'transcript.txt', transcript)
  const conv = createConversation(ws.db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  appendMessage(ws.db, { conversationId: conv.id, role: 'user', content: question })
  const settings = ragSettingsFrom(getSettings(ws.db))
  const msg = await generateGroundedAnswer(ws.db, runtime, embedder, conv.id, question, settings, {
    skill: MEETING_SKILL,
    wholeDocument: { documentId: docId }
  })
  // eslint-disable-next-line no-console
  console.log(`\n===== ${label} =====\n${msg.content}\n`)
  expect(msg.coverage?.mode).toBe('capped')
  expect(msg.coverage?.truncated).toBe(false)
  expect(msg.content.length).toBeGreaterThan(80)
  return msg.content.toLowerCase()
}

/** Follow-up B 2-document compare; returns the lowercased content + the citation count. */
async function runCompare(
  label: string,
  v1: string,
  v2: string,
  question: string
): Promise<{ lc: string; citations: number }> {
  const ws = freshWorkspace()
  const a = await ingest(ws, 'v1.txt', v1)
  const b = await ingest(ws, 'v2.txt', v2)
  const conv = createConversation(ws.db, { mode: 'documents', scope: { collectionIds: [], documentIds: [a, b] } })
  appendMessage(ws.db, { conversationId: conv.id, role: 'user', content: question })
  const settings = ragSettingsFrom(getSettings(ws.db))
  const msg = await generateGroundedAnswer(ws.db, runtime, embedder, conv.id, question, settings, {
    skill: WHAT_CHANGED_SKILL,
    wholeDocumentCompare: { documentIds: [a, b] }
  })
  // eslint-disable-next-line no-console
  console.log(`\n===== ${label} =====\n${msg.content}\n`)
  expect(msg.coverage?.mode).toBe('capped')
  return { lc: msg.content.toLowerCase(), citations: (msg.citations ?? []).length }
}

/** Follow-up A tree map-reduce over a hand-seeded single-level ready tree (real model does the reduce). */
async function runTree(label: string, doc: string, rootSummary: string, question: string): Promise<string> {
  const ws = freshWorkspace()
  const docId = await ingest(ws, 'doc.txt', doc)
  const chunkIds = (
    ws.db.prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index').all(docId) as Array<{
      id: string
    }>
  ).map((r) => r.id)
  const rootId = randomUUID()
  ws.db
    .prepare(
      `INSERT INTO tree_nodes
         (id, document_id, scope_key, level, ordinal, parent_id, is_root, summary_text,
          embedding_blob, dimensions, embedding_model_id, content_hash, model_id, created_at)
       VALUES (?, ?, NULL, 1, 0, NULL, 1, ?, NULL, NULL, NULL, ?, 'qwen3.5-4b', ?)`
    )
    .run(rootId, docId, rootSummary, `hash-${rootId}`, new Date().toISOString())
  chunkIds.forEach((cid, i) => {
    ws.db
      .prepare('INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, 1, ?)')
      .run(rootId, cid, i)
  })
  ws.db.prepare('UPDATE documents SET tree_status = ? WHERE id = ?').run('ready', docId)
  const conv = createConversation(ws.db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  const msg = await answerWholeDocFromTree({
    db: ws.db,
    runtime,
    conversationId: conv.id,
    documentId: docId,
    question,
    skill: SUMMARY_SKILL,
    contextTokens: CONTEXT_TOKENS
  })
  // eslint-disable-next-line no-console
  console.log(`\n===== ${label} =====\n${msg?.content ?? '<null>'}\n`)
  expect(msg).not.toBeNull()
  expect(msg!.coverage?.mode).toBe('tree')
  expect(msg!.coverage?.treeStatus).toBe('ready')
  expect((msg!.content ?? '').length).toBeGreaterThan(40)
  return (msg!.content ?? '').toLowerCase()
}

beforeAll(async () => {
  if (!RUN) return
  expect(existsSync(MODEL_PATH), `model weights at ${MODEL_PATH}`).toBe(true)
  expect(existsSync(LLAMA_BIN), `llama-server at ${LLAMA_BIN}`).toBe(true)
  process.env.HILBERTRAUM_LLAMA_BIN = LLAMA_BIN
  // Force CPU (rung 2, --device none): robust + deterministic for a harness (no GPU crash-fallback
  // wiring here). Slower than GPU but fine for a handful of prompts.
  const factory = createSelectingRuntimeFactory({ rootPath: 'D:/', isDev: true, gpu: { getGpuMode: () => 'off' } })
  manager = new RuntimeManager(factory)
  await manager.start({ modelId: 'qwen3.5-4b', modelPath: MODEL_PATH, contextTokens: CONTEXT_TOKENS })
  const active = manager.active()
  expect(active, 'a runtime is active').not.toBeNull()
  runtime = active as ModelRuntime
  expect(runtime.backend, 'real (non-mock) backend').not.toBe('mock')
  // eslint-disable-next-line no-console
  console.log(`\n[real-model] backend=${runtime.backend} ctx=${runtime.contextWindow?.()}\n`)
}, 180_000)

afterAll(async () => {
  await manager?.stop().catch(() => {})
})

describe.runIf(RUN)('Wave 3 real model — English', () => {
  it('Wave 2 minutes: capped coverage + END-of-transcript items', async () => {
    const lc = await runMinutes('EN MINUTES', MEETING_TRANSCRIPT_EN, 'Write the meeting minutes.')
    expect(lc.includes('prometheus') || lc.includes('q3')).toBe(true)
    expect(lc.includes('friday') || lc.includes('dana')).toBe(true)
  }, 300_000)

  it('Follow-up B compare: LATE changes (Frankfurt) present', async () => {
    const { lc, citations } = await runCompare(
      'EN COMPARE',
      CONTRACT_V1_EN,
      CONTRACT_V2_EN,
      'What changed between these two versions?'
    )
    expect(citations).toBeGreaterThanOrEqual(2)
    expect(lc).toContain('frankfurt')
  }, 300_000)

  it('Follow-up A tree reduce: tree coverage + non-empty answer', async () => {
    await runTree(
      'EN TREE',
      MEETING_TRANSCRIPT_EN,
      'The team blocked 2.4 on the empty-workspace crash, deferred slow-search to 2.5, will auto-import deletable sample docs, and parked Prometheus until Q3. Actions: Tobias crash fix (end of week), Priya mockup (Thursday), Dana ticket counts (Friday).',
      'Summarize the key points of this document.'
    )
  }, 300_000)
})

describe.runIf(RUN)('Wave 3 real model — German', () => {
  it('Wave 2 minutes (DE): capped coverage + END-of-transcript items, answered in German', async () => {
    const lc = await runMinutes('DE MINUTES', MEETING_TRANSCRIPT_DE, 'Erstelle ein Besprechungsprotokoll.')
    // Tail of the transcript: decision 4 (Prometheus→Q3) + the last action (Dana→Freitag).
    expect(lc.includes('prometheus') || lc.includes('q3')).toBe(true)
    expect(lc.includes('freitag') || lc.includes('dana')).toBe(true)
    // Sanity that it answered in German (a common German word the format yields).
    expect(lc.includes('entscheidung') || lc.includes('aufgabe') || lc.includes('zusammenfassung')).toBe(true)
  }, 300_000)

  it('Follow-up B compare (DE): LATE changes (Frankfurt) present, answered in German', async () => {
    const { lc, citations } = await runCompare(
      'DE COMPARE',
      CONTRACT_V1_DE,
      CONTRACT_V2_DE,
      'Was hat sich zwischen diesen beiden Versionen geändert?'
    )
    expect(citations).toBeGreaterThanOrEqual(2)
    expect(lc).toContain('frankfurt')
    // A late confidentiality change to five years is German-language evidence of full coverage.
    expect(lc.includes('fünf') || lc.includes('5 jahre') || lc.includes('haftung')).toBe(true)
  }, 300_000)

  it('Follow-up A tree reduce (DE): tree coverage + non-empty German answer', async () => {
    await runTree(
      'DE TREE',
      MEETING_TRANSCRIPT_DE,
      'Das Team blockierte 2.4 wegen des Absturzes bei leerem Arbeitsbereich, verschob die langsame Suche auf 2.5, importiert künftig löschbare Beispieldokumente und parkte Prometheus bis Q3. Aktionen: Tobias Crash-Fix (Ende der Woche), Priya Mockup (Donnerstag), Dana Ticket-Zahlen (Freitag).',
      'Fasse die wichtigsten Punkte dieses Dokuments zusammen.'
    )
  }, 300_000)
})
