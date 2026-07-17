import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
import { createSkillRegistry, getSkill } from '../../src/main/services/skills/registry'
import { createConversation, listMessages } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerBuiltinSkillAnalysisHandlers, clearSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { SCAN_MARKER_TYPE } from '../../src/main/services/analysis/extract'
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

function writeBankSkill(appSkillsDir: string, opts: { triggers?: boolean } = {}): void {
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
    // A4 (SKA-7): the single-doc inversion consults the skill's manifest doc signals. With triggers the
    // `*statement*` filename pattern marks a `statement.txt` in scope as "plausibly a statement".
    ...(opts.triggers
      ? [
          'triggers:',
          '  keywords: [bank statement, kontoauszug, transaction, balance]',
          '  mimeTypes: [application/pdf, text/csv]',
          '  filenamePatterns: ["*statement*", "*kontoauszug*"]'
        ]
      : []),
    '---',
    'Quote the printed figures.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

// SEC-1 end-to-end (T2): a USER-imported `kind:'tool'` skill that DECLARES `analysis: whole-doc` plus the
// same Tier-2 tools the app bank skill runs. THREE layered gates must all hold at the chat surface: the
// manifest parser ignores `analysis` on a tool skill, `manifestAnalysisHandler` honors instruction skills
// only, and the app registry holds no handler under a `user:` install id — so askDocuments must take the
// plain relevance path (no analysis engine, no tool run) even with the skill force-enabled.
function writeUserToolSkill(userSkillsDir: string): void {
  const d = join(userSkillsDir, 'imported-bank')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: imported-bank',
    'title: Imported bank tool',
    'description: A user-imported tool skill.',
    'version: 1.0.0',
    'kind: tool',
    'analysis: whole-doc',
    'allowedTools: [extract_transactions, validate_statement_balances, summarize_cashflow]',
    'triggers:',
    '  keywords: [bank statement, kontoauszug, transaction, balance]',
    '  filenamePatterns: ["*statement*"]',
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

/** Real DB + an ingested single bank statement + an ENABLED app:bank-statement tool skill + the
 *  analysis registry, wired through the real `askDocuments` handler. `fullyChunked: false` clears the
 *  ingestion-set marker to simulate a legacy (not exhaustively analysable) index. */
async function makeHarness(
  opts: { fullyChunked?: boolean; text?: string; triggers?: boolean; docFile?: string; userToolSkill?: boolean } = {}
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-ragskill-'))
  const workspacePath = join(root, 'workspace')
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  if (opts.userToolSkill) writeUserToolSkill(userSkillsDir)
  else writeBankSkill(appSkillsDir, { triggers: opts.triggers })

  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir, appVersion: '0.0.0-test' })
  skills.reconcile() // installs app:bank-statement ENABLED
  // A drop-in user skill installs DISABLED (DS19); force-enable to model the SEC-1 worst case.
  if (opts.userToolSkill) db.prepare('UPDATE skills SET enabled = 1 WHERE install_id = ?').run('user:imported-bank')

  // A REAL ingested statement: stored copy + chunks + embeddings + fully_chunked (the production path).
  // The filename drives the A4 signal match (`*statement*`) — a test can override it to a non-matching name.
  const storeDir = documentsDir(workspacePath)
  const docPath = join(root, opts.docFile ?? 'statement.txt')
  writeFileSync(docPath, opts.text ?? CLEAN, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })
  if (opts.fullyChunked === false) {
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(doc.id)
  }

  // A runtime that records whether it was ever asked to generate (the Phase-3 template/refuse outcomes must
  // make ZERO model calls) AND captures the messages it was handed, so a W4 grounded-data turn can assert
  // the model saw the JSON data block + the verbatim rules.
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

    // The analysis handler did NOT fire: the relevance path ran (D72 stamps `relevance` coverage —
    // NOT the extract/whole-document breadth an analysis handler would stamp), and no bank figures.
    expect(msg.coverage?.mode).toBe('relevance')
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

