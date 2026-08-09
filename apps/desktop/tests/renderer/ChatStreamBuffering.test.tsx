// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen, STREAM_FLUSH_MS } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Coverage adds (frontend audit 2026-08-09, #147): the SCREEN-level stream path. The chat
// components had oracle-equivalence sweeps, but ChatScreen itself only ever saw 1–2 tokens
// per test — a STREAM_FLUSH_MS buffering / transcript-accumulation regression (dropped or
// re-ordered chunks across flush windows) reddened nothing. And no test drove a mid-stream
// ERROR after tokens had rendered, so the partial-bubble disposition was unpinned.

const runningStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function chatConv(id: string, title: string): Conversation {
  return {
    id,
    title,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    collectionId: null,
    scope: null
  }
}

function userMsg(id: string, convId: string, content: string): Message {
  return { id, conversationId: convId, role: 'user', content, createdAt: '2026-01-01T00:01:00Z' }
}

const unsub = (): (() => void) => () => {}

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

/** Stub the send surface; capture the token callback and park the send so the stream stays live. */
function streamHarness(): {
  tokenCb: () => ((t: string) => void) | undefined
  finishSend: (outcome?: 'resolve' | 'reject') => void
} {
  let cb: ((t: string) => void) | undefined
  let resolveSend: (m: Message) => void = () => {}
  let rejectSend: (e: Error) => void = () => {}
  stubApi({
    listConversations: vi.fn(async () => [chatConv('c1', 'Chat 1')]),
    getRuntimeStatus: vi.fn(async () => runningStatus),
    listMessages: vi.fn(async () => [userMsg('u1', 'c1', 'question')]),
    listDocuments: vi.fn(async () => []),
    listCollections: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    listActiveStreamConversations: vi.fn(async () => []),
    getActiveStream: vi.fn(async () => null),
    sendChatMessage: vi.fn(
      () =>
        new Promise<Message>((resolve, reject) => {
          resolveSend = resolve
          rejectSend = reject
        })
    ),
    onToken: vi.fn((_id: string, callback: (t: string) => void) => {
      cb = callback
      return () => {}
    }),
    onReasoning: vi.fn(unsub),
    onScopeNotice: vi.fn(unsub),
    onCompaction: vi.fn(unsub)
  })
  return {
    tokenCb: () => cb,
    finishSend: (outcome = 'resolve') => {
      if (outcome === 'reject') rejectSend(new Error('runtime crashed mid-stream'))
      else resolveSend(userMsg('a9', 'c1', 'done'))
    }
  }
}

describe('ChatScreen — many-token stream buffering (#147 coverage add)', () => {
  it('accumulates a 60-token burst across flush windows with nothing dropped or reordered', async () => {
    const h = streamHarness()
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await user.click(await screen.findByText('Chat 1'))
    await user.type(screen.getByRole('textbox'), 'go')
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(h.tokenCb()).toBeDefined())

    // 60 numbered tokens, pushed in 3 bursts with a real flush window between them — the
    // buffered flush must preserve every chunk in order.
    const tokens = Array.from({ length: 60 }, (_, i) => `t${i} `)
    for (let burst = 0; burst < 3; burst++) {
      await act(async () => {
        for (let i = burst * 20; i < burst * 20 + 20; i++) h.tokenCb()?.(tokens[i])
        await new Promise((r) => setTimeout(r, STREAM_FLUSH_MS + 10))
      })
    }
    const expected = tokens.join('').trim()
    await waitFor(() => {
      const bubble = document.querySelector('.chat-transcript')
      expect(bubble?.textContent ?? '').toContain(expected)
    })
  })

  it('a mid-stream error after rendered tokens surfaces the banner and keeps the persisted partial', async () => {
    const h = streamHarness()
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await user.click(await screen.findByText('Chat 1'))
    await user.type(screen.getByRole('textbox'), 'go')
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(h.tokenCb()).toBeDefined())

    await act(async () => {
      h.tokenCb()?.('partial ')
      h.tokenCb()?.('answer')
      await new Promise((r) => setTimeout(r, STREAM_FLUSH_MS + 10))
    })
    await screen.findByText(/partial answer/)

    // The send rejects AFTER tokens rendered (a mid-stream runtime crash): the live bubble is
    // dropped in favor of the persisted truth (refreshIfVisible), the error surfaces on the
    // banner, and the composer unlocks for a retry.
    await act(async () => {
      h.finishSend('reject')
    })
    expect(await screen.findByRole('button', { name: /^send$/i })).toBeInTheDocument()
    // The friendly error is visible (never the raw stack) inside the always-mounted region.
    await waitFor(() => {
      const region = document.querySelector('.error-banner-region')
      expect(region?.textContent ?? '').not.toBe('')
    })
  })
})
