// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ChatScreen, WARMUP_HINT_DELAY_MS } from '../../src/renderer/screens/ChatScreen'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { stubApi } from '../helpers/renderer'

// Issue #39: the calm one-time "the first answer takes a little longer — the model is
// warming up" line under the pending answer. Honesty gates, all of which must hold:
//  - only AFTER the turn has streamed nothing for WARMUP_HINT_DELAY_MS (no flash on GPU);
//  - only when the runtime says it really is the first generation since the model started
//    (RuntimeStatus.warmedUp === false — a warmed session never sees it);
//  - dropped the instant ANYTHING streams (answer token OR Deep-mode reasoning delta);
//  - absent `warmedUp` (older/bare runtime shape) fails safe: no hint, ever.

const HINT = t('en', 'chat.warmup.hint')

function conv(): Conversation {
  return {
    id: 'c1',
    title: 'Warmup chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    collectionId: null,
    scope: null
  }
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: true, modelId: 'm1', port: 1234, healthy: true, message: 'ok', ...over }
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
  vi.useRealTimers()
  window.localStorage.clear()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
  })
}

/** Render the screen and park a send so the stream stays in flight with no tokens yet. */
function setup(statusOver: Partial<RuntimeStatus> = {}): {
  tokenCb: () => (tok: string) => void
  reasoningCb: () => (delta: string) => void
} {
  let tokenCb: ((tok: string) => void) | undefined
  let reasoningCb: ((delta: string) => void) | undefined
  stubApi({
    listConversations: vi.fn(async () => [conv()]),
    listMessages: vi.fn(async () => []),
    listActiveStreamConversations: vi.fn(async () => []),
    getActiveStream: vi.fn(async () => null),
    getRuntimeStatus: vi.fn(async () => status(statusOver)),
    // Parks forever — the turn stays pending, exactly the silent-prefill window under test.
    sendChatMessage: vi.fn(() => new Promise<Message>(() => {})),
    onToken: vi.fn((_id: string, cb: (tok: string) => void) => {
      tokenCb = cb
      return () => {}
    }),
    onReasoning: vi.fn((_id: string, cb: (delta: string) => void) => {
      reasoningCb = cb
      return () => {}
    }),
    onScopeNotice: vi.fn(() => () => {})
  })
  render(<ChatScreen onNavigate={() => {}} />)
  return { tokenCb: () => tokenCb!, reasoningCb: () => reasoningCb! }
}

async function sendParkedTurn(): Promise<void> {
  await flush()
  fireEvent.click(screen.getByText('Warmup chat'))
  await flush()
  fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'hi' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await flush()
}

describe('ChatScreen — first-answer warm-up hint (#39)', () => {
  it('shows the hint only after the delay on a cold runtime, and the first token retires it', async () => {
    vi.useFakeTimers()
    const h = setup({ warmedUp: false })
    await sendParkedTurn()

    // Before the delay: streaming, but no hint yet — a fast first turn must never flash it.
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS)
    })
    await flush()
    const hint = screen.getByText(HINT)
    // A quiet status line inside the live bubble — announced once, never an alert.
    expect(hint).toHaveAttribute('role', 'status')
    expect(hint.className).toContain('chat-warmup-hint')

    // The first answer token drops it for good — tokens flowing IS the "warm-up over" signal.
    act(() => h.tokenCb()('Hello'))
    await flush()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  it('never shows on a warmed runtime (warmedUp: true), however long the wait', async () => {
    vi.useFakeTimers()
    setup({ warmedUp: true })
    await sendParkedTurn()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS * 3)
    })
    await flush()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  it('never shows when the runtime cannot report warm-up state (warmedUp absent)', async () => {
    vi.useFakeTimers()
    setup({}) // no warmedUp field — the older/bare-runtime status shape
    await sendParkedTurn()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS * 3)
    })
    await flush()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  it('a token that arrives before the delay suppresses the hint entirely (no flash)', async () => {
    vi.useFakeTimers()
    const h = setup({ warmedUp: false })
    await sendParkedTurn()

    act(() => h.tokenCb()('fast'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS * 2)
    })
    await flush()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  it('a Deep-mode reasoning delta counts as streaming too — it suppresses and retires the hint', async () => {
    vi.useFakeTimers()
    const h = setup({ warmedUp: false })
    await sendParkedTurn()

    // Hint shows first (cold + silent past the delay)…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS)
    })
    await flush()
    expect(screen.getByText(HINT)).toBeInTheDocument()

    // …then the first reasoning delta (which precedes any answer token in Deep mode) drops it:
    // the model is visibly thinking, so "warming up" would be false.
    act(() => h.reasoningCb()('pondering…'))
    await flush()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })
})
