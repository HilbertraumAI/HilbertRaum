// Skills S13a — the offline trigger-evaluation harness (skills-s13-plan.md §3.2/§3.3).
//
// Pure measurement: it scores a labelled SYNTHETIC corpus through the EXISTING deterministic
// selector (`scoreSkillTriggers` / `selectSuggestion` in services/skills/selector.ts) and reports
// precision, recall, and a confusion matrix. NO model, NO network, NO DB (DS4) — so it is a normal
// vitest target and, once a bar is ratified (D1), becomes the regression gate for any selector change.
//
// It changes NO runtime behaviour. The only thing beyond the real selector is a THRESHOLD SWEEP: the
// same `scoreSkillTriggers` scores, but the fire-gate is parameterized so the owner can see where a
// higher bar (the D2 proposal — "require a keyword hit, not a lone doc signal") would land. At the
// current threshold the harness must agree with `selectSuggestion` exactly (a faithfulness guard in
// the test pins this).
//
// Privacy (skills-s13-plan.md §6): a question is CONTENT — it is scored here and NEVER logged. This
// module returns ids/labels/counts only; nothing here writes the question text to any sink.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkillManifestFromDir } from '../../src/main/services/skills/manifest'
import {
  countKeywordHits,
  scoreSkillTriggers,
  selectSuggestion,
  SUGGEST_SCORE_THRESHOLD,
  AUTOFIRE_SCORE_THRESHOLD,
  type SkillCandidate,
  type SkillTriggerContext
} from '../../src/main/services/skills/selector'
import { APP_VOCAB_SKILL_IDS } from '../../src/main/services/skills/vocabulary'

/** The repo root, four levels up from tests/eval/. */
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
/** W5 (audit §6.4/§8.3): ALL EIGHT real app skills form the label space (was 4 — it excluded exactly the
 *  collision-prone Professional-Documents skills). Sourced from the vocabulary so the corpus label space
 *  and the routing/suggestion vocabulary can never diverge. */
const APP_SKILL_IDS = APP_VOCAB_SKILL_IDS

/** One in-scope document's matchable signals (filename + MIME). */
export interface CorpusDoc {
  title: string
  mimeType: string
}

/** One labelled corpus turn (skills-s13-plan.md §3.1). `note` is documentation, never scored. */
export interface CorpusItem {
  id: string
  question: string
  inScopeDocs: CorpusDoc[]
  /** The ground-truth skill id, or 'none' if no skill should fire. */
  expected: string
  /** W5 (audit §8.3): a CROSS-SKILL confusion pair the SUGGESTION policy must get right (fired-wrong 0
   *  over the confusion subset is an asserted bar) — one skill's keyword must win over another's docs or
   *  weaker keyword. Not scored differently; it only marks the subset the bar filters. */
  confusion?: boolean
  /**
   * U4 (audit §4.4): the DOC-SCOPE shape. `'narrowed'` (default) — the `inScopeDocs` are EXPLICITLY in
   * scope (a chat attachment or a hand-pick), so both the suggestion AND the auto-fire path see them.
   * `'whole-corpus'` — the `inScopeDocs` are merely present somewhere in the Library / a collection, NOT
   * explicitly selected: the inert SUGGESTION offer still reads them (full scope), but AUTO-FIRE narrows
   * them away (`explicitDocumentsOnly`), so they contribute no corroborating signal to a silent fire.
   */
  scope?: 'narrowed' | 'whole-corpus'
  note?: string
}

