import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Issue #80 (wave R80) — the suggestion-only cascade through the REAL askDocuments handler:
//   - deterministic offer (P1): an aggregation-shaped `amount` ask over extract data attaches the
//     bank-statement offer with ZERO model calls (deterministic provenance wins the dedupe — the
//     classifier is never consulted);
//   - classifier offer (P3, trigger a): a NON-amount aggregation ask runs exactly ONE
//     grammar-constrained classification (D55 schema pinned on the wire) and attaches the picked
//     skill as a 'classifier'-provenance offer — the answer CONTENT is byte-identical either way;
//   - silent degrade: a prose reply (the mock-runtime class) produces the byte-identical answer
//     with NO offer;
//   - trigger b: a low-confidence fallback classifies BEFORE the grounded answer streams and the
//     offer rides the persisted message; the step-5 fallthrough NEVER classifies (0 extra calls);
//   - the offer gate: a disabled skill is out of the enum AND out of the deterministic offer.
// Faked transport (tests/helpers/ipc.ts); real temp DB + mock embedder underneath.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { createConversation, listMessages } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { reconcileSkills, setSkillEnabled } from '../../src/main/services/skills/registry'
import { SCAN_MARKER_TYPE, aggregateExtractions } from '../../src/main/services/analysis/extract'
import { buildListingAnswer } from '../../src/main/services/analysis/listing-answer'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { AppContext } from '../../src/main/services/context'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import type { Message } from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

