import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Skill-whole-doc engine, Follow-up A — the DEEP-INDEX TREE map-reduce for an over-budget document
// (architecture.md §20). `answerWholeDocFromTree` runs the skill-fenced map-reduce over the precomputed
// node summaries (the same machinery the tree summary uses), stamps `tree` coverage, cites the leaf
// chunks, and applies the SKILL.md fence at EVERY step — or returns null (no usable tree) so the caller
// keeps the Wave 2 capped/"beginning" path. Drives the function directly with a faked runtime.

import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { createConversation } from '../../src/main/services/chat'
import { answerWholeDocFromTree } from '../../src/main/services/rag/whole-doc-tree'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'
import type { TurnSkill } from '../../src/main/services/chat'

const SKILL: TurnSkill = {
  installId: 'app:meeting-protocol',
  title: 'Meeting Minutes',
  // The fence body marker the assertions look for at each step.
  body: 'Produce structured minutes: decisions, action items, open questions. Work only from the source.'
}

// A multi-paragraph doc so ingestion yields several chunks to hang the tree leaves on.
const DOC = Array.from({ length: 8 }, (_, i) =>
  `Paragraph ${i + 1}. Topic ${i + 1} was discussed at length with concrete points and follow-ups.`
).join('\n\n')

interface FakeRuntime extends ModelRuntime {
  calls: number
  turns: string[][]
}

function fakeRuntime(): FakeRuntime {
  const rt = {
    modelId: 'mock',
    calls: 0,
    turns: [] as string[][],
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[]) {
      rt.calls++
      rt.turns.push(messages.map((m) => `${m.role}:${m.content}`))
      yield 'Minutes body with decisions and actions.'
    }
  } as unknown as FakeRuntime
  return rt
}

interface Harness {
  db: Db
  conversationId: string
  docId: string
  chunkIds: string[]
}

async function makeDoc(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-wholedoctree-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const storeDir = documentsDir(workspacePath)
  const docPath = join(root, 'doc.txt')
  writeFileSync(docPath, DOC, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })
  const chunkIds = (
    db
      .prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(doc.id) as Array<{ id: string }>
  ).map((r) => r.id)
  const conv = createConversation(db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds: [doc.id] }
  })
  return { db, conversationId: conv.id, docId: doc.id, chunkIds }
}

