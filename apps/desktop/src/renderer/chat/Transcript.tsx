import { Fragment, memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Streamdown, defaultRehypePlugins } from 'streamdown'
import { math } from '@streamdown/math'
import 'katex/dist/katex.min.css'
import type { ConversationSummaryMarker, Message } from '@shared/types'
import { MessageActions } from './MessageActions'
import { SourcesDisclosure } from './SourcesDisclosure'
import { CoverageMeter, Icon, Spinner } from '../components'
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
   * Re-run the turn skill-free (S13c "answer without it" undo). Surfaced on the last assistant turn
   * that ANY skill shaped — auto-fired OR explicitly picked (U3, audit §4.3: a per-turn pick must be
   * as reversible as an auto-fire). Absent ⇒ the affordance never renders.
   */
  onAnswerWithoutSkill?: () => void
  onCopy: (content: string) => void
  onSave: () => void
  /**
   * Save one answer's attached RESULT TABLE as CSV (result-tables §4, Phase 2). Rendered only on
   * messages with `hasResultTable`; the MAIN side re-serializes the persisted table and opens the
   * save dialog. Absent ⇒ the affordance never renders.
   */
  onExportTable?: (messageId: string) => void
  actionsDisabled: boolean
  /**
   * Resolve a skill's per-message glyph title in the UI language (installId → localized title),
   * falling back to the stamped canonical title. Optional — when absent the stamped title is shown.
   */
  resolveSkillTitle?: (installId: string | null | undefined, fallbackTitle: string) => string
  /**
   * The live "working on it" notice above the streaming bubble for THIS turn, or null/absent when
   * none (context-compaction §5.2). `'compaction'` = summarizing earlier messages; `'analysis'` (U5,
   * audit §3.6) = an exhaustive skill handler reading the whole document before its answer. Ephemeral:
   * cleared by the parent on the first answer token.
   */
  progressNotice?: 'compaction' | 'analysis' | null
  /**
   * The latest compaction summary + where its transcript marker sits (context-compaction §5.3,
   * D-b). The "⌄ Earlier messages summarized" divider renders before the message whose id matches
   * `beforeMessageId`; expandable to read the summary. Absent/null ⇒ no marker.
   */
  summaryMarker?: ConversationSummaryMarker | null
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
  onExportTable,
  actionsDisabled,
  resolveSkillTitle,
  progressNotice,
  summaryMarker
}: TranscriptProps): JSX.Element {
  const { t } = useT()
  // Stable ids wiring the live "Thinking…" toggle to its region (FE-D aria-controls).
  const thinkingId = useId()
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

  // Id of the assistant turn that drives the regenerate / "answer without it" affordances. SKA-37
  // (skills audit 2026-07-03, U6): these affordances re-answer via the REGENERATE path, which acts on
  // the conversation's LAST turn — so they must render ONLY when the last message IS that assistant
  // turn. A trailing UNANSWERED user turn (e.g. a send that failed to produce an answer) otherwise let
  // "Answer without this skill" on A1 actually re-answer the later Q2 skill-free. So the id is the last
  // message's id only when it is an assistant turn — a trailing user turn suppresses both affordances
  // (the failed-generation retry is covered by the error banner instead). Memoized (perf audit FE-1).
  const lastAssistantId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last && last.role === 'assistant' ? last.id : undefined
  }, [messages])

  // localizeServerCopy is an O(n) Map-lookup + two regex .exec over the WHOLE growing buffer; it
  // was run TWICE per ~40 ms flush (visible bubble + StreamAnnouncer). Compute it once and feed
  // both — behavior identical, half the work on the CPU-bound streaming path (perf audit F2).
  const localizedStream = useMemo(() => localizeServerCopy(t, streamText), [t, streamText])

  return (
    <div className="chat-transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-transcript-inner">
        {messages.length === 0 && !streamingHere && emptyState}
        {/* Each persisted message is a memoized MessageBlock keyed by id (its content is stamped
            once and never mutates), so a streaming flush — which only changes `streamText` on the
            live bubble below — never re-parses a prior message's Markdown (perf audit FE-1). */}
        {messages.map((m) => (
          <Fragment key={m.id}>
            {/* The summary divider (§5.3, D-b) renders just before the first turn the checkpoint
                does NOT subsume — "everything above was condensed for the model; below is verbatim". */}
            {summaryMarker && summaryMarker.beforeMessageId === m.id && (
              <SummaryMarker summary={summaryMarker.summary} t={t} />
            )}
            <MessageBlock
              m={m}
              t={t}
              isLast={m.id === lastAssistantId}
              onTryAgain={onTryAgain}
              onAnswerWithoutSkill={onAnswerWithoutSkill}
              onCopy={onCopy}
              onSave={onSave}
              onExportTable={onExportTable}
              actionsDisabled={actionsDisabled}
              resolveSkillTitle={resolveSkillTitle}
            />
          </Fragment>
        ))}
        {/* §5.2/U5: quiet "working on it" status above the streaming bubble; the parent clears
            `progressNotice` on the first answer token. 'analysis' (U5, §3.6) shows honest "reading the
            document…" copy instead of the compaction "summarizing…" line. Same spinner vocabulary. */}
        {progressNotice && streamingHere && (
          <div className="chat-compaction-notice" role="status">
            <Spinner />{' '}
            {t(progressNotice === 'analysis' ? 'chat.analysis.inProgress' : 'chat.compaction.inProgress')}
          </div>
        )}
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
                    id={`${thinkingId}-toggle`}
                    aria-expanded={thinkingOpen}
                    aria-controls={`${thinkingId}-region`}
                    onClick={() => onThinkingOpenChange(!thinkingOpen)}
                  >
                    {t('chat.thinking')}
                  </button>
                  {/* Kept mounted and hidden (not unmounted) when collapsed, matching the
                      old <details> semantics: the live reasoning buffer keeps accumulating
                      and is available to AT, while `hidden` removes it from view + the a11y
                      tree when collapsed. The toggle's aria-controls names this region (FE-D). */}
                  <div
                    className="msg-thinking-text"
                    id={`${thinkingId}-region`}
                    role="region"
                    aria-labelledby={`${thinkingId}-toggle`}
                    hidden={!thinkingOpen}
                  >
                    {streamThinking}
                  </div>
                </div>
              )}
              {/* The live answer renders Markdown via Streamdown (perf audit FE-1, revisited):
                  Streamdown splits the buffer into blocks and memoizes each, so a ~40 ms flush only
                  re-parses the final block instead of the whole growing reply (the O(n²) that made
                  this plain text before). `parseIncompleteMarkdown` closes dangling **bold**, `code`,
                  fences and links mid-stream so the bubble formats cleanly instead of flashing raw
                  markers. `.md` applies the same prose CSS as a persisted turn. Feeds on the ONE
                  memoized `localizedStream` (perf audit F2) — inlining localizeServerCopy here would
                  re-scan the whole buffer a second time per flush. The visible text is NOT a live
                  region (audit L7) — announcement is delegated to the separate sentence-throttled
                  StreamAnnouncer below. */}
              <div className="msg-content md">
                <AssistantMarkdown text={localizedStream} streaming />
                <span className="cursor" aria-hidden="true">
                  ▋
                </span>
              </div>
              <StreamAnnouncer text={localizedStream} />
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
  onExportTable,
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
  onExportTable?: (messageId: string) => void
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
            {/* The coverage mode tells the disclosure whether these are 1:1 inline-grounded
                excerpts (relevance) or whole-document LEAF PROVENANCE (tree/capped/extract) —
                FE-B / F11 renderer half. A NULL-coverage relevance turn passes undefined and
                renders byte-identically to before. */}
            <SourcesDisclosure citations={m.citations} mode={m.coverage?.mode} />
            {/* Honesty (whole-document-analysis §4.5/§5.2; full-doc-skills §3.3/D48): render the
                answer's PERSISTED coverage when we have it, else fall back to the relevance label —
                "based on the most relevant passages, NOT the whole document". A pre-migration row
                (NULL coverage) and a plain retrieval turn both hit the fallback, so the badge reads
                byte-identically to before; only a turn that recorded richer coverage shows it. */}
            <CoverageMeter
              coverage={m.coverage ?? { mode: 'relevance', chunksCovered: 0, chunksTotal: 0 }}
            />
          </>
        )}
        {/* Per-message skill glyph (skills plan §15/DS16/§22-A5): a quiet, labelled marker on
            the answer a skill shaped — icon + word, never colour-only (guidelines §9). SKA-38
            (skills audit 2026-07-03, U6): gated off the PERSISTED `m.skillId`, not the JOIN-resolved
            title, so DELETING the skill no longer erases the glyph + undo from an already-stamped turn
            (a disabled skill already kept both). A stamped turn whose skill is gone (null title) shows
            a localized "(removed skill)" label. Decorative-but-labelled; never alarming. */}
        {m.role === 'assistant' && m.skillId && (() => {
          // Show the glyph title in the UI language when the skill carries a `localized` override;
          // fall back to the stamped canonical title; and to "(removed skill)" when the skill is gone.
          const removedLabel = t('chat.skill.removed')
          const fallback = m.skillTitle ?? removedLabel
          const glyphTitle = resolveSkillTitle ? resolveSkillTitle(m.skillId, fallback) : fallback
          // The "answer without it" undo re-runs the same question skill-free. S13c placed it on
          // AUTO-FIRED turns only; U3 (audit §4.3) extends it to EVERY skill-stamped last turn — a
          // per-turn pick is now as reversible as an auto-fire, so no skill-shaped answer is a
          // dead end. The glyph copy still distinguishes the two: an auto-fired turn reads "Answered
          // with <skill>" (the app chose it), an explicit pick keeps "Skill: <title>".
          const canUndo = isLast && onAnswerWithoutSkill != null
          const undoButton = canUndo && (
            <button
              type="button"
              className="msg-skill-undo"
              onClick={onAnswerWithoutSkill}
              disabled={actionsDisabled}
            >
              {t('chat.skill.answerWithout')}
            </button>
          )
          if (m.autoFired) {
            return (
              <div
                className="msg-skill msg-skill-auto"
                title={t('chat.skill.autoFiredTitle', { title: glyphTitle })}
              >
                <Icon name="brain" className="msg-skill-icon" />
                <span>{t('chat.skill.autoFired', { title: glyphTitle })}</span>
                {undoButton}
              </div>
            )
          }
          return (
            <div className="msg-skill" title={t('chat.skill.usedTitle', { title: glyphTitle })}>
              <Icon name="brain" className="msg-skill-icon" />
              <span>{t('chat.skill.used', { title: glyphTitle })}</span>
              {undoButton}
            </div>
          )
        })()}
        {/* Honest-signal truncation notice (§L0): a quiet, labelled line on an assistant reply the
            model cut off at the token/context ceiling (finish_reason 'length'). Never colour-only —
            a labelled marker with an explanatory tooltip (guidelines §9); role="note" so AT reads it
            as supplementary to the answer, not an alert. */}
        {m.role === 'assistant' && m.truncated && (
          <div className="msg-truncated" role="note" title={t('chat.truncated.hint')}>
            <span className="msg-truncated-glyph" aria-hidden="true">
              ⚠
            </span>
            <span>{t('chat.truncated.label')}</span>
          </div>
        )}
      </div>
      {m.role === 'assistant' && (
        <MessageActions
          onTryAgain={isLast ? onTryAgain : undefined}
          onCopy={() => onCopy(m.content)}
          onSave={onSave}
          onExportTable={
            m.hasResultTable && onExportTable ? () => onExportTable(m.id) : undefined
          }
          disabled={actionsDisabled}
        />
      )}
    </div>
  )
})

