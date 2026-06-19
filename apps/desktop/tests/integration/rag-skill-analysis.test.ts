import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Full-doc-skills Phase 3 (§3.2) — the CHAT wiring: `askDocuments` routes a `kind:tool` skill's
// analysis-shaped question to its registered whole-document handler (exhaustive answer + honest
// `extract` coverage, NO model call), REFUSES a not-fully-chunked doc (fixed localized message + the
// Re-index affordance, no partial answer, no model call), and leaves the relevance path BYTE-UNCHANGED
// for an off-topic question (no handler fire). Drives the real IPC handler with a faked transport.

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

import { IPC, STREAM } from '../../src/shared/ipc'
import type { Message } from '../../src/shared/types'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { createSkillRegistry } from '../../src/main/services/skills/registry'
import { createConversation, listMessages } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerBuiltinSkillAnalysisHandlers, clearSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { AppContext } from '../../src/main/services/context'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'
import { t } from '../../src/shared/i18n'
import { invoke, invokeWithEvent, makeEvent, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const BANK_INSTALL_ID = 'app:bank-statement'

// A clean 2-row statement: Grocery −45,90 (out), Salary +2.500,00 (in); the running balances reconcile.
const CLEAN = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'

function writeBankSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'bank-statement')
  mkdirSync(d, { recursive: true })
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

interface Harness {
  db: Db
  conversationId: string
  docId: string
  runtime: ModelRuntime & { calls: number }
  audit: { type: string; meta?: Record<string, unknown> }[]
}

/** Real DB + an ingested single bank statement + an ENABLED app:bank-statement tool skill + the
 *  analysis registry, wired through the real `askDocuments` handler. `fullyChunked: false` clears the
 *  ingestion-set marker to simulate a legacy (not exhaustively analysable) index. */
async function makeHarness(opts: { fullyChunked?: boolean; text?: string } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-ragskill-'))
  const workspacePath = join(root, 'workspace')
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeBankSkill(appSkillsDir)

  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir, appVersion: '0.0.0-test' })
  skills.reconcile() // installs app:bank-statement ENABLED

  // A REAL ingested statement: stored copy + chunks + embeddings + fully_chunked (the production path).
  const storeDir = documentsDir(workspacePath)
  const docPath = join(root, 'statement.txt')
  writeFileSync(docPath, opts.text ?? CLEAN, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })
  if (opts.fullyChunked === false) {
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(doc.id)
  }

  // A runtime that records whether it was ever asked to generate — both Phase-3 outcomes must make
  // ZERO model calls (grounding rule: deterministic copy / fixed refusal, never the model).
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

describe('askDocuments — tool-skill analysis routing (full-doc-skills Phase 3)', () => {
  it('exhaustive path: a fully-chunked statement gets the deterministic whole-document answer', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize the transactions',
      BANK_INSTALL_ID
    )
    const msg = result as Message

    // The deterministic figures — count + in/out/net — computed from the extracted rows (NO model).
    expect(msg.content).toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
    expect(msg.content).toContain('2500.00')
    expect(msg.content).toContain('2454.10')
    expect(h.runtime.calls).toBe(0)

    // Honest extract coverage, fully chunked → the meter may say "whole document" (D48).
    expect(msg.coverage?.mode).toBe('extract')
    expect(msg.coverage?.fullyChunked).toBe(true)
    // Real source citations behind the figures (M2).
    expect(msg.citations && msg.citations.length).toBeGreaterThan(0)
    // The re-routed turn carries the skill glyph + provenance (A1): explicit pick ⇒ autoFired false.
    expect(msg.skillId).toBe(BANK_INSTALL_ID)
    expect(msg.autoFired).toBe(false)
  })

  it('refuse path: a not-fully-chunked statement is refused — fixed message, no model, no partial answer', async () => {
    const h = await makeHarness({ fullyChunked: false })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what is the total spending?',
      BANK_INSTALL_ID
    )
    const msg = result as Message

    // The localized refuse notice, surfacing the existing Re-index affordance — NOT a partial answer.
    expect(msg.content).toBe(t('en', 'skills.analysis.refusePartial'))
    expect(msg.content).not.toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
    expect(h.runtime.calls).toBe(0)
    // Honest: a refusal makes NO breadth claim (NULL coverage → renderer relevance fallback).
    expect(msg.coverage).toBeUndefined()
    // The turn still carries the skill (A1) so the user sees which skill declined.
    expect(msg.skillId).toBe(BANK_INSTALL_ID)
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
      BANK_INSTALL_ID
    )
    const msg = result as Message

    // The analysis handler did NOT fire: no extract coverage, no bank figures — the normal path ran.
    expect(msg.coverage).toBeUndefined()
    expect(msg.content).not.toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
    // And no whole-document tool was auto-run.
    const runs = h.db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(0)
  })

  it('export is never auto-run on the exhaustive path (export stays confirm-gated)', async () => {
    const h = await makeHarness({ fullyChunked: true })
    await invoke(handlers, IPC.askDocuments, h.conversationId, 'summarize and reconcile', BANK_INSTALL_ID)

    const toolNames = h.audit.map((e) => e.meta?.toolName)
    expect(toolNames).toContain('extract_transactions')
    expect(toolNames).toContain('summarize_cashflow')
    expect(toolNames).toContain('validate_statement_balances')
    expect(toolNames).not.toContain('export_transactions_csv')
  })

  it('preserves the single-locked-slot streaming contract (token + done emitted, registry cleared)', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const event = makeEvent()
    const msg = (await invokeWithEvent(
      handlers,
      IPC.askDocuments,
      event,
      h.conversationId,
      'summarize the transactions',
      BANK_INSTALL_ID
    )) as Message

    // The answer streamed over the locked channel (one token) and finished with `chat:done`.
    const channels = event.sender.send.mock.calls.map((c) => c[0])
    expect(channels).toContain(STREAM.token(h.conversationId))
    expect(channels).toContain(STREAM.done(h.conversationId))
    // The in-flight entry is released in `finally` — no stuck slot after the turn.
    expect(inFlightStreams.has(h.conversationId)).toBe(false)
    // Exactly one user turn + one assistant turn persisted (no duplicate / partial rows).
    const msgs = listMessages(h.db, h.conversationId)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].id).toBe(msg.id)
  })
})