let nodeSeq = 0
function insertNode(
  db: Db,
  docId: string,
  level: number,
  ordinal: number,
  isRoot: boolean,
  summary: string
): string {
  const id = `node-${++nodeSeq}`
  db.prepare(
    `INSERT INTO tree_nodes
       (id, document_id, scope_key, level, ordinal, parent_id, is_root, summary_text,
        embedding_blob, dimensions, embedding_model_id, content_hash, model_id, created_at)
     VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
  ).run(id, docId, level, ordinal, isRoot ? 1 : 0, summary, `hash-${id}`, 'mock', new Date().toISOString())
  return id
}

function insertEdge(db: Db, parentId: string, childId: string, childIsChunk: boolean, ordinal: number): void {
  db.prepare(
    'INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, ?, ?)'
  ).run(parentId, childId, childIsChunk ? 1 : 0, ordinal)
}

function markTreeReady(db: Db, docId: string): void {
  db.prepare('UPDATE documents SET tree_status = ? WHERE id = ?').run('ready', docId)
}

beforeEach(() => {
  nodeSeq = 0
})

describe('answerWholeDocFromTree — deep-index map-reduce for an over-budget whole-doc skill turn', () => {
  it('single-level tree: one fenced reduce over the node summary → tree coverage + leaf citations + skill stamp', async () => {
    const h = await makeDoc()
    // Degenerate (single-level) tree: the root IS the deepest layer; its children are the leaf chunks.
    const root = insertNode(h.db, h.docId, 1, 0, true, 'Section summary: decisions made and actions assigned.')
    h.chunkIds.forEach((cid, i) => insertEdge(h.db, root, cid, true, i))
    markTreeReady(h.db, h.docId)

    const rt = fakeRuntime()
    const msg = await answerWholeDocFromTree({
      db: h.db,
      runtime: rt,
      conversationId: h.conversationId,
      documentId: h.docId,
      question: 'write the meeting minutes',
      skill: SKILL,
      contextTokens: 8192
    })

    expect(msg).not.toBeNull()
    // One window of node summaries ⇒ no map step, a single (fenced) reduce.
    expect(rt.calls).toBe(1)
    expect(msg!.content).toContain('Minutes body')
    // Honest whole-document coverage from the ready tree (never capped/"beginning").
    expect(msg!.coverage?.mode).toBe('tree')
    expect(msg!.coverage?.treeStatus).toBe('ready')
    expect(msg!.coverage?.truncated).toBe(false)
    expect(msg!.coverage?.chunksCovered).toBe(h.chunkIds.length)
    expect(msg!.coverage?.chunksTotal).toBe(h.chunkIds.length)
    // Leaf-chunk provenance citations (M2-safe — never the node summary), and the skill stamp.
    expect(msg!.citations && msg!.citations.length).toBe(h.chunkIds.length)
    expect(msg!.skillId).toBe(SKILL.installId)
    expect(msg!.autoFired).toBe(false)
    // The fence (its body marker) rode in the reduce user turn — the model saw the instructions.
    const reduceUser = rt.turns[0].find((t) => t.startsWith('user:')) ?? ''
    expect(reduceUser).toContain('structured minutes')
    // The node summary (the whole-document material) was in the prompt.
    expect(reduceUser).toContain('decisions made and actions assigned')
  })

  it('multi-level tree + small context: map per section then reduce, fence applied at EVERY step', async () => {
    const h = await makeDoc()
    // Three level-1 node summaries, each long enough that a small context budget splits them across
    // windows (forcing real map steps), under a level-2 root.
    const longSummary = (label: string): string => `${label}. ${'detail point '.repeat(60)}`.trim()
    const n1 = insertNode(h.db, h.docId, 1, 0, false, longSummary('Section A summary'))
    const n2 = insertNode(h.db, h.docId, 1, 1, false, longSummary('Section B summary'))
    const n3 = insertNode(h.db, h.docId, 1, 2, false, longSummary('Section C summary'))
    const root = insertNode(h.db, h.docId, 2, 0, true, 'Whole-document root summary.')
    ;[n1, n2, n3].forEach((nid, i) => {
      insertEdge(h.db, root, nid, false, i)
      h.db.prepare('UPDATE tree_nodes SET parent_id = ? WHERE id = ?').run(root, nid)
    })
    // Distribute the real leaf chunks across the three section nodes for provenance.
    h.chunkIds.forEach((cid, i) => {
      const parent = [n1, n2, n3][i % 3]
      insertEdge(h.db, parent, cid, true, i)
    })
    markTreeReady(h.db, h.docId)

    const rt = fakeRuntime()
    const msg = await answerWholeDocFromTree({
      db: h.db,
      runtime: rt,
      conversationId: h.conversationId,
      documentId: h.docId,
      question: 'write the meeting minutes',
      skill: SKILL,
      contextTokens: 900 // tiny window → the three section summaries span >1 window → map steps run
    })

    expect(msg).not.toBeNull()
    expect(msg!.coverage?.mode).toBe('tree')
    expect(msg!.coverage?.chunksCovered).toBe(h.chunkIds.length)
    // At least one map step + the reduce — more than the single-reduce case.
    expect(rt.calls).toBeGreaterThanOrEqual(2)
    // The fence rode in EVERY step: the first (a map) AND the last (the reduce).
    const firstUser = rt.turns[0].find((t) => t.startsWith('user:')) ?? ''
    const lastUser = rt.turns[rt.turns.length - 1].find((t) => t.startsWith('user:')) ?? ''
    expect(firstUser).toContain('structured minutes')
    expect(lastUser).toContain('structured minutes')
  })

  it('no ready tree → returns null (caller falls back to the capped path), no model call', async () => {
    const h = await makeDoc()
    // A tree exists structurally but tree_status is NOT 'ready' (still building) → not usable.
    const root = insertNode(h.db, h.docId, 1, 0, true, 'Partial summary.')
    h.chunkIds.forEach((cid, i) => insertEdge(h.db, root, cid, true, i))
    h.db.prepare('UPDATE documents SET tree_status = ? WHERE id = ?').run('building', h.docId)

    const rt = fakeRuntime()
    const msg = await answerWholeDocFromTree({
      db: h.db,
      runtime: rt,
      conversationId: h.conversationId,
      documentId: h.docId,
      question: 'write the meeting minutes',
      skill: SKILL,
      contextTokens: 8192
    })
    expect(msg).toBeNull()
    expect(rt.calls).toBe(0)
  })
})
