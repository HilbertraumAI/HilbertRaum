import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Banner, Button, useToast } from '../components'
import {
  AnswerThread,
  ImageDropZone,
  ImageHistory,
  ImagePreview,
  QuestionComposer,
  VisionUnavailable,
  decodeImage,
  imageMimeFromName,
  imageMimeOfFile,
  ImageDecodeError,
  MAX_IMAGE_BYTES,
  type ComposerChip,
  type DecodeImage,
  type ImageMime
} from '../images'
import {
  analyze as analyzeImage,
  getVisionSession,
  loadSession as loadVisionSession,
  removeImage as removeVisionImage,
  selectImage as selectVisionImage,
  stopActive as stopVisionActive,
  subscribeVisionPersisted,
  subscribeVisionSession,
  type SelectedImage
} from '../lib/visionSession'
import { useT } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import type { ImageSessionSummary, VisionErrorCode, VisionStatus } from '@shared/types'

// Images screen (image-understanding §5/§11, Phase V3). Load ONE local PNG/JPEG, ask a
// question in plain language, get an answer from a local vision model (the V2 backend).
//
// The loaded image, the Q&A thread, and the live streaming answer live in the module-level
// `lib/visionSession` store (the doc-task / skill-run precedent), NOT in this component — so a
// running analysis SURVIVES navigating to another screen and back, still streaming, instead of
// being cancelled on unmount. Screen-only concerns (vision availability, the composer draft, the
// history list, transient errors) stay in local state and are re-read on mount.

// Suggestion chips (§5.5): label + the prompt it fills the composer with (no auto-send).
const CHIP_KEYS: { labelKey: MessageKey; promptKey: MessageKey }[] = [
  { labelKey: 'images.chip.summarize', promptKey: 'images.chip.summarize.prompt' },
  { labelKey: 'images.chip.extractText', promptKey: 'images.chip.extractText.prompt' },
  { labelKey: 'images.chip.explainChart', promptKey: 'images.chip.explainChart.prompt' },
  { labelKey: 'images.chip.readForm', promptKey: 'images.chip.readForm.prompt' },
  { labelKey: 'images.chip.importantDetails', promptKey: 'images.chip.importantDetails.prompt' },
  { labelKey: 'images.chip.whatNotice', promptKey: 'images.chip.whatNotice.prompt' }
]

// `multiDrop` is a UI-only concern (NOT a VisionErrorCode — there is no such backend code);
// it joins the client-guard codes the screen-level banner can show.
type ClientImageError = VisionErrorCode | 'multiDrop'

// Client-guard error codes → friendly banner copy (the runtime codes map inside AnswerThread).
const CLIENT_ERR_KEY: Partial<Record<ClientImageError, MessageKey>> = {
  tooLarge: 'images.err.tooLarge',
  unsupportedType: 'images.err.unsupported',
  decodeFailed: 'images.err.decodeFailed',
  multiDrop: 'images.err.multiDrop',
  busy: 'images.err.busy'
}

