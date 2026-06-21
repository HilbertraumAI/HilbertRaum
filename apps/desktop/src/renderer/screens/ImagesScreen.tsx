import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, EmptyState, useToast } from '../components'
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
  type DecodedImage,
  type DecodeImage,
  type ImageMime,
  type ImageTurn
} from '../images'
import { useT } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import type { ImageSessionSummary, VisionErrorCode, VisionStatus } from '@shared/types'

// Images screen (image-understanding §5/§11, Phase V3). Load ONE local PNG/JPEG, ask a
// question in plain language, get an answer from a local vision model (the V2 backend).
// Everything is ephemeral renderer state — the image, question, thread, and answer live
// only here and are gone on navigate-away / remove / close. Nothing is persisted; no OCR,
// no auto-import, no documents/chunks/embeddings writes (§3/§12).
//
// Mirrors DocumentsScreen structure (useT, window.api?.…, local useState, the component
// kit) and the Chat screen's subscribe/unsubscribe streaming lifecycle (analyze is
// streaming by default — onImageToken for live tokens, onImageDone for the terminal job).

/** The selected image plus its display metadata (all ephemeral screen state). */
interface SelectedImage {
  decoded: DecodedImage
  name: string
  sizeBytes: number
}

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

let turnCounter = 0
function nextTurnId(): string {
  turnCounter += 1
  return `img-turn-${turnCounter}`
}

