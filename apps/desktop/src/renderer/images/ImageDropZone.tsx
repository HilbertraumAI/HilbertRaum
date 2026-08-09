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

  // DOC-3 (#143): only a real FILE drag lights up / is accepted — the TranslateDropZone L8
  // pattern. A text/link/element drag reports its own MIME types (never 'Files') and must not
  // highlight the zone or be preventDefaulted; its drop would resolve to zero files and be
  // silently discarded by the screen.
  function isFileDrag(e: DragEvent<HTMLDivElement>): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files')
  }

  function onDragOver(e: DragEvent<HTMLDivElement>): void {
    // While busy, or for a non-file drag, do NOT preventDefault — the browser then shows the
    // OS no-drop cursor and the drop never lands on us (L8), instead of a copy cursor luring
    // a drop the zone would silently discard mid-analysis.
    if (busy || !isFileDrag(e)) {
      e.dataTransfer.dropEffect = 'none'
      if (dragOver) setDragOver(false)
      return
    }
    e.preventDefault()
    setDragOver(true)
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    setDragOver(false)
    // A busy/non-file drop is discarded WITHOUT preventDefault (see onDragOver — such a drop
    // should not reach us at all; this is the belt-and-braces guard).
    if (busy || !isFileDrag(e)) return
    e.preventDefault()
    onDropFiles(Array.from(e.dataTransfer.files))
  }

  // #161 (FE-6): the zone is no longer `role="button"` — a role=button's children are
  // presentational per ARIA, so the real inner <Button> was a nested interactive AT may
  // flatten, plus a redundant second tab stop firing the same onChoose. The inner Button is
  // now THE accessible control (WCAG 2.5.7's non-drag path, one tab stop); the zone keeps a
  // redundant pointer onClick for mouse users and the drag surface. Mirrors TranslateDropZone.
  return (
    <div
      className={`image-dropzone${dragOver ? ' drag-over' : ''}`}
      onClick={() => !busy && onChoose()}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        // #162 (FE-7): only a leave that actually EXITS the zone clears the highlight —
        // dragging across the inner title/button/types fires dragleave at each child
        // boundary and made the dashed highlight flicker. `relatedTarget` is null when
        // leaving the window, which correctly clears too.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
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
