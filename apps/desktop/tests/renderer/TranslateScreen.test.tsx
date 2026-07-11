// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TranslateScreen } from '../../src/renderer/screens/TranslateScreen'
import { resetTranslateSessionForTests } from '../../src/renderer/lib/translateSession'
import { resetFileTranslateSessionForTests } from '../../src/renderer/lib/fileTranslateSession'
import { resetDocTaskStoreForTests } from '../../src/renderer/lib/doctasks'
import { en, t } from '../../src/shared/i18n'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import type { AppStatus, DocTaskStatus, TranslateJob } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Renderer test (jsdom + RTL) for the Translate screen state machine (TranslateGemma plan §2 D6/D7,
// TG-4/5). The TEXT path is driven by capturing the onTranslate* subscriber callbacks and invoking
// them; the DOCUMENT path drives the import → doc-task → materialize polling with stubbed IPC.
// Both active translations live in module-level stores (survive navigation), reset between tests.

afterEach(() => {
  cleanup()
  resetTranslateSessionForTests()
  resetFileTranslateSessionForTests()
  resetDocTaskStoreForTests()
})

function appStatus(over: Partial<AppStatus> = {}): AppStatus {
  return {
    appName: 'x',
    appVersion: '0',
    offlineMode: true,
    networkAllowed: false,
    activeModelId: null,
    hardwareProfile: 'UNKNOWN',
    workspaceMode: 'plaintext_dev',
    workspaceReady: true,
    machineRamGb: 16,
    dictationAvailable: false,
    ocrAvailable: false,
    translationAvailable: true,
    ...over
  } as AppStatus
}

/** Stream-driving stubs: capture the subscriber callbacks so a test can push tokens/done/error. */
function streamStubs(startJob: TranslateJob = { jobId: 'j1', state: 'queued', text: '' }) {
  const token: { fn?: (t: string) => void } = {}
  const done: { fn?: (j: TranslateJob) => void } = {}
  const error: { fn?: (j: TranslateJob) => void } = {}
  const translateStart = vi.fn(async () => startJob)
  const translateCancel = vi.fn(async () => ({ jobId: 'j1', state: 'cancelled' }) as TranslateJob)
  const copyToClipboard = vi.fn(async () => true)
  return {
    token,
    done,
    error,
    translateStart,
    translateCancel,
    copyToClipboard,
    api: {
      getAppStatus: vi.fn(async () => appStatus()),
      getActiveTranslateJob: vi.fn(async () => null),
      translateStart,
      translateCancel,
      copyToClipboard,
      onTranslateToken: vi.fn((_id: string, cb: (t: string) => void) => {
        token.fn = cb
        return () => {}
      }),
      onTranslateDone: vi.fn((_id: string, cb: (j: TranslateJob) => void) => {
        done.fn = cb
        return () => {}
      }),
      onTranslateError: vi.fn((_id: string, cb: (j: TranslateJob) => void) => {
        error.fn = cb
        return () => {}
      })
    }
  }
}

describe('TranslateScreen — availability (O2 install path)', () => {
  it('shows the model-missing EmptyState and deep-links to AI Model', async () => {
    const onNavigate = vi.fn()
    stubApi({
      getAppStatus: vi.fn(async () => appStatus({ translationAvailable: false })),
      getActiveTranslateJob: vi.fn(async () => null)
    } as never)
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={onNavigate} />)

    expect(await screen.findByText(t('en', 'translate.avail.noModel'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: t('en', 'translate.avail.cta') }))
    expect(onNavigate).toHaveBeenCalledWith('models')
  })
})