export function ImagesScreen({
  onNavigate,
  /** Test seam: inject a fake decode (jsdom has no createImageBitmap/OffscreenCanvas). */
  decodeImpl = decodeImage
}: {
  onNavigate: (target: string) => void
  decodeImpl?: DecodeImage
}): JSX.Element {
  const { t } = useT()
  const showToast = useToast()
  const [status, setStatus] = useState<VisionStatus | null>(null)
  const [composer, setComposer] = useState('')
  const [decoding, setDecoding] = useState(false)
  const [screenError, setScreenError] = useState<ClientImageError | null>(null)
  // Image-analysis history (image-understanding history): the list shown on the landing view.
  const [sessions, setSessions] = useState<ImageSessionSummary[]>([])
  // Which view: the landing list (upload + previous results) or the single-analysis detail. Local
  // (not in the store) and defaults to the list, so navigating back to Images always returns to the
  // "new analysis" view — a running analysis is then reachable as a row in the results list.
  const [viewingDetail, setViewingDetail] = useState(false)

  // The active analysis (loaded image + Q&A thread + live answer) lives in the module-level
  // store so it survives navigating away and back (the running analysis keeps streaming there).
  const { selected, turns, analyzing } = useSyncExternalStore(subscribeVisionSession, getVisionSession)

  const checkStatus = useCallback(async (): Promise<void> => {
    try {
      const s = await window.api?.imageGetStatus?.()
      if (s) setStatus(s)
    } catch {
      // No status (missing backend / partial bridge) → calm unavailable, never a crash.
      setStatus({ available: false, reason: 'no-model' })
    }
  }, [])

  // Refresh the saved-analysis history list (workspace must be unlocked — a locked read throws
  // and is swallowed, keeping the current list).
  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api?.listImageSessions?.()
      if (list) setSessions(list)
    } catch {
      // Keep the current list (locked / partial bridge).
    }
  }, [])

  // Fetch status on mount; re-check on window focus (a vision model may have been installed
  // on the AI Model screen and the user navigated back).
  useEffect(() => {
    void checkStatus()
    const onFocus = (): void => void checkStatus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkStatus])

  // Load the history list on mount (the screen only ever mounts while the workspace is unlocked).
  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  // A completed turn persists a session in main — refresh the list (works even when the analysis
  // finished while this screen was unmounted: the store fires on the next mount's subscription).
  useEffect(() => subscribeVisionPersisted(() => void loadSessions()), [loadSessions])

  // NB: there is deliberately NO lock-purge effect here. Workspace lock unmounts this screen (the
  // shell swaps to WorkspaceGate) the moment it happens, so a screen effect could never observe it
  // — the vision store is purged at the real seam, App.lockNow → purgeSessionStores (TA-2).

  // Select a freshly decoded image. A new image mid-analysis cancels the old job and resets the
  // thread (§5.6); the store starts a NEW history session on its first analyze. A fresh image
  // opens the detail view so the user can ask a question.
  function selectImage(sel: SelectedImage): void {
    selectVisionImage(sel)
    setComposer('')
    setScreenError(null)
    setViewingDetail(true)
  }

  function removeImage(): void {
    removeVisionImage()
    setComposer('')
    setScreenError(null)
    setViewingDetail(false)
    void loadSessions()
  }

  // Leave the detail view for the landing list WITHOUT touching the analysis — a running job keeps
  // streaming in the store and stays reachable as the list's "Analysis running…" row.
  function backToList(): void {
    setViewingDetail(false)
    setScreenError(null)
    void loadSessions()
  }

  // Open a saved history entry: decrypt + reload the image and replay its stored turns. The
  // composer stays live so a follow-up question appends to the SAME session.
  async function openSession(id: string): Promise<void> {
    let detail
    try {
      detail = (await window.api?.getImageSession?.(id)) ?? null
    } catch {
      detail = null
    }
    if (!detail) {
      // The entry vanished (deleted elsewhere / missing file) — resync the list.
      void loadSessions()
      return
    }
    setScreenError(null)
    const mime: ImageMime = detail.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    try {
      const blob = new Blob([detail.imageBytes as unknown as BlobPart], { type: mime })
      const decoded = await decodeImpl(blob, mime)
      setComposer('')
      loadVisionSession(
        { decoded, name: detail.title, sizeBytes: detail.sizeBytes },
        detail.turns.map((tn, i) => ({
          id: `hist-${detail.id}-${i}`,
          question: tn.question,
          answer: tn.answer,
          state: 'done' as const,
          error: null
        })),
        detail.id
      )
      setViewingDetail(true)
    } catch (e) {
      setScreenError(e instanceof ImageDecodeError ? e.code : 'decodeFailed')
    }
  }

  // Delete a saved entry: main shreds the stored image + cascade-removes its turns. If the
  // deleted entry is the one on screen, return to the landing view.
  async function deleteSession(id: string): Promise<void> {
    try {
      await window.api?.deleteImageSession?.(id)
    } catch {
      // Best-effort; the list refresh below reflects the true state either way.
    }
    if (getVisionSession().sessionId === id) {
      removeVisionImage()
      setComposer('')
      setViewingDetail(false)
    }
    await loadSessions()
    showToast(t('images.history.deleted'))
  }

  async function handleFile(file: File): Promise<void> {
    setScreenError(null)
    const mime = imageMimeOfFile(file)
    if (!mime) {
      setScreenError('unsupportedType')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setScreenError('tooLarge')
      return
    }
    await decodeAndSelect(file, mime, file.name, file.size)
  }

  function onDropFiles(files: File[]): void {
    setScreenError(null)
    if (files.length === 0) return
    if (files.length > 1) {
      // Reject a multi-drop rather than silently taking files[0] (UX-3).
      setScreenError('multiDrop')
      return
    }
    void handleFile(files[0])
  }

  // Picker path: imageChooseImage → imageReadBytes(token) → the same decode pipeline (IPC-1).
  // D2: main returns an opaque token, never the absolute path; we hand the token straight back.
  async function handleChoose(): Promise<void> {
    setScreenError(null)
    let chosen: { token: string; name: string; sizeBytes: number } | null
    try {
      chosen = (await window.api?.imageChooseImage?.()) ?? null
    } catch {
      setScreenError('decodeFailed')
      return
    }
    if (!chosen) return
    const mime = imageMimeFromName(chosen.name)
    if (!mime) {
      setScreenError('unsupportedType')
      return
    }
    if (chosen.sizeBytes > MAX_IMAGE_BYTES) {
      setScreenError('tooLarge')
      return
    }
    setDecoding(true)
    try {
      const bytes = await window.api.imageReadBytes(chosen.token)
      const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
      const decoded = await decodeImpl(blob, mime)
      selectImage({ decoded, name: chosen.name, sizeBytes: chosen.sizeBytes })
    } catch (e) {
      setScreenError(e instanceof ImageDecodeError ? e.code : 'decodeFailed')
    } finally {
      setDecoding(false)
    }
  }

  async function decodeAndSelect(
    blob: Blob,
    mime: ImageMime,
    name: string,
    sizeBytes: number
  ): Promise<void> {
    setDecoding(true)
    try {
      const decoded = await decodeImpl(blob, mime)
      selectImage({ decoded, name, sizeBytes })
    } catch (e) {
      setScreenError(e instanceof ImageDecodeError ? e.code : 'decodeFailed')
    } finally {
      setDecoding(false)
    }
  }

  // Run one analyze (the store streams the answer into a fresh turn and keeps streaming even if
  // this screen unmounts). A second analyze while one runs is busy-rejected by the backend
  // (IPC-3) and guarded in the store; the history-list refresh rides the persisted subscription.
  function runAnalyze(question: string): void {
    void analyzeImage(question).then((outcome) => {
      // F4: a second analyze while one is in flight is busy-rejected. The trigger (composer +
      // per-turn "Try again") is already disabled while `analyzing`, but surface the friendly
      // banner if a click still reaches here, so the action is NEVER silently swallowed.
      if (outcome === 'busy') setScreenError('busy')
    })
  }

  function onStop(): void {
    stopVisionActive()
  }

  function onCopy(text: string): void {
    // Copy via MAIN (preload → clipboard:write), not navigator.clipboard — the latter needs a
    // secure context + focused document and is denied (`clipboard-sanitized-write`) in the
    // file://-loaded renderer. Mirrors ChatScreen.onCopyMessage.
    void window.api?.copyToClipboard?.(text)?.then?.((ok) => {
      if (ok) showToast(t('images.answer.copied'))
    })
  }

  function onChip(prompt: string): void {
    // Fill the composer (no auto-send) so the user can edit before asking (§5.5).
    setComposer(prompt)
  }

  const chips: ComposerChip[] = CHIP_KEYS.map((c) => ({
    label: t(c.labelKey),
    prompt: t(c.promptKey)
  }))

  function renderBody(): JSX.Element | null {
    if (status === null) {
      // Brief: status resolves on mount. A calm placeholder, never a spinner-of-doom.
      return <p className="hint">{t('images.answer.starting')}</p>
    }
    if (!status.available) {
      return <VisionUnavailable reason={status.reason ?? 'no-model'} onNavigate={onNavigate} />
    }
    // Landing view (the "new analysis" view): upload + previous results. Shown by default and on
    // every return to the screen, so a finished analysis never strands the user on the result view.
    // While an analysis runs, the upload is disabled (vision is one-at-a-time) and the running job
    // is surfaced as the top row of the results list (clicking it re-opens the live detail view).
    if (!viewingDetail || !selected) {
      return (
        <>
          {analyzing && <p className="hint">{t('images.drop.busy')}</p>}
          <ImageDropZone onDropFiles={onDropFiles} onChoose={handleChoose} busy={decoding || analyzing} />
          <ImageHistory
            sessions={sessions}
            running={analyzing && selected ? { title: selected.name, onOpen: () => setViewingDetail(true) } : null}
            onOpen={(id) => void openSession(id)}
            onDelete={(id) => void deleteSession(id)}
          />
        </>
      )
    }
    return (
      <div className="image-workspace">
        <div className="image-pane-left">
          <Button size="sm" variant="ghost" className="image-back" onClick={backToList}>
            ‹ {t('images.back')}
          </Button>
          <ImagePreview
            dataUrl={selected.decoded.dataUrl}
            name={selected.name}
            mimeType={selected.decoded.mimeType}
            width={selected.decoded.width}
            height={selected.decoded.height}
            sizeBytes={selected.sizeBytes}
            onRemove={removeImage}
            onReplace={handleChoose}
            busy={decoding}
          />
        </div>
        <div className="image-pane-right">
          <QuestionComposer
            value={composer}
            onChange={setComposer}
            onSend={() => {
              const q = composer
              setComposer('')
              void runAnalyze(q)
            }}
            onChip={onChip}
            chips={chips}
            disabled={analyzing}
          />
          <AnswerThread
            turns={turns}
            onCopy={onCopy}
            onTryAgain={(q) => runAnalyze(q)}
            onStop={onStop}
            busy={analyzing}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="screen images-screen">
      <h1>{t('images.title')}</h1>
      <p className="lead">{t('images.empty.body')}</p>
      {screenError && (
        <Banner tone="error" onDismiss={() => setScreenError(null)} t={t}>
          {t(CLIENT_ERR_KEY[screenError] ?? 'images.err.decodeFailed')}
        </Banner>
      )}
      {renderBody()}
    </div>
  )
}
