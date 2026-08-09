// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, createEvent, fireEvent } from '@testing-library/react'
import { TranslateDropZone } from '../../src/renderer/translate/TranslateDropZone'
import { t } from '../../src/shared/i18n'

// Component test for the Translate document drop zone (TG-5) — the TA-3 / L8 drag-affordance
// hardening: only a real FILE drag lights up / is accepted, and a busy zone shows the OS no-drop
// cursor (dropEffect 'none', no preventDefault) instead of luring a drop it would silently discard.
// #161 (FE-6): the zone is a plain drag surface now — the inner "or choose a document" <Button>
// is THE single accessible control (WCAG 2.5.7 non-drag path), never a nested interactive inside
// a role="button". #162 (FE-7): a drag across the zone's children must not flicker the highlight.

afterEach(cleanup)

/** A minimal mutable DataTransfer stand-in so a test can observe `dropEffect` the handler sets. */
function dataTransfer(types: string[], files: File[] = []): { types: string[]; files: File[]; dropEffect: string } {
  return { types, files, dropEffect: 'copy' }
}

/** The drag surface: the zone div AROUND the visible title (no ARIA role — FE-6). */
function zoneEl(): HTMLElement {
  const el = screen.getByText(t('en', 'translate.drop.title')).closest('.translate-dropzone')
  if (!(el instanceof HTMLElement)) throw new Error('drop zone not rendered')
  return el
}

describe('TranslateDropZone — drag affordance (L8)', () => {
  it('highlights on a file drag when idle', () => {
    render(<TranslateDropZone onDropFiles={vi.fn()} onChoose={vi.fn()} />)
    const zone = zoneEl()
    const dt = dataTransfer(['Files'])
    fireEvent.dragOver(zone, { dataTransfer: dt })
    expect(zone.className).toContain('drag-over')
  })

  it('does not highlight a non-file drag and marks it no-drop', () => {
    render(<TranslateDropZone onDropFiles={vi.fn()} onChoose={vi.fn()} />)
    const zone = zoneEl()
    const dt = dataTransfer(['text/plain'])
    fireEvent.dragOver(zone, { dataTransfer: dt })
    expect(zone.className).not.toContain('drag-over')
    expect(dt.dropEffect).toBe('none')
  })

  it('while busy: no highlight, a no-drop cursor, and a dropped file is discarded', () => {
    const onDropFiles = vi.fn()
    render(<TranslateDropZone onDropFiles={onDropFiles} onChoose={vi.fn()} busy />)
    const zone = zoneEl()
    const over = dataTransfer(['Files'])
    fireEvent.dragOver(zone, { dataTransfer: over })
    expect(zone.className).not.toContain('drag-over')
    expect(over.dropEffect).toBe('none')

    fireEvent.drop(zone, { dataTransfer: dataTransfer(['Files'], [new File(['x'], 'a.pdf')]) })
    expect(onDropFiles).not.toHaveBeenCalled()
  })

  it('discards a non-file drop', () => {
    const onDropFiles = vi.fn()
    render(<TranslateDropZone onDropFiles={onDropFiles} onChoose={vi.fn()} />)
    fireEvent.drop(zoneEl(), { dataTransfer: dataTransfer(['text/plain'], [new File(['x'], 'a.pdf')]) })
    expect(onDropFiles).not.toHaveBeenCalled()
  })

  it('delivers the files on a real file drop when idle', () => {
    const onDropFiles = vi.fn()
    render(<TranslateDropFilesHarness onDropFiles={onDropFiles} />)
    const file = new File(['%PDF'], 'a.pdf')
    fireEvent.drop(zoneEl(), { dataTransfer: dataTransfer(['Files'], [file]) })
    expect(onDropFiles).toHaveBeenCalledWith([file])
  })

  it('#162 (FE-7): a dragleave INTO a child keeps the highlight; leaving the zone clears it', () => {
    render(<TranslateDropZone onDropFiles={vi.fn()} onChoose={vi.fn()} />)
    const zone = zoneEl()
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer(['Files']) })
    expect(zone.className).toContain('drag-over')

    // Crossing onto the inner title fires dragleave with the child as relatedTarget — the
    // old handler cleared unconditionally and the dashes blinked at every child boundary.
    // (jsdom drops `relatedTarget` from the fireEvent init for drag events, so build the
    // event explicitly and stamp the property.)
    const title = screen.getByText(t('en', 'translate.drop.title'))
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
})

describe('TranslateDropZone — the single accessible control (#161 FE-6, WCAG 2.5.7)', () => {
  it('the zone carries NO button role; the inner Button is the one interactive control', () => {
    const onChoose = vi.fn()
    render(<TranslateDropZone onDropFiles={vi.fn()} onChoose={onChoose} />)
    // Exactly ONE button in the tree — the nested-interactive double tab stop is gone.
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent(t('en', 'translate.drop.choose'))
    expect(zoneEl().getAttribute('role')).toBeNull()
    expect(zoneEl().getAttribute('tabindex')).toBeNull()

    // The keyboard path is the native button (Enter/Space activate a real <button> via click).
    fireEvent.click(buttons[0])
    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it('the choose Button is disabled while busy; a zone click is inert too', () => {
    const onChoose = vi.fn()
    render(<TranslateDropZone onDropFiles={vi.fn()} onChoose={onChoose} busy />)
    const button = screen.getByRole('button', { name: t('en', 'translate.drop.choose') })
    expect(button).toBeDisabled()
    fireEvent.click(zoneEl())
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('a zone click (the redundant pointer affordance) still opens the picker when idle', () => {
    const onChoose = vi.fn()
    render(<TranslateDropZone onDropFiles={vi.fn()} onChoose={onChoose} />)
    fireEvent.click(zoneEl())
    expect(onChoose).toHaveBeenCalledTimes(1)
  })
})

/** Small wrapper so the file-drop assertion reads cleanly. */
function TranslateDropFilesHarness({ onDropFiles }: { onDropFiles: (files: File[]) => void }): JSX.Element {
  return <TranslateDropZone onDropFiles={onDropFiles} onChoose={vi.fn()} />
}