describe('TranslateScreen — device hint (issue #42 reopen)', () => {
  it('shows the full-offload GPU hint once the sidecar has started', async () => {
    stubApi({
      getAppStatus: vi.fn(async () =>
        appStatus({ translationDevice: { device: 'auto', gpuLayers: 49, totalLayers: 49, live: true } })
      ),
      getActiveTranslateJob: vi.fn(async () => null)
    } as never)
    render(<TranslateScreen onNavigate={vi.fn()} />)
    expect(
      await screen.findByText(t('en', 'translate.device.gpu', { done: 49, total: 49 }))
    ).toBeInTheDocument()
  })

  it('a PARTIAL offload shows the near-CPU-speed form with the contention tooltip (the reopened-#42 case)', async () => {
    stubApi({
      getAppStatus: vi.fn(async () =>
        appStatus({ translationDevice: { device: 'auto', gpuLayers: 12, totalLayers: 49, live: false } })
      ),
      getActiveTranslateJob: vi.fn(async () => null)
    } as never)
    render(<TranslateScreen onNavigate={vi.fn()} />)
    const hint = await screen.findByText(t('en', 'translate.device.gpuPartial', { done: 12, total: 49 }))
    // The tooltip carries the cause (VRAM taken by the chat model) + the remedy (re-fit after idle).
    expect(hint).toHaveAttribute('title', t('en', 'translate.device.partialTitle'))
  })

  it('CODE-23: a fully-starved fit (0 layers) says processor, not "partly on the graphics card"', async () => {
    stubApi({
      getAppStatus: vi.fn(async () =>
        appStatus({ translationDevice: { device: 'auto', gpuLayers: 0, totalLayers: 49, live: false } })
      ),
      getActiveTranslateJob: vi.fn(async () => null)
    } as never)
    render(<TranslateScreen onNavigate={vi.fn()} />)
    // Pre-fix this rendered the contradictory "runs only partly on the graphics card
    // (0/49 layers)" (full-audit 2026-07-11 CODE-23).
    const hint = await screen.findByText(t('en', 'translate.device.gpuNone', { total: 49 }))
    expect(hint).toHaveAttribute('title', t('en', 'translate.device.gpuNoneTitle'))
    expect(
      screen.queryByText(t('en', 'translate.device.gpuPartial', { done: 0, total: 49 }))
    ).not.toBeInTheDocument()
  })

  it('a forced-CPU start shows the CPU form; no outcome yet shows NO hint', async () => {
    stubApi({
      getAppStatus: vi.fn(async () =>
        appStatus({ translationDevice: { device: 'cpu', gpuLayers: null, totalLayers: null, live: true } })
      ),
      getActiveTranslateJob: vi.fn(async () => null)
    } as never)
    const { unmount } = render(<TranslateScreen onNavigate={vi.fn()} />)
    expect(await screen.findByText(t('en', 'translate.device.cpu'))).toBeInTheDocument()
    unmount()

    // Before the sidecar's first start (translationDevice null) the line is absent entirely.
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
      getActiveTranslateJob: vi.fn(async () => null)
    } as never)
    const { container } = render(<TranslateScreen onNavigate={vi.fn()} />)
    await screen.findByText(t('en', 'translate.action'))
    expect(container.querySelector('.translate-device-hint')).toBeNull()
  })
})

describe('TranslateScreen — translate → stream → copy', () => {
  it('types text, translates, streams the output, and copies it', async () => {
    const s = streamStubs()
    stubApi(s.api as never)
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={() => {}} />)

    const input = await screen.findByLabelText(t('en', 'translate.input.label'))
    await user.type(input, 'Hallo Welt.')
    await user.click(screen.getByRole('button', { name: t('en', 'translate.action') }))

    expect(s.translateStart).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLang: 'de', targetLang: 'en', text: 'Hallo Welt.' })
    )
    // The stream is wired once the start round-trip resolves. Scope assertions to the output
    // panel (aria-label "Translation") — the sr-only StreamAnnouncer also mirrors the text.
    await waitFor(() => expect(s.token.fn).toBeDefined())
    act(() => s.token.fn!('Hello '))
    const outPanel = screen.getByLabelText(t('en', 'translate.output.label'))
    expect(await within(outPanel).findByText('Hello', { exact: false })).toBeInTheDocument()
    act(() => s.done.fn!({ jobId: 'j1', state: 'done', text: 'Hello world.' }))
    expect(await within(outPanel).findByText('Hello world.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('en', 'translate.copy') }))
    expect(s.copyToClipboard).toHaveBeenCalledWith('Hello world.')
  })

  it('shows Stop while translating and cancels the job', async () => {
    const s = streamStubs()
    stubApi(s.api as never)
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={() => {}} />)

    await user.type(await screen.findByLabelText(t('en', 'translate.input.label')), 'Hallo')
    await user.click(screen.getByRole('button', { name: t('en', 'translate.action') }))
    await waitFor(() => expect(s.token.fn).toBeDefined())

    await user.click(screen.getByRole('button', { name: t('en', 'translate.stop') }))
    expect(s.translateCancel).toHaveBeenCalledWith('j1')
  })

  it('surfaces a docTaskBusy refusal as a friendly banner', async () => {
    const s = streamStubs({ jobId: 'x', state: 'failed', error: 'docTaskBusy' })
    stubApi(s.api as never)
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={() => {}} />)

    await user.type(await screen.findByLabelText(t('en', 'translate.input.label')), 'Hallo')
    await user.click(screen.getByRole('button', { name: t('en', 'translate.action') }))
    expect(await screen.findByText(t('en', 'translate.err.docTaskBusy'))).toBeInTheDocument()
  })

  it('a dismissed error banner clears the store state (does not stick / reappear on remount)', async () => {
    const s = streamStubs({ jobId: 'x', state: 'failed', error: 'runtimeFailed' })
    stubApi(s.api as never)
    const user = userEvent.setup()
    const { unmount } = render(<TranslateScreen onNavigate={() => {}} />)

    await user.type(await screen.findByLabelText(t('en', 'translate.input.label')), 'Hallo')
    await user.click(screen.getByRole('button', { name: t('en', 'translate.action') }))
    expect(await screen.findByText(t('en', 'translate.err.runtimeFailed'))).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('en', 'common.dismiss') }))
    expect(screen.queryByText(t('en', 'translate.err.runtimeFailed'))).not.toBeInTheDocument()

    // Remount: the failed state was cleared in the store, so the banner does NOT come back.
    unmount()
    render(<TranslateScreen onNavigate={() => {}} />)
    await screen.findByLabelText(t('en', 'translate.input.label'))
    expect(screen.queryByText(t('en', 'translate.err.runtimeFailed'))).not.toBeInTheDocument()
  })
})

