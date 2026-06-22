import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// REAL-MODEL harness (Wave 3) — drives the ACTUAL whole-doc / compare / tree code paths with a real
// local llama.cpp model from the portable drive, no GUI and no workspace access. It is the autonomous
// stand-in for the manual GUI smoke test: the vitest suite already proves the LOGIC against the mock
// runtime; this proves real-model OUTPUT QUALITY (the 8-section minutes, the tail changes in a compare,
// the tree reduce). The whole-doc/compare/tree paths read chunks IN ORDER (not by embedding), so a mock
// embedder is enough for ingestion — only the CHAT model is real.
//
// GATED: it spawns a multi-GB model (RAM + minutes), so it NEVER runs in the normal suite. Run it with:
//   HILBERTRAUM_REAL_MODEL=1 npx vitest run tests/real-model/wave3.realmodel.test.ts
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

const MEETING_TRANSCRIPT = [
  'Weekly Product Sync — raw transcript. Present: Mara (PM), Tobias (Eng), Priya (Design), Dana (Support).',
  '[00:01] Tobias: 2.4 is feature-complete. Two open tickets: a slow-search regression and a crash on empty workspace.',
  '[00:03] Mara: We do NOT ship 2.4 until the empty-workspace crash is fixed. Slow-search slips to 2.5.',
  '[00:08] Priya: Onboarding redesign — open question is whether to auto-import sample docs on first launch.',
  '[00:12] Dana: Support backlog is 140 tickets, up from 90, mostly slow-search and license-activation confusion.',
  '[00:16] Tobias: We should decide on the Prometheus metrics integration. Mara: Let’s park it — not this quarter, revisit in Q3 planning.',
  '[00:18] Mara: Reading back the decisions: (1) 2.4 blocked on the empty-workspace crash; (2) slow-search deferred to 2.5; (3) proceed with auto-importing deletable sample docs, pending Priya’s mockup; (4) Prometheus integration parked until Q3 planning.',
  '[00:19] Mara: Action items: Tobias owns the crash fix by end of week; Priya delivers the sample-docs mockup by Thursday; Dana sends me the updated ticket counts on Friday.'
].join('\n\n')

const CONTRACT_V1 = [
  'SOFTWARE MAINTENANCE AGREEMENT — Version 1 (2025).',
  '5. FEES. 5.2 Invoices are due within thirty (30) days of the invoice date.',
  '6. TERM. 6.1 Initial term of twelve (12) months. 6.2 Auto-renews unless either party gives ninety (90) days written notice of non-renewal.',
  '8. LIABILITY. 8.1 Each party’s total aggregate liability shall not exceed the total fees paid by Customer in the twelve (12) months preceding the claim.',
  '9. CONFIDENTIALITY. 9.2 This obligation survives termination for a period of three (3) years.',
  '10. GOVERNING LAW. 10.2 The exclusive place of jurisdiction for all disputes is Berlin.'
].join('\n\n')

const CONTRACT_V2 = [
  'SOFTWARE MAINTENANCE AGREEMENT — Version 2 (2026).',
  '5. FEES. 5.2 Invoices are due within fourteen (14) days of the invoice date.',
  '6. TERM. 6.1 Initial term of twenty-four (24) months. 6.2 Auto-renews unless either party gives sixty (60) days written notice of non-renewal.',
  '8. LIABILITY. 8.1 Each party’s total aggregate liability shall not exceed the total fees paid by Customer in the six (6) months preceding the claim.',
  '9. CONFIDENTIALITY. 9.2 This obligation survives termination for a period of five (5) years.',
  '10. GOVERNING LAW. 10.2 The exclusive place of jurisdiction for all disputes is Frankfurt am Main.'
].join('\n\n')

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

