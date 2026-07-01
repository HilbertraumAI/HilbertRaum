// Compare handler — two documents in, one materialized "Comparison: A vs B.md" out (DX-1 split,
// full-audit-2026-06-29 follow-up Phase 8). Relocated VERBATIM from `manager.ts`; `this.deps` →
// `ctx.deps`, `this.generate` → `ctx.generate`, and `extractSegmentTexts` / `materializeDocument`
// / `buildProvenance` now come from `./shared`. The two private modes + the symmetric gate are
// module-local functions taking `ctx`. Behavior unchanged.

import { tMain } from '../../i18n'
import type { ModelRuntime } from '../../runtime'
import { getDocument } from '../../ingestion'
import { approxTokenCount, truncateToApproxTokens } from '../../ingestion/chunker'
import { decodeVector } from '../../embeddings'
import { ensureNodeEmbeddings, loadNodeVectors } from '../../analysis/node-vectors'
import {
  planCompareWindows,
  compareBudgetWords,
  compareFitsSinglePass,
  COMPARE_OUTPUT_TOKENS,
  COMPARE_TEMPERATURE,
  COMPARE_NEIGHBORS_PER_CHUNK,
  compareSystemPrompt,
  compareFullPrompt,
  comparePairPrompt,
  compareReducePrompt,
  compareAttributionLine,
  compareTruncationNotice,
  compareSymmetricTruncationNotice,
  compareAsymmetricNotice,
  compareNodePairPrompt,
  comparePairOutputCap,
  compareNearestNeighbors,
  alignNodes,
  SYMMETRIC_COMPARE_CALL_CEILING,
  compareDocumentTitle,
  compareDiffPrompt,
  compareIdenticalReport,
  compareRedlineHeading,
  COMPARE_DIFF_CONTEXT_WORDS,
  COMPARE_DIFF_MAX_CHANGED_RATIO
} from '../compare'
import { wordDiff, renderRedline, renderChangesForModel, isPreciseDiffUseful } from '../../diff'
import type { DocTaskCtx, InternalTask } from '../context'
import { buildProvenance, extractSegmentTexts, materializeDocument } from './shared'

/**
 * The compare task: two documents in, one materialized "Comparison: A vs B.md"
 * report out. The strategy auto-switches on token math — mode (a) when both
 * re-extracted full texts fit one call, else mode (b) section-matched over the
 * stored chunks + vectors. Returns the new document's id.
 */
