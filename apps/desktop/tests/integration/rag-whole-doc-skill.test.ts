import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Skill-whole-doc engine (Wave 2) — the CHAT wiring: `askDocuments` routes an analysis-shaped
// question for a `grounded-whole-doc` INSTRUCTION skill (meeting-protocol) to a MODEL answer over the
// WHOLE document (capped coverage, fence applied), REFUSES a not-fully-chunked doc (fixed message, no
// model), and leaves the relevance path unchanged for an off-topic question. Drives the real IPC
// handler with a faked transport (mirrors rag-skill-analysis.test.ts).

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

import { randomUUID } from 'node:crypto'
import { IPC } from '../../src/shared/ipc'
import type { Message } from '../../src/shared/types'
import { openDatabase, type Db } from '../../src/main/services/db'
import { SCAN_MARKER_TYPE } from '../../src/main/services/analysis/extract'
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
const MEETING_INSTALL_ID = 'app:meeting-protocol'

// A short multi-line "transcript" so the whole document fits the budget (not truncated).
const TRANSCRIPT = [
  'Project sync 2026-06-22. Present: Anna, Ben.',
  'Decision: ship the beta on Friday.',
  'Action: Ben to update the changelog by Thursday.',
  'Open question: do we need a second reviewer?'
].join('\n')

/** A realistic large transcript that overflows the whole-doc budget at a 4096 window — for the A3
 *  needle-vs-deliverable downgrade (a NEEDLE ask over an over-budget doc with no tree keeps top-k). */
function bigTranscript(lines: number): string {
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    out.push(
      `Line ${i}: the team discussed the quarterly roadmap in detail, weighed the trade-offs of each ` +
        `proposal, recorded who would own which follow-up, and noted the budget implications carefully.`
    )
  }
  return out.join('\n')
}

function writeMeetingSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'meeting-protocol')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: meeting-protocol',
    'title: Meeting Minutes',
    'description: Produces minutes.',
    'version: 1.1.0',
    'kind: instruction',
    '---',
    'Produce structured minutes: decisions, action items, open questions. Work only from the source.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

/** A3: a USER-imported INSTRUCTION skill declaring `analysis: whole-doc` — it has NO app-registered
 *  handler, so it must reach the whole-doc engine via the manifest fallback (`manifestAnalysisHandler`). */
const USER_BRIEF_INSTALL_ID = 'user:brief-reader'
function writeUserWholeDocSkill(userSkillsDir: string): void {
  const d = join(userSkillsDir, 'brief-reader')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: brief-reader',
    'title: Brief Reader',
    'description: Briefs a document.',
    'version: 1.0.0',
    'kind: instruction',
    'analysis: whole-doc',
    '---',
    'Give a plain-language brief of the whole document. Work only from the source.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

interface Harness {
  db: Db
  conversationId: string
  docId: string
  runtime: ModelRuntime & { calls: number; lastMessages: ChatMessage[] }
}

async function makeHarness(opts: { fullyChunked?: boolean; text?: string; contextWindow?: number; userWholeDocSkill?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-wholedocskill-'))
  const workspacePath = join(root, 'workspace')
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeMeetingSkill(appSkillsDir)
  if (opts.userWholeDocSkill) writeUserWholeDocSkill(userSkillsDir)

  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir, appVersion: '0.0.0-test' })
  skills.reconcile() // installs app:meeting-protocol ENABLED; a user skill installs DISABLED (import-ack gated)
  if (opts.userWholeDocSkill) {
    // A user skill is reconciled DISABLED (enabled only after the import-warning ack); enable it so the
    // turn resolver picks it up — the point under test is the ENGINE resolution, not the import UX.
    db.prepare('UPDATE skills SET enabled = 1 WHERE install_id = ?').run(USER_BRIEF_INSTALL_ID)
  }

  const storeDir = documentsDir(workspacePath)
  const docPath = join(root, 'transcript.txt')
  writeFileSync(docPath, opts.text ?? TRANSCRIPT, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })
  if (opts.fullyChunked === false) {
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(doc.id)
  }

  const runtime = {
    modelId: 'mock',
    calls: 0,
    lastMessages: [] as ChatMessage[],
    // Report a fixed launched window (§L0) so the A3 needle downgrade's budget calculus is deterministic;
    // the tiny default TRANSCRIPT still fits it (not truncated), so existing expectations are unchanged.
    contextWindow: () => opts.contextWindow ?? 4096,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[]) {
      runtime.calls++
      runtime.lastMessages = messages
      yield 'Minutes: decisions, actions, open questions.'
    }
  } as unknown as ModelRuntime & { calls: number; lastMessages: ChatMessage[] }

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
    audit: () => {},
    skills
  } as unknown as AppContext

  registerBuiltinSkillAnalysisHandlers()
  registerRagIpc(ctx)
  const conv = createConversation(db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds: [doc.id] }
  })
  return { db, conversationId: conv.id, docId: doc.id, runtime }
}