describe.runIf(RUN)('Wave 3 — real local model (qwen3.5-4b)', () => {
  beforeAll(async () => {
    expect(existsSync(MODEL_PATH), `model weights at ${MODEL_PATH}`).toBe(true)
    expect(existsSync(LLAMA_BIN), `llama-server at ${LLAMA_BIN}`).toBe(true)
    process.env.HILBERTRAUM_LLAMA_BIN = LLAMA_BIN
    // Force CPU (rung 2, --device none): robust + deterministic for a harness (no GPU crash-fallback
    // wiring here). Slower than GPU but fine for a handful of prompts.
    const factory = createSelectingRuntimeFactory({
      rootPath: 'D:/',
      isDev: true,
      gpu: { getGpuMode: () => 'off' }
    })
    manager = new RuntimeManager(factory)
    await manager.start({ modelId: 'qwen3.5-4b', modelPath: MODEL_PATH, contextTokens: CONTEXT_TOKENS })
    const active = manager.active()
    expect(active, 'a runtime is active').not.toBeNull()
    runtime = active as ModelRuntime
    // Guard against a silent mock fallback (missing bin/model) defeating the whole point.
    expect(runtime.backend, 'real (non-mock) backend').not.toBe('mock')
    // eslint-disable-next-line no-console
    console.log(`\n[real-model] backend=${runtime.backend} ctx=${runtime.contextWindow?.()}\n`)
  }, 180_000)

  afterAll(async () => {
    await manager?.stop().catch(() => {})
  })

  it(
    'Wave 2 — whole-document minutes: capped coverage, format applied, END-of-transcript items present',
    async () => {
      const ws = freshWorkspace()
      const docId = await ingest(ws, 'transcript.txt', MEETING_TRANSCRIPT)
      const conv = createConversation(ws.db, {
        mode: 'documents',
        scope: { collectionIds: [], documentIds: [docId] }
      })
      const q = 'Write the meeting minutes.'
      appendMessage(ws.db, { conversationId: conv.id, role: 'user', content: q })
      const settings = ragSettingsFrom(getSettings(ws.db))
      const msg = await generateGroundedAnswer(ws.db, runtime, embedder, conv.id, q, settings, {
        skill: MEETING_SKILL,
        wholeDocument: { documentId: docId }
      })
      // eslint-disable-next-line no-console
      console.log('\n===== WAVE 2 — MINUTES (real model) =====\n' + msg.content + '\n')
      expect(msg.coverage?.mode).toBe('capped')
      expect(msg.coverage?.truncated).toBe(false)
      expect(msg.content.length).toBeGreaterThan(80)
      // The tail of the transcript (decision 4 + the last action) must surface — the whole-doc win.
      const lc = msg.content.toLowerCase()
      expect(lc.includes('prometheus') || lc.includes('q3')).toBe(true)
      expect(lc.includes('friday') || lc.includes('freitag') || lc.includes('dana')).toBe(true)
    },
    300_000
  )

  it(
    'Follow-up B — 2-document compare: capped coverage + LATE changes (Frankfurt / 6 months / 5 years)',
    async () => {
      const ws = freshWorkspace()
      const v1 = await ingest(ws, 'v1.txt', CONTRACT_V1)
      const v2 = await ingest(ws, 'v2.txt', CONTRACT_V2)
      const conv = createConversation(ws.db, {
        mode: 'documents',
        scope: { collectionIds: [], documentIds: [v1, v2] }
      })
      const q = 'What changed between these two versions?'
      appendMessage(ws.db, { conversationId: conv.id, role: 'user', content: q })
      const settings = ragSettingsFrom(getSettings(ws.db))
      const msg = await generateGroundedAnswer(ws.db, runtime, embedder, conv.id, q, settings, {
        skill: WHAT_CHANGED_SKILL,
        wholeDocumentCompare: { documentIds: [v1, v2] }
      })
      // eslint-disable-next-line no-console
      console.log('\n===== FOLLOW-UP B — COMPARE (real model) =====\n' + msg.content + '\n')
      expect(msg.coverage?.mode).toBe('capped')
      expect((msg.citations ?? []).length).toBeGreaterThanOrEqual(2)
      const lc = msg.content.toLowerCase()
      // §10.2 jurisdiction is the LAST clause — its presence proves both whole versions were read,
      // not a top-k head. (Loose: a real 4B phrases freely, but the proper noun is robust.)
      expect(lc).toContain('frankfurt')
    },
    300_000
  )

  it(
    'Follow-up A — deep-index tree map-reduce: tree coverage + non-empty answer',
    async () => {
      const ws = freshWorkspace()
      const docId = await ingest(ws, 'doc.txt', MEETING_TRANSCRIPT)
      // Hand-seed a single-level ready tree (root summarises; its children are the leaf chunks), so the
      // real model only does the skill-fenced REDUCE — fast, no multi-minute tree build.
      const chunkIds = (
        ws.db
          .prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index')
          .all(docId) as Array<{ id: string }>
      ).map((r) => r.id)
      const rootId = randomUUID()
      ws.db
        .prepare(
          `INSERT INTO tree_nodes
             (id, document_id, scope_key, level, ordinal, parent_id, is_root, summary_text,
              embedding_blob, dimensions, embedding_model_id, content_hash, model_id, created_at)
           VALUES (?, ?, NULL, 1, 0, NULL, 1, ?, NULL, NULL, NULL, ?, 'qwen3.5-4b', ?)`
        )
        .run(
          rootId,
          docId,
          'The team blocked 2.4 on the empty-workspace crash, deferred slow-search to 2.5, will auto-import deletable sample docs, and parked Prometheus until Q3. Actions: Tobias crash fix (end of week), Priya mockup (Thursday), Dana ticket counts (Friday).',
          `hash-${rootId}`,
          new Date().toISOString()
        )
      chunkIds.forEach((cid, i) => {
        ws.db
          .prepare('INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, 1, ?)')
          .run(rootId, cid, i)
      })
      ws.db.prepare('UPDATE documents SET tree_status = ? WHERE id = ?').run('ready', docId)

      const conv = createConversation(ws.db, {
        mode: 'documents',
        scope: { collectionIds: [], documentIds: [docId] }
      })
      const msg = await answerWholeDocFromTree({
        db: ws.db,
        runtime,
        conversationId: conv.id,
        documentId: docId,
        question: 'Summarize the key points of this document.',
        skill: SUMMARY_SKILL,
        contextTokens: CONTEXT_TOKENS
      })
      // eslint-disable-next-line no-console
      console.log('\n===== FOLLOW-UP A — TREE REDUCE (real model) =====\n' + (msg?.content ?? '<null>') + '\n')
      expect(msg).not.toBeNull()
      expect(msg!.coverage?.mode).toBe('tree')
      expect(msg!.coverage?.treeStatus).toBe('ready')
      expect((msg!.content ?? '').length).toBeGreaterThan(40)
    },
    300_000
  )
})
