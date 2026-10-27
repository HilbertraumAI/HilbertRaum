// @vitest-environment jsdom
// Renderer tests for the in-app OCR language-file install (#410): the Documents rows
// (a failed scan or photo needing the files) and the AI Model screen's quiet row, both
// driven by `useOcrInstall`/`OcrInstall.tsx`. Assertions read copy from the i18n catalogs
// (never hand-typed strings) the way DocumentsScreen.test.tsx / ModelsScreen.test.tsx /
// KnowledgePacks.test.tsx / GermanSmoke.test.tsx already do.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, cleanup, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { ModelsScreen, __resetModelsScreenMemoryForTests } from '../../src/renderer/screens/ModelsScreen'
import { __resetOcrInstallForTests, useOcrInstall } from '../../src/renderer/lib/useOcrInstall'
import { ToastProvider } from '../../src/renderer/components'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { en, de, t as translate } from '../../src/shared/i18n'
import {
  DEFAULT_SETTINGS,
  type DocumentInfo,
  type OcrInstallJob,
  type OcrInstallLanguage,
  type OcrInstallStatus,
  type PolicyStatus
} from '../../src/shared/types'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { appStatus as appStatusFixture, makePolicyStatus } from '../helpers/status'
import { hangBudgetMs } from '../helpers/hang-budget'

/** The banner text is built from several sibling text nodes (the stored error + the appended
 *  OCR remedy), so an exact-string `findByText` never matches the whole thing and a literal
 *  `new RegExp(catalogText)` breaks on the catalog copy's own parentheses/periods. This escapes
 *  the catalog string first so it matches as a plain substring regardless of layout. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function byText(s: string): RegExp {
  return new RegExp(escapeRegExp(s))
}

function doc(over: Partial<DocumentInfo>): DocumentInfo {
  return {
    id: 'd1',
    title: 'contract.pdf',
    originalPath: '/u/contract.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 7,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over
  }
}

function scanDoc(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return doc({
    id: 'scan1',
    title: 'scan.pdf',
    status: 'failed',
    errorMessage: en['main.ingest.pdfScanDetected'],
    scanDetected: true,
    chunkCount: 0,
    ...over
  })
}

function photoDoc(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return doc({
    id: 'photo1',
    title: 'photo.jpg',
    mimeType: 'image/jpeg',
    status: 'failed',
    errorMessage: en['main.ingest.imageNeedsOcr'],
    scanDetected: false,
    chunkCount: 0,
    ...over
  })
}

/** The two pinned languages, both missing — 1,333,102 + 2,952,873 bytes ≈ "4.1 MB" / "4,1 MB". */
const DEU_SIZE = 1_333_102
const ENG_SIZE = 2_952_873

function ocrStatus(
  languages: OcrInstallLanguage[] = [
    { lang: 'deu', role: 'language', sizeBytes: DEU_SIZE, installed: false },
    { lang: 'eng', role: 'language', sizeBytes: ENG_SIZE, installed: false }
  ],
  over: Partial<OcrInstallStatus> = {}
): OcrInstallStatus {
  return {
    available: true,
    languages,
    totalBytes: languages.filter((l) => !l.installed).reduce((s, l) => s + l.sizeBytes, 0),
    sourceHost: 'ocr.example.org',
    license: 'Apache-2.0',
    ...over
  }
}

function queuedJob(over: Partial<OcrInstallJob> = {}): OcrInstallJob {
  return {
    jobId: 'j1',
    status: 'queued',
    receivedBytes: 0,
    totalBytes: DEU_SIZE + ENG_SIZE,
    outcome: null,
    error: null,
    ...over
  }
}

function allowedPolicy(): PolicyStatus {
  return makePolicyStatus({ network: { allowModelDownloads: true }, allowNetworkSetting: true })
}

function blockedByPolicy(): PolicyStatus {
  return makePolicyStatus({ network: { allowModelDownloads: false }, allowNetworkSetting: true })
}

function german(node: JSX.Element): JSX.Element {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
  return <I18nProvider>{node}</I18nProvider>
}

