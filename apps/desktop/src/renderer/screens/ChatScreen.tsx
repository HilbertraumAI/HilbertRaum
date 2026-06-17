import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  DOC_TASK_BUSY_MESSAGE,
  type ChatDepthMode,
  type Collection,
  type Conversation,
  type DocumentInfo,
  type DocumentScope,
  type Message,
  type RunnableTool,
  type SkillInfo,
  type SkillSuggestion
} from '@shared/types'
import { cancelActiveDocTask } from '../lib/doctasks'
import {
  acknowledgeSkillRun,
  cancelActiveSkillRun,
  getActiveSkillRun,
  startSkillRun,
  subscribeSkillRun
} from '../lib/skillruns'
import { localizeServerCopy } from '../lib/displayMap'
import { skillTitleResolver } from '../lib/skillI18n'
import { friendlyIpcError } from '../lib/errors'
import { RUNTIME_POLL_MS, STREAM_RECOVER_POLL_MS } from '../lib/polling'
import { useT } from '../i18n'
import { Button, Chip, EmptyState, ErrorBanner, SegmentedControl, Spinner, useToast } from '../components'
import { Composer, ConversationList, DepthMenu, ScopePopover, SkillPicker, SkillRunBar, Transcript } from '../chat'
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

/**
 * Teaching empty state (guidelines §3): example prompts that fill the composer. Two sets —
 * plain Chat has no document access, so its examples are general-purpose; the "Ask my
 * documents" mode keeps document-shaped prompts. The empty state picks by `mode`.
 */
const CHAT_EXAMPLE_KEYS: MessageKey[] = [
  'chat.exampleChat.explain',
  'chat.exampleChat.draftEmail',
  'chat.exampleChat.brainstorm'
]
const DOC_EXAMPLE_KEYS: MessageKey[] = [
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
}

