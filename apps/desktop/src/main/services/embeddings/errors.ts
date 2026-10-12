// #634: what went wrong with the search model (the E5 embeddings sidecar), as a TYPE its callers
// map to copy — never as its text. Before #634 a timeout reached the user as the bare English
// "The operation timed out.", and a start failure as llama-server's stderr tail, which names the
// weight file by absolute path (stored on every document imported in that session, because the
// start failure is latched). `rag-design.md` §12.4 "#634 amendment".
//
// Not covered here, on purpose:
// - a user Stop: the caller's own AbortError passes through untouched (a clean cancellation);
// - an engine the operating system refuses to start: `EngineCannotRunError` (#530) keeps its own
//   copy, which names the missing piece.

/**
 * - `timeout`: a request got no complete answer within its deadline (120 s).
 * - `start`: the sidecar could not start — a damaged or incomplete weight file, a crash while
 *   loading, the health budget, a launch or integrity failure of the program.
 * - `failed`: it started, and a request went wrong — an HTTP error, a malformed response, a crash
 *   or a lost connection mid-request.
 * - `interrupted`: a workspace lock or app quit stopped the sidecar under the request.
 */
export type EmbedderFailureKind = 'timeout' | 'start' | 'failed' | 'interrupted'

/**
 * A search-model failure. Its message is a path-free English diagnostic for the local log (the raw
 * detail, path included, is logged once where it happens); no user surface shows it — the row text
 * and the chat copy are chosen by `kind`.
 */
export class EmbedderError extends Error {
  readonly kind: EmbedderFailureKind

  constructor(kind: EmbedderFailureKind, message: string) {
    super(message)
    this.name = 'EmbedderError'
    this.kind = kind
  }
}

/** `instanceof` across module copies is not guaranteed in tests; the name check is the fallback. */
export function isEmbedderError(err: unknown): err is EmbedderError {
  return (
    err instanceof EmbedderError ||
    (err instanceof Error && err.name === 'EmbedderError' && typeof (err as { kind?: unknown }).kind === 'string')
  )
}