beforeEach(() => {
  __resetOcrInstallForTests()
  __resetModelsScreenMemoryForTests()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('OcrInstall — Documents rows (#410)', () => {
  it('1: a scan row with the files missing offers the download; the dialog states facts and confirming installs with no arguments', async () => {
    const user = userEvent.setup()
    const installOcr = vi.fn(async () => queuedJob())
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy()),
      installOcr,
      getOcrInstallJob: vi.fn(async () => queuedJob())
    })
    render(<DocumentsScreen />)

    await screen.findByText('scan.pdf')
    expect(await screen.findByText(byText(en['docs.scan.ocrMissing']))).toBeInTheDocument()
    const btn = await screen.findByRole('button', { name: en['ocr.install.action'] })
    expect(btn).toBeEnabled()
    // #572: a scan row never offers Try again (the photo row in test 2 still does).
    expect(screen.queryByRole('button', { name: en['docs.failed.retry'] })).not.toBeInTheDocument()
    await user.click(btn)

    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(`${en['ocr.install.lang.deu']}, ${en['ocr.install.lang.eng']}`)
    ).toBeInTheDocument()
    expect(within(dialog).getByText('4.1 MB')).toBeInTheDocument()
    expect(within(dialog).getByText('Apache-2.0')).toBeInTheDocument()
    expect(within(dialog).getByText('ocr.example.org').tagName).toBe('CODE')
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: en['ocr.install.confirm.start'] }))
    expect(installOcr).toHaveBeenCalledTimes(1)
    expect(installOcr.mock.calls[0]).toHaveLength(0)
  })

  it('2: a failed photo row keeps its stored error, appends the missing-files copy, offers the download, and still offers Try again', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [photoDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy())
    })
    render(<DocumentsScreen />)

    await screen.findByText('photo.jpg')
    expect(await screen.findByText(byText(en['main.ingest.imageNeedsOcr']))).toBeInTheDocument()
    expect(screen.getByText(byText(en['docs.photo.ocrMissing']))).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: en['ocr.install.action'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['docs.failed.retry'] })).toBeInTheDocument()
  })

  it('3: once OCR is available a photo row reads "ready" and offers no download button', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [photoDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: true, ocrState: 'available' }))
    })
    render(<DocumentsScreen />)

    await screen.findByText('photo.jpg')
    expect(await screen.findByText(byText(en['docs.photo.ocrReady']))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en['ocr.install.action'] })).not.toBeInTheDocument()
  })

  it('4: an ordinary failed row gets no OCR copy and no download button', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [
        doc({ id: 'd9', title: 'broken.pdf', status: 'failed', errorMessage: 'EIO: i/o error, read', chunkCount: 0 })
      ]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' }))
    })
    render(<DocumentsScreen />)

    await screen.findByText('broken.pdf')
    expect(screen.queryByText(byText(en['docs.photo.ocrMissing']))).not.toBeInTheDocument()
    expect(screen.queryByText(byText(en['docs.scan.ocrMissing']))).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en['ocr.install.action'] })).not.toBeInTheDocument()
  })

  // The Settings-toggle branch of the shared gate is owned by KnowledgePackToolsInstall.test.tsx (#339 P8-2 it.each).
  it('5: gates closed (the drive policy denies downloads) disable the download button and show why', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => blockedByPolicy())
    })
    render(<DocumentsScreen />)

    await screen.findByText('scan.pdf')
    const btn = await screen.findByRole('button', { name: en['ocr.install.action'] })
    expect(btn).toBeDisabled()
    expect(await screen.findByText(en['models.downloads.blockedByPolicy'])).toBeInTheDocument()
  })

  it('6: with no usable source list on this drive the rows point at the offline path and offer no button', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc(), photoDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus(undefined, { available: false, sourceHost: null })),
      getPolicy: vi.fn(async () => allowedPolicy())
    })
    render(<DocumentsScreen />)

    await screen.findByText('scan.pdf')
    expect(await screen.findByText(byText(en['docs.scan.ocrMissingOffline']))).toBeInTheDocument()
    expect(screen.getByText(byText(en['docs.photo.ocrMissingOffline']))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en['ocr.install.action'] })).not.toBeInTheDocument()
  })

  it('7: a live job shows progress and Cancel calls cancelOcrInstall with the job id', async () => {
    const user = userEvent.setup()
    const cancelOcrInstall = vi.fn(async () => ({ ...queuedJob(), status: 'cancelled' as const }))
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy()),
      installOcr: vi.fn(async () => queuedJob()),
      getOcrInstallJob: vi.fn(async () => queuedJob({ status: 'downloading', receivedBytes: 50, totalBytes: 100 })),
      cancelOcrInstall
    })
    render(<DocumentsScreen />)

    await user.click(await screen.findByRole('button', { name: en['ocr.install.action'] }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: en['ocr.install.confirm.start'] }))

    const progressText = translate('en', 'ocr.install.progress', { pct: 50 })
    expect(await screen.findByText(progressText, {}, { timeout: hangBudgetMs(3000) })).toBeInTheDocument()
    // The OCR-specific label: never the same accessible name as a model download's Cancel.
    expect(en['ocr.install.cancel']).not.toBe(en['models.download.cancel'])
    await user.click(screen.getByRole('button', { name: en['ocr.install.cancel'] }))
    expect(cancelOcrInstall).toHaveBeenCalledWith('j1')
  })

  it('8: a failed job shows the friendly failure and Retry re-opens the dialog', async () => {
    const user = userEvent.setup()
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy()),
      installOcr: vi.fn(async () => queuedJob()),
      getOcrInstallJob: vi.fn(async () => queuedJob({ status: 'failed', error: 'some friendly error', outcome: null }))
    })
    render(<DocumentsScreen />)

    await user.click(await screen.findByRole('button', { name: en['ocr.install.action'] }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: en['ocr.install.confirm.start'] }))

    expect(await screen.findByText(en['ocr.install.failed'], {}, { timeout: hangBudgetMs(3000) })).toBeInTheDocument()
    expect(screen.getByText('some friendly error')).toBeInTheDocument()
    const retryBtn = screen.getByRole('button', { name: en['ocr.install.retry'] })
    await user.click(retryBtn)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('8b: while the engine is being started (activating) there is no Cancel — the files are already in place', async () => {
    const user = userEvent.setup()
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy()),
      installOcr: vi.fn(async () => queuedJob()),
      getOcrInstallJob: vi.fn(async () => queuedJob({ status: 'activating', receivedBytes: DEU_SIZE + ENG_SIZE }))
    })
    render(<DocumentsScreen />)

    await user.click(await screen.findByRole('button', { name: en['ocr.install.action'] }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: en['ocr.install.confirm.start'] }))

    expect(await screen.findByText(en['ocr.install.activating'], {}, { timeout: hangBudgetMs(3000) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en['ocr.install.cancel'] })).not.toBeInTheDocument()
  })

  it('8c: files already on the drive but OCR not started (copied by hand): the row names the restart, not a dead-end download', async () => {
    const installOcr = vi.fn(async () => queuedJob())
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc(), photoDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () =>
        ocrStatus([
          { lang: 'deu', role: 'language', sizeBytes: DEU_SIZE, installed: true },
          { lang: 'eng', role: 'language', sizeBytes: ENG_SIZE, installed: true }
        ])
      ),
      getPolicy: vi.fn(async () => allowedPolicy()),
      installOcr
    })
    render(<DocumentsScreen />)

    // One restart hint per remedy row (the scan and the photo), and nothing to download.
    expect(await screen.findAllByText(en['ocr.install.alreadyPresent'])).toHaveLength(2)
    expect(screen.queryByRole('button', { name: en['ocr.install.action'] })).not.toBeInTheDocument()
    // Neither row still claims the files are missing.
    expect(screen.queryByText(byText(en['docs.scan.ocrMissing']))).not.toBeInTheDocument()
    expect(screen.queryByText(byText(en['docs.photo.ocrMissing']))).not.toBeInTheDocument()
    expect(installOcr).not.toHaveBeenCalled()
  })

  it('9: a done "activated" job toasts, re-reads app status, and the scan row offers OCR without a remount', async () => {
    const user = userEvent.setup()
    const getAppStatus = vi
      .fn()
      .mockResolvedValueOnce(appStatusFixture({ ocrAvailable: false, ocrState: 'missing' }))
      .mockResolvedValue(appStatusFixture({ ocrAvailable: true, ocrState: 'available' }))
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus,
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy()),
      installOcr: vi.fn(async () => queuedJob()),
      getOcrInstallJob: vi.fn(async () => queuedJob({ status: 'done', outcome: 'activated' }))
    })
    render(
      <ToastProvider>
        <DocumentsScreen />
      </ToastProvider>
    )

    await user.click(await screen.findByRole('button', { name: en['ocr.install.action'] }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: en['ocr.install.confirm.start'] }))

    expect(
      await screen.findByText(en['ocr.install.outcome.activated'], {}, { timeout: hangBudgetMs(3000) })
    ).toBeInTheDocument()
    expect(getAppStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await screen.findByRole('button', { name: en['docs.makeSearchable'] })).toBeInTheDocument()
  })

  // #687: a poll answer about ANOTHER job (a late reply for an earlier one) never replaces the current job — no toast
  // and no outcome of its own; the current job's outcome is what the row and the toast show.
  it('9b: a poll reply about another job is ignored; only the current job’s outcome shows (#687)', async () => {
    const user = userEvent.setup()
    const getOcrInstallJob = vi
      .fn()
      .mockResolvedValueOnce(queuedJob({ jobId: 'j0', status: 'done', outcome: 'activated' }))
      .mockResolvedValue(queuedJob({ status: 'done', outcome: 'restartRequired' }))
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy()),
      installOcr: vi.fn(async () => queuedJob()),
      getOcrInstallJob
    })
    render(
      <ToastProvider>
        <DocumentsScreen />
      </ToastProvider>
    )

    await user.click(await screen.findByRole('button', { name: en['ocr.install.action'] }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: en['ocr.install.confirm.start'] }))

    expect(
      await screen.findAllByText(en['ocr.install.outcome.restartRequired'], {}, { timeout: hangBudgetMs(3000) })
    ).not.toHaveLength(0)
    // Both answers were delivered — the first (about j0) was read and dropped, polling went on to j1's end.
    expect(getOcrInstallJob.mock.calls).toEqual([['j1'], ['j1']])
    expect(screen.queryByText(en['ocr.install.outcome.activated'])).not.toBeInTheDocument()
  })

  it('10: a window focus re-reads app status and the offer appears without a remount', async () => {
    const getAppStatus = vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' }))
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus,
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy())
    })
    render(<DocumentsScreen />)

    await screen.findByText('scan.pdf')
    expect(screen.queryByRole('button', { name: en['docs.makeSearchable'] })).not.toBeInTheDocument()
    const callsBeforeFocus = getAppStatus.mock.calls.length

    getAppStatus.mockResolvedValue(appStatusFixture({ ocrAvailable: true, ocrState: 'available' }))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(await screen.findByRole('button', { name: en['docs.makeSearchable'] })).toBeInTheDocument()
    expect(getAppStatus.mock.calls.length).toBeGreaterThan(callsBeforeFocus)
  })

  it('11: with no failed scan/photo row on screen the OCR install status is never fetched', async () => {
    const getOcrInstallStatus = vi.fn(async () => ocrStatus())
    stubApi({
      listDocuments: vi.fn(async () => [doc({})]),
      getAppStatus: vi.fn(async () => appStatusFixture()),
      getOcrInstallStatus,
      // The screen's ordinary mount-time polls (unrelated to the OCR install lazy-load) —
      // supplied so `assertNoUnexpectedApiCalls` below checks ONLY for a stray OCR fetch.
      listCollections: vi.fn(async () => []),
      getReindexAllJob: vi.fn(async () => null),
      getActiveImportJob: vi.fn(async () => null)
    })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    expect(getOcrInstallStatus).not.toHaveBeenCalled()
    assertNoUnexpectedApiCalls()
  })
})

