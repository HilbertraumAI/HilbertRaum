// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ImageDropZone } from '../../src/renderer/images/ImageDropZone'
import { t } from '../../src/shared/i18n'

// DOC-3 (frontend audit 2026-08-09, #143): ImageDropZone now carries the same L8 drag-affordance
// hardening its sibling TranslateDropZone established — only a real FILE drag lights up / is
// accepted, and a busy zone shows the OS no-drop cursor (dropEffect 'none', no preventDefault)
// instead of showing a copy cursor and then silently discarding the drop mid-analysis.

afterEach(cleanup)

/** A minimal mutable DataTransfer stand-in so a test can observe `dropEffect` the handler sets. */
function dataTransfer(types: string[], files: File[] = []): { types: string[]; files: File[]; dropEffect: string } {
  return { types, files, dropEffect: 'copy' }
}

function zoneEl(): HTMLElement {
  return screen.getByRole('button', { name: t('en', 'images.drop.title') })
}

describe('ImageDropZone — drag affordance parity with TranslateDropZone (DOC-3)', () => {
  it('highlights on a file drag when idle', () => {
    render(<ImageDropZone onDropFiles={vi.fn()} onChoose={vi.fn()} />)
    const zone = zoneEl()
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer(['Files']) })
    expect(zone.className).toContain('drag-over')
  })

  it('does not highlight a non-file drag and marks it no-drop', () => {
    render(<ImageDropZone onDropFiles={vi.fn()} onChoose={vi.fn()} />)
    const zone = zoneEl()
    const dt = dataTransfer(['text/plain'])
    fireEvent.dragOver(zone, { dataTransfer: dt })
    expect(zone.className).not.toContain('drag-over')
    expect(dt.dropEffect).toBe('none')
  })

  it('while busy: no highlight, a no-drop cursor, and a dropped file is discarded', () => {
    // Pre-fix the busy zone preventDefaulted dragOver (OS showed an allowed/copy cursor),
    // then onDrop silently returned — the file vanished with no feedback.
    const onDropFiles = vi.fn()
    render(<ImageDropZone onDropFiles={onDropFiles} onChoose={vi.fn()} busy />)
    const zone = zoneEl()
    const over = dataTransfer(['Files'])
    fireEvent.dragOver(zone, { dataTransfer: over })
    expect(zone.className).not.toContain('drag-over')
    expect(over.dropEffect).toBe('none')

    fireEvent.drop(zone, { dataTransfer: dataTransfer(['Files'], [new File(['x'], 'a.png')]) })
    expect(onDropFiles).not.toHaveBeenCalled()
  })

  it('discards a non-file drop', () => {
    const onDropFiles = vi.fn()
    render(<ImageDropZone onDropFiles={onDropFiles} onChoose={vi.fn()} />)
    fireEvent.drop(zoneEl(), { dataTransfer: dataTransfer(['text/plain'], [new File(['x'], 'a.png')]) })
    expect(onDropFiles).not.toHaveBeenCalled()
  })

  it('delivers the files on a real file drop when idle', () => {
    const onDropFiles = vi.fn()
    render(<ImageDropZone onDropFiles={onDropFiles} onChoose={vi.fn()} />)
    const file = new File(['png'], 'a.png')
    fireEvent.drop(zoneEl(), { dataTransfer: dataTransfer(['Files'], [file]) })
    expect(onDropFiles).toHaveBeenCalledWith([file])
  })
})
