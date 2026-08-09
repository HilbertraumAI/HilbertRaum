import type { JsonSchema } from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import { stripThinkBlocks } from '../chat'
import { isAggregationShaped, type RouteDecision } from './router'

// The constrained skill-pointer classification (issue #80, wave R80; STR-1 §5.2). The
// deterministic router stays the fast path — every currently-confident route is byte-unchanged,
// still 0 model calls. ONLY on the two trigger classes below does the caller make ONE
// grammar-constrained, single-shot classification call over an ENUM of gated skill pointers plus
// the mandatory `none` drop target (the D55 `responseSchema` machinery — the bank categorizer is
// the direct template: fixed enum, drop-to-safe-value on any fault, injected runtime, and the
// MockRuntime ignores `responseSchema`, so mock/dev mode always exercises the degrade path and
// behaves byte-identically to a no-classifier build — a tested invariant).
//
// Consent posture (S13b/D4): the classification result NEVER changes the engine, never activates
// a skill, and never reaches answer content — it only populates the per-answer OFFER surface
// (`Message.skillOffer`, provenance 'classifier'), where a user CLICK is the consent. Every
// failure mode (no runtime, no candidates, parse failure, timeout, abort, runaway output) returns
// null — a silent degrade to exactly today's behaviour, never an error surfaced to the turn.
//
// Explicitly NOT here (STR-1 §2, scope exclusions): no engine members in the enum (no rerouting),
// no tool-calling loop, no step-5 classification (ordinary questions keep 0 model calls). The
// candidate inventory arrives as a plain injected list so a future signal-aware picker (#53/#52)
// can extend HOW candidates are chosen without touching this module.

/** One gated skill candidate (id + display title). The caller builds this list from the ONE
 *  shared offer gate (`offerableSkillCandidates` — enabled + available + app-compatible), so a
 *  skill outside that gate can never appear in the enum by construction. */
export interface ClassifyCandidate {
  installId: string
  title: string
}

/** The mandatory drop target — always in the enum, and the honest answer when unsure. */
export const CLASSIFY_NONE = 'none'

/**
 * Hard wall-clock bound on the classification (ms). The call runs INSIDE the held chat slot
 * BEFORE the answer is emitted, so it must never hold the turn hostage: past the bound the
 * request is aborted and the turn proceeds offer-less (silent degrade). Generous against the
 * expected cost (a one-line grammar-constrained completion) while keeping the worst case felt
 * as "a beat", not "a hang".
 */
export const CLASSIFY_TIMEOUT_MS = 4000

/** Output-token budget: `{"skill":"<install id>"}` plus framing — install ids are bounded
 *  (`<source>:<kebab-id>`), so this is generous. */
export const CLASSIFY_MAX_TOKENS = 48

/** Defensive char cap over the budget (the categorizer's L-2 posture): a looping runtime that
 *  ignores `maxTokens` is cut off and the classification dropped, never accumulated unbounded. */
const OUTPUT_CHAR_CAP = CLASSIFY_MAX_TOKENS * 8

/**
 * The TRIGGER BOUNDARY (owner decision, issue #80): classification may run ONLY on
 *   (a) coverage-extract turns whose question matched the #37/#54 AGGREGATION lexicon — the
 *       engine can list values but not group/sum them, so the answer is wrong-shaped; and
 *   (b) low-confidence relevance fallbacks (`confidence: 'low'` — the router PROVABLY could not
 *       serve the intent it detected: a coverage ask with no extract data, a compare without two
 *       documents).
 * NEVER on the step-5 fallthrough: an ordinary high-confidence relevance question keeps 0 model
 * calls by construction — that is what protects trust in the suggestion surface. Pure, so the
 * golden-set tests pin the boundary directly.
 */
export function isClassificationTrigger(decision: RouteDecision, question: string): boolean {
  if (decision.engine === 'coverage-extract') return isAggregationShaped(question)
  return decision.engine === 'relevance' && decision.confidence === 'low'
}

/**
 * The grammar contract (D55): one object whose single `skill` field is an ENUM of the gated
 * candidate install ids + `none` — the model structurally cannot emit a skill outside the gate,
 * and `none` is always available as the drop target.
 */
