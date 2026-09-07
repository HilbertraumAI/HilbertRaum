import { cloneElement, isValidElement, memo, type ReactElement, type ReactNode } from 'react'
import { Streamdown, defaultRehypePlugins, useIsCodeFenceIncomplete } from 'streamdown'
import { math } from '@streamdown/math'
import { codeBlockExtension } from '@shared/code-block-export'
import { useCodeBlockActions, type CodeBlockActions } from './CodeBlockActionsContext'
import { useT } from '../i18n'
// katex is already in the bundle via @streamdown/math → rehype-katex; imported directly only
// to VALIDATE partially-streamed TeX before typesetting it (completePartialTex below).
import katex from 'katex'
import 'katex/dist/katex.min.css'

// Streamdown + KaTeX markdown renderer for assistant replies. Split out of Transcript.tsx into
// its own module (perf: renderer code-split) so the streamdown/katex/@streamdown/math weight
// (~2 MB pre-split) loads as a separate async chunk via AssistantMarkdownLazy — the app shell and
// non-chat screens no longer carry it in the initial bundle. Consumers import the lazy wrapper
// (barrel `AssistantMarkdown`), never this module directly.

// The math plugin (KaTeX) is module-level so its reference is stable across renders — a fresh
// object each render would defeat Streamdown's block memoization. remark-math parses ONLY
// $$…$$ — NOT single `$` (deliberately off: it mangles prose like "$5 and $10" as math) and NOT
// the LaTeX-style \(…\)/\[…\] delimiters; those are normalized to $$ by
// `normalizeMathDelimiters` below before the text reaches Streamdown.
const mdPlugins = { math }

// Local models emit LaTeX-style `\[ … \]` / `\( … \)` math at least as often as the `$$` form,
// but remark-math parses only `$`-delimiters — bracket math silently degraded to literal
// "[ … ]" text (commonmark eats the backslashes as escapes). Normalize brackets → `$$…$$`
// before Streamdown, SKIPPING fenced blocks and inline code spans so a code sample mentioning
// `\[x\]` stays verbatim. `\[ … \]` on its own lines becomes flow math (display); `\( … \)`
// becomes `$$…$$` inline math text (single-`$` stays off, so dollar prose is still safe).
// One O(n) pass per text change — the same whole-buffer class as parseIncompleteMarkdown; an
// unclosed `\[ …` mid-stream stays literal until its `\]` arrives, then converts on that flush.
// ponytail: regex-over-segments, not a markdown AST walk — revisit only if a real transcript
// shows a false positive (e.g. prose containing a literal backslash-bracket pair).
// Capturing split: even indices are prose, odd indices are code (fences first, then spans).
// An UNCLOSED trailing fence swallows to end-of-text as a code part, so a streaming buffer
// that currently ends inside a fence lands on an odd index and is left alone.
const CODE_SPLIT_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/

