// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TranslateScreen } from '../../src/renderer/screens/TranslateScreen'
import { resetTranslateSessionForTests } from '../../src/renderer/lib/translateSession'
import { t } from '../../src/shared/i18n'
import type { AppStatus, TranslateJob } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Renderer test (jsdom + RTL) for the Translate screen state machine (TranslateGemma plan §2 D6,
// TG-4). Streaming is driven by capturing the onTranslate* subscriber callbacks and invoking them,
// mirroring the ImagesScreen / Chat lifecycle. The active translation lives in a module-level store
// (survives navigation), so it is reset between tests.

afterEach(() => {
  cleanup()
  resetTranslateSessionForTests()
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
