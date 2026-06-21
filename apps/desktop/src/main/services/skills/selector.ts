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
 * The SEPARATE, higher bar an auto-fire (S13b) must clear — the ratified D2 setting
 * (skills-s13-plan.md §2.1). A lone doc signal maxes at MIME(1)+filename(1)=2, so a score ≥ 3
 * STRUCTURALLY means "a keyword hit corroborated by ≥ 1 doc signal" — never a lone keyword and never
 * a lone doc signal. Kept distinct from `SUGGEST_SCORE_THRESHOLD` (the inert in-picker offer stays at
 * 2): auto-fire silently shapes a turn, so it demands the stricter, baseline-proven (100% precision)
 * gate. The §3.3.1 baseline harness asserts this threshold clears the D1 ≥ 95% precision bar.
 */
export const AUTOFIRE_SCORE_THRESHOLD = 3

/**
 * Match a `*statement*`-style filename glob against a title with a LINEAR, non-backtracking matcher
 * (case-insensitive, full-string). `*` matches any run, `?` matches any single char, every other
 * char is literal — identical semantics to the old `^…$`/`i` regex form, but with NO regex engine,
 * so catastrophic backtracking is structurally impossible.
 *
 * ReDoS history (S12-audit guard → vuln-scan 2026-06-21): the previous `globToRegExp` compiled the
 * skill-controlled pattern into a backtracking RegExp and merely capped the number of `*`. That cap
 * (a) counted only `*`, not `?`, so a `*?*?*?…` pattern with ≤ 10 stars slipped through and compiled
 * to `.*..*..*.…` — ten greedy groups separated by `.` — yielding degree-10 polynomial backtracking
 * that froze the main process on a single moderately-long document title; and (b) refused otherwise
 * legitimate wildcard-heavy globs. This greedy two-pointer algorithm (the classic `*`/`?` wildcard
 * match) runs in O(title × pattern) with bounded inputs (the manifest parser caps a pattern at 200
 * chars / 64 entries) and never backtracks exponentially, so the cap is no longer needed and every
 * valid glob now matches.
 */
export function globMatches(pattern: string, title: string): boolean {
  const pat = pattern.toLowerCase()
  const text = title.toLowerCase()
  let p = 0
  let t = 0
  // The last place a `*` was open, so a later mismatch can resume by letting that `*` eat one more
  // char — the bounded "remembered star" that keeps the scan linear instead of recursive.
  let starP = -1
  let starT = 0
  while (t < text.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === text[t])) {
      p++
      t++
    } else if (p < pat.length && pat[p] === '*') {
      starP = p
      starT = t
      p++ // tentatively let `*` match zero chars; the fallback below extends it if needed
    } else if (starP !== -1) {
      p = starP + 1
      starT++
      t = starT // backtrack: the remembered `*` absorbs one more char
    } else {
      return false
    }
  }
  // Any trailing pattern must be all `*` to match the empty remainder of the title.
  while (p < pat.length && pat[p] === '*') p++
  return p === pat.length
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
    return ctx.docTitles.some((t) => globMatches(pat, t))
  })
  return keywordHits * KEYWORD_WEIGHT + (mimeHit ? MIME_WEIGHT : 0) + (filenameHit ? FILENAME_WEIGHT : 0)
}

export interface SkillCandidate {
  installId: string
  title: string
  triggers: SkillTriggers
}

/**
 * Pick the single best-scoring candidate at or above `threshold`, or null. Ties break
 * deterministically by `installId` (ascending) so the choice is stable across runs. Shared by the
 * suggestion offer and the S13b auto-fire decision — the ONLY difference between them is the gate.
 */
function selectByThreshold(
  candidates: SkillCandidate[],
  ctx: SkillTriggerContext,
  threshold: number
): SkillCandidate | null {
  let best: SkillCandidate | null = null
  let bestScore = 0
  for (const c of candidates) {
    const score = scoreSkillTriggers(c.triggers, ctx)
    if (score < threshold) continue
    if (score > bestScore || (score === bestScore && best != null && c.installId < best.installId)) {
      best = c
      bestScore = score
    }
  }
  return best
}

/**
 * Pick the single best-scoring candidate at or above the SUGGESTION threshold, or null. The inert
 * in-picker offer (DS14) — never auto-applied.
 */
export function selectSuggestion(
  candidates: SkillCandidate[],
  ctx: SkillTriggerContext
): SkillCandidate | null {
  return selectByThreshold(candidates, ctx, SUGGEST_SCORE_THRESHOLD)
}

/**
 * Pick the single best AUTO-FIRE candidate at or above `AUTOFIRE_SCORE_THRESHOLD`, or null (S13b).
 * Same deterministic scoring + tie-break as `selectSuggestion`; only the gate is stricter (D2). The
 * caller (`resolveAutoFireSkill`) has already narrowed candidates to enabled + compatible + app-only
 * + `triggers.autoFire` and checked the user opt-in.
 */
export function selectAutoFire(
  candidates: SkillCandidate[],
  ctx: SkillTriggerContext
): SkillCandidate | null {
  return selectByThreshold(candidates, ctx, AUTOFIRE_SCORE_THRESHOLD)
}