beforeEach(() => {
  clearSkillAnalysisHandlers()
  inFlightStreams.clear()
})

describe('askDocuments — grounded-whole-doc skill routing (skill-whole-doc engine, Wave 2)', () => {
  it('whole-document path: a fully-chunked doc gets a MODEL answer with capped coverage + the fence', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'write the meeting minutes',
      MEETING_INSTALL_ID
    )
    const msg = result as Message

    // The MODEL was called (unlike the deterministic bank/invoice handlers).
    expect(h.runtime.calls).toBe(1)
    expect(msg.content).toContain('Minutes')
    // Honest breadth: the whole (small) document fit → capped/not-truncated → "covers the whole document".
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    // Real source citations + the skill stamp (explicit pick ⇒ autoFired false).
    expect(msg.citations && msg.citations.length).toBeGreaterThan(0)
    expect(msg.skillId).toBe(MEETING_INSTALL_ID)
    expect(msg.autoFired).toBe(false)
    // The SKILL.md fence rode in the grounded user turn (the model saw the instructions).
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userTurn).toContain('structured minutes')
    // The WHOLE transcript reached the model (a late line, not just the top-k head).
    expect(userTurn).toContain('second reviewer')
  })

  it('refuse path: a not-fully-chunked doc is refused — fixed message, no model call', async () => {
    const h = await makeHarness({ fullyChunked: false })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'write the meeting minutes',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).toBe(t('en', 'skills.analysis.refusePartial'))
    expect(h.runtime.calls).toBe(0)
    expect(msg.coverage).toBeUndefined()
  })

  it('clear small talk keeps the relevance path (A3 opt-out — no capped coverage, model still answers)', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'thanks!',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    // Small-talk opt-out ⇒ the whole-doc engine did NOT fire: no capped whole-document coverage claim
    // (the ordinary relevance path handled it — renderer falls back to the relevance badge).
    expect(msg.coverage).toBeUndefined()
  })

  it('A3 inversion: a GENERAL (non-shaped, non-chatter) question now gets the whole-doc engine', async () => {
    // Pre-A3 this off-topic-to-the-keyword-list question degraded to top-k; now the whole-doc engine is
    // the default for an active analysis skill over a single fully-chunked doc.
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what does this document cover?',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    expect(h.runtime.calls).toBe(1)
    // capped breadth ⇒ the model read the whole (small) document, not top-k passages.
    expect(msg.coverage?.mode).toBe('capped')
    // The whole transcript reached the model (a late line, not just the top-k head).
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userTurn).toContain('second reviewer')
  })
})

