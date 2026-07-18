import type { DocTaskGaps, TranslationSourceLang, TranslationTargetLang } from '@shared/types'
import { getActiveDocTask, isDocTaskTerminal } from './doctasks'
import { friendlyIpcError } from './errors'
import { clearTranslateSession, getTranslateSession, setLastTranslateChoice } from './translateSession'

// Renderer-side store for the SINGLE active DOCUMENT translation in the Translate view (TG-5,
// plan §2 D7). A dropped or picked document rides the EXISTING translation doc-task — it is NOT
// the live TEXT job (that is `translateSession.ts`). The flow is:
//
//   getDroppedFilePath / pickDocuments → importDocuments(paths, {destination:{kind:'temporary'}})
//   → poll getImportJob until ingested → startDocTask('translation', docId, {sourceLang,targetLang})
//   → poll getDocTask until terminal → load the materialized doc's Markdown (previewDocument)
//   into the SAME output panel + offer Export / "Show in Documents".
//
// No new parsing / IPC path: provenance, audit and encryption invariants ride the doc-task for
// free (security-model.md). The imported source is a TEMPORARY document (never the Library); the
// materialized translation is a Generated document, findable under Documents. We do NOT bespoke-
// delete the temporary source — it rides the existing Temporary-lifecycle retention (owner-gated).
//
// Module-level (NOT inside the screen), like `translateSession`/`doctasks`, so a running document
// translation survives navigating away and back. Privacy: the only content this store holds is the
// materialized translation preview (a Generated document that already lives in the workspace);
// on workspace LOCK `App.lockNow` calls `clearFileTranslate()` (via `lib/lockPurge`'s
// `purgeSessionStores`) to drop it in lockstep with main. It is NOT a screen effect: lock unmounts
// the screen before any effect could observe it (TA-2 / H3 — the old screen-gated purge was dead).
//
// DELIBERATE DEVIATION from plan §4 TG-5's "poll (lib/doctasks.ts store)": we run our OWN
// import + doc-task polling here rather than routing through the GLOBAL `doctasks` store's
// `startTask`. Reason: this store also owns the import step and the result load, and the global
// store is shared with DocumentsScreen/ChatScreen (which acknowledge terminal tasks) — coupling the
// two would race the result load against a foreign `acknowledgeDocTask`. The backend still enforces
// one-task-at-a-time (a real `ctx.docTasks` task), so the D9 lane holds either way; we READ the
// global store only to pre-block a start while a foreign doc task runs.

export type FileTranslateErrorCode =
  | 'multiDrop'
  | 'noPath'
  | 'unsupported'
  | 'scanned'
  | 'importFailed'
  | 'docTaskBusy'
  | 'runtimeFailed'

/** `started` once the pipeline is underway (or a code surfaces), `busy` when one is already
 *  running (text or file), `noop` when there is nothing to translate (empty selection). */
export type FileTranslateOutcome = 'started' | 'busy' | 'noop'

export interface FileTranslateSnapshot {
  state: 'idle' | 'importing' | 'translating' | 'done' | 'failed' | 'cancelled'
  /** Basename of the source document (display only). */
  fileName: string | null
  /** Coarse window progress from the doc-task (`Translating… (3/12)`). */
  windowsDone: number
  windowsTotal: number
  /** The materialized translation preview, on done. */
  output: string
  /** True when `output` is only the START of a long translation (see Export / Documents). */
  truncated: boolean
  /** The materialized document's id — drives Export + "Show in Documents". */
  resultDocumentId: string | null
  /** Issue #58 — the doc-task's honest completeness accounting on done: source pages that
   *  yielded no text + model-failed windows. Null = the output covers the whole source. */
  gaps: DocTaskGaps | null
  /** A CODE the screen maps to friendly copy. */
  error: FileTranslateErrorCode | null
  /** A backend-provided friendly failure message. Doc-task failures are persist-canonical
   *  ENGLISH — the screen localizes at display time via `localizeServerCopy` (DR-7 parity;
   *  full-audit 2026-07-11 CODE-42). */
  errorMessage: string | null
  /** importing || translating — the file path's contribution to the screen's single busy state. */
  busy: boolean
}

const EMPTY: FileTranslateSnapshot = {
  state: 'idle',
  fileName: null,
  windowsDone: 0,
  windowsTotal: 0,
  output: '',
  truncated: false,
  resultDocumentId: null,
  gaps: null,
  error: null,
  errorMessage: null,
  busy: false
}

const POLL_MS = 400

