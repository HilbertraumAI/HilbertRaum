import { useState, type DragEvent } from 'react'
import { Button } from '../components'
import { useT } from '../i18n'

// Document drop zone for the Translate view (TG-5, plan §2 D7). A focusable target with a "choose
// a document" button as the mandatory non-drag path (WCAG 2.5.7) — the ImageDropZone precedent. A
// multi-drop is REJECTED by the store (translateDroppedFiles) rather than silently taking files[0].
// The bytes-level work (path resolution → import → doc-task) lives in the store; this component
// only surfaces the user intent. Disabled while a translation (text OR document) is running so the
// view keeps ONE busy state.

export function TranslateDropZone({
  onDropFiles,
  onChoose,
  busy
}: {
  /** All dropped files — the store rejects a multi-drop and resolves the single file's path. */
  onDropFiles: (files: File[]) => void
  /** The picker path (pickDocuments → import), owned by the store. */
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
      className={`translate-dropzone${dragOver ? ' drag-over' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={t('translate.drop.title')}
      aria-disabled={busy || undefined}
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
      <p className="translate-dropzone-title">{t('translate.drop.title')}</p>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={(e) => {
          // The zone itself is clickable; stop the bubble so the button isn't a double-fire.
          e.stopPropagation()
          onChoose()
        }}
      >
        {t('translate.drop.choose')}
      </Button>
      <p className="hint translate-dropzone-types">{t('translate.drop.types')}</p>
    </div>
  )
}
