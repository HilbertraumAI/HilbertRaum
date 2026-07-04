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
import {
  ANALYSIS_RESPONSE_RESERVE_TOKENS,
  appendMessage,
  CHAT_RESPONSE_RESERVE_TOKENS,
  createConversation
} from '../../src/main/services/chat'
import {
  generateGroundedAnswer,
  ragSettingsFrom,
  retrieveWholeDocument,
  wholeDocumentFitBudgetTokens
} from '../../src/main/services/rag'
import { DEFAULT_SETTINGS, type Message } from '../../src/shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import { MAX_REDUCE_CONTINUATIONS } from '../../src/main/services/rag/whole-doc-tree'

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

// Phase 2 — adaptive reduce output reserve (wholedoc-truncation-fix-plan §4). The reduce step no longer
// reserves a fixed CHAT_RESPONSE_RESERVE_TOKENS (1024); it sizes the deliverable's output cap from the
// REAL launched window so a long brief completes on a large window, while `notes + output` provably fit
// `n_ctx` at every size (no HTTP 400). The reserve is NOTES-FIRST: it yields toward the floor so the whole
// document survives a small window, truncating the notes (⇒ truncated) only when even the floor leaves no
// room. These cases capture the reduce call's runtime options to pin `maxTokens === reduceOutputCap`.

interface OptionRecordingRuntime extends ModelRuntime {
  calls: number
  turns: ChatMessage[][]
  options: Array<{ maxTokens?: number } | undefined>
}

/** Reports `ctx` as the launched window and records EVERY call's turns AND runtime options, so a test can
 *  assert the reduce received a specific `maxTokens`. `reply` sizes the map/reduce output (long ⇒ the
 *  joined notes overflow the reduce budget → the honest truncation path). */
function optionRecordingRuntime(ctx: number, reply: string): OptionRecordingRuntime {
  const rt = {
    modelId: 'mock',
    calls: 0,
    turns: [] as ChatMessage[][],
    options: [] as Array<{ maxTokens?: number } | undefined>,
    contextWindow: () => ctx,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: { maxTokens?: number }) {
      rt.calls++
      rt.turns.push(messages)
      rt.options.push(options)
      yield reply
    }
  } as unknown as OptionRecordingRuntime
  return rt
}

describe('whole-document chunk map-reduce — adaptive reduce output reserve (Phase 2)', () => {
  it('ctx 8192: a long deliverable gets the FULL desired reserve and is NOT stamped truncated', async () => {
    const h = await makeHarness(280) // over the 8 k single-read budget ⇒ multi-window map-reduce
    // Short map notes ⇒ the joined notes are tiny, so the reduce keeps the whole ANALYSIS reserve.
    const runtime = optionRecordingRuntime(8192, 'Notiz zum Abschnitt.')
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

    // Whole-document coverage survives — the long answer fit the cap, no honest-truncation badge.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    // The final REDUCE call streamed with the FULL desired analysis reserve (not the old 1024 floor).
    const reduceOptions = runtime.options[runtime.options.length - 1]
    expect(reduceOptions?.maxTokens).toBe(ANALYSIS_RESPONSE_RESERVE_TOKENS)
    expect(reduceOptions?.maxTokens).toBeGreaterThan(CHAT_RESPONSE_RESERVE_TOKENS)
  })

  it('ctx 4096: a genuinely over-cap answer floors the output and shows the honest truncated badge', async () => {
    const h = await makeHarness(280)
    // Long map notes ⇒ the joined notes exceed (context − overhead − floor-output): even the floor output
    // leaves no room, so the output sits at the floor and the notes are hard-truncated (honest coverage).
    const runtime = optionRecordingRuntime(4096, `${'Detailpunkt '.repeat(1000)}`.trim())
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

    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(true)
    // The reduce output was floored (nothing left to yield) — never below today's reserve.
    const reduceOptions = runtime.options[runtime.options.length - 1]
    expect(reduceOptions?.maxTokens).toBe(CHAT_RESPONSE_RESERVE_TOKENS)
    // The softened, honest reduce framing accompanies the truncated stamp.
    const reduceUser = userTurnOf(runtime.turns[runtime.turns.length - 1])
    expect(reduceUser).toContain('BEGINNING of the document')
  })
})