/** Load the committed synthetic corpus (text only — no user data). */
export function loadCorpus(): CorpusItem[] {
  const path = join(REPO_ROOT, 'apps', 'desktop', 'tests', 'fixtures', 'skill-triggers', 'corpus.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items: CorpusItem[] }
  return parsed.items
}

/** Load the real app skills' triggers as selector candidates (installId = the skill id). */
export function loadSkillCandidates(): SkillCandidate[] {
  return APP_SKILL_IDS.map((id) => {
    const res = parseSkillManifestFromDir(join(REPO_ROOT, 'app-skills', id))
    if (!res.ok || !res.manifest) {
      throw new Error(`could not parse app skill '${id}': ${res.errors.join('; ')}`)
    }
    return { installId: res.manifest.id, title: res.manifest.title, triggers: res.manifest.triggers }
  })
}

/** Turn a corpus item into the selector's turn context (the renderer→main scope shape). Full doc
 *  signals — this is the SUGGESTION path's view (`inScopeDocSignals` reads the whole scope). */
export function toContext(item: CorpusItem): SkillTriggerContext {
  return {
    question: item.question,
    docTitles: item.inScopeDocs.map((d) => d.title),
    docMimeTypes: item.inScopeDocs.map((d) => d.mimeType).filter((m) => m.length > 0)
  }
}

/**
 * The AUTO-FIRE path's turn context (U4/audit §4.4): identical to `toContext` EXCEPT a `whole-corpus`
 * item contributes NO doc signal — modelling `inScopeDocSignals(…, {explicitDocumentsOnly:true})`, which
 * counts only EXPLICITLY scoped documents (attachments / hand-picks). A `narrowed` item (the default) is
 * unchanged: its `inScopeDocs` ARE the explicit selection. So one corpus item can carry a real matching
 * Library doc — documenting the §4.4 trap AND exercising the suggestion path with full signals — while
 * the auto-fire path correctly ignores it.
 */
export function toAutoFireContext(item: CorpusItem): SkillTriggerContext {
  if (item.scope === 'whole-corpus') {
    return { question: item.question, docTitles: [], docMimeTypes: [] }
  }
  return toContext(item)
}

/** How many DISTINCT keyword hits a skill lands (the selector's OWN `countKeywordHits` — word-boundary +
 *  longest-match dedupe, W5). Reusing the runtime counter keeps the `keyword-required` policy identical to
 *  the production `selectSuggestion` gate, so the faithfulness guard holds by construction. */
function keywordHits(triggers: SkillCandidate['triggers'], question: string): number {
  return countKeywordHits(triggers.keywords, question)
}

/**
 * A fire policy: given a candidate's deterministic score and its keyword-hit count, decide whether
 * it is ELIGIBLE to fire. The score always comes from the real `scoreSkillTriggers`; the policy only
 * moves the gate. This is what the D2 sweep varies.
 */
export interface FirePolicy {
  name: string
  /** Short human description for the baseline report. */
  description: string
  eligible: (score: number, kwHits: number) => boolean
  /**
   * U4 (audit §4.4): does this policy model the AUTO-FIRE path, which reads only EXPLICITLY scoped
   * documents? When true, `scoreCorpus` scores it through `toAutoFireContext` (a whole-corpus item's doc
   * signals are zeroed). The ratified auto-fire gate (`threshold-3`) sets it; the SUGGESTION policies
   * (`threshold-2`, `keyword-required`) leave it false — the inert offer reads the full scope.
   */
  narrowsDocSignals?: boolean
}

/**
 * The policies the baseline sweeps. `threshold-2` reproduces today's `selectSuggestion` exactly
 * (the faithfulness guard pins this). The rest are the D2 "higher bar" candidates the owner weighs.
 *
 * Note a lone doc signal maxes at MIME(1)+filename(1)=2, so any score ≥ 3 already implies a keyword
 * hit — `threshold-3` is therefore "a keyword corroborated by ≥1 doc signal". `keyword-required` is
 * the literal D2 proposal: require a keyword hit (≥1), reject a lone doc signal, but still accept a
 * lone strong keyword.
 */
export const POLICIES: FirePolicy[] = [
  {
    name: 'threshold-2',
    description: 'current selector (score ≥ 2): one keyword, OR MIME+filename together',
    eligible: (score) => score >= SUGGEST_SCORE_THRESHOLD
  },
  {
    name: 'keyword-required',
    description: 'D2: require a keyword hit (≥1) — a lone doc signal never fires; a lone keyword still does',
    eligible: (score, kwHits) => kwHits >= 1 && score >= SUGGEST_SCORE_THRESHOLD
  },
  {
    // The RATIFIED auto-fire gate (D2): score ≥ AUTOFIRE_SCORE_THRESHOLD ⇒ "a keyword corroborated
    // by ≥1 doc signal". The harness and the runtime (`resolveAutoFireSkill`) share the constant, so
    // the gate-assertion below measures exactly the production threshold. U4/§4.4: it also mirrors the
    // runtime's `explicitDocumentsOnly` narrowing — a whole-corpus doc signal doesn't count here either.
    name: 'threshold-3',
    description: `auto-fire gate (score ≥ ${AUTOFIRE_SCORE_THRESHOLD}): a keyword + ≥1 EXPLICITLY-scoped doc signal`,
    eligible: (score) => score >= AUTOFIRE_SCORE_THRESHOLD,
    narrowsDocSignals: true
  },
  {
    name: 'threshold-4',
    description: 'score ≥ 4 — two keywords, or a keyword + both doc signals',
    eligible: (score) => score >= 4
  }
]

/**
 * Pick the single best candidate that is ELIGIBLE under `policy`, mirroring `selectSuggestion`'s
 * deterministic tie-break (higher score wins; ties break by installId ascending). Returns the skill
 * id, or 'none'.
 */
export function predict(candidates: SkillCandidate[], ctx: SkillTriggerContext, policy: FirePolicy): string {
  let best: SkillCandidate | null = null
  let bestScore = 0
  for (const c of candidates) {
    const score = scoreSkillTriggers(c.triggers, ctx)
    if (!policy.eligible(score, keywordHits(c.triggers, ctx.question))) continue
    if (score > bestScore || (score === bestScore && best != null && c.installId < best.installId)) {
      best = c
      bestScore = score
    }
  }
  return best ? best.installId : 'none'
}

/** The four-cell confusion matrix (skills-s13-plan.md §3.2). */
export interface Confusion {
  firedCorrect: number
  firedWrong: number
  missed: number
  correctlyAbstained: number
}

export interface PolicyResult {
  policy: string
  description: string
  confusion: Confusion
  /** firedCorrect / (firedCorrect + firedWrong); null when nothing fired. */
  precision: number | null
  /** firedCorrect / (firedCorrect + missed); null when nothing was expected to fire. */
  recall: number | null
  /** Per-item ids+labels (NO question text) for an auditable trail. */
  perItem: Array<{ id: string; expected: string; predicted: string }>
}

/** Options for `scoreCorpus`. */
export interface ScoreOptions {
  /**
   * Score every policy on the FULL doc signals, bypassing the auto-fire `narrowsDocSignals` narrowing.
   * Used only by the monotonicity sanity test, which measures the BAR effect on one fixed signal basis —
   * comparing fired-wrong across policies that treat doc signals differently is not a bar comparison.
   */
  forceFullSignals?: boolean
}

/** Score the whole corpus under one policy. Deterministic, content-free output. */
export function scoreCorpus(
  items: CorpusItem[],
  candidates: SkillCandidate[],
  policy: FirePolicy,
  opts: ScoreOptions = {}
): PolicyResult {
  const confusion: Confusion = { firedCorrect: 0, firedWrong: 0, missed: 0, correctlyAbstained: 0 }
  const perItem: PolicyResult['perItem'] = []
  const narrow = policy.narrowsDocSignals && !opts.forceFullSignals
  for (const item of items) {
    const ctx = narrow ? toAutoFireContext(item) : toContext(item)
    const predicted = predict(candidates, ctx, policy)
    const expected = item.expected
    if (predicted !== 'none' && predicted === expected) confusion.firedCorrect++
    else if (predicted !== 'none') confusion.firedWrong++ // wrong skill OR a fire where 'none' was right
    else if (expected !== 'none') confusion.missed++
    else confusion.correctlyAbstained++
    perItem.push({ id: item.id, expected, predicted })
  }
  const fired = confusion.firedCorrect + confusion.firedWrong
  const wanted = confusion.firedCorrect + confusion.missed
  return {
    policy: policy.name,
    description: policy.description,
    confusion,
    precision: fired > 0 ? confusion.firedCorrect / fired : null,
    recall: wanted > 0 ? confusion.firedCorrect / wanted : null,
    perItem
  }
}

/** Run every policy over the corpus. */
export function runBaseline(items: CorpusItem[], candidates: SkillCandidate[]): PolicyResult[] {
  return POLICIES.map((p) => scoreCorpus(items, candidates, p))
}

const pct = (v: number | null): string => (v == null ? '  n/a' : `${(v * 100).toFixed(1)}%`)

/**
 * A human-readable baseline report (metrics + confusion only — NO question text). This is what gets
 * transcribed into the `architecture.md` §18 record (S13a suggestion-selector baseline) for the owner
 * to set D1/D2 — its durable home since `skills-s13-plan.md` §3.3 was deleted at S13 close.
 */
export function formatReport(results: PolicyResult[], corpusSize: number): string {
  const lines: string[] = []
  lines.push(
    `Skills trigger baseline — ${corpusSize} synthetic turns, ${APP_SKILL_IDS.length} app skills as the label space`
  )
  lines.push('')
  lines.push('policy            precision  recall   fired-correct  fired-wrong  missed  abstained')
  for (const r of results) {
    const c = r.confusion
    lines.push(
      [
        r.policy.padEnd(17),
        pct(r.precision).padStart(8),
        pct(r.recall).padStart(8),
        String(c.firedCorrect).padStart(14),
        String(c.firedWrong).padStart(12),
        String(c.missed).padStart(7),
        String(c.correctlyAbstained).padStart(10)
      ].join(' ')
    )
  }
  lines.push('')
  for (const r of results) lines.push(`  ${r.policy}: ${r.description}`)
  return lines.join('\n')
}
