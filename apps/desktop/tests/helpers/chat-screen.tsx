import type { ComponentProps } from 'react'
import { act, render, type RenderResult } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import type { PreloadApi } from '../../src/preload'
import type { CompactionNotice } from '../../src/shared/ipc'
import { DEFAULT_SETTINGS, type ContextUsage } from '../../src/shared/types'
import { dropFiles } from './drop'
import { appStatus, runtimeStatus } from './status'

// The ChatScreen harness (chat-ui campaign). Replaces what the ChatScreen suites each built for themselves:
// the hand-copied `stubApi` baseline (15 calls in lane A alone), the `<ToastProvider><ChatScreen …/>` render
// (written out ~15× inline plus `renderChat()` copies), the fake-timer `flush()` (5 named copies, 8 or 10
// hops), the captured onToken / onReasoning / onCompaction listeners (`streamHarness`, ChatWarmupHint's
// `setup`, ChatCompaction ×3 inline), the parked-send promise, the `getDroppedFilePath` WeakMap + drop
// helpers (ChatAttach, ChatBackToConversation, ChatUnmount, ChatScopeToolsRefresh) and the `.chat-conv` row
// lookups (`convRow`, `convRowButton`).
//
// Rules:
//  - `chatScreenStubs` answers EVERY `window.api` method an idle mounted ChatScreen calls, so a suite can end
//    each test with `assertNoUnexpectedApiCalls()`. A method the screen starts calling at mount must be added
//    here, or every adopter goes red at once (the point). What a mount calls, and when:
//      at mount       listConversations, getRuntimeStatus, listDocuments, listCollections, listKnowledgePacks,
//                     getAppStatus, listSkills, getSettings, listSkillRuns (adoptSkillRuns),
//                     listActiveStreamConversations; subscribes onRuntimeNotice and onKnowledgePacksChanged
//      400 ms later   suggestSkills(conversationId ?? '', draft): the composer's debounce (a literal in
//                     ChatScreen), re-armed by every keystroke and conversation switch
//      window focus   getAppStatus (the dictation re-check)
//      no model       getRuntimeStatus every RUNTIME_POLL_MS (2,500 ms) while `running` is false
//      a conversation listMessages, getConversationContextUsage, getConversationSummary, listAttachments,
//      is selected    getActiveStream (once, then every STREAM_RECOVER_POLL_MS = 300 ms until it answers null);
//                     getEvidenceReviewSummariesForConversation once a review-eligible answer is listed;
//                     listRunnableTools while a skill is picked
//      each send      onToken, onCompaction, onContextUsage, onAnswerSpeed, onReasoning, onScopeNotice
//                     (unsubscribed when the send settles), then sendChatMessage / askDocuments
//    The send itself is NOT stubbed: a test supplies `sendChatMessage` / `askDocuments` (often `deferred()`).
//  - `renderChatScreen` does not call stubApi: install `stubApi(chatScreenStubs({ … }))` first, so the stub
//    set a test runs against is visible in the test.
//  - A fake stream event must reach a live listener: `fakeChatStream`'s emitters throw when nothing is
//    subscribed (before the send subscribed, or after it settled and unsubscribed). Gate on `subscribed()`.

/** A no-op unsubscribe, the return of every calm `on*` stub. */
const unsubscribed = (): void => {}

/**
 * A calm, typed `window.api` for a mounted ChatScreen: no conversations, a running model (`runtimeStatus()`),
 * nothing imported, no skills, packs, runs or streams, and a no-op for every event subscription. Each stub
 * is a `vi.fn` minted per call, so a test can assert on it (`expect(stubs.getRuntimeStatus)…`). `over`
 * spreads last.
 */