// Phase 3 — progress affordance (wholedoc-truncation-fix-plan §5). A multi-window whole-doc turn runs
// SILENT map calls before the first streamed reduce token; the shared core fires the ephemeral 'analysis'
// progress notice ("Reading the whole document…") so that gap doesn't read as a hang. It fires ONLY when
// there is a real map loop: a single-window (reduce-only) turn — and the fits-budget single read / needle
// paths, which never enter this core — must show no spurious notice.
describe('whole-document chunk map-reduce — analysis progress notice (Phase 3)', () => {
  it('fires onCompactionStart("analysis") exactly once on a multi-window (map-loop) turn', async () => {
    const h = await makeHarness(280) // over-budget, no tree ⇒ multi-window map-reduce (a real map loop)
    const runtime = recordingRuntime()
    const kinds: Array<'analysis' | undefined> = []
    appendMessage(h.db, { conversationId: h.conversationId, role: 'user', content: QUESTION })
    await generateGroundedAnswer(
      h.db,
      runtime,
      new MockEmbedder(),
      h.conversationId,
      QUESTION,
      ragSettingsFrom(DEFAULT_SETTINGS),
      { wholeDocument: { documentId: h.docId }, onCompactionStart: (kind) => kinds.push(kind) }
    )

    expect(runtime.calls).toBeGreaterThan(1) // precondition: a real map loop ran (map windows + reduce)
    expect(kinds).toEqual(['analysis']) // fired exactly once, with the analysis kind
  })

  it('does NOT fire on a single-window (reduce-only) whole-doc turn', async () => {
    const h = await makeHarness(90) // over-budget but packs into ONE window ⇒ reduce only, no silent map step
    const runtime = recordingRuntime()
    const kinds: Array<'analysis' | undefined> = []
    appendMessage(h.db, { conversationId: h.conversationId, role: 'user', content: QUESTION })
    await generateGroundedAnswer(
      h.db,
      runtime,
      new MockEmbedder(),
      h.conversationId,
      QUESTION,
      ragSettingsFrom(DEFAULT_SETTINGS),
      { wholeDocument: { documentId: h.docId }, onCompactionStart: (kind) => kinds.push(kind) }
    )

    expect(runtime.calls).toBe(1) // precondition: no map fan-out (the single call is the reduce)
    expect(kinds).toEqual([]) // no silent map window ⇒ no notice
  })
})

// Phase 4 — continue-generation for an over-cap deliverable (wholedoc-truncation-fix-plan §6). Phase 2 caps
// the reduce output to fit `n_ctx`; on a small (4 k) window a very long deliverable is still cut at the
// ceiling (`finishReason === 'length'`) and persisted mid-sentence. When a reduce pass ends 'length' (the
// model was cut off — NOT a user Stop), the shared core re-prompts to FINISH from where it stopped, appends,
// and de-duplicates the seam overlap; it is bounded by a hard cap (`MAX_REDUCE_CONTINUATIONS`), and when the
// cap is exhausted the answer carries an honest OUTPUT-truncated stamp (`Message.truncated`) — kept distinct
// from `coverage.truncated` (INPUT coverage). These cases use a SINGLE-window fixture (90 sentences) so
// chatStream call 0 IS the reduce (no map fan-out) and calls 1..N are its continuations.

interface ScriptStep {
  reply: string
  /** finish_reason fired via `options.onFinish` after yielding `reply`; omit ⇒ 'stop'. Ignored when `abort`. */
  finish?: string
  /** Throw an AbortError after yielding `reply` (a user Stop mid-stream) — fires NO finish reason (the
   *  runtime contract: an aborted request carries no final chunk). */
  abort?: boolean
}

interface FinishScriptingRuntime extends ModelRuntime {
  calls: number
  turns: ChatMessage[][]
}

/** Scripts a finish-reason + reply per chatStream call (index-aligned): a test drives continue-generation
 *  by scripting 'length' on the first reduce and 'stop'/'length'/abort on the continuations. Unlike the
 *  recording/option runtimes above, it FIRES `options.onFinish` — the signal those runtimes never send (so
 *  every Phase 1–3 case still never continues). Calls past the script reuse its LAST step (defensive). */
function finishScriptingRuntime(script: ScriptStep[]): FinishScriptingRuntime {
  const rt = {
    modelId: 'mock',
    calls: 0,
    turns: [] as ChatMessage[][],
    contextWindow: () => CTX,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const step = script[Math.min(rt.calls, script.length - 1)]
      rt.calls++
      rt.turns.push(messages)
      yield step.reply
      if (step.abort) {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      options?.onFinish?.(step.finish ?? 'stop')
    }
  } as unknown as FinishScriptingRuntime
  return rt
}

async function answerWith(h: Harness, runtime: ModelRuntime): Promise<Message> {
  appendMessage(h.db, { conversationId: h.conversationId, role: 'user', content: QUESTION })
  return (await generateGroundedAnswer(
    h.db,
    runtime,
    new MockEmbedder(),
    h.conversationId,
    QUESTION,
    ragSettingsFrom(DEFAULT_SETTINGS),
    { wholeDocument: { documentId: h.docId } }
  )) as Message
}