// ---- W4: bank grounded-data (third mode) + inline format parity (audit §3.1/§3.3/§8.1) ----
// The bank port of W3: a non-summary bank question streams a MODEL answer over the deterministically
// extracted + validated statement (with the parsed in/out/net echoed beneath it), and a format ask
// serializes the statement inline (JSON/CSV) with 0 model calls — parity with the invoice handler.

describe('askDocuments — bank grounded-data + inline format (W4)', () => {
  it('grounded-data: a non-summary question streams a model answer over the JSON + deterministic postscript', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what was my largest transaction?',
      BANK_INSTALL_ID
    )
    const msg = result as Message

    // The model WAS called (the point of the third mode), and its answer is persisted.
    expect(h.runtime.calls).toBe(1)
    expect(msg.content).toContain('Model answer.')

    // The prompt the model saw carried the serialized JSON data block + the strict verbatim rule.
    const lastTurn = h.runtime.lastMessages[h.runtime.lastMessages.length - 1]
    expect(lastTurn.role).toBe('user')
    expect(lastTurn.content).toContain('Bank statement (JSON):')
    expect(lastTurn.content).toContain('quote them EXACTLY')
    expect(lastTurn.content).toContain('Do NOT do arithmetic')
    // The grounded-data SYSTEM prompt drops the "[S1]" excerpt-citation rule (no numbered excerpts here).
    expect(h.runtime.lastMessages[0].role).toBe('system')
    expect(h.runtime.lastMessages[0].content).toContain('Do NOT add inline [S1]')

    // The deterministic in/out/net echo (postscript) is appended verbatim UNDER the model answer, and it
    // matches the PARSED net (2454.10) exactly — a model misquote is immediately contradicted.
    expect(msg.content).toContain('2454.10')
    expect(msg.content.indexOf('Model answer.')).toBeLessThan(msg.content.indexOf('2454.10'))

    // Honest extract coverage + citations pass straight through; the fence rode the turn so the row is stamped.
    expect(msg.coverage?.mode).toBe('extract')
    expect(msg.citations && msg.citations.length).toBeGreaterThan(0)
    expect(msg.skillId).toBe(BANK_INSTALL_ID)

    // The read-only tools still auto-ran (they feed the data block); export never did.
    const toolNames = h.audit.map((e) => e.meta?.toolName)
    expect(toolNames).toContain('extract_transactions')
    expect(toolNames).toContain('validate_statement_balances')
    expect(toolNames).not.toContain('export_transactions_csv')
  })

  it('follow-up regression: an explanatory "warum stimmen die Summen nicht?" is a DIFFERENT (model) answer, not the byte-identical template', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'warum stimmen die Summen nicht?',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(h.runtime.calls).toBe(1)
    expect(msg.content).toContain('Model answer.')
    // NOT the deterministic template's headline count line.
    expect(msg.content).not.toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
  })

  it('format path: "as JSON" serializes the statement inline (no model)', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'give me the statement as JSON',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(h.runtime.calls).toBe(0)
    expect(msg.content).toContain('```json')
    expect(msg.content).toContain('"totalIn": 2500')
  })
})

// ---- A4: tool-skill single-doc gate inversion (SKA-7 structural, audit §3.2/§8.2) ----
// With the bank skill ACTIVE over a single fully-chunked statement that plausibly IS a statement (manifest
// doc signals OR a prior extraction), a NON-vocabulary on-topic question is answered from the VERIFIED
// extract (grounded-data), NOT raw top-k + model arithmetic (the pre-W3 incident class). A doc matching NO
// signal keeps the phrasing gate (relevance); small talk opts out (no extraction).

