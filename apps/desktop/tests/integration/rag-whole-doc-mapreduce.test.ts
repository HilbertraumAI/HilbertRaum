import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Phase 1 — whole-document input coverage via chunk map-reduce (wholedoc-truncation-fix-plan §3).
// An over-budget `analysis: whole-doc` turn with NO deep-index tree used to be read from the BEGINNING
// only (the "gap band": too large for a single read, too small to have auto-built a tree). Now the
// `opts.wholeDocument` branch runs an on-the-fly map-reduce over the document's RAW chunks and stamps
// honest WHOLE-document coverage (`mode:'capped', truncated:false`). This suite pins, at contextTokens
// 4096 with no tree present:
//   - the coverage stamp is capped + untruncated, chunksCovered === chunksTotal,
//   - the runtime received >1 model call (map windows + reduce) on a multi-window doc,
//   - the FIRST and LAST `M####` markers of the doc reach the MAP inputs (whole-doc reach, not a prefix),
//   - an over-budget doc that packs into ONE window runs a single (reduce) call, still untruncated,
//   - a Stop before the first reduce token yields an empty message and NO capped second pass,
//   - the share-safe scan block rides in the reduce USER turn (never the system prompt).

import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { MockEmbedder } from '../../src/main/services/embeddings'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import {
  generateGroundedAnswer,
  ragSettingsFrom,
  retrieveWholeDocument,
  wholeDocumentFitBudgetTokens
} from '../../src/main/services/rag'
import { DEFAULT_SETTINGS, type Message } from '../../src/shared/types'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'

const CTX = 4096
const QUESTION = 'Fasse das gesamte Dokument zusammen: welche Entscheidungen wurden getroffen?'

/** A realistic German document: each sentence carries a unique `M####` marker so whole-doc reach (first
 *  AND last marker) is directly detectable in the map inputs. Subword-dense prose — what the budget math
 *  is sized for. One coalesced segment ⇒ the chunker produces overlapping windows (exercises de-overlap). */
function germanDoc(sentences: number): string {
  const lines: string[] = []
  for (let i = 0; i < sentences; i++) {
    const marker = `M${String(i).padStart(4, '0')}`
    lines.push(
      `${marker} Abschnitt: Der Kontostand des Geschäftskontos wurde im Berichtszeitraum sorgfältig ` +
        `geprüft, sämtliche Buchungen ordnungsgemäß erfasst und den jeweiligen Kategorien zugeordnet.`
    )
  }
  return lines.join('\n')
}

interface Harness {
  db: Db
  docId: string
  conversationId: string
}

/** Ingest a `germanDoc(sentences)` fixture and open a documents-scoped conversation. NO tree is built,
 *  so an over-budget whole-doc turn must take the Phase-1 chunk map-reduce path. */
async function makeHarness(sentences: number): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-wholedocmr-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const storeDir = documentsDir(workspacePath)
  const docPath = join(root, 'statement.txt')
  writeFileSync(docPath, germanDoc(sentences), 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: new MockEmbedder() })
  const conv = createConversation(db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds: [doc.id] }
  })
  return { db, docId: doc.id, conversationId: conv.id }
}

interface RecordingRuntime extends ModelRuntime {
  calls: number
  turns: ChatMessage[][]
}

/** Reports a 4096 window (§L0) and records EVERY call's turns (map steps + the reduce), so a test can
 *  assert the call count and inspect the map inputs — unlike the single-`lastMessages` truncation stub. */
function recordingRuntime(reply = 'Notiz zum Abschnitt.'): RecordingRuntime {
  const rt = {
    modelId: 'mock',
    calls: 0,
    turns: [] as ChatMessage[][],
    contextWindow: () => CTX,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[]) {
      rt.calls++
      rt.turns.push(messages)
      yield reply
    }
  } as unknown as RecordingRuntime
  return rt
}

