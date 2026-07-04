import type { Db } from '../db'
import type { Citation, CoverageInfo, Message } from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import {
  ANALYSIS_RESPONSE_RESERVE_TOKENS,
  appendMessage,
  CHAT_RESPONSE_RESERVE_TOKENS,
  emptyAssistantMessage,
  isAbortError,
  stripThinkBlocks,
  type TurnSkill
} from '../chat'
import { approxPromptTokens, buildSkillFence, stripSkillFenceEcho } from '../skills/prompt'
import {
  documentChunkCount,
  documentLeafProvenance,
  maxTreeLevel,
  nodeSummariesAtLevel,
  reachableLeafChunkIds
} from '../analysis/coverage'
import {
  packIntoWindows,
  summaryBudgetWords,
  SUMMARY_MAP_CALL_CEILING,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_TEMPERATURE,
  SUMMARY_TOKENS_PER_WORD
} from '../doctasks/summary'
import { truncateToApproxTokens } from '../ingestion/chunker'

// Skill-aware WHOLE-DOCUMENT answer over a DEEP-INDEX TREE (skill-whole-doc engine, Follow-up A —
// architecture.md §20). Wave 2 read an over-budget document from the BEGINNING and stamped the honest
// `capped`/"covers the beginning" badge — true coverage stopped at the budget. This closes that for a
// document with a READY deep-index tree: instead of truncating, run the SAME map-reduce the tree
// summary uses (`manager.summarizeFromTree`) over the precomputed node summaries — the deepest layer
// (level 1 = full leaf coverage) — with the SKILL.md fence applied at EACH step, then stamp the honest
// `tree` coverage. The whole document is reached (via its node summaries), formatted to the skill spec.
//
// Reuses the existing infra, builds NO parallel one: `nodeSummariesAtLevel`/`maxTreeLevel`/
// `reachableLeafChunkIds`/`documentLeafProvenance` (coverage tree readers), `packIntoWindows`/
// `summaryBudgetWords` (summary window math), `buildSkillFence` (the §11.2/§14 prompt-injection fence +
// guard around the untrusted body). The §14 capability ceiling is unchanged: pure DB reads + the chat
// runtime, no new DB/FS/net handle.
//
// Returns `null` (a pure pre-model decision — no tree, or no usable node summaries) so the caller falls
// back to the Wave 2 capped path; once a model call has been made it always returns a Message (the
// persisted answer, or an empty message on a Stop) so a cancel never triggers a second, capped pass.

/** App-authored system prompt (fixed English, D-L6) — the untrusted skill body rides in the USER turn
 *  inside `buildSkillFence`, never here, so the app rules + the fence guard bracket it on both sides. */
const WHOLE_DOC_TREE_SYSTEM_PROMPT =
  'You are completing a task over a user\'s local document, fully offline. ' +
  'Use only the material provided. Never invent facts, names, numbers, or dates. ' +
  'Answer in the same language as the document.'

/** MAP step: pull the skill-relevant material from ONE section so the reduce can assemble the
 *  deliverable. The fence (its own guard line included) rides in this USER turn after the instruction. */
function mapUserPrompt(skillFence: string | null, part: number, total: number, text: string): string {
  const fence = skillFence ? `\n${skillFence}\n` : ''
  return (
    `You are processing part ${part} of ${total} of ONE document, section by section, to complete the ` +
    'task described below. From THIS part only, note every detail the task needs — keep names, numbers, ' +
    `dates, decisions, and obligations exact. Write brief notes, not the final answer.\n${fence}\n` +
    `Part ${part} of ${total} (section summaries):\n${text}\n\nNotes:`
  )
}

/** FOLD step (hierarchical reduce, follow-up #2): condense a batch of already-mapped section NOTES into a
 *  shorter faithful summary, so a document beyond the single map-call ceiling still folds down to notes that
 *  fit ONE final reduce (instead of dropping its tail). The fence rides this USER turn too (§2, fence at
 *  every step); the app-authored system prompt stays outside it. */
function foldUserPrompt(skillFence: string | null, part: number, total: number, notes: string): string {
  const fence = skillFence ? `\n${skillFence}\n` : ''
  return (
    `You are condensing the notes from part ${part} of ${total} of ONE document into a shorter summary, to ` +
    'complete the task described below. Keep every name, number, date, decision, and obligation exact — drop ' +
    `only repetition and filler. Write condensed notes, not the final answer.\n${fence}\n` +
    `Part ${part} of ${total} (section notes):\n${notes}\n\nCondensed notes:`
  )
}

/** REDUCE step (streamed): produce the final skill-formatted deliverable from the notes. When the
 *  document was too large to process in full (map-call ceiling hit or the joined notes were
 *  truncated to fit the reduce budget), the prompt is SOFTENED to the honest beginning-only framing
 *  and forbids asserting an absence beyond the covered part — the tree-rescue equivalent of the
 *  whole-doc read's partial-document notice (audit §2.2). */
