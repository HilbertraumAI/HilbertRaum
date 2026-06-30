// Yielding deep-index build handlers — tree + structured-extract (DX-1 split,
// full-audit-2026-06-29 follow-up Phase 8). Relocated VERBATIM from `manager.ts`; `this.arbiter`
// became `ctx.arbiter`, `this.deps` → `ctx.deps`, `this.generate` → `ctx.generate`. Behavior
// unchanged.

import type { ModelRuntime } from '../../runtime'
import { buildTree } from '../../analysis/tree-build'
import { extractDocument } from '../../analysis/extract'
import type { DocTaskCtx, InternalTask } from '../context'

/**
 * The deep-index (tree) build: the YIELDING background job that builds the document's
 * hierarchical summary tree (plan §4.1). Registers with the model-slot arbiter for the
 * duration so chat can pause it between nodes and it resumes in-session. Pins the build
 * to the current chat model (M12 — the cache is keyed by it, so a model change can't
 * yield a mixed-model tree). DB-only writer ⇒ no vault lease (L1).
 */
export async function runTreeBuild(
  task: InternalTask,
  runtime: ModelRuntime,
  ctx: DocTaskCtx
): Promise<string> {
  const documentId = task.status.documentIds[0]
  const signal = task.controller.signal
  ctx.arbiter.registerBuild(task.status.jobId)
  try {
    await buildTree(documentId, {
      db: ctx.deps.getDb(),
      modelId: runtime.modelId,
      contextTokens: ctx.deps.getContextTokens(),
      signal,
      arbiter: ctx.arbiter,
      jobId: task.status.jobId,
      generate: (systemPrompt, prompt, maxTokens, temperature, sig) =>
        ctx.generate(runtime, systemPrompt, prompt, maxTokens, temperature, sig),
      onProgress: (done, total) => {
        task.status.progress.stepsDone = done
        task.status.progress.stepsTotal = total
      }
    })
  } finally {
    // Always release the slot ownership — on success, abort, or error — so a later chat
    // never waits on a handoff from a build that is gone.
    ctx.arbiter.unregisterBuild(task.status.jobId)
  }
  return documentId
}

/**
 * The structured-extract pass (whole-document-analysis plan §4.2, Phase 3): the second
 * YIELDING background job. Per chunk it makes one model call to surface structured items,
 * stored in `extraction_records` so a later "list every X" answer is a pure SQL aggregation
 * (0 query-time model calls). Same arbiter handshake + yielding/cancel discipline as the
 * tree build; resumable (already-scanned chunks are skipped via their `__scan__` marker).
 * DB-only writer ⇒ no vault lease (L1). Content is never logged/audited.
 */
export async function runExtract(
  task: InternalTask,
  runtime: ModelRuntime,
  ctx: DocTaskCtx
): Promise<string> {
  const documentId = task.status.documentIds[0]
  const signal = task.controller.signal
  ctx.arbiter.registerBuild(task.status.jobId)
  try {
    await extractDocument(documentId, {
      db: ctx.deps.getDb(),
      modelId: runtime.modelId,
      signal,
      arbiter: ctx.arbiter,
      jobId: task.status.jobId,
      generate: (systemPrompt, prompt, maxTokens, temperature, sig) =>
        ctx.generate(runtime, systemPrompt, prompt, maxTokens, temperature, sig),
      onProgress: (done, total) => {
        task.status.progress.stepsDone = done
        task.status.progress.stepsTotal = total
      }
    })
  } finally {
    ctx.arbiter.unregisterBuild(task.status.jobId)
  }
  return documentId
}
