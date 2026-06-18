import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@shared/types'
import { MessageActions } from './MessageActions'
import { SourcesDisclosure } from './SourcesDisclosure'
import { CoverageMeter, Icon } from '../components'
import { localizeServerCopy } from '../lib/displayMap'
import { useT, type I18n } from '../i18n'

// Transcript (guidelines §3): the conversation IS the canvas — centered,
// max-width 720px, --text-md body (CSS). Assistant answers carry an inline
// "▸ Sources (N)" disclosure and a hover/focus action row; the live streaming bubble
// shows the collapsed "Thinking…" line (never persisted) and announces streamed text to
// screen readers via a separate visually-hidden plain-text live region (StreamAnnouncer,
// audit L7) — the visible markdown is intentionally not a live region.

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
  /**
   * Re-run the turn skill-free (S13c "answer without it" undo). Surfaced ONLY on the last assistant
   * turn that the app AUTO-FIRED a skill on (`autoFired`). Absent ⇒ the affordance never renders.
   */
  onAnswerWithoutSkill?: () => void
  onCopy: (content: string) => void
  onSave: () => void
  actionsDisabled: boolean
  /**
   * Resolve a skill's per-message glyph title in the UI language (installId → localized title),
   * falling back to the stamped canonical title. Optional — when absent the stamped title is shown.
   */
  resolveSkillTitle?: (installId: string | null | undefined, fallbackTitle: string) => string
}