function reduceUserPrompt(
  skillFence: string | null,
  question: string,
  notes: string,
  truncated: boolean,
  extraReduceBlock?: string
): string {
  const fence = skillFence ? `\n${skillFence}\n` : ''
  const coverageLine = truncated
    ? 'Using the notes below — which cover only the BEGINNING of the document (it was too large to ' +
      'process in full) — complete the user request by following the task instructions exactly. State ' +
      'plainly that your answer covers only the beginning, and do NOT say that anything is absent or ' +
      'missing — the part not covered may contain it. Do not mention that the document was processed in parts.'
    : 'Using the notes below — which together cover the WHOLE document — complete the user request by ' +
      'following the task instructions exactly. Do not mention that the document was processed in parts.'
  const notesLabel = truncated ? 'Notes (beginning of the document)' : 'Notes (whole document)'
  // An optional app-authored block (e.g. the share-safe whole-document PII pre-scan, §L-share-safe)
  // rides in THIS reduce USER turn — never the system prompt (untrusted-text class). Absent ⇒ byte-
  // identical to the pre-Phase-1 tree prompt (the tree path passes none).
  const extra = extraReduceBlock ? `\n${extraReduceBlock}\n` : ''
  return `${coverageLine}\n\nUser request:\n${question}\n${fence}${extra}\n${notesLabel}:\n${notes}\n\nAnswer:`
}

// ── Continue-generation for an over-cap deliverable (Phase 4 — wholedoc-truncation-fix-plan §6) ────────
//
// Phase 2 sizes the reduce output to fit `n_ctx`; on a small (4 k) window a very long deliverable is still
// cut at the ceiling (the reduce stream ends `finishReason === 'length'`) and persisted mid-sentence.
// Continue-generation removes that ceiling: when a reduce pass ends 'length' (the model was cut off — NOT a
// user Stop, which fires no finish reason), re-prompt to FINISH from where it stopped, append, and
// de-duplicate the seam overlap. Bounded by a hard cap so a model that never emits EOS cannot fan out
// without end; when the cap is exhausted the answer carries an honest OUTPUT-truncated stamp
// (`Message.truncated` — distinct from `coverage.truncated`, which is INPUT coverage; the two are never
// conflated). Applies to BOTH the tree rescue and the chunk map-reduce (they share this reduce core).

/** Hard cap on EXTRA reduce passes after a 'length'-cut deliverable (the runaway guard). */
export const MAX_REDUCE_CONTINUATIONS = 2
/** Tail (chars) of the produced answer fed to a continuation as its resume anchor + the seam-dedup window. */
export const CONTINUATION_ANCHOR_CHARS = 200
/** A continuation is launched only when the launched window leaves at least this many OUTPUT tokens after
 *  its (anchor-enlarged) prompt — otherwise the no-`n_ctx`-overflow guard stops and the answer is honestly
 *  output-truncated (never assemble a prompt the runtime rejects — the HTTP 400 class, invariant §2). */
export const CONTINUATION_MIN_OUTPUT_TOKENS = 256

// ── Hierarchical fold for the ≥~50-page tail (follow-up #2) ────────────────────────────────────────────
//
// A document whose window count exceeds `SUMMARY_MAP_CALL_CEILING` (~12 windows ≈ ~50 pages) used to drop
// its tail — only the first 12 windows were mapped and the answer was honestly badged beginning-only. That
// is the designed hand-off point to the deep-index TREE (which auto-builds at ~this size), but a document in
// the transient window BEFORE its tree exists still read beginning-only. Follow-up #2 raises the reach: up to
// `SUMMARY_MAP_CALL_HARD_CEILING` windows are mapped, and the per-window notes are CONDENSED down through
// bounded fenced intermediate reduces (`foldUserPrompt`) until they fit ONE final reduce — so the WHOLE
// document (to the hard ceiling) is covered. Beyond the hard ceiling the answer stays honestly beginning-only
// (the tree is the right rescue at that size — this is a query-time cost lever, deliberately bounded: the
// dominant cost is one map call per window, on CPU, so the raise is moderate, not unbounded).

/** Raised ceiling on windows actually MAPPED before the answer is honestly beginning-only (2× the single-
 *  level ceiling ≈ ~100 pages). Beyond it, deep-index tree territory — `truncated` stays true. */
export const SUMMARY_MAP_CALL_HARD_CEILING = SUMMARY_MAP_CALL_CEILING * 2
/** Hard cap on the fold's condense levels (the runaway guard). Each level shrinks the notes ~fan-out-fold, so
 *  a hard-ceiling document converges in 1–2 levels; a residual overflow falls to the notes hard-cut (honest). */
export const MAX_FOLD_DEPTH = 3

/** CONTINUE step: append a short resume instruction + an `anchor` (the tail already produced) to a USER
 *  turn, so the model continues exactly where it stopped without repeating. The seam overlap between the
 *  anchor and the continuation's opening is de-duplicated by the caller. */