describe('OcrInstall — AI Model screen row (#410)', () => {
  function stubModels(opts: {
    status?: OcrInstallStatus
    policy?: PolicyStatus
    installOcr?: Mock
    getOcrInstallJob?: Mock
  } = {}) {
    const getOcrInstallStatus = vi.fn(async () => opts.status ?? ocrStatus())
    stubApi({
      listModels: vi.fn(async () => []),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      getPolicy: vi.fn(async () => opts.policy ?? allowedPolicy()),
      getAppStatus: vi.fn(async () => appStatusFixture()),
      listDownloadJobs: vi.fn(async () => []),
      dismissDownloadJob: vi.fn(async () => undefined),
      getOcrInstallStatus,
      installOcr: opts.installOcr,
      getOcrInstallJob: opts.getOcrInstallJob
    })
    return { getOcrInstallStatus }
  }

  it('12: a missing language shows the quiet row and opens the dialog', async () => {
    const user = userEvent.setup()
    stubModels()
    render(<ModelsScreen />)

    expect(await screen.findByText(en['models.ocr.row'])).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: en['ocr.install.action'] }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it.each([
    [
      'both languages installed',
      ocrStatus([
        { lang: 'deu', role: 'language', sizeBytes: DEU_SIZE, installed: true },
        { lang: 'eng', role: 'language', sizeBytes: ENG_SIZE, installed: true }
      ])
    ],
    // every pin still listed, as status() always lists them — only the source list is missing
    ['no usable source list on this drive', ocrStatus(undefined, { available: false, sourceHost: null })]
  ] as const)('13: no OCR row once the status has landed — %s', async (_label, status) => {
    const { getOcrInstallStatus } = stubModels({ status })
    render(<ModelsScreen />)

    await screen.findByRole('heading', { name: en['models.title'] })
    // The row is hidden while the status is still null, so wait for the status to land before the negative.
    await vi.waitFor(() => expect(getOcrInstallStatus).toHaveResolved())
    await act(async () => {})
    // Neither row text: with every language installed, a broken "missing" check would render rowOrientation.
    expect(screen.queryByText(en['models.ocr.row'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['models.ocr.rowOrientation'])).not.toBeInTheDocument()
  })

  it('13b (#538): with both languages installed and only the orientation file missing, the row says what it adds', async () => {
    const user = userEvent.setup()
    stubModels({
      status: ocrStatus([
        { lang: 'deu', role: 'language', sizeBytes: DEU_SIZE, installed: true },
        { lang: 'eng', role: 'language', sizeBytes: ENG_SIZE, installed: true },
        { lang: 'osd', role: 'orientation', sizeBytes: 4_320_130, installed: false }
      ])
    })
    render(<ModelsScreen />)

    expect(await screen.findByText(en['models.ocr.rowOrientation'])).toBeInTheDocument()
    expect(screen.queryByText(en['models.ocr.row'])).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: en['ocr.install.action'] }))
    expect(within(await screen.findByRole('dialog')).getByText(en['ocr.install.lang.osd'])).toBeInTheDocument()
  })

  it('16: a "restartRequired" outcome keeps the row visible with its outcome copy', async () => {
    const user = userEvent.setup()
    stubModels({
      installOcr: vi.fn(async () => queuedJob()),
      getOcrInstallJob: vi.fn(async () => queuedJob({ status: 'done', outcome: 'restartRequired' }))
    })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: en['ocr.install.action'] }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: en['ocr.install.confirm.start'] }))

    expect(
      await screen.findByText(en['ocr.install.outcome.restartRequired'], {}, { timeout: hangBudgetMs(3000) })
    ).toBeInTheDocument()
    expect(screen.getByText(en['models.ocr.row'])).toBeInTheDocument()
  })
})

