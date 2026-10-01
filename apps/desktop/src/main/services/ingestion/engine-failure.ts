import { t } from '../../../shared/i18n'
import type { EngineProblem } from '../../../shared/types'
import type { Db } from '../db'
import { log } from '../logging'
import {
  classifyLoadFailureMessage,
  isEngineCannotRunError,
  type LoadFailureInput
} from '../runtime/engine-load'

// A document that failed because the AI engine cannot run on this computer (#530). The row's
// `error_message` is persist-canonical English (i18n record §3.3 rule 1), display-mapped in the
// renderer (`displayMap.ts`) — and NEVER the loader's raw line, which carries the absolute drive
// path. Only the library's file name is interpolated, so the Documents row can name it.

/** The persist-canonical row text for an engine the OS refused to start. */
export function engineProblemRowMessage(problem: EngineProblem): string {
  if (problem.family === 'whisper_cpp') return t('en', 'main.ingest.voiceEngineCannotRun')
  if (problem.reason === 'library-missing' && problem.name) {
    return t('en', 'main.ingest.engineLibraryMissing', { library: problem.name })
  }
  return t('en', 'main.ingest.engineCannotRun')
}

/** What a failed document's row says: the canonical engine text, else the error's own message. */
export function failureRowMessage(err: unknown): string {
  if (isEngineCannotRunError(err)) return engineProblemRowMessage(err.problem)
  return err instanceof Error ? err.message : String(err)
}

/**
 * Rows written before #530 hold the embedder's raw start failure — `llama-server exited before
 * becoming healthy (code 127) — last output: /media/<user>/…/llama-server: error while loading
 * shared libraries: libgomp.so.1: …` — absolute path included. Rewrite every one the classifier
 * recognises as a load failure to the canonical text, so the path leaves the database and the row
 * reads in the user's language. Runs once per session start (idempotent: a rewritten row no longer
 * matches the prefix). Any other failed row is left exactly as it is. Returns the number rewritten.
 */
export function rewriteEngineFailureRows(
  db: Db,
  opts: Pick<LoadFailureInput, 'platform' | 'systemDllExists'> = {}
): number {
  const rows = db
    .prepare(
      `SELECT id, error_message AS message FROM documents
       WHERE status = 'failed' AND error_message LIKE 'llama-server exited before becoming healthy%'`
    )
    .all() as Array<{ id: string; message: string }>
  let rewritten = 0
  const update = db.prepare('UPDATE documents SET error_message = ? WHERE id = ?')
  for (const row of rows) {
    const failure = classifyLoadFailureMessage(row.message, opts)
    if (!failure) continue
    update.run(engineProblemRowMessage({ family: 'llama_cpp', ...failure }), row.id)
    rewritten += 1
  }
  if (rewritten > 0) log.info('Rewrote failed-document rows that held a raw engine load failure', { rewritten })
  return rewritten
}