export async function runCompare(
  task: InternalTask,
  runtime: ModelRuntime,
  ctx: DocTaskCtx
): Promise<string> {
  const db = ctx.deps.getDb()
  const [idA, idB] = task.status.documentIds
  const docA = getDocument(db, idA)
  const docB = getDocument(db, idB)
  if (!docA || !docB) throw new Error(tMain('main.task.documentNotReady'))

  // The mode decision AND mode (a)'s input both use the re-extracted parser
  // segments — exact and non-overlapping. Deciding on stored chunks would inflate
  // the length by the ~80-token overlap (and mode (a) would show the model
  // duplicated text as phantom "shared" content).
  const textA = (await extractSegmentTexts(idA, ctx)).join('\n\n')
  const textB = (await extractSegmentTexts(idB, ctx)).join('\n\n')
  const contextTokens = ctx.deps.getContextTokens()
  const signal = task.controller.signal

  let report: string
  let truncated = false
  let asymmetric = false
  // Mode (d) — DIFF-DRIVEN compare (compare-diff record, architecture.md §20). A deterministic
  // word-level diff is the backbone: it catches an exact one-word change that every model-eyeball
  // mode below misses, and never dismisses repetitive/placeholder text as "identical". It drives the
  // compare ONLY when the two documents are SIMILAR (a real version pair); a rewrite — or docs too
  // different to diff cheaply — returns null and falls through to the thematic modes (a)/(b)/(c).
  const diffReport = await runCompareByDiff(task, runtime, docA, docB, textA, textB, ctx)
  if (diffReport) {
    report = diffReport.report
  } else if (compareFitsSinglePass(approxTokenCount(textA), approxTokenCount(textB), contextTokens)) {
    // Mode (a): one structured-comparison call over both full texts — already symmetric.
    task.status.progress.stepsTotal = 2
    report = await ctx.generate(
      runtime,
      compareSystemPrompt(),
      compareFullPrompt(docA.title, textA, docB.title, textB),
      COMPARE_OUTPUT_TOKENS,
      COMPARE_TEMPERATURE,
      signal
    )
    if (report.length === 0) throw new Error(tMain('main.task.genericFailure'))
    task.status.progress.stepsDone = 1
  } else {
    // Large docs. Prefer the SYMMETRIC both-trees path when both documents are deeply
    // indexed (plan §4.3, H8): align level-1 sections by node-vector cosine and diff each
    // pair, so swapping A/B mirrors. Otherwise fall back to the A-driven mode (b), LABELLED
    // asymmetric (it may under-report content unique to B — the existing honesty note).
    const symmetric = bothTreesReadyForSymmetric(idA, idB, ctx)
      ? await runCompareSymmetricTrees(task, runtime, docA, docB, ctx)
      : null
    if (symmetric) {
      report = symmetric.report
      // A lopsided pair (few aligned sections but many Only-A/Only-B notes) can overflow
      // the reduce input; the belt then drops the tail (the Only-B notes are last), so the
      // symmetric report would silently under-report. Surface the same honest notice mode
      // (b) uses rather than implying a complete two-way comparison (H8).
      truncated = symmetric.truncated
    } else {
      const sectionMatched = await runCompareSectionMatched(task, runtime, docA, docB, ctx)
      report = sectionMatched.report
      truncated = sectionMatched.truncated
      asymmetric = true
    }
  }

  // Materialize: attribution + (honest) asymmetric/truncation notices + report.
  if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
  const markdown =
    `> ${compareAttributionLine(runtime.modelId)}\n\n` +
    (asymmetric ? `${compareAsymmetricNotice(docB.title)}\n\n` : '') +
    (truncated
      ? `${asymmetric ? compareTruncationNotice(docA.title) : compareSymmetricTruncationNotice()}\n\n`
      : '') +
    `${report}\n`
  const newDocId = await materializeDocument(
    task,
    markdown,
    compareDocumentTitle(docA.title, docB.title),
    buildProvenance('compare', [idA, idB], runtime.modelId, ctx),
    ctx
  )
  task.status.progress.stepsDone += 1
  return newDocId
}

/**
 * Mode (d) — DIFF-DRIVEN compare (compare-diff record, architecture.md §20). Runs a deterministic
 * word-level diff over both full texts and, when the two are similar enough that a precise redline
 * is the right deliverable, materializes that redline + a model interpretation of the EXACT changes
 * (never the two whole documents). Returns null to signal "not applicable — fall through to the
 * thematic modes": the docs are too different to diff cheaply (`wordDiff` cutoff), a rewrite (equal
 * share too low / changed-ratio over the gate), or the change list overflows the model budget.
 * Identical documents short-circuit to a deterministic report with NO model call.
 */
async function runCompareByDiff(
  task: InternalTask,
  runtime: ModelRuntime,
  docA: { id: string; title: string },
  docB: { id: string; title: string },
  textA: string,
  textB: string,
  ctx: DocTaskCtx
): Promise<{ report: string } | null> {
  const diff = wordDiff(textA, textB, { context: COMPARE_DIFF_CONTEXT_WORDS })
  if (!diff) return null // edit distance over the cutoff → too different for a precise redline

  // Route only when a precise redline is the right answer (identical, or a real version pair);
  // a rewrite falls through to the thematic modes.
  if (!isPreciseDiffUseful(diff, COMPARE_DIFF_MAX_CHANGED_RATIO)) return null

  // Identical (ground truth): state it plainly, no model call — the old failure was the model
  // waffling over two identical walls of placeholder text.
  if (diff.identical) {
    task.status.progress.stepsTotal = 1 // materialize only
    return { report: compareIdenticalReport() }
  }

  // The model sees the deterministic change list, never the whole documents — so it cannot miss a
  // one-word change. Bail to the thematic modes if the list itself overflows the per-call budget.
  const forModel = renderChangesForModel(diff.changes)
  if (approxTokenCount(forModel.text) > compareBudgetWords(ctx.deps.getContextTokens())) return null

  task.status.progress.stepsTotal = 2 // interpret + materialize
  const interpretation = await ctx.generate(
    runtime,
    compareSystemPrompt(),
    compareDiffPrompt(docA.title, docB.title, forModel.text),
    COMPARE_OUTPUT_TOKENS,
    COMPARE_TEMPERATURE,
    task.controller.signal
  )
  if (interpretation.length === 0) throw new Error(tMain('main.task.genericFailure'))
  task.status.progress.stepsDone += 1
  // The deterministic redline sits ABOVE the interpretation, so the exact wording is always shown.
  const redline = renderRedline(diff.changes)
  return { report: `${compareRedlineHeading()}\n${redline.text}\n\n${interpretation}` }
}

