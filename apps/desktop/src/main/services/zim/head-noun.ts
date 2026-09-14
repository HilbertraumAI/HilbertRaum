import { suggestTitles, type KiwixSearchHit } from './client'
import { TOKEN_RE, isContentWord } from './query-rewrite'

// The head-noun candidate rule (step 1a-i "A1", frozen `head-noun-rule.mjs`, ported here
// verbatim in behaviour) — Phase 4 PR-A, `docs/rag-design.md` §17 "Discovery port (Phase 4
// PR-A)". A German compound noun's HEAD is usually its rightmost component
// ("Gezeitenberg" -> "Gezeiten", "Tischtennisball" -> "Tischtennis"): when the exact
// question-noun does not resolve, trying the head alone against the title index catches a
// title the full compound never matches. The candidate WORDS come from
// `germanCapitalizedNounTokens`, which runs unconditionally (the arm has no per-question
// language signal to gate on) — the compound-splitting/inflection rules below assume German
// morphology, so on a non-German question this simply tends to find fewer/no candidates
// (most non-German words fail every rule and degrade to no probe at all, see `candidates()`),
// never something actively wrong.

const SUFFIXES = ['en', 'es', 's', 'n'] // longest first; ties keep this listed order
const FUGEN = new Set(['s', 'n', 'e'])
const MIN_CANDIDATE_LEN = 3 // matches the arm's own titleCandidates()-style length floor

/** Normalise for title comparison: diacritics folded, ß -> ss, case-insensitive, whitespace
 *  collapsed — the same normalisation the research harness's `retrieval-v3.mjs` `norm()` used,
 *  so a ported admission predicate agrees with it on the same inputs. */
export function norm(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/_/g, ' ')
}

/**
 * `candidates(w)` -> string[], in priority order (most-preferred first):
 *   (1) hyphen split — if `w` contains '-', its parts, LAST first (e.g. "Vierer-Curling" ->
 *       ["Curling","Vierer"]): the rightmost component is the German compound's head noun.
 *   (2) inflection strip — trailing s/n/en/es removed one at a time, longest suffix first:
 *       recovers genitive/plural forms ("Nepals" -> "Nepal").
 *   (3) prefix strip — w[0..k] for k from len(w)-3 down to 4, longest first; for each k, if
 *       that prefix itself ends in a s/n/e Fugenelement, the (k-1)-length variant is also
 *       queued immediately (a probe-budget optimisation — the string itself is always one the
 *       sweep would reach eventually, so this only ever reorders, never adds new values).
 */
export function candidates(w: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (s: string | undefined): void => {
    if (!s) return
    if (s.length < MIN_CANDIDATE_LEN) return
    if (seen.has(s)) return
    seen.add(s)
    out.push(s)
  }

  // (1) hyphen
  if (w.includes('-')) {
    const parts = w
      .split('-')
      .map((p) => p.trim())
      .filter(Boolean)
    for (let i = parts.length - 1; i >= 0; i--) push(parts[i])
  }

  // (2) inflection — the single longest matching suffix only.
  for (const suf of SUFFIXES) {
    if (w.length > suf.length && w.slice(-suf.length).toLowerCase() === suf) {
      push(w.slice(0, w.length - suf.length))
      break
    }
  }

  // (3) prefix, with the Fugenelement shortcut. The floor of 4 applies to BOTH the plain
  // prefix and its Fugenelement variant: an unfloored strip could yield a 3-character
  // candidate that collides with unrelated short titles (acronyms, short names).
  const top = w.length - 3
  for (let k = Math.min(top, w.length - 1); k >= 4; k--) {
    const p = w.slice(0, k)
    push(p)
    const last = p.slice(-1).toLowerCase()
    if (FUGEN.has(last) && p.length - 1 >= 4) push(p.slice(0, -1))
  }

  return out
}

/** Capitalised noun tokens of a question, in question order: tokens starting with an uppercase
 *  Unicode letter, length > 2, and not a stop/frame word (German declarative and interrogative
 *  sentences capitalise every common noun, so this approximates "noun token" without a POS
 *  tagger on German text; on other languages it degrades to ordinary proper-noun capture, which
 *  is harmless — the arm has no language signal at this layer to gate on, so this runs for
 *  every question regardless of language, exactly like the plain pattern rewrite it sits beside). */
export function germanCapitalizedNounTokens(question: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of String(question ?? '').matchAll(TOKEN_RE)) {
    const tok = m[0]
    if (tok.length <= 2) continue
    if (!/^\p{Lu}/u.test(tok)) continue
    if (!isContentWord(tok)) continue
    const key = tok.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tok)
  }
  return out
}

export interface HeadNounProbe {
  candidate: string
  hit: KiwixSearchHit | null
  ok: boolean
}

export interface HeadNounResolution {
  accepted: KiwixSearchHit | null
  candidate: string | null
  probes: number
  tried: HeadNounProbe[]
  candidatesTotal: number
}

/** Probe `candidates(w)` via the title index (`/suggest`); accept the first candidate the
 *  index confirms EXACTLY (normalised). Capped at `maxProbes` (the arm: at most 6 per word,
 *  12 total probes per ask across every word tried — see `arm.ts`). */
export async function resolveHeadNoun(
  port: number,
  name: string,
  w: string,
  signal: AbortSignal | undefined,
  opts: { maxProbes?: number; timeoutMs?: number } = {}
): Promise<HeadNounResolution> {
  const maxProbes = opts.maxProbes ?? 6
  const cands = candidates(w)
  let probes = 0
  const tried: HeadNounProbe[] = []
  for (const cand of cands) {
    if (probes >= maxProbes) break
    probes++
    let hits: KiwixSearchHit[]
    try {
      hits = await suggestTitles(port, name, cand, 1, signal, { timeoutMs: opts.timeoutMs })
    } catch (err) {
      if (signal?.aborted) throw err
      tried.push({ candidate: cand, hit: null, ok: false })
      continue
    }
    const hit = hits[0] ?? null
    const ok = hit !== null && norm(hit.title) === norm(cand)
    tried.push({ candidate: cand, hit, ok })
    if (ok) {
      return { accepted: hit, candidate: cand, probes, tried, candidatesTotal: cands.length }
    }
  }
  return { accepted: null, candidate: null, probes, tried, candidatesTotal: cands.length }
}