// Memoized (perf audit FE-3): ChatScreen re-renders on every keystroke (input state) and every
// ~40 ms streaming flush. With stable props from the parent (useCallback'd handlers + a memoized
// emptyState), the transcript — and its per-message Markdown parsing — is skipped on a keystroke
// and only re-renders for genuine transcript/stream changes.
export const Transcript = memo(function Transcript({
  messages,
  streamingHere,
  streamText,
  streamThinking,
  thinkingOpen,
  onThinkingOpenChange,
  emptyState,
  onTryAgain,
  onAnswerWithoutSkill,
  onCopy,
  onSave,
  actionsDisabled,
  resolveSkillTitle
}: TranscriptProps): JSX.Element {
  const { t } = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether the viewport is pinned to the bottom. We only auto-scroll on new content while the
  // user is already near the bottom, so a ~40 ms streaming flush no longer forces a layout +
  // scroll when the user has scrolled up to read an earlier turn (perf audit FE-1/FE-5).
  const atBottomRef = useRef(true)
  function onScroll(): void {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // Keep the transcript scrolled to the newest content — but only while pinned to the bottom,
  // so a streaming flush never yanks a user who scrolled up to read.
  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streamText, streamThinking])

  // Id of the last assistant turn — drives the regenerate / "answer without it" affordances.
  // Memoized so a 40 ms streaming flush doesn't re-scan the whole transcript (perf audit FE-1).
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return undefined
  }, [messages])

  return (
    <div className="chat-transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-transcript-inner">
        {messages.length === 0 && !streamingHere && emptyState}
        {/* Each persisted message is a memoized MessageBlock keyed by id (its content is stamped
            once and never mutates), so a streaming flush — which only changes `streamText` on the
            live bubble below — never re-parses a prior message's Markdown (perf audit FE-1). */}
        {messages.map((m) => (
          <MessageBlock
            key={m.id}
            m={m}
            t={t}
            isLast={m.id === lastAssistantId}
            onTryAgain={onTryAgain}
            onAnswerWithoutSkill={onAnswerWithoutSkill}
            onCopy={onCopy}
            onSave={onSave}
            actionsDisabled={actionsDisabled}
            resolveSkillTitle={resolveSkillTitle}
          />
        ))}
        {streamingHere && (
          <div className="msg-block assistant">
            <div className="msg assistant">
              <div className="msg-role">{t('chat.role.assistant')}</div>
              {/* Deep mode: live reasoning, collapsed by default, auto-collapsed
                  again when the first answer token lands. Display-only — never persisted,
                  so it disappears once the final reply is re-read from history. */}
              {streamThinking !== '' && (
                // A <button aria-expanded> (the SourcesDisclosure pattern), not a
                // <details>/<summary> driven by preventDefault (audit L15): the controlled
                // toggle (auto-collapse on the first answer token) used to fight the native
                // <details> state, which could desync the implicit aria-expanded a screen
                // reader announces. An explicit aria-expanded button stays in lockstep.
                <div className="msg-thinking">
                  <button
                    type="button"
                    className="msg-thinking-toggle"
                    aria-expanded={thinkingOpen}
                    onClick={() => onThinkingOpenChange(!thinkingOpen)}
                  >
                    {t('chat.thinking')}
                  </button>
                  {/* Kept mounted and hidden (not unmounted) when collapsed, matching the
                      old <details> semantics: the live reasoning buffer keeps accumulating
                      and is available to AT, while `hidden` removes it from view + the a11y
                      tree when collapsed. */}
                  <div className="msg-thinking-text" hidden={!thinkingOpen}>
                    {streamThinking}
                  </div>
                </div>
              )}
              {/* The live answer renders as PLAIN TEXT while streaming (perf audit FE-1): re-parsing
                  the whole growing Markdown buffer on every ~40 ms flush is O(n²) over the reply
                  length and competes with token generation on CPU-only hardware. The full Markdown
                  parse runs ONCE on completion, when the turn re-renders from `messages` as a
                  persisted MessageBlock. `.msg-content` without `.md` keeps white-space: pre-wrap so
                  newlines survive; the fixed RAG answers (one onToken chunk) read fine as plain text
                  too. The visible text is NOT a live region (audit L7) — announcement is delegated to
                  the separate sentence-throttled StreamAnnouncer below. */}
              <div className="msg-content">
                {localizeServerCopy(t, streamText)}
                <span className="cursor" aria-hidden="true">
                  ▋
                </span>
              </div>
              <StreamAnnouncer text={localizeServerCopy(t, streamText)} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

/**
 * One persisted message (user or assistant). Memoized (React.memo) and keyed by message id so a
 * ~40 ms streaming flush — which only updates the live bubble's `streamText` — never re-renders
 * or re-parses the Markdown of prior, unchanged turns (perf audit FE-1). The memo is fully
 * effective once the parent passes stable callbacks (perf audit FE-3); even before that, the
 * memoized `AssistantMarkdown` below keeps identical text from being re-parsed.
 */
const MessageBlock = memo(function MessageBlock({
  m,
  t,
  isLast,
  onTryAgain,
  onAnswerWithoutSkill,
  onCopy,
  onSave,
  actionsDisabled,
  resolveSkillTitle
}: {
  m: Message
  t: I18n['t']
  /** True on the last assistant turn — gates the regenerate + "answer without it" affordances. */
  isLast: boolean
  onTryAgain?: () => void
  onAnswerWithoutSkill?: () => void
  onCopy: (content: string) => void
  onSave: () => void
  actionsDisabled: boolean
  resolveSkillTitle?: (installId: string | null | undefined, fallbackTitle: string) => string
}): JSX.Element {
  return (
    <div className={`msg-block ${m.role}`}>
      <div className={`msg ${m.role}`}>
        <div className="msg-role">{roleLabel(m.role, t)}</div>
        {m.role === 'assistant' ? (
          <div className="msg-content md">
            {/* The fixed RAG answers (no-context / reindex-needed) are persisted
                canonical English; the D-L4 display map translates them at render
                — exact match only, real model output passes through untouched. */}
            <AssistantMarkdown text={localizeServerCopy(t, m.content)} />
          </div>
        ) : (
          <div className="msg-content">{m.content}</div>
        )}
        {m.citations && m.citations.length > 0 && (
          <>
            <SourcesDisclosure citations={m.citations} />
            {/* Honesty (whole-document-analysis §4.5/§5.2): a grounded document answer
                is a RELEVANCE answer — based on the most relevant passages, NOT the whole
                document. Always labelled so a retrieval answer never reads as exhaustive. */}
            <CoverageMeter coverage={{ mode: 'relevance', chunksCovered: 0, chunksTotal: 0 }} />
          </>
        )}
        {/* Per-message skill glyph (skills plan §15/DS16/§22-A5): a quiet, labelled marker on
            the answer a skill shaped — icon + word, never colour-only (guidelines §9). The
            read resolves a DELETED skill to null (no skillTitle), so the glyph never points at
            a vanished skill. Decorative-but-labelled; never alarming. */}
        {m.role === 'assistant' && m.skillTitle && (() => {
          // Show the glyph title in the UI language when the skill carries a `localized`
          // override; fall back to the stamped canonical title otherwise.
          const glyphTitle = resolveSkillTitle ? resolveSkillTitle(m.skillId, m.skillTitle) : m.skillTitle
          // S13c (D3): an AUTO-FIRED turn reads "Answered with <skill>" and — on the last
          // assistant turn — carries a one-click "answer without it" undo that re-runs the same
          // question skill-free. An explicitly-picked turn keeps the plain "Skill: <title>" glyph
          // (no undo). Either way the glyph keeps the auto-fire visible, never silent.
          if (m.autoFired) {
            const canUndo = isLast && onAnswerWithoutSkill != null
            return (
              <div
                className="msg-skill msg-skill-auto"
                title={t('chat.skill.autoFiredTitle', { title: glyphTitle })}
              >
                <Icon name="brain" className="msg-skill-icon" />
                <span>{t('chat.skill.autoFired', { title: glyphTitle })}</span>
                {canUndo && (
                  <button
                    type="button"
                    className="msg-skill-undo"
                    onClick={onAnswerWithoutSkill}
                    disabled={actionsDisabled}
                  >
                    {t('chat.skill.answerWithout')}
                  </button>
                )}
              </div>
            )
          }
          return (
            <div className="msg-skill" title={t('chat.skill.usedTitle', { title: glyphTitle })}>
              <Icon name="brain" className="msg-skill-icon" />
              <span>{t('chat.skill.used', { title: glyphTitle })}</span>
            </div>
          )
        })()}
      </div>
      {m.role === 'assistant' && (
        <MessageActions
          onTryAgain={isLast ? onTryAgain : undefined}
          onCopy={() => onCopy(m.content)}
          onSave={onSave}
          disabled={actionsDisabled}
        />
      )}
    </div>
  )
})

/** Localized role chip; unknown roles (defensive) render as-is. */
function roleLabel(role: string, t: I18n['t']): string {
  return role === 'user' ? t('chat.role.user') : role === 'assistant' ? t('chat.role.assistant') : role
}

/**
 * Visually-hidden polite live region for streaming answers (audit L7). Screen readers
 * announce a live region by reading what is ADDED to it, so we feed it only newly
 * COMPLETED sentences as plain text — never the churning markdown buffer. This avoids
 * both failure modes of announcing the rendered markdown directly: re-reading the whole
 * answer on every flush, or (because the subtree remounts) going silent entirely.
 *
 * Sentence boundary = the position after the last terminator (. ! ? … or newline). We
 * announce the stable prefix up to that boundary and remember how far we've gone, so the
 * trailing in-progress sentence is held back until it completes. Markdown markup is
 * stripped to a rough plain-text form so the reader doesn't voice "asterisk asterisk".
 */
export function StreamAnnouncer({ text }: { text: string }): JSX.Element {
  const announcedLenRef = useRef(0)
  const [announced, setAnnounced] = useState('')

  useEffect(() => {
    // A new stream (text got shorter / reset) → start over.
    if (text.length < announcedLenRef.current) {
      announcedLenRef.current = 0
      setAnnounced('')
      return
    }
    // Find the last completed-sentence boundary in the current buffer.
    const boundary = lastSentenceBoundary(text)
    if (boundary <= announcedLenRef.current) return
    const next = stripMarkdown(text.slice(announcedLenRef.current, boundary)).trim()
    announcedLenRef.current = boundary
    if (next !== '') setAnnounced(next)
  }, [text])

  return (
    <div className="sr-only" role="log" aria-live="polite" aria-atomic="true">
      {announced}
    </div>
  )
}

/** Index just past the last sentence terminator (. ! ? … or newline); 0 if none yet. */
function lastSentenceBoundary(text: string): number {
  // Match a terminator optionally followed by closing quotes/brackets then whitespace
  // or end-of-string — the last such match is our boundary.
  const re = /[.!?…\n]+["')\]]*(?=\s|$)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) last = m.index + m[0].length
  return last
}

/** Rough markdown → plain text for the announcer (not the visible render). */
function stripMarkdown(s: string): string {
  return s
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ') // inline/code spans
    .replace(/[*_~`#>]+/g, '') // emphasis / heading / quote / strike markers
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images → their text
    .replace(/^\s*[-+*]\s+/gm, '') // list bullets
    .replace(/\s+/g, ' ')
}

/**
 * Assistant replies render as Markdown (GFM: bold, lists, tables, code, …) — local
 * models emit Markdown and showing the raw `**asterisks**` reads as broken output.
 * react-markdown builds React elements (no innerHTML), and raw HTML in model output is
 * rendered as literal text, so the strict CSP / no-injection posture is unchanged.
 * Links open in the OS browser via `target="_blank"` (the main process's window-open
 * handler allows http(s) only); user turns stay plain text — they are not Markdown.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          // Whitelist http(s) only (audit L1): a model could emit a `javascript:`/`data:`
          // href. The CSP + the window-open handler already block execution/navigation, so
          // this is belt-and-suspenders — a disallowed scheme renders as inert text, not a link.
          const safe = isSafeHttpUrl(href)
          return safe ? (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          )
        }
      }}
    >
      {text}
    </Markdown>
  )
})

/** True only for absolute http(s) URLs — the one scheme allowed in rendered model links. */
function isSafeHttpUrl(href: string | undefined): boolean {
  if (!href) return false
  try {
    const proto = new URL(href).protocol
    return proto === 'http:' || proto === 'https:'
  } catch {
    // Not an absolute URL (relative/anchor/malformed) → not a safe external link.
    return false
  }
}
