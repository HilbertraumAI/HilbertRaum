import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  DOC_TASK_BUSY_MESSAGE,
  type ChatDepthMode,
  type Collection,
  type ContextUsage,
  type Conversation,
  type ConversationSummaryMarker,
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
  adoptSkillRuns,
  cancelSkillRun,
  getReattachConversationId,
  getSkillRunsSnapshot,
  hasRunningRunElsewhere,
  pickConversationRun,
  startSkillRun,
  subscribeSkillRuns
} from '../lib/skillruns'
import { localizeServerCopy } from '../lib/displayMap'
import { skillTitleResolver } from '../lib/skillI18n'
import { friendlyIpcError } from '../lib/errors'
import { RUNTIME_POLL_MS, STREAM_RECOVER_POLL_MS } from '../lib/polling'
import { useEventCallback } from '../lib/useEventCallback'
import { useT } from '../i18n'
import { Button, Chip, EmptyState, ErrorBanner, SegmentedControl, Spinner, useToast } from '../components'
import { Composer, ContextMeter, ConversationList, DepthMenu, ScopeNarrowDialog, ScopePopover, SkillPicker, SkillRunBar, Transcript, type SkillRunTarget } from '../chat'
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

/**
 * Rough renderer-side token estimate for the LIVE context meter while a turn streams. Mirrors the
 * main-process chat budget (word count × the ~1.95 English/German subword-safety rate + per-message
 * chrome, chat.ts `messageTokens`) closely enough for a climbing bar; the exact resting value is
 * reconciled from the main process (`getConversationContextUsage`) when the turn settles, so this
 * only has to be approximately right, never authoritative.
 */
const LIVE_TOKENS_PER_WORD = 1.95
function estimateLiveTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  if (words === 0) return 0
  return Math.ceil(words * LIVE_TOKENS_PER_WORD) + 8
}

/** localStorage key for the conversation-list collapse (a UI preference, not user data). */
export const LIST_COLLAPSED_KEY = 'hilbertraum.chat.listCollapsed'

/** Below this viewport width the history column auto-collapses (responsive; the
 *  persisted desktop preference is untouched — widening restores the user's choice). */
export const LIST_AUTO_COLLAPSE_PX = 1150

/** Streamed tokens are batched and flushed on this cadence instead of per-token.
 *  Exported so the FE-1 unmount test can identify (and assert teardown of) the flush timer. */
export const STREAM_FLUSH_MS = 40

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

/**
 * Tool runs whose finished result is surfaced as a REAL chat answer — a question routed into the
 * transcript that the 0-model-call bank analysis handler answers from the persisted rows — rather than
 * a bare run-bar count. `categorize` → the per-category breakdown; `summarize_cashflow` → the in/out/net
 * cash-flow totals. The figures are computed main-side (the content-free run state carries no figures),
 * so routing is the only way these buttons can produce their actual output. Keyed by tool name → the
 * localized question key; a tool absent here keeps the plain run-bar result row.
 */
