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
// a matching document type/filename is supporting. Since W5 (audit §4.2) a suggestion REQUIRES a keyword
// hit — the doc signals are supporting-only, never a fire on their own — so a library of `statement.pdf`
// plus any PDF no longer stands a permanent question-independent offer. The keyword contribution is CAPPED
// (`MAX_SCORED_KEYWORD_HITS`) so a self-overlapping list can't out-shout a terse one, and overlapping hits
// are deduped longest-match-wins in `countKeywordHits` (so "meeting minutes" counts once, not three times).
const KEYWORD_WEIGHT = 2
const MIME_WEIGHT = 1
const FILENAME_WEIGHT = 1

/**
 * Cap on how many keyword hits count toward the score (audit §4.2). Uncapped, a long self-overlapping list
 * (meeting-protocol ~30 keywords, `meeting minutes` + `meeting` + `minutes`) drowned a terse one (bank 6)
 * in cross-skill competition purely on list length. Two capped hits (→ 4) still outscore one (→ 2), so
 * genuine corroboration wins, but list LENGTH no longer does.
 */
const MAX_SCORED_KEYWORD_HITS = 2

/** A match must clear this AND land ≥1 keyword hit to be offered (a lone doc signal never fires — §4.2). */
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

/** Is a character a letter or digit (Unicode-aware, so umlauts/ß count)? An empty string (a text edge)
 *  is NOT — it is a word boundary. Mirrors `tools/money.ts` `wordIncludes`, which W5's routing gates use;
 *  kept here in one predicate so the SUGGESTION scorer and the routing gates draw word boundaries the same
 *  way (audit §3.2/§4.2). */
function isLetterDigit(c: string): boolean {
  return c !== '' && /[\p{L}\p{N}]/u.test(c)
}

/** The first place a keyword matches the (already-lower-cased) question, or null. A MULTI-WORD keyword is
 *  a phrase (substring); a SINGLE token is word-boundary matched, so `net` never hits "Netflix" and `bill`
 *  never hits "billboard" (audit §3.2). The word-vs-phrase split is inferred from whitespace — the SAME
 *  inference `vocabulary.deriveMatch` uses, so the manifest keywords (mirrored from the vocabulary) match
 *  here exactly as their `word`/`phrase` vocabulary entries route. */
function firstKeywordHit(q: string, kw: string): { start: number; end: number } | null {
  if (/\s/.test(kw)) {
    const i = q.indexOf(kw)
    return i < 0 ? null : { start: i, end: i + kw.length }
  }
  for (let i = q.indexOf(kw); i >= 0; i = q.indexOf(kw, i + 1)) {
    const before = i === 0 ? '' : q[i - 1]
    const after = i + kw.length >= q.length ? '' : q[i + kw.length]
    if (!isLetterDigit(before) && !isLetterDigit(after)) return { start: i, end: i + kw.length }
  }
  return null
}

/**
 * Count DISTINCT keyword hits in a question, deduped longest-match-wins (audit §4.2). Each keyword is
 * matched word-boundary (single token) or substring (phrase) via `firstKeywordHit`; a hit whose span is
 * contained in a longer hit's span is dropped, so "meeting minutes" counts ONCE (not `meeting minutes` +
 * `meeting` + `minutes` = three) and list-length can no longer inflate a score. Case-insensitive;
 * empty/whitespace entries ignored. Exported so the trigger eval harness measures the SAME count the
 * runtime scorer + keyword-required gate use (faithfulness by construction).
 */
export function countKeywordHits(keywords: readonly string[], question: string): number {
  const q = question.toLowerCase()
  const hits: Array<{ start: number; end: number }> = []
  for (const raw of keywords) {
    const kw = raw.trim().toLowerCase()
    if (kw.length === 0) continue
    const hit = firstKeywordHit(q, kw)
    if (hit) hits.push(hit)
  }
  // Longest first, then keep a hit only when no already-kept (longer/equal) hit fully covers its span.
  hits.sort((a, b) => b.end - b.start - (a.end - a.start))
  const kept: Array<{ start: number; end: number }> = []
  for (const h of hits) {
    if (kept.some((k) => k.start <= h.start && h.end <= k.end)) continue
    kept.push(h)
  }
  return kept.length
}

/**
 * Score one skill's triggers against the turn context. Deterministic, case-insensitive; returns 0
 * when nothing matches. Keyword hits are word-boundary/phrase matched, deduped, and CAPPED
 * (`MAX_SCORED_KEYWORD_HITS`); doc signals add at most one each. Empty/whitespace entries are ignored.
 * NOTE: this returns the raw additive score — the keyword-REQUIRED gate (a lone doc signal never fires)
 * lives in `selectByThreshold`, so `scoreSkillTriggers` stays a pure signal measure the eval can sweep.
 */
export function scoreSkillTriggers(triggers: SkillTriggers, ctx: SkillTriggerContext): number {
  const keywordHits = countKeywordHits(triggers.keywords, ctx.question)
  const mimeHit = triggers.mimeTypes.some((m) => m.trim() && ctx.docMimeTypes.includes(m.trim()))
  const filenameHit = triggers.filenamePatterns.some((p) => {
    const pat = p.trim()
    if (!pat) return false
    return ctx.docTitles.some((t) => globMatches(pat, t))
  })
  return (
    Math.min(keywordHits, MAX_SCORED_KEYWORD_HITS) * KEYWORD_WEIGHT +
    (mimeHit ? MIME_WEIGHT : 0) +
    (filenameHit ? FILENAME_WEIGHT : 0)
  )
}

/**
 * Does ONE document match a skill's DOCUMENT signals — its `filenamePatterns` (glob over the title) or
 * `mimeTypes`? The boolean sibling of the mime/filename half of `scoreSkillTriggers`, extracted so the
 * W2 doc-count narrowing (registerRagIpc) and the bank/invoice plausibility gate test a document's
 * plausibility the SAME way the suggestion scorer weighs it (audit §2.1/§4.5) — one definition, no
 * drift. Empty/whitespace entries are ignored; a skill with no doc signals matches nothing.
 *
 * Note the app's standing signal philosophy (see the weights above): the built-in financial skills
 * carry a BROAD `application/pdf` MIME, so a MIME hit alone is weak evidence that a document "is" a
 * statement/invoice — the discriminating signal in practice is the filename pattern (`*statement*`,
 * `*invoice*`). This helper reports either, matching the plan's "filenamePatterns/mimeTypes"; callers
 * that need the stronger signal should lean on the filename match.
 */
export function matchesSkillDocSignals(
  triggers: Pick<SkillTriggers, 'mimeTypes' | 'filenamePatterns'>,
  doc: { title: string; mimeType: string | null }
): boolean {
  const mimeHit =
    doc.mimeType != null && triggers.mimeTypes.some((m) => m.trim() && m.trim() === doc.mimeType)
  const filenameHit = triggers.filenamePatterns.some((p) => {
    const pat = p.trim()
    return pat ? globMatches(pat, doc.title) : false
  })
  return mimeHit || filenameHit
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
    // §4.2 (W5): a suggestion/auto-fire REQUIRES at least one keyword hit — the doc signals are
    // supporting-only. Without this a lone `statement.pdf` in scope stands a permanent question-
    // independent offer (mime + filename = 2 clears the bar). Auto-fire (threshold 3) already implied a
    // keyword; this makes the property explicit and shared by both gates.
    if (countKeywordHits(c.triggers.keywords, ctx.question) < 1) continue
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
