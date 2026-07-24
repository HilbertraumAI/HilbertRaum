import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Banner, Button, EmptyState, Icon, useToast } from '../components'
import { AssistantMarkdown, StreamAnnouncer } from '../chat'
import {
  acknowledgeError,
  adoptActiveJob,
  getLastTranslateChoice,
  getTranslateSession,
  stopActive,
  subscribeTranslateSession,
  translate as runTranslate
} from '../lib/translateSession'
import {
  adoptActiveFileTranslation,
  cancelFileTranslation,
  getFileTranslate,
  resetFileTranslation,
  subscribeFileTranslate,
  translateDroppedFiles,
  translatePickedFile,
  type FileTranslateErrorCode
} from '../lib/fileTranslateSession'
import { TranslateDropZone } from '../translate/TranslateDropZone'
import { localizeServerCopy } from '../lib/displayMap'
import { useT } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import {
  TRANSLATION_LANGUAGE_CODES,
  TRANSLATION_NATIVE_NAMES,
  type TranslateErrorCode,
  type TranslationDeviceStatus,
  type TranslationSourceLang,
  type TranslationTargetLang
} from '@shared/types'

// Translate screen (TranslateGemma wave, plan §2 D6/D7). Type text OR drop/choose a document, pick
// source + target languages, and get a local TranslateGemma translation into ONE output panel with
// ONE busy state. Everything stays local; the live text is transient (nothing persisted).
//
// Two paths, reconciled here:
//  - TEXT (TG-4): a streamed live translation on the `translateSession` module store — survives
//    navigation, per-token render, no numeric progress.
//  - DOCUMENT (TG-5, plan §2 D7): a dropped/picked file rides the EXISTING translation doc-task via
//    the `fileTranslateSession` store (import as Temporary → doc-task → materialized Markdown), with
//    coarse window-count progress and Export / "Show in Documents" actions.
//
// The two are one-at-a-time (D9 lane): the SCREEN's single `busy` disables BOTH triggers while
// either runs, and each path resets the other on start, so at most one session is non-idle. Panel
// OWNERSHIP therefore reduces to "file if the file session is non-idle, else text" — remount-safe
// (no component-local flag) because the module stores hold the state.

// A UI-only "same language" guard joins the backend error codes the banner can show.
type ClientTranslateError = TranslateErrorCode | 'sameLang'

// Codes → friendly banner copy. `noModel` normally shows the availability EmptyState instead (this
// is the rare mid-session-uninstall backstop); `cancelled` is a user action, never a banner.
const ERR_KEY: Partial<Record<ClientTranslateError, MessageKey>> = {
  noModel: 'translate.err.noModel',
  badRequest: 'translate.err.badRequest',
  busy: 'translate.err.busy',
  docTaskBusy: 'translate.err.docTaskBusy',
  runtimeFailed: 'translate.err.runtimeFailed',
  startFailed: 'translate.err.startFailed',
  empty: 'translate.err.empty',
  sameLang: 'translate.err.sameLang'
}

// File-path error CODES → friendly copy (a backend-provided friendly MESSAGE shows verbatim instead).
const FILE_ERR_KEY: Record<FileTranslateErrorCode, MessageKey> = {
  multiDrop: 'translate.file.err.multiDrop',
  noPath: 'translate.file.err.noPath',
  unsupported: 'translate.file.err.unsupported',
  scanned: 'translate.file.err.scanned',
  importFailed: 'translate.file.err.importFailed',
  docTaskBusy: 'translate.err.docTaskBusy',
  runtimeFailed: 'translate.file.err.runtimeFailed'
}

/** "3" / "3–4" / "3–4, 7" — the {pages} value for the #58 gap warning (en-dash, like the
 *  in-document range notice). */
function formatPageRanges(ranges: Array<{ from: number; to: number }>): string {
  return ranges.map((r) => (r.from === r.to ? String(r.from) : `${r.from}–${r.to}`)).join(', ')
}

/** Total missing pages across the ranges — drives the one/other plural of the gap warning. */
function countMissingPages(ranges: Array<{ from: number; to: number }>): number {
  return ranges.reduce((sum, r) => sum + (r.to - r.from + 1), 0)
}

