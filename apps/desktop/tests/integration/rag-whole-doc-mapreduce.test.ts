import { describe, it, expect } from 'vitest'

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

import { ANALYSIS_RESPONSE_RESERVE_TOKENS, CHAT_RESPONSE_RESERVE_TOKENS, listMessages } from '../../src/main/services/chat'
import { retrieveWholeDocument, wholeDocumentFitBudgetTokens, type GroundedAnswerOptions } from '../../src/main/services/rag'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import { buildSkillFence } from '../../src/main/services/skills/prompt'
import { createRepetitionGuard } from '../../src/main/services/rag/repetition-guard'
import { continueUntilComplete } from '../../src/main/services/rag/whole-doc-tree'
import { finishScriptedRuntime, recordingRuntime, type RecordingRuntime } from '../helpers/scripted-runtime'
import {
  answerWholeDoc,
  asNoFenceMapPrompt,
  asPreRequestMapPrompt,
  germanDoc,
  masterContinuationTurn,
  WHOLE_DOC_QUESTION,
  wholeDocHarness,
  type WholeDocHarness
} from '../helpers/whole-doc-fixtures'

const CTX = 4096
/** A `germanDoc(sentences)` fixture with NO tree, so an over-budget whole-doc turn takes the chunk map-reduce. */
const makeHarness = (sentences: number): Promise<WholeDocHarness> => wholeDocHarness(germanDoc(sentences))

/** Reports `ctx` as the launched window (§L0); the shared fake records EVERY call's turns AND runtime options (map
 *  steps + the reduce), so a test can assert the call count, inspect the map inputs and pin the reduce's
 *  `maxTokens`. `reply` sizes the map/reduce output (long ⇒ the joined notes overflow the reduce budget → the
 *  honest truncation path). It never fires `onFinish`, so no Phase 1–3 case ever continues. */
const mapReduceRuntime = (reply = 'Notiz zum Abschnitt.', ctx = CTX): RecordingRuntime =>
  recordingRuntime(reply, { contextWindow: ctx })

const userTurnOf = (turn: ChatMessage[]): string => turn.find((m) => m.role === 'user')?.content ?? ''
const systemTurnOf = (turn: ChatMessage[]): string => turn.find((m) => m.role === 'system')?.content ?? ''