let snapshot: FileTranslateSnapshot = EMPTY
const listeners = new Set<() => void>()
/** The single active poll timer (import THEN doc-task — never both at once). */
let timer: ReturnType<typeof setInterval> | null = null
// Reentrancy latch for the poll callbacks: `setInterval` fires every POLL_MS regardless of whether
// the previous async callback resolved, so a round-trip slower than POLL_MS would let two callbacks
// both observe the same terminal status and double-fire the (non-idempotent) transition — the
// second `startTranslationTask`/`loadResult` would kill the just-installed next-phase timer and
// surface a spurious failure. The latch skips a tick while the prior one is still in flight.
//
// The latch is LOCAL to each `setInterval` closure (a `let inFlight` captured per timer), NOT
// module-level (TA-3 / H4). A shared latch reset by `stopPolling()` could be freed by a STALE
// generation's callback whose slow IPC round-trip resolved after a Stop + re-drop — its
// `finally { inFlight = false }` runs even on the stale-generation early-return, releasing a latch
// owned by the NEW generation's in-flight tick and letting two ticks fire concurrently (→ a double
// `startDocTask`, a zombie backend task on the one-at-a-time lane). A per-timer latch means a stale
// callback only ever frees its own (already-dead) timer's latch.
/**
 * Generation guard (the `translateSession` F8 pattern): a superseding action (a new start, a
 * clear/lock) bumps this so a slower import/start round-trip that resolves after the user moved on
 * detects it is stale and bails instead of wiring a zombie poll over the newer session.
 */
let gen = 0
/**
 * The active translation doc-task's jobId, held so the two cancel paths (supersede + Stop) can
 * issue a jobId-TARGETED cancel (FA-3 / F-6): the backend cancels only when this id IS the active
 * task, so a Stop landing after our task went terminal — with another screen's task now on the
 * lane — can never kill that foreign task. Set when the doc-task starts (or is adopted after a
 * reload); the reset/clear paths drop it. Only ever consulted while `state === 'translating'`.
 */
let docTaskJobId: string | null = null

function notify(): void {
  for (const fn of listeners) fn()
}

function set(next: Partial<FileTranslateSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  notify()
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // No latch reset here (TA-3 / H4): the latch is per-timer, so a cleared timer's latch is already
  // dead and nothing shared could be freed out from under a newer generation's in-flight tick.
}

function fail(code: FileTranslateErrorCode): void {
  stopPolling()
  set({ state: 'failed', error: code, errorMessage: null, busy: false })
}

function failWith(message: string): void {
  stopPolling()
  set({ state: 'failed', error: null, errorMessage: message, busy: false })
}

/**
 * Map the doc-task's raw progress to the WINDOW counts the Translate view labels
 * ("Translating… (3/12)"). The translation doc-task's `stepsTotal` counts the model windows PLUS
 * the final materialize step (`planTranslationWindows`: `windows + 1`), so a 12-window document
 * would otherwise read "(3/13)". The materialize step is subtracted for DISPLAY (F-8) and
 * `windowsDone` is clamped to the window total — the materialize tick that pushes `stepsDone` to
 * `windows + 1` lands exactly as the task goes `done`, when the result panel (not this label) shows.
 * Display-only: the doc-task's real progress contract is untouched. Shared by the fresh-start poll
 * and the post-reload adopt so both show the corrected count.
 */
function windowProgress(p: { stepsDone: number; stepsTotal: number }): {
  windowsDone: number
  windowsTotal: number
} {
  const windowsTotal = Math.max(0, p.stepsTotal - 1)
  return { windowsDone: Math.min(p.stepsDone, windowsTotal), windowsTotal }
}

/** Basename of an absolute path for a friendly label (cross-platform separators). */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

