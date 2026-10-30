// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { t } from '../../src/shared/i18n'
import type { PreloadApi } from '../../src/preload'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { runtimeStatus } from '../helpers/status'
import { assistantMsg, makeConversation, makeDocumentInfo, userMsg } from '../helpers/chat-fixtures'
import { chatScreenStubs, renderChatScreen } from '../helpers/chat-screen'

// Phase 25 (guidelines §3) structural tests: the teaching empty state, the header
// mode segmented control, conversation-list collapse persistence (localStorage),
// per-message hover actions (Try again / Copy / Save → toasts), the header "⋯"
// overflow ("Save this conversation"), and the no-model empty state.

// The persisted key itself, not the export: a rename would silently reset every user's choice.
const LIST_COLLAPSED_KEY = 'hilbertraum.chat.listCollapsed'

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
    window.localStorage.clear()
  }
})

describe('ChatScreen — teaching empty state (guidelines §3)', () => {
  it('shows example prompt chips that fill the composer', async () => {
    const user = userEvent.setup()
    stubApi(chatScreenStubs({ listDocuments: vi.fn(async () => [makeDocumentInfo({ title: 'contract.pdf' })]) }))
    renderChatScreen()

    expect(
      await screen.findByText('Ask a question, or ask about your documents.')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Explain a concept in simple terms' }))
    expect(screen.getByPlaceholderText("Message…")).toHaveValue(
      'Explain a concept in simple terms'
    )
  })

  it('nudges toward Documents when nothing is imported yet', async () => {
    const user = userEvent.setup()
    stubApi(chatScreenStubs())
    const { onNavigate } = renderChatScreen()

    await user.click(
      await screen.findByRole('button', { name: /add documents to ask about them/i })
    )
    expect(onNavigate).toHaveBeenCalledWith('documents')
  })

  it('hides the nudge once indexed documents exist', async () => {
    stubApi(chatScreenStubs({ listDocuments: vi.fn(async () => [makeDocumentInfo({ title: 'contract.pdf' })]) }))
    renderChatScreen()
    await screen.findByText('Ask a question, or ask about your documents.')
    expect(
      screen.queryByRole('button', { name: /add documents to ask about them/i })
    ).not.toBeInTheDocument()
  })
})

describe('ChatScreen — header mode segmented control', () => {
  it('is a radiogroup and switches the composer mode', async () => {
    const user = userEvent.setup()
    stubApi(chatScreenStubs())
    renderChatScreen()

    const group = await screen.findByRole('radiogroup', { name: 'Chat mode' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Chat' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Ask my documents' }))
    expect(screen.getByPlaceholderText(/ask about your documents/i)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Ask my documents' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Chat' }))
    expect(screen.getByPlaceholderText("Message…")).toBeInTheDocument()
  })
})

