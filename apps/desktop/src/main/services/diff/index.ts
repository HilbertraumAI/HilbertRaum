// Deterministic word-level text diff — the offline backbone of document compare.
//
// WHY THIS EXISTS (compare-diff record, architecture.md §20): a version compare must catch an
// exact one-word change. Before this module every compare path (chat `grounded-whole-doc-compare`
// and the doctask `compare` modes a/b/c) handed two walls of text to the LLM and asked it to
// *eyeball* the differences — which reliably MISSES a single-word deletion buried in repetitive
// text, and makes the model dismiss low-salience/placeholder content as "identical, nothing to
// compare". A deterministic word diff cannot miss it and does not care whether the words are
// "meaningful": it reports the exact added/removed words, which the model then interprets into
// business language (compareDiffPrompt / the chat diff prompt).
//
// ALGORITHM: Myers' greedy O(ND) shortest-edit-script (the same core `diff`/`git` use), with a
// `maxEdits` cutoff. It is near-linear when the two texts are SIMILAR (few edits — the real
// version-compare case) and cheaply BAILS (returns null) when they diverge past the cutoff, which
// is exactly when a precise redline stops being useful and the caller should fall back to the
// thematic section-matched/summary modes. So the cutoff both bounds CPU and routes the compare:
// similar docs → precise redline, dissimilar docs → the existing modes. Pure + deterministic ⇒
// unit-tested without a model.

/** Split text into whitespace-delimited words. Whitespace-only differences (PDF/line reflow
 *  between two exports of the "same" text) collapse away, so they never show up as changes. */
export function tokenizeForDiff(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0)
}

export type DiffOpKind = 'equal' | 'insert' | 'delete'

/** A run of consecutive words with the same disposition (coalesced from the per-word script). */
export interface DiffOp {
  kind: DiffOpKind
  words: string[]
}

/** One contiguous change with up to `context` equal words on each side, ready to render as a
 *  redline or feed to the model. A pure deletion has `added: []`; a pure insertion `removed: []`;
 *  a replacement has both. */
export interface DiffChange {
  before: string[]
  removed: string[]
  added: string[]
  after: string[]
  /** Word index in the OLD text where this change starts (removed/context anchor). Set by
   *  `wordDiff`; used to attribute a change back to its source chunk/page for citations. */
  aStart?: number
  /** Word index in the NEW text where this change starts (added anchor). */
  bStart?: number
}

export interface DiffResult {
  /** The full coalesced edit script (equal/insert/delete runs) in document order. */
  ops: DiffOp[]
  /** Just the changes, each with surrounding context — the compare payload. */
  changes: DiffChange[]
  /** Word tallies (added = in new only, removed = in old only, equal = shared). */
  stats: { added: number; removed: number; equal: number }
  /** True when the two texts are word-for-word identical (no changes). */
  identical: boolean
}

/** Unchanged words kept on each side of a change (readable redline / model context). */
export const DEFAULT_DIFF_CONTEXT_WORDS = 8

/** The diff drives compare only up to this changed-word fraction; above it the two documents are
 *  effectively a rewrite and the thematic (section-matched/summary) modes read better. */
export const DEFAULT_MAX_CHANGED_RATIO = 0.5

/**
 * Should the precise word-diff DRIVE the compare, or should the caller fall back to the thematic
 * modes? True for identical docs and for real version pairs (some shared content, changed fraction
 * within `maxChangedRatio`); false for a rewrite (no/low shared content). The single routing policy
 * shared by the doctask and chat compare paths.
 */
export function isPreciseDiffUseful(
  diff: DiffResult,
  maxChangedRatio: number = DEFAULT_MAX_CHANGED_RATIO
): boolean {
  if (diff.identical) return true
  const changed = diff.stats.added + diff.stats.removed
  const denom = changed + diff.stats.equal
  if (denom === 0 || diff.stats.equal === 0) return false
  return changed / denom <= maxChangedRatio
}

/** Default edit-distance cutoff. Above this the two texts are "too different" for a precise
 *  redline — `wordDiff` returns null and the caller falls back to the thematic compare modes.
 *  Sized generously so real version pairs (which differ in a handful of places) always diff. */