export function subscribeFileTranslate(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot for useSyncExternalStore — a fresh object per change, stable between. */
export function getFileTranslate(): FileTranslateSnapshot {
  return snapshot
}

type Choice = { sourceLang: TranslationSourceLang; targetLang: TranslationTargetLang }

/** Shared start guard: refuse while this store is busy, a live TEXT translation streams, or a
 *  foreign doc task holds the lane (D9). The screen's `busy` prop already disables the triggers;
 *  this defends the one-at-a-time invariant at the store level too (a text stream lives in
 *  `translateSession`, not the global doc-task store, so it is checked explicitly). */
function guardStart(): FileTranslateOutcome | null {
  if (snapshot.busy || getTranslateSession().translating) return 'busy'
  // A foreign doc task blocks us ONLY while it is actually RUNNING — the global store keeps a
  // TERMINAL task visible until a screen acknowledges it, and that lingering done/failed task must
  // not spuriously refuse a translation (the backend `hasActiveTask()` ignores terminal tasks too).
  const foreign = getActiveDocTask()
  if (foreign && !isDocTaskTerminal(foreign.status)) {
    fail('docTaskBusy')
    return 'started'
  }
  return null
}

/**
 * Translate a DROPPED document. Rejects a multi-drop and resolves the single file's on-disk path
 * via the preload `getDroppedFilePath` bridge (a browser-origin drag with no path resolves to '').
 */
export async function translateDroppedFiles(files: File[], choice: Choice): Promise<FileTranslateOutcome> {
  const blocked = guardStart()
  if (blocked) return blocked
  if (files.length === 0) return 'noop'
  if (files.length > 1) {
    fail('multiDrop')
    return 'started'
  }
  const path = window.api?.getDroppedFilePath?.(files[0]) ?? ''
  if (typeof path !== 'string' || path.length === 0) {
    fail('noPath')
    return 'started'
  }
  return runImport([path], undefined, choice)
}

/**
 * Translate a PICKED document (the WCAG 2.5.7 non-drag path). `pickDocuments` returns a one-time
 * capability token main resolves to the exact picked paths (D1) — passed back as `pickerToken`.
 */
export async function translatePickedFile(choice: Choice): Promise<FileTranslateOutcome> {
  const blocked = guardStart()
  if (blocked) return blocked
  let picked
  try {
    picked = await window.api?.pickDocuments?.('files')
  } catch {
    fail('importFailed')
    return 'started'
  }
  if (!picked || picked.paths.length === 0) return 'noop' // user cancelled the dialog
  if (picked.paths.length > 1) {
    fail('multiDrop')
    return 'started'
  }
  // Re-check the start guard AFTER the picker await resolved with a path (TA-3 / M8): a text
  // translation (or another file translation) can start while the OS dialog is open (a non-modal
  // dialog: no focused BrowserWindow, or Linux WM behavior). Without this second check `runImport`
  // would call `clearTranslateSession()` and drop that text job's store WITHOUT cancelling the
  // main-side job (an orphan holding the one-at-a-time lane). On refusal, bail with the outcome and
  // leave the text session untouched — mirroring how a rejected drop keeps the text result.
  const blockedAfter = guardStart()
  if (blockedAfter) return blockedAfter
  return runImport(picked.paths, picked.token, choice)
}

/**
 * Import the source as a TEMPORARY document, then (on ingestion) start the translation doc-task.
 * A drop has no picker token (main hardens the raw paths); a pick passes its token.
 */
async function runImport(paths: string[], token: string | undefined, choice: Choice): Promise<FileTranslateOutcome> {
  const myGen = ++gen
  stopPolling()
  setLastTranslateChoice(choice.sourceLang, choice.targetLang) // shared last-choice memory (text + file)
  // A file translation is actually STARTING now (past every reject guard) — take the panel from
  // any lingering text result. Done HERE, not in the screen's drop handler, so a REJECTED drop
  // (multi-file, no path, foreign task busy) leaves the text result intact behind the error banner.
  clearTranslateSession()
  set({
    ...EMPTY,
    state: 'importing',
    busy: true,
    fileName: baseName(paths[0])
  })

  let job
  try {
    job = await window.api.importDocuments(
      paths,
      token ? { destination: { kind: 'temporary' }, pickerToken: token } : { destination: { kind: 'temporary' } }
    )
  } catch (e) {
    if (myGen === gen) failWith(friendlyIpcError(e))
    return 'started'
  }
  if (myGen !== gen) return 'started' // superseded while the import round-trip was in flight
  // Nothing supported was imported — the DocumentsScreen "no supported documents" precedent.
  if (!job || job.documentIds.length === 0) {
    fail('unsupported')
    return 'started'
  }

  const docId = job.documentIds[0]
  const importJobId = job.jobId
  // Poll ingestion; only once the file is fully indexed can the doc-task run over it.
  let inFlight = false // per-timer reentrancy latch (TA-3 / H4) — see the note by `timer` above.
  timer = setInterval(() => {
    if (inFlight) return // a slower-than-POLL_MS round-trip is still resolving; skip this tick
    inFlight = true
    void (async () => {
      try {
        if (myGen !== gen) {
          stopPolling()
          return
        }
        const status = await window.api.getImportJob(importJobId)
        if (myGen !== gen) return
        if (status.done) {
          stopPolling()
          if (status.completed === 0) {
            // Imported as a SUPPORTED type but ingestion failed (an image-only scan with no text,
            // a corrupt/encrypted PDF) — there is no document to translate. FE-3: read WHY from the
            // failed row and surface an honest reason (a scan → the OCR handoff; else the real
            // message) instead of the misleading "unsupported file type" copy.
            void resolveImportFailure(docId, myGen)
            return
          }
          void startTranslationTask(docId, choice, myGen)
        }
      } catch (e) {
        if (myGen !== gen) return
        failWith(friendlyIpcError(e))
      } finally {
        inFlight = false
      }
    })()
  }, POLL_MS)
  return 'started'
}

/**
 * FE-3: an import that finished with nothing ingested — the source imported as a supported type
 * but its INGESTION failed. Read the failed document's persisted reason (read-only `listDocuments`
 * — no new IPC surface) to tell the user WHY:
 *  - a detected image-only scan (`scanDetected`, derived main-side from the exact scan notice) →
 *    the `scanned` code, whose copy points at the Documents row's "Make searchable (OCR)" action;
 *  - any other ingest failure → surface its localized `error_message` verbatim (the screen routes
 *    it through `localizeServerCopy`, like DocumentsScreen), falling back to the generic
 *    import-failed frame when the row or its message can't be read.
 * The genuinely-unsupported EXTENSION path (nothing imported at all) stays `fail('unsupported')` in
 * `runImport` — this resolver is only reached once a document row exists.
 */
async function resolveImportFailure(docId: string, myGen: number): Promise<void> {
  if (myGen !== gen) return
  let failed
  try {
    const docs = await window.api.listDocuments()
    failed = docs.find((d) => d.id === docId)
  } catch {
    // The list read failed — fall through to the generic import-failed frame below.
  }
  if (myGen !== gen) return
  if (failed?.scanDetected) {
    fail('scanned')
  } else if (failed?.errorMessage) {
    failWith(failed.errorMessage)
  } else {
    fail('importFailed')
  }
}

/** Start the translation doc-task over the ingested temporary document, then poll it to completion. */
async function startTranslationTask(docId: string, choice: Choice, myGen: number): Promise<void> {
  if (myGen !== gen) return
  let started
  try {
    started = await window.api.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: choice.sourceLang, targetLang: choice.targetLang }
    })
  } catch (e) {
    // Backend refusals (a doc task already runs, the model vanished) arrive as friendly messages.
    if (myGen === gen) failWith(friendlyIpcError(e))
    return
  }
  // Superseded WHILE the start round-trip was in flight (Stop / lock / a new start landed during the
  // `importing`→`translating` window): the backend task is now RUNNING but this session is gone.
  // Cancel it so it does not linger as a zombie holding the one-at-a-time lane and materialize an
  // unexpected document (the translateSession supersede-cancel, applied to the doc-task lane).
  if (myGen !== gen) {
    // TARGETED supersede-cancel (FA-3 / F-6): pass OUR just-started task's id so that if the lane
    // was already taken by a newer task (Stop + an immediate new start), the backend no-ops instead
    // of killing that foreign task.
    void window.api?.cancelDocTask?.(started.jobId)?.catch?.(() => {})
    return
  }
  docTaskJobId = started.jobId
  set({ state: 'translating' })
  pollDocTask(started.jobId, myGen)
}

