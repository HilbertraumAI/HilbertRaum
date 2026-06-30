// Benchmark: per-flush cost of the live streaming bubble — validates the FE-1-revisited claim that
// Streamdown's block memoization turns the streaming render from O(n²) (FE-1's original worry) into
// ~O(n) over the reply length, and probes the two flagged risks: (1) does parseIncompleteMarkdown
// reintroduce whole-buffer work each flush, (2) does memoization actually hold across re-renders.
//
// Method: simulate a reply streamed in `flushes` steps. At each step the buffer grows by one block.
// We render with react-dom/client into jsdom and flushSync each step (a real ~40 ms flush), timing
// the cumulative wall clock. Three paths, several reply sizes:
//   A) streaming  — same root re-rendered with growing text (Streamdown memoizes closed blocks)
//   B) reparse    — fresh key each flush, defeating memoization (FE-1's feared O(n²) strawman)
//   C) plaintext  — the pre-port baseline: a <div> with the raw text (trivially O(n) total)
// If A grows ~linearly with block count while B grows ~quadratically, the port's premise holds.
//
// Run: node scripts/bench-markdown-flush.mjs   (from apps/desktop)

import { JSDOM } from 'jsdom'

// jsdom globals must exist BEFORE importing React DOM / Streamdown.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const { window } = dom
globalThis.window = window
globalThis.document = window.document
// node 22 exposes `navigator` as a read-only getter — only override if it's writable/absent.
try {
  if (!globalThis.navigator) globalThis.navigator = window.navigator
} catch {
  /* read-only built-in navigator is fine for this bench */
}
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.getComputedStyle = window.getComputedStyle
window.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.matchMedia = window.matchMedia
globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = globalThis.ResizeObserver
globalThis.requestAnimationFrame ||= (cb) => setTimeout(() => cb(performance.now()), 0)
globalThis.cancelAnimationFrame ||= (id) => clearTimeout(id)

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const { Streamdown, defaultRehypePlugins } = await import('streamdown')
const { math } = await import('@streamdown/math')

const h = React.createElement
const mdPlugins = { math }
const mdRehypePlugins = [defaultRehypePlugins.sanitize]

// One realistic markdown "block" of streamed reply. Mixes prose, a bold span, an inline-code span,
// a list, a fenced code block and a KaTeX display block — the shapes a tax/finance answer emits.
function block(i) {
  return [
    `## Section ${i}`,
    '',
    `Paragraph **${i}** with \`inline code\` and a [link](https://example.com/${i}).`,
    '',
    '- item one',
    '- item two',
    '',
    '```js',
    `const x${i} = ${i} * 1.21 // 21% VAT`,
    '```',
    '',
    `Effective rate: $$r_{${i}} = \\frac{tax_{${i}}}{base_{${i}}}$$`,
    ''
  ].join('\n')
}

function streamdownEl(text, { streaming, parseIncomplete, key }) {
  return h(
    Streamdown,
    {
      key,
      mode: streaming ? 'streaming' : 'static',
      parseIncompleteMarkdown: parseIncomplete,
      plugins: mdPlugins,
      rehypePlugins: mdRehypePlugins,
      controls: false,
      linkSafety: { enabled: false }
    },
    text
  )
}

// Render `blocks` blocks across the same number of flushes, timing the whole stream. `mode`:
//  'streaming' → memoized (path A), 'reparse' → fresh key each flush (path B),
//  'plaintext' → a plain <div> (path C).
function streamReply(blocks, mode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let buffer = ''
  const t0 = performance.now()
  for (let i = 0; i < blocks; i++) {
    buffer += (i ? '\n\n' : '') + block(i)
    let el
    if (mode === 'plaintext') {
      el = h('div', { className: 'msg-content' }, buffer)
    } else if (mode === 'reparse') {
      // Fresh key each flush → no memoization, full re-parse: FE-1's feared O(n²) strawman.
      el = streamdownEl(buffer, { streaming: true, parseIncomplete: true, key: i })
    } else if (mode === 'stream-noparse') {
      // Memoized streaming WITHOUT parseIncompleteMarkdown — isolates the parse-incomplete cost.
      el = streamdownEl(buffer, { streaming: true, parseIncomplete: false, key: 'live' })
    } else {
      // The shipped live-bubble config: memoized streaming + parseIncompleteMarkdown.
      el = streamdownEl(buffer, { streaming: true, parseIncomplete: true, key: 'live' })
    }
    flushSync(() => root.render(el))
  }
  const total = performance.now() - t0
  flushSync(() => root.unmount())
  container.remove()
  return total
}

const SIZES = [10, 20, 40, 80]
const MODES = ['plaintext', 'streaming', 'stream-noparse', 'reparse']
const REPEATS = 3

// Warm up (JIT, first-parse plugin init) so the first timed size isn't penalised.
streamReply(8, 'streaming')

console.log('blocks | ' + MODES.map((m) => m.padStart(14)).join(' | '))
console.log('-'.repeat(9 + MODES.length * 17))
const results = {}
for (const n of SIZES) {
  const row = {}
  for (const mode of MODES) {
    let best = Infinity
    for (let r = 0; r < REPEATS; r++) best = Math.min(best, streamReply(n, mode))
    row[mode] = best
  }
  results[n] = row
  console.log(
    String(n).padStart(6) +
      ' | ' +
      MODES.map((m) => `${row[m].toFixed(1)}ms`.padStart(14)).join(' | ')
  )
}

// Scaling check: total stream time / blocks. For O(n) total this per-block figure is ~flat as n
// grows; for O(n²) total it grows ~linearly with n. Report the ratio between the largest and
// smallest size — ~1× means linear, ~Nx means quadratic.
console.log('\nper-block (total/blocks), and small→large growth ratio:')
const small = SIZES[0]
const large = SIZES[SIZES.length - 1]
for (const mode of MODES) {
  const perSmall = results[small][mode] / small
  const perLarge = results[large][mode] / large
  const ratio = perLarge / perSmall
  const verdict = ratio < 1.8 ? 'O(n)  ✓ flat' : ratio > 3 ? 'O(n²) ✗ grows' : 'mixed'
  console.log(
    `  ${mode.padEnd(10)} ${perSmall.toFixed(2)}ms → ${perLarge.toFixed(2)}ms / block  ` +
      `(${ratio.toFixed(1)}× over ${small}→${large} blocks)  ${verdict}`
  )
}