export const DEFAULT_MAX_EDITS = 1200

/** Default per-side word cap. Beyond this, `wordDiff` bails (null) BEFORE running Myers so a very
 *  large document can never make the O((N+M)·D) diff expensive — the caller falls back to the
 *  tree/section modes that are built for large docs. Comfortably covers ordinary version pairs. */
export const DEFAULT_MAX_WORDS = 20000

interface Script {
  /** Per-position edit ops, in document order, before coalescing. */
  kinds: DiffOpKind[]
  words: string[]
}

/**
 * Myers greedy shortest-edit-script over two word arrays. Returns the per-word script, or null
 * when the edit distance exceeds `maxEdits` (bail early — cost is O((N+M)·D), so the cutoff caps
 * it). Space is O(D²) for the trace, bounded by the same cutoff.
 */
function myers(a: string[], b: string[], maxEdits: number): Script | null {
  const n = a.length
  const m = b.length
  const max = Math.min(maxEdits, n + m)
  // v is indexed by diagonal k ∈ [-max, max]; offset by `max` into a flat array.
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      // Move DOWN (insertion from b) when on the bottom edge, or when the down neighbour reaches
      // further than the right neighbour; otherwise move RIGHT (deletion from a).
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]
      } else {
        x = v[offset + k - 1] + 1
      }
      let y = x - k
      // Follow the diagonal (matching words) as far as possible — this is the "snake".
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  if (found < 0) return null // edit distance exceeded the cutoff

  // Backtrack through the saved traces to reconstruct the script (in reverse, then flipped).
  const kinds: DiffOpKind[] = []
  const words: string[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const vPrev = trace[d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = vPrev[offset + prevK]
    const prevY = prevX - prevK
    // Diagonal (equal) moves between (prevX,prevY)-step and the current point.
    while (x > prevX && y > prevY) {
      kinds.push('equal')
      words.push(a[x - 1])
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) {
        // Down move: an insertion from b.
        kinds.push('insert')
        words.push(b[y - 1])
        y--
      } else {
        // Right move: a deletion from a.
        kinds.push('delete')
        words.push(a[x - 1])
        x--
      }
    }
  }
  // Any remaining leading diagonal (the d=0 snake).
  while (x > 0 && y > 0) {
    kinds.push('equal')
    words.push(a[x - 1])
    x--
    y--
  }
  kinds.reverse()
  words.reverse()
  return { kinds, words }
}

/** Coalesce the per-word script into runs of the same kind (document order preserved). */
function coalesce(script: Script): DiffOp[] {
  const ops: DiffOp[] = []
  for (let i = 0; i < script.kinds.length; i++) {
    const kind = script.kinds[i]
    const last = ops[ops.length - 1]
    if (last && last.kind === kind) last.words.push(script.words[i])
    else ops.push({ kind, words: [script.words[i]] })
  }
  return ops
}

/**
 * Turn the coalesced ops into `DiffChange`s: each maximal block of adjacent non-equal ops becomes
 * one change, with up to `context` equal words borrowed from the neighbouring equal runs. Adjacent
 * delete+insert runs merge into a single replacement (both `removed` and `added` populated).
 */
function toChanges(ops: DiffOp[], context: number): DiffChange[] {
  const changes: DiffChange[] = []
  let aIdx = 0 // running word index into the OLD text
  let bIdx = 0 // running word index into the NEW text
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind === 'equal') {
      aIdx += ops[i].words.length
      bIdx += ops[i].words.length
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    const start = i
    const aStart = aIdx
    const bStart = bIdx
    while (i < ops.length && ops[i].kind !== 'equal') {
      if (ops[i].kind === 'delete') {
        removed.push(...ops[i].words)
        aIdx += ops[i].words.length
      } else {
        added.push(...ops[i].words)
        bIdx += ops[i].words.length
      }
      i++
    }
    const prevEqual = ops[start - 1]
    const nextEqual = ops[i]
    const before = prevEqual?.kind === 'equal' ? prevEqual.words.slice(-context) : []
    const after = nextEqual?.kind === 'equal' ? nextEqual.words.slice(0, context) : []
    changes.push({ before, removed, added, after, aStart, bStart })
    i-- // the outer loop's i++ will step past `nextEqual`'s start correctly
  }
  return changes
}