export function chatScreenStubs(over: Partial<PreloadApi> = {}): Partial<PreloadApi> {
  return {
    // Mount reads.
    listConversations: vi.fn<PreloadApi['listConversations']>(async () => []),
    getRuntimeStatus: vi.fn<PreloadApi['getRuntimeStatus']>(async () => runtimeStatus()),
    listDocuments: vi.fn<PreloadApi['listDocuments']>(async () => []),
    listCollections: vi.fn<PreloadApi['listCollections']>(async () => []),
    listKnowledgePacks: vi.fn<PreloadApi['listKnowledgePacks']>(async () => []),
    getAppStatus: vi.fn<PreloadApi['getAppStatus']>(async () => appStatus()),
    listSkills: vi.fn<PreloadApi['listSkills']>(async () => []),
    getSettings: vi.fn<PreloadApi['getSettings']>(async () => ({ ...DEFAULT_SETTINGS })),
    listSkillRuns: vi.fn<PreloadApi['listSkillRuns']>(async () => []),
    listActiveStreamConversations: vi.fn<PreloadApi['listActiveStreamConversations']>(async () => []),
    suggestSkills: vi.fn<PreloadApi['suggestSkills']>(async () => []),
    // Reads for the selected conversation.
    listMessages: vi.fn<PreloadApi['listMessages']>(async () => []),
    getConversationContextUsage: vi.fn<PreloadApi['getConversationContextUsage']>(async () => null),
    getConversationSummary: vi.fn<PreloadApi['getConversationSummary']>(async () => null),
    listAttachments: vi.fn<PreloadApi['listAttachments']>(async () => []),
    getActiveStream: vi.fn<PreloadApi['getActiveStream']>(async () => null),
    getEvidenceReviewSummariesForConversation: vi.fn<
      PreloadApi['getEvidenceReviewSummariesForConversation']
    >(async () => []),
    listRunnableTools: vi.fn<PreloadApi['listRunnableTools']>(async () => ({ tools: [], documentIds: [] })),
    // App-wide subscriptions (mount).
    onRuntimeNotice: vi.fn<PreloadApi['onRuntimeNotice']>(() => unsubscribed),
    onKnowledgePacksChanged: vi.fn<PreloadApi['onKnowledgePacksChanged']>(() => unsubscribed),
    // Per-send stream subscriptions (`fakeChatStream().stubs` replaces the first four).
    onToken: vi.fn<PreloadApi['onToken']>(() => unsubscribed),
    onReasoning: vi.fn<PreloadApi['onReasoning']>(() => unsubscribed),
    onCompaction: vi.fn<PreloadApi['onCompaction']>(() => unsubscribed),
    onContextUsage: vi.fn<PreloadApi['onContextUsage']>(() => unsubscribed),
    onAnswerSpeed: vi.fn<PreloadApi['onAnswerSpeed']>(() => unsubscribed),
    onScopeNotice: vi.fn<PreloadApi['onScopeNotice']>(() => unsubscribed),
    ...over
  }
}

/** The fake stream: spread `stubs` into `chatScreenStubs`, then emit into the send's live listeners. */
export interface ChatStreamFake {
  /** onToken / onReasoning / onCompaction / onContextUsage, each recording the listener a send subscribes. */
  stubs: Partial<PreloadApi>
  /** One answer token (`STREAM.token`). */
  token(t: string): void
  /** One Thorough-mode reasoning delta (`STREAM.reasoning`). */
  reasoning(d: string): void
  /** The "working on it" notice (`STREAM.compaction`); main sends `{ phase: 'start' }` or with `kind`. */
  compaction(n: CompactionNotice): void
  /** The in-flight turn's assembled-prompt usage (`STREAM.usage`). */
  contextUsage(u: ContextUsage): void
  /** True while a send has an onToken listener subscribed: the "the send reached the stream" gate. */
  subscribed(): boolean
}

/** One stream channel: the listener the CURRENT send subscribed (the latest subscription wins), cleared
 *  when that send unsubscribes. */
function streamChannel<T>(name: string): {
  subscribe: (conversationId: string, cb: (payload: T) => void) => () => void
  emit: (payload: T) => void
  live: () => boolean
} {
  let current: ((payload: T) => void) | null = null
  return {
    subscribe: (_conversationId, cb) => {
      current = cb
      return () => {
        if (current === cb) current = null
      }
    },
    emit: (payload) => {
      const cb = current
      if (cb == null) {
        throw new Error(
          `fakeChatStream.${name}(): no ${name} listener is subscribed, so the event would reach nobody. ` +
            `Wait for subscribed() before emitting; after the send settles the screen has unsubscribed.`
        )
      }
      act(() => {
        cb(payload)
      })
    },
    live: () => current != null
  }
}

/**
 * Capture the stream listeners ChatScreen's `stream()` subscribes for a send. Emitters run the current
 * listener inside `act` and throw when none is subscribed. Tokens are buffered by the screen and painted
 * after STREAM_FLUSH_MS (40 ms): await a `findBy…` with real timers, or advance the fake clock past it.
 */
