import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'

// #714 — the three routing helpers in `registerRagIpc.ts` count only what the chat's scope admits:
// `extractionsExistInScope` (the listing), `readyTreeCountInScope` (the tree route) and
// `allInScopeDocsFullyChunked` (the whole read and the skills' D45 refusal). Driven through the real
// `askDocuments` handler over one corpus that always holds what a helper could wrongly count — a scanned
// document, a ready deep index, a legacy (not fully chunked) document — OUTSIDE the asked scope, so a
// helper that ignored the scope changes the answer. Documents off (#301) is one scope among them. It cannot
// test the fully-chunked check: an empty scope is vacuously fully chunked, and a check that ignored the scope
// could only refuse more, so that check's rows ask in ordinary scopes.

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
import type { DocumentScope, Message } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import type { Db } from '../../src/main/services/db'
import type { ExternalRetrievalArm } from '../../src/main/services/rag'
import { createConversation } from '../../src/main/services/chat'
import { resolveScope } from '../../src/main/services/collections'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { SCAN_MARKER_TYPE } from '../../src/main/services/analysis/extract'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { MEETING_PROTOCOL_INSTALL_ID } from '../../src/main/services/skills/analysis/whole-doc-skills'
import { skillInstallId } from '../../src/main/services/skills/registry'
import { t } from '../../src/shared/i18n'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { scriptedRuntime } from '../helpers/scripted-runtime'
import { writeSkillPackage } from '../helpers/skill-fixtures'
import { ingestTextFile, makeRagAskContext, makeSkillsWorld } from '../helpers/skills-world'
import { archiveCandidate, testArm } from '../helpers/zim-retrieval-fixtures'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** An instruction skill with no analysis engine: its fence shapes any answer, so the #80 classifier may
 *  offer it in a packs-only chat too. The classifier below always picks it. */
const PLAIN_LANGUAGE = skillInstallId('app', 'plain-language')
const MODEL_ANSWER = 'Model answer.'

/** `n` numbered lines, each with a deadline and the two gases the control question asks about. */
const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `Abschnitt ${i}: Die Frist endet am 2026-0${(i % 9) + 1}-15. Methan und Lachgas.`).join('\n')

/** A typed list ask the listing serves when extract data is in scope (router step 3). */
const LIST_ASK = 'Liste alle Fristen auf'
/** A summary ask with an untyped list request: `tree-summary` with a ready tree in scope, else the #641
 *  labelled `relevance/low/partial` — the one shape whose route the tree check alone decides. */
const SUMMARY_LIST_ASK = 'Fasse alle Punkte zusammen'

interface Harness {
  db: Db
  /** `notizen.txt`: scanned (a `__scan__` marker + one date record) and a ready, usable deep index. */
  notes: string
  /** `andere.txt`: three lines, fits a whole read; nothing extracted, no tree. */
  small: string
  /** `gross.txt`: 600 lines, too large to read whole at 4,096 tokens; nothing extracted, no tree. */
  large: string
  armCalls: () => number
}

let h: Harness

