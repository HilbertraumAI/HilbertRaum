import { memo, type ReactNode } from 'react'
import { Streamdown, defaultRehypePlugins } from 'streamdown'
import { math } from '@streamdown/math'
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