function appendResumeInstruction(userContent: string, anchor: string): string {
  return (
    `${userContent}\n\n` +
    'You already produced the answer up to the passage below, but were cut off before finishing. Continue ' +
    'the answer exactly from where it stops — do NOT repeat anything already written, do NOT restart, and ' +
    'do NOT add any preamble or heading.\n\n' +
    `Already written (your answer ends with this — continue immediately after it):\n${anchor}\n\nContinuation:`
  )
}

/** Build the continuation prompt: re-send `base` VERBATIM (system + any history + the grounded/reduce USER
 *  turn — full grounding, "fence at every step" §2) with the resume instruction + anchor appended to the
 *  LAST user turn. A shallow clone so `base` is never mutated. */
function withContinuation(base: ChatMessage[], anchor: string): ChatMessage[] {
  const out = base.map((m) => ({ ...m }))
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i] = { ...out[i], content: appendResumeInstruction(out[i].content, anchor) }
      return out
    }
  }
  out.push({ role: 'user', content: appendResumeInstruction('', anchor) })
  return out
}

/** Longest seam overlap between the tail of `produced` and the head of `cont`, capped at `maxOverlap` chars
 *  (the model only ever saw the anchor, so the overlap cannot exceed it). Returns the number of leading
 *  `cont` chars that duplicate `produced`'s tail — the caller drops them before appending, so a continuation
 *  that re-emits the anchor tail does not double the seam. */
function seamOverlap(produced: string, cont: string, maxOverlap: number): number {
  const limit = Math.min(maxOverlap, cont.length, produced.length)
  for (let l = limit; l > 0; l--) {
    if (produced.endsWith(cont.slice(0, l))) return l
  }
  return 0
}

export interface ContinueGenerationInput {
  runtime: ModelRuntime
  signal?: AbortSignal
  /** Streams the de-duplicated continuation tokens to the renderer (same channel as the first pass). */
  onToken?: (token: string) => void
  /** The messages the just-completed stream used (system + any history + the grounded/reduce USER turn);
   *  re-sent verbatim each pass with the resume instruction appended to its last user turn. */
  baseMessages: ChatMessage[]
  /** The REAL launched context window (model tokens) — the no-overflow room guard sizes each pass against it. */
  contextTokens: number
  /** Per-pass output ceiling (the first pass's cap); each continuation is shrunk to fit its larger prompt. */
  outputCap: number
  temperature?: number
  /** Mutable accumulator: the text produced so far; the engine appends the continuation text here. */
  acc: { content: string }
  /** The finish reason of the pass that just completed ('length' = cut at the ceiling ⇒ continue). */
  finishReason: string | null
}

/**
 * Shared continue-generation engine (wholedoc-truncation-fix-plan §6 + follow-up #1). When a stream ended
 * `finishReason === 'length'` (cut at the output ceiling — NOT a user Stop, which fires no finish reason), it
 * re-prompts to FINISH the deliverable: each pass re-sends `baseMessages` with a resume instruction + anchor
 * (the last `CONTINUATION_ANCHOR_CHARS` produced) appended to the last user turn, streams the seam-deduped
 * remainder live into `acc.content`, and loops while still 'length'. Bounded by `MAX_REDUCE_CONTINUATIONS`
 * (runaway guard) AND a per-pass no-`n_ctx`-overflow room guard (each continuation's `maxTokens` is sized
 * against the ACTUAL assembled prompt, and the loop stops rather than assemble a prompt the runtime would
 * reject — the HTTP 400 class). A user Stop mid-continuation flushes the seam-deduped partial into
 * `acc.content` and returns (swallowed — the caller persists the accumulated partial); a real error
 * propagates. Returns the FINAL finish reason: the caller stamps an honest OUTPUT-truncation when it is still
 * 'length' (the cap was exhausted); `null` on a user Stop (intentional, not an overflow).
 */
export async function continueUntilComplete(input: ContinueGenerationInput): Promise<string | null> {
  const { runtime, signal, onToken, baseMessages, contextTokens, outputCap, temperature, acc } = input
  let finishReason = input.finishReason
  let continuations = 0
  try {
    while (finishReason === 'length' && continuations < MAX_REDUCE_CONTINUATIONS) {
      continuations++
      const anchor = acc.content.slice(-CONTINUATION_ANCHOR_CHARS)
      const continueMessages = withContinuation(baseMessages, anchor)
      const continuePromptTokens = continueMessages.reduce((sum, m) => sum + approxPromptTokens(m.content), 0)
      const continueCap = Math.min(outputCap, contextTokens - continuePromptTokens)
      if (continueCap < CONTINUATION_MIN_OUTPUT_TOKENS) break
      finishReason = null
      // Hold back the continuation's opening until enough is buffered to resolve the seam overlap against
      // the anchor, then stream the DE-DUPLICATED remainder live.
      let seam = ''
      let seamResolved = false
      const flushSeam = (): void => {
        const emit = seam.slice(seamOverlap(acc.content, seam, anchor.length))
        if (emit.length > 0) {
          acc.content += emit
          onToken?.(emit)
        }
        seam = ''
        seamResolved = true
      }
      try {
        for await (const token of runtime.chatStream(continueMessages, {
          signal,
          maxTokens: continueCap,
          temperature,
          onFinish: (reason) => {
            finishReason = reason
          }
        })) {
          if (seamResolved) {
            acc.content += token
            onToken?.(token)
          } else {
            seam += token
            if (seam.length >= anchor.length) flushSeam()
          }
        }
      } finally {
        // A short pass (never reached the anchor length) OR a Stop mid-continuation still emits the
        // de-duplicated partial, so the accumulated answer is persisted (abort contract, §2).
        if (!seamResolved) flushSeam()
      }
    }
  } catch (err) {
    if (!isAbortError(err, signal)) throw err
    // A user Stop mid-continuation: the seam partial was flushed into acc.content by the finally above.
    // Swallow and report null so the caller persists the partial and does NOT stamp it output-truncated.
    return null
  }
  return finishReason
}