// #687: the design record promises `onFinished` fires exactly once per job (architecture.md "In-app OCR install —
// design record" §3). Both callers re-read their status there and the Documents one toasts, so a second call is a
// duplicate toast. The race: a poll and the Cancel reply can both report the same job's end before React commits.
describe('useOcrInstall — onFinished fires once per job (#687)', () => {
  /** The hook bare (the screens' wiring is covered above): its job, Start and Cancel. */
  function InstallHarness({ onFinished }: { onFinished: (job: OcrInstallJob) => void }): JSX.Element {
    const install = useOcrInstall(true, onFinished)
    return (
      <div>
        <output>{install.job ? `${install.job.jobId}:${install.job.status}` : 'none'}</output>
        <button onClick={() => void install.start()}>start</button>
        <button onClick={() => void install.cancel()}>cancel</button>
      </div>
    )
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['poll', 'cancel'] as const)(
    'a poll and a Cancel reply that both report the end call onFinished once — the %s reply handled first',
    async (first) => {
      // Only the poll's interval is faked, so the test decides when a poll is in flight.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const poll = deferred<OcrInstallJob>()
      const cancelReply = deferred<OcrInstallJob>()
      const getOcrInstallJob = vi.fn(() => poll.promise)
      const cancelOcrInstall = vi.fn(() => cancelReply.promise)
      stubApi({
        getOcrInstallStatus: vi.fn(async () => ocrStatus()),
        getPolicy: vi.fn(async () => allowedPolicy()),
        installOcr: vi.fn(async () => queuedJob()),
        getOcrInstallJob,
        cancelOcrInstall
      })
      const onFinished = vi.fn()
      render(<InstallHarness onFinished={onFinished} />)

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'start' }))
      })
      expect(screen.getByRole('status')).toHaveTextContent('j1:queued')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(getOcrInstallJob).toHaveBeenCalledTimes(1) // a poll is in flight
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
      })
      expect(cancelOcrInstall).toHaveBeenCalledWith('j1')

      // Both replies land back to back, before React commits either.
      const end = queuedJob({ status: 'cancelled' })
      await act(async () => {
        const [a, b] = first === 'poll' ? [poll, cancelReply] : [cancelReply, poll]
        a.resolve(end)
        b.resolve(end)
        // The hook's handlers were attached first, so both have run once these settle.
        await Promise.all([poll.promise, cancelReply.promise])
      })
      expect(onFinished).toHaveBeenCalledTimes(1)
      expect(onFinished).toHaveBeenCalledWith(end)
      expect(screen.getByRole('status')).toHaveTextContent('j1:cancelled')
    }
  )
})

