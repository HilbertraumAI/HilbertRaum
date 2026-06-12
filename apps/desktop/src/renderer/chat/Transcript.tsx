import { useEffect, useRef, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@shared/types'
import { MessageActions } from './MessageActions'
import { SourcesDisclosure } from './SourcesDisclosure'
import { useT } from '../i18n'

// Transcript (guidelines §3): the conversation IS the canvas — centered,
// max-width 720px, --text-md body (CSS). Assistant answers carry an inline
// "▸ Sources (N)" disclosure and a hover/focus action row; the live streaming bubble
// shows the collapsed "Thinking…" line (never persisted) and announces
// streamed text over a polite ARIA live region.

interface TranscriptProps {
  messages: Message[]
  /** True when the in-flight stream belongs to THIS conversation. */
  streamingHere: boolean
  streamText: string
  /** Live Deep-mode reasoning; '' hides the Thinking… line. */
  streamThinking: string
  /** Controlled expand state of the Thinking… line (auto-collapses on first token). */
  thinkingOpen: boolean
  onThinkingOpenChange: (open: boolean) => void
  /** Rendered when there is nothing to show (the teaching empty state). */
  emptyState: ReactNode
  /** Provided only for the message that can regenerate (last assistant turn, chat mode). */
  onTryAgain?: () => void
  onCopy: (content: string) => void
  onSave: () => void
  actionsDisabled: boolean
}

export function Transcript({
  messages,
  streamingHere,
  streamText,
  streamThinking,
  thinkingOpen,
  onThinkingOpenChange,
  emptyState,
  onTryAgain,
  onCopy,
  onSave,
  actionsDisabled
}: TranscriptProps): JSX.Element {
  const { t } = useT()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Localized role chip; unknown roles (defensive) render as-is.
  function roleLabel(role: string): string {
    return role === 'user' ? t('chat.role.user') : role === 'assistant' ? t('chat.role.assistant') : role
  }

  // Keep the transcript scrolled to the newest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streamText, streamThinking])

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id

  return (
    <div className="chat-transcript" ref={scrollRef}>
      <div className="chat-transcript-inner">
        {messages.length === 0 && !streamingHere && emptyState}
        {messages.map((m) => (
          <div key={m.id} className={`msg-block ${m.role}`}>
            <div className={`msg ${m.role}`}>
              <div className="msg-role">{roleLabel(m.role)}</div>
              {m.role === 'assistant' ? (
                <div className="msg-content md">
                  <AssistantMarkdown text={m.content} />
                </div>
              ) : (
                <div className="msg-content">{m.content}</div>
              )}
              {m.citations && m.citations.length > 0 && <SourcesDisclosure citations={m.citations} />}
            </div>
            {m.role === 'assistant' && (
              <MessageActions
                onTryAgain={m.id === lastAssistantId ? onTryAgain : undefined}
                onCopy={() => onCopy(m.content)}
                onSave={onSave}
                disabled={actionsDisabled}
              />
            )}
          </div>
        ))}
        {streamingHere && (
          <div className="msg-block assistant">
            <div className="msg assistant">
              <div className="msg-role">{t('chat.role.assistant')}</div>
              {/* Deep mode: live reasoning, collapsed by default, auto-collapsed
                  again when the first answer token lands. Display-only — never persisted,
                  so it disappears once the final reply is re-read from history. */}
              {streamThinking !== '' && (
                <details className="msg-thinking" open={thinkingOpen}>
                  {/* Controlled explicitly (not the native toggle) so auto-collapse on
                      the first answer token can't fight the browser's own state. */}
                  <summary
                    onClick={(e) => {
                      e.preventDefault()
                      onThinkingOpenChange(!thinkingOpen)
                    }}
                  >
                    {t('chat.thinking')}
                  </summary>
                  <div className="msg-thinking-text">{streamThinking}</div>
                </details>
              )}
              {/* role="log": additions are announced politely without re-reading the lot. */}
              <div className="msg-content md" role="log" aria-live="polite">
                <AssistantMarkdown text={streamText} />
                <span className="cursor" aria-hidden="true">
                  ▋
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Assistant replies render as Markdown (GFM: bold, lists, tables, code, …) — local
 * models emit Markdown and showing the raw `**asterisks**` reads as broken output.
 * react-markdown builds React elements (no innerHTML), and raw HTML in model output is
 * rendered as literal text, so the strict CSP / no-injection posture is unchanged.
 * Links open in the OS browser via `target="_blank"` (the main process's window-open
 * handler allows http(s) only); user turns stay plain text — they are not Markdown.
 */
export function AssistantMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      }}
    >
      {text}
    </Markdown>
  )
}