/**
 * Compute a word-level diff of two texts. Returns null when the two are "too different" (edit
 * distance over `maxEdits`) — the signal to fall back to the thematic compare modes. `context` is
 * how many unchanged words to keep on each side of a change (for a readable redline).
 */
export function wordDiff(
  oldText: string,
  newText: string,
  opts: { maxEdits?: number; context?: number; maxWords?: number } = {}
): DiffResult | null {
  const a = tokenizeForDiff(oldText)
  const b = tokenizeForDiff(newText)
  const maxWords = opts.maxWords ?? DEFAULT_MAX_WORDS
  if (a.length > maxWords || b.length > maxWords) return null // too large — fall back to modes
  const context = opts.context ?? 6
  const script = myers(a, b, opts.maxEdits ?? DEFAULT_MAX_EDITS)
  if (!script) return null
  const ops = coalesce(script)
  const changes = toChanges(ops, context)
  let added = 0
  let removed = 0
  let equal = 0
  for (const op of ops) {
    if (op.kind === 'insert') added += op.words.length
    else if (op.kind === 'delete') removed += op.words.length
    else equal += op.words.length
  }
  return { ops, changes, stats: { added, removed, equal }, identical: changes.length === 0 }
}

/** Join a context/removed/added word run for display, collapsing an empty side to ''. */
function words(ws: string[]): string {
  return ws.join(' ')
}

/**
 * Render the changes as a human-readable Markdown redline: one numbered line per change with its
 * context, deletions struck through and insertions bold. `max` caps how many changes are shown
 * (the rest are summarized) so a very long diff can't blow up the output; `truncated` reports it.
 */
export function renderRedline(
  changes: DiffChange[],
  opts: { max?: number } = {}
): { text: string; truncated: boolean } {
  const max = opts.max ?? 200
  const shown = changes.slice(0, max)
  const lines = shown.map((c, i) => {
    const before = c.before.length ? `…${words(c.before)} ` : ''
    const after = c.after.length ? ` ${words(c.after)}…` : ''
    const del = c.removed.length ? `~~${words(c.removed)}~~` : ''
    const ins = c.added.length ? `**${words(c.added)}**` : ''
    const mid = [del, ins].filter(Boolean).join(' ')
    return `${i + 1}. ${before}${mid}${after}`.trim()
  })
  const truncated = changes.length > shown.length
  if (truncated) lines.push(`…and ${changes.length - shown.length} more change(s).`)
  return { text: lines.join('\n'), truncated }
}

/**
 * Render the changes as a compact, model-facing change list for the interpretation prompt. Each
 * change is labelled Removed/Added/Changed with the exact words and a little context, so the model
 * classifies materiality over the DETERMINISTIC changes instead of hunting for them. `max` caps the
 * count; `truncated` reports whether any were dropped.
 */
export function renderChangesForModel(
  changes: DiffChange[],
  opts: { max?: number } = {}
): { text: string; truncated: boolean } {
  const max = opts.max ?? 200
  const shown = changes.slice(0, max)
  const lines = shown.map((c, i) => {
    const ctx = [c.before.length ? `…${words(c.before)}` : '', c.after.length ? `${words(c.after)}…` : '']
      .filter(Boolean)
      .join(' / ')
    let head: string
    if (c.removed.length && c.added.length) head = `Changed: "${words(c.removed)}" → "${words(c.added)}"`
    else if (c.removed.length) head = `Removed: "${words(c.removed)}"`
    else head = `Added: "${words(c.added)}"`
    return `${i + 1}. ${head}${ctx ? `  (context: ${ctx})` : ''}`
  })
  const truncated = changes.length > shown.length
  if (truncated) lines.push(`(+${changes.length - shown.length} further change(s) not listed)`)
  return { text: lines.join('\n'), truncated }
}