describe('whole-document chunk map-reduce — continue-generation for an over-cap deliverable (Phase 4)', () => {
  it('first reduce ends length, one continuation ends stop → concatenated content, >1 reduce call, no output-truncated stamp', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptingRuntime([
      { reply: 'Teil eins des Ergebnisses.', finish: 'length' },
      { reply: ' Teil zwei schließt den Bericht ab.', finish: 'stop' }
    ])
    const msg = await answerWith(h, runtime)

    expect(runtime.calls).toBe(2) // the reduce + exactly one continuation
    expect(msg.content).toBe('Teil eins des Ergebnisses. Teil zwei schließt den Bericht ab.')
    expect(msg.truncated).toBeUndefined() // the last pass ended 'stop' ⇒ NO output-truncated stamp
    expect(msg.coverage?.truncated).toBe(false) // INPUT coverage is whole-document, untouched

    // The continuation re-sends the reduce framing (notes + question) PLUS the resume instruction + anchor —
    // the model keeps full grounding at every step (§2 "fence at every step"), never a bare "continue".
    const contUser = runtime.turns[1].find((m) => m.role === 'user')?.content ?? ''
    expect(contUser).toContain('Notes (whole document)')
    expect(contUser).toContain('Continue the answer exactly from where it stops')
    expect(contUser).toContain('Teil eins des Ergebnisses.') // the anchor = the tail produced so far
  })

  it('the continuation repeats the anchor tail → the persisted content has no duplicated seam', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptingRuntime([
      { reply: 'Die Analyse beginnt hier und endet mit NAHTSTELLE', finish: 'length' },
      { reply: 'NAHTSTELLE und wird danach fortgesetzt.', finish: 'stop' }
    ])
    const msg = await answerWith(h, runtime)

    expect(runtime.calls).toBe(2)
    // The overlapping 'NAHTSTELLE' seam between the anchor tail and the continuation start is emitted ONCE.
    expect(msg.content.split('NAHTSTELLE').length - 1).toBe(1)
    expect(msg.content).toBe('Die Analyse beginnt hier und endet mit NAHTSTELLE und wird danach fortgesetzt.')
    expect(msg.truncated).toBeUndefined()
  })

  it('a runtime that returns length on every pass → exactly MAX_REDUCE_CONTINUATIONS extra passes, then an honest output-truncated stamp', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptingRuntime([
      { reply: 'Eins. ', finish: 'length' },
      { reply: 'Zwei. ', finish: 'length' },
      { reply: 'Drei. ', finish: 'length' }
    ])
    const msg = await answerWith(h, runtime)

    // Exactly one reduce + MAX_REDUCE_CONTINUATIONS continuations: the runaway cap prevents a further pass
    // even though EVERY pass reported 'length'.
    expect(runtime.calls).toBe(1 + MAX_REDUCE_CONTINUATIONS)
    expect(msg.content).toContain('Eins.')
    expect(msg.content).toContain('Zwei.')
    expect(msg.content).toContain('Drei.')
    // Continuation exhausted while still cut ⇒ the honest OUTPUT-truncation stamp (parity with single-turn)…
    expect(msg.truncated).toBe(true)
    // …but INPUT coverage is untouched: the whole document was processed, only the deliverable is cut.
    expect(msg.coverage?.truncated).toBe(false)
  })

  it('a user Stop mid-continuation persists the accumulated partial and starts no further pass', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptingRuntime([
      { reply: 'Erster vollständiger und ausführlicher Teil des Berichts.', finish: 'length' },
      { reply: ' zweiter Teil', abort: true } // a user Stop mid-continuation (no finish reason fired)
    ])
    const msg = await answerWith(h, runtime)

    // The aborted continuation's partial is folded in (seam de-duplicated), not discarded…
    expect(msg.content).toBe('Erster vollständiger und ausführlicher Teil des Berichts. zweiter Teil')
    // …and the abort started NO further pass (the reduce + the one aborted continuation only).
    expect(runtime.calls).toBe(2)
    // A user Stop is intentional, never an output overflow ⇒ no output-truncated stamp (parity with chat).
    expect(msg.truncated).toBeUndefined()
  })

  it('a first reduce that ends stop starts no continuation at all', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptingRuntime([{ reply: 'Eine vollständige Antwort.', finish: 'stop' }])
    const msg = await answerWith(h, runtime)

    expect(runtime.calls).toBe(1) // the reduce finished cleanly ⇒ zero continuation passes
    expect(msg.content).toBe('Eine vollständige Antwort.')
    expect(msg.truncated).toBeUndefined()
  })
})