function patchTurn(
  turns: ImageTurn[],
  id: string,
  patch: Partial<ImageTurn> | ((t: ImageTurn) => Partial<ImageTurn>)
): ImageTurn[] {
  return turns.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t))
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
  const [locked, setLocked] = useState(false)
  const [selected, setSelected] = useState<SelectedImage | null>(null)
  const [turns, setTurns] = useState<ImageTurn[]>([])
  const [composer, setComposer] = useState('')
  const [decoding, setDecoding] = useState(false)
  const [screenError, setScreenError] = useState<ClientImageError | null>(null)
  // Image-analysis history (image-understanding history). The list shown on the landing view;
  // `sessionRef` is the session the loaded image persists into (null ⇒ a fresh image whose
  // FIRST analyze creates a new session in main). A ref so the async analyze closure reads the
  // latest id without re-subscribing.
  const [sessions, setSessions] = useState<ImageSessionSummary[]>([])
  const sessionRef = useRef<string | null>(null)

  // Streaming bookkeeping (refs so the async analyze closure + unmount cleanup see latest).
  const activeJobRef = useRef<string | null>(null)
  const activeTurnRef = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  const checkStatus = useCallback(async (): Promise<void> => {
    try {
      const s = await window.api?.imageGetStatus?.()
      if (s) setStatus(s)
    } catch {
      // No status (missing backend / partial bridge) → calm unavailable, never a crash.
      setStatus({ available: false, reason: 'no-model' })
    }
    try {
      const st = await window.api?.getAppStatus?.()
      if (st) setLocked(st.workspaceReady === false)
    } catch {
      // Keep the default (unlocked): the app shell already gates the whole app on lock.
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

  // Load (and reload on unlock) the history list.
  useEffect(() => {
    if (!locked) void loadSessions()
  }, [locked, loadSessions])

  // Tear down any in-flight analyze on unmount (navigate-away / close). Nothing persists.
  useEffect(
    () => () => {
      if (activeJobRef.current) void window.api?.imageCancel?.(activeJobRef.current)?.catch?.(() => {})
      cleanupRef.current?.()
    },
    []
  )

  function endStream(): void {
    cleanupRef.current?.()
    cleanupRef.current = null
    activeJobRef.current = null
    activeTurnRef.current = null
    setAnalyzing(false)
  }

  // Select a freshly decoded image. A new image mid-analysis cancels the old job and resets
  // the thread (§5.6) — the image, question, and answer are per-image and ephemeral.
  function selectImage(sel: SelectedImage): void {
    if (activeJobRef.current) {
      void window.api?.imageCancel?.(activeJobRef.current)?.catch?.(() => {})
      endStream()
    }
    // A freshly selected image starts a NEW history session on its first analyze.
    sessionRef.current = null
    setTurns([])
    setComposer('')
    setScreenError(null)
    setSelected(sel)
  }

  function removeImage(): void {
    if (activeJobRef.current) {
      void window.api?.imageCancel?.(activeJobRef.current)?.catch?.(() => {})
      endStream()
    }
    sessionRef.current = null
    setSelected(null)
    setTurns([])
    setComposer('')
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
    if (activeJobRef.current) {
      void window.api?.imageCancel?.(activeJobRef.current)?.catch?.(() => {})
      endStream()
    }
    setScreenError(null)
    const mime: ImageMime = detail.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    try {
      const blob = new Blob([detail.imageBytes as unknown as BlobPart], { type: mime })
      const decoded = await decodeImpl(blob, mime)
      sessionRef.current = detail.id
      setComposer('')
      setSelected({ decoded, name: detail.title, sizeBytes: detail.sizeBytes })
      setTurns(
        detail.turns.map((tn, i) => ({
          id: `hist-${detail.id}-${i}`,
          question: tn.question,
          answer: tn.answer,
          state: 'done' as const,
          error: null
        }))
      )
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
    if (sessionRef.current === id) {
      if (activeJobRef.current) {
        void window.api?.imageCancel?.(activeJobRef.current)?.catch?.(() => {})
        endStream()
      }
      sessionRef.current = null
      setSelected(null)
      setTurns([])
      setComposer('')
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

  // Run one analyze, streaming the answer into a fresh turn. A second analyze while one runs
  // is busy-rejected by the backend (IPC-3) and never enqueued; we also guard client-side.
  async function runAnalyze(question: string): Promise<void> {
    const sel = selected
    const q = question.trim()
    if (!sel || !q || activeJobRef.current) return

    const turnId = nextTurnId()
    setTurns((prev) => [...prev, { id: turnId, question: q, answer: '', state: 'starting' }])
    setAnalyzing(true)

    let job
    try {
      job = await window.api.imageAnalyze({
        imageBytes: sel.decoded.bytes,
        mimeType: sel.decoded.mimeType,
        question: q,
        name: sel.name,
        width: sel.decoded.width,
        height: sel.decoded.height,
        sessionId: sessionRef.current
      })
    } catch {
      setTurns((prev) => patchTurn(prev, turnId, { state: 'failed', error: 'runtimeFailed' }))
      setAnalyzing(false)
      return
    }

    if (job.error === 'busy' || job.state === 'failed' || job.state === 'cancelled') {
      setTurns((prev) =>
        patchTurn(prev, turnId, { state: 'failed', error: job.error ?? 'runtimeFailed' })
      )
      setAnalyzing(false)
      return
    }

    // Main creates the history session on first analyze and returns its id; reuse it for any
    // follow-up turn on the same loaded image.
    if (job.sessionId) sessionRef.current = job.sessionId

    activeJobRef.current = job.jobId
    activeTurnRef.current = turnId

    const unsubs: Array<(() => void) | undefined> = []
    cleanupRef.current = () => {
      for (const u of unsubs) u?.()
    }

    unsubs.push(
      window.api?.onImageToken?.(job.jobId, (token: string) => {
        setTurns((prev) =>
          patchTurn(prev, turnId, (tn) => ({ answer: tn.answer + token, state: 'analyzing' }))
        )
      })
    )
    unsubs.push(
      window.api?.onImageDone?.(job.jobId, (doneJob) => {
        // Main creates the history session on the first completed answer and returns its id on
        // the done job; reuse it for any follow-up turn on this same loaded image.
        if (doneJob.sessionId) sessionRef.current = doneJob.sessionId
        let saved = false
        setTurns((prev) =>
          patchTurn(prev, turnId, (tn) => {
            const answer = doneJob.answer ?? tn.answer
            if (answer.trim()) {
              saved = true
              return { answer, state: 'done', error: null }
            }
            return { state: 'failed', error: 'emptyResponse' }
          })
        )
        // A completed turn was persisted in main — refresh the history list so it's current.
        if (saved) void loadSessions()
        endStream()
      })
    )
    unsubs.push(
      window.api?.onImageError?.(job.jobId, (errJob) => {
        const code = errJob.error ?? 'runtimeFailed'
        setTurns((prev) =>
          patchTurn(prev, turnId, code === 'cancelled' ? { state: 'cancelled' } : { state: 'failed', error: code })
        )
        endStream()
      })
    )
  }

  function onStop(): void {
    const jobId = activeJobRef.current
    const turnId = activeTurnRef.current
    if (!jobId) return
    void window.api?.imageCancel?.(jobId)?.catch?.(() => {})
    if (turnId) setTurns((prev) => patchTurn(prev, turnId, { state: 'cancelled' }))
    endStream()
  }

  function onCopy(text: string): void {
    void navigator.clipboard?.writeText?.(text)?.then?.(() => showToast(t('images.answer.copied')))
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
    if (locked) {
      return <EmptyState title={t('images.locked')} />
    }
    if (status === null) {
      // Brief: status resolves on mount. A calm placeholder, never a spinner-of-doom.
      return <p className="hint">{t('images.answer.starting')}</p>
    }
    if (!status.available) {
      return <VisionUnavailable reason={status.reason ?? 'no-model'} onNavigate={onNavigate} />
    }
    if (!selected) {
      return (
        <>
          <ImageDropZone onDropFiles={onDropFiles} onChoose={handleChoose} busy={decoding} />
          <ImageHistory
            sessions={sessions}
            onOpen={(id) => void openSession(id)}
            onDelete={(id) => void deleteSession(id)}
          />
        </>
      )
    }
    return (
      <div className="image-workspace">
        <div className="image-pane-left">
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
            onTryAgain={(q) => void runAnalyze(q)}
            onStop={onStop}
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
