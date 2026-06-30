// Summary handler — stored chunks (or a ready deep index) in, `summary_json` out (DX-1 split,
// full-audit-2026-06-29 follow-up Phase 8). Relocated VERBATIM from `manager.ts`; `this.deps`
// became `ctx.deps`, `this.generate` → `ctx.generate`, and the private `summarizeFromTree`
// became a module-local function taking `ctx`. Behavior unchanged.

import { tMain } from '../../i18n'
import type { CoverageTier, DocumentSummary } from '../../../../shared/types'
import type { ModelRuntime } from '../../runtime'
import { getDocument, setDocumentSummary } from '../../ingestion'
import { approxTokenCount, truncateToApproxTokens } from '../../ingestion/chunker'
import { maxTreeLevel, nodeSummariesAtLevel } from '../../analysis/coverage'
import {
  packIntoWindows,
  planSummaryWindows,
  summaryBudgetWords,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_TEMPERATURE,
  SUMMARY_SYSTEM_PROMPT,
  singlePassPrompt,
  mapPrompt,
  reducePrompt
} from '../summary'
import type { DocTaskCtx, InternalTask } from '../context'

/**
 * Serve a whole-document summary from a READY deep index at the chosen coverage tier
 * (whole-document-analysis plan §4.5). All tiers cover the whole document (`truncated:false`)
 * — they differ in DEPTH, not breadth. Returns the summary, or null to fall through to the
 * capped path. One model job at a time (we run inside the serialized summary task).
 * - Tier 1: the stored ROOT verbatim — 0 model calls (Q6).
 * - Tier 2: the root's children (the layer below the root, which fit ONE budget window by
 *   construction) reduced once → a richer section-by-section summary (1 model call).
 * - Tier 3: ALL level-1 nodes (the deepest summary layer, full leaf coverage) reduced in
 *   budget-bounded batches — bounded by NODE count, never by document size at query time.
 */
async function summarizeFromTree(
  task: InternalTask,
  runtime: ModelRuntime,
  documentId: string,
  title: string,
  tier: CoverageTier,
  ctx: DocTaskCtx
): Promise<DocumentSummary | null> {
  const db = ctx.deps.getDb()
  const root = db
    .prepare('SELECT summary_text, model_id FROM tree_nodes WHERE document_id = ? AND is_root = 1 LIMIT 1')
    .get(documentId) as unknown as { summary_text: string; model_id: string | null } | undefined
  if (!root || root.summary_text.length === 0) return null
  const now = (): string => new Date().toISOString()

  // Tier 1: the stored root verbatim — no model call (Q6).
  if (tier === 1) {
    task.status.progress.stepsTotal = 1
    task.status.progress.stepsDone = 1
    return { text: root.summary_text, modelId: root.model_id ?? runtime.modelId, createdAt: now(), truncated: false, tier: 1 }
  }

  // Tier 2/3 read precomputed node summaries and reduce them.
  const maxLevel = maxTreeLevel(db, documentId)
  const nodeTexts =
    tier === 3
      ? nodeSummariesAtLevel(db, documentId, 1)
      : maxLevel > 1
        ? nodeSummariesAtLevel(db, documentId, maxLevel - 1)
        : []
  // Degenerate tree (a single level, or an empty layer): nothing richer than the root.
  if (nodeTexts.length === 0) {
    task.status.progress.stepsTotal = 1
    task.status.progress.stepsDone = 1
    return { text: root.summary_text, modelId: root.model_id ?? runtime.modelId, createdAt: now(), truncated: false, tier }
  }

  const contextTokens = ctx.deps.getContextTokens()
  const budgetWords = summaryBudgetWords(contextTokens)
  const windows = packIntoWindows(nodeTexts, budgetWords)
  const signal = task.controller.signal
  task.status.progress.stepsTotal = windows.length <= 1 ? 1 : windows.length + 1

  let text: string
  if (windows.length <= 1) {
    // One reduce over the node summaries (Tier 2 always; Tier 3 when they fit one window).
    text = await ctx.generate(
      runtime,
      SUMMARY_SYSTEM_PROMPT,
      reducePrompt(title, windows.length === 1 ? [windows[0]] : nodeTexts),
      SUMMARY_OUTPUT_TOKENS,
      SUMMARY_TEMPERATURE,
      signal
    )
    task.status.progress.stepsDone = 1
  } else {
    // Tier 3 deep tree: reduce each batch (map), then reduce the batch summaries — bounded
    // by node count. Each batch was packed to fit the input budget.
    const partials: string[] = []
    for (const w of windows) {
      const partial = await ctx.generate(
        runtime,
        SUMMARY_SYSTEM_PROMPT,
        reducePrompt(title, [w]),
        SUMMARY_OUTPUT_TOKENS,
        SUMMARY_TEMPERATURE,
        signal
      )
      if (partial.length > 0) partials.push(partial)
      task.status.progress.stepsDone += 1
    }
    if (partials.length === 0) return null
    let reduceInput = partials
    const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
    if (totalWords > budgetWords) {
      reduceInput = [truncateToApproxTokens(partials.join('\n\n'), budgetWords)]
    }
    text = await ctx.generate(
      runtime,
      SUMMARY_SYSTEM_PROMPT,
      reducePrompt(title, reduceInput),
      SUMMARY_OUTPUT_TOKENS,
      SUMMARY_TEMPERATURE,
      signal
    )
    task.status.progress.stepsDone += 1
  }
  if (text.length === 0) return null
  return { text, modelId: runtime.modelId, createdAt: now(), truncated: false, tier }
}

