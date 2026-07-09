// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type { RuntimeStatus } from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { stubApi } from '../helpers/renderer'

// Issue #36: the muted chat-header hint — which model is answering, and whether it runs
// on the GPU or the CPU — sourced from the same RuntimeStatus that feeds the Diagnostics
// "Acceleration" line. Subtle (a caption, no alarm): the backend difference is dramatic
// (~0.7 tok/s CPU-pinned vs. normal GPU speeds), and before this the only surface was
// Settings → Diagnostics, several clicks away from where the slowness is experienced.

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    running: true,
    modelId: 'qwen3.5-9b-q8',
    port: 1234,
    healthy: true,
    message: 'ok',
    ...over
  }
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('ChatScreen — runtime hint in the header (#36)', () => {
  it('shows model · GPU (name) when the runtime landed on the GPU', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ backend: 'gpu', gpuName: 'RTX 3090' }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    const hint = await screen.findByText('qwen3.5-9b-q8 · GPU (RTX 3090)')
    expect(hint).toHaveAttribute('title', t('en', 'chat.runtime.title'))
  })

  it('falls back to the generic GPU name when the probe reported none', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ backend: 'gpu', gpuName: null }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    expect(await screen.findByText('qwen3.5-9b-q8 · GPU (Graphics card)')).toBeInTheDocument()
  })

  it('shows model · CPU for a plain CPU session (no alarm, no compatibility hint)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ backend: 'cpu' }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    const hint = await screen.findByText('qwen3.5-9b-q8 · CPU')
    expect(hint).toHaveAttribute('title', t('en', 'chat.runtime.title'))
  })

  it('says "compatibility mode" (with the explanatory tooltip) when CPU comes from the auto-disable latch', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ backend: 'cpu', gpuAutoDisabled: true }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    const hint = await screen.findByText('qwen3.5-9b-q8 · CPU (compatibility mode)')
    expect(hint).toHaveAttribute('title', t('en', 'chat.runtime.compatTitle'))
  })

  it('labels the mock backend as demo mode', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ backend: 'mock' }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    expect(await screen.findByText('qwen3.5-9b-q8 · demo mode')).toBeInTheDocument()
  })

  it('refreshes on the runtime notice broadcast — the mid-generation GPU→CPU fallback flips the hint', async () => {
    // First read: GPU. After the crash-fallback notice fires, the re-read lands on CPU
    // with the latch set — the hint is the notice's persistent, low-key home.
    let noticeCb: ((message: string) => void) | null = null
    const getRuntimeStatus = vi
      .fn(async () => status({ backend: 'cpu', gpuAutoDisabled: true }))
      .mockResolvedValueOnce(status({ backend: 'gpu', gpuName: 'RTX 3090' }))
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus,
      onRuntimeNotice: vi.fn((cb: (message: string) => void) => {
        noticeCb = cb
        return () => {}
      })
    })
    render(<ChatScreen onNavigate={() => {}} />)
    expect(await screen.findByText('qwen3.5-9b-q8 · GPU (RTX 3090)')).toBeInTheDocument()

    // Teeth: without the ChatScreen notice subscription the label would stay "GPU".
    expect(noticeCb).not.toBeNull()
    act(() => noticeCb!(t('en', 'main.runtime.compatibilityMode')))
    await waitFor(() =>
      expect(screen.getByText('qwen3.5-9b-q8 · CPU (compatibility mode)')).toBeInTheDocument()
    )
  })

  it('renders no hint while no runtime is running (the no-model empty state owns the screen)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ running: false, modelId: null }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    expect(await screen.findByText(t('en', 'chat.noModel.title'))).toBeInTheDocument()
    expect(document.querySelector('.chat-runtime-hint')).toBeNull()
  })

  it('renders the German compatibility label from the catalog (D-L8)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ backend: 'cpu', gpuAutoDisabled: true }))
    })
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    render(
      <I18nProvider>
        <ChatScreen onNavigate={() => {}} />
      </I18nProvider>
    )
    expect(
      await screen.findByText(
        t('de', 'chat.runtime.cpuCompat', { model: 'qwen3.5-9b-q8' })
      )
    ).toBeInTheDocument()
  })
})