/**
 * Mode (b) — section-matched compare: window doc A's stored chunks, retrieve each
 * window's nearest doc-B chunks (cosine over doc-B's stored vectors, decoded ONCE),
 * compare each matched pair (map), then reduce the notes into the report.
 */
async function runCompareSectionMatched(
  task: InternalTask,
  runtime: ModelRuntime,
  docA: { id: string; title: string },
  docB: { id: string; title: string },
  ctx: DocTaskCtx
): Promise<{ report: string; truncated: boolean }> {
  const db = ctx.deps.getDb()
  const contextTokens = ctx.deps.getContextTokens()
  const signal = task.controller.signal

  // Embedder-visibility guard: the pairing reads stored vectors, so BOTH documents
  // must be visible to the ACTIVE embedder — a stale-embeddings document would
  // silently pair against nothing. Fail friendly with the actionable re-index copy
  // instead.
  const embedder = ctx.deps.getIngestionDeps().embedder
  if (!embedder) throw new Error(tMain('main.task.compareReindex'))
  const embeddedCount = (documentId: string): number => {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n FROM embeddings e JOIN chunks c ON e.chunk_id = c.id
         WHERE c.document_id = ? AND e.embedding_model_id = ?`
      )
      .get(documentId, embedder.id) as unknown as { n: number }
    return r.n
  }
  if (embeddedCount(docA.id) === 0 || embeddedCount(docB.id) === 0) {
    throw new Error(tMain('main.task.compareReindex'))
  }

  // Doc A's chunks in document order, with their STORED vectors (no re-embedding —
  // the pairing must be deterministic and cost nothing but cosine scans).
  const aRows = db
    .prepare(
      `SELECT c.id, c.text, e.vector_blob, e.dimensions
       FROM chunks c JOIN embeddings e ON e.chunk_id = c.id AND e.embedding_model_id = ?
       WHERE c.document_id = ? ORDER BY c.chunk_index`
    )
    .all(embedder.id, docA.id) as unknown as Array<{
    id: string
    text: string
    vector_blob: Uint8Array
    dimensions: number
  }>
  if (aRows.length === 0) throw new Error(tMain('main.task.compareReindex'))

  const plan = planCompareWindows(
    aRows.map((r) => ({ id: r.id, text: r.text })),
    contextTokens
  )
  if (plan.windows.length === 0) throw new Error(tMain('main.task.documentNotReady'))
  task.status.progress.stepsTotal = plan.stepsTotal

  // Skip any physically truncated stored vector (DATA-2): decodeVector returns null, so the
  // A-chunk is simply absent from the map and skipped in the window loop below — a corrupt row
  // degrades the compare gracefully instead of throwing a RangeError that fails the task.
  const vectorByChunk = new Map<string, Float32Array>()
  for (const r of aRows) {
    const vec = decodeVector(r.vector_blob, r.dimensions)
    if (vec) vectorByChunk.set(r.id, vec)
  }
  // RAG-2/ING-1 (perf audit 2026-06-18): load doc-B's chunks ONCE — text, chunk_index AND
  // vector together — and decode each B vector a single time. The previous code ran
  // VectorIndex.search per A-chunk, which re-issued `SELECT … FROM embeddings WHERE chunk_id
  // IN (…doc B…)` and re-decoded EVERY doc-B vector for each A-chunk (O(N_A × N_B) redundant
  // decodes + N_A full re-scans), then re-fetched B's text with a fresh IN(…) per window.
  // Mirrors the alignNodes approach (compare.ts:349): pre-decode both sides, cosine in memory.
  const bRows = db
    .prepare(
      `SELECT c.id, c.text, c.chunk_index, e.vector_blob, e.dimensions
       FROM chunks c JOIN embeddings e ON e.chunk_id = c.id AND e.embedding_model_id = ?
       WHERE c.document_id = ? ORDER BY c.chunk_index`
    )
    .all(embedder.id, docB.id) as unknown as Array<{
    id: string
    text: string
    chunk_index: number
    vector_blob: Uint8Array
    dimensions: number
  }>
  // Skip any physically truncated stored vector (DATA-2): a corrupt B row is simply not a
  // pairing candidate instead of throwing a RangeError that fails the whole compare task.
  const bChunks: Array<{ id: string; text: string; chunkIndex: number; vec: Float32Array }> = []
  for (const r of bRows) {
    const vec = decodeVector(r.vector_blob, r.dimensions)
    if (!vec) continue
    bChunks.push({ id: r.id, text: r.text, chunkIndex: r.chunk_index, vec })
  }
  const bById = new Map(bChunks.map((b) => [b.id, b]))
  // Top-`topK` doc-B neighbors of one A-vector, scored against the resident decoded vectors, no DB
  // round-trip. The pure `compareNearestNeighbors` uses the `dotProduct` fast path (RAG-1: stored
  // vectors are L2-normalized, so dot == cosine ranking) + a running top-K instead of sorting all
  // N_B candidates per A-chunk — IDENTICAL ranking to the previous cosine-sort-slice (P1,
  // full-audit-2026-06-30; same fast path VectorIndex.search uses), at a fraction of the FLOPs.
  const nearestB = (vec: Float32Array, topK: number): Array<{ chunkId: string; score: number }> =>
    compareNearestNeighbors(bChunks, vec, topK)

  const partials: string[] = []
  for (let i = 0; i < plan.windows.length; i++) {
    const window = plan.windows[i]
    // Union of each window chunk's top-N doc-B neighbors, best score kept.
    // Deterministic: scores come from stored vectors; ties break on chunk id.
    const scoreByB = new Map<string, number>()
    for (const chunkId of window.chunkIds) {
      const vec = vectorByChunk.get(chunkId)
      if (!vec) continue
      for (const hit of nearestB(vec, COMPARE_NEIGHBORS_PER_CHUNK)) {
        const prev = scoreByB.get(hit.chunkId)
        if (prev === undefined || hit.score > prev) scoreByB.set(hit.chunkId, hit.score)
      }
    }
    const candidates = [...scoreByB.entries()].sort(
      (x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)
    )
    // Fill the B side best-first up to its word budget; present the picked excerpts
    // in doc-B document order (readability). The first excerpt always fits — a
    // degenerate tiny context hard-truncates it rather than sending nothing. The text +
    // chunk_index come from the resident `bById` map loaded once above (RAG-2: no per-window
    // IN(…) re-fetch).
    const picked: Array<{ text: string; chunkIndex: number }> = []
    let usedWords = 0
    for (const [chunkId] of candidates) {
      const row = bById.get(chunkId)
      if (!row) continue
      const rowWords = approxTokenCount(row.text)
      if (picked.length === 0 && rowWords > plan.pairBudgetWords) {
        picked.push({
          text: truncateToApproxTokens(row.text, plan.pairBudgetWords),
          chunkIndex: row.chunkIndex
        })
        usedWords = plan.pairBudgetWords
        continue
      }
      if (usedWords + rowWords > plan.pairBudgetWords) continue
      picked.push(row)
      usedWords += rowWords
    }
    picked.sort((x, y) => x.chunkIndex - y.chunkIndex)
    const excerptsB = picked.map((p) => p.text).join('\n\n')

    const partial = await ctx.generate(
      runtime,
      compareSystemPrompt(),
      comparePairPrompt(
        docA.title,
        docB.title,
        i + 1,
        plan.windows.length,
        window.text,
        excerptsB
      ),
      plan.mapMaxTokens,
      COMPARE_TEMPERATURE,
      signal
    )
    if (partial.length > 0) partials.push(partial)
    task.status.progress.stepsDone += 1
  }
  if (partials.length === 0) throw new Error(tMain('main.task.genericFailure'))

  // Belt for the reduce input: the map output caps already size the notes to fit,
  // but a model that ignores maxTokens must still not overflow. If it fires it cuts the
  // tail — i.e. the later doc-A windows — so flag it too (alongside the map-ceiling
  // coverage cut) and let the caller surface the honest notice (H8 — never imply full
  // coverage when content was dropped; mirrors the symmetric path).
  const budgetWords = compareBudgetWords(contextTokens)
  let reduceInput = partials
  let beltTruncated = false
  const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
  if (totalWords > budgetWords) {
    reduceInput = [truncateToApproxTokens(partials.join('\n\n'), budgetWords)]
    beltTruncated = true
  }
  const report = await ctx.generate(
    runtime,
    compareSystemPrompt(),
    compareReducePrompt(docA.title, docB.title, reduceInput),
    COMPARE_OUTPUT_TOKENS,
    COMPARE_TEMPERATURE,
    signal
  )
  if (report.length === 0) throw new Error(tMain('main.task.genericFailure'))
  task.status.progress.stepsDone += 1
  return { report, truncated: plan.truncated || beltTruncated }
}

/**
 * Both documents have a ready deep index AND the smaller one has few enough level-1
 * sections that a symmetric pair-by-pair diff stays CPU-bounded (the pair count never
 * exceeds the smaller section count). Gates the SYMMETRIC mode (c); otherwise compare
 * falls back to the labelled asymmetric mode (b).
 */
function bothTreesReadyForSymmetric(idA: string, idB: string, ctx: DocTaskCtx): boolean {
  const db = ctx.deps.getDb()
  const ready = (id: string): boolean => {
    const row = db.prepare('SELECT tree_status FROM documents WHERE id = ?').get(id) as
      | { tree_status: string | null }
      | undefined
    return row?.tree_status === 'ready'
  }
  if (!ready(idA) || !ready(idB)) return false
  const level1Count = (id: string): number =>
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE document_id = ? AND level = 1')
        .get(id) as unknown as { n: number }
    ).n
  return Math.min(level1Count(idA), level1Count(idB)) <= SYMMETRIC_COMPARE_CALL_CEILING
}

