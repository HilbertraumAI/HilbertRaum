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
// The printed opening/closing balances (2000.00 + Σ 2454.10 == 4454.10) PROVE completeness so the D56
// gate presents a total (without them the gate honestly downgrades — see skills-analysis-bank.test.ts).
const CLEAN =
  'Statement EUR\nOpening balance 2.000,00\n2026-01-02 Grocery -45,90 1.954,10\n' +
  '2026-01-03 Salary 2.500,00 4.454,10\nClosing balance 4.454,10'

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

// ---- W2: doc-count-fallthrough routing + plausibility gate (audit §2.1/§3.4/§4.5) ----
// A tool/whole-doc skill reads ONE document (two, for compare) at a time. Before W2 a multi-document
// scope silently fell through to top-k retrieval (a couple of passages dressed up as a whole-doc read),
// and a zero-row extraction on a NON-statement (a contract with the bank skill sticky) claimed "I read
// the whole statement but couldn't find any transactions". W2 kills both, deterministically (no model):
// narrow to the one matching statement (with an honest notice), route ("pick one" / "select two"), or —
// for a zero-row read on a doc that doesn't even look like a statement — fall through to the grounded path.

/** A bank skill WITH real manifest doc signals (the narrowing/gate consult filenamePatterns/mimeTypes). */
function writeBankSkillWithTriggers(appSkillsDir: string): void {
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
    'triggers:',
    '  keywords: [bank statement, kontoauszug, transaction, balance]',
    '  mimeTypes: [application/pdf, text/csv]',
    '  filenamePatterns: ["*statement*", "*kontoauszug*"]',
    '---',
    'Quote the printed figures.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

/** A what-changed compare skill (kind:instruction) — its handler needs EXACTLY two in-scope docs. */
function writeWhatChangedSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'what-changed')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: what-changed',
    'title: What Changed',
    'description: Compares two document versions.',
    'version: 1.0.0',
    'kind: instruction',
    'triggers:',
    '  keywords: [what changed, compare versions]',
    '  mimeTypes: [application/pdf, text/plain]',
    '  filenamePatterns: ["*draft*"]',
    '---',
    'Compare document A and document B.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

/** A contract-brief skill (kind:instruction, grounded-whole-doc) — narrows to the one matched contract
 *  and streams a MODEL answer over it (exercising the W2 `answerPrefix` scope-notice path). */
function writeContractBriefSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'contract-brief')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: contract-brief',
    'title: Contract Brief',
    'description: Briefs a contract.',
    'version: 1.0.0',
    'kind: instruction',
    'triggers:',
    '  keywords: [contract, agreement, summarize contract]',
    '  mimeTypes: [application/pdf, text/plain, text/markdown]',
    '  filenamePatterns: ["*contract*", "*agreement*", "*lease*"]',
    '---',
    'Produce a plain-language brief of the whole contract.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

interface MultiHarness {
  db: Db
  conversationId: string
  docIds: string[]
  runtime: ModelRuntime & { calls: number }
}

/** Ingest N real documents (each named `file`, so its title drives the filename-pattern match) into ONE
 *  conversation scope, with the trigger-bearing bank skill (+ optionally what-changed) enabled. */
async function makeMultiHarness(opts: {
  docs: { file: string; text: string; mime?: string }[]
  installWhatChanged?: boolean
  installContractBrief?: boolean
  /** Make the mock model yield NOTHING (a Stop-before-first-token / think-only turn) — for the W2
   *  "an empty model turn on a narrowed whole-doc persists nothing" regression. */
  emptyModel?: boolean
}): Promise<MultiHarness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-ragskill-w2-'))
  const workspacePath = join(root, 'workspace')
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeBankSkillWithTriggers(appSkillsDir)
  if (opts.installWhatChanged) writeWhatChangedSkill(appSkillsDir)
  if (opts.installContractBrief) writeContractBriefSkill(appSkillsDir)

  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir, appVersion: '0.0.0-test' })
  skills.reconcile()

  const storeDir = documentsDir(workspacePath)
  const embedder = createMockEmbedder()
  const docIds: string[] = []
  for (const { file, text, mime } of opts.docs) {
    const p = join(root, file)
    writeFileSync(p, text, 'utf8')
    const doc = createQueuedDocument(db, p)
    await processDocument(db, storeDir, doc.id, { embedder })
    // Override the ingestion-guessed MIME when a test needs a specific doc-signal shape (the narrowing +
    // plausibility gate consult mime_type). Post-ingestion: content is already parsed as text.
    if (mime) db.prepare('UPDATE documents SET mime_type = ? WHERE id = ?').run(mime, doc.id)
    docIds.push(doc.id)
  }

  const runtime = {
    modelId: 'mock',
    calls: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(_messages: ChatMessage[]) {
      runtime.calls++
      if (opts.emptyModel) return // an empty model turn — yields no tokens
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
    scope: { collectionIds: [], documentIds: docIds }
  })
  return { db, conversationId: conv.id, docIds, runtime }
}

