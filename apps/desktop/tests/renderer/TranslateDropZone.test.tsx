// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TranslateDropZone } from '../../src/renderer/translate/TranslateDropZone'
import { t } from '../../src/shared/i18n'

// Component test for the Translate document drop zone (TG-5) — the TA-3 / L8 drag-affordance
// hardening: only a real FILE drag lights up / is accepted, and a busy zone shows the OS no-drop
// cursor (dropEffect 'none', no preventDefault) instead of luring a drop it would silently discard.
// Keyboard activation (WCAG 2.5.7 non-drag path) must keep working when idle and be inert when busy.

afterEach(cleanup)

/** A minimal mutable DataTransfer stand-in so a test can observe `dropEffect` the handler sets. */
function dataTransfer(types: string[], files: File[] = []): { types: string[]; files: File[]; dropEffect: string } {
  return { types, files, dropEffect: 'copy' }
}

function zoneEl(): HTMLElement {
  return screen.getByRole('button', { name: t('en', 'translate.drop.title') })
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
})

describe('TranslateDropZone — keyboard activation (WCAG 2.5.7)', () => {
  it('Enter and Space trigger choose when idle, and are inert while busy', () => {
    const onChoose = vi.fn()
    const { rerender } = render(<TranslateDropZone onDropFiles={vi.fn()} onChoose={onChoose} />)
    const zone = zoneEl()
    zone.focus()
    fireEvent.keyDown(zone, { key: 'Enter' })
    fireEvent.keyDown(zone, { key: ' ' })
    expect(onChoose).toHaveBeenCalledTimes(2)

    onChoose.mockClear()
    rerender(<TranslateDropZone onDropFiles={vi.fn()} onChoose={onChoose} busy />)
    fireEvent.keyDown(zone, { key: 'Enter' })
    expect(onChoose).not.toHaveBeenCalled()
  })
})

/** Small wrapper so the file-drop assertion reads cleanly. */
function TranslateDropFilesHarness({ onDropFiles }: { onDropFiles: (files: File[]) => void }): JSX.Element {
  return <TranslateDropZone onDropFiles={onDropFiles} onChoose={vi.fn()} />
}
