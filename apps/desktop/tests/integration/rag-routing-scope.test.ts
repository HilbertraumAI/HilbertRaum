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
import type { RuntimeChatOptions } from '../../src/main/services/runtime'
import { createConversation } from '../../src/main/services/chat'
import { updateSettings } from '../../src/main/services/settings'
import { GPU_RERANK_SCOPE } from '../../src/main/services/rag/rerank-profile'
import { resolveScope } from '../../src/main/services/collections'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { SCAN_MARKER_TYPE } from '../../src/main/services/analysis/extract'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { MEETING_PROTOCOL_INSTALL_ID } from '../../src/main/services/skills/analysis/whole-doc-skills'
import { skillInstallId } from '../../src/main/services/skills/registry'
import { t } from '../../src/shared/i18n'
import { chunkIdsOf, seedReadyTree } from '../helpers/doc-fixtures'
import { CATALOG_MANIFESTS } from '../helpers/gpu-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { scriptedRuntime, type ScriptedCall } from '../helpers/scripted-runtime'
import { writeSkillPackage } from '../helpers/skill-fixtures'
import { ingestTextFile, makeRagAskContext, makeSkillsWorld } from '../helpers/skills-world'
import { archiveCandidate, testArm } from '../helpers/zim-retrieval-fixtures'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** An instruction skill with no analysis engine: its fence shapes any answer, so the #80 classifier may
 *  offer it in a packs-only chat too. */
const PLAIN_LANGUAGE = skillInstallId('app', 'plain-language')
const MODEL_ANSWER = 'Model answer.'

