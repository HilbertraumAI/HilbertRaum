import { useCallback, useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  DOC_TASK_BUSY_MESSAGE,
  type ChatDepthMode,
  type Conversation,
  type DocumentInfo,
  type Message
} from '@shared/types'
import { cancelActiveDocTask } from '../lib/doctasks'
import { localizeServerCopy } from '../lib/displayMap'
import { friendlyIpcError } from '../lib/errors'
import { RUNTIME_POLL_MS } from '../lib/polling'
import { useT } from '../i18n'
import { Button, Chip, EmptyState, ErrorBanner, LocalIndicator, SegmentedControl, Spinner, useToast } from '../components'
import { Composer, ConversationList, DepthMenu, ScopePopover, Transcript } from '../chat'
import type { MessageKey } from '@shared/i18n'

// Chat screen (spec §7.6 / §7.8; layout per design-guidelines §3). The
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
// Answer depth (spec §10.3): the composer footer carries the answer-detail dropdown
// (Quick / Balanced / Thorough — the ids stay fast|balanced|deep), sticky per
// conversation for this session and sent per-message (`ChatOptions.mode`). Thorough is
// offered only when the running model's manifest declares thinking support
// (`RuntimeStatus.supportsThinkingMode`); its reasoning streams into a collapsed
// "Thinking…" line on the live bubble only — the persisted reply never includes it.
// Document answers always run Balanced.

type Mode = 'chat' | 'documents'

/** localStorage key for the conversation-list collapse (a UI preference, not user data). */
export const LIST_COLLAPSED_KEY = 'hilbertraum.chat.listCollapsed'

/** Below this viewport width the history column auto-collapses (responsive; the
 *  persisted desktop preference is untouched — widening restores the user's choice). */
export const LIST_AUTO_COLLAPSE_PX = 1150

/** Streamed tokens are batched and flushed on this cadence instead of per-token. */
const STREAM_FLUSH_MS = 40

/** Teaching empty state (guidelines §3): example prompts that fill the composer. */
const EXAMPLE_PROMPT_KEYS: MessageKey[] = [
  'chat.example.summarize',
  'chat.example.paymentTerms',
  'chat.example.indemnity'
]

interface Props {
  onNavigate: (screen: string) => void
  /** Composer mode to open with — Home's "Ask My Documents" passes 'documents'. */
  initialMode?: Mode
  /** Retrieval scope for the NEXT documents conversation ("Ask these documents"). */
  initialScopeDocumentIds?: string[] | null
  /**
   * Effective offline state, owned by App (M-U4: one ambient truth, guidelines §7).
   * Passed to the header LocalIndicator so it agrees with the sidebar instead of
   * self-fetching the policy at its own mount.
   */
  offline?: boolean
}

