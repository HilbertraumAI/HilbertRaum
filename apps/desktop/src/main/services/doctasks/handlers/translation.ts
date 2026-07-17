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
import { isCleanStop, isTranslationStartError } from '../../translation'
import type { CompletionFinal, Translator } from '../../translation'
import type { TranslationSourceLang, TranslationTargetLang } from '../../../../shared/types'
import {
  planTranslationBlocks,
  failedWindowNotice,
  missingPageNotice,
  translationAttributionLine,
  translatedDocumentTitle
} from '../translation'
import type { DocTaskCtx, InternalTask } from '../context'
import { buildProvenance, extractTranslationSource, materializeDocument } from './shared'

interface WindowRequest {
  sourceLang: TranslationSourceLang
  targetLang: TranslationTargetLang
  text: string
  maxTokens: number
  signal: AbortSignal
}

/**
 * One window on the translation sidecar with a single retry for the TRANSIENT failure classes
 * (the R-T2 policy carried over from the chat path): a thrown or empty window is retried once; a
 * second failure returns null (the caller marks it visibly). Aborts always propagate immediately —
 * cancel must never look like a failed window. `translator.translate()` THROWS on failure and takes
 * sidecar-shaped options (the manager's former chat retry took system+user prompts over
 * `chatStream`), so the retry loop lives here with the handler.
 *
 * TA-5 M6: a non-empty reply is NOT sufficient — the final frame's stop reason is now load-bearing.
 * A window that ran to the output-limit cap (a greedy-decode repetition loop, or a token-dense
 * window) carries no clean stop and is a silent mid-sentence truncation; `isCleanStop(final)` is
 * false, so it is a failed attempt.
 *
 * FA-2 F-2: distinguish the failure classes before retrying. A THROW (the class M1 crash-recovery
 * feeds) or an EMPTY reply is TRANSIENT — retry once. A NON-EMPTY window that did not stop cleanly
 * is a DETERMINISTIC temperature-0 limit-stop: the sidecar decodes greedily with `cache_prompt`, so
 * a retry reproduces the identical truncation and burns another full ~30-min decode for the same
 * marked-window outcome. So a limit-stop returns null immediately (mark now, no futile retry).
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
    let final: CompletionFinal | undefined
    try {
      const out = (
        await translator.translate({
          sourceLang: req.sourceLang,
          targetLang: req.targetLang,
          text: req.text,
          maxTokens: req.maxTokens,
          signal: req.signal,
          onFinal: (info) => {
            final = info
          }
        })
      ).trim()
      // A fake/suspended backend may resolve cleanly on abort; normalize to the throw the
      // orchestrator maps to `cancelled` (the chat path's mock-runtime rule).
      if (req.signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
      // M6: accept only a non-empty window that ALSO stopped cleanly — a limit-stop truncation
      // (no `stoppingWord`/eos in the final frame) is a failed attempt, never a clean window.
      if (out.length > 0 && isCleanStop(final)) return out
      log.warn('Translation window came back empty or truncated', {
        attempt,
        empty: out.length === 0,
        truncated: out.length > 0
      })
      // F-2: a non-empty limit-stop is deterministic — do not burn a second decode reproducing it.
      // (An empty reply falls through to the retry: it is the transient class.) The signal was just
      // re-checked above, so returning here cannot swallow a pending abort.
      if (out.length > 0) return null
    } catch (err) {
      if (isAbortError(err, req.signal)) throw err
      // A LATCHED sidecar start failure (F-7 / FA-4) fails the WHOLE task, not just this window —
      // every window would fail identically, and a retry is futile (the latch re-throws). Log the
      // runtime/stderr string content-free for local diagnosis, then rethrow as the localized
      // "restart / free memory" copy (a FRIENDLY task error the manager passes through verbatim) so
      // the file view shows the actionable message rather than the generic failure or N marked
      // windows. No cause message crosses to the renderer.
      if (isTranslationStartError(err)) {
        log.warn('Translation sidecar start failed', { error: err.message })
        throw new Error(tMain('main.translation.startFailed'))
      }
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
  // would duplicate their ~80-token overlap into the translation). Page numbers +
  // the declared page count ride along for the #58 completeness accounting.
  const source = await extractTranslationSource(documentId, ctx)

  // Window budgets follow the SIDECAR's launched `--ctx-size` (4096 from the manifest,
  // read back via `contextWindow()`) plus the D4 ≤2K-input clamp inside the planner —
  // the chat runtime's context window is irrelevant to translation since TG-3.
  // The plan is BLOCKS (#58): windows to translate, interleaved with gap notices for
  // source pages that yielded no text — those mark the output at their true position.
  const plan = planTranslationBlocks(source.segments, source.pageCount, translator.contextWindow())
  task.status.progress.stepsTotal = plan.stepsTotal
  const signal = task.controller.signal

  // Map in document order — no reduce, strictly SEQUENTIAL windows (D9: the sidecar runs
  // `--parallel 1`, and parallel translation requests are the #25142 Windows-Vulkan hang
  // shape). A window the model refuses/garbles is retried ONCE, then MARKED visibly with
  // the original text kept; it is never silently dropped. Only a fully-failed translation
  // fails the task.
  const parts: string[] = []
  let failedWindows = 0
  let windowIndex = 0
  for (const block of plan.blocks) {
    if (block.kind === 'gap') {
      // A page gap costs no model call and no progress step — just its inline notice.
      parts.push(missingPageNotice(block.gap))
      continue
    }
    windowIndex += 1
    const translated = await translateWithRetry(translator, {
      sourceLang,
      targetLang,
      text: block.text,
      maxTokens: plan.windowMaxTokens,
      signal
    })
    if (translated !== null) {
      parts.push(translated)
    } else {
      failedWindows += 1
      parts.push(`${failedWindowNotice(windowIndex, plan.windowCount)}\n\n${block.text}`)
    }
    task.status.progress.stepsDone += 1
  }
  if (failedWindows === plan.windowCount) throw new Error(tMain('main.task.genericFailure'))

  // #58: surface the honest completeness accounting to the UI poller. Set ONLY when the
  // output is incomplete — absent means "covers the whole source" (the common case).
  if (plan.gaps.length > 0 || failedWindows > 0) {
    task.status.gaps = { missingPageRanges: plan.gaps, failedWindows }
  }

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
