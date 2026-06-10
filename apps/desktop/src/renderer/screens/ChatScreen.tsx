import { useCallback, useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ChatDepthMode, Conversation, DocumentInfo, Message } from '@shared/types'
import { Banner, Button, Chip, EmptyState, LocalIndicator, SegmentedControl, useToast } from '../components'
import { Composer, ConversationList, DepthMenu, ScopePopover, Transcript } from '../chat'

// Chat screen (spec §7.6 / §7.8; layout per design-guidelines §3, Phase 25). The
// conversation is the canvas: a collapsible conversation list, a centered transcript,
// and a composer whose footer carries the quiet affordances (answer detail, document
// scope). Two modes share the same streaming contract:
//   • "Chat"             → sendChatMessage (plain assistant)
//   • "Ask my documents" → askDocuments    (RAG: grounded answer + [Sn] citations)
// Tokens arrive over the preload `onToken(convId)` channel (buffered here against
// layout thrash); both calls resolve with the final persisted assistant message. A mode
// is fixed per conversation (its `mode` field); the header segmented control picks the
// mode for the NEXT new conversation. Both need a running model — when none is running
// we show an empty state pointing at the AI Model screen.
//
// Phase 20 (spec §10.3): the composer footer carries the answer-detail dropdown
// (Quick / Balanced / Thorough — ids stay fast|balanced|deep per D-UI4), sticky per
// conversation for this session and sent per-message (`ChatOptions.mode`). Thorough is
// offered only when the running model's manifest declares thinking support
// (`RuntimeStatus.supportsThinkingMode`); its reasoning streams into a collapsed
// "Thinking…" line on the live bubble only — the persisted reply never includes it.
// Document answers always run Balanced.

type Mode = 'chat' | 'documents'

/** localStorage key for the conversation-list collapse (a UI preference, not user data). */
export const LIST_COLLAPSED_KEY = 'paid.chat.listCollapsed'

/** Streamed tokens are batched and flushed on this cadence instead of per-token. */
const STREAM_FLUSH_MS = 40

/** Teaching empty state (guidelines §3): example prompts that fill the composer. */
const EXAMPLE_PROMPTS = [
  'Summarize this contract',
  'What are the payment terms?',
  "Find every mention of 'indemnity'"
]

interface Props {
  onNavigate: (screen: string) => void
  /** Composer mode to open with — Home's "Ask My Documents" passes 'documents'. */
  initialMode?: Mode
  /** Retrieval scope for the NEXT documents conversation ("Ask these documents"). */
  initialScopeDocumentIds?: string[] | null
}

