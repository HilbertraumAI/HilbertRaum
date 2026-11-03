// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, createEvent, fireEvent } from '@testing-library/react'
import { FileDropZone, type FileDropZoneProps } from '../../src/renderer/components'
import { dropFiles, fileDataTransfer } from '../helpers/drop'

// Component test for the file drop zone the Images screen and the Translate document view (TG-5) both
// render, each with its own copy, CSS block and button look (#745: one component, it was written twice).
// The screens' own suites drop through it with their copy (ImagesScreen, TranslateScreen).
//  - TA-3 / L8, DOC-3 (#143): only a real FILE drag lights up / is accepted, and a busy zone shows the OS
//    no-drop cursor (dropEffect 'none', no preventDefault) instead of luring a drop it would silently discard.
//  - #161 (FE-6): the zone is a plain drag surface — the inner "or choose …" <Button> is THE single
//    accessible control (WCAG 2.5.7 non-drag path), never a nested interactive inside a role="button".
//  - #162 (FE-7): a drag across the zone's children must not flicker the highlight.

afterEach(cleanup)

const TITLE = 'Drop a file here'
const CHOOSE = 'or choose a file'

function renderZone(over: Partial<FileDropZoneProps> = {}): void {
  render(
    <FileDropZone
      block="test-dropzone"
      title={TITLE}
      chooseLabel={CHOOSE}
      types="PDF, PNG"
      onDropFiles={vi.fn()}
      onChoose={vi.fn()}
      {...over}
    />
  )
}

/** The drag surface: the zone div AROUND the visible title (no ARIA role — FE-6). */
function zoneEl(): HTMLElement {
  const el = screen.getByText(TITLE).closest('.test-dropzone')
  if (!(el instanceof HTMLElement)) throw new Error('drop zone not rendered')
  return el
}

const file = (): File => new File(['%PDF'], 'a.pdf')

describe('FileDropZone — drag affordance (L8 / DOC-3 / #162) and the single control (#161 FE-6)', () => {
  it('highlights on a file drag when idle', () => {
    renderZone()
    const zone = zoneEl()
    fireEvent.dragOver(zone, { dataTransfer: fileDataTransfer() })
    expect(zone.className).toContain('drag-over')
  })

  it('does not highlight a non-file drag and marks it no-drop', () => {
    renderZone()
    const zone = zoneEl()
    const dt = fileDataTransfer([], ['text/plain'])
    fireEvent.dragOver(zone, { dataTransfer: dt })
    expect(zone.className).not.toContain('drag-over')
    expect(dt.dropEffect).toBe('none')
  })

  it('while busy: no highlight, a no-drop cursor, and a dropped file is discarded', () => {
    // Pre-fix the busy zone preventDefaulted dragOver (the OS showed an allowed/copy cursor),
    // then onDrop silently returned — the file vanished with no feedback.
    const onDropFiles = vi.fn()
    renderZone({ onDropFiles, busy: true })
    const zone = zoneEl()
    const over = fileDataTransfer()
    fireEvent.dragOver(zone, { dataTransfer: over })
    expect(zone.className).not.toContain('drag-over')
    expect(over.dropEffect).toBe('none')

    fireEvent.drop(zone, { dataTransfer: fileDataTransfer([file()]) })
    expect(onDropFiles).not.toHaveBeenCalled()
  })

  it('discards a non-file drop', () => {
    const onDropFiles = vi.fn()
    renderZone({ onDropFiles })
    fireEvent.drop(zoneEl(), { dataTransfer: fileDataTransfer([file()], ['text/plain']) })
    expect(onDropFiles).not.toHaveBeenCalled()
  })

  it('delivers the files on a real file drop when idle', () => {
    const onDropFiles = vi.fn()
    renderZone({ onDropFiles })
    const dropped = file()
    dropFiles(zoneEl(), [dropped])
    expect(onDropFiles).toHaveBeenCalledWith([dropped])
  })

  it('#162 (FE-7): a dragleave INTO a child keeps the highlight; leaving the zone clears it', () => {
    renderZone()
    const zone = zoneEl()
    fireEvent.dragOver(zone, { dataTransfer: fileDataTransfer() })
    expect(zone.className).toContain('drag-over')

    // Crossing onto the inner title fires dragleave with the child as relatedTarget — the
    // old handler cleared unconditionally and the dashes blinked at every child boundary.
    // (jsdom drops `relatedTarget` from the fireEvent init for drag events, so build the
    // event explicitly and stamp the property.)
    const title = screen.getByText(TITLE)
    const intoChild = createEvent.dragLeave(zone)
    Object.defineProperty(intoChild, 'relatedTarget', { value: title })
    fireEvent(zone, intoChild)
    expect(zone.className).toContain('drag-over')

    // Actually leaving the zone (relatedTarget outside — or null, leaving the window) clears.
    const outOfZone = createEvent.dragLeave(zone)
    Object.defineProperty(outOfZone, 'relatedTarget', { value: document.body })
    fireEvent(zone, outOfZone)
    expect(zone.className).not.toContain('drag-over')
  })

  it('the zone carries NO button role; the inner Button is the one interactive control', () => {
    const onChoose = vi.fn()
    renderZone({ onChoose })
    // Exactly ONE button in the tree — the nested-interactive double tab stop is gone.
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent(CHOOSE)
    expect(zoneEl().getAttribute('role')).toBeNull()
    expect(zoneEl().getAttribute('tabindex')).toBeNull()

    // The keyboard path is the native button (Enter/Space activate a real <button> via click).
    fireEvent.click(buttons[0])
    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it('the choose Button is disabled while busy; a zone click is inert too', () => {
    const onChoose = vi.fn()
    renderZone({ onChoose, busy: true })
    const button = screen.getByRole('button', { name: CHOOSE })
    expect(button).toBeDisabled()
    fireEvent.click(zoneEl())
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('a zone click (the redundant pointer affordance) still opens the picker when idle', () => {
    const onChoose = vi.fn()
    renderZone({ onChoose })
    fireEvent.click(zoneEl())
    expect(onChoose).toHaveBeenCalledTimes(1)
  })
})