function normalizeMathDelimiters(text: string): string {
  if (!text.includes('\\[') && !text.includes('\\(')) return text
  const parts = text.split(CODE_SPLIT_RE)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]!
      // Line-anchored \[ … \] first: micromark's DISPLAY (flow) math needs `$$` on its own
      // lines, so a block-shaped bracket pair becomes the fence form…
      .replace(
        /^[ \t]*\\\[([\s\S]+?)\\\][ \t]*$/gm,
        (_m, inner: string) => `$$\n${inner.trim()}\n$$`
      )
      // …and anything left (mid-sentence brackets, \( … \)) becomes inline math text.
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$$${inner}$$`)
  }
  return parts.join('')
}

// A partially-streamed TeX expression usually is NOT valid TeX (a `\frac{…` cut mid-group
// throws, and rehype-katex then falls back to raw error text — worse than showing nothing).
// Complete it: cut a half-streamed macro name / dangling `^`/`_`, close unbalanced brace
// groups, and if the result still lacks a pending argument group (e.g. `\frac{X}` awaiting
// its denominator) try an appended `{}` — then VALIDATE with KaTeX itself (already in the
// bundle via rehype-katex) and only emit TeX that actually parses. Returns null when the
// partial is unsalvageable this flush (e.g. `\left(` before its `\right` arrives) — the
// caller then hides the math tail instead of flashing raw TeX; it appears once parseable.
function completePartialTex(tex: string): string | null {
  let t = tex
    .replace(/\\[a-zA-Z]*$/, '') // half-streamed macro name (`\fra`) or lone trailing `\`
    .replace(/[\^_]\s*$/, '') // trailing sub/superscript operator awaiting its argument
    .trimEnd()
  let depth = 0
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '\\') {
      i++ // skip the escaped char — `\{` is not a group open
    } else if (c === '{') {
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
    }
  }
  t += '}'.repeat(depth)
  if (t.trim() === '') return null
  for (const candidate of [t, `${t}{}`]) {
    try {
      katex.renderToString(candidate, { throwOnError: true })
      return candidate
    } catch {
      // try the next candidate / fall through to null
    }
  }
  return null
}

// Streaming companion to `normalizeMathDelimiters`: mid-stream, a trailing `\[ …` / `\( …`
// whose CLOSING delimiter hasn't arrived yet can't be claimed by the whole-text pass, so the
// raw TeX would flash until the close streamed in. Streamdown's `remend` hook runs custom
// handlers over the buffer on every flush (streaming mode only, before block-splitting) —
// complete the dangling opener to a CLOSED `$$…$$` there (via `completePartialTex`, so only
// TeX that actually parses is typeset; an unsalvageable partial is held back this flush).
// A prose `\[` that never closes shows as math only WHILE streaming; the persisted turn
// re-renders static (no remend) through the whole-text pass and is literal again.
function completeTrailingBracketMath(text: string): string {
  if (!text.includes('\\[') && !text.includes('\\(')) return text
  const parts = text.split(CODE_SPLIT_RE)
  const last = parts.length - 1
  if (last % 2 === 1) return text // the buffer currently ends inside code — leave it alone
  const tail = parts[last]!
  // The LAST opener in the trailing prose segment; a closed pair was already converted to $$
  // by normalizeMathDelimiters, so anything still bracket-form here is the dangling tail.
  const b = tail.lastIndexOf('\\[')
  const p = tail.lastIndexOf('\\(')
  const open = Math.max(b, p)
  if (open === -1) return text
  const isBlock = open === b
  if (tail.indexOf(isBlock ? '\\]' : '\\)', open) !== -1) return text // actually closed
  const inner = tail.slice(open + 2)
  if (inner.trim() === '') return text // just the opener so far — nothing to typeset yet
  const fixed = completePartialTex(inner)
  // Not (yet) parseable even after completion → hide the math tail this flush rather than
  // flash raw TeX / a KaTeX error box; a later flush with more tokens will pick it up.
  if (fixed === null) {
    parts[last] = tail.slice(0, open)
    return parts.join('')
  }
  const blockShaped = isBlock && /(^|\n)[ \t]*$/.test(tail.slice(0, open))
  parts[last] = tail.slice(0, open) + (blockShaped ? `$$\n${fixed}\n$$` : `$$${fixed}$$`)
  return parts.join('')
}

// Module-level (stable reference for Streamdown's memoization). Priority 10 puts the handler
// BEFORE remend's built-in links completion (20) — that handler treats a dangling `\[ …` tail
// as an incomplete LINK, completes it to `](streamdown:incomplete-link)`, and EARLY-RETURNS
// the whole pipeline, so at any later priority we would never run. Converting first also means
// links sees no unclosed `[` and the katex built-in (70) sees our `$$` already balanced.
const mdRemend = {
  handlers: [{ name: 'latex-bracket-math', priority: 10, handle: completeTrailingBracketMath }]
}

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

// ---------------------------------------------------------------------------------------------
// #286 — the per-code-block Copy / Save toolbar.
//
// WHY `pre` AND NOT `code`: Streamdown's default `pre` is literally
// `({children}) => isValidElement(children) ? cloneElement(children, {'data-block':'true'}) : children`
// — it exists only to STAMP the child <code> as a block; the default `code` component then reads
// that stamp and renders the whole `<div data-streamdown="code-block">` (header row with the
// language + `<pre><code>` body), and renders `<code data-streamdown="inline-code">` without it.
// Overriding `code` would therefore mean re-implementing Streamdown's block chrome (and would have
// to re-handle inline code); overriding `pre` lets us keep every pixel of it and merely wrap.
//
// `controls={false}` STAYS (owner decision D4): Streamdown's own download control is a
// blob + `<a download>` in the renderer, which bypasses the main-process write boundary (the
// native save dialog IS the consent). Ours goes through `window.api.saveCodeBlock`.

/** The block's exact code value + its fence language token, read off the child <code> element. */
function readCodeChild(child: ReactElement): { content: string; language: string } {
  const props = child.props as { className?: string; children?: unknown }
  // Mirror Streamdown's own extraction: the highlighted body may be a string or a single
  // element wrapping one.
  const inner = props.children
  let raw = ''
  if (typeof inner === 'string') {
    raw = inner
  } else if (isValidElement(inner)) {
    const nested = (inner.props as { children?: unknown }).children
    if (typeof nested === 'string') raw = nested
  }
  // mdast-util-to-hast appends ONE '\n' to every code node's value (`value ? value + '\n' : ''`).
  // D1 says "verbatim" = the code value AS PARSED, so strip exactly that one newline — otherwise
  // every saved file would gain a byte the markdown never contained.
  const content = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const language = /language-([^\s]+)/.exec(props.className ?? '')?.[1] ?? ''
  return { content, language }
}

/**
 * The hover/focus toolbar over one fenced block. Mounted ONLY when the transcript provided
 * CodeBlockActions — which is also why it may use the i18n hook: AssistantMarkdown itself renders
 * in contexts with no I18nProvider (unit tests, other screens) and the bare `pre` path below must
 * stay hook-free for them.
 */
function CodeBlockToolbar({
  actions,
  content,
  language
}: {
  actions: CodeBlockActions
  content: string
  language: string
}): JSX.Element | null {
  const { t } = useT()
  // Mid-stream the closing fence may not have arrived, so the "code" so far is a partial the user
  // should not be saving. (Belt-and-braces: the live bubble is never given a provider at all.)
  const incomplete = useIsCodeFenceIncomplete()
  if (incomplete) return null
  // Distinct accessible names per block: the extension comes from the SHARED allowlist, so the
  // label can never promise an extension main would not use.
  const saveTitle = t('chat.code.saveTitle', { ext: codeBlockExtension(language) })
  const copyTitle = t('chat.code.copyTitle')
  return (
    <div className="code-block-actions">
      <button
        type="button"
        className="msg-action"
        title={copyTitle}
        aria-label={copyTitle}
        onClick={() => actions.onCopy(content)}
      >
        {t('chat.code.copy')}
      </button>
      <button
        type="button"
        className="msg-action"
        title={saveTitle}
        aria-label={saveTitle}
        onClick={() => actions.onSave(content, language)}
      >
        {t('chat.code.save')}
      </button>
    </div>
  )
}

/**
 * `pre` override. With NO CodeBlockActions in context this is byte-for-byte Streamdown's default
 * (clone the child with the `data-block` stamp) — so every non-transcript consumer, inline code,
 * and the live streaming bubble keep the exact DOM they had before #286.
 */
function CodeBlockPre({ children }: { children?: ReactNode }): JSX.Element {
  const actions = useCodeBlockActions()
  if (!isValidElement(children)) return <>{children}</>
  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    'data-block': 'true'
  })
  if (actions === null) return <>{child}</>
  const { content, language } = readCodeChild(children)
  return (
    <div className="code-block">
      {child}
      <CodeBlockToolbar actions={actions} content={content} language={language} />
    </div>
  )
}

// Module-level so the reference is stable across every render — defining this inline in JSX would
// hand Streamdown a fresh `components` object on each ~40 ms flush, busting the block memoization
// that makes the live bubble O(n) instead of O(n²) (the whole point of FE-1 revisited).
const mdComponents = {
  // #286: the Copy/Save toolbar wrapper (a no-op passthrough without the transcript's context).
  pre: CodeBlockPre,
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
      remend={mdRemend}
      plugins={mdPlugins}
      rehypePlugins={mdRehypePlugins}
      controls={false}
      linkSafety={{ enabled: false }}
      components={mdComponents}
    >
      {normalizeMathDelimiters(text)}
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