// ── Reduce output/notes budget (Phase 2 — wholedoc-truncation-fix-plan §4) ────────────────────────────
//
// The reduce step needs a MUCH larger output reserve than a chat reply to finish a structured
// deliverable, but at a small `n_ctx` you cannot both hold the document notes AND emit a long answer.
// `computeReduceBudget` sizes both from the REAL launched context so `notes + output` provably fit the
// window at EVERY size — the regression guard against the HTTP 400 "exceeds context size" (invariant §2,
// "no n_ctx overflow").
//
// POLICY (owner-approved 2026-07-04, a deliberate deviation from §4's fixed output-first clamp): the
// deliverable reserve is NOTES-FIRST. It aims for `ANALYSIS_RESPONSE_RESERVE_TOKENS` but YIELDS toward
// `CHAT_RESPONSE_RESERVE_TOKENS` (today's floor — never worse) so the WHOLE document's notes survive.
// Only when even the floor output leaves no room are the notes hard-truncated (⇒ `truncated:true`, honest
// coverage). Consequence: a long brief gets the full reserve on a ≥ ~8 k window; on a 4 k window the
// OUTPUT shrinks (the documented residual) rather than reopening Phase 1's whole-doc coverage.
//
// UNIT CONVENTION — all arithmetic is in MODEL tokens (the unit of `contextTokens`, `maxTokens`, and
// `approxPromptTokens`, which is `approxTokenCount × TOKENS_PER_WORD`). `notesTokens` is the reduce
// notes measured with `approxPromptTokens`; `reduceOutputCap` is passed straight to `maxTokens`;
// `reduceNotesBudget` is the max model tokens the notes may occupy — the caller divides it by
// `SUMMARY_TOKENS_PER_WORD` to get the WORD budget the `truncateToApproxTokens`/`approxTokenCount`
// helpers count in (word_units × SUMMARY_TOKENS_PER_WORD ≈ model tokens).
//
// GUARANTEE: `fenceTokens + questionTokens + REDUCE_CHROME_TOKENS + reduceNotesBudget + reduceOutputCap
// ≤ contextTokens` at every context size ≥ `CHAT_RESPONSE_RESERVE_TOKENS + REDUCE_MIN_NOTES_TOKENS +
// overhead` (~1.9 k + fence — i.e. every real window; the smallest supported is 2 048). Below that the
// output floor alone exceeds the window (an inherent small-`n_ctx` limit, no worse than today's fixed
// 1024 reserve) and the notes retain `REDUCE_MIN_NOTES_TOKENS` of material.

/** Reduce prompt chrome (system prompt + coverage line + labels), in model tokens (§4 CHROME=128). */
export const REDUCE_CHROME_TOKENS = 128
/** Never starve the reduce notes below this many model tokens (§4 MIN_NOTES=512). */
export const REDUCE_MIN_NOTES_TOKENS = 512

export interface ReduceBudgetInput {
  /** The REAL launched context window (§L0), in model tokens. */
  contextTokens: number
  /** Skill-fence cost in the reduce user turn (`approxPromptTokens`), model tokens. 0 when no skill. */
  fenceTokens: number
  /** Question cost in the reduce user turn (`approxPromptTokens`), model tokens. */
  questionTokens: number
  /** Actual assembled reduce-notes size (`approxPromptTokens(notes)`), model tokens. */
  notesTokens: number
}

export interface ReduceBudget {
  /** `maxTokens` for the reduce stream (model tokens): the deliverable reserve after yielding to notes. */
  reduceOutputCap: number
  /** Max model tokens the notes may occupy; truncate the notes to this (÷ SUMMARY_TOKENS_PER_WORD words). */
  reduceNotesBudget: number
  /** The notes exceed `reduceNotesBudget` and must be hard-truncated ⇒ the answer covers only the
   *  beginning (coverage honesty C1/L2). */
  notesTruncated: boolean
}

/**
 * Size the reduce step's output cap + notes budget from the launched context (see the module note above).
 * Pure — unit-tested at the boundaries (wholedoc-reduce-budget.test.ts).
 */