/**
 * The transcript summary marker (context-compaction plan §5.3, D-b): a subtle, non-bubble divider
 * where a compaction checkpoint sits — "⌄ Earlier messages summarized" — expandable to read the
 * checkpoint summary text. Makes the compression visible + auditable (the user confirms context was
 * condensed, not lost), matching the honest/local/nothing-hidden posture. The summary is the same
 * conversation-language text the model received; it never leaves the device. An aria-expanded
 * button (the SourcesDisclosure pattern), not a native <details>.
 */
function SummaryMarker({ summary, t }: { summary: string; t: I18n['t'] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="chat-summary-marker">
      <button
        type="button"
        className="chat-summary-marker-toggle"
        id={`${id}-toggle`}
        aria-expanded={open}
        aria-controls={`${id}-region`}
        title={t('chat.compaction.viewSummary')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-summary-marker-chevron" aria-hidden="true">
          {open ? '⌄' : '›'}
        </span>
        <span className="chat-summary-marker-label">{t('chat.compaction.markerLabel')}</span>
      </button>
      {open && (
        <div
          className="chat-summary-marker-text"
          id={`${id}-region`}
          role="region"
          aria-labelledby={`${id}-toggle`}
        >
          {summary}
        </div>
      )}
    </div>
  )
}

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
 *
 * F6 (a11y fallback): a table-only or very long run-on answer can go a long time with no sentence
 * terminator, leaving the announcer silent until completion. When the UNANNOUNCED tail grows past a
 * soft cap with no new terminator, we flush up to the last WORD boundary instead, so AT still hears
 * progress. (A pure code block is stripped to ~nothing by stripMarkdown — voicing code punctuation
 * is worse a11y than silence — so that case stays intentionally quiet; the surrounding prose still
 * announces. Recorded as an accepted residual in known-limitations.)
 */
const ANNOUNCE_SOFT_CAP = 160

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
    // Prefer the last completed-sentence boundary; if none is new, fall back to a word boundary once
    // the unannounced tail is long enough (F6) so a terminator-less answer isn't held silent.
    let boundary = lastSentenceBoundary(text)
    if (boundary <= announcedLenRef.current) {
      if (text.length - announcedLenRef.current < ANNOUNCE_SOFT_CAP) return
      boundary = lastWordBoundary(text, announcedLenRef.current)
      if (boundary <= announcedLenRef.current) return
    }
    const next = stripMarkdown(text.slice(announcedLenRef.current, boundary)).trim()
    announcedLenRef.current = boundary
    if (next !== '') setAnnounced(next)
  }, [text])

  return (
    // No aria-atomic (F23): this is an ADDITIVE log — we feed it only the newest completed
    // sentence, so the AT should read what was ADDED. aria-atomic="true" forces a re-read of the
    // ENTIRE region on every change (re-announcing prior sentences; double-speak on fast
    // boundaries), defeating the sentence-slicing above. role="log" defaults to atomic=false.
    <div className="sr-only" role="log" aria-live="polite">
      {announced}
    </div>
  )
}