/** The classifier stub: the document skill whenever the grammar admits it (#733), else the fence-only skill. */
function pickSkill(options: RuntimeChatOptions | undefined): string {
  const allowed = (options?.responseSchema as { properties: { skill: { enum: string[] } } } | undefined)?.properties.skill.enum ?? []
  return allowed.includes(MEETING_PROTOCOL_INSTALL_ID) ? MEETING_PROTOCOL_INSTALL_ID : PLAIN_LANGUAGE
}

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
  /** Model calls so far (the answer and the #80 classification each count one). */
  modelCalls: () => number
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

  const chunkIds = chunkIdsOf(w.db, notes)
  const now = new Date().toISOString()
  const record = w.db.prepare(
    `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text, normalized_value, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  record.run(randomUUID(), notes, chunkIds[0], SCAN_MARKER_TYPE, '', 'ok', 'hash-714', now)
  record.run(randomUUID(), notes, chunkIds[0], 'date', '2026-01-15', '2026-01-15', 'hash-714', now)
  seedReadyTree(w.db, notes, chunkIds, { summary: 'Summary: deadlines and greenhouse gases.' })

  const calls: ScriptedCall[] = []
  const runtime = {
    ...scriptedRuntime(
      (call) => (call.options?.responseSchemaName === 'skill_pointer' ? JSON.stringify({ skill: pickSkill(call.options) }) : MODEL_ANSWER),
      calls,
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
  return { db: w.db, notes, small, large, armCalls: () => armCalls, modelCalls: () => calls.length }
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
  // Since #736 a tree route the tree cannot answer is labelled and classified as the route without it, so a
  // miscounted tree changes the answer in one place only: one document that fits is read whole either way,
  // and the route alone decides whether the #80 classifier runs (a low-confidence route classifies,
  // `tree-summary` never does). The deep index outside the scope (`notes`), or on a document being
  // re-indexed (#736), must not count.
  it.each([
    { name: 'outside the scope', scope: () => only(h.small) },
    {
      name: 'on an in-scope document being re-indexed (#736)',
      scope: () => {
        h.db.prepare("UPDATE documents SET status = 'extracting' WHERE id = ?").run(h.notes)
        return { collectionIds: [], documentIds: [h.small, h.notes] }
      }
    }
  ])('a deep index $name: the summary-and-list ask is read whole and classified', async ({ scope }) => {
    const { msg } = await ask(scope(), SUMMARY_LIST_ASK)
    expect(msg.coverage?.mode).toBe('capped')
    expect(new Set(citedDocuments(msg))).toEqual(new Set([h.small]))
    expect(msg.skillOffer).toMatchObject({ source: 'classifier' })
  })

  // #736: two answerable documents, one with a deep index. The router picks the tree, but there is no
  // multi-document tree read, so top-k answers: it is labelled and classified as without the deep index.
  it('two documents, one with a deep index: top-k, led by the heads-up, with the classifier offer (#736)', async () => {
    const { msg } = await ask({ collectionIds: [], documentIds: [h.notes, h.large] }, SUMMARY_LIST_ASK)
    expect(msg.coverage?.mode).toBe('relevance')
    expect(msg.content.startsWith(t('en', 'analysis.partialAnswerHint'))).toBe(true)
    expect(msg.skillOffer).toMatchObject({ source: 'classifier' })
  })

  // The offered skill has no analysis engine, only a fence that shapes the pack answer, so its offer stays
  // honest with documents off (a document skill's would not: #733 below).
  it('documents off, one pack: a summary-and-list ask carries the classifier offer', async () => {
    const { msg, armCalls, noDocuments } = await ask(PACK_ONLY, SUMMARY_LIST_ASK)
    expect(noDocuments).toBe(true)
    expect(armCalls).toBe(1)
    expect(sourceKinds(msg)).toEqual(['archive'])
    expect(msg.skillOffer).toMatchObject({ installId: PLAIN_LANGUAGE, source: 'classifier' })
  })
})

// #733 — an offer must be a real capability (#133). A document skill's `intends()` reads the wording only,
// and the W2 pre-pass that makes it honest acts only on a document in scope, so with no answerable document
// the accept would re-run the same answer under the skill's stamp. A meeting ask that hits the
// meeting-protocol vocabulary; the classifier stub picks that skill whenever the grammar admits it.
describe('askDocuments — the classifier offers no document skill without an answerable document (#733)', () => {
  const MEETING_ASK = 'Fasse alle Punkte der Besprechung zusammen'

  it.each([
    { name: 'documents off, one pack', scope: () => PACK_ONLY },
    {
      name: 'a chat whose only document failed to re-index',
      scope: () => {
        h.db.prepare("UPDATE documents SET status = 'failed' WHERE id = ?").run(h.large)
        return only(h.large)
      }
    }
  ])('$name: the fence-only skill is offered, the document skill is not', async ({ scope }) => {
    const { msg } = await ask(scope(), MEETING_ASK)
    expect(msg.skillOffer).toMatchObject({ installId: PLAIN_LANGUAGE, source: 'classifier' })
  })

  // Every answer there is the fixed no-context reply, which no skill changes: no offer, and no model call.
  it('documents off, no pack: no classification, no offer', async () => {
    const calls0 = h.modelCalls()
    const { msg } = await ask(DOCUMENTS_OFF, MEETING_ASK)
    expect(msg.content).toBe(t('en', 'main.rag.noContext'))
    expect(msg.skillOffer).toBeUndefined()
    expect(h.modelCalls() - calls0).toBe(0)
  })

  it('an answerable document in scope: the document skill is offered (control)', async () => {
    const { msg } = await ask(only(h.large), MEETING_ASK)
    expect(msg.skillOffer).toMatchObject({ installId: MEETING_PROTOCOL_INSTALL_ID, source: 'classifier' })
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

// #737 — the ask site reads the reranker's demotion itself (`ctx.reranker.gpuDemoted()`, #495): the occupancy
// snapshot cannot supply it. A session whose reranker fell back to the processor must ask the pack arm for the
// capped candidate slice, not the wide GPU scope the measurement machine's card otherwise resolves.
describe('askDocuments — a demoted reranker narrows the pack arm to the capped slice (#737)', () => {
  it.each([
    { demoted: false, scope: GPU_RERANK_SCOPE },
    { demoted: true, scope: 'capped' }
  ])('reranker demoted $demoted: the arm is built for $scope', async ({ demoted, scope }) => {
    const w = makeSkillsWorld('routing-scope-rerank')
    // The measurement machine's card (RTX 3080 Ti) beside the committed 4B: the wide scope resolves.
    updateSettings(w.db, {
      gpuMode: 'auto',
      gpuAutoDisabled: false,
      gpuProbe: {
        devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }],
        probedAt: new Date().toISOString()
      }
    })
    const runtime = { ...scriptedRuntime(MODEL_ANSWER, [], { tokens: 'whole' }), modelId: 'qwen3.5-4b-ud-q4kxl' }
    const reranker = {
      id: 'reranker',
      rerank: async (_q: string, docs: string[]) => docs.map((_, index) => ({ index, score: 0 })),
      gpuDemoted: () => demoted
    }
    const seen: unknown[] = []
    const arm: ExternalRetrievalArm = async () => testArm(archiveCandidate(0, 'Methan ist ein Treibhausgas.'))
    const zim = {
      makeArm: (_db: Db, packIds: readonly string[] | null | undefined, opts?: { candidateScope?: unknown }) => {
        seen.push(opts?.candidateScope)
        return packIds?.length ? arm : null
      }
    }
    const { ctx } = makeRagAskContext(w, runtime)
    registerRagIpc({ ...ctx, manifestsDir: CATALOG_MANIFESTS, reranker, zim } as unknown as AppContext)
    const conv = createConversation(w.db, { mode: 'documents', scope: PACK_ONLY })
    await invoke(handlers, IPC.askDocuments, conv.id, 'Was ist Methan?', null)
    expect(seen).toEqual([scope])
  })
})
