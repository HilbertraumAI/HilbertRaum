import { useState, type DragEvent } from 'react'
import { Button } from '../components'
import { useT } from '../i18n'

// Drop zone (§5.2): a large, focusable target with a "choose an image" button as the
// mandatory non-drag path (WCAG 2.5.7). A multi-drop is REJECTED ("Drop one image at a
// time.") rather than silently taking files[0] (UX-3). The bytes-level work (validation +
// decode) lives in the screen; this component only surfaces the user intent.

export function ImageDropZone({
  onDropFiles,
  onChoose,
  busy
}: {
  /** All dropped files — the screen rejects a multi-drop and decodes the single file. */
  onDropFiles: (files: File[]) => void
  /** The picker path (imageChooseImage → imageReadBytes → decode), owned by the screen. */
  onChoose: () => void
  busy?: boolean
}): JSX.Element {
  const { t } = useT()
  const [dragOver, setDragOver] = useState(false)

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setDragOver(false)
    if (busy) return
    onDropFiles(Array.from(e.dataTransfer.files))
  }

  return (
    <div
      className={`image-dropzone${dragOver ? ' drag-over' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={t('images.drop.title')}
      onClick={() => !busy && onChoose()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
          e.preventDefault()
          onChoose()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!busy) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <p className="image-dropzone-title">{t('images.drop.title')}</p>
      <Button
        variant="primary"
        disabled={busy}
        onClick={(e) => {
          // The zone itself is clickable; stop the bubble so the button isn't a double-fire.
          e.stopPropagation()
          onChoose()
        }}
      >
        {t('images.drop.choose')}
      </Button>
      <p className="hint image-dropzone-types">{t('images.drop.types')}</p>
    </div>
  )
}