describe('askDocuments — A4 tool-skill inversion (SKA-7 structural)', () => {
  const bankRows = (h: Harness): number =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM bank_statements').get() as { n: number }).n

  it('signal-matching statement + NON-vocabulary question → grounded-data over the extract (never top-k)', async () => {
    // "An wen ging das meiste Geld?" misses the ~45-term bank vocabulary, so pre-A4 it fell to top-k.
    const h = await makeHarness({ fullyChunked: true, triggers: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'An wen ging das meiste Geld?',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    // The handler ran (extraction persisted) and the answer streamed grounded-data over the JSON block.
    expect(bankRows(h)).toBe(1)
    expect(h.runtime.calls).toBe(1)
    const lastTurn = h.runtime.lastMessages[h.runtime.lastMessages.length - 1]
    expect(lastTurn.content).toContain('Bank statement (JSON):')
    expect(lastTurn.content).toContain('quote them EXACTLY')
    // Honest extract coverage + the deterministic net echo (never a top-k relevance badge).
    expect(msg.coverage?.mode).toBe('extract')
    expect(msg.content).toContain('2454.10')
    // Provenance flows through the inverted gate: the grounded-data dispatch stamps skillId + auto_fired
    // exactly as the applies()-path does (false here — an explicit pick). For a TOOL skill an auto-fire
    // keyword is always a route-term (so applies() is already true), so auto-fire never NEEDS the inversion;
    // the stamp rides the identical dispatch regardless — this pins that it isn't dropped.
    expect(msg.skillId).toBe(BANK_INSTALL_ID)
    expect(msg.autoFired).toBe(false)
  })

  it('NO signal + no prior extraction → relevance path, extraction NOT run', async () => {
    // Same non-vocabulary question, but the doc matches no manifest signal (no triggers, non-statement
    // filename) and has never been extracted → the phrasing gate stands (the W2 plausibility posture,
    // inverted): the ordinary relevance path answers, and the bank extractor is never force-run.
    const h = await makeHarness({ fullyChunked: true, triggers: false, docFile: 'letter.txt' })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'An wen ging das meiste Geld?',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(bankRows(h)).toBe(0) // extraction NOT run
    expect(msg.coverage?.mode).not.toBe('extract') // relevance path, not the exhaustive handler
    expect(msg.content).not.toContain('Bank statement (JSON):')
  })

  it('inversion requires FULLY-CHUNKED: a phrasing-miss over a signal-matching but NOT-fully-chunked doc falls through to relevance (never a refusal)', async () => {
    // The `allInScopeDocsFullyChunked` conjunct of the inversion gate: a legacy/partly-chunked statement
    // can't be analysed exhaustively, so a vocabulary MISS must keep its pre-A4 relevance behaviour — it
    // must NOT invert-then-refuse. (Drop that conjunct and this turn would hit the else-branch D45 refusal.)
    const h = await makeHarness({ fullyChunked: false, triggers: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'An wen ging das meiste Geld?',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).not.toBe(t('en', 'skills.analysis.refusePartial'))
    expect(msg.coverage?.mode).not.toBe('extract') // relevance, not the exhaustive handler
    expect(bankRows(h)).toBe(0) // extraction NOT run
    expect(h.runtime.calls).toBe(1) // the relevance model call
  })

  it('small talk ("danke") over an active tool skill → relevance path, no extraction, no narration', async () => {
    const h = await makeHarness({ fullyChunked: true, triggers: true })
    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, 'danke', BANK_INSTALL_ID)
    const msg = result as Message
    // The inversion's `!isSmallTalk` guard holds: a pleasantry over a signal-matching statement does NOT
    // extract-and-narrate — it keeps the relevance path.
    expect(bankRows(h)).toBe(0)
    expect(msg.coverage?.mode).not.toBe('extract')
  })

  it('zero-row extraction on a signal-matching doc keeps the honest empty template (unchanged posture)', async () => {
    // A doc that LOOKS like a statement (name + triggers) but carries no parseable transactions: the
    // inversion runs the handler, the extractor finds nothing, and — because the doc DOES match a signal —
    // the honest empty template stands (it does NOT fall through to relevance). 0 model calls.
    const h = await makeHarness({
      fullyChunked: true,
      triggers: true,
      text: 'Monthly statement summary. No transactions were posted this period.'
    })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'An wen ging das meiste Geld?',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).toBe(t('en', 'skills.bankAnalysis.empty'))
    expect(h.runtime.calls).toBe(0)
  })

  it('a doc with a PRIOR extraction inverts even without a manifest signal match', async () => {
    // classMatches also fires when a persisted extraction already exists (the strongest evidence the skill
    // has read this doc). No triggers + a non-statement filename, but a first vocabulary turn seeds an
    // extraction; the follow-up NON-vocabulary question then inverts to grounded-data.
    const h = await makeHarness({ fullyChunked: true, triggers: false, docFile: 'ledger.txt' })
    // Seed the extraction via a vocabulary-shaped turn (applies() true).
    await invoke(handlers, IPC.askDocuments, h.conversationId, 'summarize the transactions', BANK_INSTALL_ID)
    expect(bankRows(h)).toBe(1)
    // The follow-up misses the vocabulary; classMatches now sees the prior extraction → grounded-data.
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'An wen ging das meiste Geld?',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.coverage?.mode).toBe('extract')
    const lastTurn = h.runtime.lastMessages[h.runtime.lastMessages.length - 1]
    expect(lastTurn.content).toContain('Bank statement (JSON):')
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

  // A4 (SKA-8, audit §3.2): the W2 count-mismatch routing is now VOCABULARY-gated uniformly. A sticky
  // skill over a MULTI-doc scope no longer turns EVERY non-chatter question into a "pick one / select two"
  // dead-end — only a vocabulary-shaped one narrows/routes; a general/off-topic question falls through to
  // the ordinary engines (relevance/coverage-extract).
  it('SKA-8: an instruction skill + multi-doc + OFF-TOPIC question falls through to relevance, NOT selectOne', async () => {
    const h = await makeMultiHarness({
      docs: [
        { file: 'notes-a.txt', text: 'General notes about the weather and the weekend plans.' },
        { file: 'notes-b.txt', text: 'More notes about lunch and the office plants.' },
        { file: 'notes-c.txt', text: 'Even more notes about nothing in particular at all.' }
      ],
      installContractBrief: true
    })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'who is Angela Merkel?',
      'app:contract-brief'
    )
    const msg = result as Message
    // The off-topic question misses contract-brief's vocabulary → the pre-pass does NOT fire → the ordinary
    // relevance engine answers (model consulted), never the "pick one document" dead-end.
    expect(msg.content).not.toBe(t('en', 'skills.analysis.selectOne', { count: 3 }))
    expect(h.runtime.calls).toBe(1)
  })

  it('SKA-8 uniformity: a tool skill + multi-doc + OFF-TOPIC question falls through AND the A4 inversion does NOT over-fire at multi-doc', async () => {
    // Tool `intends()` was already vocabulary-shaped pre-A4, so the fall-through (content ≠ selectOne,
    // calls===1) is unchanged W2 behaviour — kept here as a uniformity check. The A4-relevant guard is
    // `skill_runs.n === 0`: the new single-doc `classMatches` inversion must NOT engage over a MULTI-doc
    // scope (`singleDocMatchesSkillClass` returns false unless exactly one doc is in scope), so no
    // extraction is force-run for an off-topic multi-doc question.
    const h = await makeMultiHarness({
      docs: [
        { file: 'statement-jan.txt', text: CLEAN },
        { file: 'statement-feb.txt', text: CLEAN },
        { file: 'notes.txt', text: 'Some notes.' }
      ]
    })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'who is Angela Merkel?',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).not.toBe(t('en', 'skills.analysis.selectOne', { count: 3 }))
    expect(h.runtime.calls).toBe(1)
    // A4 teeth: the single-doc inversion never engages at multi-doc scope → no extraction force-run.
    const runs = h.db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(0)
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

// T2 (skills-audit-2026-07-03 §5) — SEC-1 end-to-end at the CHAT surface. The resolver unit tests pin
// that `manifestAnalysisHandler` refuses a tool-kind manifest; this drives the full askDocuments IPC:
// an ENABLED user-imported `kind:'tool'` skill declaring `analysis: whole-doc` over a signal-matching,
// fully-chunked statement must land on plain RELEVANCE — no analysis engine, no Tier-2 tool run.
describe('askDocuments — SEC-1 end-to-end (user kind:tool skill never reaches an analysis engine, T2)', () => {
  it('user tool skill + analysis: whole-doc + matching doc → the relevance path (no handler, no tool run)', async () => {
    // Teeth: honor `manifestAnalysisHandler` for kind:'tool' (drop its instruction-only guard AND the
    // parser's analysisIgnoredForTool note) → the whole-doc engine would fire here → red.
    const h = await makeHarness({ fullyChunked: true, userToolSkill: true })
    // Sanity: the worst case really is on the board — an ENABLED user TOOL skill that declared tools
    // (the manifest parser already stripped its `analysis: whole-doc`; that strip is one of the gates).
    const record = getSkill(h.db, 'user:imported-bank')!
    expect(record.source).toBe('user')
    expect(record.kind).toBe('tool')
    expect(record.enabled).toBe(true)
    expect(record.manifest.analysis).toBeUndefined() // parser gate: ignored for a tool skill
    expect(record.manifest.allowedTools.length).toBeGreaterThan(0)

    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'summarize the transactions', // would engage any analysis engine, were one resolvable
      'user:imported-bank'
    )
    const msg = result as Message

    // Relevance, not analysis: one ordinary grounded model call whose prompt carries retrieved excerpts,
    // never the serialized extract; the answer is the model's, not the deterministic template.
    expect(h.runtime.calls).toBe(1)
    expect(msg.content).toContain('Model answer.')
    expect(msg.content).not.toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
    // The relevance path stamps `relevance` coverage (D72) — never the extract/whole-document breadth
    // an analysis handler would claim.
    expect(msg.coverage?.mode).toBe('relevance')
    const lastTurn = h.runtime.lastMessages[h.runtime.lastMessages.length - 1]
    expect(lastTurn.content).not.toContain('Bank statement (JSON):')

    // No Tier-2 tool ever ran for the user skill — no run row, no run lifecycle in the audit.
    const runs = h.db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(0)
    expect(h.audit.map((e) => e.type)).not.toContain('skill_run_started')
  })
})

// T2 (skills-audit-2026-07-03 §5 honesty-matrix gap) — W6's multi-currency grounded-data behaviour at
// the IPC layer: W6 pinned the pure builder (rag-grounded-data.test.ts); this pins what the user KEEPS.
describe('askDocuments — W6 multi-currency grounded-data (IPC pin, T2)', () => {
  const MIXED = 'Statement\n2026-01-02 Coffee -3,50 EUR\n2026-01-03 Book -10,00 USD'

  it('a mixed-currency statement PERSISTS no cashflow echo under the model answer', async () => {
    // Teeth: make buildCashflowPostscript echo unconditionally (drop its `summary.currency` gate) → the
    // persisted content would carry a cross-currency net figure → red.
    const h = await makeHarness({ fullyChunked: true, text: MIXED })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what was my largest transaction?', // non-summary shape → grounded-data
      BANK_INSTALL_ID
    )
    const msg = result as Message

    // The grounded-data narration ran (model called over the serialized extract)…
    expect(h.runtime.calls).toBe(1)
    expect(msg.content).toContain('Model answer.')
    expect(h.runtime.lastMessages[h.runtime.lastMessages.length - 1].content).toContain('Bank statement (JSON):')
    // …but the persisted turn carries NO app-authored cashflow echo: summing EUR and USD into one net
    // (−13.50) would be an invented figure, so no "computed" totals line may ride under the answer.
    expect(msg.content).not.toContain('13.50')
    expect(msg.content).not.toContain('computed')
    expect(msg.content).not.toContain(t('en', 'skills.bankAnalysis.figureEchoNet', { amount: '13.50', currency: 'EUR' }))
  })
})

// Issues #37/#38 — the no-skill aggregation incident: „kategorisiere die ausgaben und erstelle
// eine summe pro kategorie auf" over a 25-page statement silently ran on top-k retrieval and
// presented per-category sums computed from 5 of 25 sections like a normal answer. The router
// now classifies aggregation verbs as coverage; with no extract data it falls back to relevance
// marked `fallback:'coverage'`, and askDocuments LEADS the answer with the actionable deep-index
// hint instead of discarding the confidence (the pre-fix behaviour).
describe('askDocuments — whole-document hint on the low-confidence coverage fallback (#37/#38)', () => {
  it('the #37 aggregation question with NO skill leads with the deep-index hint over the relevance answer', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'kategorisiere die ausgaben und erstelle eine summe pro kategorie auf',
      null // explicit no-skill turn — the incident configuration
    )
    const msg = result as Message

    // Teeth: discard `decision.confidence` again (the pre-fix behaviour) → no hint → red.
    expect(msg.content.startsWith(t('en', 'analysis.wholeDocHint'))).toBe(true)
    // The hint LEADS the ordinary relevance answer — it never replaces it.
    expect(msg.content).toContain('Model answer.')
    expect(h.runtime.calls).toBe(1)
    expect(msg.coverage?.mode).toBe('relevance')
  })

  it('an ordinary question never carries the hint (byte-unchanged relevance)', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'who wrote this letter?',
      null
    )
    const msg = result as Message
    expect(msg.content).not.toContain(t('en', 'analysis.wholeDocHint'))
    expect(msg.content).toContain('Model answer.')
  })

  // full-audit 2026-07-10 BE-3 — an INFLECTED German count question ("Zähle …": the router's
  // zähl stem previously sat behind a trailing \b only "zähl"/"zahl" could satisfy) must engage
  // the same coverage machinery as its English equivalent: the deterministic listing when
  // extract data exists in scope, the deep-index hint when not. Both cases FAILED pre-fix
  // (silent top-k relevance, no hint). The doc text carries "Ausgaben" so the hint case's
  // relevance retrieval finds the chunk under the token-overlap mock embedder (an empty
  // retrieval takes the no-context honesty path, which never carries a prefix).
  const DE_STATEMENT =
    'Ausgaben Statement EUR\nOpening balance 2.000,00\n2026-01-02 Miete -800,00 1.200,00\n' +
    'Closing balance 1.200,00'

  it('an inflected German count question WITH extract data takes the deterministic coverage-extract route (BE-3)', async () => {
    const h = await makeHarness({ fullyChunked: true, text: DE_STATEMENT })
    // Seed a __scan__ completeness marker + one 'amount' record, the shape a finished deep-index
    // extract pass leaves behind (extractionsExistInScope gates on the marker).
    const chunkId = (
      h.db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 1').get(h.docId) as { id: string }
    ).id
    const insertRec = (recordType: string, value: string, normalized: string): void => {
      h.db
        .prepare(
          `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), h.docId, chunkId, recordType, value, normalized, `hash-${normalized}`, '2026-07-10T00:00:00.000Z')
    }
    insertRec(SCAN_MARKER_TYPE, '', 'ok')
    insertRec('amount', '45,90 EUR', '45.90')

    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, 'Zähle die Ausgaben', null)
    const msg = result as Message

    // Deterministic listing over the precomputed extract — zero model calls, never top-k.
    expect(h.runtime.calls).toBe(0)
    expect(msg.content).toContain(t('en', 'analysis.listing.item', { value: '45,90 EUR', count: 1 }))
    expect(msg.content).not.toContain(t('en', 'analysis.wholeDocHint'))
  })

  it('the same German count question WITHOUT extract data leads with the deep-index hint (BE-3)', async () => {
    const h = await makeHarness({ fullyChunked: true, text: DE_STATEMENT })
    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, 'Zähle die Ausgaben', null)
    const msg = result as Message
    expect(msg.content.startsWith(t('en', 'analysis.wholeDocHint'))).toBe(true)
    expect(msg.content).toContain('Model answer.')
    expect(h.runtime.calls).toBe(1)
  })

  // Issue #54 — the wrong-shape half of the #37 incident: WITH extract data the aggregation
  // question deterministically got the amounts frequency list ("Found 193 amounts …"), which is
  // NOT the requested categories-with-sums, and (unlike the no-data case above) carried no hint
  // at all — the categorization intent is structurally unrepresentable in the listing engine.
  // Owner decision 2026-07-17: keep the honest listing, but LEAD it with the shape hint + the
  // bank-statement-skill pointer for amounts (option 1 of 3; auto-routing to the skill would
  // reverse the ratified default-off auto-fire posture, a bare redirect would withhold data).
  it('#54: the aggregation question WITH extract data leads the listing with the shape hint + skill pointer', async () => {
    const h = await makeHarness({ fullyChunked: true, text: DE_STATEMENT })
    const chunkId = (
      h.db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 1').get(h.docId) as { id: string }
    ).id
    const insertRec = (recordType: string, value: string, normalized: string): void => {
      h.db
        .prepare(
          `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), h.docId, chunkId, recordType, value, normalized, `hash-${normalized}`, '2026-07-10T00:00:00.000Z')
    }
    insertRec(SCAN_MARKER_TYPE, '', 'ok')
    insertRec('amount', '45,90 EUR', '45.90')

    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'kategorisiere alle transaktionen und erstelle eine summe pro kategorie',
      null // the #54 configuration: no skill on the turn
    )
    const msg = result as Message

    // Still the deterministic listing (0 model calls) — the hint LEADS it, never replaces it.
    expect(h.runtime.calls).toBe(0)
    expect(msg.content.startsWith(t('en', 'analysis.listing.aggregationHint'))).toBe(true)
    expect(msg.content).toContain(t('en', 'analysis.listing.aggregationHintAmountSkill'))
    expect(msg.content).toContain(t('en', 'analysis.listing.item', { value: '45,90 EUR', count: 1 }))
  })

  it('#54: a plain count question keeps its listing WITHOUT the shape hint (byte-unchanged)', async () => {
    const h = await makeHarness({ fullyChunked: true, text: DE_STATEMENT })
    const chunkId = (
      h.db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 1').get(h.docId) as { id: string }
    ).id
    const insertRec = (recordType: string, value: string, normalized: string): void => {
      h.db
        .prepare(
          `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), h.docId, chunkId, recordType, value, normalized, `hash-${normalized}`, '2026-07-10T00:00:00.000Z')
    }
    insertRec(SCAN_MARKER_TYPE, '', 'ok')
    insertRec('amount', '45,90 EUR', '45.90')

    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId, 'Zähle die Ausgaben', null)
    const msg = result as Message
    expect(h.runtime.calls).toBe(0)
    expect(msg.content).not.toContain(t('en', 'analysis.listing.aggregationHint'))
    expect(msg.content).toContain(t('en', 'analysis.listing.item', { value: '45,90 EUR', count: 1 }))
  })

  it('the same #37 question WITH the bank skill takes the whole-document engine — no hint, no top-k', async () => {
    // The user-facing guarantee behind #37: a bank-statement aggregation ask with the skill
    // attached is answered from the WHOLE statement (deterministic extract, honest extract
    // coverage), never from retrieved excerpts — so the hint has nothing to warn about.
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'kategorisiere die ausgaben und erstelle eine summe pro kategorie auf',
      BANK_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.coverage?.mode).toBe('extract')
    expect(msg.coverage?.fullyChunked).toBe(true)
    expect(msg.content).toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
    expect(msg.content).not.toContain(t('en', 'analysis.wholeDocHint'))
  })
})