describe('askDocuments — W2 doc-count-fallthrough routing + plausibility gate', () => {
  it('narrows a multi-doc scope to the one statement the skill matches, with an honest notice (0 model)', async () => {
    const h = await makeMultiHarness({
      docs: [
        { file: 'statement-jan.txt', text: CLEAN },
        { file: 'lease-agreement.txt', text: 'This service agreement is between the provider and the client.' },
        { file: 'notes.txt', text: 'Some meeting notes about nothing in particular.' }
      ]
    })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize my bank statement',
      BANK_INSTALL_ID
    )
    const msg = result as Message

    // The honest scope notice leads the answer (narrowed to the one matched statement, 2 others unread)…
    expect(msg.content).toContain(t('en', 'skills.analysis.scopeNarrowed', { title: 'statement-jan.txt', count: 2 }))
    // …and the deterministic bank answer over that one statement follows — with ZERO model calls.
    expect(msg.content).toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
    expect(msg.content).toContain('2500.00')
    expect(h.runtime.calls).toBe(0)
    expect(msg.coverage?.mode).toBe('extract')
    expect(msg.skillId).toBe(BANK_INSTALL_ID)
  })

  it('routes ("pick one") when several in-scope docs match the skill — no silent fall-through (0 model)', async () => {
    const h = await makeMultiHarness({
      docs: [
        { file: 'statement-jan.txt', text: CLEAN },
        { file: 'statement-feb.txt', text: CLEAN },
        { file: 'notes.txt', text: 'Some meeting notes.' }
      ]
    })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize the transactions',
      BANK_INSTALL_ID
    )
    const msg = result as Message

    // Two candidate statements → no single best match → the deterministic "select one document" routing
    // answer (naming the in-scope count), not a degraded top-k answer and not a narrowed guess.
    expect(msg.content).toBe(t('en', 'skills.analysis.selectOne', { count: 3 }))
    expect(h.runtime.calls).toBe(0)
    expect(msg.coverage).toBeUndefined()
    expect(msg.skillId).toBe(BANK_INSTALL_ID)
  })

  it('plausibility gate: a zero-row read on a NON-statement falls through to the grounded path (LLM answers)', async () => {
    const h = await makeMultiHarness({
      docs: [
        {
          file: 'lease-agreement.txt',
          text:
            'This service agreement is entered into between the provider and the client. ' +
            'The provider shall deliver the described services in good faith. ' +
            'Either party may terminate this agreement with thirty days written notice.'
        }
      ]
    })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize this agreement',
      BANK_INSTALL_ID
    )
    const msg = result as Message

    // NOT the misleading "I read the whole statement but couldn't find any transactions" template…
    expect(msg.content).not.toBe(t('en', 'skills.bankAnalysis.empty'))
    expect(msg.content).not.toContain(t('en', 'skills.bankAnalysis.count', { count: 0 }))
    // …instead the ordinary grounded path answered the actual question (the model WAS consulted).
    expect(msg.content).toContain('Model answer.')
    expect(h.runtime.calls).toBe(1)
    // Grounded relevance path ⇒ no `extract` breadth claim.
    expect(msg.coverage?.mode).not.toBe('extract')
  })

  it('narrows for a grounded-whole-doc skill too: streams the model answer over the one matched contract, notice prepended', async () => {
    // A grounded-whole-doc skill (contract-brief) over a 3-doc scope. The two non-contract docs carry a
    // MIME outside contract-brief's set, so only the contract matches → narrow to it, then the MODEL
    // answers over the whole document with the honest scope notice LED (W2 `answerPrefix` path).
    const h = await makeMultiHarness({
      docs: [
        { file: 'contract.txt', text: 'This lease agreement is between the landlord and the tenant for the flat.' },
        { file: 'a.txt', text: 'a,b\n1,2', mime: 'text/csv' },
        { file: 'b.txt', text: 'c,d\n3,4', mime: 'text/csv' }
      ],
      installContractBrief: true
    })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize this contract',
      'app:contract-brief'
    )
    const msg = result as Message

    // The notice leads, then the streamed model answer over the whole contract (both persisted).
    expect(msg.content).toContain(t('en', 'skills.analysis.scopeNarrowed', { title: 'contract.txt', count: 2 }))
    expect(msg.content).toContain('Model answer.')
    expect(h.runtime.calls).toBe(1)
    // grounded-whole-doc ⇒ `capped` breadth (covers the whole document), stamped with the skill.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.skillId).toBe('app:contract-brief')
  })

  it('does NOT narrow to a legacy/partly-chunked sole match — routes instead (no notice-dropped refusal)', async () => {
    // Review finding: narrowing to a matched-but-not-fully-chunked doc would hit the refusePartial branch
    // and silently drop the scope notice, implying a single-doc scope the user never chose. Guard: only
    // narrow to a doc we can actually answer (fully chunked); otherwise route honestly ("pick one").
    const h = await makeMultiHarness({
      docs: [
        { file: 'statement-jan.txt', text: CLEAN },
        { file: 'contract.txt', text: 'a service agreement' },
        { file: 'notes.txt', text: 'some notes' }
      ]
    })
    // The sole signal-match is legacy/partly-chunked → not exhaustively answerable.
    h.db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(h.docIds[0])
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize my bank statement',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).toBe(t('en', 'skills.analysis.selectOne', { count: 3 }))
    expect(msg.content).not.toBe(t('en', 'skills.analysis.refusePartial'))
    expect(h.runtime.calls).toBe(0)
  })

  it('an empty model turn on a narrowed whole-doc persists NOTHING (no notice-only coverage-stamped message)', async () => {
    // Review finding: the `answerPrefix` seed defeated the `content === ''` empty guard, so a Stop-before-
    // first-token / think-only turn would persist a message carrying ONLY the scope notice, stamped with
    // `capped` coverage. Guard: prefix-only content persists nothing (as before the diff).
    const h = await makeMultiHarness({
      docs: [
        { file: 'contract.txt', text: 'This lease agreement is between the landlord and the tenant.' },
        { file: 'a.txt', text: 'a,b\n1,2', mime: 'text/csv' },
        { file: 'b.txt', text: 'c,d\n3,4', mime: 'text/csv' }
      ],
      installContractBrief: true,
      emptyModel: true
    })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize this contract',
      'app:contract-brief'
    )
    const msg = result as Message
    expect(msg.content).toBe('')
    expect(msg.coverage).toBeUndefined()
    // The user turn persisted; NO assistant row was written (a notice-only stamped message never lands).
    const assistantRows = listMessages(h.db, h.conversationId).filter((m) => m.role === 'assistant')
    expect(assistantRows).toHaveLength(0)
  })

  it('what-changed at ≠ 2 docs answers "select exactly two" deterministically (1 doc and 3 docs)', async () => {
    const one = await makeMultiHarness({
      docs: [{ file: 'draft-v1.txt', text: 'first version text' }],
      installWhatChanged: true
    })
    const r1 = (await invoke(handlers, IPC.askDocuments, one.conversationId, 'what changed?', 'app:what-changed'))
      .result as Message
    expect(r1.content).toBe(t('en', 'skills.analysis.selectTwo', { count: 1 }))
    expect(one.runtime.calls).toBe(0)

    const three = await makeMultiHarness({
      docs: [
        { file: 'draft-v1.txt', text: 'first version text' },
        { file: 'draft-v2.txt', text: 'second version text' },
        { file: 'draft-v3.txt', text: 'third version text' }
      ],
      installWhatChanged: true
    })
    const r3 = (await invoke(handlers, IPC.askDocuments, three.conversationId, 'what changed?', 'app:what-changed'))
      .result as Message
    expect(r3.content).toBe(t('en', 'skills.analysis.selectTwo', { count: 3 }))
    expect(three.runtime.calls).toBe(0)
  })

  it('single-statement happy path is byte-unchanged — no W2 notice/routing leaks in', async () => {
    const h = await makeMultiHarness({ docs: [{ file: 'statement.txt', text: CLEAN }] })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize the transactions',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
    // None of the three W2 messages leak into the ordinary single-doc answer (all end with "ask again").
    expect(msg.content).not.toContain('ask again')
    expect(h.runtime.calls).toBe(0)
    expect(msg.coverage?.mode).toBe('extract')
  })
})
