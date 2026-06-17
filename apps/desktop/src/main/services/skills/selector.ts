import type { SkillTriggers } from '../../../shared/skill-manifest'

// Deterministic skill-suggestion scoring (skills plan §10.2 #2/§10.4/DS14, S8). NO model, NO
// network — pure `triggers`-matching, so it is a normal vitest target and doubles as the regression
// guard if trigger rules change. The suggestion is only ever an OFFER surfaced INSIDE the picker
// (never auto-applied, never a canvas chip — §22-D3); auto-fire stays the deferred S13 wave.

/** The turn's matchable signals (resolved main-side from the conversation — §22-C4). */
export interface SkillTriggerContext {
  /** The composer's draft question (CONTENT — scored here, never logged). */
  question: string
  /** Titles (filenames) of the indexed documents in the conversation's scope. */
  docTitles: string[]
  /** MIME types of those in-scope documents. */
  docMimeTypes: string[]
}

// Weights: a topical KEYWORD hit in the question is the strong signal (the user said the thing);
// a matching document type/filename is supporting. The threshold requires either one keyword OR
// both document signals, so a lone "there's a PDF in scope" never fires a suggestion on its own.
const KEYWORD_WEIGHT = 2
const MIME_WEIGHT = 1
const FILENAME_WEIGHT = 1

/** A match must clear this to be offered (one keyword, or mime+filename together). */
export const SUGGEST_SCORE_THRESHOLD = 2

/**
 * Cap on `*` wildcards in a filename glob. A pattern like `*a*a*a…` compiles to `^.*a.*a…$` —
 * the catastrophic-backtracking shape — and the selector runs it against every in-scope doc title
 * on every turn (main-side, synchronous). Triggers are skill-controlled, so even though only an
 * ENABLED skill is scored (a crafted document can never introduce one), an over-complex glob is
 * refused outright rather than risk hanging the main process (S12-audit ReDoS guard; the parser
 * also bounds the pattern length). Legitimate filename globs use a handful of wildcards.
 */
const MAX_GLOB_WILDCARDS = 10

/** Turn a `*statement*`-style filename pattern into a case-insensitive anchored regex, or null if
 *  it is too wildcard-heavy to be safe (the caller then treats it as a non-match). */
function globToRegExp(pattern: string): RegExp | null {
  if ((pattern.match(/\*/g)?.length ?? 0) > MAX_GLOB_WILDCARDS) return null
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * Score one skill's triggers against the turn context. Deterministic, case-insensitive; returns 0
 * when nothing matches. Empty/whitespace trigger entries are ignored.
 */
export function scoreSkillTriggers(triggers: SkillTriggers, ctx: SkillTriggerContext): number {
  const q = ctx.question.toLowerCase()
  const keywordHits = triggers.keywords.filter((k) => {
    const kw = k.trim().toLowerCase()
    return kw.length > 0 && q.includes(kw)
  }).length
  const mimeHit = triggers.mimeTypes.some((m) => m.trim() && ctx.docMimeTypes.includes(m.trim()))
  const filenameHit = triggers.filenamePatterns.some((p) => {
    const pat = p.trim()
    if (!pat) return false
    const re = globToRegExp(pat)
    if (!re) return false // too wildcard-heavy — refused (ReDoS guard), counts as no match
    return ctx.docTitles.some((t) => re.test(t))
  })
  return keywordHits * KEYWORD_WEIGHT + (mimeHit ? MIME_WEIGHT : 0) + (filenameHit ? FILENAME_WEIGHT : 0)
}

export interface SkillCandidate {
  installId: string
  title: string
  triggers: SkillTriggers
}

/**
 * Pick the single best-scoring candidate at or above the threshold, or null. Ties break
 * deterministically by `installId` (ascending) so the offer is stable across runs.
 */
export function selectSuggestion(
  candidates: SkillCandidate[],
  ctx: SkillTriggerContext
): SkillCandidate | null {
  let best: SkillCandidate | null = null
  let bestScore = 0
  for (const c of candidates) {
    const score = scoreSkillTriggers(c.triggers, ctx)
    if (score < SUGGEST_SCORE_THRESHOLD) continue
    if (score > bestScore || (score === bestScore && best != null && c.installId < best.installId)) {
      best = c
      bestScore = score
    }
  }
  return best
}