/**
 * F6 fallback: index just past the last whitespace in the unannounced tail (so we announce only
 * complete words and hold back the trailing partial). A single unbroken token past the cap returns
 * `text.length` — flush it whole rather than stall the announcer forever.
 */
function lastWordBoundary(text: string, from: number): number {
  for (let i = text.length - 1; i > from; i--) {
    if (/\s/.test(text[i]!)) return i + 1
  }
  return text.length
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

// The math plugin (KaTeX) is module-level so its reference is stable across renders — a fresh
// object each render would defeat Streamdown's block memoization. Default delimiters: $$…$$ block
// and \(…\)/\[…\] — NOT single `$` (avoids mangling prose like "$5 and $10" as math).
const mdPlugins = { math }

// Pare Streamdown's default rehype chain (raw → sanitize → harden) down to just `sanitize`:
//  • drop `rehype-raw` so model-emitted HTML is NEVER parsed into live elements — it renders as
//    literal text instead (the app's long-standing no-injection posture: `<img onerror=…>` and
//    `<script>` show as text, not as a stripped-but-present <img>/<script> node).
//  • drop `rehype-harden` (link/image-origin rewriting): redundant here — the CSP already blocks
//    remote images (`img-src 'self' data:`) and the `a` override below is the link gate; harden only
//    muddied output with "[blocked]" rewrites and trailing-slash href normalization.
// `sanitize` stays as defence-in-depth. KaTeX's rehype plugin rides in via `plugins`, independent of
// this list, so math is unaffected. Module-level for a stable reference (memoization).
const mdRehypePlugins = [defaultRehypePlugins.sanitize]

// Module-level so the reference is stable across every render — defining this inline in JSX would
// hand Streamdown a fresh `components` object on each ~40 ms flush, busting the block memoization
// that makes the live bubble O(n) instead of O(n²) (the whole point of FE-1 revisited).
const mdComponents = {
  // Streamdown renders `**bold**` as a Tailwind-classed <span> (font-semibold). This app ships
  // no Tailwind, so that span would be UNSTYLED — map it back to a semantic <strong> the
  // existing `.md strong` CSS styles (and screen readers announce as emphasis). Every other
  // markdown element already comes out semantic (<em>, <code>, <h1>, <li>, <table>, …).
  strong: ({ children }: { children?: ReactNode }) => <strong>{children}</strong>,
  // Whitelist http(s) only (audit L1): a model could emit a `javascript:`/`data:` href.
  // rehype-sanitize already strips dangerous schemes and the CSP + window-open handler block
  // execution/navigation, so this is belt-and-suspenders — a disallowed scheme renders as
  // inert text, not a link.
  a: ({ href, children }: { href?: string; children?: ReactNode }) =>
    isSafeHttpUrl(href) ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    )
}

/**
 * Assistant replies render as Markdown (GFM + KaTeX math) via Streamdown, a streaming-aware
 * drop-in for react-markdown — local models emit Markdown and showing raw `**asterisks**` reads as
 * broken output. Streamdown splits the text into blocks and memoizes each, and (when `streaming`)
 * `parseIncompleteMarkdown` closes dangling syntax so the live bubble formats cleanly instead of
 * flashing raw markers. It builds React elements (no innerHTML) and runs rehype-sanitize, so scripts
 * and event handlers are stripped; with the strict CSP the no-injection posture holds. Streamdown's
 * own link-safety modal is disabled in favour of the existing posture: links are whitelisted to
 * http(s) and open in the OS browser via the main process's window-open handler. Code-block controls
 * are disabled (they ship Tailwind-styled chrome this app doesn't load). User turns stay plain text.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  streaming = false
}: {
  text: string
  /** Live bubble: parse incomplete markdown so partial syntax renders without flicker. */
  streaming?: boolean
}): JSX.Element {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      plugins={mdPlugins}
      rehypePlugins={mdRehypePlugins}
      controls={false}
      linkSafety={{ enabled: false }}
      components={mdComponents}
    >
      {text}
    </Streamdown>
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
