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
const MEETING_INSTALL_ID = 'app:meeting-protocol'

// A short multi-line "transcript" so the whole document fits the budget (not truncated).
const TRANSCRIPT = [
  'Project sync 2026-06-22. Present: Anna, Ben.',
  'Decision: ship the beta on Friday.',
  'Action: Ben to update the changelog by Thursday.',
  'Open question: do we need a second reviewer?'
].join('\n')

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

interface Harness {
  db: Db
  conversationId: string
  docId: string
  runtime: ModelRuntime & { calls: number; lastMessages: ChatMessage[] }
}

async function makeHarness(opts: { fullyChunked?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-wholedocskill-'))
  const workspacePath = join(root, 'workspace')
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeMeetingSkill(appSkillsDir)

  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir, appVersion: '0.0.0-test' })
  skills.reconcile() // installs app:meeting-protocol ENABLED

  const storeDir = documentsDir(workspacePath)
  const docPath = join(root, 'transcript.txt')
  writeFileSync(docPath, TRANSCRIPT, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })
  if (opts.fullyChunked === false) {
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(doc.id)
  }

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

  it('off-topic question keeps the relevance path (no capped coverage, model still answers)', async () => {
    const h = await makeHarness({ fullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId,
      'what colour is the sky?',
      MEETING_INSTALL_ID
    )
    const msg = result as Message
    expect(h.runtime.calls).toBe(1)
    // Relevance path ⇒ no persisted coverage (renderer falls back to the relevance badge).
    expect(msg.coverage).toBeUndefined()
  })
})