describe('OcrInstall — German (#410)', () => {
  it('17: DocumentsScreen and ModelsScreen render the German copy, and the dialog states German facts with a comma decimal', async () => {
    const user = userEvent.setup()
    stubApi({
      listDocuments: vi.fn(async () => [scanDoc()]),
      getAppStatus: vi.fn(async () => appStatusFixture({ ocrAvailable: false, ocrState: 'missing' })),
      getOcrInstallStatus: vi.fn(async () => ocrStatus()),
      getPolicy: vi.fn(async () => allowedPolicy())
    })
    render(german(<DocumentsScreen />))

    await screen.findByText('scan.pdf')
    expect(await screen.findByText(byText(de['docs.scan.ocrMissing']))).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: de['ocr.install.action'] }))
    const docsDialog = await screen.findByRole('dialog')
    expect(within(docsDialog).getByText(de['ocr.install.confirm.title'])).toBeInTheDocument()
    expect(
      within(docsDialog).getByText(`${de['ocr.install.lang.deu']}, ${de['ocr.install.lang.eng']}`)
    ).toBeInTheDocument()
    expect(within(docsDialog).getByText('4,1 MB')).toBeInTheDocument()

    cleanup()
    window.localStorage.clear()

    stubApi({
      listModels: vi.fn(async () => []),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      getPolicy: vi.fn(async () => allowedPolicy()),
      getAppStatus: vi.fn(async () => appStatusFixture()),
      listDownloadJobs: vi.fn(async () => []),
      dismissDownloadJob: vi.fn(async () => undefined),
      getOcrInstallStatus: vi.fn(async () => ocrStatus())
    })
    render(german(<ModelsScreen />))

    expect(await screen.findByText(de['models.ocr.row'])).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: de['ocr.install.action'] })).toBeInTheDocument()
  })
})