export function fakeChatStream(): ChatStreamFake {
  const token = streamChannel<string>('token')
  const reasoning = streamChannel<string>('reasoning')
  const compaction = streamChannel<CompactionNotice>('compaction')
  const contextUsage = streamChannel<ContextUsage>('contextUsage')
  return {
    stubs: {
      onToken: vi.fn<PreloadApi['onToken']>(token.subscribe),
      onReasoning: vi.fn<PreloadApi['onReasoning']>(reasoning.subscribe),
      onCompaction: vi.fn<PreloadApi['onCompaction']>(compaction.subscribe),
      onContextUsage: vi.fn<PreloadApi['onContextUsage']>(contextUsage.subscribe)
    },
    token: token.emit,
    reasoning: reasoning.emit,
    compaction: compaction.emit,
    contextUsage: contextUsage.emit,
    subscribed: token.live
  }
}

/** `deferred<Message>()` → `sendChatMessage: vi.fn(() => send.promise)`, then `send.resolve(answer)`. */
export { deferred, type Deferred } from './deferred'

/**
 * Render ChatScreen inside the ToastProvider (the RTL `wrapper`, so `rerender(<ChatScreen …/>)` keeps it).
 * The returned `onNavigate` mock records every navigation and also calls a `props.onNavigate` you pass.
 * Install `stubApi(chatScreenStubs(…))` BEFORE calling this.
 */
export function renderChatScreen(
  props: Partial<ComponentProps<typeof ChatScreen>> = {}
): RenderResult & { onNavigate: Mock<(screen: string) => void> } {
  const onNavigate = vi.fn((screen: string): void => props.onNavigate?.(screen))
  const result = render(<ChatScreen {...props} onNavigate={onNavigate} />, { wrapper: ToastProvider })
  return { ...result, onNavigate }
}

/**
 * Under `vi.useFakeTimers()`: let resolved IPC promises and the effects they schedule land, without moving
 * the clock. Each hop is one `advanceTimersByTimeAsync(0)` in its own `act`. ChatScreen's mount settles in
 * well under the default 10 hops; a timer (the 400 ms suggestion debounce, a 300 ms recovery tick) still
 * needs `vi.advanceTimersByTimeAsync(ms)`.
 */
export async function flushFakeTimers(hops = 10): Promise<void> {
  for (let i = 0; i < hops; i++) await act(() => vi.advanceTimersByTimeAsync(0))
}

/** Dropping files on the chat surface through the preload path resolver (FE-A). */
export interface ChatDropBridge {
  /** `getDroppedFilePath`: the path `drop` registered for a File, '' for any other File. */
  stubs: Partial<PreloadApi>
  /** Drop one file named `name` that resolves to `path` (usually on `.chat-main`). */
  drop(target: Element, name: string, path: string): void
  /** Drop one file with no on-disk path (a browser-origin drag): the resolver answers ''. */
  dropUnresolvable(target: Element, name: string): void
}

/** The `webUtils.getPathForFile` stand-in: a dropped File has no `.path`, the bridge maps it to one. */
export function chatDropBridge(): ChatDropBridge {
  const paths = new WeakMap<File, string>()
  const getDroppedFilePath = vi.fn<PreloadApi['getDroppedFilePath']>((file) => paths.get(file) ?? '')
  return {
    stubs: { getDroppedFilePath },
    drop(target, name, path) {
      const file = new File([], name)
      paths.set(file, path)
      dropFiles(target, [file])
    },
    dropUnresolvable(target, name) {
      dropFiles(target, [new File([], name)])
    }
  }
}

/** The conversation-list row button (`button.chat-conv`) whose title reads exactly `title`. Throws when
 *  there is none, or more than one. (The title is also in the row's "⋯" aria-label, so a role + name
 *  lookup is ambiguous; this reads the row's title span.) */
export function conversationRow(title: string): HTMLButtonElement {
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('button.chat-conv')).filter(
    (row) => row.querySelector('.chat-conv-title')?.textContent === title
  )
  if (rows.length !== 1) {
    throw new Error(`conversationRow(${JSON.stringify(title)}): ${rows.length} rows carry that title, expected 1`)
  }
  return rows[0]
}