export function TranslateScreen({
  onNavigate
}: {
  onNavigate: (target: string) => void
}): JSX.Element {
  const { t, tCount, lang } = useT()
  const showToast = useToast()
  // null while the first availability read is in flight (a calm placeholder, never a spinner).
  const [available, setAvailable] = useState<boolean | null>(null)
  // The sidecar's last cold-start device outcome (issue #42 reopen) — null before its first
  // start this session. Drives the muted #36-style device hint below the language bar.
  const [device, setDevice] = useState<TranslationDeviceStatus | null>(null)
  const [input, setInput] = useState('')
  // Source+target start from the session's last choice (else a UI-language-aware default), the
  // DocumentsScreen translate-modal precedent. TranslateGemma needs an explicit source — no auto-detect.
  const [choice, setChoice] = useState<{
    sourceLang: TranslationSourceLang
    targetLang: TranslationTargetLang
  }>(
    () =>
      getLastTranslateChoice() ??
      (lang === 'de'
        ? { sourceLang: 'en', targetLang: 'de' }
        : { sourceLang: 'de', targetLang: 'en' })
  )
  const [screenError, setScreenError] = useState<ClientTranslateError | null>(null)

  // The active TEXT translation (streamed output) lives in the module store so it survives
  // navigating away and back (it keeps streaming there).
  const { output, state, error, translating } = useSyncExternalStore(
    subscribeTranslateSession,
    getTranslateSession
  )
  // The active DOCUMENT translation (import → doc-task → materialized Markdown) lives in its own
  // module store, likewise navigation-surviving.
  const fileTx = useSyncExternalStore(subscribeFileTranslate, getFileTranslate)

  // The file session owns the panel whenever it is non-idle; otherwise the text session does.
  const fileActive = fileTx.state !== 'idle'
  // ONE busy state across both paths (drives the Stop button + disables BOTH triggers).
  const busy = translating || fileTx.busy

  const checkStatus = useCallback(async (): Promise<void> => {
    try {
      const st = await window.api?.getAppStatus?.()
      if (st) {
        setAvailable(st.translationAvailable)
        // Issue #42 reopen: the device hint. `?? null` keeps a partial bridge (older status
        // shape without the field) rendering no hint rather than crashing.
        setDevice(st.translationDevice ?? null)
      }
    } catch {
      // No status (partial bridge) → calm unavailable, never a crash.
      setAvailable(false)
    }
  }, [])

  // Availability on mount; re-check on focus (the model may have been installed on the AI Model
  // screen and the user navigated back). Issue #40: a completed in-app download now RE-RUNS the
  // translation selector in main (`AppContext.onModelInstalled`), so the mount/focus re-read here
  // is what makes a mid-session install show up without a restart — and it keeps the flag honest
  // across a lock/unlock.
  useEffect(() => {
    void checkStatus()
    const onFocus = (): void => void checkStatus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkStatus])

  // Remount recovery after a full renderer reload: re-adopt a still-running job from main — the
  // TEXT view job AND (FA-3 / F-3) the DOCUMENT translation doc-task, which previously came back
  // idle (no progress/Stop/result) while the task ran on invisibly. Each is a no-op when the store
  // already holds one (navigate-away kept it alive) or nothing of its kind is running; the D9 lane
  // means at most one is ever live, and the file adopt yields to a live text job, so they can't
  // both claim the panel.
  useEffect(() => {
    void adoptActiveJob()
    void adoptActiveFileTranslation()
  }, [])

  // NB: there is deliberately NO lock-purge effect here. Workspace lock unmounts this screen (the
  // shell swaps to WorkspaceGate) the moment it happens, so a screen effect could never observe it
  // — the purge of the module stores runs at the real seam, App.lockNow → purgeSessionStores (TA-2).

  const sameLang = choice.sourceLang === choice.targetLang

  // Issue #42 reopen: keep the device hint live around a run. The sidecar cold-starts INSIDE a
  // translate (its outcome exists only once the model has loaded, seconds-to-a-minute in), so the
  // mount/focus reads above can't see it — poll gently while busy, and read once more when the
  // run settles (that read also reflects a mid-run CPU fallback). 4 s is a cheap local IPC and
  // far under any cold start + first window.
  useEffect(() => {
    if (!busy) {
      void checkStatus()
      return
    }
    const id = setInterval(() => void checkStatus(), 4000)
    return () => clearInterval(id)
  }, [busy, checkStatus])

  // The #36-style muted device line: posture + the parsed offload split of the LAST cold start.
  // The partial-offload form is the point of the feature — under GPU auto-offload a large resident
  // chat model can leave the translator a sliver of VRAM, which decodes at ~processor speed and
  // would otherwise be indistinguishable from "GPU translation not working"; its tooltip explains
  // the cause and the remedy (smaller chat model; the ~2-min idle teardown re-fits).
  const deviceHint = ((): { text: string; title: string } | null => {
    if (!device) return null
    if (device.device === 'cpu') {
      return { text: t('translate.device.cpu'), title: t('translate.device.title') }
    }
    if (device.gpuLayers != null && device.totalLayers != null) {
      // Fully starved (0 layers fit): "runs only partly on the graphics card (0/49 layers)"
      // contradicted itself — say processor plainly (full-audit 2026-07-11 CODE-23).
      if (device.gpuLayers === 0) {
        return {
          text: t('translate.device.gpuNone', { total: device.totalLayers }),
          title: t('translate.device.gpuNoneTitle')
        }
      }
      const partial = device.gpuLayers < device.totalLayers
      const params = { done: device.gpuLayers, total: device.totalLayers }
      return {
        text: t(partial ? 'translate.device.gpuPartial' : 'translate.device.gpu', params),
        title: t(partial ? 'translate.device.partialTitle' : 'translate.device.title')
      }
    }
    // GPU posture but the server printed no offload line — say GPU without inventing a split.
    return { text: t('translate.device.gpuUnknown'), title: t('translate.device.title') }
  })()

  function onTranslate(): void {
    setScreenError(null)
    if (sameLang) {
      setScreenError('sameLang')
      return
    }
    // Starting a text translation takes the panel from any lingering file result.
    resetFileTranslation()
    void runTranslate({
      sourceLang: choice.sourceLang,
      targetLang: choice.targetLang,
      text: input
    }).then((outcome) => {
      // A second translate while one is in flight is busy-rejected. The trigger is already disabled
      // while busy, but surface the friendly banner if a click still reaches here so the action is
      // never silently swallowed.
      if (outcome === 'busy') setScreenError('busy')
    })
  }

  function onDropFiles(files: File[]): void {
    setScreenError(null)
    // The store clears any lingering text result only when the file translation actually STARTS
    // (past its reject guards), so a rejected drop keeps the text result behind the error banner.
    void translateDroppedFiles(files, choice)
  }

  function onChooseFile(): void {
    setScreenError(null)
    void translatePickedFile(choice)
  }

  function onStop(): void {
    if (translating) stopActive()
    else if (fileTx.busy) cancelFileTranslation()
  }

  function onSwap(): void {
    // Swap the two language selects (the common translate affordance). The output stays until the
    // next Translate — swapping is a setup step, not a re-run.
    setChoice((c) => ({ sourceLang: c.targetLang, targetLang: c.sourceLang }))
    setScreenError(null)
  }

  function onCopy(textToCopy: string): void {
    // Copy via MAIN (preload → clipboard:write), not navigator.clipboard — the latter is denied in
    // the file://-loaded renderer. Mirrors ImagesScreen.onCopy / ChatScreen.onCopyMessage.
    void window.api
      ?.copyToClipboard?.(textToCopy)
      ?.then?.((ok) => {
        if (ok) showToast(t('translate.copied'))
      })
      ?.catch?.(() => {
        // A failed clipboard write is not worth a banner (L7 — match onExport's swallow); the text
        // stays in the panel so the user can retry. An unhandled rejection here would be noise.
      })
  }

  async function onExport(): Promise<void> {
    if (!fileTx.resultDocumentId) return
    try {
      const path = await window.api?.exportDocument?.(fileTx.resultDocumentId)
      if (path) showToast(t('translate.file.exported'))
    } catch {
      // A cancelled/failed export is not an error worth a banner — the document stays in Documents.
    }
  }

  function renderFileProgress(): JSX.Element {
    if (fileTx.state === 'importing') {
      return <p className="hint">{t('translate.file.importing')}</p>
    }
    // Translating: show the coarse window count once the doc-task reports a plan, else a plain hint.
    return (
      <p className="hint">
        {fileTx.windowsTotal > 0
          ? t('translate.file.progress', { done: fileTx.windowsDone, total: fileTx.windowsTotal })
          : t('translate.file.working')}
      </p>
    )
  }

  function renderOutputPane(): JSX.Element {
    if (fileActive) {
      // ---- DOCUMENT path (TG-5) ----
      const done = fileTx.state === 'done'
      return (
        <div className="translate-pane">
          <div className="translate-output" aria-label={t('translate.output.label')}>
            {done ? (
              <AssistantMarkdown text={fileTx.output} />
            ) : fileTx.state === 'importing' || fileTx.state === 'translating' ? (
              renderFileProgress()
            ) : (
              // failed / cancelled: the banner carries the reason; keep the panel calm.
              <p className="hint">{t('translate.output.empty')}</p>
            )}
          </div>
          {done && fileTx.truncated && <p className="hint">{t('translate.file.truncated')}</p>}
          {/* Issue #58: honest completeness — pages with no readable text / model-failed parts.
              Both are ALSO marked inline in the generated document; this is the at-a-glance UI. */}
          {done && fileTx.gaps && fileTx.gaps.missingPageRanges.length > 0 && (
            <p className="hint warn">
              {tCount('translate.file.gapPages', countMissingPages(fileTx.gaps.missingPageRanges), {
                pages: formatPageRanges(fileTx.gaps.missingPageRanges)
              })}
            </p>
          )}
          {done && fileTx.gaps && fileTx.gaps.failedWindows > 0 && (
            <p className="hint warn">
              {tCount('translate.file.failedParts', fileTx.gaps.failedWindows)}
            </p>
          )}
          <div className="actions">
            {(fileTx.state === 'importing' || fileTx.state === 'translating') && (
              <Button onClick={onStop}>{t('translate.stop')}</Button>
            )}
            {done && (
              <>
                <Button size="sm" variant="primary" onClick={() => void onExport()}>
                  {t('translate.file.export')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onNavigate('documents')}>
                  {t('translate.file.show')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onCopy(fileTx.output)}>
                  {t('translate.copy')}
                </Button>
              </>
            )}
            {(done || fileTx.state === 'failed' || fileTx.state === 'cancelled') && (
              <Button size="sm" variant="ghost" onClick={resetFileTranslation}>
                {t('translate.file.reset')}
              </Button>
            )}
          </div>
        </div>
      )
    }

    // ---- TEXT path (TG-4) ----
    return (
      <div className="translate-pane">
        <div className="translate-output" aria-label={t('translate.output.label')}>
          {output === '' && !translating ? (
            <p className="hint">{t('translate.output.empty')}</p>
          ) : state === 'done' ? (
            <AssistantMarkdown text={output} />
          ) : (
            // Plain-text live buffer while streaming (Markdown is only parsed once complete, so
            // half-written syntax never flickers) — the ChatScreen live-render precedent.
            // DIVERGENCE NOTE: chat has since revised that precedent to streaming Markdown via
            // Streamdown (architecture.md §FE-1 revisited); this site deliberately keeps the
            // plain-text-while-streaming pattern until it gets the same treatment.
            <div className="translate-output-live">{output}</div>
          )}
        </div>
        {/* a11y: a separate visually-hidden, sentence-throttled live region for AT (§ChatScreen). */}
        <StreamAnnouncer text={output} />
        <div className="actions">
          {output !== '' && !translating && (
            <Button size="sm" variant="ghost" onClick={() => onCopy(output)}>
              {t('translate.copy')}
            </Button>
          )}
          {translating && <p className="hint">{t('translate.working')}</p>}
        </div>
      </div>
    )
  }

  function renderBody(): JSX.Element | null {
    if (available === null) {
      return <p className="hint">{t('translate.starting')}</p>
    }
    if (!available) {
      // The O2 install path: a friendly, actionable refusal with a deep link to the AI Model
      // screen (the ChatScreen / VisionUnavailable no-model precedent).
      return (
        <EmptyState
          title={t('translate.avail.noModel')}
          line={t('translate.avail.hint')}
          action={
            <Button variant="primary" onClick={() => onNavigate('models')}>
              {t('translate.avail.cta')}
            </Button>
          }
        />
      )
    }
    return (
      <div className="translate-workspace">
        {/* Language bar: source select · swap · target select (native-name labels, untranslated
            by design — the Settings language-picker precedent). */}
        <div className="translate-langbar">
          <label>
            {t('translate.from')}{' '}
            <select
              className="select"
              aria-label={t('translate.from')}
              value={choice.sourceLang}
              onChange={(e) =>
                setChoice((c) => ({ ...c, sourceLang: e.target.value as TranslationSourceLang }))
              }
            >
              {TRANSLATION_LANGUAGE_CODES.map((code) => (
                <option key={code} value={code}>
                  {TRANSLATION_NATIVE_NAMES[code]}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="translate-swap"
            aria-label={t('translate.swap')}
            title={t('translate.swap')}
            onClick={onSwap}
          >
            <Icon name="refresh" />
          </Button>
          <label>
            {t('translate.to')}{' '}
            <select
              className="select"
              aria-label={t('translate.to')}
              value={choice.targetLang}
              onChange={(e) =>
                setChoice((c) => ({ ...c, targetLang: e.target.value as TranslationTargetLang }))
              }
            >
              {TRANSLATION_LANGUAGE_CODES.map((code) => (
                <option key={code} value={code}>
                  {TRANSLATION_NATIVE_NAMES[code]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Issue #42 reopen: the muted device line (the chat #36 analogue). Appears once the
            sidecar has cold-started this session; `title` carries the explanation/remedy. */}
        {deviceHint && (
          <p className="hint translate-device-hint" title={deviceHint.title}>
            {deviceHint.text}
          </p>
        )}

        {sameLang && <p className="hint">{t('translate.err.sameLang')}</p>}

        <div className="translate-panes">
          <div className="translate-pane">
            <textarea
              className="translate-input"
              aria-label={t('translate.input.label')}
              placeholder={t('translate.input.placeholder')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="actions">
              <Button
                variant="primary"
                disabled={busy || input.trim() === '' || sameLang}
                onClick={onTranslate}
              >
                {t('translate.action')}
              </Button>
              {translating && <Button onClick={onStop}>{t('translate.stop')}</Button>}
            </div>
            {/* Document drag-and-drop / choose (TG-5). Disabled (with the text triggers) while any
                translation runs, keeping ONE busy state. The current file name shows as a caption. */}
            <TranslateDropZone onDropFiles={onDropFiles} onChoose={onChooseFile} busy={busy} />
            {fileTx.fileName && (
              <p className="hint translate-file-name">{fileTx.fileName}</p>
            )}
          </div>

          {renderOutputPane()}
        </div>
      </div>
    )
  }

  // Banner reconciliation (priority: client guard → text-job failure → file-path failure). At most
  // one path is non-idle at a time, so these never collide in practice; the priority is a tie-break.
  let bannerText: string | null = null
  let dismissBanner: () => void = () => {}
  if (screenError) {
    bannerText = t(ERR_KEY[screenError] ?? 'translate.err.runtimeFailed')
    dismissBanner = () => setScreenError(null)
  } else if (state === 'failed' && error) {
    bannerText = t(ERR_KEY[error] ?? 'translate.err.runtimeFailed')
    // Clear the store's terminal failed state too, so the banner doesn't reappear on remount (the
    // failed state is persistent; a component-local dismiss flag would reset).
    dismissBanner = () => acknowledgeError()
  } else if (fileTx.state === 'failed') {
    // Doc-task failure messages are persist-canonical ENGLISH — localize at display time via
    // the DR-7 map, like DocumentsScreen does for the same family (full-audit 2026-07-11
    // CODE-42). Unknown strings pass through unchanged.
    bannerText =
      fileTx.errorMessage != null
        ? localizeServerCopy(t, fileTx.errorMessage)
        : t(fileTx.error ? FILE_ERR_KEY[fileTx.error] : 'translate.file.err.runtimeFailed')
    dismissBanner = () => resetFileTranslation()
  }

  return (
    <div className="screen translate-screen">
      <h1>{t('translate.title')}</h1>
      <p className="lead">{t('translate.lead')}</p>
      {bannerText && (
        <Banner tone="error" onDismiss={dismissBanner} t={t}>
          {bannerText}
        </Banner>
      )}
      {renderBody()}
    </div>
  )
}