describe('whole-document chunk map-reduce for an over-budget no-tree turn (Phase 1)', () => {
  it('covers the WHOLE document: capped+untruncated coverage, >1 model call, first AND last markers reach the map inputs', async () => {
    const SENTENCES = 280 // ~11 pages, well over the 4096 single-read budget → multi-window map-reduce
    const h = await makeHarness(SENTENCES)
    // Precondition: the single read truncates (so the map-reduce path is exercised), and there is no tree.
    const fit = wholeDocumentFitBudgetTokens(CTX, WHOLE_DOC_QUESTION, null)
    expect(retrieveWholeDocument(h.db, h.docId, fit).truncated).toBe(true)

    const runtime = mapReduceRuntime()
    const msg = await answerWholeDoc(h, runtime)

    // Honest WHOLE-document coverage via map-reduce — never the beginning-only "PARTIAL DOCUMENT" defect.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    expect(msg.coverage?.chunksCovered).toBeGreaterThan(0)
    expect(msg.coverage?.chunksCovered).toBe(msg.coverage?.chunksTotal)
    // #643: the model saw section notes, never [Sn] labels — these citations stay provenance.
    expect(msg.coverage?.labelledExcerpts).toBeUndefined()
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

  // #939 (owner call 2026-11-20): the map step used to see the skill's task and never the user's request, so a
  // list-all question under a whole-document skill was answered from notes taken for the skill's deliverable. With
  // `wholeDocumentNotesForRequest` (set by registerRagIpc for a list-shaped question under a bundled skill) every map
  // call carries the request under the reduce's label, before the fence, and keeps the task; without it every map
  // call is the prompt as it was.
  it.each([{ notesForRequest: true }, { notesForRequest: false }])(
    'with the request flag $notesForRequest, the map calls carry the user request or are the prompt as it was (#939)',
    async ({ notesForRequest }) => {
      const h = await makeHarness(280)
      const runtime = mapReduceRuntime()
      const question = "Find every mention of 'Kategorien'"
      const skill = { installId: 'app:contract-brief', title: 'Contract Brief', body: '# Contract brief\nList the parties and the risks.' }
      await answerWholeDoc(h, runtime, { skill, wholeDocumentNotesForRequest: notesForRequest }, question)
      expect(runtime.calls).toBeGreaterThan(2)
      const maps = runtime.turns.slice(0, -1).map(userTurnOf)
      for (const map of maps) {
        expect(map).toContain('List the parties and the risks.')
        if (notesForRequest) {
          expect(map).toContain(`\nUser request:\n${question}\n`)
          expect(map.indexOf('User request:')).toBeLessThan(map.indexOf('List the parties and the risks.'))
          expect(map).toContain('note every detail the task needs')
        } else {
          expect(map).not.toContain('User request:')
          expect(map).toBe(asPreRequestMapPrompt(map, buildSkillFence({ title: skill.title, body: skill.body }).text))
        }
      }
      // The reduce carried the request before #939 already, either way.
      const reduceUser = userTurnOf(runtime.turns[runtime.turns.length - 1])
      expect(reduceUser).toContain(`User request:\n${question}\n`)
    }
  )

  it('an over-budget doc that packs into ONE window runs a single reduce call, still untruncated', async () => {
    // Over the single-read budget (enters the map-reduce path) but small enough that the de-overlapped
    // chunks pack into one summary window ⇒ NO map step, the reduce runs directly over the whole doc.
    const h = await makeHarness(90)
    const fit = wholeDocumentFitBudgetTokens(CTX, WHOLE_DOC_QUESTION, null)
    expect(retrieveWholeDocument(h.db, h.docId, fit).truncated).toBe(true) // really over-budget

    const runtime = mapReduceRuntime()
    const msg = await answerWholeDoc(h, runtime)

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
    const runtime = finishScriptedRuntime([{ reply: '', abort: true }], CTX) // a Stop before any token
    const msg = await answerWholeDoc(h, runtime)

    // The reduce aborted before any token ⇒ an empty assistant message, no coverage stamp persisted.
    expect(msg.content).toBe('')
    expect(msg.coverage).toBeUndefined()
    // Exactly one call (the aborted reduce): the cancel did NOT trigger a second, capped grounded pass.
    expect(runtime.calls).toBe(1)
  })

  it('share-safe: the whole-document scan block rides in the reduce USER turn, never the system prompt', async () => {
    const h = await makeHarness(280) // over-budget, no tree ⇒ chunk map-reduce, PII scan requested
    const runtime = mapReduceRuntime()
    const msg = await answerWholeDoc(h, runtime, { wholeDocumentPiiScan: true })

    expect(msg.coverage?.truncated).toBe(false) // whole document analysed
    const reduceUser = userTurnOf(runtime.turns[runtime.turns.length - 1])
    // The deterministic pre-scan summary (its counts, not just the heading) rides in the reduce user turn…
    expect(reduceUser).toContain('AUTOMATED PRE-SCAN')
    expect(reduceUser).toContain('payment-card numbers:')
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

describe('whole-document chunk map-reduce — adaptive reduce output reserve (Phase 2)', () => {
  it('ctx 8192: a long deliverable gets the FULL desired reserve and is NOT stamped truncated', async () => {
    const h = await makeHarness(280) // over the 8 k single-read budget ⇒ multi-window map-reduce
    // Short map notes ⇒ the joined notes are tiny, so the reduce keeps the whole ANALYSIS reserve.
    const runtime = mapReduceRuntime('Notiz zum Abschnitt.', 8192)
    const msg = await answerWholeDoc(h, runtime)

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
    const runtime = mapReduceRuntime(`${'Detailpunkt '.repeat(1000)}`.trim(), 4096)
    const msg = await answerWholeDoc(h, runtime)

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

// #996 A (follow-ups wave 7, owner call G-7): the reduce prompt above asks the model to say that its answer covers
// only the beginning, and a 4B model never did (0 of 8 such answers in wave 6). So an answer whose notes had to be
// cut leads with the app's own line (design-guidelines §11.25), after the scope notice and the sum hint
// (`answerPrefix`). It rides the first reduce token, so it never streams or persists without model text, and every
// prompt stays byte for byte as it was. The IPC rows (registerRagIpc sets the line) are in rag-skill-analysis.test.ts
// and rag-whole-read.test.ts; the tree path's in rag-whole-doc-tree.test.ts.
describe('whole-document chunk map-reduce — the beginning-only line (#996 A)', () => {
  const PREFIX = 'Scope notice.\n\nSum hint.\n\n'
  const LINE = '**Heads-up:** this answer covers only the beginning.'
  // Long map notes overflow the reduce budget at 4096 (the floored case above), so the notes are cut.
  const LONG_NOTE = `${'Detailpunkt '.repeat(1000)}`.trim()

  /** Map and fold calls yield `note`; the reduce (its user turn ends "Answer:") yields `reduceReply`, or a user
   *  Stop before its first token when `reduceReply` is null. */
  function reduceScriptRuntime(note: string, reduceReply: string | null): ModelRuntime & { reduceCalls: number } {
    const rt = {
      modelId: 'mock',
      reduceCalls: 0,
      contextWindow: () => CTX,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      async *chatStream(messages: ChatMessage[]) {
        if (!userTurnOf(messages).endsWith('\n\nAnswer:')) {
          yield note
          return
        }
        rt.reduceCalls++
        if (reduceReply === null) {
          const err = new Error('aborted')
          err.name = 'AbortError'
          throw err
        }
        yield reduceReply
      }
    }
    return rt
  }

  async function run(runtime: ModelRuntime, extra: GroundedAnswerOptions) {
    const h = await makeHarness(280)
    const tokens: string[] = []
    const msg = await answerWholeDoc(h, runtime, { onToken: (token) => tokens.push(token), ...extra })
    const assistantRows = listMessages(h.db, h.conversationId).filter((m) => m.role === 'assistant')
    return { tokens, msg, assistantRows }
  }

  it('a cut document: the line follows the prefix, rides the first reduce token, and is persisted', async () => {
    const { tokens, msg } = await run(mapReduceRuntime(LONG_NOTE), { answerPrefix: PREFIX, beginningNotice: LINE })
    expect(msg.coverage?.truncated).toBe(true) // precondition: the notes were cut
    expect(tokens).toEqual([PREFIX, `${LINE}\n\n${LONG_NOTE}`])
    expect(msg.content).toBe(`${PREFIX}${LINE}\n\n${LONG_NOTE}`)
  })

  it('a cut document: every model call is byte for byte the one made without the line', async () => {
    const withLine = mapReduceRuntime(LONG_NOTE)
    const without = mapReduceRuntime(LONG_NOTE)
    await run(withLine, { answerPrefix: PREFIX, beginningNotice: LINE })
    const plain = await run(without, { answerPrefix: PREFIX })
    expect(withLine.calls).toBeGreaterThan(1) // map steps + the reduce
    expect(withLine.turns).toEqual(without.turns)
    expect(withLine.options.map((o) => o?.maxTokens)).toEqual(without.options.map((o) => o?.maxTokens))
    expect(plain.msg.content).toBe(`${PREFIX}${LONG_NOTE}`) // without the input, the answer is as before
  })

  it('a whole document: no line, even with one passed in', async () => {
    const { tokens, msg } = await run(mapReduceRuntime('Notiz zum Abschnitt.', 8192), { answerPrefix: PREFIX, beginningNotice: LINE })
    expect(msg.coverage?.truncated).toBe(false) // precondition: the whole document was read
    expect(tokens).toEqual([PREFIX, 'Notiz zum Abschnitt.'])
    expect(msg.content).toBe(`${PREFIX}Notiz zum Abschnitt.`)
  })

  it('a Stop before the first reduce token on a cut document streams no line and persists nothing', async () => {
    const runtime = reduceScriptRuntime(LONG_NOTE, null)
    const { tokens, msg, assistantRows } = await run(runtime, { answerPrefix: PREFIX, beginningNotice: LINE })
    expect(runtime.reduceCalls).toBe(1) // the map steps ran; the Stop came at the reduce
    expect(tokens).toEqual([PREFIX]) // the prefix streams before the map steps, as before; the line never does
    expect(msg.content).toBe('')
    expect(msg.coverage).toBeUndefined()
    expect(assistantRows).toHaveLength(0)
  })

  it('a think-only reduce reply on a cut document persists nothing: the line alone is no answer', async () => {
    const runtime = reduceScriptRuntime(LONG_NOTE, '<think>weighing the notes</think>')
    const { msg, assistantRows } = await run(runtime, { beginningNotice: LINE })
    expect(runtime.reduceCalls).toBe(1)
    expect(msg.content).toBe('')
    expect(assistantRows).toHaveLength(0)
  })

  /** Map and fold calls yield `note`; the reduce and its continuations (user turns ending "Answer:" or
   *  "Continuation:") take `steps` in order. Each yields its reply (nothing when empty: a pass a thinking model
   *  spent reasoning) and fires its finish reason; `stepTurns` records their user turns. */
  function reduceStepsRuntime(note: string, steps: Array<{ reply: string; finish: string }>): ModelRuntime & { stepTurns: string[] } {
    const rt = {
      modelId: 'mock',
      stepTurns: [] as string[],
      contextWindow: () => CTX,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
        const user = userTurnOf(messages)
        if (!user.endsWith('\n\nAnswer:') && !user.endsWith('\n\nContinuation:')) {
          yield note
          return
        }
        const step = steps[Math.min(rt.stepTurns.length, steps.length - 1)]!
        rt.stepTurns.push(user)
        if (step.reply) yield step.reply
        options?.onFinish?.(step.finish)
      }
    }
    return rt
  }

  // Code review round 2: a reduce that writes no text (its reasoning fills the cap, finish 'length') used to drop
  // the line, because only the reduce loop carried it; the continuation then wrote the whole answer without it.
  it('a cut document whose reduce wrote no text still leads with the line, on the first continuation text', async () => {
    const runtime = reduceStepsRuntime(LONG_NOTE, [
      { reply: '', finish: 'length' },
      { reply: 'Antwort aus der Fortsetzung.', finish: 'stop' }
    ])
    const { tokens, msg } = await run(runtime, { answerPrefix: PREFIX, beginningNotice: LINE })
    expect(runtime.stepTurns).toHaveLength(2) // the reduce and one continuation
    expect(msg.coverage?.truncated).toBe(true)
    expect(tokens).toEqual([PREFIX, `${LINE}\n\nAntwort aus der Fortsetzung.`])
    expect(msg.content).toBe(`${PREFIX}${LINE}\n\nAntwort aus der Fortsetzung.`)
    // The continuation's prompt is the one it gets without the line: its anchor holds only the prefix.
    expect(runtime.stepTurns[1]).not.toContain(LINE)
    expect(runtime.stepTurns[1].endsWith(`${PREFIX}\n\nContinuation:`)).toBe(true)
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
    const runtime = mapReduceRuntime()
    const kinds: Array<'analysis' | undefined> = []
    await answerWholeDoc(h, runtime, { onCompactionStart: (kind) => kinds.push(kind) })

    expect(runtime.calls).toBeGreaterThan(1) // precondition: a real map loop ran (map windows + reduce)
    expect(kinds).toEqual(['analysis']) // fired exactly once, with the analysis kind
  })

  it('does NOT fire on a single-window (reduce-only) whole-doc turn', async () => {
    const h = await makeHarness(90) // over-budget but packs into ONE window ⇒ reduce only, no silent map step
    const runtime = mapReduceRuntime()
    const kinds: Array<'analysis' | undefined> = []
    await answerWholeDoc(h, runtime, { onCompactionStart: (kind) => kinds.push(kind) })

    expect(runtime.calls).toBe(1) // precondition: no map fan-out (the single call is the reduce)
    expect(kinds).toEqual([]) // no silent map window ⇒ no notice
  })
})

// Phase 4 — continue-generation for an over-cap deliverable (wholedoc-truncation-fix-plan §6). Phase 2 caps
// the reduce output to fit `n_ctx`; on a small (4 k) window a very long deliverable is still cut at the
// ceiling (`finishReason === 'length'`) and persisted mid-sentence. When a reduce pass ends 'length' (the
// model was cut off — NOT a user Stop), the shared core re-prompts to FINISH from where it stopped, appends
// (the shared engine's seam de-dup is pinned in rag.test.ts); it is bounded by a hard cap (`MAX_REDUCE_CONTINUATIONS`), and when the
// cap is exhausted the answer carries an honest OUTPUT-truncated stamp (`Message.truncated`) — kept distinct
// from `coverage.truncated` (INPUT coverage). These cases use a SINGLE-window fixture (90 sentences) so
// chatStream call 0 IS the reduce (no map fan-out) and calls 1..N are its continuations; `finishScriptedRuntime`
// scripts each pass's reply + finish reason ('length' on the first reduce, 'stop'/'length'/abort after).

describe('whole-document chunk map-reduce — continue-generation for an over-cap deliverable (Phase 4)', () => {
  it('first reduce ends length, one continuation ends stop → concatenated content, >1 reduce call, no output-truncated stamp', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptedRuntime([
      { reply: 'Teil eins des Ergebnisses.', finish: 'length' },
      { reply: ' Teil zwei schließt den Bericht ab.', finish: 'stop' }
    ], CTX)
    const msg = await answerWholeDoc(h, runtime)

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

  it('a runtime that returns length on every pass → exactly 2 extra passes, then an honest output-truncated stamp', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptedRuntime([
      { reply: 'Eins. ', finish: 'length' },
      { reply: 'Zwei. ', finish: 'length' },
      { reply: 'Drei. ', finish: 'length' }
    ], CTX)
    const msg = await answerWholeDoc(h, runtime)

    // Exactly one reduce + 2 continuations: the runaway cap prevents a further pass even though EVERY pass
    // reported 'length'. A literal, not MAX_REDUCE_CONTINUATIONS, so raising the documented cap goes red (#737).
    expect(runtime.calls).toBe(3)
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
    const runtime = finishScriptedRuntime([
      { reply: 'Erster vollständiger und ausführlicher Teil des Berichts.', finish: 'length' },
      { reply: ' zweiter Teil', abort: true } // a user Stop mid-continuation (no finish reason fired)
    ], CTX)
    const msg = await answerWholeDoc(h, runtime)

    // The aborted continuation's partial is folded in (seam de-duplicated), not discarded…
    expect(msg.content).toBe('Erster vollständiger und ausführlicher Teil des Berichts. zweiter Teil')
    // …and the abort started NO further pass (the reduce + the one aborted continuation only).
    expect(runtime.calls).toBe(2)
    // A user Stop is intentional, never an output overflow ⇒ no output-truncated stamp (parity with chat).
    expect(msg.truncated).toBeUndefined()
  })

  it('a first reduce that ends stop starts no continuation at all', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptedRuntime([{ reply: 'Eine vollständige Antwort.', finish: 'stop' }], CTX)
    const msg = await answerWholeDoc(h, runtime)

    expect(runtime.calls).toBe(1) // the reduce finished cleanly ⇒ zero continuation passes
    expect(msg.content).toBe('Eine vollständige Antwort.')
    expect(msg.truncated).toBeUndefined()
  })

  // #996 B (follow-ups wave 7): the stamp read only the LAST pass's finish reason, so a cut reduce whose
  // continuation ended 'stop' in the middle of a sentence was stored as complete. The real case (wave 6, 4B
  // Contract Brief): 22 long items ending with a full stop, then "… unless the lease provides otherwise or".
  const items = Array.from(
    { length: 22 },
    (_, i) => `- Clause ${i + 1}: the tenant keeps the premises in good repair and returns them clean.`
  ).join('\n')
  const cutItem = '- Costs: the costs incurred by a party in connection with these provisions are borne by that party'

  it('#996 B: a continuation that ends stop mid-sentence is stamped cut, with the cause of the pass that was cut', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptedRuntime([
      { reply: `${items}\n${cutItem}`, finish: 'length' },
      { reply: ' unless the lease provides otherwise or', finish: 'stop' }
    ], CTX)
    const msg = await answerWholeDoc(h, runtime)

    expect(runtime.calls).toBe(2) // the reduce + one continuation, which ended 'stop'
    expect(msg.content.endsWith(`${cutItem} unless the lease provides otherwise or`)).toBe(true)
    expect(msg.truncated).toBe(true)
    // The reduce reached its own cap (no timings ⇒ the cap fired), so the remedy is "ask it to continue".
    expect(msg.truncatedCause).toBe('cap')
    expect(msg.coverage?.truncated).toBe(false) // INPUT coverage is untouched
  })

  it('#996 B: a first reduce that ends stop mid-sentence is not judged: no continuation ran, no stamp', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptedRuntime([{ reply: `${items}\n${cutItem} unless`, finish: 'stop' }], CTX)
    const msg = await answerWholeDoc(h, runtime)

    expect(runtime.calls).toBe(1)
    expect(msg.content.endsWith(`${cutItem} unless`)).toBe(true)
    expect(msg.truncated).toBeUndefined()
  })

  it('#996 B: a user Stop mid-continuation is never judged, even when the answer stops mid-sentence', async () => {
    const h = await makeHarness(90)
    const runtime = finishScriptedRuntime([
      { reply: `${items}\n${cutItem}`, finish: 'length' },
      { reply: ' unless the lease provides otherwise or', abort: true }
    ], CTX)
    const msg = await answerWholeDoc(h, runtime)

    expect(runtime.calls).toBe(2)
    expect(msg.content.endsWith(`${cutItem} unless the lease provides otherwise or`)).toBe(true)
    expect(msg.truncated).toBeUndefined() // a Stop is the user's choice, not a cut
  })
})

// #994 (follow-ups wave 7, owner calls G-3, G-4, G-5): at temperature 0.3 a small model can write one table row or
// one list line over and over until its output cap and every continuation are used up (20–38k characters, 67–435 s).
// The whole-document engine now watches the text it streams for the same line six times in a row
// (rag/repetition-guard.ts, unit rows in tests/unit/repetition-guard.test.ts). On a trip the pass is stopped (the
// consumer leaves the stream, which cancels the request), the answer is cut back to before its repeated tail and ends
// there with the cut stamp, cause 'repeat' (B1: in the GPU session the one continuation B2 allowed restarted the loop
// in 3 of 3 runs). A map or fold note that loops is stopped and keeps one copy. A turn the guard never trips sends
// every request as before.
describe('whole-document chunk map-reduce — the repetition guard (#994)', () => {
  type Ending = 'complete' | 'left'
  interface LineRuntime extends ModelRuntime {
    turns: ChatMessage[][]
    options: Array<RuntimeChatOptions | undefined>
    /** Per call: the stream ran to its end ('complete'), or its consumer left it early ('left': the cancel). */
    endings: Ending[]
  }
  /** Map and fold calls stream `note(i)` (i counts the map and fold calls); the reduce and its continuations (user
   *  turns ending "Answer:" or "Continuation:") take `steps` in order, the last one reused. Every reply streams one
   *  line per token, and a step's finish reason fires after its last line (never when the consumer left). */
  function lineRuntime(note: (i: number) => string, steps: Array<{ reply: string; finish: string }>, ctx = CTX): LineRuntime {
    let maps = 0
    let stepAt = 0
    const rt: LineRuntime = {
      modelId: 'mock',
      turns: [],
      options: [],
      endings: [],
      contextWindow: () => ctx,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
        const at = rt.turns.push(messages) - 1
        rt.options.push(options)
        rt.endings.push('left')
        const user = userTurnOf(messages)
        const isStep = user.endsWith('\n\nAnswer:') || user.endsWith('\n\nContinuation:')
        const reply = isStep ? steps[Math.min(stepAt, steps.length - 1)]!.reply : note(maps++)
        const finish = isStep ? steps[Math.min(stepAt++, steps.length - 1)]!.finish : null
        for (const line of reply.match(/[^\n]*\n|[^\n]+$/g) ?? []) yield line
        if (finish !== null) options?.onFinish?.(finish)
        rt.endings[at] = 'complete'
      }
    }
    return rt
  }
  const lines = (...ls: string[]): string => ls.map((l) => `${l}\n`).join('')
  const times = (n: number, f: (i: number) => string): string[] => Array.from({ length: n }, (_, i) => f(i))
  const HEADER = ['## 1. Important deadlines', '', '| # | Deadline | What happens |', '|---|---|---|']
  const FIRST = '| 1 | 31 December 2030 | Notice of termination must reach the landlord in writing |'
  /** The looping row, written the same way each time (rows that count up a number are different lines, #994 round 3). */
  const ROW = '| 14 days of the request | Party requesting consent must be told about reasonable conditions |'
  const LOOP = (): string => ROW
  const LATER = '| 10 | 1 March 2031 | The deposit is paid back within eight weeks of the handover |'
  /** The reduce's text up to the first copy of the looping row: what the guard keeps of a looping reduce. */
  const KEPT = lines(...HEADER, FIRST, ROW)
  const LOOPING = lines(...HEADER, FIRST, ...times(9, LOOP))

  async function ask(runtime: ModelRuntime, sentences = 90) {
    const h = await makeHarness(sentences) // 90: one window, so call 0 is the reduce; 280: a real map step
    const tokens: string[] = []
    const msg = await answerWholeDoc(h, runtime, { onToken: (token) => tokens.push(token) })
    return { msg, streamed: tokens.join('') }
  }

  it('a reduce that starts repeating a row is stopped at the sixth copy, cut back to one copy and stamped "repeat"', async () => {
    const runtime = lineRuntime(() => 'Notiz.', [
      { reply: LOOPING, finish: 'length' },
      { reply: lines(LATER), finish: 'stop' }
    ])
    const { msg, streamed } = await ask(runtime)

    // The reduce stream was left at the sixth copy (the live bubble showed the loop up to there and no further).
    expect(runtime.endings).toEqual(['left'])
    expect(streamed.split(ROW).length - 1).toBe(6)
    // Nothing continues it (B1), although the pass would have been cut at its ceiling and a continuation was left.
    expect(runtime.turns).toHaveLength(1)
    expect(msg.content).toBe(KEPT)
    expect(msg.truncated).toBe(true)
    expect(msg.truncatedCause).toBe('repeat')
    expect(msg.coverage?.truncated).toBe(false) // INPUT coverage is untouched
  })

  it('a continuation that starts repeating is stopped and cut back too, and no further pass runs', async () => {
    const runtime = lineRuntime(() => 'Notiz.', [
      { reply: lines(...HEADER, FIRST), finish: 'length' },
      { reply: lines(LATER, ...times(9, LOOP)), finish: 'length' },
      { reply: lines('This pass must never run.'), finish: 'stop' }
    ])
    const { msg } = await ask(runtime)

    expect(runtime.endings).toEqual(['complete', 'left'])
    expect(runtime.turns).toHaveLength(2) // one continuation was still left: the trip ends the answer anyway
    expect(msg.content).toBe(lines(...HEADER, FIRST, LATER, ROW))
    expect(msg.truncated).toBe(true)
    expect(msg.truncatedCause).toBe('repeat')
  })

  // Code review round 5: a looping wholly bold line used to be cut back to nothing (read as an empty heading), so the
  // turn the user had watched stream was not stored at all.
  it('a reduce that loops on a bold line keeps its first copy and is stored, stamped "repeat"', async () => {
    const bold = '**Clause 4.2: Tenant must give notice within fourteen days**'
    const runtime = lineRuntime(() => 'Notiz.', [{ reply: lines('## Deadlines', '', ...times(9, () => bold)), finish: 'length' }])
    const { msg } = await ask(runtime)

    expect(runtime.endings).toEqual(['left'])
    expect(msg.content).toBe(lines('## Deadlines', '', bold))
    expect(msg.truncatedCause).toBe('repeat')
  })

  // Code review round 5: a Stop while a continuation's opening is still held back for the seam check flushes it in
  // the engine's finally; that flush can complete a run, and the stored partial is cut back like any trip.
  it('a Stop that flushes a looping continuation opening stores one copy of the loop, unstamped', async () => {
    const first = lines(
      'The tenant pays the rent on the third working day of every month.',
      'The deposit equals three months of the net rent and is held by the landlord.',
      'The lease runs for five years and can be renewed once for three more years.'
    )
    const row = '- The tenant pays rent monthly'
    const runtime = finishScriptedRuntime([
      { reply: first, finish: 'length' },
      { reply: lines(...times(6, () => row)), abort: true }
    ], CTX)
    const msg = await answerWholeDoc(await makeHarness(90), runtime)

    expect(runtime.calls).toBe(2)
    expect(msg.content).toBe(first + lines(row))
    expect(msg.truncated).toBeUndefined() // the user stopped it
  })

  it('a trip on the last pass left ends the answer with the cut stamp, cause "repeat"', async () => {
    const runtime = lineRuntime(() => 'Notiz.', [
      { reply: lines(...HEADER, FIRST), finish: 'length' },
      { reply: lines(LATER), finish: 'length' },
      { reply: lines(...times(9, LOOP)), finish: 'length' }
    ])
    const { msg } = await ask(runtime)

    expect(runtime.endings).toEqual(['complete', 'complete', 'left'])
    expect(msg.content).toBe(lines(...HEADER, FIRST, LATER, ROW))
    expect(msg.truncated).toBe(true)
    expect(msg.truncatedCause).toBe('repeat')
  })

  // Accepted escape (known-limitations.md, rag-design.md §14.10.2): the heading rules evaluated for the Meeting Minutes
  // recursion each stopped answers about several entities, so a report that restarts itself runs on as before.
  it('a report that restarts its own sections is not stopped (the minutes recursion, an accepted escape)', async () => {
    const minutes = lines(
      '## Meeting details',
      'Date: Monday, 20 April 2026, 10:00 in the harbour office',
      '## Decisions',
      '- The board approves the new parking rules for the delivery yard from 1 June',
      '## Formal minutes version'
    )
    const runtime = lineRuntime(() => 'Notiz.', [{ reply: minutes + minutes + minutes + minutes, finish: 'stop' }])
    const { msg } = await ask(runtime)

    expect(runtime.endings).toEqual(['complete'])
    expect(msg.content).toBe(minutes + minutes + minutes + minutes)
    expect(msg.truncated).toBeUndefined()
  })

  it('a map note that loops is stopped and keeps one copy; the reduce reads that one copy', async () => {
    const loopNote = lines('- Consent for subletting: 14 days after the request (Article 25.3)', ...times(12, () => '- Within 14 days of the request the landlord states reasonable conditions'))
    const runtime = lineRuntime((i) => (i === 0 ? loopNote : `Notiz ${i}: keine Frist in diesem Teil.`), [
      { reply: 'Antwort.', finish: 'stop' }
    ])
    await ask(runtime, 280)

    const reduceAt = runtime.turns.length - 1
    expect(reduceAt).toBeGreaterThan(1) // a real map step ran
    expect(runtime.endings[0]).toBe('left') // the looping note's call was stopped
    expect(runtime.endings.slice(1)).toEqual(Array(reduceAt).fill('complete'))
    const reduceUser = userTurnOf(runtime.turns[reduceAt])
    expect(reduceUser.split('Within 14 days of the request').length - 1).toBe(1)
    expect(reduceUser).toContain('- Consent for subletting: 14 days after the request (Article 25.3)\n')
  })

  // Rows that differ only in their numbers and dates are real content, not a loop: an instalment schedule, or one
  // clause the document repeats in many articles (#978's lease). The guard compares lines exactly, so neither the
  // note nor the answer is stopped.
  it('a 36-row instalment schedule and 30 per-article rows are never stopped, in a note or in the answer', async () => {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const schedule = lines(...times(36, (i) => `- Instalment ${i + 1} of EUR 1,200 is due on 1 ${months[i % 12]} ${2026 + Math.floor(i / 12)}.`))
    const perArticle = lines(...times(30, (i) => `- within fourteen days of the request (Article ${i + 3}.3)`))
    const runtime = lineRuntime((i) => (i === 0 ? perArticle : `Notiz ${i}.`), [{ reply: schedule, finish: 'stop' }])
    const { msg } = await ask(runtime, 280)

    expect(runtime.endings.every((e) => e === 'complete')).toBe(true)
    expect(userTurnOf(runtime.turns[runtime.turns.length - 1])).toContain(perArticle.trim())
    expect(msg.content).toBe(schedule)
    expect(msg.truncated).toBeUndefined()
  })

  // #994 round 3 (an independent review): answers about several entities reuse sub-headings, labels and row text per
  // entity. None of them is a loop: each is stored as written, unstamped.
  it.each([
    {
      name: 'a portfolio brief with the same ### sub-headings under each lease',
      reply: ['A', 'B', 'C', 'D'].map((n) => `## Lease ${n}\n\n### Parties\n- Landlord: Hausverwaltung ${n} GmbH\n- Tenant: Mieter ${n} AG\n\n### Key dates\n- Start: 1 January 202${n.charCodeAt(0) - 64}\n\n`).join('')
    },
    {
      name: 'a portfolio brief with the same bold labels under each lease',
      reply: ['A', 'B', 'C', 'D'].map((n) => `**Lease ${n}**\n\n**Parties**\nLandlord ${n} GmbH and Tenant ${n} AG\n\n**Termination**\nSix months, first possible on 30 June 203${n.charCodeAt(0) - 64}\n\n`).join('')
    },
    {
      name: 'ten leases whose rows differ only in their number',
      reply: lines('| Lease | Tenant | Notice |', '|---|---|---|', ...times(10, (i) => `| ${i + 1} | Not stated | Written notice three months before the end of term |`))
    },
    {
      name: 'a year table',
      reply: lines('| Year | Obligation |', '|---|---|', ...times(8, (i) => `| ${2024 + i} | Pay the annual service charge adjustment |`))
    }
  ])('$name is never stopped', async ({ reply }) => {
    const runtime = lineRuntime(() => 'Notiz.', [{ reply, finish: 'stop' }])
    const { msg } = await ask(runtime)
    expect(runtime.endings).toEqual(['complete'])
    expect(msg.content).toBe(reply)
    expect(msg.truncated).toBeUndefined()
  })

  // No trip, no change: the guard only reads. A whole turn whose answer comes close to every threshold (five
  // identical rows in a row, thirty rows that differ only in numbers, every heading twice) sends master's map
  // prompts with master's options, hands the reduce every note verbatim, continues with master's continuation turn,
  // and stores the text the model wrote.
  it('a turn the guard never trips sends every request byte for byte as master does', async () => {
    const nearNote = (i: number): string =>
      lines(
        `**Deadlines ${i + 1}**`,
        ...times(5, (j) => `- Within ${14 + j} days of request ${i + 1} the landlord states reasonable conditions`),
        `**Deadlines ${i + 1}**`
      )
    const reduceReply = lines(...HEADER, ...times(5, LOOP), ...times(30, (i) => `| ${i + 7} | 14 days of the request | Consent for subletting, Article ${20 + i}.3 |`))
    const contReply = lines(...HEADER, FIRST, 'These are all the deadlines in the document.')
    const runtime = lineRuntime(nearNote, [
      { reply: reduceReply, finish: 'length' },
      { reply: contReply, finish: 'stop' }
    ])
    const { msg } = await ask(runtime, 280)

    const reduceAt = runtime.turns.length - 2
    expect(reduceAt).toBeGreaterThan(1)
    expect(runtime.endings.every((e) => e === 'complete')).toBe(true)
    for (let i = 0; i < reduceAt; i++) {
      const user = userTurnOf(runtime.turns[i])
      expect(user).toBe(asNoFenceMapPrompt(user, WHOLE_DOC_QUESTION))
      expect(runtime.options[i]).toStrictEqual({ signal: undefined, maxTokens: 512, temperature: 0.3 })
    }
    const notes = times(reduceAt, (i) => nearNote(i).trim()).join('\n\n')
    const reduceUser = userTurnOf(runtime.turns[reduceAt])
    expect(reduceUser.endsWith(`\nNotes (whole document):\n${notes}\n\nAnswer:`)).toBe(true)
    expect(userTurnOf(runtime.turns[reduceAt + 1])).toBe(masterContinuationTurn(reduceUser, reduceReply.slice(-200)))
    expect(msg.content).toBe(reduceReply + contReply)
    expect(msg.truncated).toBeUndefined()
  })

  // The same at the engine: the whole-document reduce passes the guard, the single-turn grounded path passes none
  // (G-5). On text that never trips it, the two make the same requests and keep the same text.
  it('the continuation engine makes the same requests with the guard as without it when nothing trips', async () => {
    const first = lines(...HEADER, ...times(5, LOOP))
    const steps = [
      { reply: lines(...times(30, (i) => `- Article ${20 + i}.3: consent may not be withheld unreasonably`)), finish: 'length' },
      { reply: lines('**Important deadlines**', FIRST, 'End of the list.'), finish: 'stop' }
    ]
    const base: ChatMessage[] = [
      { role: 'system', content: 'System.' },
      { role: 'user', content: 'The notes and the request.\n\nAnswer:' }
    ]
    const runOnce = async (withGuard: boolean) => {
      const runtime = lineRuntime(() => '', steps)
      const acc = { content: first }
      const guard = createRepetitionGuard()
      guard.push(first)
      const outcome = await continueUntilComplete({
        runtime,
        baseMessages: base,
        contextTokens: CTX,
        outputCap: 1024,
        temperature: 0.3,
        acc,
        finishReason: 'length',
        sentCap: 1024,
        ...(withGuard ? { repetitionGuard: guard } : {})
      })
      return { turns: runtime.turns, caps: runtime.options.map((o) => [o?.maxTokens, o?.temperature]), acc, outcome }
    }
    const guarded = await runOnce(true)
    const plain = await runOnce(false)
    expect(guarded.turns).toHaveLength(2)
    expect(guarded).toEqual(plain)
  })
})

// Follow-up #2 — hierarchical fold for the ≥~50-page tail (wholedoc-truncation-fix-plan §14.10 residual (a)).
// A document whose window count exceeds SUMMARY_MAP_CALL_CEILING (~12 windows) used to drop its tail (read
// beginning-only, honestly badged). Now every window up to SUMMARY_MAP_CALL_HARD_CEILING is mapped and the
// per-window notes are CONDENSED down through fenced intermediate reduces until they fit one final reduce —
// so the WHOLE document (to the hard ceiling) is covered; beyond the hard ceiling the answer stays honestly
// beginning-only. Driven at ctx 2048 (a small window packs the document into many windows) — the doc must be
// large enough to exceed the ceiling in window count.
describe('whole-document chunk map-reduce — hierarchical fold for the large-document tail (follow-up #2)', () => {
  const CTX2 = 2048
  // Medium map/condense notes: large enough that the joined per-window notes overflow the fold target (so a
  // real condense level runs), small enough to still batch (< one summary window).
  const MEDIUM_NOTE = `${'Detailpunkt Nummer '.repeat(40)}`.trim()

  it('folds a document beyond the single map-call ceiling into WHOLE-document coverage (not beginning-only)', async () => {
    const SENTENCES = 350 // > SUMMARY_MAP_CALL_CEILING windows at ctx 2048, comfortably ≤ the hard ceiling
    const h = await makeHarness(SENTENCES)
    const runtime = mapReduceRuntime(MEDIUM_NOTE, CTX2)
    const msg = await answerWholeDoc(h, runtime)

    // Honest WHOLE-document coverage — the tail was folded in, NOT dropped at the single-level ceiling.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    // A real condense (fold) level ran — its prompt is distinctive.
    expect(runtime.turns.some((t) => userTurnOf(t).includes('Condensed notes:'))).toBe(true)
    // Whole-doc reach: the FIRST and LAST document markers both reached the MAP inputs (markers ride only the
    // raw windows — the condense/reduce turns carry notes, not markers), so no window was dropped.
    const allTurns = runtime.turns.map(userTurnOf).join('\n')
    expect(allTurns).toContain('M0000')
    expect(allTurns).toContain(`M${String(SENTENCES - 1).padStart(4, '0')}`)
  })

  // #939: the fold condenses the map notes, so with the request flag it carries the request too. #952: with no skill
  // there is no task, so every map and condense call takes notes for the request alone with no flag, on the frozen
  // no-fence template, and never names "the task described below".
  it.each([
    { name: 'a skill and the request flag', skill: { installId: 'app:contract-brief', title: 'Contract Brief', body: '# Contract brief\nList every decision.' }, notesForRequest: true },
    { name: 'no skill', skill: undefined, notesForRequest: undefined }
  ])('the map and condense calls with $name (#939, #952)', async ({ skill, notesForRequest }) => {
    const h = await makeHarness(350)
    const runtime = mapReduceRuntime(MEDIUM_NOTE, CTX2)
    await answerWholeDoc(h, runtime, { skill, wholeDocumentNotesForRequest: notesForRequest })
    const steps = runtime.turns.slice(0, -1).map(userTurnOf)
    const folds = steps.filter((u) => u.includes('Condensed notes:'))
    expect(folds.length).toBeGreaterThan(0)
    expect(steps.length).toBeGreaterThan(folds.length)
    for (const step of steps) {
      expect(step).toContain(`\nUser request:\n${WHOLE_DOC_QUESTION}\n`)
      if (skill == null) {
        expect(step).not.toContain('task described below')
        expect(step).toBe(asNoFenceMapPrompt(step, WHOLE_DOC_QUESTION))
      }
    }
  })

  it('beyond the HARD ceiling the tail is honestly dropped (deep-index tree territory)', async () => {
    const SENTENCES = 1000 // > SUMMARY_MAP_CALL_HARD_CEILING windows at ctx 2048 ⇒ sliced + truncated
    const h = await makeHarness(SENTENCES)
    const runtime = mapReduceRuntime(MEDIUM_NOTE, CTX2)
    const msg = await answerWholeDoc(h, runtime)

    // Beyond the hard ceiling: honestly beginning-only (INPUT coverage truncated), never a false whole-doc claim.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(true)
    // The dropped tail never reached the model: the LAST document marker is absent from every map input, while
    // the FIRST is present (the beginning WAS covered).
    const allTurns = runtime.turns.map(userTurnOf).join('\n')
    expect(allTurns).toContain('M0000')
    expect(allTurns).not.toContain(`M${String(SENTENCES - 1).padStart(4, '0')}`)
  })
})