async function makeHarness(): Promise<Harness> {
  const w = makeSkillsWorld('routing-scope', {
    seedApp: (dir) => {
      writeSkillPackage(dir, { id: 'meeting-protocol', kind: 'instruction' })
      writeSkillPackage(dir, { id: 'plain-language', kind: 'instruction' })
    },
    appVersion: '0.0.0-test',
    reconcile: true
  })
  const notes = await ingestTextFile(w, 'notizen.txt', lines(40))
  const small = await ingestTextFile(w, 'andere.txt', lines(3))
  const large = await ingestTextFile(w, 'gross.txt', lines(600))
  // A legacy document, in no row's scope.
  await ingestTextFile(w, 'alt.txt', lines(5), { fullyChunked: false })

  const chunkIds = (
    w.db.prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index').all(notes) as Array<{ id: string }>
  ).map((r) => r.id)
  const now = new Date().toISOString()
  const record = w.db.prepare(
    `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  record.run(randomUUID(), notes, chunkIds[0], SCAN_MARKER_TYPE, '', 'ok', 'hash-714', now)
  record.run(randomUUID(), notes, chunkIds[0], 'date', '2026-01-15', '2026-01-15', 'hash-714', now)
  w.db
    .prepare(
      `INSERT INTO tree_nodes
         (id, document_id, scope_key, level, ordinal, parent_id, is_root, summary_text,
          embedding_blob, dimensions, embedding_model_id, content_hash, model_id, created_at)
       VALUES (?, ?, NULL, 1, 0, NULL, 1, ?, NULL, NULL, NULL, ?, 'mock', ?)`
    )
    .run('root-714', notes, 'Summary: deadlines and greenhouse gases.', 'hash-root-714', now)
  const edge = w.db.prepare('INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, 1, ?)')
  chunkIds.forEach((id, i) => edge.run('root-714', id, i))
  w.db.prepare("UPDATE documents SET tree_status = 'ready' WHERE id = ?").run(notes)

  const runtime = {
    ...scriptedRuntime(
      (call) => (call.options?.responseSchemaName === 'skill_pointer' ? JSON.stringify({ skill: PLAIN_LANGUAGE }) : MODEL_ANSWER),
      [],
      { tokens: 'whole' }
    ),
    contextWindow: () => 4096
  }
  let armCalls = 0
  const arm: ExternalRetrievalArm = async () => {
    armCalls++
    return testArm(archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'))
  }
  const { ctx } = makeRagAskContext(w, runtime)
  const zim = { makeArm: (_db: Db, packIds: readonly string[] | null | undefined) => (packIds?.length ? arm : null) }
  registerBuiltinSkillAnalysisHandlers()
  registerRagIpc({ ...ctx, zim } as unknown as AppContext)
  return { db: w.db, notes, small, large, armCalls: () => armCalls }
}

const PACK_ONLY: DocumentScope = { collectionIds: [], documentIds: [], packIds: ['pack-1'], documentsOff: true }
const DOCUMENTS_OFF: DocumentScope = { collectionIds: [], documentIds: [], documentsOff: true }
const only = (documentId: string): DocumentScope => ({ collectionIds: [], documentIds: [documentId] })

async function ask(
  scope: DocumentScope,
  question: string,
  skillId: string | null = null
): Promise<{ msg: Message; armCalls: number; noDocuments: boolean }> {
  const conv = createConversation(h.db, { mode: 'documents', scope })
  const arm0 = h.armCalls()
  const { result } = await invoke(handlers, IPC.askDocuments, conv.id, question, skillId)
  return {
    msg: result as Message,
    armCalls: h.armCalls() - arm0,
    noDocuments: resolveScope(h.db, conv.id).noDocuments === true
  }
}

const sourceKinds = (msg: Message): string[] => (msg.citations ?? []).map((c) => c.sourceKind ?? 'document')
const citedDocuments = (msg: Message): Array<string | null | undefined> => (msg.citations ?? []).map((c) => c.documentId)

beforeEach(async () => {
  inFlightStreams.clear()
  h = await makeHarness()
})

describe('askDocuments — the listing needs extract data IN scope (`extractionsExistInScope`, #714)', () => {
  it('documents off, one pack: a list ask searches the pack and cites it', async () => {
    const { msg, armCalls, noDocuments } = await ask(PACK_ONLY, LIST_ASK)
    expect(noDocuments).toBe(true)
    expect(armCalls).toBe(1)
    expect(msg.content).toBe(MODEL_ANSWER)
    expect(sourceKinds(msg)).toEqual(['archive'])
  })

  it('documents off, no pack: a list ask gets the no-context answer', async () => {
    const { msg, noDocuments } = await ask(DOCUMENTS_OFF, LIST_ASK)
    expect(noDocuments).toBe(true)
    expect(msg.content).toBe(t('en', 'main.rag.noContext'))
  })

  it('a document with no extract data is answered from its text while another document has some', async () => {
    const { msg } = await ask(only(h.small), LIST_ASK)
    expect(msg.content).toBe(MODEL_ANSWER)
    expect(msg.coverage?.mode).toBe('capped')
    expect(new Set(citedDocuments(msg))).toEqual(new Set([h.small]))
  })
})

describe('askDocuments — the tree route needs a ready deep index IN scope (`readyTreeCountInScope`, #714)', () => {
  // In a documents-off chat the tree is never read either way (`wholeReadDocumentId` needs one routable
  // document). The route still decides whether the #80 classifier runs: a low-confidence route classifies,
  // `tree-summary` never does. So the offer is the one thing this check changes there. The offered skill
  // has no analysis engine, only a fence that shapes the pack answer, so its offer stays honest with
  // documents off (unlike a document skill's, whose engine needs a document in scope).
  it('documents off, one pack: a summary-and-list ask carries the classifier offer', async () => {
    const { msg, armCalls, noDocuments } = await ask(PACK_ONLY, SUMMARY_LIST_ASK)
    expect(noDocuments).toBe(true)
    expect(armCalls).toBe(1)
    expect(sourceKinds(msg)).toEqual(['archive'])
    expect(msg.skillOffer).toMatchObject({ installId: PLAIN_LANGUAGE, source: 'classifier' })
  })

  it('a large document without a deep index: the answer leads with the may-miss-items heads-up', async () => {
    const { msg } = await ask(only(h.large), SUMMARY_LIST_ASK)
    expect(msg.coverage?.mode).toBe('relevance')
    expect(msg.content.startsWith(t('en', 'analysis.partialAnswerHint'))).toBe(true)
  })
})

describe('askDocuments — a legacy document outside the scope blocks nothing (`allInScopeDocsFullyChunked`, #714)', () => {
  it('a document that fits is read whole', async () => {
    const { msg } = await ask(only(h.small), 'Was ist Methan?')
    expect(msg.coverage?.mode).toBe('capped')
    expect(new Set(citedDocuments(msg))).toEqual(new Set([h.small]))
  })

  it('a whole-document skill answers instead of refusing', async () => {
    const { msg } = await ask(only(h.small), 'Erstelle das Protokoll', MEETING_PROTOCOL_INSTALL_ID)
    expect(msg.content).toBe(MODEL_ANSWER)
    expect(msg.skillId).toBe(MEETING_PROTOCOL_INSTALL_ID)
    expect(msg.coverage?.mode).toBe('capped')
  })
})