describe('TranslateScreen — language selects', () => {
  it('swaps the source and target languages', async () => {
    const s = streamStubs()
    stubApi(s.api as never)
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={() => {}} />)

    const from = (await screen.findByLabelText(t('en', 'translate.from'))) as HTMLSelectElement
    const to = screen.getByLabelText(t('en', 'translate.to')) as HTMLSelectElement
    expect(from.value).toBe('de')
    expect(to.value).toBe('en')

    await user.click(screen.getByRole('button', { name: t('en', 'translate.swap') }))
    expect(from.value).toBe('en')
    expect(to.value).toBe('de')
  })

  it('disables Translate and hints when source equals target', async () => {
    const s = streamStubs()
    stubApi(s.api as never)
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={() => {}} />)

    await user.type(await screen.findByLabelText(t('en', 'translate.input.label')), 'Hallo')
    // Make the target match the source (both 'de').
    await user.selectOptions(screen.getByLabelText(t('en', 'translate.to')), 'de')
    expect(screen.getByRole('button', { name: t('en', 'translate.action') })).toBeDisabled()
    expect(screen.getByText(t('en', 'translate.err.sameLang'))).toBeInTheDocument()
    expect(s.translateStart).not.toHaveBeenCalled()
  })
})

// ---- TG-5: document drag-and-drop + file translation ----

function docTask(over: Partial<DocTaskStatus> = {}): DocTaskStatus {
  return {
    jobId: 'task1',
    kind: 'translation',
    documentIds: ['d1'],
    state: 'running',
    progress: { stepsDone: 0, stepsTotal: 0 },
    ...over
  }
}

/** Stubs the full drop → import → doc-task → materialize pipeline. `getDocTask` returns `running`
 *  once, then the supplied `done`/`failed` status on every later poll. */
function fileStubs(opts: {
  documentIds?: string[]
  terminal?: DocTaskStatus
  preview?: { segments: { text: string }[]; nextOffset?: number | null }
} = {}) {
  const importDocuments = vi.fn(async () => ({
    jobId: 'imp1',
    documentIds: opts.documentIds ?? ['d1']
  }))
  const getImportJob = vi.fn(async () => ({
    jobId: 'imp1',
    total: 1,
    completed: 1,
    failed: 0,
    done: true
  }))
  const startDocTask = vi.fn(async () => ({ jobId: 'task1' }))
  let taskPolls = 0
  const terminal =
    opts.terminal ??
    docTask({ state: 'done', progress: { stepsDone: 3, stepsTotal: 3 }, resultRef: { documentId: 'gen1' } })
  const getDocTask = vi.fn(async () => {
    taskPolls += 1
    return taskPolls === 1 ? docTask({ progress: { stepsDone: 1, stepsTotal: 3 } }) : terminal
  })
  const previewDocument = vi.fn(async () => ({
    id: 'gen1',
    title: 'a (English)',
    mimeType: 'text/markdown',
    segments: (opts.preview?.segments ?? [{ text: 'Hello world.' }]).map((s) => ({
      text: s.text,
      pageNumber: null,
      sectionLabel: null
    })),
    nextOffset: opts.preview?.nextOffset
  }))
  const exportDocument = vi.fn(async () => 'C:\\out\\a (English).md')
  const pickDocuments = vi.fn(async () => ({ token: 'tok1', paths: ['C:\\docs\\a.pdf'] }))
  const getDroppedFilePath = vi.fn(() => 'C:\\docs\\a.pdf')
  return {
    importDocuments,
    getImportJob,
    startDocTask,
    getDocTask,
    previewDocument,
    exportDocument,
    pickDocuments,
    getDroppedFilePath,
    api: {
      getAppStatus: vi.fn(async () => appStatus()),
      getActiveTranslateJob: vi.fn(async () => null),
      copyToClipboard: vi.fn(async () => true),
      importDocuments,
      getImportJob,
      startDocTask,
      getDocTask,
      previewDocument,
      exportDocument,
      pickDocuments,
      getDroppedFilePath
    }
  }
}

