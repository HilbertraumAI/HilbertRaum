import { useCallback, useEffect, useRef, useState } from 'react'
import type { Conversation, Message } from '@shared/types'

// Chat screen (spec §7.6 / Milestone 3). Conversation list on the left, a streamed
// message view on the right. Tokens arrive over the preload `onToken(convId)`
// channel; `sendChatMessage` resolves with the final persisted assistant message.
// A chat needs a running model — when none is running we show an empty state that
// points at the Models screen (sendChatMessage will otherwise reject).

interface Props {
  onNavigate: (screen: string) => void
}

export function ChatScreen({ onNavigate }: Props): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [runtimeRunning, setRuntimeRunning] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const refreshConversations = useCallback(async (): Promise<void> => {
    setConversations(await window.api.listConversations())
  }, [])

  const checkRuntime = useCallback(async (): Promise<void> => {
    const models = await window.api.listModels()
    setRuntimeRunning(models.some((m) => m.state === 'running'))
  }, [])

  useEffect(() => {
    void refreshConversations()
    void checkRuntime().catch(() => setRuntimeRunning(false))
  }, [refreshConversations, checkRuntime])

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
    const conv = await window.api.createConversation()
    setActiveId(conv.id)
    await refreshConversations()
    return conv.id
  }

  async function stream(convId: string, content: string, regenerate: boolean): Promise<void> {
    setError(null)
    setStreaming(true)
    setStreamText('')
    const unsubscribe = window.api.onToken(convId, (token) => {
      setStreamText((prev) => prev + token)
    })
    try {
      await window.api.sendChatMessage(convId, content, regenerate ? { regenerate: true } : undefined)
      // Re-read the persisted history (includes the user turn + final assistant reply).
      setMessages(await window.api.listMessages(convId))
      await refreshConversations()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      // Refresh so a partial (stopped) reply that was persisted still shows.
      setMessages(await window.api.listMessages(convId))
      await checkRuntime()
    } finally {
      unsubscribe()
      setStreaming(false)
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
    if (!activeId || streaming) return
    // Drop the last assistant message from the view; the backend re-streams it.
    setMessages((prev) => {
      const lastAssistant = [...prev].reverse().findIndex((m) => m.role === 'assistant')
      if (lastAssistant === -1) return prev
      const idx = prev.length - 1 - lastAssistant
      return prev.slice(0, idx)
    })
    await stream(activeId, '', true)
  }

  function onStop(): void {
    if (activeId) void window.api.stopGeneration(activeId)
  }

  async function onNewChat(): Promise<void> {
    const conv = await window.api.createConversation()
    await refreshConversations()
    setActiveId(conv.id)
    setMessages([])
  }

  const canRegenerate = !streaming && messages.some((m) => m.role === 'assistant')

  // --- Empty state: no model running ------------------------------------------
  if (runtimeRunning === false) {
    return (
      <div className="screen">
        <h1>Chat</h1>
        <div className="card">
          <h2>No model is running</h2>
          <p className="hint">
            Chat needs a model loaded into the runtime. Open the Models screen, pick a model, then
            choose <b>Start runtime</b>. Everything stays local — nothing is downloaded or sent
            anywhere.
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
        <button className="btn sm primary chat-new" onClick={() => void onNewChat()}>
          + New chat
        </button>
        <div className="chat-conv-list">
          {conversations.length === 0 && <p className="hint">No conversations yet.</p>}
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`chat-conv ${c.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(c.id)}
              title={c.title}
            >
              {c.title}
            </button>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        <div className="chat-transcript" ref={scrollRef}>
          {messages.length === 0 && !streaming && (
            <p className="hint chat-empty">
              Send a message to start. Replies stream from the local mock runtime.
            </p>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {streaming && (
            <div className="msg assistant">
              <div className="msg-role">assistant</div>
              <div className="msg-content">
                {streamText}
                <span className="cursor">▋</span>
              </div>
            </div>
          )}
        </div>

        {error && <div className="chat-error">⚠ {error}</div>}

        <div className="chat-input-row">
          <textarea
            className="chat-input"
            placeholder="Message Private AI Drive Lite…"
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
                Send
              </button>
            )}
            <button className="btn sm" disabled={!canRegenerate} onClick={() => void onRegenerate()}>
              Regenerate
            </button>
          </div>
        </div>
      </section>
    </div>
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
      <div className="msg-content">{message.content}</div>
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
