// Translation handler — re-extracted segments in, one materialized Markdown document out (DX-1
// split, full-audit-2026-06-29 follow-up Phase 8). Relocated VERBATIM from `manager.ts`;
// `this.deps` → `ctx.deps`, `this.generateWithRetry` → `ctx.generateWithRetry`, and the shared
// `extractSegmentTexts` / `materializeDocument` / `buildProvenance` now come from `./shared`.
// Behavior unchanged.

import { tMain } from '../../i18n'
import type { ModelRuntime } from '../../runtime'
import { getDocument } from '../../ingestion'
import {
  planTranslationWindows,
  TRANSLATION_TEMPERATURE,
  translationSystemPrompt,
  translationWindowPrompt,
  failedWindowNotice,
  translationAttributionLine,
  translatedDocumentTitle
} from '../translation'
import type { DocTaskCtx, InternalTask } from '../context'
import { buildProvenance, extractSegmentTexts, materializeDocument } from './shared'

/**
 * The translation task: re-extracted parser SEGMENTS in, window-by-window
 * translation in document order (no reduce), one NEW materialized Markdown
 * document out. Returns the new document's id (the `resultRef`).
 */
export async function runTranslation(
  task: InternalTask,
  runtime: ModelRuntime,
  ctx: DocTaskCtx
): Promise<string> {
  const db = ctx.deps.getDb()
  const documentId = task.status.documentIds[0]
  const targetLang = task.targetLang
  if (!targetLang) throw new Error(tMain('main.task.translationTarget'))
  const doc = getDocument(db, documentId)
  if (!doc) throw new Error(tMain('main.task.documentNotReady'))

  // The input is the parser's SEGMENTS re-extracted from the stored copy —
  // ordered and non-overlapping (see the window-math note above; stored chunks
  // would duplicate their ~80-token overlap into the translation).
  const segmentTexts = await extractSegmentTexts(documentId, ctx)

  const plan = planTranslationWindows(segmentTexts, ctx.deps.getContextTokens())
  task.status.progress.stepsTotal = plan.stepsTotal
  const signal = task.controller.signal

  // Map in document order — no reduce. A window the model refuses/garbles is
  // retried ONCE, then MARKED visibly with the original text kept; it is never
  // silently dropped. Only a fully-failed translation fails the task.
  const parts: string[] = []
  let failedWindows = 0
  for (let i = 0; i < plan.windows.length; i++) {
    const translated = await ctx.generateWithRetry(
      runtime,
      translationSystemPrompt(targetLang),
      translationWindowPrompt(targetLang, i + 1, plan.windows.length, plan.windows[i]),
      plan.windowMaxTokens,
      TRANSLATION_TEMPERATURE,
      signal
    )
    if (translated !== null) {
      parts.push(translated)
    } else {
      failedWindows += 1
      parts.push(`${failedWindowNotice(i + 1, plan.windows.length)}\n\n${plan.windows[i]}`)
    }
    task.status.progress.stepsDone += 1
  }
  if (failedWindows === plan.windows.length) throw new Error(tMain('main.task.genericFailure'))

  // Materialize ONLY now that every window succeeded (or is honestly marked) — a
  // cancelled task persists nothing, so the last cancellation point is here.
  if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
  const markdown = `> ${translationAttributionLine(runtime.modelId)}\n\n${parts.join('\n\n')}\n`
  const newDocId = await materializeDocument(
    task,
    markdown,
    translatedDocumentTitle(doc.title, targetLang),
    buildProvenance('translation', [documentId], runtime.modelId, ctx),
    ctx
  )
  task.status.progress.stepsDone += 1
  return newDocId
}
