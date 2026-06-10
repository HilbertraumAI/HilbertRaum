import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Citation, Conversation, Message } from '@shared/types'

// Chat screen (spec §7.6 / §7.8 — Milestones 3 & 6). Conversation list on the left, a
// streamed message view on the right. Two modes share the same streaming contract:
//   • "Chat"          → sendChatMessage (plain assistant)
//   • "Ask Documents" → askDocuments    (RAG: grounded answer + [Sn] citations)
// Tokens arrive over the preload `onToken(convId)` channel; both calls resolve with the
// final persisted assistant message. A mode is fixed per conversation (its `mode` field);
// the toggle picks the mode for the NEXT new conversation. Both need a running model — when
// none is running we show an empty state pointing at the Models screen.

type Mode = 'chat' | 'documents'

interface Props {
  onNavigate: (screen: string) => void
  /** Composer mode to open with — Home's "Ask My Documents" passes 'documents'. */
  initialMode?: Mode
}

export function ChatScreen({ onNavigate, initialMode }: Props): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [mode, setMode] = useState<Mode>(initialMode ?? 'chat')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  /** Which conversation the live stream belongs to (M2): the bubble renders, and the
   *  completion refresh applies, only when this still matches the visible conversation. */
  const [streamConvId, setStreamConvId] = useState<string | null>(null)
  const [runtimeRunning, setRuntimeRunning] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The currently-visible conversation, readable from inside async stream completions
  // (the `activeId` captured by the closure goes stale when the user switches).
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const refreshConversations = useCallback(async (): Promise<void> => {
    setConversations(await window.api.listConversations())
  }, [])

  const checkRuntime = useCallback(async (): Promise<void> => {
    const status = await window.api.getRuntimeStatus()
    setRuntimeRunning(status.running)
  }, [])

  useEffect(() => {
    void refreshConversations()
    void checkRuntime().catch(() => setRuntimeRunning(false))
  }, [refreshConversations, checkRuntime])

  // While no runtime is up, poll: the app may still be auto-starting the selected model
  // in the background (it can take a while to load a large GGUF), and the screen should
  // flip to the composer on its own instead of demanding a manual "Re-check".
  useEffect(() => {
    if (runtimeRunning !== false) return
    const timer = setInterval(() => {
      void checkRuntime().catch(() => undefined)
    }, 2500)
    return () => clearInterval(timer)
  }, [runtimeRunning, checkRuntime])

  // Load history when the active conversation changes.
  useEffect(() => {
    if (!activeId) {
      setMessages([])
      return
    }
    window.api
      .listMessages(activeId)
      .then(setMessages)
      .catch((e) => setError(String(e)))
  }, [activeId])

  // Keep the transcript scrolled to the newest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streamText])

  async function ensureConversation(): Promise<string> {
    if (activeId) return activeId
    const conv = await window.api.createConversation({ mode })
    setActiveId(conv.id)
    await refreshConversations()
    return conv.id
  }

  async function stream(convId: string, content: string, regenerate: boolean): Promise<void> {
    setError(null)
    setStreaming(true)
    setStreamConvId(convId)
    setStreamText('')
    const unsubscribe = window.api.onToken(convId, (token) => {
      setStreamText((prev) => prev + token)
    })
    // Only update the visible transcript if the user is still looking at THIS
    // conversation — replacing another conversation's view with this one's messages
    // was the M2 corruption.
    const refreshIfVisible = async (): Promise<void> => {
      if (activeIdRef.current === convId) {
        setMessages(await window.api.listMessages(convId))
      }
    }
    try {
      if (mode === 'documents') {
        await window.api.askDocuments(convId, content)
      } else {
        await window.api.sendChatMessage(convId, content, regenerate ? { regenerate: true } : undefined)
      }
      // Re-read the persisted history (includes the user turn + final assistant reply).
      await refreshIfVisible()
      await refreshConversations()
    } catch (e) {
      if (activeIdRef.current === convId) setError(String(e instanceof Error ? e.message : e))
      // Refresh so a partial (stopped) reply that was persisted still shows.
      await refreshIfVisible().catch(() => undefined)
      await checkRuntime().catch(() => undefined)
    } finally {
      unsubscribe()
      setStreaming(false)
      setStreamConvId(null)
      setStreamText('')
    }
  }

  async function onSend(): Promise<void> {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    try {
      const convId = await ensureConversation()
      setMessages((prev) => [...prev, optimisticUser(convId, text)])
      await stream(convId, text, false)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  async function onRegenerate(): Promise<void> {
    if (!activeId || streaming || mode === 'documents') return
    // Drop the LAST message from the view only if it is an assistant turn — mirroring
    // the backend (M1): after a failed generation the conversation ends in a user turn,
    // and regenerate must not touch the answer to an earlier question.
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      return last && last.role === 'assistant' ? prev.slice(0, -1) : prev
    })
    await stream(activeId, '', true)
  }

  function onStop(): void {
    if (activeId) void window.api.stopGeneration(activeId)
  }

  // Export the transcript to a user-chosen local file (spec §7.6 — M13). Saving is an
  // explicit user action via the OS save dialog; nothing leaves the device otherwise.
  async function onExport(): Promise<void> {
    if (!activeId) return
    setNotice(null)
    try {
      const saved = await window.api.exportConversation(activeId)
      if (saved) setNotice(`Transcript saved to ${saved}`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  async function onNewChat(): Promise<void> {
    const conv = await window.api.createConversation({ mode })
    await refreshConversations()
    setActiveId(conv.id)
    setMessages([])
  }

  // Selecting a conversation also syncs the composer mode to that conversation's mode.
  function onSelectConversation(c: Conversation): void {
    setActiveId(c.id)
    setMode(c.mode)
  }

  // Delete a conversation (chat or document Q&A) and its messages — permanent.
  async function onDeleteConversation(c: Conversation): Promise<void> {
    if (streaming) return
    if (!window.confirm(`Delete "${c.title}"? This permanently removes the conversation and its messages.`)) {
      return
    }
    try {
      await window.api.deleteConversation(c.id)
      if (activeId === c.id) {
        setActiveId(null)
        setMessages([])
      }
      await refreshConversations()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  // Switching mode starts a fresh composition: if the active conversation is in a
  // different mode, deselect it so the next send creates a conversation in the new mode.
  function onSelectMode(next: Mode): void {
    if (streaming) return
    setMode(next)
    const active = conversations.find((c) => c.id === activeId)
    if (active && active.mode !== next) {
      setActiveId(null)
      setMessages([])
    }
  }

  const canRegenerate = !streaming && mode === 'chat' && messages.some((m) => m.role === 'assistant')

  // --- Empty state: no model running ------------------------------------------
  if (runtimeRunning === false) {
    return (
      <div className="screen">
        <h1>Chat</h1>
        <div className="card">
          <h2>No model is running</h2>
          <p className="hint">
            Chat and document Q&amp;A need a model loaded into the runtime. Open the Models screen,
            pick a model, then choose <b>Start runtime</b>. Everything stays local — nothing is
            downloaded or sent anywhere.
          </p>
          <p className="hint">
            <span className="spinner" /> If you just opened the app, your selected model may still
            be loading — this screen continues automatically once it is ready.
          </p>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => onNavigate('models')}>
              Go to Models
            </button>
            <button className="btn" onClick={() => void checkRuntime()}>
              Re-check
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        {/* Switching conversations mid-stream is disabled (M2): the stream belongs to one
            conversation, and hopping away used to corrupt the other transcript's view. */}
        <button className="btn sm primary chat-new" disabled={streaming} onClick={() => void onNewChat()}>
          + New {mode === 'documents' ? 'document Q&A' : 'chat'}
        </button>
        <div className="chat-conv-list">
          {conversations.length === 0 && <p className="hint">No conversations yet.</p>}
          {conversations.map((c) => (
            <div key={c.id} className="chat-conv-row">
              <button
                className={`chat-conv ${c.id === activeId ? 'active' : ''}`}
                disabled={streaming && c.id !== activeId}
                onClick={() => onSelectConversation(c)}
                title={c.title}
              >
                {c.mode === 'documents' && <span className="chat-conv-badge">DOC</span>}
                {c.title}
              </button>
              <button
                className="chat-conv-delete"
                disabled={streaming}
                title="Delete conversation"
                aria-label={`Delete conversation "${c.title}"`}
                onClick={() => void onDeleteConversation(c)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        <div className="chat-mode-tabs">
          <button
            className={`chat-mode-tab ${mode === 'chat' ? 'active' : ''}`}
            disabled={streaming}
            onClick={() => onSelectMode('chat')}
          >
            Chat
          </button>
          <button
            className={`chat-mode-tab ${mode === 'documents' ? 'active' : ''}`}
            disabled={streaming}
            onClick={() => onSelectMode('documents')}
          >
            Ask Documents
          </button>
        </div>

        <div className="chat-transcript" ref={scrollRef}>
          {messages.length === 0 && !streaming && (
            <p className="hint chat-empty">
              {mode === 'documents'
                ? 'Ask a question about your imported documents. Answers cite their sources.'
                : 'Send a message to start. Replies stream from the local model.'}
            </p>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {streaming && streamConvId === activeId && (
            <div className="msg assistant">
              <div className="msg-role">assistant</div>
              <div className="msg-content md">
                <AssistantMarkdown text={streamText} />
                <span className="cursor">▋</span>
              </div>
            </div>
          )}
        </div>

        {error && <div className="chat-error">⚠ {error}</div>}
        {notice && <div className="hint chat-notice">{notice}</div>}

        <div className="chat-input-row">
          <textarea
            className="chat-input"
            placeholder={
              mode === 'documents'
                ? 'Ask about your documents…'
                : 'Message Private AI Drive Lite…'
            }
            value={input}
            disabled={streaming}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void onSend()
              }
            }}
          />
          <div className="chat-input-actions">
            {streaming ? (
              <button className="btn" onClick={onStop}>
                Stop
              </button>
            ) : (
              <button className="btn primary" disabled={!input.trim()} onClick={() => void onSend()}>
                {mode === 'documents' ? 'Ask' : 'Send'}
              </button>
            )}
            {mode === 'chat' && (
              <button className="btn sm" disabled={!canRegenerate} onClick={() => void onRegenerate()}>
                Regenerate
              </button>
            )}
            <button
              className="btn sm"
              disabled={!activeId || messages.length === 0 || streaming}
              title="Save this conversation as a Markdown file (stays local)"
              onClick={() => void onExport()}
            >
              Export
            </button>
          </div>
        </div>
      </section>
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
function AssistantMarkdown({ text }: { text: string }): JSX.Element {
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

function MessageBubble({ message }: { message: Message }): JSX.Element {
  const [copied, setCopied] = useState(false)
  function copy(): void {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-role">
        {message.role}
        <button className="msg-copy" onClick={copy} title="Copy message">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {message.role === 'assistant' ? (
        <div className="msg-content md">
          <AssistantMarkdown text={message.content} />
        </div>
      ) : (
        <div className="msg-content">{message.content}</div>
      )}
      {message.citations && message.citations.length > 0 && <SourcePanel citations={message.citations} />}
    </div>
  )
}

// Source-snippet panel (spec §7.8 / Milestone 6): lists the cited sources for a grounded
// answer and lets the user expand each one to read the chunk text that was cited.
function SourcePanel({ citations }: { citations: Citation[] }): JSX.Element {
  const [openLabel, setOpenLabel] = useState<string | null>(null)
  return (
    <div className="msg-sources">
      <div className="msg-sources-title">Sources</div>
      {citations.map((c) => {
        const open = openLabel === c.label
        return (
          <div key={c.label} className="cite">
            <button
              className="cite-head"
              onClick={() => setOpenLabel(open ? null : c.label)}
              disabled={!c.snippet}
              title={c.snippet ? 'Show cited text' : undefined}
            >
              <span className="cite-label">[{c.label}]</span>
              <span className="cite-src">
                {c.sourceTitle}
                {c.pageNumber != null
                  ? ` · Page ${c.pageNumber}`
                  : c.section
                    ? ` · ${c.section}`
                    : ''}
              </span>
            </button>
            {open && c.snippet && <div className="cite-snippet">{c.snippet}</div>}
          </div>
        )
      })}
    </div>
  )
}

function optimisticUser(conversationId: string, content: string): Message {
  return {
    id: `optimistic-${Date.now()}`,
    conversationId,
    role: 'user',
    content,
    createdAt: new Date().toISOString()
  }
}