export function ChatScreen({
  onNavigate,
  initialMode,
  initialScopeDocumentIds
}: Props): JSX.Element {
  const { t, lang } = useT()
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
  // True while RECOVERING an in-flight generation that this component instance did not
  // start — the user sent a message, navigated away (unmounting the screen + its token
  // listeners), and came back while the model is still responding. Drives the same
  // streaming UI (live bubble, locked composer, Stop) as a locally-owned stream, but is
  // fed by polling `getActiveStream` rather than the live token events it missed.
  const [recovering, setRecovering] = useState(false)
  const [runtimeRunning, setRuntimeRunning] = useState<boolean | null>(null)
  // True while a model is loading in the background (server `startingModelId`), so the
  // no-model state can say "your model is starting" instead of the generic loading hint.
  const [modelStarting, setModelStarting] = useState(false)
  /** Whether the RUNNING model's manifest declares thinking support — gates Thorough. */
  const [supportsThinking, setSupportsThinking] = useState(false)
  /** Per-conversation answer depth for this session ('new' = no conversation yet). */
  const [depths, setDepths] = useState<Record<string, ChatDepthMode>>({})
  /** Enabled, available skills for the composer picker (skills plan §10.2/§11.3 lightweight index). */
  const [enabledSkills, setEnabledSkills] = useState<SkillInfo[]>([])
  /** All installed skills — used to localize the per-message glyph title (incl. a now-disabled skill). */
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  /** Per-conversation skill selection this session ('new' = no conversation yet). A key present
   *  here overrides the conversation's persisted `activeSkillId`; null = explicitly no skill. */
  const [skillByConv, setSkillByConv] = useState<Record<string, string | null>>({})
  /** The deterministic one-tap suggestion for the open picker (skills plan §10.2/S8), or null. */
  const [skillSuggestion, setSkillSuggestion] = useState<SkillSuggestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Imported documents — drives the scope popover's titles and the empty-state nudge.
  // Best-effort: a failed load just hides both affordances.
  const [docs, setDocs] = useState<DocumentInfo[]>([])
  // Collections (Library + projects) — drives the multi-select source picker + footer union
  // (document-organization plan §13). Best-effort: a failed load leaves the picker docs-only.
  const [collections, setCollections] = useState<Collection[]>([])
  // Voice dictation: availability-driven — the composer mic renders only
  // when a transcriber is selected (whisper binary + weights on the drive). Best-effort
  // like `docs`: a failed status read just hides the mic.
  const [dictationAvailable, setDictationAvailable] = useState(false)
  // Composite scope for the NEXT documents conversation (plan D1); once a conversation is
  // created it owns the scope (`scope_v2_json`) and this clears. Seeded from the Documents
  // screen's "Ask these documents" handoff (a specific-doc selection).
  const [pendingScope, setPendingScope] = useState<DocumentScope | null>(
    initialScopeDocumentIds && initialScopeDocumentIds.length > 0
      ? { collectionIds: [], documentIds: initialScopeDocumentIds }
      : null
  )
  // Temporary chat attachments for the active conversation (plan C3): the docs dropped /
  // attached into THIS chat, shown read-only as "Files in this chat" and always unioned
  // into retrieval. Loaded from `listAttachments` whenever the active documents chat changes.
  const [attachments, setAttachments] = useState<DocumentInfo[]>([])
  // An in-flight attachment import (plan §11.2 N4): drives the non-removable "processing
  // invoice.pdf…" pending chip until the doc is indexed and its `conversation_documents`
  // link exists. Conversation-scoped so it only shows on the chat that received the file.
  const [pendingImport, setPendingImport] = useState<{
    jobId: string
    convId: string
    documentIds: string[]
    fileNames: string[]
  } | null>(null)
  // Screen-reader-only status for the attach flow (UX-3): the pending chip lives inside a
  // closed ScopePopover, so keyboard/picker users get no audible "processing"/"added" cue.
  // A polite live region in the chat surface announces both (failures stay on ErrorBanner).
  const [attachStatus, setAttachStatus] = useState('')
  // Drag-over highlight for the chat-surface drop target (plan §11.2 net-new intake).
  const [dragOver, setDragOver] = useState(false)
  const attachPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
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
    setModelStarting(status.startingModelId != null)
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
        setCollections((await window.api.listCollections?.()) ?? [])
      } catch {
        setCollections([])
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
    void (async () => {
      try {
        // Only ENABLED, available skills are pickable for a turn (skills plan §10.2/§11.3).
        const all = (await window.api.listSkills?.()) ?? []
        setAllSkills(all)
        setEnabledSkills(all.filter((s) => s.enabled && !s.unavailable))
      } catch {
        setAllSkills([])
        setEnabledSkills([])
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

  // Load the conversation's chat attachments (plan C3) when it changes. Best-effort: a
  // failed load (or an older preload without the channel) just hides the affordance.
  const refreshAttachments = useCallback(async (convId: string | null): Promise<void> => {
    if (!convId || !window.api.listAttachments) {
      setAttachments([])
      return
    }
    try {
      setAttachments((await window.api.listAttachments(convId)) ?? [])
    } catch {
      setAttachments([])
    }
  }, [])
  useEffect(() => {
    void refreshAttachments(activeId)
  }, [activeId, refreshAttachments])

  // Stop the attachment-import poll on unmount.
  useEffect(() => {
    return () => {
      if (attachPollRef.current) clearInterval(attachPollRef.current)
    }
  }, [])

  // Recover an in-flight generation after a remount: if the visible conversation is still
  // streaming in the main process (the user navigated away mid-reply and came back), show
  // the live partial and lock the composer, finishing when it completes. Only runs when
  // this instance is NOT itself the stream owner (`streaming` false); a locally-owned
  // stream already drives the UI via live token events. Polls the main-side snapshot —
  // the token events fired while the screen was gone are not replayed.
  useEffect(() => {
    if (!activeId || streaming) return
    if (!window.api.getActiveStream) return // older preload / test stub
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    const stopPolling = (): void => {
      if (timer != null) {
        clearInterval(timer)
        timer = null
      }
    }
    const tick = async (): Promise<void> => {
      let snap: Awaited<ReturnType<NonNullable<typeof window.api.getActiveStream>>> = null
      try {
        snap = await window.api.getActiveStream!(activeId)
      } catch {
        snap = null
      }
      if (cancelled || activeIdRef.current !== activeId) return
      if (snap) {
        setRecovering(true)
        setStreamConvId(activeId)
        setStreamText(snap.content)
        setStreamThinking(snap.reasoning)
      } else {
        // Nothing in flight — either it never was, or it just finished while we watched.
        setRecovering((was) => {
          if (was) {
            // Completed: pull the persisted final reply and clear the live bubble.
            void window.api
              .listMessages(activeId)
              .then((m) => {
                if (!cancelled && activeIdRef.current === activeId) setMessages(m)
              })
              .catch(() => undefined)
            setStreamConvId(null)
            setStreamText('')
            setStreamThinking('')
          }
          return false
        })
        stopPolling() // idle — stop until activeId/streaming changes again
      }
    }
    void tick()
    timer = setInterval(() => void tick(), STREAM_RECOVER_POLL_MS)
    return () => {
      cancelled = true
      stopPolling()
    }
  }, [activeId, streaming])

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

  // Create a conversation in the current mode. A documents conversation takes the pending
  // composite scope (which it then owns — the handoff clears). When the pending scope is a
  // single project, that project also becomes the creation anchor (plan §13.3/§13.4).
  async function createConversationInMode(): Promise<Conversation> {
    const scope = mode === 'documents' ? pendingScope : undefined
    const collectionId =
      scope && scope.collectionIds.length === 1 && scope.documentIds.length === 0
        ? scope.collectionIds[0]
        : undefined
    const conv = await window.api.createConversation({ mode, scope, collectionId })
    if (scope) setPendingScope(null)
    return conv
  }

  async function ensureConversation(): Promise<string> {
    if (activeId) return activeId
    const conv = await createConversationInMode()
    // Carry a skill picked while still on the 'new' composer onto the created conversation as its
    // sticky default (skills plan §10.1), and re-key the session override to the new id.
    if ('new' in skillByConv) {
      const picked = skillByConv['new'] ?? null
      void window.api.setConversationDefaultSkill?.(conv.id, picked)
      setSkillByConv((prev) => ({ ...prev, [conv.id]: picked }))
    }
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
  // A reply is in progress — either this instance owns the live stream, or we are
  // recovering one that survived a navigation. Gates every "no new turn / no edits while
  // answering" affordance so a recovered stream behaves exactly like a live one.
  const busyStreaming = streaming || recovering

  function selectDepth(d: ChatDepthMode): void {
    if (busyStreaming) return
    setDepths((prev) => ({ ...prev, [depthKey]: d }))
  }

  // Per-message glyph title resolver (installId → localized title), rebuilt only when the loaded
  // skills or the UI language change. Display-only localization (architecture.md "Skills" §16).
  const resolveGlyphSkillTitle = useMemo(() => skillTitleResolver(allSkills, lang), [allSkills, lang])

  // ---- Turn skill (skills plan §10) -------------------------------------------------
  // The effective skill for a conversation key: a session override (the picker) wins, else the
  // conversation's persisted sticky default (`activeSkillId`), else none. A skill that is no longer
  // enabled/available is treated as none (graceful — §10.3), so a disabled default never lingers.
  const activeConversation = activeId ? conversations.find((c) => c.id === activeId) ?? null : null
  function skillFor(key: string, conv: Conversation | null): string | null {
    const raw = key in skillByConv ? (skillByConv[key] ?? null) : (conv?.activeSkillId ?? null)
    if (!raw) return null
    return enabledSkills.some((s) => s.installId === raw) ? raw : null
  }
  const currentSkillId = skillFor(depthKey, activeConversation)
  const currentSkill = currentSkillId
    ? enabledSkills.find((s) => s.installId === currentSkillId) ?? null
    : null

  function selectSkill(installId: string | null): void {
    if (busyStreaming) return
    setSkillByConv((prev) => ({ ...prev, [depthKey]: installId }))
    // Persist the sticky default the moment a conversation exists; a still-"new" pick is persisted
    // when the conversation is created on send (ensureConversation).
    if (activeId) void window.api.setConversationDefaultSkill?.(activeId, installId)
  }

  // Recompute the deterministic suggestion when the picker OPENS (skills plan §10.2/S8) — the offer
  // rides the picker the user already opened (no canvas chip). The draft question is scored
  // main-side and never logged; scope is resolved there from the conversation id.
  function onSkillPickerOpenChange(open: boolean): void {
    if (!open) return
    void window.api
      .suggestSkills?.(activeId ?? '', input)
      .then((s) => setSkillSuggestion(s[0] ?? null))
      .catch(() => setSkillSuggestion(null))
  }

  // ---- Tier-2 tool runs (skills plan §12.2/§15, S11b) ------------------------------------------
  // The single active run survives screen unmounts (the doc-task store precedent), polled main-side.
  const activeSkillRun = useSyncExternalStore(subscribeSkillRun, getActiveSkillRun)
  // Wired, runnable tools for the active skill in THIS conversation's scope — empty unless the skill
  // reserves Tier-2 tools AND there is an in-scope document. Main resolves the scope (§22-C4); the
  // renderer stays bank-free (it renders whatever descriptors come back).
  const [runnableTools, setRunnableTools] = useState<RunnableTool[]>([])
  useEffect(() => {
    if (!currentSkillId || !activeId || !window.api.listRunnableTools) {
      setRunnableTools([])
      return
    }
    let live = true
    void window.api
      .listRunnableTools(currentSkillId, activeId)
      .then((tools) => {
        if (live) setRunnableTools(tools)
      })
      .catch(() => {
        if (live) setRunnableTools([])
      })
    return () => {
      live = false
    }
  }, [currentSkillId, activeId, messages.length])

  // Start a tool run from the calm transcript affordance (DS4 — a USER action, never the model).
  function onRunTool(toolName: string, confirmed: boolean): void {
    if (!currentSkillId || !activeId) return
    setError(null)
    void startSkillRun({ skillInstallId: currentSkillId, toolName, conversationId: activeId, confirmed })
      .then((outcome) => {
        // `needsConfirmation` is handled inside SkillRunBar (it raises the modal before calling with
        // confirmed:true); reaching it here would mean a write tool slipped the modal — surface it.
        if (!outcome.started && 'error' in outcome) setError(outcome.error)
      })
      .catch((e) => setError(friendlyIpcError(e)))
  }

  async function stream(
    convId: string,
    content: string,
    regenerate: boolean,
    depth: ChatDepthMode,
    skillInstallId: string | null
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
        await window.api.askDocuments(convId, content, skillInstallId ?? undefined)
      } else {
        await window.api.sendChatMessage(convId, content, {
          mode: depth,
          // Include the skill only when one is set, so a no-skill turn keeps its plain options
          // shape; a cleared skill is already persisted as the conversation's null sticky default.
          ...(skillInstallId ? { skillInstallId } : {}),
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
    if (!text || busyStreaming) return
    setInput('')
    try {
      // The 'new'-composer depth selection sticks to the conversation that gets created.
      const depth = depthFor(depthKey)
      // Capture the turn's skill BEFORE ensureConversation re-keys the 'new' selection (the closure
      // value is stable; the picker's effective resolution already dropped any disabled skill).
      const turnSkill = currentSkillId
      const convId = await ensureConversation()
      setDepths((prev) => ({ ...prev, [convId]: depth }))
      setMessages((prev) => [...prev, optimisticUser(convId, text)])
      await stream(convId, text, false, depth, turnSkill)
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  async function onTryAgain(): Promise<void> {
    if (!activeId || busyStreaming || mode === 'documents') return
    // Drop the LAST message from the view only if it is an assistant turn — mirroring
    // the backend: after a failed generation the conversation ends in a user turn,
    // and regenerate must not touch the answer to an earlier question.
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      return last && last.role === 'assistant' ? prev.slice(0, -1) : prev
    })
    await stream(activeId, '', true, depthFor(activeId), skillFor(activeId, activeConversation))
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
    // Copy via MAIN (preload → clipboard:write), not navigator.clipboard — the latter needs
    // a secure context + focused document and is unreliable in the file://-loaded renderer.
    void window.api?.copyToClipboard(content).then((ok) => {
      if (ok) showToast(t('chat.copied'))
    })
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
    if (busyStreaming) return
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
    if (busyStreaming) return
    setMode(next)
    const active = conversations.find((c) => c.id === activeId)
    if (active && active.mode !== next) {
      setActiveId(null)
      setMessages([])
    }
  }

  const canTryAgain = !busyStreaming && mode === 'chat' && messages.some((m) => m.role === 'assistant')
  const indexedDocCount = docs.filter((d) => d.status === 'indexed').length

  const activeConv = activeId ? conversations.find((c) => c.id === activeId) : undefined

  // The composite source scope shown in the picker (plan §13.2/D1). From the active
  // conversation's stored scope, falling back to its legacy fields, else the Library
  // default; a dangling/archived anchor falls back to Library with a quiet notice (§13.4).
  const library = collections.find((c) => c.type === 'library') ?? null
  const danglingProject =
    activeConv?.scope == null &&
    activeConv?.collectionId != null &&
    !(activeConv.scopeDocumentIds && activeConv.scopeDocumentIds.length > 0) &&
    !collections.some((c) => c.id === activeConv.collectionId && c.archivedAt == null)
  const pickerScope: DocumentScope =
    mode !== 'documents'
      ? { collectionIds: [], documentIds: [] }
      : deriveScope(activeConv, pendingScope, library, danglingProject)

  // Scope changes from the picker. An existing conversation persists the change; with no
  // conversation yet, the pending handoff updates. An empty scope = the whole corpus.
  async function onChangeScope(next: DocumentScope): Promise<void> {
    if (activeId) {
      try {
        await window.api.setConversationScope(activeId, next)
        await refreshConversations()
      } catch (e) {
        setError(friendlyIpcError(e))
      }
    } else {
      setPendingScope(next)
    }
  }

  // ---- Chat attach / drag-drop intake (plan §11.2 H1 / §13.5 H2) ---------------------
  // Net-new ingestion entry point: dropped/picked files become Temporary docs linked to
  // this conversation (`conversation_documents`), answerable here by default — never added
  // to Library unless the user later Keeps them.

  // Poll the import job; when a file indexes its link row is written (main-side, FK-guarded),
  // so a refreshed `listAttachments` reveals it as a live "Files in this chat" entry. A
  // failed file surfaces the friendly per-file error and writes no link (N4).
  function watchAttachJob(jobId: string, convId: string, documentIds: string[], fileNames: string[]): void {
    if (attachPollRef.current) clearInterval(attachPollRef.current)
    attachPollRef.current = setInterval(async () => {
      try {
        const job = await window.api.getImportJob(jobId)
        if (activeIdRef.current === convId) await refreshAttachments(convId)
        if (!job.done) return
        if (attachPollRef.current) clearInterval(attachPollRef.current)
        attachPollRef.current = null
        setPendingImport(null)
        const fresh = (await window.api.listDocuments().catch(() => [])) ?? []
        setDocs(fresh)
        if (activeIdRef.current === convId) await refreshAttachments(convId)
        // Per-file failure: show the friendly error (canonical English → display map).
        if (job.failed > 0) {
          const failed = fresh.find((d) => documentIds.includes(d.id) && d.status === 'failed')
          if (failed) {
            setError(
              failed.errorMessage
                ? localizeServerCopy(t, failed.errorMessage)
                : t('chat.attach.failed', { name: failed.title })
            )
          }
        } else {
          // UX-3: audibly confirm the attachment for the keyboard/picker path.
          setAttachStatus(t('chat.attach.added', { name: fileNames.join(', ') }))
        }
      } catch {
        if (attachPollRef.current) clearInterval(attachPollRef.current)
        attachPollRef.current = null
        setPendingImport(null)
      }
    }, 400)
  }

  // Attach files to a chat. Routing (§13.5): a documents chat takes them directly; an
  // in-progress PLAIN chat is never mutated — a new documents conversation is created and
  // committed BEFORE the import references its id (N3 ordering), then focused with a toast;
  // an empty chat switches in place to a documents conversation (nothing to lose).
  async function attachFiles(paths: string[]): Promise<void> {
    if (paths.length === 0 || busyStreaming) return
    setError(null)
    const fileNames = paths.map(fileBaseName)
    const active = activeId ? conversations.find((c) => c.id === activeId) : undefined
    try {
      let convId: string
      if (active && active.mode === 'documents') {
        convId = active.id
      } else if (active && active.mode === 'chat' && messages.length > 0) {
        const conv = await window.api.createConversation({ mode: 'documents' })
        convId = conv.id
        setMode('documents')
        setActiveId(conv.id)
        setMessages([])
        await refreshConversations()
        showToast(t('chat.attach.newDocChat', { name: fileNames[0] }))
      } else {
        // Empty (no conversation, or an empty plain chat): switch in place to documents.
        const conv = await window.api.createConversation({ mode: 'documents' })
        convId = conv.id
        setMode('documents')
        setActiveId(conv.id)
        setMessages([])
        await refreshConversations()
      }
      const job = await window.api.importDocuments(paths, {
        destination: { kind: 'conversation', conversationId: convId }
      })
      setPendingImport({ jobId: job.jobId, convId, documentIds: job.documentIds, fileNames })
      setAttachStatus(t('chat.attach.processing', { name: fileNames.join(', ') }))
      watchAttachJob(job.jobId, convId, job.documentIds, fileNames)
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  // Keyboard-reachable picker fallback for the drag/drop target.
  async function onPickAttach(): Promise<void> {
    if (busyStreaming) return
    try {
      const paths = await window.api.pickDocuments('files')
      if (paths.length > 0) await attachFiles(paths)
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    setDragOver(false)
    if (busyStreaming) return
    const paths = pathsFromDrop(e)
    if (paths.length > 0) void attachFiles(paths)
  }

  function onDragOver(e: DragEvent): void {
    // preventDefault marks this a valid drop target; the copy cursor reads "add", not "move".
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (!busyStreaming) setDragOver(true)
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
                <Spinner />{' '}
                {modelStarting ? t('chat.noModel.starting') : t('chat.noModel.stillLoading')}
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
            {(mode === 'documents' ? DOC_EXAMPLE_KEYS : CHAT_EXAMPLE_KEYS).map((key) => (
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
          streaming={busyStreaming}
          mode={mode}
          collections={collections}
          onSelect={onSelectConversation}
          onNew={() => void onNewChat()}
          onDelete={(c) => void onDeleteConversation(c)}
          onCollapse={collapseList}
        />
      )}

      <section
        className="chat-main"
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="chat-drop-overlay" aria-hidden="true">
            {t('chat.attach.drop')}
          </div>
        )}
        {/* UX-3: visually-hidden polite live region for attach processing/added (the visible
            pending chip lives in a closed popover, inaudible to keyboard/SR users). */}
        <div className="sr-only" role="status" aria-live="polite">
          {attachStatus}
        </div>
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
            disabled={busyStreaming}
          />
          <div className="chat-header-spacer" />
          {/* The ambient privacy signal now lives once, app-wide, at the foot of the nav
              rail (§12.1 #2) — no per-screen instance here. */}
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
                  disabled={!activeId || messages.length === 0 || busyStreaming}
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
          streamingHere={busyStreaming && streamConvId === activeId}
          streamText={streamText}
          streamThinking={streamThinking}
          thinkingOpen={thinkingOpen}
          onThinkingOpenChange={setThinkingOpen}
          emptyState={emptyState}
          onTryAgain={canTryAgain ? () => void onTryAgain() : undefined}
          onCopy={onCopyMessage}
          onSave={() => void onSaveConversation()}
          actionsDisabled={busyStreaming}
          resolveSkillTitle={resolveGlyphSkillTitle}
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

        {/* Tier-2 tool run (skills plan §12.2/§15, S11b): a calm offer / busy row / result, all
            content-free. Hidden entirely when no run is active and no tool is offered. */}
        <SkillRunBar
          run={activeSkillRun}
          runnableTools={runnableTools}
          onRun={onRunTool}
          onCancel={() => void cancelActiveSkillRun()}
          onDismiss={acknowledgeSkillRun}
          disabled={busyStreaming}
        />

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void onSend()}
          onStop={onStop}
          streaming={busyStreaming}
          placeholder={mode === 'documents' ? t('chat.placeholder.documents') : t('chat.placeholder.chat')}
          sendLabel={mode === 'documents' ? t('chat.send.ask') : t('chat.send.send')}
          inputRef={composerRef}
          dictationAvailable={dictationAvailable}
          onDictationError={setError}
          onAttach={() => void onPickAttach()}
          footer={
            <>
              {mode === 'documents' ? (
                <span className="scope-footer-wrap">
                  {danglingProject && (
                    <span className="scope-dangling hint">{t('chat.scope.archivedFallback')}</span>
                  )}
                  <ScopePopover
                    docs={docs}
                    collections={collections}
                    scope={pickerScope}
                    disabled={busyStreaming}
                    onChangeScope={(next) => void onChangeScope(next)}
                    onAddDocuments={() => onNavigate('documents')}
                    attachments={attachments}
                    pendingAttachmentNames={
                      pendingImport && pendingImport.convId === activeId ? pendingImport.fileNames : []
                    }
                  />
                </span>
              ) : (
                <DepthMenu
                  value={currentDepth}
                  onChange={selectDepth}
                  supportsThinking={supportsThinking}
                  disabled={busyStreaming}
                />
              )}
              {/* Skills shape BOTH plain-chat and document answers (audit A1), so the picker
                  rides the footer in both modes. Hidden entirely when no skills are enabled. */}
              {enabledSkills.length > 0 && (
                <SkillPicker
                  skills={enabledSkills}
                  value={currentSkillId}
                  onChange={selectSkill}
                  disabled={busyStreaming}
                  suggestion={skillSuggestion}
                  onOpenChange={onSkillPickerOpenChange}
                />
              )}
            </>
          }
        />
      </section>
    </div>
  )
}

/**
 * The composite scope to show in the picker for a documents conversation (plan §13.2/§13.4).
 * Precedence: the stored composite `scope` ⇒ legacy `scopeDocumentIds` ⇒ a non-archived
 * `collectionId` anchor ⇒ the Library default. A dangling/archived anchor falls back to
 * Library (the quiet notice is rendered separately).
 */
function deriveScope(
  conv: Conversation | undefined,
  pending: DocumentScope | null,
  library: Collection | null,
  dangling: boolean
): DocumentScope {
  const libraryDefault: DocumentScope = {
    collectionIds: library ? [library.id] : [],
    documentIds: []
  }
  if (!conv) return pending ?? libraryDefault
  if (conv.scope) return conv.scope
  if (conv.scopeDocumentIds && conv.scopeDocumentIds.length > 0) {
    return { collectionIds: [], documentIds: conv.scopeDocumentIds }
  }
  if (conv.collectionId && !dangling) return { collectionIds: [conv.collectionId], documentIds: [] }
  return libraryDefault
}

/** Basename of an absolute path for a friendly chip label (cross-platform separators). */
function fileBaseName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/**
 * Absolute paths of dropped files. Electron exposes `File.path` on a native drag/drop; the
 * main process re-validates every path (existence + supported extension) downstream, so a
 * spoofed entry simply fails to import. Files without a path (a browser drag) are skipped.
 */
function pathsFromDrop(e: DragEvent): string[] {
  const files = e.dataTransfer?.files
  if (!files) return []
  const out: string[] = []
  for (let i = 0; i < files.length; i++) {
    const p = (files[i] as unknown as { path?: string }).path
    if (typeof p === 'string' && p.length > 0) out.push(p)
  }
  return out
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