export function computeReduceBudget({
  contextTokens,
  fenceTokens,
  questionTokens,
  notesTokens
}: ReduceBudgetInput): ReduceBudget {
  const overhead = fenceTokens + questionTokens + REDUCE_CHROME_TOKENS
  const available = Math.max(0, contextTokens - overhead) // model tokens shared by notes + output
  // Notes-first: output aims for ANALYSIS…, but reserves the ACTUAL notes (never below MIN_NOTES) and
  // never drops under CHAT… (today's floor). Output takes whatever the notes leave.
  const reduceOutputCap = Math.max(
    CHAT_RESPONSE_RESERVE_TOKENS,
    Math.min(ANALYSIS_RESPONSE_RESERVE_TOKENS, available - Math.max(notesTokens, REDUCE_MIN_NOTES_TOKENS))
  )
  // The notes may fill whatever the (final) output cap leaves — at least MIN_NOTES of material. At every
  // real context (≥ 2 048 with a realistic fence) `available − cap ≥ MIN_NOTES`, so this floor does not
  // bind and `overhead + reduceNotesBudget + reduceOutputCap === contextTokens` (fits exactly, no overflow).
  const reduceNotesBudget = Math.max(REDUCE_MIN_NOTES_TOKENS, available - reduceOutputCap)
  return { reduceOutputCap, reduceNotesBudget, notesTruncated: notesTokens > reduceNotesBudget }
}

export interface WholeDocTreeDeps {
  db: Db
  runtime: ModelRuntime
  conversationId: string
  documentId: string
  question: string
  /** The turn's skill — its fence is applied at every map/reduce step (the whole-doc engine invariant). */
  skill?: TurnSkill | null
  /** The REAL launched context window (§L0) — sizes the per-call window budget. */
  contextTokens: number
  signal?: AbortSignal
  /** Streams the FINAL reduce tokens to the renderer (the map steps are internal, not streamed). */
  onToken?: (token: string) => void
  /** Phase 3 (§5) — the ephemeral 'analysis' progress notice, fired by the core when a real map loop runs
   *  (threaded straight through to `streamWholeDocMapReduce`). Absent ⇒ no notice. */
  onCompactionStart?: (kind: 'analysis') => void
  /** W2 scope notice (§2.1): prepended to the streamed + persisted answer when the scope was auto-
   *  narrowed to this document. App-authored, content-free. Absent ⇒ no prefix. */
  answerPrefix?: string
}

/**
 * Shared map-reduce CORE for a whole-document skill answer (Phase 1 — wholedoc-truncation-fix-plan §3).
 * Given the document's whole-doc material (`sourceTexts`) and its provenance (`citations`), it builds the
 * fence, packs windows, runs the map (per-section notes) → reduce (streamed deliverable), and persists the
 * answer with an HONEST coverage stamp. Two callers pass different sources:
 *   - `answerWholeDocFromTree` — node summaries at level 1, `coverageMode:'tree'` (the ready-tree rescue).
 *   - `answerWholeDocFromChunks` (rag/index.ts) — the de-overlapped RAW chunks, `coverageMode:'capped'`
 *     (the no-tree over-budget path — closes the "gap band"). Co-located there so the chunk de-overlap
 *     helpers stay private to rag/index.ts (no circular import back here).
 * `truncated` is finalized AFTER the map-reduce: a map-call-ceiling cut OR a reduce-budget notes hard-
 * truncation makes the answer honestly cover only the BEGINNING (C1/L2 — coverage honesty). Once a model
 * call is made it always returns a Message (partial on Stop, `emptyAssistantMessage` on Stop-before-first-
 * token) so a cancel never triggers a second pass. Capability ceiling unchanged: pure `db` reads + the
 * chat runtime, no new DB/FS/net handle (SEC-1).
 */
export interface WholeDocMapReduceInput {
  db: Db
  runtime: ModelRuntime
  conversationId: string
  documentId: string
  question: string
  /** The turn's skill — its fence rides in every map/reduce USER turn (the whole-doc engine invariant). */
  skill?: TurnSkill | null
  /** The REAL launched context window (§L0) — sizes the per-call window budget. */
  contextTokens: number
  signal?: AbortSignal
  /** Streams the FINAL reduce tokens to the renderer (the map steps are internal, not streamed). */
  onToken?: (token: string) => void
  /** Phase 3 (§5) — fires the ephemeral 'analysis' progress notice ("Reading the whole document…") when a
   *  real map loop runs before the first streamed token. Same channel/kind the exhaustive path uses
   *  (registerRagIpc); ephemeral (R14), no new handle (SEC-1). Absent ⇒ no notice (e.g. tests, or no IPC). */
  onCompactionStart?: (kind: 'analysis') => void
  /** W2 scope notice (§2.1): prepended to the streamed + persisted answer. Absent ⇒ no prefix. */
  answerPrefix?: string
  /** The whole-document material: node summaries (tree) OR de-overlapped chunk texts (chunk path). */
  sourceTexts: string[]
  /** Provenance for THIS answer: real leaf CHUNKS only (M2), never node summaries. */
  citations: Citation[]
  chunksCovered: number
  chunksTotal: number
  coverageMode: 'tree' | 'capped'
  /** Tree only — levels in the deep-index tree (coverage stamp; ignored for `capped`). */
  treeLevels?: number
  /** Optional app-authored block (e.g. the share-safe PII scan) for the reduce USER turn — never system. */
  extraReduceBlock?: string
}