/**
 * Mode (c) — SYMMETRIC both-trees compare (plan §4.3, H4/H8). Lazily embeds each tree's
 * nodes under the active embedder (the FIRST consumer of node vectors — L6; reused +
 * H5-staleness-guarded thereafter), aligns each document's level-1 summary SECTIONS by
 * node-vector cosine (`alignNodes`, greedy mutual-best-match with a swap-invariant
 * tie-break), diffs every aligned pair with one `generate` call, attributes unmatched
 * sections to Only-A / Only-B (no model call — node summaries are derived context, never
 * `[Sn]` citations, M2), and reduces the notes into the four-section report. Swapping A/B
 * yields the mirror-image report. Returns null to signal "not applicable — fall back to the
 * asymmetric path" (a degenerate tree with no level-1 vectors). The lazy embed runs on the
 * CPU embedder sidecar, NOT the chat slot, inside the (non-yielding) compare task — still
 * one model job at a time.
 */
async function runCompareSymmetricTrees(
  task: InternalTask,
  runtime: ModelRuntime,
  docA: { id: string; title: string },
  docB: { id: string; title: string },
  ctx: DocTaskCtx
): Promise<{ report: string; truncated: boolean } | null> {
  const db = ctx.deps.getDb()
  const signal = task.controller.signal
  const contextTokens = ctx.deps.getContextTokens()

  // Node vectors are required; the embedder must be present (same friendly copy as mode (b)).
  const embedder = ctx.deps.getIngestionDeps().embedder
  if (!embedder) throw new Error(tMain('main.task.compareReindex'))

  // Lazy node embeddings [L6] under the active embedder; re-embeds any node under a
  // different embedder [H5]; 0 sidecar calls on the warm path.
  await ensureNodeEmbeddings(db, docA.id, embedder, signal)
  await ensureNodeEmbeddings(db, docB.id, embedder, signal)
  if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')

  const aNodes = loadNodeVectors(db, docA.id, 1, embedder.id)
  const bNodes = loadNodeVectors(db, docB.id, 1, embedder.id)
  if (aNodes.length === 0 || bNodes.length === 0) return null // degenerate → asymmetric fallback

  const alignment = alignNodes(aNodes, bNodes)
  // Diffs + reduce + the materialize step (consistent with mode (b)'s stepsTotal accounting).
  task.status.progress.stepsTotal = alignment.pairs.length + 2

  const aById = new Map(aNodes.map((n) => [n.id, n]))
  const bById = new Map(bNodes.map((n) => [n.id, n]))
  const pairCap = comparePairOutputCap(contextTokens, alignment.pairs.length)
  const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 400)

  const partials: string[] = []
  let part = 0
  for (const pair of alignment.pairs) {
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    const sectionA = aById.get(pair.aId)?.summaryText ?? ''
    const sectionB = bById.get(pair.bId)?.summaryText ?? ''
    part += 1
    const note = await ctx.generate(
      runtime,
      compareSystemPrompt(),
      compareNodePairPrompt(docA.title, docB.title, part, alignment.pairs.length, sectionA, sectionB),
      pairCap,
      COMPARE_TEMPERATURE,
      signal
    )
    if (note.length > 0) partials.push(note)
    task.status.progress.stepsDone += 1
  }
  // Unmatched sections → Only-A / Only-B notes with NO model call (M2-safe: the node
  // summary is fed as a note for the reduce, never surfaced as a citation). INTERLEAVE the
  // two sides (A, B, A, B, …) rather than appending all Only-A then all Only-B: if the
  // reduce belt below cuts the tail, an interleaved order sheds both documents' unique
  // content roughly evenly, keeping the loss mirror-symmetric (swapping A/B drops the same
  // sections, off by at most one note at an odd boundary) instead of always sacrificing the
  // Only-B tail first.
  const onlyA = alignment.unmatchedA
    .map((id) => aById.get(id)?.summaryText)
    .filter((s): s is string => !!s && s.trim().length > 0)
    .map((s) => `- Only in A: ${oneLine(s)}`)
  const onlyB = alignment.unmatchedB
    .map((id) => bById.get(id)?.summaryText)
    .filter((s): s is string => !!s && s.trim().length > 0)
    .map((s) => `- Only in B: ${oneLine(s)}`)
  for (let i = 0; i < Math.max(onlyA.length, onlyB.length); i++) {
    if (i < onlyA.length) partials.push(onlyA[i])
    if (i < onlyB.length) partials.push(onlyB[i])
  }
  if (partials.length === 0) throw new Error(tMain('main.task.genericFailure'))

  // Belt for the reduce input (the per-pair caps already size the notes, but a model that
  // ignores maxTokens must still not overflow the reduce call's input budget).
  const budgetWords = compareBudgetWords(contextTokens)
  let reduceInput = partials
  // When the notes overflow the reduce budget, the belt cuts the tail — and the Only-B
  // notes are appended last, so a lopsided pair would silently lose B-unique content.
  // Flag it so the caller materializes the honest truncation notice (H8 — never imply a
  // complete two-way comparison when content was dropped).
  let truncated = false
  if (partials.reduce((n, p) => n + approxTokenCount(p), 0) > budgetWords) {
    reduceInput = [truncateToApproxTokens(partials.join('\n\n'), budgetWords)]
    truncated = true
  }
  const report = await ctx.generate(
    runtime,
    compareSystemPrompt(),
    compareReducePrompt(docA.title, docB.title, reduceInput),
    COMPARE_OUTPUT_TOKENS,
    COMPARE_TEMPERATURE,
    signal
  )
  if (report.length === 0) throw new Error(tMain('main.task.genericFailure'))
  task.status.progress.stepsDone += 1
  return { report, truncated }
}
