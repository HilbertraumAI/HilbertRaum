import { AsyncLocalStorage } from 'node:async_hooks'

// PC-1 (skills-tools-audit-2026-06-26 §2.3): an in-process, PER-DOCUMENT async mutex that serializes
// the write-capable run sections across the THREE independent execution lanes that touch the
// bank/invoice tables:
//   - Lane A: the chat-analysis auto-run (`analysis/bank-statement.ts` / `analysis/invoice.ts`),
//   - Lane B: the `SkillRunController` button run (`tool-runs.ts` → the `run.ts`/`invoice-run.ts` seams),
//   - Lane C: the `DocTaskManager` categorize (`doctasks/manager.ts` `runCategorize`).
// Before this, the lanes were mutually unaware (NO cross-lane lock) — now they serialize per document.
//
// This is NOT an OS-thread data race: the main process is single-threaded, so the hazard is COOPERATIVE
// interleaving across `await` points. One lane can be suspended at an await (e.g. while re-reading the
// stored document segments) while another runs its DELETE+INSERT on the SAME document. The cardinal
// case is `runBankExtraction(..., replaceExisting:true)` deleting a statement a second lane is
// mid-read / mid-categorize on → "statement vanished mid-read", orphaned rows, a nondeterministic final
// state. Serializing every write-capable section by `documentId` makes the final state deterministic.
//
// Posture (load-bearing, §14 ceiling intact):
//   - NO new DB/FS/net capability — this is a plain in-memory `Map<documentId, Promise>` chain in the
//     one main process (the workspace DB is single-writer anyway); no schema change, no IPC, no audit.
//   - Content-class boundary intact — the key is a document ID (never content) and nothing is logged.
//   - PER-document granularity — unrelated documents keep running fully concurrently (no global lock).
//   - No deadlock — the lock is FINER-grained than `DocTaskManager.acquireChatSlot()` / the
//     `ModelSlotArbiter`, and is ALWAYS released in a `finally`. The chat-analysis lane acquires the
//     chat slot FIRST and only then the doc lock; Lanes B/C never acquire the chat slot, so there is no
//     party holding the doc lock while waiting on the chat slot — no cycle is possible.
//
// Re-entrancy. A lane wraps its WHOLE multi-step sequence in one `withDocumentLock` (the analysis
// handler's extract→validate→categorize; `runCategorize`'s extract→categorize-persist) so a re-extract
// from another lane cannot slip BETWEEN two of the lane's own steps. The individual write seams it
// calls (`runBankExtraction`, …) ALSO self-lock, so a future caller cannot forget. An
// `AsyncLocalStorage` records the document ids the current async call chain already holds, so a nested
// acquire of an already-held id runs INLINE instead of awaiting the lane's own outer hold forever.
//
// Abort-aware acquisition (SKA-24, skills-audit-2026-07-03 §3.3). Acquisition takes an OPTIONAL
// `AbortSignal`: a waiter still PARKED behind another lane (e.g. a run queued behind a long categorize
// holding the lock for minutes of LLM batches) rejects with an `AbortError` the moment the signal
// fires, instead of showing a dead "running" spinner until the other lane finishes. The chain
// invariant this must preserve: the waiter's tail (`wait.then(() => mine)`) is PUBLISHED into
// `chainTails` BEFORE it parks, so an aborted waiter still resolves its `mine` (it will never run
// `fn`, so nothing else would) and prunes its map entry once the chain drains — otherwise every later
// caller on that document would await a tail that never settles (deadlock forever). The signal is
// consulted ONLY while parked: once `fn` starts, cancellation is the seam's own business (the tools
// check `ctx.signal` cooperatively), and an already-aborted caller facing a FREE lock still runs `fn`
// so the seam records its honest 'cancelled' run row (the pre-R9 tested behaviour).

/** The tail promise of each document's pending lock chain; pruned when the chain drains (no leak). */
const chainTails = new Map<string, Promise<void>>()
/** The set of document ids the current async call chain already holds (for re-entrancy). */
const heldByChain = new AsyncLocalStorage<Set<string>>()

const noop = (): void => {}

/** The content-free rejection an aborted parked waiter throws (SKA-24). The document id is a
 *  content-class-adjacent key and deliberately NOT included in the message. */
function lockWaitAborted(): DOMException {
  return new DOMException('The wait for the document lock was cancelled.', 'AbortError')
}

/**
 * Run `fn` while holding the per-document lock for `documentId`. Calls targeting the SAME document
 * serialize (FIFO); calls for DIFFERENT documents run concurrently. Re-entrant within one async call
 * chain — a nested acquire of an already-held id runs inline (never self-deadlocks). The hold is
 * released — and the map entry pruned when the chain drains — in a `finally`, even if `fn` throws (the
 * rejection propagates to the caller unchanged; the chain still advances).
 *
 * `signal` (optional, SKA-24): while PARKED behind a predecessor, an abort rejects immediately with an
 * `AbortError` — `fn` never runs, no run row is created. The already-published tail still settles
 * (see the abort path below), so later callers are never wedged. Once `fn` is running, the signal is
 * ignored here — cancellation inside the critical section stays cooperative (the seams' own checks).
 */
export async function withDocumentLock<T>(
  documentId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const held = heldByChain.getStore()
  if (held?.has(documentId)) return fn() // re-entrant: this chain already holds this document's lock

  const prior = chainTails.get(documentId)
  // SKA-24: already cancelled AND the chain is live — refuse before publishing anything (nothing to
  // clean up). An already-aborted caller facing a FREE lock proceeds instead: `fn` starts, the seam's
  // own first signal check fires, and the run is recorded 'cancelled' honestly (pre-R9 behaviour).
  if (signal?.aborted && prior !== undefined) throw lockWaitAborted()

  // Our turn comes after `prior` SETTLES — success OR failure: a thrown predecessor must advance the
  // chain, never wedge it. Publish a NEW tail that settles only once OUR `fn` settles, so the next
  // caller in line waits for us.
  const wait = (prior ?? Promise.resolve()).then(noop, noop)
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = wait.then(() => mine)
  chainTails.set(documentId, tail)

  if (signal && prior !== undefined) {
    // Park abort-aware: whichever settles first wins (`wait` never rejects; the abort listener is
    // dropped once the lock is ours, so a later cancel lands in the seam's cooperative checks).
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(lockWaitAborted())
        signal.addEventListener('abort', onAbort, { once: true })
        void wait.then(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    } catch (err) {
      // Aborted while parked. CHAIN INVARIANT (the header): our tail is already PUBLISHED, so we must
      // still resolve `mine` — `fn` will never run, and nothing else would release it — and prune our
      // map entry once the chain drains, or every later caller on this document deadlocks forever.
      release()
      void tail.then(() => {
        if (chainTails.get(documentId) === tail) chainTails.delete(documentId)
      })
      throw err
    }
  } else {
    await wait
  }
  const nextHeld = new Set(held)
  nextHeld.add(documentId)
  try {
    return await heldByChain.run(nextHeld, fn)
  } finally {
    release()
    // Prune when no later caller chained after us — keeps the map bounded by the number of documents
    // with a CURRENTLY pending chain, not by the total ever locked.
    if (chainTails.get(documentId) === tail) chainTails.delete(documentId)
  }
}

/** Test-only: documents with a live (pending) lock chain — proves the map does not leak after runs settle. */
export function activeDocumentLockCount(): number {
  return chainTails.size
}