/** One indexed document with a single chunk + mock embedding (retrieval context for `text`). */
async function seedDocument(db: Db, embedder: MockEmbedder, title: string, text: string): Promise<string> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
  const [vector] = await embedder.embed([text])
  const chunkId = randomUUID()
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
     VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, ?)`
  ).run(chunkId, docId, text, title, text.split(/\s+/).length, now)
  db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(chunkId, embedder.id, encodeVector(vector), vector.length, now)
  return docId
}

/** Plant the extract-pass rows the coverage engine reads: one ok __scan__ marker per chunk plus
 *  typed records (the whole-doc-extract #54 planted-row precedent — the pass supplies this shape). */
function plantExtraction(db: Db, docId: string, records: Array<{ type: string; value: string; normalized: string }>): void {
  const chunkId = (
    db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 1').get(docId) as { id: string }
  ).id
  const now = '2026-08-09T00:00:00.000Z'
  db.prepare(
    `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
     VALUES (?, ?, ?, ?, '', 'ok', 'hash-80', ?)`
  ).run(randomUUID(), docId, chunkId, SCAN_MARKER_TYPE, now)
  for (const r of records) {
    db.prepare(
      `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'hash-80', ?)`
    ).run(randomUUID(), docId, chunkId, r.type, r.value, r.normalized, now)
  }
}

/** Install the two app tool-skills the offers point at (real reconcile — enabled by default). */
function installSkills(db: Db): { appSkillsDir: string; userSkillsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-r80-skills-'))
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  const write = (id: string, title: string): void => {
    const dir = join(appSkillsDir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', `id: ${id}`, `title: ${title}`, `description: Test skill ${id}`, 'version: 1.0.0', '---', 'Body.'].join('\n'),
      'utf8'
    )
  }
  write('bank-statement', 'Bank Statement Analysis')
  write('invoice', 'Invoice Analysis')
  reconcileSkills(db, { appSkillsDir, userSkillsDir })
  return { appSkillsDir, userSkillsDir }
}

interface ScriptedRuntime extends ModelRuntime {
  calls: number
  options: Array<RuntimeChatOptions | undefined>
}

/** Per-call scripted replies (call 1 gets replies[0], …; past the end: a plain text answer). */
function scriptedRuntime(replies: string[]): ScriptedRuntime {
  const rt: ScriptedRuntime = {
    modelId: 'scripted',
    calls: 0,
    options: [],
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: 1 }),
    async *chatStream(_messages: ChatMessage[], options?: RuntimeChatOptions) {
      const reply = replies[rt.calls] ?? 'A grounded answer.'
      rt.calls += 1
      rt.options.push(options)
      if (options?.signal?.aborted) return
      yield reply
    }
  }
  return rt
}

function makeCtx(
  db: Db,
  workspacePath: string,
  runtime: ModelRuntime,
  skillsDirs: { appSkillsDir: string; userSkillsDir: string }
): AppContext {
  return {
    paths: { rootPath: workspacePath, workspacePath },
    get db() {
      return db
    },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    runtime: { active: () => runtime, activeModelId: () => runtime.modelId },
    embedder: createMockEmbedder(),
    reranker: null,
    ocrEngine: undefined,
    skills: { ...skillsDirs, appVersion: '0.1.55' }
  } as unknown as AppContext
}

function freshWorld(): { db: Db; workspacePath: string; skillsDirs: { appSkillsDir: string; userSkillsDir: string } } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-r80-'))
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return { db, workspacePath: join(root, 'workspace'), skillsDirs: installSkills(db) }
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

const AMOUNT_AGG_ASK = 'kategorisiere alle transaktionen und erstelle eine summe pro kategorie' // #54 verbatim
const PARTY_AGG_ASK = 'gruppiere die Parteien nach Vertrag'
const ORDINARY_ASK = 'what does the contract say about termination?'

async function ask(
  db: Db,
  workspacePath: string,
  runtime: ModelRuntime,
  skillsDirs: { appSkillsDir: string; userSkillsDir: string },
  question: string,
  docId: string
): Promise<Message> {
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
  registerRagIpc(makeCtx(db, workspacePath, runtime, skillsDirs))
  const { result } = await invoke(handlers, IPC.askDocuments, conv.id, question)
  return result as Message
}

describe('askDocuments — the #80 offer cascade', () => {
  it('deterministic offer: an amount aggregation ask attaches the bank skill at ZERO model calls', async () => {
    const { db, workspacePath, skillsDirs } = freshWorld()
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'statement.pdf', 'Zahlung 12,50 EUR an Acme.')
    plantExtraction(db, docId, [{ type: 'amount', value: '12,50 EUR', normalized: '12.50' }])
    const rt = scriptedRuntime([])

    const msg = await ask(db, workspacePath, rt, skillsDirs, AMOUNT_AGG_ASK, docId)

    expect(rt.calls).toBe(0) // deterministic provenance wins — the classifier is never consulted
    expect(msg.skillOffer).toEqual({
      installId: 'app:bank-statement',
      title: 'Bank Statement Analysis',
      source: 'deterministic'
    })
    // The offer PERSISTS (survives a reload) and the content still leads with the #54 prose hint
    // (the degradation path stays intact underneath the actionable offer).
    const stored = listMessages(db, msg.conversationId).at(-1)
    expect(stored?.skillOffer).toEqual(msg.skillOffer)
    expect(msg.content).toContain(tr('analysis.listing.aggregationHint'))
  })

  it('classifier offer (trigger a): a party aggregation ask runs ONE constrained call and offers with classifier provenance', async () => {
    const { db, workspacePath, skillsDirs } = freshWorld()
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'contract.pdf', 'Vertrag zwischen Acme und Globex.')
    plantExtraction(db, docId, [{ type: 'party', value: 'Acme', normalized: 'acme' }])
    const rt = scriptedRuntime(['{"skill":"app:invoice"}'])

    const msg = await ask(db, workspacePath, rt, skillsDirs, PARTY_AGG_ASK, docId)

    expect(rt.calls).toBe(1)
    // The wire is the D55 grammar contract: enum of gated ids + none, temp 0.
    const o = rt.options[0]
    expect(o?.responseSchemaName).toBe('skill_pointer')
    expect(o?.temperature).toBe(0)
    expect(o?.responseSchema?.properties?.skill?.enum).toEqual(['app:bank-statement', 'app:invoice', 'none'])
    expect(msg.skillOffer).toEqual({ installId: 'app:invoice', title: 'Invoice Analysis', source: 'classifier' })
    // The classification result NEVER reaches answer content — the content is exactly the
    // deterministic listing this scope produces.
    const expected = buildListingAnswer(db, aggregateExtractions(db, { collectionIds: [], documentIds: [docId] }, 'party'), tr, {
      aggregationAsk: true
    })
    expect(msg.content).toBe(expected)
    expect(listMessages(db, msg.conversationId).at(-1)?.skillOffer).toEqual(msg.skillOffer)
  })

  it('silent degrade: a prose reply (the mock-runtime class) yields the byte-identical answer with NO offer', async () => {
    const { db, workspacePath, skillsDirs } = freshWorld()
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'contract.pdf', 'Vertrag zwischen Acme und Globex.')
    plantExtraction(db, docId, [{ type: 'party', value: 'Acme', normalized: 'acme' }])
    const rt = scriptedRuntime(['I am a mock runtime and this is prose, not JSON.'])

    const msg = await ask(db, workspacePath, rt, skillsDirs, PARTY_AGG_ASK, docId)

    expect(rt.calls).toBe(1) // the one bounded attempt — no retry
    expect(msg.skillOffer).toBeUndefined()
    const expected = buildListingAnswer(db, aggregateExtractions(db, { collectionIds: [], documentIds: [docId] }, 'party'), tr, {
      aggregationAsk: true
    })
    expect(msg.content).toBe(expected) // byte-identical to today — the degrade is invisible
  })

  it('trigger (b): a low-confidence fallback classifies before the grounded answer and persists the offer', async () => {
    const { db, workspacePath, skillsDirs } = freshWorld()
    const embedder = new MockEmbedder()
    // NO extract data → the aggregation ask falls back low-confidence to relevance (+ wholeDocHint).
    const docId = await seedDocument(db, embedder, 'statement.pdf', AMOUNT_AGG_ASK)
    const rt = scriptedRuntime(['{"skill":"app:bank-statement"}', 'Here is a partial answer.'])

    const msg = await ask(db, workspacePath, rt, skillsDirs, AMOUNT_AGG_ASK, docId)

    expect(rt.calls).toBe(2) // classification + the grounded generation, in that order
    expect(rt.options[0]?.responseSchemaName).toBe('skill_pointer')
    expect(rt.options[1]?.responseSchema).toBeUndefined() // the answer stream is unconstrained
    expect(msg.skillOffer).toEqual({
      installId: 'app:bank-statement',
      title: 'Bank Statement Analysis',
      source: 'classifier'
    })
    expect(msg.content).toContain(tr('analysis.wholeDocHint')) // the #37/#38 hint still leads
    expect(listMessages(db, msg.conversationId).at(-1)?.skillOffer).toEqual(msg.skillOffer)
  })

  it('the step-5 fallthrough NEVER classifies: an ordinary question makes exactly one (unconstrained) call', async () => {
    const { db, workspacePath, skillsDirs } = freshWorld()
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'contract.pdf', ORDINARY_ASK)
    plantExtraction(db, docId, [{ type: 'party', value: 'Acme', normalized: 'acme' }]) // extract data present — still no trigger
    const rt = scriptedRuntime(['The termination clause allows 30 days notice.'])

    const msg = await ask(db, workspacePath, rt, skillsDirs, ORDINARY_ASK, docId)

    expect(rt.calls).toBe(1) // the grounded answer only — 0 classification calls by construction
    expect(rt.options[0]?.responseSchema).toBeUndefined()
    expect(msg.skillOffer).toBeUndefined()
  })

  it('the offer gate holds: a DISABLED bank skill is out of the deterministic offer AND out of the enum', async () => {
    const { db, workspacePath, skillsDirs } = freshWorld()
    setSkillEnabled(db, 'app:bank-statement', false)
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'statement.pdf', 'Zahlung 12,50 EUR an Acme.')
    plantExtraction(db, docId, [{ type: 'amount', value: '12,50 EUR', normalized: '12.50' }])
    const rt = scriptedRuntime(['{"skill":"none"}'])

    const msg = await ask(db, workspacePath, rt, skillsDirs, AMOUNT_AGG_ASK, docId)

    // No deterministic offer (gated out) → the classifier ran instead, over an enum WITHOUT the
    // disabled skill — it structurally cannot be offered.
    expect(rt.calls).toBe(1)
    expect(rt.options[0]?.responseSchema?.properties?.skill?.enum).toEqual(['app:invoice', 'none'])
    expect(msg.skillOffer).toBeUndefined()
  })
})
