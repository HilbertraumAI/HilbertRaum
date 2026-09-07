// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { AssistantMarkdown } from '../../src/renderer/chat/AssistantMarkdown'
import { I18nProvider } from '../../src/renderer/i18n'
import { stubApi } from '../helpers/renderer'
import type { Message } from '../../src/shared/types'

// #286 renderer half — the per-code-block Copy/Save toolbar on PERSISTED assistant turns.
//
// The invariants worth pinning:
//  • D3 scope: transcript, persisted turns only. Never the live streaming bubble; never any other
//    AssistantMarkdown consumer (images AnswerThread, ReviewScreen, TranslateScreen, documents
//    PreviewModal) — those render with no CodeBlockActions context and must be unchanged.
//  • D1 verbatim: what reaches Save/Copy is the code value AS PARSED — mdast-util-to-hast appends
//    one '\n' to every code node, and shipping that would add a byte the markdown never had.
//  • Distinct accessible names per block (the ext comes from the shared allowlist), so a keyboard
//    user picking from a list of "Save" buttons can tell the html one from the python one.

afterEach(cleanup)

// jsdom does not implement Element.scrollTo (Transcript scrolls to newest content).
beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

function noop(): void {}

const HTML_BLOCK = '<b>hi</b>'
const PY_BLOCK = 'print("hi")'
const TWO_BLOCKS = `Here you go:\n\n\`\`\`html\n${HTML_BLOCK}\n\`\`\`\n\nand in python:\n\n\`\`\`python\n${PY_BLOCK}\n\`\`\`\n`

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'a1',
    conversationId: 'c1',
    role: 'assistant',
    content: TWO_BLOCKS,
    createdAt: '2026-09-06T10:00:00.000Z',
    ...over
  }
}

function renderTranscript(props: {
  messages?: Message[]
  streamingHere?: boolean
  streamText?: string
  onCopy?: (content: string) => void
  onSaveCodeBlock?: (messageId: string, content: string, language: string) => void
}): void {
  render(
    <I18nProvider>
      <Transcript
        messages={props.messages ?? [msg()]}
        streamingHere={props.streamingHere ?? false}
        streamText={props.streamText ?? ''}
        streamThinking=""
        thinkingOpen={false}
        onThinkingOpenChange={noop}
        emptyState={null}
        onCopy={props.onCopy ?? noop}
        onSave={noop}
        onSaveCodeBlock={props.onSaveCodeBlock}
        actionsDisabled={false}
      />
    </I18nProvider>
  )
}

// Transcript renders AssistantMarkdown through the LAZY (Suspense) wrapper — every assertion
// about markdown output has to wait for that chunk to resolve.
const SAVE_HTML = 'Save this code block as a .html file (stays local)'
const SAVE_PY = 'Save this code block as a .py file (stays local)'
const COPY_TITLE = 'Copy this code block to the clipboard'

describe('#286 per-code-block toolbar in the transcript', () => {
  it('renders a Copy + Save pair per block, with DISTINCT per-language Save names', async () => {
    renderTranscript({ onSaveCodeBlock: vi.fn() })
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
    renderTranscript({ messages: [msg({ id: 'answer-7' })], onSaveCodeBlock })
    fireEvent.click(await screen.findByRole('button', { name: SAVE_HTML }))
    expect(onSaveCodeBlock).toHaveBeenCalledTimes(1)
    expect(onSaveCodeBlock).toHaveBeenCalledWith('answer-7', HTML_BLOCK, 'html')
    fireEvent.click(await screen.findByRole('button', { name: SAVE_PY }))
    expect(onSaveCodeBlock).toHaveBeenLastCalledWith('answer-7', PY_BLOCK, 'python')
  })

  it('copies the same verbatim content through the transcript copy path', async () => {
    const onCopy = vi.fn()
    renderTranscript({ onCopy, onSaveCodeBlock: vi.fn() })
    const copies = await screen.findAllByRole('button', { name: COPY_TITLE })
    fireEvent.click(copies[0])
    expect(onCopy).toHaveBeenCalledWith(HTML_BLOCK)
  })

  it('reaches window.api.saveCodeBlock end-to-end when the handler forwards to the bridge', async () => {
    // The ChatScreen wiring in miniature: the Transcript prop forwards to the preload bridge,
    // which is the ONLY write path (Streamdown's own blob download control stays disabled).
    const saveCodeBlock = vi.fn().mockResolvedValue('C:/x/code.html')
    stubApi({ saveCodeBlock })
    renderTranscript({
      messages: [msg({ id: 'answer-9' })],
      onSaveCodeBlock: (id, content, language) => void window.api.saveCodeBlock(id, content, language)
    })
    fireEvent.click(await screen.findByRole('button', { name: SAVE_HTML }))
    await waitFor(() => expect(saveCodeBlock).toHaveBeenCalledWith('answer-9', HTML_BLOCK, 'html'))
  })

  it('renders NO toolbar on the live streaming bubble (D3 — persisted turns only)', async () => {
    renderTranscript({
      messages: [],
      streamingHere: true,
      streamText: TWO_BLOCKS,
      onSaveCodeBlock: vi.fn()
    })
    // Wait for the lazy markdown chunk to actually paint the block before asserting absence.
    await waitFor(() => expect(document.querySelector('code')).not.toBeNull())
    expect(screen.queryByRole('button', { name: SAVE_HTML })).toBeNull()
    expect(screen.queryByRole('button', { name: COPY_TITLE })).toBeNull()
    expect(document.querySelector('.code-block-actions')).toBeNull()
  })

  it('renders no toolbar for INLINE code', async () => {
    renderTranscript({
      messages: [msg({ content: 'some `inline` text' })],
      onSaveCodeBlock: vi.fn()
    })
    await waitFor(() => expect(document.querySelector('code')).not.toBeNull())
    expect(document.querySelector('.code-block-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: COPY_TITLE })).toBeNull()
  })

  it('renders no toolbar when the onSaveCodeBlock prop is absent', async () => {
    renderTranscript({})
    await waitFor(() => expect(document.querySelector('code')).not.toBeNull())
    expect(document.querySelector('.code-block-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: COPY_TITLE })).toBeNull()
    expect(screen.queryByRole('button', { name: SAVE_HTML })).toBeNull()
  })
})

describe('#286 AssistantMarkdown outside the transcript', () => {
  it('renders a fenced block with NO buttons and still a <code> element', () => {
    // The other consumers (images AnswerThread, ReviewScreen, TranslateScreen, documents
    // PreviewModal) render AssistantMarkdown with neither the actions context NOR an
    // I18nProvider — the `pre` override must stay a hook-free passthrough there.
    const { container } = render(<AssistantMarkdown text={'```js\nx\n```'} />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('.code-block-actions')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('x')
  })
})