/**
 * Poll a running translation doc-task to its terminal state and drive the panel (progress → result
 * load / failure / cancel). Extracted so both a fresh start (`startTranslationTask`) and a
 * post-reload adoption (`adoptActiveFileTranslation`) resume the SAME loop under their own
 * generation. Installs the single `timer`; the reentrancy latch is LOCAL to this closure (TA-3 / H4).
 */
function pollDocTask(taskJobId: string, myGen: number): void {
  let inFlight = false // per-timer reentrancy latch (TA-3 / H4) — see the import poll above.
  timer = setInterval(() => {
    if (inFlight) return // reentrancy latch — see the import poll above
    inFlight = true
    void (async () => {
      try {
        if (myGen !== gen) {
          stopPolling()
          return
        }
        const status = await window.api.getDocTask(taskJobId)
        if (myGen !== gen) return
        set(windowProgress(status.progress)) // F-8: subtract the materialize step for display
        if (status.state === 'done') {
          stopPolling()
          // #58: capture the completeness accounting BEFORE the result load (whose `set`
          // does not touch it) — the screen shows the gap warning next to the output.
          set({ gaps: status.gaps ?? null })
          void loadResult(status.resultRef?.documentId ?? null, myGen)
        } else if (status.state === 'failed') {
          stopPolling()
          status.error ? failWith(status.error) : fail('runtimeFailed')
        } else if (status.state === 'cancelled') {
          stopPolling()
          set({ state: 'cancelled', busy: false })
        }
      } catch (e) {
        if (myGen !== gen) return
        failWith(friendlyIpcError(e))
      } finally {
        inFlight = false
      }
    })()
  }, POLL_MS)
}