export function classifyResponseSchema(candidates: readonly ClassifyCandidate[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['skill'],
    properties: {
      skill: { type: 'string', enum: [...candidates.map((c) => c.installId), CLASSIFY_NONE] }
    }
  }
}

/** The per-call messages. English instructions with the candidate titles verbatim (they carry the
 *  domain words a bilingual question needs to match); biased to prefer `none` when unsure — a
 *  missed offer costs nothing, a wrong offer costs trust. The question is CONTENT: it rides in
 *  the user turn only and is never logged. The prompt still DESCRIBES the JSON shape (llama.cpp
 *  does not inject the schema into the prompt; the grammar only constrains decoding). */
export function buildClassifyMessages(
  question: string,
  candidates: readonly ClassifyCandidate[]
): ChatMessage[] {
  const list = candidates.map((c) => `- ${c.installId}: ${c.title}`).join('\n')
  const system = [
    'You route a user question (English or German) to the ONE specialised document skill that',
    'could answer it better than ordinary retrieval, or to "none". The skills:',
    list,
    '',
    `Rules: pick a skill ONLY when the question clearly asks for that skill's speciality.`,
    `If you are unsure, or no skill clearly fits, answer "${CLASSIFY_NONE}" — preferring`,
    `"${CLASSIFY_NONE}" is always safe. Reply with JSON only: {"skill": "<id>"}.`
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Question:\n${question}` }
  ]
}

/** Parse the reply into a candidate install id or null (`none`, off-list, or unparseable — the
 *  mock runtime's prose lands here, which IS the degrade path dev/test mode exercises). */
function parseClassifyReply(text: string, candidates: readonly ClassifyCandidate[]): ClassifyCandidate | null {
  try {
    const parsed = JSON.parse(stripThinkBlocks(text).trim()) as { skill?: unknown }
    const id = typeof parsed?.skill === 'string' ? parsed.skill : ''
    if (id === '' || id === CLASSIFY_NONE) return null
    return candidates.find((c) => c.installId === id) ?? null
  } catch {
    return null
  }
}

/**
 * Run the ONE bounded classification call and return the picked candidate, or null (= `none`).
 * NEVER throws and never retries (single-shot by design — a second call would double the cost of
 * exactly the turns this is supposed to keep cheap): no runtime / no candidates → null with ZERO
 * model calls; timeout (`CLASSIFY_TIMEOUT_MS`) aborts the request and returns null; a caller
 * abort (user Stop) returns null; an unparseable / off-list / `none` / runaway reply → null.
 * Temperature 0, D55 `responseSchema`, loopback-only via the injected runtime; the reply is
 * discarded after parsing — it never reaches answer content.
 */
export async function classifySkillPointer(
  question: string,
  candidates: readonly ClassifyCandidate[],
  deps: { runtime: ModelRuntime | null; signal: AbortSignal; timeoutMs?: number }
): Promise<ClassifyCandidate | null> {
  const { runtime, signal } = deps
  if (!runtime || candidates.length === 0 || signal.aborted) return null

  // A linked inner signal: aborts on the caller's abort AND on the wall-clock bound, so a stuck
  // runtime can never hold the chat slot past the budget.
  const inner = new AbortController()
  const onOuterAbort = (): void => inner.abort()
  signal.addEventListener('abort', onOuterAbort)
  const timer = setTimeout(() => inner.abort(), deps.timeoutMs ?? CLASSIFY_TIMEOUT_MS)

  try {
    let text = ''
    const stream = runtime.chatStream(buildClassifyMessages(question, candidates), {
      signal: inner.signal,
      maxTokens: CLASSIFY_MAX_TOKENS,
      temperature: 0,
      responseSchema: classifyResponseSchema(candidates),
      responseSchemaName: 'skill_pointer'
    })
    for await (const token of stream) {
      if (inner.signal.aborted) return null
      text += token
      if (text.length > OUTPUT_CHAR_CAP) return null // L-2: bound memory, drop the classification
    }
    if (inner.signal.aborted) return null // aborted/timed out mid-stream — a partial reply is not a pick
    return parseClassifyReply(text, candidates)
  } catch {
    return null // AbortError, a dead sidecar, anything — silent degrade, the answer proceeds
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onOuterAbort)
  }
}
