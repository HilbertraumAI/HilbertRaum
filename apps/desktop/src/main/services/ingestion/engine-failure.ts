import { t, type MessageKey } from '../../../shared/i18n'
import type { EngineProblem } from '../../../shared/types'
import type { Db } from '../db'
import { isEmbedderError, type EmbedderFailureKind } from '../embeddings/errors'
import { log } from '../logging'
import { failureSignature, isBindRaceError } from '../runtime/sidecar'
import {
  classifyLoadFailureMessage,
  isEngineCannotRunError,
  type LoadFailureInput
} from '../runtime/engine-load'

// A document that failed because the AI engine cannot run on this computer (#530), or because the
// search model failed (#634). The row's `error_message` is persist-canonical English (i18n record
// §3.3 rule 1), display-mapped in the renderer (`displayMap.ts`) — and NEVER the loader's raw line or
// llama-server's stderr tail, which carry the absolute drive path. Only the library's file name is
// interpolated, so the Documents row can name it.

/** The persist-canonical row text for an engine the OS refused to start. */
export function engineProblemRowMessage(problem: EngineProblem): string {
  if (problem.family === 'whisper_cpp') return t('en', 'main.ingest.voiceEngineCannotRun')
  if (problem.reason === 'library-missing' && problem.name) {
    return t('en', 'main.ingest.engineLibraryMissing', { library: problem.name })
  }
  return t('en', 'main.ingest.engineCannotRun')
}

/** #634: the row says what failed and what to do; a lock or quit reads as the interruption it was. */
const SEARCH_MODEL_ROW_KEY: Record<EmbedderFailureKind, MessageKey> = {
  timeout: 'main.ingest.searchModelTimeout',
  start: 'main.ingest.searchModelCannotStart',
  failed: 'main.ingest.searchModelFailed',
  interrupted: 'main.ingest.interrupted'
}

/** What a failed document's row says: the canonical engine or search-model text, else the error's own message. */
export function failureRowMessage(err: unknown): string {
  if (isEngineCannotRunError(err)) return engineProblemRowMessage(err.problem)
  if (isEmbedderError(err)) return t('en', SEARCH_MODEL_ROW_KEY[err.kind])
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

/** Exact texts only the embedder ever stored on a document row before #634. */
const LEGACY_SEARCH_MODEL_TEXT: ReadonlyMap<string, EmbedderFailureKind> = new Map([
  // Our request deadline (`combineSignals`).
  ['The operation timed out.', 'timeout'],
  // undici: a body that ended under the request (before #607 also its own 305 s body limit), and
  // a request to a sidecar that was gone.
  ['terminated', 'failed'],
  ['fetch failed', 'failed'],
  ['Embeddings server failed to start', 'failed'],
  ['llama-server is not started', 'failed'],
  // A lock or quit that stopped the sidecar under the import.
  ['llama-server start aborted', 'interrupted'],
  ['Embedder is stopped (app is shutting down)', 'interrupted'],
  ['Embedder is suspending (workspace is locking)', 'interrupted']
])

/**
 * #634: the kind of search-model failure a row written before #634 holds, or null for any other
 * text. Attributable because ingestion's only network request and only `llama-server` are the
 * embedder's: OCR runs in-process and transcription is a command-line program.
 */
function legacySearchModelFailureKind(message: string): EmbedderFailureKind | null {
  const exact = LEGACY_SEARCH_MODEL_TEXT.get(message)
  if (exact) return exact
  // A llama-server start failure, by the one definition of its shapes (`failureSignature`); a bind
  // race was transient, as the embedder now types it.
  if (failureSignature(message) !== null) return isBindRaceError(message) ? 'failed' : 'start'
  if (/^Embedding (request failed: HTTP |count mismatch:|dimension mismatch:|response mixes indexed and unindexed entries)/.test(message)) {
    return 'failed'
  }
  return null
}

/**
 * #634: rows written before #634 hold the embedder's raw failure — "The operation timed out.",
 * "terminated", or a start failure whose stderr tail names the weight file by absolute path. Rewrite
 * each to its canonical text, once per session start, so the path leaves the database and the row
 * reads in the user's language. Runs after `rewriteEngineFailureRows` and skips any row the #530
 * classifier claims as a load refusal, so that text stays #530's. Every failed row is read and the
 * classifier decides (no second list of texts to drift); the rewrites share one transaction, since
 * a latched start failure stamped every document of its session. Idempotent: a canonical row
 * matches nothing here. Returns the number rewritten.
 */
export function rewriteSearchModelFailureRows(
  db: Db,
  opts: Pick<LoadFailureInput, 'platform' | 'systemDllExists'> = {}
): number {
  const rows = db
    .prepare(`SELECT id, error_message AS message FROM documents WHERE status = 'failed' AND error_message IS NOT NULL`)
    .all() as Array<{ id: string; message: string }>
  const rewrites: Array<{ id: string; text: string }> = []
  for (const row of rows) {
    if (classifyLoadFailureMessage(row.message, opts)) continue
    const kind = legacySearchModelFailureKind(row.message)
    if (kind) rewrites.push({ id: row.id, text: t('en', SEARCH_MODEL_ROW_KEY[kind]) })
  }
  if (rewrites.length === 0) return 0
  const update = db.prepare('UPDATE documents SET error_message = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const r of rewrites) update.run(r.text, r.id)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* connection may already be clean */
    }
    throw err
  }
  log.info('Rewrote failed-document rows that held a raw search-model failure', { rewritten: rewrites.length })
  return rewrites.length
}
