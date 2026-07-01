import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Skill-whole-doc engine, Follow-up B — the CHAT wiring for a 2-document compare: `askDocuments`
// routes a compare-shaped question for the `grounded-whole-doc-compare` skill (what-changed) to a
// MODEL answer over BOTH documents read whole (budget split, capped coverage, fence applied), REFUSES
// when either doc is not fully chunked, and does NOT fire on a single-doc scope (keeps relevance).

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
const WHAT_CHANGED_INSTALL_ID = 'app:what-changed'

// A real version pair: same wording except the amounts/terms — the diff-driven compare path.
const VERSION_A = 'Service fee is 100 EUR per month. Term: 12 months. Cancellation notice: 30 days.'
const VERSION_B = 'Service fee is 120 EUR per month. Term: 24 months. Cancellation notice: 60 days.'
// A pair with NO shared wording — the diff is abandoned and the whole-doc-compare read runs.
const REWRITE_A = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike'
const REWRITE_B = 'one two three four five six seven eight nine ten eleven twelve thirteen'

function writeWhatChangedSkill(appSkillsDir: string): void {
  const d = join(appSkillsDir, 'what-changed')
  mkdirSync(d, { recursive: true })
  const lines = [
    '---',
    'id: what-changed',
    'title: What Changed?',
    'description: Compare two versions.',
    'version: 1.0.0',
    'kind: instruction',
    '---',
    'Compare the two versions and report the material changes that matter, in business language.'
  ]
  writeFileSync(join(d, 'SKILL.md'), lines.join('\n'), 'utf8')
}

interface Harness {
  db: Db
  conversationId: (docIds: string[]) => string
  docA: string
  docB: string
  mk: (name: string, text: string) => Promise<string>
  runtime: ModelRuntime & { calls: number; lastMessages: ChatMessage[] }
}

async function makeHarness(opts: { bothFullyChunked?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-wholedoccompare-'))
  const workspacePath = join(root, 'workspace')
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeWhatChangedSkill(appSkillsDir)

  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir, appVersion: '0.0.0-test' })
  skills.reconcile()

  const storeDir = documentsDir(workspacePath)
  const mk = async (name: string, text: string): Promise<string> => {
    const p = join(root, name)
    writeFileSync(p, text, 'utf8')
    const doc = createQueuedDocument(db, p)
    await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })
    return doc.id
  }
  const docA = await mk('v1.txt', VERSION_A)
  const docB = await mk('v2.txt', VERSION_B)
  if (opts.bothFullyChunked === false) {
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(docB)
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
      yield 'Material changes: fee 100→120, term 12→24, notice 30→60.'
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
  const conversationId = (docIds: string[]): string =>
    createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: docIds } }).id
  return { db, conversationId, docA, docB, mk, runtime }
}

beforeEach(() => {
  clearSkillAnalysisHandlers()
  inFlightStreams.clear()
})

describe('askDocuments — grounded-whole-doc-compare routing (what-changed, Follow-up B)', () => {
  it('diff path: the EXACT changes reach the model (not two walls of text), capped coverage, cited, stamped', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([h.docA, h.docB]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message

    expect(h.runtime.calls).toBe(1)
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    // The model is handed the deterministic change list — the exact changed values, not two whole
    // documents. A one-word change here cannot be missed because it is spelled out. The redline
    // direction follows document order (inherently ambiguous without an old/new signal), so accept
    // either — what matters is that the exact 100↔120 change is surfaced deterministically.
    expect(userTurn).toContain('deterministic word-level comparison')
    expect(userTurn).toContain('100')
    expect(userTurn).toContain('120')
    expect(userTurn).toMatch(/~~(100|120)~~ \*\*(120|100)\*\*/) // redline shows the exact swap
    expect(userTurn).not.toContain('Document 1') // NOT the whole-doc-walls prompt
    // The SKILL.md fence rode in the compare user turn.
    expect(userTurn).toContain('material changes')
    // Honest breadth: the diff examined the WHOLE of both documents → capped/not-truncated.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    // Citations point at the change locations in BOTH documents; the skill is stamped.
    expect(msg.citations && msg.citations.length).toBeGreaterThanOrEqual(2)
    expect(msg.skillId).toBe(WHAT_CHANGED_INSTALL_ID)
    expect(msg.autoFired).toBe(false)
  })

  it('identical documents: the model is told they are identical (not asked to eyeball two walls)', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    const same = await h.mk('same.txt', VERSION_A)
    const sameCopy = await h.mk('same-copy.txt', VERSION_A)
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([same, sameCopy]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userTurn).toContain('textually identical')
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
  })

  it('a full rewrite (no shared wording) falls back to the labelled whole-doc-compare read', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    const a = await h.mk('rewrite-a.txt', REWRITE_A)
    const b = await h.mk('rewrite-b.txt', REWRITE_B)
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([a, b]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    // The diff was abandoned (no shared content) → the two documents are presented as labelled blocks.
    expect(userTurn).toContain('Document 1')
    expect(userTurn).toContain('Document 2')
    expect(userTurn).not.toContain('deterministic word-level comparison')
    expect(msg.coverage?.mode).toBe('capped')
  })

  it('refuse path: a not-fully-chunked doc in the pair is refused — fixed message, no model call', async () => {
    const h = await makeHarness({ bothFullyChunked: false })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([h.docA, h.docB]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).toBe(t('en', 'skills.analysis.refusePartial'))
    expect(h.runtime.calls).toBe(0)
    expect(msg.coverage).toBeUndefined()
  })

  it('does NOT fire on a single-doc scope (needs exactly two) — keeps the relevance path', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([h.docA]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message
    // The compare path did NOT fire (needs exactly two in-scope docs) ⇒ no capped coverage stamped;
    // the turn took the ordinary relevance path instead.
    expect(msg.coverage).toBeUndefined()
  })
})