describe('ChatScreen — conversation-list collapse persistence', () => {
  it('collapses, remembers the choice in localStorage, and restores on remount', async () => {
    const user = userEvent.setup()
    stubApi(chatScreenStubs({ listConversations: vi.fn(async () => [makeConversation({ title: 'My first chat' })]) }))
    const { unmount } = renderChatScreen()

    await screen.findByText('My first chat')
    await user.click(screen.getByRole('button', { name: 'Hide conversation list' }))
    expect(screen.queryByText('My first chat')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(LIST_COLLAPSED_KEY)).toBe('1')
    unmount()

    // A fresh mount starts collapsed; expanding persists the new preference.
    stubApi(chatScreenStubs({ listConversations: vi.fn(async () => [makeConversation({ title: 'My first chat' })]) }))
    renderChatScreen()
    expect(await screen.findByRole('button', { name: 'Show conversation list' })).toBeInTheDocument()
    expect(screen.queryByText('My first chat')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show conversation list' }))
    expect(await screen.findByText('My first chat')).toBeInTheDocument()
    expect(window.localStorage.getItem(LIST_COLLAPSED_KEY)).toBe('0')
  })
})

describe('ChatScreen — per-message actions (Try again · Copy · Save)', () => {
  function renderWithMessages(overrides: Partial<PreloadApi> = {}) {
    const sendChatMessage = vi.fn(async () => assistantMsg('a3', 'regenerated'))
    const exportConversation = vi.fn(async () => 'D:\\out\\chat.md')
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'My first chat' })]),
        listMessages: vi.fn(async () => [
          userMsg('u1', 'question'),
          assistantMsg('a1', 'first answer'),
          userMsg('u2', 'follow-up'),
          assistantMsg('a2', 'second answer')
        ]),
        sendChatMessage,
        exportConversation,
        ...overrides
      })
    )
    renderChatScreen()
    return { sendChatMessage, exportConversation }
  }

  // The Copy action goes through Electron's native clipboard bridge (window.api.copyToClipboard),
  // not navigator.clipboard. CH-5 (#148): a refused write gives feedback instead of silence.
  it.each([
    ['copies an answer and confirms with a toast', true, 'chat.copied', 'chat.copyFailed'],
    ['a refused clipboard write toasts the failure instead of staying silent (CH-5, #148)', false, 'chat.copyFailed', 'chat.copied']
  ] as const)('%s', async (_title, ok, shown, absent) => {
    const user = userEvent.setup()
    const copyToClipboard = vi.fn(async (_text: string) => ok)
    renderWithMessages({ copyToClipboard })
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('second answer')

    await user.click(screen.getAllByRole('button', { name: 'Copy' })[0])
    expect(copyToClipboard).toHaveBeenCalledWith('first answer')
    expect(await screen.findByText(t('en', shown))).toBeInTheDocument()
    expect(screen.queryByText(t('en', absent))).not.toBeInTheDocument()
  })

  it('offers Try again only on the last assistant answer and regenerates', async () => {
    const user = userEvent.setup()
    const { sendChatMessage } = renderWithMessages()
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('second answer')

    const tryAgain = screen.getAllByRole('button', { name: /try again/i })
    expect(tryAgain).toHaveLength(1)
    await user.click(tryAgain[0])
    // A regenerate sends the resolved skill choice VERBATIM (S13c): no skill here ⇒ an explicit
    // `skillInstallId: null` clear, so the re-run is pinned skill-free and never re-auto-fires.
    await waitFor(() =>
      expect(sendChatMessage).toHaveBeenCalledWith('c1', '', {
        mode: 'balanced',
        skillInstallId: null,
        regenerate: true
      })
    )
  })

  it('saves the conversation from a message row and confirms with a toast', async () => {
    const user = userEvent.setup()
    const { exportConversation } = renderWithMessages()
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('second answer')

    await user.click(screen.getAllByRole('button', { name: 'Save' })[0])
    await waitFor(() => expect(exportConversation).toHaveBeenCalledWith('c1'))
    expect(await screen.findByText(/saved to/i)).toBeInTheDocument()
  })

  it('saves via the header "⋯" overflow menu (Save this conversation)', async () => {
    const user = userEvent.setup()
    const { exportConversation } = renderWithMessages()
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('second answer')

    await user.click(screen.getByRole('button', { name: 'Conversation options' }))
    await user.click(await screen.findByRole('menuitem', { name: /save this conversation/i }))
    await waitFor(() => expect(exportConversation).toHaveBeenCalledWith('c1'))
    expect(await screen.findByText(/saved to/i)).toBeInTheDocument()
  })
})

describe('ChatScreen — no-model empty state (M-U3)', () => {
  it('renders the no-model empty state: its heading, and "Go to AI Model" opens AI Model (#527)', async () => {
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'My first chat' })]),
        getRuntimeStatus: vi.fn(async () =>
          runtimeStatus({ running: false, modelId: null, port: null, healthy: false, message: 'no model' })
        )
      })
    )
    const { onNavigate } = renderChatScreen()

    // The shared EmptyState renders the title as a heading.
    expect(await screen.findByRole('heading', { name: t('en', 'chat.noModel.title') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('en', 'chat.noModel.recheck') })).toBeInTheDocument()
    // #527: "Open AI Model" read as "OpenAI model" — the button names where it goes, and goes there.
    await userEvent.click(screen.getByRole('button', { name: t('en', 'chat.noModel.open') }))
    expect(onNavigate).toHaveBeenCalledWith('models')
  })
})

// The ambient privacy indicator was moved out of the chat header to a single app-wide
// rail-foot instance (§12.1 #2); the chat-header indicator + its `offline` prop are gone.
// Coverage now lives in InformationArchitecture.test.tsx (the single rail-foot indicator)
// and LocalIndicator.test.tsx (the short label + honest states).
