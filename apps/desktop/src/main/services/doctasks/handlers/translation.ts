// Translation handler — re-extracted segments in, one materialized Markdown document out (DX-1
// split, full-audit-2026-06-29 follow-up Phase 8). Since TG-3 (translategemma plan §2 D3/D9)
// translation runs on the TranslateGemma SIDECAR (`Translator`), never the chat runtime: windows
// budget against the sidecar's launched `--ctx-size` + the D4 input clamp, each window is one
// `translate()` call (the prompt is built INSIDE the sidecar service — no system/user prompt
// here), and the model id stamped into attribution + provenance is the translation model's.

import { tMain } from '../../i18n'
import { getDocument } from '../../ingestion'
import { isAbortError } from '../../chat'
import { log } from '../../logging'
import type { Translator } from '../../translation'
import type { TranslationSourceLang, TranslationTargetLang } from '../../../../shared/types'
import {
  planTranslationWindows,
  failedWindowNotice,
  translationAttributionLine,
  translatedDocumentTitle
} from '../translation'
import type { DocTaskCtx, InternalTask } from '../context'
import { buildProvenance, extractSegmentTexts, materializeDocument } from './shared'

interface WindowRequest {
  sourceLang: TranslationSourceLang
  targetLang: TranslationTargetLang
  text: string
  maxTokens: number
  signal: AbortSignal
}

/**
 * One window on the translation sidecar with a single retry (the R-T2 policy carried over
 * from the chat path): a thrown or empty window is retried once; a second failure returns
 * null (the caller marks it visibly). Aborts always propagate immediately — cancel must
 * never look like a failed window. `translator.translate()` THROWS on failure and takes
 * sidecar-shaped options (the manager's former chat retry took system+user prompts over
 * `chatStream`), so the retry loop lives here with the handler.
 */
async function translateWithRetry(
  translator: Translator,
  req: WindowRequest
): Promise<string | null> {
  // A cancel that landed BETWEEN windows must not start the next one: translate() would
  // run the sidecar's lazy ensureStarted before its fetch sees the aborted signal — after
  // a workspace-lock suspend that would RESPAWN the just-killed ~10 GB server for nothing.
  if (req.signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = (
        await translator.translate({
          sourceLang: req.sourceLang,
          targetLang: req.targetLang,
          text: req.text,
          maxTokens: req.maxTokens,
          signal: req.signal
        })
      ).trim()
      // A fake/suspended backend may resolve cleanly on abort; normalize to the throw the
      // orchestrator maps to `cancelled` (the chat path's mock-runtime rule).
      if (req.signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
      if (out.length > 0) return out
      log.warn('Translation window came back empty', { attempt })
    } catch (err) {
      if (isAbortError(err, req.signal)) throw err
      log.warn('Translation window failed', {
        attempt,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    if (req.signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
  }
  return null
}

/**
 * The translation task: re-extracted parser SEGMENTS in, window-by-window
 * translation in document order (no reduce), one NEW materialized Markdown
 * document out. Returns the new document's id (the `resultRef`).
 */
export async function runTranslation(
  task: InternalTask,
  translator: Translator,
  ctx: DocTaskCtx
): Promise<string> {
  const db = ctx.deps.getDb()
  const documentId = task.status.documentIds[0]
  const { sourceLang, targetLang } = task
  if (!sourceLang || !targetLang) throw new Error(tMain('main.task.translationTarget'))
  const doc = getDocument(db, documentId)
  if (!doc) throw new Error(tMain('main.task.documentNotReady'))

  // The input is the parser's SEGMENTS re-extracted from the stored copy —
  // ordered and non-overlapping (see the window-math note above; stored chunks
  // would duplicate their ~80-token overlap into the translation).
  const segmentTexts = await extractSegmentTexts(documentId, ctx)

  // Window budgets follow the SIDECAR's launched `--ctx-size` (4096 from the manifest,
  // read back via `contextWindow()`) plus the D4 ≤2K-input clamp inside the planner —
  // the chat runtime's context window is irrelevant to translation since TG-3.
  const plan = planTranslationWindows(segmentTexts, translator.contextWindow())
  task.status.progress.stepsTotal = plan.stepsTotal
  const signal = task.controller.signal

  // Map in document order — no reduce, strictly SEQUENTIAL windows (D9: the sidecar runs
  // `--parallel 1`, and parallel translation requests are the #25142 Windows-Vulkan hang
  // shape). A window the model refuses/garbles is retried ONCE, then MARKED visibly with
  // the original text kept; it is never silently dropped. Only a fully-failed translation
  // fails the task.
  const parts: string[] = []
  let failedWindows = 0
  for (let i = 0; i < plan.windows.length; i++) {
    const translated = await translateWithRetry(translator, {
      sourceLang,
      targetLang,
      text: plan.windows[i],
      maxTokens: plan.windowMaxTokens,
      signal
    })
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
  const markdown = `> ${translationAttributionLine(translator.modelId)}\n\n${parts.join('\n\n')}\n`
  const newDocId = await materializeDocument(
    task,
    markdown,
    translatedDocumentTitle(doc.title, targetLang),
    buildProvenance('translation', [documentId], translator.modelId, ctx),
    ctx
  )
  task.status.progress.stepsDone += 1
  return newDocId
}
