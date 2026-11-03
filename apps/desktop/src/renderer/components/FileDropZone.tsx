import { useState, type DragEvent } from 'react'
import { Button, type ButtonProps } from './Button'

// File drop zone (image-understanding §5.2; the Translate view's TG-5): a large target with a
// "choose …" button as the mandatory non-drag path (WCAG 2.5.7). The Images screen and the
// Translate document view each render one with their own copy, CSS block and button look. A
// multi-drop is REJECTED by the owner (the Images screen, translateDroppedFiles) rather than
// silently taking files[0] (UX-3); the bytes-level work (decode / path resolution → import)
// lives there too. This component only surfaces the user intent.

export interface FileDropZoneProps {
  /** The CSS block: `image-dropzone` or `translate-dropzone` (its `-title` / `-types` parts too). */
  block: string
  title: string
  chooseLabel: string
  /** The accepted types, as a hint under the button. */
  types: string
  /** The choose button's look: the Images screen's primary button, the Translate view's small ghost. */
  chooseVariant?: ButtonProps['variant']
  chooseSize?: ButtonProps['size']
  /** All dropped files — the owner rejects a multi-drop. */
  onDropFiles: (files: File[]) => void
  /** The picker path, owned by the screen / store. */
  onChoose: () => void
  busy?: boolean
}

export function FileDropZone({
  block,
  title,
  chooseLabel,
  types,
  chooseVariant,
  chooseSize,
  onDropFiles,
  onChoose,
  busy
}: FileDropZoneProps): JSX.Element {
  const [dragOver, setDragOver] = useState(false)

  // L8, DOC-3 (#143): only a real FILE drag lights up / is accepted. A text/link/element drag
  // reports its own MIME types (never 'Files') and must not highlight the zone or be
  // preventDefaulted; its drop would resolve to zero files and be silently discarded.
  function isFileDrag(e: DragEvent<HTMLDivElement>): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files')
  }

  function onDragOver(e: DragEvent<HTMLDivElement>): void {
    // While busy, or for a non-file drag, do NOT preventDefault — the browser then shows the
    // OS no-drop cursor and the drop never lands on us (L8), instead of a copy cursor luring
    // a drop the zone would silently discard.
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
  // redundant pointer onClick for mouse users and the drag surface.
  return (
    <div
      className={`${block}${dragOver ? ' drag-over' : ''}`}
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
      <p className={`${block}-title`}>{title}</p>
      <Button
        variant={chooseVariant}
        size={chooseSize}
        disabled={busy}
        onClick={(e) => {
          // The zone itself is clickable; stop the bubble so the button isn't a double-fire.
          e.stopPropagation()
          onChoose()
        }}
      >
        {chooseLabel}
      </Button>
      <p className={`hint ${block}-types`}>{types}</p>
    </div>
  )
}
