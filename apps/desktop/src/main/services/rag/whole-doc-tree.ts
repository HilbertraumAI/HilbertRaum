import type { Db } from '../db'
import type { Citation, CoverageInfo, Message } from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import {
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
import { approxTokenCount, truncateToApproxTokens } from '../ingestion/chunker'

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

/** REDUCE step (streamed): produce the final skill-formatted deliverable from the notes. When the
 *  document was too large to process in full (map-call ceiling hit or the joined notes were
 *  truncated to fit the reduce budget), the prompt is SOFTENED to the honest beginning-only framing
 *  and forbids asserting an absence beyond the covered part — the tree-rescue equivalent of the
 *  whole-doc read's partial-document notice (audit §2.2). */
function reduceUserPrompt(
  skillFence: string | null,
  question: string,
  notes: string,
  truncated: boolean
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
  return `${coverageLine}\n\nUser request:\n${question}\n${fence}\n${notesLabel}:\n${notes}\n\nAnswer:`
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
  /** W2 scope notice (§2.1): prepended to the streamed + persisted answer when the scope was auto-
   *  narrowed to this document. App-authored, content-free. Absent ⇒ no prefix. */
  answerPrefix?: string
}

/**
 * Answer a whole-document skill turn from the document's READY deep-index tree, or return `null` when
 * there is no usable tree (caller falls back to the Wave 2 capped path). The answer is persisted with
 * the leaf-chunk provenance citations (M2-safe — node summaries are never `[Sn]`) and honest `tree`
 * coverage; the skill is stamped (the fence shaped the answer at every step).
 */
export async function answerWholeDocFromTree(deps: WholeDocTreeDeps): Promise<Message | null> {
  const { db, runtime, conversationId, documentId, question, skill, contextTokens, signal, onToken, answerPrefix } =
    deps

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

  // Provenance + the whole-tree coverage reads are pure and computed up front; the `truncated` flag is
  // finalized AFTER the map-reduce, because a map-call-ceiling cut OR a reduce-budget notes truncation
  // makes the answer honestly cover only the beginning (audit §2.2 — the former code truncated the
  // notes here while the coverage stamp still asserted `truncated:false`/whole-document coverage).
  const citations: Citation[] = documentLeafProvenance(db, documentId, title)
  const chunksCovered = reachableLeafChunkIds(db, documentId).length
  const chunksTotal = documentChunkCount(db, documentId)
  const treeLevels = maxTreeLevel(db, documentId)

  // The fence is built ONCE (full body — already capped at import validation) and applied at every
  // step. Its token cost is reserved out of the per-window input budget so a window + fence + output
  // fits the launched context.
  const skillFence = skill ? buildSkillFence({ title: skill.title, body: skill.body }).text : null
  const fenceTokens = skillFence ? approxPromptTokens(skillFence) : 0
  const reserveWords = Math.ceil(
    (fenceTokens + approxPromptTokens(question) + 200) / SUMMARY_TOKENS_PER_WORD
  )
  const budgetWords = Math.max(200, summaryBudgetWords(contextTokens) - reserveWords)
  // Map-call ceiling (parity with `planSummaryWindows` / SUMMARY_MAP_CALL_CEILING): beyond ~12 windows
  // the tree rescue would fan out without bound. Keep the first N windows and mark the answer truncated
  // so the coverage stamp AND the reduce prompt stay honest ("covers the beginning") — audit §2.2.
  let truncated = false
  let windows = packIntoWindows(nodeTexts, budgetWords)
  if (windows.length > SUMMARY_MAP_CALL_CEILING) {
    windows = windows.slice(0, SUMMARY_MAP_CALL_CEILING)
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
  if (answerPrefix) onToken?.(answerPrefix)
  try {
    // MAP: when the node summaries fit one window there is no map step — the reduce runs over them
    // directly (it still carries the fence). More than one window → fence-applied notes per section.
    let notes: string
    if (windows.length <= 1) {
      notes = windows[0] ?? nodeTexts.join('\n\n')
    } else {
      const partials: string[] = []
      for (let i = 0; i < windows.length; i++) {
        const partial = await collect(mapUserPrompt(skillFence, i + 1, windows.length, windows[i]))
        if (partial.length > 0) partials.push(partial)
      }
      // All-empty maps (e.g. a reasoning model that emitted only think blocks): fall back to the raw
      // node summaries so the reduce still has document material. Either way, when the joined notes
      // exceed the reduce budget they are hard-truncated → mark the answer truncated so the coverage
      // stamp + reduce prompt stop claiming whole-document coverage (audit §2.2, the "lies at the
      // margin" defect).
      let joined = partials.length > 0 ? partials.join('\n\n') : nodeTexts.join('\n\n')
      if (approxTokenCount(joined) > budgetWords) {
        joined = truncateToApproxTokens(joined, budgetWords)
        truncated = true
      }
      notes = joined
    }

    // REDUCE (streamed to the user): the final skill-formatted deliverable. The prompt is softened to
    // the honest "beginning only" framing when the document did not fit in full (audit §2.2).
    const messages: ChatMessage[] = [
      { role: 'system', content: WHOLE_DOC_TREE_SYSTEM_PROMPT },
      { role: 'user', content: reduceUserPrompt(skillFence, question, notes, truncated) }
    ]
    for await (const token of runtime.chatStream(messages, {
      signal,
      maxTokens: CHAT_RESPONSE_RESERVE_TOKENS,
      temperature: SUMMARY_TEMPERATURE
    })) {
      content += token
      onToken?.(token)
    }
  } catch (err) {
    // A user Stop aborts mid-map (no partial) or mid-reduce (keep the partial); any other error is a
    // real failure and propagates. Same contract as `generateGroundedAnswer`'s stream.
    if (!isAbortError(err, signal)) throw err
  }

  content = stripThinkBlocks(content)
  content = stripSkillFenceEcho(content)
  // Persist NOTHING when the model added nothing beyond the (app-authored) scope-notice prefix (a Stop
  // before the first reduce token, or a think-only reply): the notice is not an answer, and must never be
  // persisted alone stamped with `tree` coverage (W2 review). `content === seeded` catches the prefix-only
  // case; `content === ''` the no-prefix case — byte-identical to the pre-W2 guard when there is no prefix.
  if (content === '' || content === seeded) return emptyAssistantMessage(conversationId)
  // `truncated` is now final (ceiling cut and/or notes truncation): a truncated tree answer is stamped
  // as covering only the beginning, never as whole-document coverage (audit §2.2). The renderer badge
  // reads this flag first, before the leaf-fraction 100% claim.
  const coverage: CoverageInfo = {
    mode: 'tree',
    treeStatus: 'ready',
    chunksCovered,
    chunksTotal,
    treeLevels,
    truncated
  }
  return appendMessage(db, {
    conversationId,
    role: 'assistant',
    content,
    citations,
    coverage,
    // The fence shaped the answer at every step, so the skill is always stamped here.
    skillId: skill?.installId ?? null,
    autoFired: skill?.autoFired === true
  })
}