const ROUTED_RUN_QUESTION: Partial<Record<string, MessageKey>> = {
  categorize_transactions: 'chat.skill.categorize.breakdownQuestion',
  summarize_cashflow: 'chat.skill.summarize.question'
}

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
  /** The live ephemeral "working on it" notice above the streaming bubble, or null when none
   *  (context-compaction §5.2). `'compaction'` = summarizing earlier messages; `'analysis'` (U5,
   *  audit §3.6) = an exhaustive skill handler reading the whole document before its one-blob answer.
   *  Set on the STREAM.compaction notice (by its `kind`), cleared on the first answer token + in the
   *  stream's finally. Never persisted, lost on remount (R14). */
  const [progressNotice, setProgressNotice] = useState<'compaction' | 'analysis' | null>(null)
  /** Resting context-window usage for the composer meter (§5.1); null hides it. Refreshed on
   *  conversation switch + after each completed turn. During a turn the meter climbs LIVE via
   *  `liveUsage` (base + the in-flight user turn + the streaming answer estimate), then reconciles to
   *  this authoritative resting read when the turn settles. */
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  /** Estimated tokens of the in-flight user turn, added to the live meter until the turn settles. */
  const [liveUserTokens, setLiveUserTokens] = useState(0)
  /** The REAL assembled-prompt usage of the in-flight turn (STREAM.usage, fired post-assembly).
   *  A document answer injects the retrieved excerpt/whole-document block into its prompt —
   *  content that never persists, so the resting read + word estimate under-count it by the whole
   *  document ("meter says 7% while the window is full"). When present it REPLACES the estimate
   *  base while streaming; cleared when the turn settles (the excerpt block is per-turn, so the
   *  meter honestly drops back to the resting read). */
  const [streamUsage, setStreamUsage] = useState<ContextUsage | null>(null)
  /** The latest compaction summary + its transcript marker position (§5.3, D-b); null hides it. */
  const [summaryMarker, setSummaryMarker] = useState<ConversationSummaryMarker | null>(null)
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
  /** U3 (audit §4.3): per-conversation "keep this pick as the default" intent, OPTIMISTIC over the
   *  persisted `activeSkillId`. A pick now applies per-turn by DEFAULT; only an explicit opt-in here
   *  (or a pre-existing sticky default) persists it. A key absent ⇒ derive from the stored default. */
  const [keepByConv, setKeepByConv] = useState<Record<string, boolean>>({})
  /** The deterministic one-tap suggestion for the picker (skills plan §10.2/S8), or null. Now
   *  recomputed proactively as the draft changes (U-3) so it can ride the CLOSED trigger too. */
  const [skillSuggestion, setSkillSuggestion] = useState<SkillSuggestion | null>(null)
  /** U-3: the user explicitly declined the suggestion for this draft (picked "None"). Suppresses the
   *  CLOSED-trigger hint so it never re-nags; reset when the turn is sent or the conversation changes.
   *  A renderer-only flag — `currentSkillId === null` alone can't tell an explicit "None" from a
   *  never-set default, and nothing about a declined offer crosses the IPC (it is purely UI state). */
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)
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
  // D71 (#26): the one-time narrow/widen choice offered when a file is attached to an EXISTING
  // whole-library documents chat. `scopeChoice` drives the dialog; the asked-set makes the choice
  // sticky per conversation — a "Whole library" answer keeps the default but must not re-prompt on
  // the next attach (a "Just this file" answer narrows the scope, so it self-heals against re-asking).
  const [scopeChoice, setScopeChoice] = useState<{ convId: string; fileName: string } | null>(null)
  const scopeChoiceAskedRef = useRef<Set<string>>(new Set())
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
  // M-U2: set when the user presses Stop during a stream, so the stream's finally can
  // confirm the interruption (a stopped partial reply otherwise looks like a normal turn).
  const stopped = useRef(false)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // FE-1 (mirrors DocumentsScreen/DiagnosticsTab FE-4): the attach-import poll's late
  // getImportJob tick and the streamed-token flush both resolve AFTER the user can navigate
  // away (mid-import / mid-generation). The main-side stream is intentionally left running
  // and recovered on remount (getActiveStream, below) — so we do NOT cancel it; we only flip
  // this flag and gate every async setState that would otherwise land on a dead component.
  const mountedRef = useRef(true)

  const flushStream = useCallback((): void => {
    // FE-1: a late token can re-arm this timer after unmount (the onToken subscription stays
    // live until the stream's finally); drop the flush rather than setState on a dead screen.
    if (!mountedRef.current) return
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

  // Context-window meter + transcript summary marker (context-compaction §5.1/§5.3). Both are
  // resting-state reads, refreshed on conversation switch and after each completed turn (live is
  // not required). Best-effort: a failed read (or an older preload missing the channel) just hides
  // the affordance. `getConversationContextUsage`/`getConversationSummary` may be absent on an old
  // bridge — the optional-call guard + a null result both fall through to "hidden".
  const refreshContextInfo = useCallback(async (convId: string | null): Promise<void> => {
    if (!convId) {
      setContextUsage(null)
      setSummaryMarker(null)
      return
    }
    try {
      const usage = (await window.api.getConversationContextUsage?.(convId)) ?? null
      setContextUsage(usage)
    } catch {
      setContextUsage(null)
    }
    try {
      const marker = (await window.api.getConversationSummary?.(convId)) ?? null
      setSummaryMarker(marker)
    } catch {
      setSummaryMarker(null)
    }
  }, [])

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
    void refreshContextInfo(activeId)
  }, [activeId, refreshContextInfo])

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

  // Stop the attachment-import poll on unmount, flip the mounted flag the async poll/flush
  // guards read (FE-1), and clear any pending stream-flush timer so no buffered flush fires
  // after teardown. The main-side stream is intentionally NOT torn down here — an in-flight
  // generation is recovered on remount via getActiveStream (the recovery effect below).
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (attachPollRef.current) clearInterval(attachPollRef.current)
      if (flushTimer.current != null) clearTimeout(flushTimer.current)
      flushTimer.current = null
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
            // A recovered turn may have cut a fresh checkpoint / changed fullness — refresh both.
            void refreshContextInfo(activeId)
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
  }, [activeId, streaming, refreshContextInfo])

  // On a FRESH mount (the user navigated away mid-reply and came back), the Chat screen has
  // forgotten which conversation it was streaming — `activeId` resets to null, so the recovery
  // effect above bails and an empty new chat shows while the answer streams invisibly (and, since
  // the one-stream guard is per-conversation, a new empty conversation would even accept another
  // turn). If a generation is still in flight, re-select that conversation so the recovery effect
  // re-attaches to the live reply. Runs once on mount; the `activeIdRef` guards make it a no-op if
  // the user has already hand-picked a conversation, and it never yanks the user onto an old chat
  // when nothing is generating.
  useEffect(() => {
    if (!window.api.listActiveStreamConversations) return // older preload / test stub
    let cancelled = false
    void (async () => {
      if (activeIdRef.current != null) return
      let ids: string[] = []
      try {
        ids = (await window.api.listActiveStreamConversations!()) ?? []
      } catch {
        ids = []
      }
      if (cancelled || activeIdRef.current != null || ids.length === 0) return
      const streamingId = ids[ids.length - 1] // insertion order → the most recently started stream
      let convs: Conversation[] = []
      try {
        convs = await window.api.listConversations()
      } catch {
        convs = []
      }
      if (cancelled || activeIdRef.current != null) return
      if (convs.length > 0) setConversations(convs)
      setActiveId(streamingId)
      const conv = convs.find((c) => c.id === streamingId)
      if (conv) setMode(conv.mode) // mirror the conversation's mode (chat vs documents), like onSelectConversation
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // On a FRESH mount, re-attach to the conversation that owns an in-flight SKILL RUN (e.g. a
  // "categorize transactions" doctask). Its spinner survives the unmount (the module-level skillruns
  // store), but `activeId` reset to null — so without this the user who navigated away mid-run and came
  // back would land on a NEW empty chat while the badge still spins, unable to get back to the running
  // document chat. Parallels the stream-recovery re-select above, but for skill runs (a categorizing
  // doctask is NOT a llama stream, so `listActiveStreamConversations` never sees it). Runs once; the
  // `activeIdRef` guards make it a no-op once the user hand-picks a conversation, and it never fires
  // when nothing is running (the conversation id is renderer-owned — the one passed to `startSkillRun`).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // SKA-17: a reload destroyed the renderer's per-run store but main kept the runs — re-adopt them
      // FIRST (their bars/outcomes come back) so `getReattachConversationId` below can see a run to
      // land on. `adoptSkillRuns` is idempotent (it skips already-tracked handles), so re-running it
      // on a later mount is a no-op.
      await adoptSkillRuns()
      if (cancelled || activeIdRef.current != null) return
      const runConvId = getReattachConversationId()
      if (!runConvId) return
      let convs: Conversation[] = []
      try {
        convs = await window.api.listConversations()
      } catch {
        convs = []
      }
      if (cancelled || activeIdRef.current != null) return
      if (convs.length > 0) setConversations(convs)
      setActiveId(runConvId)
      const conv = convs.find((c) => c.id === runConvId)
      if (conv) setMode(conv.mode) // mirror the conversation's mode, like onSelectConversation
    })()
    return () => {
      cancelled = true
    }
  }, [])

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

  // Create the documents conversation an attachment needs, carrying any pending composite scope
  // the user set on the 'new' composer (e.g. Library unchecked to ask ONLY the attached file).
  // Without this the attach flow silently resets to the Library default — the user's narrowing is
  // lost and a single-doc skill (whole-doc engine) never fires. The handoff clears (the new
  // conversation owns its scope), exactly like `createConversationInMode`. A single-project pending
  // scope also becomes the creation anchor (plan §13.3/§13.4).
  async function createDocsConversationForAttach(): Promise<Conversation> {
    // D71 (#26): a chat born from an attachment defaults to a DOCS-ONLY scope so the question is
    // answered from just the attached file(s), not the whole Library. When the user set no explicit
    // scope on the 'new' composer, persist an EMPTY EXPLICIT scope: `resolveScope` reads that as "no
    // collections" and unions the chat attachments in, narrowing to exactly them — while keeping
    // `hasExplicitDocSelection` false, so an attachment never masquerades as a hand-pick (N2). (A NULL
    // scope, the old default, would fall through to the Library — the #26 friction.) An explicit
    // `pendingScope` — e.g. the user re-checked Library to ask the whole corpus — is honored as-is.
    const scope: DocumentScope = pendingScope ?? { collectionIds: [], documentIds: [] }
    const collectionId =
      scope.collectionIds.length === 1 && scope.documentIds.length === 0
        ? scope.collectionIds[0]
        : undefined
    const conv = await window.api.createConversation({ mode: 'documents', scope, collectionId })
    setPendingScope(null)
    return conv
  }

  async function ensureConversation(): Promise<string> {
    if (activeId) return activeId
    const conv = await createConversationInMode()
    // Carry a skill picked while still on the 'new' composer onto the created conversation, and re-key
    // the session override to the new id. U3 (audit §4.3): per-turn by default — persist the sticky
    // default ONLY when the user opted in via "keep for this conversation" (`keepByConv['new']`).
    if ('new' in skillByConv) {
      const picked = skillByConv['new'] ?? null
      if (picked && keepByConv['new']) void window.api.setConversationDefaultSkill?.(conv.id, picked)
      // SKA-18: re-key the 'new'-composer pick onto the created conversation AND DELETE the 'new' keys.
      // Leaving them behind resurrects the pick on any later empty composer (a mode toggle, a
      // conversation delete), so the NEXT send would persist a keep opt-in made for conversation 1 as
      // conversation 2's sticky default. "New chat" starts clean — the re-key must too.
      setSkillByConv((prev) => {
        const next = { ...prev, [conv.id]: picked }
        delete next['new']
        return next
      })
      if ('new' in keepByConv) {
        setKeepByConv((prev) => {
          const next = { ...prev, [conv.id]: keepByConv['new']! }
          delete next['new']
          return next
        })
      }
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

  // Live context-usage for the meter (§5.1): while THIS conversation streams, add the in-flight user
  // turn + a running estimate of the streaming answer on top of the resting read, so the bar climbs
  // as the answer grows (and warns before it overflows). Off-stream it is just the resting value; on
  // completion the resting read is reconciled from the main process (the `finally` above).
  const liveUsage = useMemo<ContextUsage | null>(() => {
    const streamingHere = busyStreaming && streamConvId === activeId
    // The main process reported the REAL assembled prompt (incl. a document turn's injected
    // excerpt block): it already contains the user turn + fence + history, so only the streaming
    // answer estimate rides on top — never `liveUserTokens` (that would double-count the question).
    if (streamingHere && streamUsage) {
      return {
        usedTokens: streamUsage.usedTokens + estimateLiveTokens(streamText),
        window: streamUsage.window
      }
    }
    if (!contextUsage) return null
    if (!streamingHere) return contextUsage
    const extra = liveUserTokens + estimateLiveTokens(streamText)
    return { ...contextUsage, usedTokens: contextUsage.usedTokens + extra }
  }, [contextUsage, busyStreaming, streamConvId, activeId, liveUserTokens, streamText, streamUsage])

  function selectDepth(d: ChatDepthMode): void {
    if (busyStreaming) return
    setDepths((prev) => ({ ...prev, [depthKey]: d }))
  }

  // Per-message glyph title resolver (installId → localized title), rebuilt only when the loaded
  // skills or the UI language change. Display-only localization (architecture.md "Skills" §16).
  const resolveGlyphSkillTitle = useMemo(() => skillTitleResolver(allSkills, lang), [allSkills, lang])

  // Stable handler identities for the memoized Transcript / ConversationList children (perf audit
  // FE-3): the latest-ref wrappers keep each handler's identity constant across keystroke +
  // streaming-flush re-renders (so the memoized children skip them) while still calling the current
  // closure. The impl functions below are hoisted declarations, so referencing them here is fine.
  const handleCopyMessage = useEventCallback(onCopyMessage)
  const handleSaveConversation = useEventCallback(onSaveConversation)
  const handleExportMessageTable = useEventCallback(onExportMessageTable)
  const handleTryAgain = useEventCallback(onTryAgain)
  const handleAnswerWithoutSkill = useEventCallback(onAnswerWithoutSkill)
  const handleSelectConversation = useEventCallback(onSelectConversation)
  const handleNewChat = useEventCallback(onNewChat)
  const handleDeleteConversation = useEventCallback(onDeleteConversation)
  const handleCollapseList = useEventCallback(collapseList)
  const fillComposerStable = useEventCallback(fillComposer)

  // Teaching empty state (guidelines §3): a friendly line, example prompts that fill the composer,
  // and — when nothing is imported yet — a nudge toward Documents. Memoized so it is a STABLE prop
  // for the memoized Transcript (FE-3): it depends only on the mode + whether anything is indexed,
  // never on `input`, so a keystroke doesn't rebuild it (which would re-render the transcript).
  const emptyState = useMemo(
    () => (
      <div className="chat-empty">
        <EmptyState
          title={t('chat.empty.title')}
          line={mode === 'documents' ? t('chat.empty.lineDocuments') : t('chat.empty.lineChat')}
          action={
            <>
              {(mode === 'documents' ? DOC_EXAMPLE_KEYS : CHAT_EXAMPLE_KEYS).map((key) => (
                <Chip key={key} onClick={() => fillComposerStable(t(key))} title={t('chat.empty.fillTitle')}>
                  {t(key)}
                </Chip>
              ))}
              {docs.filter((d) => d.status === 'indexed').length === 0 && (
                <Button size="sm" onClick={() => onNavigate('documents')}>
                  {t('chat.empty.addDocs')}
                </Button>
              )}
            </>
          }
        />
      </div>
    ),
    [mode, t, docs, onNavigate, fillComposerStable]
  )

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
  // U3 (audit §4.3): whether the active pick is SAVED as this conversation's default (survives
  // reload) — drives the picker's "keep for this conversation" checkbox. The optimistic `keepByConv`
  // wins; absent, derive from the persisted `activeSkillId`. A pre-existing sticky default reads as
  // kept (it is), so legacy defaults keep working and show checked.
  const keptForConversation =
    currentSkillId != null &&
    (depthKey in keepByConv ? keepByConv[depthKey] : activeConversation?.activeSkillId === currentSkillId)

  // The skill ARGUMENT to send to main for this turn (audit §4.3): the session pick VERBATIM when the
  // user made one this session (id, or an explicit `null` = "no skill, no auto-fire"), else `undefined`
  // so main resolves the saved default and MAY auto-fire. This is what makes a pick per-turn: the
  // session pick is authoritative and never silently re-derives the saved default, while an untouched
  // composer still honours a persisted default. A picked-then-disabled skill degrades to `null`
  // (no skill this turn), mirroring `skillFor`'s graceful drop.
  function turnSkillArgFor(key: string): string | null | undefined {
    if (!(key in skillByConv)) return undefined
    const raw = skillByConv[key] ?? null
    if (!raw) return null
    return enabledSkills.some((s) => s.installId === raw) ? raw : null
  }

  function selectSkill(installId: string | null): void {
    if (busyStreaming) return
    // Per-turn apply (audit §4.3): a pick sets the SESSION override only — it is NEVER written to the
    // persisted sticky default (that is the explicit "keep for this conversation" opt-in below).
    setSkillByConv((prev) => ({ ...prev, [depthKey]: installId }))
    // A fresh pick is unkept — the keep-checkbox reads unchecked.
    setKeepByConv((prev) => ({ ...prev, [depthKey]: false }))
    // …and CLEAR any saved sticky default too: a pick that supersedes a legacy default (including an
    // explicit "None", where the chip's × is hidden so it can't clear it) must not leave that default
    // lurking to (a) resurface on reload against the user's visible session choice, or (b) contradict
    // the now-unchecked keep-checkbox (a re-pick of the saved skill would otherwise read "not kept"
    // while still stored). The store write is unconditional (activeConversation may hold a stale
    // activeSkillId), so `keep` stays the SINGLE writer of the persisted default. 'new' has no row yet.
    if (activeId) void window.api.setConversationDefaultSkill?.(activeId, null)
    // U-3: an explicit "None" pick DECLINES the current suggestion — remember it so the quiet
    // closed-trigger hint does not re-nag for this draft. Any real pick clears the flag (the hint
    // is gated on "no skill picked" anyway, but this keeps the next "None" an honest fresh decline).
    setSuggestionDismissed(installId == null)
  }

  // U3 (audit §4.3): the composer chip's × — clear the active skill for this conversation. Identical to
  // picking "None": `selectSkill(null)` drops the session override, clears any saved default, and
  // dismisses the suggestion. Kept as a named handler so the × call site reads intent-first.
  function clearSkill(): void {
    selectSkill(null)
  }

  // U3 (audit §4.3): the explicit opt-in — save (or stop saving) the current pick as this
  // conversation's default. Keeping writes the sticky default; un-keeping stops persisting BUT pins
  // the skill as a session override so it stays active this session (only reload-persistence drops) —
  // the chip and the next turn stay consistent (both read the override, not the just-cleared default).
  function onKeepForConversation(keep: boolean): void {
    if (busyStreaming || !currentSkillId) return
    setKeepByConv((prev) => ({ ...prev, [depthKey]: keep }))
    if (keep) {
      if (activeId) void window.api.setConversationDefaultSkill?.(activeId, currentSkillId)
    } else {
      setSkillByConv((prev) => ({ ...prev, [depthKey]: currentSkillId }))
      if (activeId) void window.api.setConversationDefaultSkill?.(activeId, null)
    }
  }

  // Carry the skill the user currently sees selected onto a conversation created on the fly (the
  // attach flow), so adding a document never silently RESETS the pick. Mirrors the 'new'→id carry in
  // ensureConversation: re-key the SESSION override (the skill stays active for the turn). U3 (audit
  // §4.3): per-turn by default — persist the sticky default ONLY when the source pick was explicitly
  // kept, so an unkept pick isn't silently persisted onto the new conversation. A null pick needs no
  // carry — a brand-new conversation already defaults to none.
  function carrySkillToConversation(convId: string, skillId: string | null, keep: boolean): void {
    if (!skillId) return
    setSkillByConv((prev) => ({ ...prev, [convId]: skillId }))
    setKeepByConv((prev) => ({ ...prev, [convId]: keep }))
    if (keep) void window.api.setConversationDefaultSkill?.(convId, skillId)
  }

  // Score the current draft for the one-tap suggestion (deterministic, main-side, never logged) and
  // store the single best offer (or null). `Promise.resolve` + optional chaining keep it inert when
  // the IPC is absent or a test stub returns nothing — it never throws inside the debounce timer.
  function refreshSuggestion(convId: string, draft: string): void {
    // FE-1/F3: this resolves after a ~400 ms debounce + the main-side scoring round-trip, by which
    // time the user may have navigated away or switched conversations. Apply the result only if we
    // are still mounted AND still on the conversation it was computed for — otherwise a late reply
    // setStates a dead component or stamps a stale-conversation suggestion. (`activeIdRef` tracks
    // the live id; `convId` is '' for a still-"new" draft, matching `activeId ?? ''` at call time.)
    const applies = (): boolean => mountedRef.current && (activeIdRef.current ?? '') === convId
    void Promise.resolve(window.api.suggestSkills?.(convId, draft))
      .then((s) => {
        if (applies()) setSkillSuggestion(s?.[0] ?? null)
      })
      .catch(() => {
        if (applies()) setSkillSuggestion(null)
      })
  }

  // Recompute the deterministic suggestion when the picker OPENS (skills plan §10.2/S8) — a refresh
  // that keeps the in-picker pinned offer current. The draft question is scored main-side and never
  // logged; scope is resolved there from the conversation id.
  function onSkillPickerOpenChange(open: boolean): void {
    if (!open) return
    refreshSuggestion(activeId ?? '', input)
  }

  // U-3: recompute the suggestion PROACTIVELY as the draft changes (debounced ~400 ms, mirroring the
  // attachment-poll/stream-flush timer precedent) so a high-confidence offer can ride the CLOSED
  // trigger — a user who never opens "Skill: none ▾" still sees the nudge. Deterministic
  // `suggestSkills` IPC (no model, no network); the draft is CONTENT — scored main-side, never
  // logged. Only when no skill is already picked (an explicit pick owns the turn); cleared otherwise.
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (currentSkillId) {
      setSkillSuggestion(null)
      return
    }
    const convId = activeId ?? ''
    const draft = input
    if (suggestTimer.current != null) clearTimeout(suggestTimer.current)
    suggestTimer.current = setTimeout(() => refreshSuggestion(convId, draft), 400)
    return () => {
      if (suggestTimer.current != null) clearTimeout(suggestTimer.current)
    }
  }, [input, currentSkillId, activeId])

  // U-3: a declined offer is per-draft — reset the dismissal when the conversation changes so a fresh
  // conversation starts from a clean slate (the per-send reset rides `onSend`'s `setInput('')` →
  // recompute). Never carries a decline across conversations.
  useEffect(() => {
    setSuggestionDismissed(false)
  }, [activeId])

  // ---- Tier-2 tool runs (skills plan §12.2/§15, S11b) ------------------------------------------
  // SKA-6 (audit 2026-07-03, U6): the per-run store survives screen unmounts (the doc-task precedent),
  // polled main-side. It now holds MANY runs keyed by handle — the run bar is gated to the run whose
  // conversation is active, and a quiet chip covers runs working in OTHER chats. `skillRuns` is a
  // referentially-stable snapshot (SKA-39), so a 400 ms no-op poll doesn't re-render the screen.
  const skillRuns = useSyncExternalStore(subscribeSkillRuns, getSkillRunsSnapshot)
  // The run to show in THIS conversation's bar (null when it has none) + whether some OTHER conversation
  // has a run in flight (the "a skill is working in another chat" chip).
  const activeRunEntry = useMemo(() => pickConversationRun(skillRuns, activeId), [skillRuns, activeId])
  const activeSkillRun = activeRunEntry?.run ?? null
  const otherChatRunBusy = useMemo(() => hasRunningRunElsewhere(skillRuns, activeId), [skillRuns, activeId])
  // Wired, runnable tools for the active skill in THIS conversation's scope — empty unless the skill
  // reserves Tier-2 tools AND there is an in-scope document. Main resolves the scope (§22-C4); the
  // renderer stays bank-free (it renders whatever descriptors come back).
  const [runnableTools, setRunnableTools] = useState<RunnableTool[]>([])
  // U-1: the in-scope target document ids main resolved (ids only — content-free). The names are
  // mapped renderer-side from the loaded document list (`docs`/`attachments`), so a title never
  // enters the run state/IPC. `[0]` is the default target.
  const [scopeDocIds, setScopeDocIds] = useState<string[]>([])
  useEffect(() => {
    // Clear the PRIOR conversation's offer SYNCHRONOUSLY before the async re-resolve below lands, so a
    // run can never fire against a STALE target: `scopeDocIds` otherwise briefly held the PREVIOUS
    // conversation's document (e.g. a "…(1).pdf" left over from another chat) while `onRunTool` sends the
    // NEW conversation's id, which main then rejects as out-of-scope ("that document isn't in this chat's
    // documents"). Clearing up front means the run bar offers nothing until the new scope resolves.
    setRunnableTools([])
    setScopeDocIds([])
    if (!currentSkillId || !activeId || !window.api.listRunnableTools) return
    let live = true
    void window.api
      .listRunnableTools(currentSkillId, activeId)
      .then((res) => {
        if (!live) return
        setRunnableTools(res?.tools ?? [])
        setScopeDocIds(res?.documentIds ?? [])
      })
      .catch(() => {
        if (live) {
          setRunnableTools([])
          setScopeDocIds([])
        }
      })
    return () => {
      live = false
    }
    // FE-10 (perf audit 2026-06-18): key only on (skill, conversation). `listRunnableTools` derives
    // the tool set from the skill + the conversation's in-scope documents — NOT the message count —
    // so a new turn never changes the result (the prior `messages.length` dep just re-fired the IPC
    // after every turn for an identical answer). The new-conversation transition is covered by
    // `activeId` (null → created id).
  }, [currentSkillId, activeId])

  // U-1: resolve an in-scope target id to its DISPLAY NAME from the renderer's own loaded documents
  // (Library docs + this chat's attachments). The title is read here, renderer-side — it never comes
  // from the run state/IPC. An unknown id (not yet loaded) falls back to a generic, content-free label.
  const docNameForId = useCallback(
    (id: string): string => {
      const found = docs.find((d) => d.id === id) ?? attachments.find((d) => d.id === id)
      return found?.title ?? t('chat.skill.run.thisDocument')
    },
    [docs, attachments, t]
  )
  // The in-scope target documents offered in the run bar (id + renderer-resolved name), in main's
  // resolution order. Exactly one ⇒ the name is shown; more than one ⇒ the chooser appears.
  const targetDocuments = useMemo<SkillRunTarget[]>(
    () => scopeDocIds.map((id) => ({ id, name: docNameForId(id) })),
    [scopeDocIds, docNameForId]
  )
  // U3 (audit ux-6): the routed buttons (Categorize / Summarize cashflow) surface their real output by
  // routing a question into the transcript — a documents-mode-only relay (the routed-run effect below
  // is inert in plain chat). So HIDE them in plain-chat mode, where their answer would be unreachable;
  // the other run-bar tools (extract / validate / export) show their result inline and stay. The
  // post-extract categorize follow-up is gated the same way via `offerRoutedFollowups` on the bar.
  const routedRunsReachable = mode === 'documents'
  const visibleRunnableTools = useMemo<RunnableTool[]>(
    () => (routedRunsReachable ? runnableTools : runnableTools.filter((tool) => !ROUTED_RUN_QUESTION[tool.name])),
    [runnableTools, routedRunsReachable]
  )
  // The name of the document the ACTIVE run targets — remembered renderer-side when the run is
  // launched (the run state carries only ids/counts, never the title). Drives the busy/result row.
  const [runTargetName, setRunTargetName] = useState<string | null>(null)
  // The id of that same target, remembered alongside the name (U-2). The run state is content-free,
  // so this is how the post-extract "Categorize transactions" offer targets the SAME document the
  // extract ran on — the id rides back through `onRunTool('categorize_transactions', …, id)`.
  const [runTargetId, setRunTargetId] = useState<string | null>(null)

  // The active run's target document, resolved for the busy/result row. The AUTHORITATIVE source is the
  // active conversation's run ENTRY (`activeRunEntry.documentId`, threaded main-side per-run) — NOT the
  // single global `runTargetId`, which `onRunTool` overwrites on every launch across ALL conversations
  // and so goes STALE the moment a second run starts in another chat (it would then pin/name/scope the
  // wrong document). `runTargetId`/`runTargetName` are only a fallback for the brief window before the
  // store entry exists (and, for the name, when the document isn't in the renderer's loaded list). The
  // NAME is resolved renderer-side (never IPC).
  const resolvedRunDocId = activeRunEntry?.documentId ?? runTargetId ?? null
  const resolvedRunDocName = resolvedRunDocId ? docNameForId(resolvedRunDocId) : runTargetName
  // SKA-6: the post-extract "Categorize" offer must NOT retarget across scopes. Refuse it when the
  // remembered target is a KNOWN document that is NOT in THIS conversation's current scope (e.g. it was
  // removed, or — before conversation-gating — belonged to another chat). An unknown id (null) is safe:
  // main falls back to the first in-scope document. Never relies on main's single-doc fallback (SKA-29).
  const categorizeTargetInScope = resolvedRunDocId == null || scopeDocIds.includes(resolvedRunDocId)

  // Start a tool run from the calm transcript affordance (DS4 — a USER action, never the model). The
  // chosen `documentId` (U-1) is an in-scope id the renderer offered; main re-validates it against the
  // resolved scope. Defaults to the first in-scope document when none was chosen.
  function onRunTool(toolName: string, confirmed: boolean, documentId?: string): void {
    if (!currentSkillId || !activeId) return
    const targetId = documentId ?? scopeDocIds[0]
    // Remember the target NAME + ID for the busy/result row (resolved renderer-side; never from the
    // IPC). The id powers the U-2 post-extract categorize offer (same-document targeting).
    setRunTargetName(targetId ? docNameForId(targetId) : null)
    setRunTargetId(targetId ?? null)
    setError(null)
    // Pass the RESOLVED target id (not the raw `documentId`, which is undefined when the user relied on
    // the first-in-scope default): main still re-validates it, and it is what the run store carries so
    // the U3 routed-run relay can pin its answer to this document even after a screen remount (ux-6).
    void startSkillRun({ skillInstallId: currentSkillId, toolName, conversationId: activeId, documentId: targetId, confirmed })
      .then((outcome) => {
        // `needsConfirmation` is handled inside SkillRunBar (it raises the modal before calling with
        // confirmed:true); reaching it here would mean a write tool slipped the modal — surface it.
        if (!outcome.started && 'error' in outcome) setError(outcome.error)
      })
      .catch((e) => setError(friendlyIpcError(e)))
  }

  // (D) Routed feedback (Phase 33, Q3; extended to summarize): when a ROUTED run finishes, surface the
  // result as a real chat answer instead of a bare run-bar count. Categorize → route the per-category
  // breakdown question; summarize_cashflow → route the cash-flow-totals question — both answered by the
  // 0-model-call bank analysis handler from the persisted rows (reusing the latest statement). This is
  // what gives "Summarize cashflow" an actual output (the figures never cross the content-free run
  // state). Fires ONCE per run, documents-mode only, never while another stream is in flight.
  const handledRoutedRunRef = useRef<string | null>(null)
  useEffect(() => {
    const run = activeSkillRun
    if (!run || run.state !== 'done') return
    const questionKey = ROUTED_RUN_QUESTION[run.toolName]
    if (!questionKey) return
    if (handledRoutedRunRef.current === run.runHandle) return
    if (mode !== 'documents' || !activeId || busyStreaming) return
    // C1 — the routed answer lands ONLY in the conversation that STARTED the run. `activeSkillRun` is
    // now the per-run store's entry for THE ACTIVE conversation (SKA-6), so a run that finished in
    // another chat is simply not this effect's `run`; it surfaces when the user returns there. The
    // explicit guard stays as defense (the entry's own conversationId must equal the active id).
    const targetConv = activeRunEntry?.conversationId ?? activeId
    if (targetConv !== activeId) return
    // U3 (audit ux-6): PIN the routed answer to the document the run targeted, so a multi-document (or
    // whole-corpus) scope can't scatter it across the wrong documents — the ux-6 breakage. The
    // AUTHORITATIVE id is the run ENTRY's own `documentId` (threaded main-side, per-run, survives a
    // reload) — NOT the global `runTargetId`, which a later run in another chat overwrites (it would
    // then pin THIS conversation's answer to the wrong document). `runTargetId` is only a fallback for
    // the pre-store-entry window. Absent ⇒ the ordinary scope (a single-doc chat is unaffected).
    const pinnedDocId = activeRunEntry?.documentId ?? runTargetId ?? undefined
    handledRoutedRunRef.current = run.runHandle
    acknowledgeSkillRun(run.runHandle) // drop the content-free run row; the routed answer replaces it
    const question = t(questionKey)
    setMessages((prev) => [...prev, optimisticUser(targetConv, question)])
    // Route under the skill the RUN used (C2) — never `currentSkillId`, which is whatever the picker
    // shows now; a null/non-bank pick would bypass the 0-model-call bank analysis handler.
    void stream(targetConv, question, false, depthFor(targetConv), run.skillInstallId, pinnedDocId)
    // Keyed on the run + mode/conv/streaming-gate; the other closures are stable for this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSkillRun, mode, activeId, busyStreaming])

  async function stream(
    convId: string,
    content: string,
    regenerate: boolean,
    depth: ChatDepthMode,
    // `undefined` ⇒ main resolves the saved default (and may auto-fire); `null` ⇒ explicit no-skill,
    // no auto-fire (the per-turn "None" / the "answer without it" undo); an id ⇒ that skill (§4.3).
    skillInstallId: string | null | undefined,
    // U3 (audit ux-6): pin the document answer to ONE document (the routed-run relay passes the run's
    // target). Documents mode only; main re-validates it against scope. Absent ⇒ ordinary scope.
    pinnedDocumentId?: string
  ): Promise<void> {
    setError(null)
    setStreaming(true)
    setStreamConvId(convId)
    setStreamText('')
    setStreamThinking('')
    setThinkingOpen(false)
    setProgressNotice(null)
    // Seed the live meter with the user turn about to be sent; the streaming answer estimate is
    // added on top in `liveUsage`. A regenerate re-streams an EXISTING user turn (already counted in
    // the resting usage), so it seeds 0 to avoid double-counting the question.
    setLiveUserTokens(regenerate ? 0 : estimateLiveTokens(content))
    // A stale prior turn's real-usage report must not leak into this turn's meter.
    setStreamUsage(null)
    answerStarted.current = false
    stopped.current = false
    const unsubscribe = window.api.onToken(convId, (token) => {
      // The first answer token auto-collapses an expanded Thinking… line and clears any live
      // "working on it" notice (§5.2/U5 — the summary or extraction is done once tokens flow).
      if (!answerStarted.current) {
        answerStarted.current = true
        setThinkingOpen(false)
        setProgressNotice(null)
      }
      pendingTokens.current += token
      scheduleFlush()
    })
    // One-shot ephemeral "working on it" notice (§5.2). Its `kind` picks the copy: 'compaction'
    // (summarizing earlier messages) or 'analysis' (U5 — reading the whole document for a skill's
    // exhaustive answer). The optional-chained CALL tolerates an older bridge (no unsubscribe there).
    // Cleared on the first token (above) and in finally. Never recovered on remount (R14).
    const unsubscribeCompaction = window.api.onCompaction?.(convId, (notice) =>
      setProgressNotice(notice.kind ?? 'compaction')
    )
    // The REAL assembled-prompt usage for this turn (fired once, post-assembly): the live meter's
    // base while streaming — the only way a document turn's injected excerpt block reaches the
    // meter. Optional-chained like onCompaction (tolerates an older bridge); ephemeral (R14).
    const unsubscribeUsage = window.api.onContextUsage?.(convId, (usage) => setStreamUsage(usage))
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
      // Send the resolved skill choice VERBATIM (audit §4.3 per-turn semantics): `undefined` lets main
      // resolve the saved default (and may auto-fire), an explicit `null` forces a skill-free turn (no
      // auto-fire — the per-turn "None" pick and the S13c "answer without it" undo), an id forces that
      // skill. The caller (`onSend`/`onTryAgain`/`onAnswerWithoutSkill`/routed-run) already resolved
      // this; `stream` no longer collapses `null`→`undefined`, so an explicit decline is honoured.
      const turnSkillArg = skillInstallId
      if (mode === 'documents') {
        await window.api.askDocuments(convId, content, turnSkillArg, regenerate, pinnedDocumentId)
      } else {
        await window.api.sendChatMessage(convId, content, {
          mode: depth,
          ...(turnSkillArg !== undefined ? { skillInstallId: turnSkillArg } : {}),
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
      unsubscribeCompaction?.()
      unsubscribeUsage?.()
      clearStreamBuffers()
      setStreaming(false)
      setStreamConvId(null)
      setStreamText('')
      setStreamThinking('')
      setProgressNotice(null)
      // Drop the live delta BEFORE reconciling so the meter never double-counts the turn: the
      // authoritative resting read below already includes the persisted user turn + reply.
      setLiveUserTokens(0)
      // The per-turn excerpt block is gone with the turn — drop the real-usage base so the meter
      // reconciles to the resting read (what actually persists across turns).
      setStreamUsage(null)
      // The turn may have cut a fresh checkpoint and changed fullness — reconcile the meter + marker
      // to the persisted truth (runs on success AND error, so a partial/stopped reply settles too).
      if (activeIdRef.current === convId) void refreshContextInfo(convId)
      // M-U2: confirm a user-requested stop so a truncated reply is not mistaken for a
      // complete one. Only when looking at THIS conversation (a background stream's toast
      // would be confusing) and only if no error already explained the early end.
      if (stopped.current && activeIdRef.current === convId) showToast(t('chat.stopped'))
      stopped.current = false
    }
  }

  async function onSend(): Promise<void> {
    const text = input.trim()
    if (!text || busyStreaming) return
    setInput('')
    // U-3: a fresh turn deserves a fresh suggestion — a decline was scoped to the just-sent draft.
    setSuggestionDismissed(false)
    try {
      // The 'new'-composer depth selection sticks to the conversation that gets created.
      const depth = depthFor(depthKey)
      // Capture the turn's skill ARGUMENT BEFORE ensureConversation re-keys the 'new' selection
      // (§4.3 per-turn: the session pick verbatim when made, else undefined so main resolves the saved
      // default + may auto-fire). The picker's effective resolution already dropped any disabled skill.
      const turnSkill = turnSkillArgFor(depthKey)
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

  // S13c (D3): the per-turn "answer without it" undo on an AUTO-FIRED turn. Re-runs the SAME user
  // question with the skill explicitly cleared (null) — the explicit per-turn clear suppresses
  // auto-fire and stamps no skill, so the answer is skill-free. Re-uses the regenerate path in BOTH
  // modes (drop the last assistant turn from view; the main side deletes + re-answers it). The skill
  // is cleared on this turn only — a never-set conversation default is untouched.
  async function onAnswerWithoutSkill(): Promise<void> {
    if (!activeId || busyStreaming) return
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      return last && last.role === 'assistant' ? prev.slice(0, -1) : prev
    })
    await stream(activeId, '', true, depthFor(activeId), null)
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

  // Save one answer's attached RESULT TABLE as CSV (result-tables §4, Phase 2). MAIN re-serializes
  // the persisted table and opens the save dialog (the consent — same posture as onSaveConversation);
  // null = user cancelled or no table, a calm non-error outcome.
  async function onExportMessageTable(messageId: string): Promise<void> {
    try {
      const saved = await window.api.exportMessageTable(messageId)
      if (saved) showToast(t('chat.savedTo', { path: saved }))
    } catch (e) {
      setError(friendlyIpcError(e))
    }
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
    // FE-7: the 400 ms tick reads ONLY the small `getImportJob` status. The attachment list
    // (and, at completion, the full document list) refreshes when a file actually finishes — the
    // job's completed/failed count changes, which is exactly when the FK-guarded link row that
    // reveals it as a "Files in this chat" entry is written — instead of re-fetching it every tick.
    let lastSettled = -1
    attachPollRef.current = setInterval(async () => {
      try {
        const job = await window.api.getImportJob(jobId)
        // The interval is cleared on unmount, but a tick already parked on this await resolves
        // after teardown — drop it instead of refreshing/setState-ing on a dead screen (FE-1).
        if (!mountedRef.current) return
        const settled = job.completed + job.failed
        const transitioned = settled !== lastSettled
        lastSettled = settled
        if ((transitioned || job.done) && activeIdRef.current === convId) await refreshAttachments(convId)
        if (!job.done) return
        if (attachPollRef.current) clearInterval(attachPollRef.current)
        attachPollRef.current = null
        setPendingImport(null)
        const fresh = (await window.api.listDocuments().catch(() => [])) ?? []
        if (!mountedRef.current) return // unmounted while the document list was loading (FE-1)
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
        if (mountedRef.current) setPendingImport(null) // FE-1: not after unmount
      }
    }, 400)
  }

  // Attach files to a chat. Routing (§13.5): a documents chat takes them directly; an
  // in-progress PLAIN chat is never mutated — a new documents conversation is created and
  // committed BEFORE the import references its id (N3 ordering), then focused with a toast;
  // an empty chat switches in place to a documents conversation (nothing to lose).
  // `pickerToken` (D1): present for the picker path (main imports exactly what was picked,
  // ignoring `paths`); absent for drag-drop (main hardens the raw OS paths instead).
  async function attachFiles(paths: string[], pickerToken?: string): Promise<void> {
    if (paths.length === 0 || busyStreaming) return
    setError(null)
    const fileNames = paths.map(fileBaseName)
    const active = activeId ? conversations.find((c) => c.id === activeId) : undefined
    // D71 (#26): attaching to an EXISTING documents chat that is still on the whole-library default
    // offers a one-time "just this file / whole library" narrow choice. A fresh chat created below is
    // already docs-scoped by `createDocsConversationForAttach`, so it never prompts. Captured BEFORE
    // any conversation switch so the decision reflects the chat that received the file.
    const promptExistingNarrow =
      isWholeLibraryDefault(active) && !scopeChoiceAskedRef.current.has(active!.id)
    // The skill the user currently sees selected — captured BEFORE we switch conversations so a docs
    // conversation created here inherits it instead of resetting to none (attach-flow reset bug). Its
    // "kept" state rides along so a per-turn pick stays per-turn on the new conversation (U3).
    const carrySkill = currentSkillId
    const carrySkillKept = keptForConversation
    try {
      let convId: string
      if (active && active.mode === 'documents') {
        convId = active.id
      } else if (active && active.mode === 'chat' && messages.length > 0) {
        const conv = await createDocsConversationForAttach()
        convId = conv.id
        carrySkillToConversation(conv.id, carrySkill, carrySkillKept)
        setMode('documents')
        setActiveId(conv.id)
        setMessages([])
        await refreshConversations()
        showToast(t('chat.attach.newDocChat', { name: fileNames[0] }))
      } else {
        // Empty (no conversation, or an empty plain chat): switch in place to documents.
        const conv = await createDocsConversationForAttach()
        convId = conv.id
        carrySkillToConversation(conv.id, carrySkill, carrySkillKept)
        setMode('documents')
        setActiveId(conv.id)
        setMessages([])
        await refreshConversations()
      }
      const job = await window.api.importDocuments(paths, {
        destination: { kind: 'conversation', conversationId: convId },
        ...(pickerToken ? { pickerToken } : {})
      })
      setPendingImport({ jobId: job.jobId, convId, documentIds: job.documentIds, fileNames })
      setAttachStatus(t('chat.attach.processing', { name: fileNames.join(', ') }))
      watchAttachJob(job.jobId, convId, job.documentIds, fileNames)
      // Offer the narrow/widen choice for an existing whole-library chat (D71). Only reachable on
      // the `convId === active.id` branch above; a freshly created docs chat is already narrowed.
      if (promptExistingNarrow && convId === active!.id) {
        setScopeChoice({ convId, fileName: fileNames[0] })
      }
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  // D71: "Just this file" — narrow an existing whole-library chat to its attachment(s) by persisting
  // an empty explicit scope (resolveScope then unions the attachments in; whole Library drops out).
  async function onScopeChoiceNarrow(): Promise<void> {
    const choice = scopeChoice
    setScopeChoice(null)
    if (!choice) return
    scopeChoiceAskedRef.current.add(choice.convId)
    try {
      await window.api.setConversationScope(choice.convId, { collectionIds: [], documentIds: [] })
      await refreshConversations()
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  // D71: "Whole library" — keep the corpus-wide default, but remember the choice so the next attach
  // to this conversation does not re-prompt (sticky per conversation).
  function onScopeChoiceWhole(): void {
    if (scopeChoice) scopeChoiceAskedRef.current.add(scopeChoice.convId)
    setScopeChoice(null)
  }

  // Keyboard-reachable picker fallback for the drag/drop target.
  async function onPickAttach(): Promise<void> {
    if (busyStreaming) return
    try {
      const { token, paths } = await window.api.pickDocuments('files')
      if (paths.length > 0) await attachFiles(paths, token)
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    setDragOver(false)
    if (busyStreaming) return
    const hadFiles = (e.dataTransfer?.files?.length ?? 0) > 0
    const paths = pathsFromDrop(e)
    if (paths.length > 0) {
      void attachFiles(paths)
    } else if (hadFiles) {
      // A Files-bearing drop that resolved to zero importable paths (a browser-origin drag, or
      // any drop with no on-disk file). Don't fail silently — tell the user (FE-C).
      setError(t('chat.attach.dropUnsupported'))
    }
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

  return (
    <div className={`chat-layout ${effectiveCollapsed ? 'list-collapsed' : ''}`}>
      {!effectiveCollapsed && (
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          streaming={busyStreaming}
          mode={mode}
          collections={collections}
          onSelect={handleSelectConversation}
          onNew={handleNewChat}
          onDelete={handleDeleteConversation}
          onCollapse={handleCollapseList}
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
          onTryAgain={canTryAgain ? handleTryAgain : undefined}
          // The undo's own placement gate (last skill-stamped turn — auto-fired OR picked, U3 §4.3)
          // lives in Transcript; here we only withhold it while a reply is streaming (it would re-run
          // mid-answer).
          onAnswerWithoutSkill={busyStreaming ? undefined : handleAnswerWithoutSkill}
          onCopy={handleCopyMessage}
          onSave={handleSaveConversation}
          onExportTable={handleExportMessageTable}
          actionsDisabled={busyStreaming}
          resolveSkillTitle={resolveGlyphSkillTitle}
          progressNotice={streamConvId === activeId ? progressNotice : null}
          summaryMarker={summaryMarker}
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

        {/* SKA-6: a quiet chip when a skill is working in ANOTHER chat — the per-run store keeps that
            run alive + acknowledgeable there; here it is just a non-alarming presence hint (the bar
            itself only ever shows THIS conversation's run). */}
        {otherChatRunBusy && (
          <div className="skill-run-elsewhere hint" role="status">
            {t('chat.skill.run.otherChatBusy')}
          </div>
        )}

        {/* Tier-2 tool run (skills plan §12.2/§15, S11b): a calm offer / busy row / result, all
            content-free. Gated to THIS conversation's run (SKA-6). Hidden entirely when this
            conversation has no run active and no tool is offered. */}
        <SkillRunBar
          run={activeSkillRun}
          runnableTools={visibleRunnableTools}
          targetDocuments={targetDocuments}
          runningDocumentName={resolvedRunDocName}
          runningDocumentId={resolvedRunDocId}
          categorizeTargetInScope={categorizeTargetInScope}
          stateUnknown={activeRunEntry?.stateUnknown ?? false}
          onRun={onRunTool}
          onCancel={() => activeSkillRun && void cancelSkillRun(activeSkillRun.runHandle)}
          onDismiss={() => activeSkillRun && acknowledgeSkillRun(activeSkillRun.runHandle)}
          disabled={busyStreaming}
          offerRoutedFollowups={routedRunsReachable}
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
                  suggestionDismissed={suggestionDismissed}
                  onClear={clearSkill}
                  keptForConversation={keptForConversation}
                  onKeepChange={onKeepForConversation}
                />
              )}
              {/* Context-window usage meter (§5.1): pushed to the right of the footer's quiet
                  affordances. Shown for an existing conversation once usage is known; applies to
                  both Chat and document answers. Uses the LIVE usage so the bar + % climb while the
                  answer streams. */}
              {liveUsage && (
                <span className="composer-footer-spacer">
                  <ContextMeter usage={liveUsage} />
                </span>
              )}
            </>
          }
        />
        {/* D71 (#26): the one-time narrow/widen choice when a file is attached to an existing
            whole-library documents chat. Portal-based (Radix) — placement in the tree is cosmetic. */}
        <ScopeNarrowDialog
          open={scopeChoice != null}
          fileName={scopeChoice?.fileName ?? ''}
          onNarrow={() => void onScopeChoiceNarrow()}
          onWhole={onScopeChoiceWhole}
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

/**
 * True when a documents conversation is still on the whole-library default — no explicit composite
 * scope, no legacy specific-doc selection, no project anchor (D71). Only these get the narrow/widen
 * prompt on attach; a conversation the user already scoped (incl. an empty-explicit docs-only scope
 * from a prior attach) is left alone.
 */
function isWholeLibraryDefault(conv: Conversation | undefined): conv is Conversation {
  return (
    conv != null &&
    conv.mode === 'documents' &&
    conv.scope == null &&
    !(conv.scopeDocumentIds && conv.scopeDocumentIds.length > 0) &&
    conv.collectionId == null
  )
}

/** Basename of an absolute path for a friendly chip label (cross-platform separators). */
function fileBaseName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/**
 * Absolute paths of dropped files. Electron removed the non-standard `File.path` in v32
 * (installed: 37.x — FE-A), so the path is resolved in the PRELOAD via
 * `window.api.getDroppedFilePath` (which wraps `webUtils.getPathForFile`) — `webUtils` is not
 * available to the sandboxed renderer. The main process re-validates every path (existence +
 * supported extension) downstream, so a spoofed entry simply fails to import. A File with no
 * on-disk path (a browser-origin drag) resolves to '' and is skipped.
 */
function pathsFromDrop(e: DragEvent): string[] {
  const files = e.dataTransfer?.files
  if (!files) return []
  const out: string[] = []
  for (let i = 0; i < files.length; i++) {
    const p = window.api.getDroppedFilePath(files[i])
    if (typeof p === 'string' && p.length > 0) out.push(p)
  }
  return out
}

// Monotonic counter for optimistic message ids (audit FE-6): two user turns sent in the same
// millisecond would collide on a `Date.now()` key; an ever-incrementing counter is unique for
// the session, which is all a React key needs.
let optimisticSeq = 0

function optimisticUser(conversationId: string, content: string): Message {
  return {
    id: `optimistic-${++optimisticSeq}`,
    conversationId,
    role: 'user',
    content,
    createdAt: new Date().toISOString()
  }
}