export function ChatScreen({ onNavigate, initialMode, initialScopeDocumentIds }: Props): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [mode, setMode] = useState<Mode>(initialMode ?? 'chat')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  /** Live Deep-mode reasoning (Phase 20) — rendered as the collapsed "Thinking…" line
   *  on the streaming bubble only; it is never persisted, so it vanishes on refresh. */
  const [streamThinking, setStreamThinking] = useState('')
  /** Expand state of the Thinking… line — auto-collapses on the first answer token. */
  const [thinkingOpen, setThinkingOpen] = useState(false)
  /** Which conversation the live stream belongs to (M2): the bubble renders, and the
   *  completion refresh applies, only when this still matches the visible conversation. */
  const [streamConvId, setStreamConvId] = useState<string | null>(null)
  const [runtimeRunning, setRuntimeRunning] = useState<boolean | null>(null)
  /** Whether the RUNNING model's manifest declares thinking support — gates Thorough. */
  const [supportsThinking, setSupportsThinking] = useState(false)
  /** Per-conversation answer depth for this session ('new' = no conversation yet). */
  const [depths, setDepths] = useState<Record<string, ChatDepthMode>>({})
  const [error, setError] = useState<string | null>(null)
  // Imported documents — drives the scope popover's titles and the empty-state nudge.
  // Best-effort: a failed load just hides both affordances.
  const [docs, setDocs] = useState<DocumentInfo[]>([])
  // Scope for the NEXT documents conversation (from "Ask these documents"); once a
  // conversation is created it owns the scope (`scopeDocumentIds`) and this clears.
  const [pendingScope, setPendingScope] = useState<string[] | null>(initialScopeDocumentIds ?? null)
  // Conversation-list collapse, remembered across sessions (localStorage — a UI
  // preference, NOT user data, so it may live outside the encrypted workspace).
  const [listCollapsed, setListCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(LIST_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const showToast = useToast()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // The currently-visible conversation, readable from inside async stream completions
  // (the `activeId` captured by the closure goes stale when the user switches).
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  // Token buffering (guidelines §3): deltas accumulate in refs and flush to state on a
  // timer, so a fast model doesn't force a re-render + reflow per token.
  const pendingTokens = useRef('')
  const pendingThinking = useRef('')
  const answerStarted = useRef(false)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushStream = useCallback((): void => {
    flushTimer.current = null
    if (pendingTokens.current !== '') {
      const chunk = pendingTokens.current
      pendingTokens.current = ''
      setStreamText((prev) => prev + chunk)
    }
    if (pendingThinking.current !== '') {
      const chunk = pendingThinking.current
      pendingThinking.current = ''
      setStreamThinking((prev) => prev + chunk)
    }
  }, [])

  const scheduleFlush = useCallback((): void => {
    if (flushTimer.current == null) flushTimer.current = setTimeout(flushStream, STREAM_FLUSH_MS)
  }, [flushStream])

  function clearStreamBuffers(): void {
    if (flushTimer.current != null) clearTimeout(flushTimer.current)
    flushTimer.current = null
    pendingTokens.current = ''
    pendingThinking.current = ''
  }

  const refreshConversations = useCallback(async (): Promise<void> => {
    setConversations(await window.api.listConversations())
  }, [])

  const checkRuntime = useCallback(async (): Promise<void> => {
    const status = await window.api.getRuntimeStatus()
    setRuntimeRunning(status.running)
    setSupportsThinking(status.supportsThinkingMode === true)
  }, [])

  useEffect(() => {
    void refreshConversations()
    void checkRuntime().catch(() => setRuntimeRunning(false))
    void (async () => {
      try {
        setDocs((await window.api.listDocuments()) ?? [])
      } catch {
        setDocs([])
      }
    })()
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

  function setListCollapsedPersistent(collapsed: boolean): void {
    setListCollapsed(collapsed)
    try {
      window.localStorage.setItem(LIST_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // Remembering the preference is best-effort.
    }
  }

  // Create a conversation in the current mode. A documents conversation takes the
  // pending "ask selected documents" scope (which it then owns — the handoff clears).
  async function createConversationInMode(): Promise<Conversation> {
    const scope = mode === 'documents' ? pendingScope : undefined
    const conv = await window.api.createConversation({ mode, scopeDocumentIds: scope })
    if (scope) setPendingScope(null)
    return conv
  }

  async function ensureConversation(): Promise<string> {
    if (activeId) return activeId
    const conv = await createConversationInMode()
    setActiveId(conv.id)
    await refreshConversations()
    return conv.id
  }

  // ---- Phase 20: answer depth (Quick / Balanced / Thorough; ids per D-UI4) -----
  /** The depth selected for a conversation key, coerced to Balanced when the running
   *  model cannot think (a sticky Thorough choice must not silently send 'deep'). */
  function depthFor(key: string): ChatDepthMode {
    const selected = depths[key] ?? 'balanced'
    return selected === 'deep' && !supportsThinking ? 'balanced' : selected
  }

  const depthKey = activeId ?? 'new'
  const currentDepth = depthFor(depthKey)

  function selectDepth(d: ChatDepthMode): void {
    if (streaming) return
    setDepths((prev) => ({ ...prev, [depthKey]: d }))
  }

  async function stream(
    convId: string,
    content: string,
    regenerate: boolean,
    depth: ChatDepthMode
  ): Promise<void> {
    setError(null)
    setStreaming(true)
    setStreamConvId(convId)
    setStreamText('')
    setStreamThinking('')
    setThinkingOpen(false)
    answerStarted.current = false
    const unsubscribe = window.api.onToken(convId, (token) => {
      // The first answer token auto-collapses an expanded Thinking… line (§3).
      if (!answerStarted.current) {
        answerStarted.current = true
        setThinkingOpen(false)
      }
      pendingTokens.current += token
      scheduleFlush()
    })
    // Deep-mode reasoning deltas (Phase 20) feed the live "Thinking…" line. They are
    // a separate channel from answer tokens and are never part of the persisted reply.
    const unsubscribeReasoning = window.api.onReasoning(convId, (delta) => {
      pendingThinking.current += delta
      scheduleFlush()
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
        await window.api.sendChatMessage(convId, content, {
          mode: depth,
          ...(regenerate ? { regenerate: true } : {})
        })
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
      unsubscribeReasoning()
      clearStreamBuffers()
      setStreaming(false)
      setStreamConvId(null)
      setStreamText('')
      setStreamThinking('')
    }
  }

  async function onSend(): Promise<void> {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    try {
      // The 'new'-composer depth selection sticks to the conversation that gets created.
      const depth = depthFor(depthKey)
      const convId = await ensureConversation()
      setDepths((prev) => ({ ...prev, [convId]: depth }))
      setMessages((prev) => [...prev, optimisticUser(convId, text)])
      await stream(convId, text, false, depth)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  async function onTryAgain(): Promise<void> {
    if (!activeId || streaming || mode === 'documents') return
    // Drop the LAST message from the view only if it is an assistant turn — mirroring
    // the backend (M1): after a failed generation the conversation ends in a user turn,
    // and regenerate must not touch the answer to an earlier question.
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      return last && last.role === 'assistant' ? prev.slice(0, -1) : prev
    })
    await stream(activeId, '', true, depthFor(activeId))
  }

  function onStop(): void {
    if (activeId) void window.api.stopGeneration(activeId)
  }

  // Save the transcript to a user-chosen local file (spec §7.6 — M13). Saving is an
  // explicit user action via the OS save dialog; nothing leaves the device otherwise.
  // Confirmation goes through the toast host (guidelines §6) — never inline notices.
  async function onSaveConversation(): Promise<void> {
    if (!activeId) return
    try {
      const saved = await window.api.exportConversation(activeId)
      if (saved) showToast(`Saved to ${saved}`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  function onCopyMessage(content: string): void {
    void navigator.clipboard.writeText(content).then(() => showToast('Copied'))
  }

  async function onNewChat(): Promise<void> {
    const conv = await createConversationInMode()
    await refreshConversations()
    setActiveId(conv.id)
    setMessages([])
  }

  // Selecting a conversation also syncs the composer mode to that conversation's mode.
  function onSelectConversation(c: Conversation): void {
    setActiveId(c.id)
    setMode(c.mode)
  }

  // Delete a conversation (chat or document Q&A) and its messages — permanent. The
  // ConfirmDialog lives in ConversationList; this runs after the user confirmed.
  async function onDeleteConversation(c: Conversation): Promise<void> {
    if (streaming) return
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

  const canTryAgain = !streaming && mode === 'chat' && messages.some((m) => m.role === 'assistant')
  const indexedDocCount = docs.filter((d) => d.status === 'indexed').length

  /** The active retrieval scope: the conversation's own, or the pending handoff. */
  const scopeIds: string[] | null =
    mode === 'documents'
      ? activeId
        ? (conversations.find((c) => c.id === activeId)?.scopeDocumentIds ?? null)
        : pendingScope
      : null

  // Scope changes from the popover. An existing conversation persists the change; with
  // no conversation yet, only the pending handoff updates. Null = the whole corpus.
  async function onChangeScope(next: string[] | null): Promise<void> {
    if (activeId) {
      try {
        await window.api.updateConversationScope(activeId, next)
        await refreshConversations()
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
      }
    } else {
      setPendingScope(next)
    }
  }

  // Example-prompt chips fill the composer (the user still presses Send).
  function fillComposer(prompt: string): void {
    setInput(prompt)
    composerRef.current?.focus()
  }

  // --- Empty state: no model running ------------------------------------------
  if (runtimeRunning === false) {
    return (
      <div className="screen">
        <h1>Chat</h1>
        <div className="card">
          <h2>No model is running</h2>
          <p className="hint">
            Chat and document Q&amp;A need a model loaded into the runtime. Open the AI Model
            screen, pick a model, then choose <b>Start runtime</b>. Everything stays local —
            nothing is downloaded or sent anywhere.
          </p>
          <p className="hint">
            <span className="spinner" /> If you just opened the app, your selected model may still
            be loading — this screen continues automatically once it is ready.
          </p>
          <div className="actions" style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={() => onNavigate('models')}>
              Open AI Model
            </Button>
            <Button onClick={() => void checkRuntime()}>Re-check</Button>
          </div>
        </div>
      </div>
    )
  }

  // Teaching empty state (guidelines §3): a friendly line, example prompts that fill
  // the composer, and — when nothing is imported yet — a nudge toward Documents.
  const emptyState = (
    <div className="chat-empty">
      <EmptyState
        title="Ask a question, or ask about your documents."
        line={
          mode === 'documents'
            ? 'Answers come from your documents and cite their sources.'
            : 'Replies stream from the model on this drive — nothing leaves it.'
        }
        action={
          <>
            {EXAMPLE_PROMPTS.map((p) => (
              <Chip key={p} onClick={() => fillComposer(p)} title="Fill the message box">
                {p}
              </Chip>
            ))}
            {indexedDocCount === 0 && (
              <Button size="sm" onClick={() => onNavigate('documents')}>
                Add documents to ask about them
              </Button>
            )}
          </>
        }
      />
    </div>
  )

  return (
    <div className={`chat-layout ${listCollapsed ? 'list-collapsed' : ''}`}>
      {!listCollapsed && (
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          streaming={streaming}
          mode={mode}
          onSelect={onSelectConversation}
          onNew={() => void onNewChat()}
          onDelete={(c) => void onDeleteConversation(c)}
          onCollapse={() => setListCollapsedPersistent(true)}
        />
      )}

      <section className="chat-main">
        <div className="chat-header">
          {listCollapsed && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Show conversation list"
              title="Show conversation list"
              onClick={() => setListCollapsedPersistent(false)}
            >
              »
            </Button>
          )}
          <SegmentedControl
            ariaLabel="Chat mode"
            options={[
              { value: 'chat', label: 'Chat' },
              { value: 'documents', label: 'Ask my documents' }
            ]}
            value={mode}
            onChange={onSelectMode}
            disabled={streaming}
          />
          <div className="chat-header-spacer" />
          {/* Ambient "Local · Offline" signal (Phase 27, guidelines §7). */}
          <LocalIndicator onNavigate={onNavigate} />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="chat-overflow-btn"
                aria-label="Conversation options"
                title="Conversation options"
              >
                ⋯
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                <DropdownMenu.Item
                  className="menu-item"
                  disabled={!activeId || messages.length === 0 || streaming}
                  onSelect={() => void onSaveConversation()}
                >
                  Save this conversation
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>

        <Transcript
          messages={messages}
          streamingHere={streaming && streamConvId === activeId}
          streamText={streamText}
          streamThinking={streamThinking}
          thinkingOpen={thinkingOpen}
          onThinkingOpenChange={setThinkingOpen}
          emptyState={emptyState}
          onTryAgain={canTryAgain ? () => void onTryAgain() : undefined}
          onCopy={onCopyMessage}
          onSave={() => void onSaveConversation()}
          actionsDisabled={streaming}
        />

        {error && (
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void onSend()}
          onStop={onStop}
          streaming={streaming}
          placeholder={mode === 'documents' ? 'Ask about your documents…' : 'Message…'}
          sendLabel={mode === 'documents' ? 'Ask' : 'Send'}
          inputRef={composerRef}
          footer={
            mode === 'documents' ? (
              <ScopePopover
                docs={docs}
                scopeIds={scopeIds}
                disabled={streaming}
                onChangeScope={(next) => void onChangeScope(next)}
              />
            ) : (
              <DepthMenu
                value={currentDepth}
                onChange={selectDepth}
                supportsThinking={supportsThinking}
                disabled={streaming}
              />
            )
          }
        />
      </section>
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