export function ChatScreen({
  onNavigate,
  initialMode,
  initialScopeDocumentIds,
  offline
}: Props): JSX.Element {
  const { t } = useT()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [mode, setMode] = useState<Mode>(initialMode ?? 'chat')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  /** Live Deep-mode reasoning — rendered as the collapsed "Thinking…" line
   *  on the streaming bubble only; it is never persisted, so it vanishes on refresh. */
  const [streamThinking, setStreamThinking] = useState('')
  /** Expand state of the Thinking… line — auto-collapses on the first answer token. */
  const [thinkingOpen, setThinkingOpen] = useState(false)
  /** Which conversation the live stream belongs to: the bubble renders, and the
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
  // Voice dictation: availability-driven — the composer mic renders only
  // when a transcriber is selected (whisper binary + weights on the drive). Best-effort
  // like `docs`: a failed status read just hides the mic.
  const [dictationAvailable, setDictationAvailable] = useState(false)
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
  // Responsive auto-collapse: on narrower windows the history column gives its space
  // to the transcript without disturbing the persisted desktop preference. The effective
  // collapsed state is (user preference OR viewport-too-narrow); only the toggle writes
  // the persisted preference, so widening the window restores what the user last chose.
  const [narrow, setNarrow] = useState<boolean>(
    () => typeof window.matchMedia === 'function' && window.matchMedia(`(max-width: ${LIST_AUTO_COLLAPSE_PX}px)`).matches
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(`(max-width: ${LIST_AUTO_COLLAPSE_PX}px)`)
    const onChange = (e: MediaQueryListEvent): void => {
      setNarrow(e.matches)
      // Leaving the narrow range drops any session-only "peek open" override.
      if (!e.matches) setNarrowPeek(false)
    }
    mql.addEventListener('change', onChange)
    setNarrow(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  // Session-only override that re-opens the list while the window is narrow (the user
  // pressed the reopen handle). Cleared when the window widens again.
  const [narrowPeek, setNarrowPeek] = useState(false)
  const effectiveCollapsed = narrow ? !narrowPeek : listCollapsed
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
  // M-U2: set when the user presses Stop during a stream, so the stream`s finally can
  // confirm the interruption (a stopped partial reply otherwise looks like a normal turn).
  const stopped = useRef(false)
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
    void (async () => {
      try {
        const status = await window.api.getAppStatus()
        setDictationAvailable(status?.dictationAvailable === true)
      } catch {
        setDictationAvailable(false)
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
    }, RUNTIME_POLL_MS)
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
      .catch((e) => setError(friendlyIpcError(e)))
  }, [activeId])

  function setListCollapsedPersistent(collapsed: boolean): void {
    setListCollapsed(collapsed)
    try {
      window.localStorage.setItem(LIST_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // Remembering the preference is best-effort.
    }
  }

  // Collapse/expand from the toggle. While the window is narrow the list is auto-collapsed,
  // so the toggle drives a session-only "peek" override instead of the persisted preference
  // (which still governs wide windows and survives the session).
  function collapseList(): void {
    if (narrow) setNarrowPeek(false)
    else setListCollapsedPersistent(true)
  }
  function expandList(): void {
    if (narrow) setNarrowPeek(true)
    else setListCollapsedPersistent(false)
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

  // ---- Answer depth (Quick / Balanced / Thorough) ------------------------------
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
    stopped.current = false
    const unsubscribe = window.api.onToken(convId, (token) => {
      // The first answer token auto-collapses an expanded Thinking… line.
      if (!answerStarted.current) {
        answerStarted.current = true
        setThinkingOpen(false)
      }
      pendingTokens.current += token
      scheduleFlush()
    })
    // Deep-mode reasoning deltas feed the live "Thinking…" line. They are
    // a separate channel from answer tokens and are never part of the persisted reply.
    const unsubscribeReasoning = window.api.onReasoning(convId, (delta) => {
      pendingThinking.current += delta
      scheduleFlush()
    })
    // Filename auto-scope notice: a one-shot hint that this document answer was
    // restricted to the file(s) the question named (ephemeral — never persisted).
    const unsubscribeScope = window.api.onScopeNotice(convId, ({ titles }) => {
      if (titles.length > 0) showToast(t('chat.scopeNotice', { titles: titles.join(', ') }))
    })
    // Only update the visible transcript if the user is still looking at THIS
    // conversation — replacing another conversation's view with this one's messages
    // corrupts the visible transcript.
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
      if (activeIdRef.current === convId) setError(friendlyIpcError(e))
      // Refresh so a partial (stopped) reply that was persisted still shows.
      await refreshIfVisible().catch(() => undefined)
      await checkRuntime().catch(() => undefined)
    } finally {
      unsubscribe()
      unsubscribeReasoning()
      unsubscribeScope()
      clearStreamBuffers()
      setStreaming(false)
      setStreamConvId(null)
      setStreamText('')
      setStreamThinking('')
      // M-U2: confirm a user-requested stop so a truncated reply is not mistaken for a
      // complete one. Only when looking at THIS conversation (a background stream`s toast
      // would be confusing) and only if no error already explained the early end.
      if (stopped.current && activeIdRef.current === convId) showToast(t('chat.stopped'))
      stopped.current = false
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
      setError(friendlyIpcError(e))
    }
  }

  async function onTryAgain(): Promise<void> {
    if (!activeId || streaming || mode === 'documents') return
    // Drop the LAST message from the view only if it is an assistant turn — mirroring
    // the backend: after a failed generation the conversation ends in a user turn,
    // and regenerate must not touch the answer to an earlier question.
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      return last && last.role === 'assistant' ? prev.slice(0, -1) : prev
    })
    await stream(activeId, '', true, depthFor(activeId))
  }

  function onStop(): void {
    if (activeId) {
      stopped.current = true
      void window.api.stopGeneration(activeId)
    }
  }

  // Save the transcript to a user-chosen local file (spec §7.6). Saving is an
  // explicit user action via the OS save dialog; nothing leaves the device otherwise.
  // Confirmation goes through the toast host (guidelines §6) — never inline notices.
  async function onSaveConversation(): Promise<void> {
    if (!activeId) return
    try {
      const saved = await window.api.exportConversation(activeId)
      if (saved) showToast(t('chat.savedTo', { path: saved }))
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  function onCopyMessage(content: string): void {
    void navigator.clipboard.writeText(content).then(() => showToast(t('chat.copied')))
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
      setError(friendlyIpcError(e))
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
        setError(friendlyIpcError(e))
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
  // Routed through the shared EmptyState (guidelines §6) like every other screen
  // (M-U3) instead of a hand-rolled .card. The "still loading" spinner line + the two
  // buttons ride in the `action` slot.
  if (runtimeRunning === false) {
    return (
      <div className="screen">
        <h1>{t('chat.title')}</h1>
        <EmptyState
          title={t('chat.noModel.title')}
          line={
            <>
              {t('chat.noModel.hintBefore')}
              <b>{t('chat.noModel.hintAction')}</b>
              {t('chat.noModel.hintAfter')}
            </>
          }
          action={
            <>
              <p className="hint">
                <Spinner /> {t('chat.noModel.stillLoading')}
              </p>
              <div className="actions" style={{ marginTop: 12 }}>
                <Button variant="primary" onClick={() => onNavigate('models')}>
                  {t('chat.noModel.open')}
                </Button>
                <Button onClick={() => void checkRuntime()}>{t('chat.noModel.recheck')}</Button>
              </div>
            </>
          }
        />
      </div>
    )
  }

  // Teaching empty state (guidelines §3): a friendly line, example prompts that fill
  // the composer, and — when nothing is imported yet — a nudge toward Documents.
  const emptyState = (
    <div className="chat-empty">
      <EmptyState
        title={t('chat.empty.title')}
        line={mode === 'documents' ? t('chat.empty.lineDocuments') : t('chat.empty.lineChat')}
        action={
          <>
            {EXAMPLE_PROMPT_KEYS.map((key) => (
              <Chip key={key} onClick={() => fillComposer(t(key))} title={t('chat.empty.fillTitle')}>
                {t(key)}
              </Chip>
            ))}
            {indexedDocCount === 0 && (
              <Button size="sm" onClick={() => onNavigate('documents')}>
                {t('chat.empty.addDocs')}
              </Button>
            )}
          </>
        }
      />
    </div>
  )

  return (
    <div className={`chat-layout ${effectiveCollapsed ? 'list-collapsed' : ''}`}>
      {!effectiveCollapsed && (
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          streaming={streaming}
          mode={mode}
          onSelect={onSelectConversation}
          onNew={() => void onNewChat()}
          onDelete={(c) => void onDeleteConversation(c)}
          onCollapse={collapseList}
        />
      )}

      <section className="chat-main">
        <div className="chat-header">
          {effectiveCollapsed && (
            <Button
              size="sm"
              variant="ghost"
              className="chat-list-show"
              aria-label={t('chat.listShow')}
              title={t('chat.listShow')}
              onClick={expandList}
            >
              »
            </Button>
          )}
          <SegmentedControl
            ariaLabel={t('chat.modeAria')}
            options={[
              { value: 'chat', label: t('chat.mode.chat') },
              { value: 'documents', label: t('chat.mode.documents') }
            ]}
            value={mode}
            onChange={onSelectMode}
            disabled={streaming}
          />
          <div className="chat-header-spacer" />
          {/* Ambient "Local · Offline" signal (guidelines §7); offline owned by App
              so the header and sidebar can never disagree (M-U4). */}
          <LocalIndicator offline={offline} onNavigate={onNavigate} t={t} />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="chat-overflow-btn"
                aria-label={t('chat.convOptions')}
                title={t('chat.convOptions')}
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
                  {t('chat.saveConversation')}
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

        {/* Always-mounted alert region (audit M-U1) so the error is announced even on
            its first appearance. DOC_TASK_BUSY_MESSAGE arrives canonical English on the
            wire — the display map localizes it here. */}
        <ErrorBanner
          message={error != null ? localizeServerCopy(t, error) : null}
          t={t}
          onDismiss={() => setError(null)}
        >
          {/* Chat refused while a document task runs: the shared
              copy comes with an actionable cancel — the task, not the chat. */}
          {error != null && error.includes(DOC_TASK_BUSY_MESSAGE) && (
            <>
              {' '}
              <Button
                size="sm"
                onClick={() => {
                  void cancelActiveDocTask()
                    .then(() => setError(null))
                    .catch(() => undefined)
                }}
              >
                {t('chat.cancelDocTask')}
              </Button>
            </>
          )}
        </ErrorBanner>

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void onSend()}
          onStop={onStop}
          streaming={streaming}
          placeholder={mode === 'documents' ? t('chat.placeholder.documents') : t('chat.placeholder.chat')}
          sendLabel={mode === 'documents' ? t('chat.send.ask') : t('chat.send.send')}
          inputRef={composerRef}
          dictationAvailable={dictationAvailable}
          onDictationError={setError}
          footer={
            mode === 'documents' ? (
              <ScopePopover
                docs={docs}
                scopeIds={scopeIds}
                disabled={streaming}
                onChangeScope={(next) => void onChangeScope(next)}
                onAddDocuments={() => onNavigate('documents')}
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