// A3 needle-vs-deliverable downgrade (audit §8.2 (b)): the whole-doc engine is the DEFAULT, but a targeted
// single-fact LOOKUP over a document that OVERFLOWS the whole-doc budget with NO deep-index tree is better
// served by top-k — a needle past the truncation cut would be missed. A DELIVERABLE over the SAME doc keeps
// the whole (capped) read. Proven on one over-budget transcript at a 4096 window.
describe('askDocuments — A3 needle downgrade on an over-budget doc', () => {
  it('a NEEDLE ask keeps top-k (relevance path, no capped whole-doc claim)', async () => {
    const h = await makeHarness({ fullyChunked: true, text: bigTranscript(400), contextWindow: 4096 })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what is the decision on the budget?',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    expect(h.runtime.calls).toBe(1)
    // Downgraded to relevance ⇒ NO capped whole-document coverage claim (honest top-k badge instead).
    expect(msg.coverage?.mode).not.toBe('capped')
    expect(msg.skillId).toBe(MEETING_INSTALL_ID)
  })

  it('a DELIVERABLE ask over the SAME over-budget doc keeps the whole (capped, truncated) read', async () => {
    const h = await makeHarness({ fullyChunked: true, text: bigTranscript(400), contextWindow: 4096 })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'write the meeting minutes',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    expect(h.runtime.calls).toBe(1)
    // A deliverable never downgrades: it keeps the whole-doc engine (capped + honestly truncated + W1 notice).
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(true)
  })

  it('SKA-12 (A4): a NEEDLE over an over-budget doc WITH a ready tree ALSO keeps top-k (tree conjunct dropped)', async () => {
    // Pre-A4 the downgrade required NO ready tree, so a needle over a deep-indexed over-budget doc ran a
    // ~13-call map-reduce over lossy node summaries. A4 drops the tree conjunct: a needle prefers top-k
    // whenever the whole read would truncate — the tree keeps rescuing DELIVERABLES only.
    const h = await makeHarness({ fullyChunked: true, text: bigTranscript(400), contextWindow: 4096 })
    h.db.prepare("UPDATE documents SET tree_status = 'ready' WHERE id = ?").run(h.docId)
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what is the decision on the budget?',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    // Downgraded to relevance despite the ready tree ⇒ NO capped whole-document coverage claim.
    expect(msg.coverage?.mode).not.toBe('capped')
    expect(msg.skillId).toBe(MEETING_INSTALL_ID)
  })

  it('SKA-23 (A4): a NEEDLE over a NOT-fully-chunked over-budget doc is served by top-k, NOT refused', async () => {
    // The needle downgrade is now evaluated BEFORE the D45 fully-chunked refusal: a downgraded needle takes
    // the relevance path (no whole-document claim), so the refusal's premise doesn't apply. Pre-A4 the
    // refusal fired first → the fixed "re-index" message with no answer.
    const h = await makeHarness({ fullyChunked: false, text: bigTranscript(400), contextWindow: 4096 })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what is the decision on the budget?',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).not.toBe(t('en', 'skills.analysis.refusePartial'))
    expect(h.runtime.calls).toBe(1) // the relevance (top-k) model call, not the 0-call refusal
    expect(msg.coverage?.mode).not.toBe('capped')
  })

  it('SKA-23 (A4): a DELIVERABLE over a NOT-fully-chunked doc still hits the D45 refusal (premise applies)', async () => {
    // A deliverable never downgrades → it keeps the WHOLE read, which over a partly-chunked doc is refused
    // (the refusal's premise — a partial whole read passed off as complete — does apply).
    const h = await makeHarness({ fullyChunked: false, text: bigTranscript(400), contextWindow: 4096 })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'write the meeting minutes',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).toBe(t('en', 'skills.analysis.refusePartial'))
    expect(h.runtime.calls).toBe(0)
  })

  it('when a downgraded needle lands on the coverage-extract listing, the turn KEEPS its skill stamp (A3 review fix)', async () => {
    // A "how many X" needle is in BOTH NEEDLE_SHAPES and the coverage-extract router, so a downgraded needle
    // over a doc with precomputed extractions is answered by the deterministic listing — which must still
    // carry the skill provenance (and, when W2-narrowed, the scope notice), not silently drop them.
    const h = await makeHarness({ fullyChunked: true, text: bigTranscript(400), contextWindow: 4096 })
    // Seed a __scan__ completeness marker + one 'date' record so extractionsExistInScope + aggregate fire.
    const chunkId = (h.db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 1').get(h.docId) as { id: string }).id
    const now = '2026-07-03T00:00:00.000Z'
    const insertRec = (recordType: string, value: string, normalized: string): void => {
      h.db
        .prepare(
          `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), h.docId, chunkId, recordType, value, normalized, `hash-${normalized}`, now)
    }
    insertRec(SCAN_MARKER_TYPE, '', 'ok')
    insertRec('date', '2026-01-15', '2026-01-15')

    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'how many dates are mentioned?',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    // Deterministic coverage-extract listing (0 model calls) — but the skill stamp survives the downgrade.
    expect(h.runtime.calls).toBe(0)
    expect(msg.coverage?.mode).not.toBe('capped') // NOT the whole-doc engine — it was downgraded off it
    expect(msg.skillId).toBe(MEETING_INSTALL_ID)
  })
})

// A3 (audit §6.3) — the HEADLINE fix: a USER-imported instruction skill declaring `analysis: whole-doc`
// reaches the SAME whole-doc engine as a bundled skill, via the manifest fallback (no app-registered
// handler). Pinned end-to-end through the real askDocuments IPC (not just the pure factory).
describe('askDocuments — a user instruction skill reaches the whole-doc engine (A3 manifest fallback)', () => {
  it('routes a user analysis:whole-doc skill to the whole-document engine (capped coverage, whole doc read)', async () => {
    const h = await makeHarness({ fullyChunked: true, userWholeDocSkill: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'brief this document',
      USER_BRIEF_INSTALL_ID
    )
    const msg = result as Message
    // The whole-doc engine fired for a USER skill with NO registered handler: model answer over the whole doc.
    expect(h.runtime.calls).toBe(1)
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.skillId).toBe(USER_BRIEF_INSTALL_ID)
    // The WHOLE transcript reached the model (a late line, not just the top-k head).
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userTurn).toContain('second reviewer')
    // The user skill's fence rode the turn.
    expect(userTurn).toContain('plain-language brief')
  })
})