export async function streamWholeDocMapReduce(input: WholeDocMapReduceInput): Promise<Message> {
  const {
    db,
    runtime,
    conversationId,
    question,
    skill,
    contextTokens,
    signal,
    onToken,
    onCompactionStart,
    answerPrefix,
    sourceTexts,
    citations,
    chunksCovered,
    chunksTotal,
    coverageMode,
    treeLevels,
    extraReduceBlock
  } = input

  // The fence is built ONCE (full body — already capped at import validation) and applied at every
  // step. Its token cost is reserved out of the per-window input budget so a window + fence + output
  // fits the launched context.
  const skillFence = skill ? buildSkillFence({ title: skill.title, body: skill.body }).text : null
  const fenceTokens = skillFence ? approxPromptTokens(skillFence) : 0
  const questionTokens = approxPromptTokens(question)
  const reserveWords = Math.ceil((fenceTokens + questionTokens + 200) / SUMMARY_TOKENS_PER_WORD)
  const budgetWords = Math.max(200, summaryBudgetWords(contextTokens) - reserveWords)
  // Map-call HARD ceiling (follow-up #2): beyond `SUMMARY_MAP_CALL_HARD_CEILING` windows (~100 pages) the
  // rescue would fan out without useful bound, and the deep-index tree is the designed answer at that size —
  // keep the first N windows and mark the answer truncated so the coverage stamp AND the reduce prompt stay
  // honest ("covers the beginning", audit §2.2). Windows BETWEEN the single-level ceiling and the hard ceiling
  // are covered whole via the hierarchical fold below (they are no longer dropped at 12).
  let truncated = false
  let windows = packIntoWindows(sourceTexts, budgetWords)
  if (windows.length > SUMMARY_MAP_CALL_HARD_CEILING) {
    windows = windows.slice(0, SUMMARY_MAP_CALL_HARD_CEILING)
    truncated = true
  }

  /** One non-streamed model call (a MAP step). Reasoning stripped, like the doctask `generate`. */
  const collect = async (user: string): Promise<string> => {
    const messages: ChatMessage[] = [
      { role: 'system', content: WHOLE_DOC_TREE_SYSTEM_PROMPT },
      { role: 'user', content: user }
    ]
    let out = ''
    for await (const token of runtime.chatStream(messages, {
      signal,
      maxTokens: SUMMARY_OUTPUT_TOKENS,
      temperature: SUMMARY_TEMPERATURE
    })) {
      out += token
    }
    return stripThinkBlocks(out).trim()
  }

  // W2 scope notice (§2.1): lead the streamed + persisted answer with the fixed narrowing notice when
  // the scope was auto-narrowed to this document (mirrors the main grounded path).
  const seeded = answerPrefix ?? ''
  let content = seeded
  // Phase 4 (§6): set true ONLY when continue-generation is exhausted and the deliverable is still cut at
  // the output ceiling — an honest OUTPUT-truncation stamp, distinct from the INPUT-coverage `truncated`.
  let outputTruncated = false
  if (answerPrefix) onToken?.(answerPrefix)
  // Phase 3 — progress affordance (wholedoc-truncation-fix-plan §5): a MULTI-window source runs SILENT
  // map calls before the first streamed reduce token; that gap otherwise reads as a hang. Fire the SAME
  // ephemeral 'analysis' notice the exhaustive path uses (registerRagIpc — "Reading the whole document…").
  // ONLY when there is a real map loop: a single window streams the reduce directly (no silent step), and
  // the fits-budget single read + needle/relevance paths never enter this core — none of them fires a
  // spurious notice. Fired AFTER the answerPrefix token (which the renderer treats as a first token,
  // clearing any prior notice) and BEFORE the map loop, so it is visible for exactly the silent map window
  // and clears on the first reduce token. Ephemeral (R14); it is a callback, so no new handle (SEC-1).
  if (windows.length > 1) onCompactionStart?.('analysis')
  try {
    // MAP: when the source fits one window there is no map step — the reduce runs over it directly (it
    // still carries the fence). More than one window → fence-applied notes per section. All-empty maps
    // (e.g. a reasoning model that emitted only think blocks): fall back to the raw source so the reduce
    // still has document material.
    let notes: string
    if (windows.length <= 1) {
      notes = windows[0] ?? sourceTexts.join('\n\n')
    } else {
      const partials: string[] = []
      for (let i = 0; i < windows.length; i++) {
        const partial = await collect(mapUserPrompt(skillFence, i + 1, windows.length, windows[i]))
        if (partial.length > 0) partials.push(partial)
      }
      if (partials.length === 0) {
        notes = sourceTexts.join('\n\n') // all-empty maps → fall back to the raw source (unchanged)
      } else if (windows.length <= SUMMARY_MAP_CALL_CEILING) {
        notes = partials.join('\n\n') // ≤ ceiling windows: single-level reduce (byte-identical to pre-#2)
      } else {
        // Hierarchical FOLD (follow-up #2): a document beyond the single map-call ceiling used to drop its
        // tail; now every mapped window's notes are CONDENSED down through fenced intermediate reduces until
        // they fit ONE final reduce, so the WHOLE document (to the hard ceiling) is covered. Fold until the
        // joined notes fit alongside at least the floor output (so the reduce's notes-cut does NOT bind ⇒
        // `truncated` stays false); a residual overflow after the depth cap falls to that notes-cut (honest).
        const foldOverhead = fenceTokens + questionTokens + REDUCE_CHROME_TOKENS
        const foldTargetTokens = Math.max(
          REDUCE_MIN_NOTES_TOKENS,
          contextTokens - foldOverhead - CHAT_RESPONSE_RESERVE_TOKENS
        )
        let level = partials
        let depth = 0
        while (
          level.length > 1 &&
          depth < MAX_FOLD_DEPTH &&
          approxPromptTokens(level.join('\n\n')) > foldTargetTokens
        ) {
          depth++
          const batches = packIntoWindows(level, budgetWords)
          if (batches.length >= level.length) break // notes too big to group further → let the notes-cut bind
          const condensed: string[] = []
          for (let i = 0; i < batches.length; i++) {
            const c = await collect(foldUserPrompt(skillFence, i + 1, batches.length, batches[i]))
            if (c.length > 0) condensed.push(c)
          }
          if (condensed.length === 0) break // degenerate condense (think-only) → keep the prior level
          level = condensed
        }
        notes = level.join('\n\n')
      }
    }

    // Adaptive reduce budget (Phase 2 — §4): size the deliverable's output cap + the notes from the REAL
    // launched context so `notes + output` fit `n_ctx` at every size (no HTTP 400). The output reserve
    // yields to the actual notes (notes-first), so a large single-window document keeps WHOLE-document
    // coverage and only the deliverable shrinks on a small window. When even the floor output leaves no
    // room, the notes are hard-truncated → mark the answer truncated so the coverage stamp + reduce prompt
    // stop claiming whole-document coverage (audit §2.2, the "lies at the margin" defect). Model-token math
    // is converted to the chunker's word units (÷ SUMMARY_TOKENS_PER_WORD) for `truncateToApproxTokens`.
    const { reduceOutputCap, reduceNotesBudget, notesTruncated } = computeReduceBudget({
      contextTokens,
      fenceTokens,
      questionTokens,
      notesTokens: approxPromptTokens(notes)
    })
    if (notesTruncated) {
      notes = truncateToApproxTokens(notes, Math.max(1, Math.floor(reduceNotesBudget / SUMMARY_TOKENS_PER_WORD)))
      truncated = true
    }

    // REDUCE (streamed to the user): the final skill-formatted deliverable. The prompt is softened to
    // the honest "beginning only" framing when the document did not fit in full (audit §2.2). The reduce
    // USER turn is built ONCE and reused verbatim by each continuation pass (fence + notes + question +
    // extraReduceBlock — the §2 "fence at every step" invariant, carried through with full grounding).
    const reduceUser = reduceUserPrompt(skillFence, question, notes, truncated, extraReduceBlock)
    const messages: ChatMessage[] = [
      { role: 'system', content: WHOLE_DOC_TREE_SYSTEM_PROMPT },
      { role: 'user', content: reduceUser }
    ]
    // Capture the reduce's finish reason ('length' = cut at the output ceiling, 'stop' = a clean EOS). A
    // user Stop aborts before any final chunk so onFinish never fires → stays null → not continued and not
    // output-truncated (the abort partial is intentional; parity with the single-turn grounded path).
    let finishReason: string | null = null
    for await (const token of runtime.chatStream(messages, {
      signal,
      maxTokens: reduceOutputCap,
      temperature: SUMMARY_TEMPERATURE,
      onFinish: (reason) => {
        finishReason = reason
      }
    })) {
      content += token
      onToken?.(token)
    }

    // CONTINUE-GENERATION (Phase 4 — §6): the reduce was cut at the output ceiling, not stopped by the user.
    // Finish the deliverable across bounded re-prompts via the SHARED engine `continueUntilComplete` (also
    // used by the single-turn grounded path — follow-up #1). It re-sends the reduce turn + a resume anchor,
    // streams the seam-deduped continuation live into `acc.content`, and stops at the cap or the no-overflow
    // room guard. It handles its OWN Stop mid-continuation (flushes the partial, returns null), so the
    // accumulated partial is persisted; a real error propagates to the outer catch. Reaching the assignment
    // below means a CLEAN return — an exhausted-while-'length' reduce is honestly stamped output-truncated;
    // a user Stop returns null ⇒ false (intentional, not an overflow).
    const acc = { content }
    const finalReason = await continueUntilComplete({
      runtime,
      signal,
      onToken,
      baseMessages: messages,
      contextTokens,
      outputCap: reduceOutputCap,
      temperature: SUMMARY_TEMPERATURE,
      acc,
      finishReason
    })
    content = acc.content
    outputTruncated = finalReason === 'length'
  } catch (err) {
    // A user Stop aborts mid-map (no partial) or mid-reduce (keep the partial); any other error is a
    // real failure and propagates. Same contract as `generateGroundedAnswer`'s stream.
    if (!isAbortError(err, signal)) throw err
  }

  content = stripThinkBlocks(content)
  content = stripSkillFenceEcho(content)
  // Persist NOTHING when the model added nothing beyond the (app-authored) scope-notice prefix (a Stop
  // before the first reduce token, or a think-only reply): the notice is not an answer, and must never be
  // persisted alone stamped with coverage (W2 review). `content === seeded` catches the prefix-only case;
  // `content === ''` the no-prefix case — byte-identical to the pre-W2 guard when there is no prefix.
  if (content === '' || content === seeded) return emptyAssistantMessage(conversationId)
  // `truncated` is now final (ceiling cut and/or notes truncation): a truncated answer is stamped as
  // covering only the beginning, never as whole-document coverage (audit §2.2). The renderer badge reads
  // this flag first, before the leaf-fraction 100% claim.
  const coverage: CoverageInfo =
    coverageMode === 'tree'
      ? { mode: 'tree', treeStatus: 'ready', chunksCovered, chunksTotal, treeLevels, truncated }
      : { mode: 'capped', chunksCovered, chunksTotal, truncated }
  return appendMessage(db, {
    conversationId,
    role: 'assistant',
    content,
    citations,
    coverage,
    // The fence shaped the answer at every step, so the skill is always stamped here.
    skillId: skill?.installId ?? null,
    autoFired: skill?.autoFired === true,
    // Phase 4 (§6): honest OUTPUT-truncation stamp when continue-generation was exhausted and the
    // deliverable is still cut at the ceiling — the "Answer truncated" badge, distinct from the coverage
    // (INPUT) truncation above. False on a clean finish and on a user Stop.
    truncated: outputTruncated
  })
}