/** A runtime that Stops (throws an AbortError) on its FIRST chatStream call, before yielding any token. */
function abortingRuntime(): RecordingRuntime {
  const rt = {
    modelId: 'mock',
    calls: 0,
    turns: [] as ChatMessage[][],
    contextWindow: () => CTX,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    // A generator that Stops (throws an AbortError) before yielding any token — the "before first token" case.
    async *chatStream(messages: ChatMessage[]) {
      rt.calls++
      rt.turns.push(messages)
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
  } as unknown as RecordingRuntime
  return rt
}

const userTurnOf = (turn: ChatMessage[]): string => turn.find((m) => m.role === 'user')?.content ?? ''
const systemTurnOf = (turn: ChatMessage[]): string => turn.find((m) => m.role === 'system')?.content ?? ''

describe('whole-document chunk map-reduce for an over-budget no-tree turn (Phase 1)', () => {
  it('covers the WHOLE document: capped+untruncated coverage, >1 model call, first AND last markers reach the map inputs', async () => {
    const SENTENCES = 280 // ~11 pages, well over the 4096 single-read budget → multi-window map-reduce
    const h = await makeHarness(SENTENCES)
    // Precondition: the single read truncates (so the map-reduce path is exercised), and there is no tree.
    const fit = wholeDocumentFitBudgetTokens(CTX, QUESTION, null)
    expect(retrieveWholeDocument(h.db, h.docId, fit).truncated).toBe(true)

    const runtime = recordingRuntime()
    appendMessage(h.db, { conversationId: h.conversationId, role: 'user', content: QUESTION })
    const msg = (await generateGroundedAnswer(
      h.db,
      runtime,
      new MockEmbedder(),
      h.conversationId,
      QUESTION,
      ragSettingsFrom(DEFAULT_SETTINGS),
      { wholeDocument: { documentId: h.docId } }
    )) as Message

    // Honest WHOLE-document coverage via map-reduce — never the beginning-only "PARTIAL DOCUMENT" defect.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    expect(msg.coverage?.chunksCovered).toBeGreaterThan(0)
    expect(msg.coverage?.chunksCovered).toBe(msg.coverage?.chunksTotal)
    // Representative leaf-chunk provenance (M2 — real chunks), bounded, never one-per-chunk noise.
    expect((msg.citations?.length ?? 0)).toBeGreaterThan(0)
    expect((msg.citations?.length ?? 0)).toBeLessThanOrEqual(12)

    // More than one model call: map windows + the reduce.
    expect(runtime.calls).toBeGreaterThan(1)

    // Whole-doc reach: the FIRST and LAST document markers both appear across the MAP inputs (the map
    // turns are all calls but the final reduce). A prefix-only read would miss the last marker.
    const mapText = runtime.turns.slice(0, -1).map(userTurnOf).join('\n')
    expect(mapText).toContain('M0000')
    expect(mapText).toContain(`M${String(SENTENCES - 1).padStart(4, '0')}`)

    // The final REDUCE turn is framed for the WHOLE document, and no untrusted text leaks into system.
    const reduceUser = userTurnOf(runtime.turns[runtime.turns.length - 1])
    expect(reduceUser).toContain('cover the WHOLE document')
    expect(reduceUser).toContain('Notes (whole document)')
    expect(reduceUser).not.toContain('BEGINNING of the document')
  })

  it('an over-budget doc that packs into ONE window runs a single reduce call, still untruncated', async () => {
    // Over the single-read budget (enters the map-reduce path) but small enough that the de-overlapped
    // chunks pack into one summary window ⇒ NO map step, the reduce runs directly over the whole doc.
    const h = await makeHarness(90)
    const fit = wholeDocumentFitBudgetTokens(CTX, QUESTION, null)
    expect(retrieveWholeDocument(h.db, h.docId, fit).truncated).toBe(true) // really over-budget

    const runtime = recordingRuntime()
    appendMessage(h.db, { conversationId: h.conversationId, role: 'user', content: QUESTION })
    const msg = (await generateGroundedAnswer(
      h.db,
      runtime,
      new MockEmbedder(),
      h.conversationId,
      QUESTION,
      ragSettingsFrom(DEFAULT_SETTINGS),
      { wholeDocument: { documentId: h.docId } }
    )) as Message

    expect(runtime.calls).toBe(1) // one window ⇒ reduce only, no map fan-out
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    expect(msg.coverage?.chunksCovered).toBe(msg.coverage?.chunksTotal)
    // The single call IS the reduce (whole-document framing), and it carries the raw document markers.
    const reduceUser = userTurnOf(runtime.turns[0])
    expect(reduceUser).toContain('Notes (whole document)')
    expect(reduceUser).toContain('M0000')
  })

  it('Stop before the first reduce token → empty message, NO capped second pass', async () => {
    const h = await makeHarness(90) // one-window over-budget doc ⇒ the first call IS the reduce
    const runtime = abortingRuntime()
    appendMessage(h.db, { conversationId: h.conversationId, role: 'user', content: QUESTION })
    const msg = (await generateGroundedAnswer(
      h.db,
      runtime,
      new MockEmbedder(),
      h.conversationId,
      QUESTION,
      ragSettingsFrom(DEFAULT_SETTINGS),
      { wholeDocument: { documentId: h.docId } }
    )) as Message

    // The reduce aborted before any token ⇒ an empty assistant message, no coverage stamp persisted.
    expect(msg.content).toBe('')
    expect(msg.coverage).toBeUndefined()
    // Exactly one call (the aborted reduce): the cancel did NOT trigger a second, capped grounded pass.
    expect(runtime.calls).toBe(1)
  })

  it('share-safe: the whole-document scan block rides in the reduce USER turn, never the system prompt', async () => {
    const h = await makeHarness(280) // over-budget, no tree ⇒ chunk map-reduce, PII scan requested
    const runtime = recordingRuntime()
    appendMessage(h.db, { conversationId: h.conversationId, role: 'user', content: QUESTION })
    const msg = (await generateGroundedAnswer(
      h.db,
      runtime,
      new MockEmbedder(),
      h.conversationId,
      QUESTION,
      ragSettingsFrom(DEFAULT_SETTINGS),
      { wholeDocument: { documentId: h.docId }, wholeDocumentPiiScan: true }
    )) as Message

    expect(msg.coverage?.truncated).toBe(false) // whole document analysed
    const reduceUser = userTurnOf(runtime.turns[runtime.turns.length - 1])
    // The deterministic pre-scan summary rides in the reduce user turn…
    expect(reduceUser).toContain('AUTOMATED PRE-SCAN')
    // …with NO verdict gate, since whole-document coverage legitimately allows the low-risk verdict.
    expect(reduceUser).not.toContain('MUST NOT')
    // It never appears in ANY system turn (untrusted-text class).
    for (const turn of runtime.turns) {
      expect(systemTurnOf(turn)).not.toContain('AUTOMATED PRE-SCAN')
    }
  })
})