/** The summary task: stored chunks in, `summary_json` out. */
export async function runSummary(
  task: InternalTask,
  runtime: ModelRuntime,
  ctx: DocTaskCtx
): Promise<string> {
  const db = ctx.deps.getDb()
  const documentId = task.status.documentIds[0]
  const doc = getDocument(db, documentId)
  if (!doc) throw new Error(tMain('main.task.documentNotReady'))

  // Tree-first (plan M1/§4.5): when a deep index is ready, serve from it at the requested
  // coverage TIER — Tier 1 (default) returns the stored ROOT verbatim at 0 extra model
  // calls (Q6), Tier 2/3 reduce precomputed node summaries (still whole-document, so
  // `truncated:false`). The existing summary_json / PreviewModal surface is unchanged.
  // Falls through to the capped map-reduce below when there is no ready tree (the fallback).
  const treeRow = db
    .prepare('SELECT tree_status, tree_meta_json FROM documents WHERE id = ?')
    .get(documentId) as unknown as
    | { tree_status: string | null; tree_meta_json: string | null }
    | undefined
  if (treeRow?.tree_status === 'ready' && treeRow.tree_meta_json) {
    const built = await summarizeFromTree(
      task,
      runtime,
      documentId,
      doc.title,
      task.summaryTier ?? 1,
      ctx
    )
    if (built) {
      setDocumentSummary(ctx.deps.getDb(), documentId, built)
      return documentId
    }
  }

  // Input = the document's stored CHUNKS, in order (no re-parse). Adjacent chunks
  // overlap by ~80 tokens (the chunker's retrieval overlap); the slight repetition
  // is harmless for summarization.
  const rows = db
    .prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as unknown as Array<{ text: string }>
  const texts = rows.map((r) => r.text).filter((t) => t.trim().length > 0)
  if (texts.length === 0) throw new Error(tMain('main.task.documentNotReady'))

  const contextTokens = ctx.deps.getContextTokens()
  const plan = planSummaryWindows(texts, contextTokens)
  task.status.progress.stepsTotal = plan.stepsTotal
  const signal = task.controller.signal

  let summaryText: string
  if (plan.singlePass) {
    summaryText = await ctx.generate(
      runtime,
      SUMMARY_SYSTEM_PROMPT,
      singlePassPrompt(doc.title, plan.windows[0] ?? ''),
      SUMMARY_OUTPUT_TOKENS,
      SUMMARY_TEMPERATURE,
      signal
    )
    task.status.progress.stepsDone = 1
  } else {
    const partials: string[] = []
    for (let i = 0; i < plan.windows.length; i++) {
      const partial = await ctx.generate(
        runtime,
        SUMMARY_SYSTEM_PROMPT,
        mapPrompt(doc.title, i + 1, plan.windows.length, plan.windows[i]),
        plan.mapMaxTokens,
        SUMMARY_TEMPERATURE,
        signal
      )
      if (partial.length > 0) partials.push(partial)
      task.status.progress.stepsDone += 1
    }
    if (partials.length === 0) throw new Error(tMain('main.task.genericFailure'))
    // Belt for the reduce input: the map output caps already size partials to fit,
    // but a model that ignores maxTokens semantics must still not overflow.
    const budgetWords = summaryBudgetWords(contextTokens)
    let reduceInput = partials
    const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
    if (totalWords > budgetWords) {
      reduceInput = [truncateToApproxTokens(partials.join('\n\n'), budgetWords)]
    }
    summaryText = await ctx.generate(
      runtime,
      SUMMARY_SYSTEM_PROMPT,
      reducePrompt(doc.title, reduceInput),
      SUMMARY_OUTPUT_TOKENS,
      SUMMARY_TEMPERATURE,
      signal
    )
    task.status.progress.stepsDone += 1
  }

  if (summaryText.length === 0) throw new Error(tMain('main.task.genericFailure'))
  const summary: DocumentSummary = {
    text: summaryText,
    modelId: runtime.modelId,
    createdAt: new Date().toISOString(),
    truncated: plan.truncated
  }
  // Re-read via a fresh getter: the document may have been deleted while we worked
  // (the IPC layer refuses re-index/delete on a busy document, but be safe anyway —
  // the UPDATE on a vanished row is a no-op).
  setDocumentSummary(ctx.deps.getDb(), documentId, summary)
  return documentId
}