function dropOnZone(files: File[], zoneName: string = t('en', 'translate.drop.title')): void {
  const zone = screen.getByRole('button', { name: zoneName })
  // A real file drag reports the 'Files' type — the zone gates on it (L8).
  fireEvent.drop(zone, { dataTransfer: { files, types: ['Files'] } })
}

describe('TranslateScreen — document translation (TG-5)', () => {
  it('drops a document → imports as temporary → runs the doc-task → shows the materialized text', async () => {
    const f = fileStubs()
    stubApi(f.api as never)
    render(<TranslateScreen onNavigate={() => {}} />)
    await screen.findByLabelText(t('en', 'translate.input.label'))

    const pdf = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })
    act(() => dropOnZone([pdf]))

    // The dropped file is imported into the Temporary destination (no picker token).
    await waitFor(() => expect(f.importDocuments).toHaveBeenCalled())
    expect(f.importDocuments).toHaveBeenCalledWith(['C:\\docs\\a.pdf'], {
      destination: { kind: 'temporary' }
    })
    // Then the translation doc-task runs over the ingested document with the chosen languages.
    await waitFor(() => expect(f.startDocTask).toHaveBeenCalled())
    expect(f.startDocTask).toHaveBeenCalledWith({
      kind: 'translation',
      documentIds: ['d1'],
      params: { sourceLang: 'de', targetLang: 'en' }
    })
    // The materialized Markdown lands in the output panel.
    const outPanel = await screen.findByLabelText(t('en', 'translate.output.label'))
    expect(await within(outPanel).findByText('Hello world.', {}, { timeout: 8000 })).toBeInTheDocument()
  }, 10000)

  it('translates a document via the choose-a-document picker path', async () => {
    const f = fileStubs()
    stubApi(f.api as never)
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={() => {}} />)
    await screen.findByLabelText(t('en', 'translate.input.label'))

    await user.click(screen.getByRole('button', { name: t('en', 'translate.drop.choose') }))
    await waitFor(() => expect(f.pickDocuments).toHaveBeenCalledWith('files'))
    // A picked import carries the one-time capability token back to main (D1).
    await waitFor(() =>
      expect(f.importDocuments).toHaveBeenCalledWith(['C:\\docs\\a.pdf'], {
        destination: { kind: 'temporary' },
        pickerToken: 'tok1'
      })
    )
    const outPanel = await screen.findByLabelText(t('en', 'translate.output.label'))
    expect(await within(outPanel).findByText('Hello world.', {}, { timeout: 8000 })).toBeInTheDocument()
  }, 10000)

  it('rejects a multi-file drop with a friendly banner (no import)', async () => {
    const f = fileStubs()
    stubApi(f.api as never)
    render(<TranslateScreen onNavigate={() => {}} />)
    await screen.findByLabelText(t('en', 'translate.input.label'))

    act(() =>
      dropOnZone([
        new File(['a'], 'a.pdf', { type: 'application/pdf' }),
        new File(['b'], 'b.pdf', { type: 'application/pdf' })
      ])
    )
    expect(await screen.findByText(t('en', 'translate.file.err.multiDrop'))).toBeInTheDocument()
    expect(f.importDocuments).not.toHaveBeenCalled()
  })

  it('a rejected multi-drop keeps the existing text result (restored when the banner is dismissed)', async () => {
    // Combine the text stubs (for a text translation) with the file stubs' getDroppedFilePath.
    const s = streamStubs()
    const f = fileStubs()
    stubApi({ ...s.api, ...f.api } as never)
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={() => {}} />)

    // First: a completed TEXT translation showing in the panel.
    await user.type(await screen.findByLabelText(t('en', 'translate.input.label')), 'Hallo')
    await user.click(screen.getByRole('button', { name: t('en', 'translate.action') }))
    await waitFor(() => expect(s.done.fn).toBeDefined())
    act(() => s.done.fn!({ jobId: 'j1', state: 'done', text: 'Hello world.' }))
    const outPanel = screen.getByLabelText(t('en', 'translate.output.label'))
    await within(outPanel).findByText('Hello world.')

    // A fat-fingered multi-file drop is REJECTED. The text result must NOT be destroyed.
    act(() =>
      dropOnZone([
        new File(['a'], 'a.pdf', { type: 'application/pdf' }),
        new File(['b'], 'b.pdf', { type: 'application/pdf' })
      ])
    )
    expect(await screen.findByText(t('en', 'translate.file.err.multiDrop'))).toBeInTheDocument()
    expect(f.importDocuments).not.toHaveBeenCalled()

    // Dismissing the error restores the text translation (it was never cleared).
    await user.click(screen.getByRole('button', { name: t('en', 'common.dismiss') }))
    expect(await within(outPanel).findByText('Hello world.')).toBeInTheDocument()
  })

  it('shows a friendly error when the dropped file type is unsupported (nothing imported)', async () => {
    const f = fileStubs({ documentIds: [] }) // main imported nothing supported
    stubApi(f.api as never)
    render(<TranslateScreen onNavigate={() => {}} />)
    await screen.findByLabelText(t('en', 'translate.input.label'))

    act(() => dropOnZone([new File(['x'], 'a.xyz', { type: '' })]))
    expect(await screen.findByText(t('en', 'translate.file.err.unsupported'))).toBeInTheDocument()
    expect(f.startDocTask).not.toHaveBeenCalled()
  }, 10000)

  it('exports the materialized document and can show it in Documents', async () => {
    const f = fileStubs()
    stubApi(f.api as never)
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(<TranslateScreen onNavigate={onNavigate} />)
    await screen.findByLabelText(t('en', 'translate.input.label'))

    act(() => dropOnZone([new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })]))
    const outPanel = await screen.findByLabelText(t('en', 'translate.output.label'))
    await within(outPanel).findByText('Hello world.', {}, { timeout: 8000 })

    await user.click(screen.getByRole('button', { name: t('en', 'translate.file.export') }))
    expect(f.exportDocument).toHaveBeenCalledWith('gen1')

    await user.click(screen.getByRole('button', { name: t('en', 'translate.file.show') }))
    expect(onNavigate).toHaveBeenCalledWith('documents')
  }, 10000)

  it('CODE-42: a persisted-English doc-task failure message localizes in the German UI', async () => {
    // Doc-task failure messages are persist-canonical ENGLISH (D-L4); the banner must route
    // them through localizeServerCopy like DocumentsScreen does (DR-7 parity — full-audit
    // 2026-07-11 CODE-42). Rendered under the real I18nProvider forced to German.
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    try {
      const f = fileStubs({
        terminal: docTask({ state: 'failed', error: en['main.chat.docTaskBusy'] })
      })
      stubApi(f.api as never)
      render(
        <I18nProvider>
          <TranslateScreen onNavigate={() => {}} />
        </I18nProvider>
      )
      await screen.findByLabelText(t('de', 'translate.input.label'))

      act(() =>
        dropOnZone(
          [new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })],
          t('de', 'translate.drop.title')
        )
      )
      // The German banner copy shows — not the raw persisted English constant.
      expect(
        await screen.findByText(t('de', 'main.chat.docTaskBusy'), {}, { timeout: 8000 })
      ).toBeInTheDocument()
      expect(screen.queryByText(en['main.chat.docTaskBusy'])).not.toBeInTheDocument()
    } finally {
      window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
    }
  }, 10000)

  it('surfaces a truncated hint when only the start of a long translation is shown', async () => {
    const f = fileStubs({ preview: { segments: [{ text: 'Beginning…' }], nextOffset: 40 } })
    stubApi(f.api as never)
    render(<TranslateScreen onNavigate={() => {}} />)
    await screen.findByLabelText(t('en', 'translate.input.label'))

    act(() => dropOnZone([new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })]))
    expect(
      await screen.findByText(t('en', 'translate.file.truncated'), {}, { timeout: 8000 })
    ).toBeInTheDocument()
  }, 10000)
})
