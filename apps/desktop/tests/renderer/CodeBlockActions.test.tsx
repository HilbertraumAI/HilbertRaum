// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { t } from '../../src/shared/i18n'
import { assistantMsg, makeConversation } from '../helpers/chat-fixtures'
import { chatScreenStubs, conversationRow, renderChatScreen } from '../helpers/chat-screen'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { renderTranscript } from '../helpers/transcript'

// #286 renderer half — the per-code-block Copy/Save toolbar on PERSISTED assistant turns.
//
// The invariants worth pinning:
//  • D3 scope: transcript, persisted turns only. Never the live streaming bubble; never any other
//    AssistantMarkdown consumer (images AnswerThread, ReviewScreen, TranslateScreen, documents
//    PreviewModal) — those render with no CodeBlockActions context and must be unchanged (pinned in
//    assistant-markdown.test.tsx 'a fenced code block ships NO Streamdown download control
//    (controls={false} stays off)').
//  • D1 verbatim: what reaches Save/Copy is the code value AS PARSED — mdast-util-to-hast appends
//    one '\n' to every code node, and shipping that would add a byte the markdown never had.
//  • Distinct accessible names per block (the ext comes from the shared allowlist), so a keyboard
//    user picking from a list of "Save" buttons can tell the html one from the python one.

afterEach(cleanup)

const HTML_BLOCK = '<b>hi</b>'
const PY_BLOCK = 'print("hi")'
const TWO_BLOCKS = `Here you go:\n\n\`\`\`html\n${HTML_BLOCK}\n\`\`\`\n\nand in python:\n\n\`\`\`python\n${PY_BLOCK}\n\`\`\`\n`

// vitest.config.ts resolves ./AssistantMarkdownLazy to the synchronous component, so the
// markdown renders in the first pass; the findBy* / waitFor below are positive gates.
const SAVE_HTML = 'Save this code block as a .html file (stays local)'
const SAVE_PY = 'Save this code block as a .py file (stays local)'
const COPY_TITLE = 'Copy this code block to the clipboard'

describe('#286 per-code-block toolbar in the transcript', () => {
  it('renders a Copy + Save pair per block, with DISTINCT per-language Save names', async () => {
    renderTranscript({ messages: [assistantMsg('a1', TWO_BLOCKS)], onSaveCodeBlock: vi.fn() })
    const copies = await screen.findAllByRole('button', { name: COPY_TITLE })
    expect(copies).toHaveLength(2)
    // Two Save buttons, and the accessible names differ by the ALLOWLIST extension.
    expect(await screen.findByRole('button', { name: SAVE_HTML })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: SAVE_PY })).toBeInTheDocument()
    // Visible labels stay short (sentence case); the long form is the accessible name/tooltip.
    expect(screen.getAllByRole('button', { name: SAVE_HTML })[0]).toHaveTextContent('Save')
    expect(copies[0]).toHaveTextContent('Copy')
  })

  it('saves the block VERBATIM — the code value with no trailing newline — plus its language', async () => {
    const onSaveCodeBlock = vi.fn()
    renderTranscript({ messages: [assistantMsg('answer-7', TWO_BLOCKS)], onSaveCodeBlock })
    fireEvent.click(await screen.findByRole('button', { name: SAVE_HTML }))
    expect(onSaveCodeBlock).toHaveBeenCalledTimes(1)
    expect(onSaveCodeBlock).toHaveBeenCalledWith('answer-7', HTML_BLOCK, 'html')
    fireEvent.click(await screen.findByRole('button', { name: SAVE_PY }))
    expect(onSaveCodeBlock).toHaveBeenLastCalledWith('answer-7', PY_BLOCK, 'python')
  })

  it('copies the same verbatim content through the transcript copy path', async () => {
    const onCopy = vi.fn()
    renderTranscript({ messages: [assistantMsg('a1', TWO_BLOCKS)], onCopy, onSaveCodeBlock: vi.fn() })
    const copies = await screen.findAllByRole('button', { name: COPY_TITLE })
    fireEvent.click(copies[0])
    expect(onCopy).toHaveBeenCalledWith(HTML_BLOCK)
  })

  it('renders NO toolbar on the live streaming bubble (D3 — persisted turns only)', async () => {
    renderTranscript({ streamingHere: true, streamText: TWO_BLOCKS, onSaveCodeBlock: vi.fn() })
    // Positive gate: the block painted, so the absences below are about the toolbar, not a missing render.
    await waitFor(() => expect(document.querySelector('code')).not.toBeNull())
    expect(screen.queryByRole('button', { name: SAVE_HTML })).toBeNull()
    expect(screen.queryByRole('button', { name: COPY_TITLE })).toBeNull()
    expect(document.querySelector('.code-block-actions')).toBeNull()
  })

  it('renders no toolbar for INLINE code', async () => {
    renderTranscript({ messages: [assistantMsg('a1', 'some `inline` text')], onSaveCodeBlock: vi.fn() })
    await waitFor(() => expect(document.querySelector('code')).not.toBeNull())
    expect(document.querySelector('.code-block-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: COPY_TITLE })).toBeNull()
  })

  it('renders no toolbar when the onSaveCodeBlock prop is absent', async () => {
    renderTranscript({ messages: [assistantMsg('a1', TWO_BLOCKS)] })
    await waitFor(() => expect(document.querySelector('code')).not.toBeNull())
    expect(document.querySelector('.code-block-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: COPY_TITLE })).toBeNull()
    expect(screen.queryByRole('button', { name: SAVE_HTML })).toBeNull()
  })
})

// The ChatScreen hop: its `onSaveCodeBlock` is the ONLY write path (Streamdown's own blob download
// control stays disabled) — it forwards to window.api.saveCodeBlock and toasts where the file went.
describe('#286 ChatScreen → the save bridge', () => {
  // Runs before the file-level cleanup (after-hooks run innermost first).
  afterEach(() => assertNoUnexpectedApiCalls())

  it('a code block Save from a persisted answer reaches window.api.saveCodeBlock and toasts where the file went', async () => {
    const saveCodeBlock = vi.fn(
      async (_id: string, _content: string, _language: string): Promise<string | null> => 'C:/x/code.html'
    )
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation()]),
        listMessages: vi.fn(async () => [assistantMsg('answer-9', TWO_BLOCKS)]),
        saveCodeBlock
      })
    )
    renderChatScreen()
    fireEvent.click(await waitFor(() => conversationRow('My chat')))
    fireEvent.click(await screen.findByRole('button', { name: SAVE_HTML }))
    await waitFor(() => expect(saveCodeBlock).toHaveBeenCalledWith('answer-9', HTML_BLOCK, 'html'))
    expect(await screen.findByText(t('en', 'chat.savedTo', { path: 'C:/x/code.html' }))).toBeInTheDocument()
  })
})