/** Load the materialized translation's Markdown into the output panel (the bounded first page —
 *  a long document shows its start here, with the whole document one Export / "Show in Documents"
 *  away). */
async function loadResult(documentId: string | null, myGen: number): Promise<void> {
  if (myGen !== gen) return
  if (!documentId) {
    // The task finished without a result reference — treat as a runtime failure rather than a
    // silent empty panel.
    if (myGen === gen) fail('runtimeFailed')
    return
  }
  try {
    const preview = await window.api.previewDocument(documentId)
    if (myGen !== gen) return
    const text = preview.segments.map((s) => s.text).join('\n\n').trim()
    set({
      state: 'done',
      busy: false,
      output: text,
      truncated: typeof preview.nextOffset === 'number',
      resultDocumentId: documentId,
      error: null,
      errorMessage: null
    })
  } catch (e) {
    if (myGen === gen) failWith(friendlyIpcError(e))
  }
}

/** Cancel an in-flight document translation (the Stop button). Cancels the doc-task main-side (a
 *  no-op if we are still importing — there is no task yet — but we still supersede + reset). */
export function cancelFileTranslation(): void {
  if (snapshot.state === 'translating' && docTaskJobId) {
    // TARGETED cancel (FA-3 / F-6): pass the held jobId so a Stop landing after our task already
    // went terminal — with another screen's task now on the lane — no-ops instead of killing that
    // foreign task. (Still importing → no task yet → no cancel; we just supersede + reset below.)
    void window.api?.cancelDocTask?.(docTaskJobId)?.catch?.(() => {})
  }
  gen += 1 // supersede any import/start round-trip still in flight
  stopPolling()
  set({ state: 'cancelled', busy: false })
}

/**
 * Remount recovery after a full renderer RELOAD (this module store + its poll timers died with it)
 * for the DOCUMENT/file translation path — the mirror of `translateSession`'s `adoptActiveJob`
 * (FA-3 / F-3). Without it a reloaded Translate screen comes back IDLE while the translation
 * doc-task keeps running in main (no progress, no Stop, no result load), and a fresh attempt is
 * refused with `docTaskBusy` until the invisible task finishes. Called from the screen's mount
 * effect ALONGSIDE `adoptActiveJob`: if main still has a RUNNING translation doc-task, re-seed
 * `translating` + its window progress and resume the poll under a FRESH generation. The source
 * `fileName` is unavailable after a reload (main tracks ids only) — tolerated as null (the panel
 * still shows progress + Stop + result without it).
 *
 * Precedence with the TEXT-path adopt (D9 one-at-a-time lane — a text job and a doc-task can never
 * be active at once): this no-ops when a live TEXT job already owns the panel, when this store
 * already holds a live/terminal session (navigate-away kept it), or when the active task is not a
 * running translation — so the two adopts can never both claim the panel.
 */
export async function adoptActiveFileTranslation(): Promise<void> {
  if (snapshot.busy) return // this store already holds a live session
  if (getTranslateSession().translating) return // the text path owns the panel (precedence)
  let task
  try {
    task = await window.api?.getActiveDocTask?.()
  } catch {
    return
  }
  if (!task || task.kind !== 'translation' || task.state !== 'running') return
  if (snapshot.busy || getTranslateSession().translating) return // a session started while we awaited
  const myGen = ++gen
  stopPolling()
  docTaskJobId = task.jobId
  set({
    ...EMPTY,
    state: 'translating',
    busy: true,
    fileName: null, // unavailable after a reload — main tracks ids only
    ...windowProgress(task.progress) // F-8: subtract the materialize step for display
  })
  pollDocTask(task.jobId, myGen)
}

/**
 * Dismiss a terminal result/error and return the panel to idle (the "Translate another document"
 * affordance + the dismissed-banner-must-not-reappear parity with `translateSession`). Keeps the
 * language choice. No-op while busy.
 */
export function resetFileTranslation(): void {
  if (snapshot.busy) return
  gen += 1
  docTaskJobId = null
  stopPolling()
  snapshot = { ...EMPTY }
  notify()
}

/**
 * Drop ALL resident state for workspace LOCK — main has aborted the doc-task and re-encrypted the
 * vault, so the materialized preview held here must not linger.
 */
export function clearFileTranslate(): void {
  gen += 1
  docTaskJobId = null
  stopPolling()
  snapshot = { ...EMPTY }
  notify()
}

/** Test-only: drop module-level state between renderer tests. */
export function resetFileTranslateSessionForTests(): void {
  stopPolling()
  snapshot = EMPTY
  gen = 0
  docTaskJobId = null
  listeners.clear()
}