/**
 * Answer a whole-document skill turn from the document's READY deep-index tree, or return `null` when
 * there is no usable tree (caller falls back to the chunk map-reduce / capped path). The pre-model gate
 * (a ready tree + usable node summaries) and the leaf-chunk provenance/coverage reads are pure and done
 * here; the map-reduce/stream/persist is delegated to `streamWholeDocMapReduce` with `coverageMode:'tree'`
 * — behavior byte-identical to the pre-Phase-1 inline path (pinned by rag-whole-doc-tree.test.ts).
 */
export async function answerWholeDocFromTree(deps: WholeDocTreeDeps): Promise<Message | null> {
  const {
    db,
    runtime,
    conversationId,
    documentId,
    question,
    skill,
    contextTokens,
    signal,
    onToken,
    onCompactionStart,
    answerPrefix
  } = deps

  // Pre-model gate (pure reads): a ready tree + at least one usable node summary, else fall back.
  const meta = db
    .prepare('SELECT title, tree_status FROM documents WHERE id = ?')
    .get(documentId) as unknown as { title: string | null; tree_status: string | null } | undefined
  if (!meta || meta.tree_status !== 'ready') return null
  const title = meta.title ?? 'Untitled'

  // Deepest layer = full leaf coverage (the Tier-3 choice in summarizeFromTree). A degenerate tree
  // (single level / empty layer) falls back to the stored root summary as the only material.
  let nodeTexts = nodeSummariesAtLevel(db, documentId, 1)
  if (nodeTexts.length === 0) {
    const root = db
      .prepare('SELECT summary_text FROM tree_nodes WHERE document_id = ? AND is_root = 1 LIMIT 1')
      .get(documentId) as unknown as { summary_text: string } | undefined
    if (!root || root.summary_text.trim().length === 0) return null
    nodeTexts = [root.summary_text]
  }

  // Provenance + the whole-tree coverage reads (leaf chunks only — M2). The `truncated` flag is finalized
  // inside the core, after the map-reduce (a ceiling cut or notes truncation covers only the beginning).
  const citations: Citation[] = documentLeafProvenance(db, documentId, title)
  const chunksCovered = reachableLeafChunkIds(db, documentId).length
  const chunksTotal = documentChunkCount(db, documentId)
  const treeLevels = maxTreeLevel(db, documentId)

  return streamWholeDocMapReduce({
    db,
    runtime,
    conversationId,
    documentId,
    question,
    skill,
    contextTokens,
    signal,
    onToken,
    onCompactionStart,
    answerPrefix,
    sourceTexts: nodeTexts,
    citations,
    chunksCovered,
    chunksTotal,
    coverageMode: 'tree',
    treeLevels
  })
}
