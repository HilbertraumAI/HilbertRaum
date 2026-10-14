// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { AssistantMarkdown } from '../../src/renderer/chat/AssistantMarkdown'

// The security-critical invariants of the Streamdown-backed renderer (audit L1 + no-injection
// posture). Streamdown runs rehype-sanitize and we whitelist links to http(s); these assertions
// fail loudly if a future upgrade or prop change reopens a script/scheme hole. The markdown-
// formatting itself (bold, lists, GFM) is Streamdown's own covered behaviour, not re-tested here.

afterEach(cleanup)

describe('AssistantMarkdown security posture', () => {
  it('renders an http(s) link as a new-tab anchor', () => {
    const { container } = render(<AssistantMarkdown text="[ok](https://example.com)" />)
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toContain('noreferrer')
  })

  it('renders a javascript: link as inert text, not a clickable anchor', () => {
    const { container } = render(
      <AssistantMarkdown text="[x](javascript:alert(1))" />
    )
    const a = container.querySelector('a')
    // Either sanitize strips the href, or SafeLink downgrades it to a <span>; never a live js href.
    expect(a?.getAttribute('href') ?? '').not.toContain('javascript:')
    expect(container.textContent).toContain('x')
  })

  it('never emits a <script> element from raw HTML in model output', () => {
    const { container } = render(
      <AssistantMarkdown text={'before\n\n<script>window.__pwned=1</script>\n\nafter'} />
    )
    expect(container.querySelector('script')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('raw HTML stays LITERAL text — dropped rehype-raw, not parsed-then-sanitized', () => {
    // The <script> test above passes under EITHER posture (dropped or parsed-then-stripped).
    // This pins the stronger claim the config makes (mdRehypePlugins drops rehype-raw): benign
    // raw HTML must survive as VISIBLE literal text, not become a live element and not vanish.
    const { container } = render(
      <AssistantMarkdown text={'use <b>bold</b> and <img src="x.png"> here'} />
    )
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<b>bold</b>')
    expect(container.textContent).toContain('<img src="x.png">')
  })

  it('a fenced code block ships NO Streamdown download control (controls={false} stays off)', () => {
    // #286 D4: the ONLY save path for a code block is window.api.saveCodeBlock — main writes the
    // bytes behind the native dialog. Streamdown's own code-block controls are a renderer-side
    // blob + <a download> (and a navigator.clipboard copy), which bypass that write boundary
    // entirely. Turning `controls` on would mint them here — this pin fails if anyone does.
    // Without the transcript's CodeBlockActions context (this render has none) the block carries
    // no interactive chrome of ours either, so ZERO buttons is the correct assertion.
    const { container } = render(<AssistantMarkdown text={'```js\nconst a = 1\n```'} />)
    expect(container.querySelector('a[download]'), 'no blob download anchor').toBeNull()
    expect(container.querySelector('button'), 'no Streamdown code-block control buttons').toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('const a = 1')
  })

  it('renders a ```mermaid fence as a plain code block — the mermaid plugin stays absent', () => {
    // DEP-3 (2026-08-09) judged the mermaid/DOMPurify Dependabot alerts unreachable because no
    // mermaid plugin is passed (mdPlugins = { math }). Since streamdown 2.6 (#550) mermaid is not
    // installed at all; adopting `@streamdown/mermaid` would bring it, and DOMPurify, back as live
    // code — this pin fails and forces that decision (packaging.test.ts guards the dependency
    // graph). Ledger: architecture.md "Dependabot triage — design record (wave DEP-3)".
    const { container } = render(
      <AssistantMarkdown text={'```mermaid\ngraph TD; A-->B\n```'} />
    )
    // Streamdown stamps plugin-rendered diagrams with this attribute (the chart itself mounts
    // async behind Suspense, so asserting on <svg> would never fire).
    expect(container.querySelector('[data-streamdown="mermaid-block"]')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('graph TD; A-->B')
  })

  it('TeX commands that need KaTeX `trust` stay error text: no link, image, style, id or data attribute', () => {
    // DEP-7: KaTeX's output does not pass rehype-sanitize (streamdown appends the math plugin after
    // it), so KaTeX's `trust` option is that path's only gate, and nothing here sets it. KaTeX before
    // 0.18.2 also reads an INHERITED `trust` (GHSA-238p-pmpm-9mq7, a prototype-pollution gadget); that
    // alert was dismissed as a tolerable risk because no code turns `trust` on. Passing it to
    // rehype-katex fails this and reopens the triage. Ledger: architecture.md "Dependabot triage —
    // design record (wave DEP-7)".
    const commands = [
      ['\\href', '\\href{https://example.com/a}{a}'],
      ['\\url', '\\url{https://example.com/b}'],
      ['\\includegraphics', '\\includegraphics{https://example.com/c.png}'],
      ['\\htmlStyle', '\\htmlStyle{position:fixed}{d}'],
      ['\\htmlId', '\\htmlId{api}{e}'],
      ['\\htmlClass', '\\htmlClass{sidebar}{f}'],
      ['\\htmlData', '\\htmlData{foo=bar}{g}']
    ]
    // KaTeX reports each `\html*` command through its strict mode ("HTML extension is disabled").
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { container } = render(
        <AssistantMarkdown text={commands.map(([, tex]) => `$$${tex}$$`).join(' and ')} />
      )
      // KaTeX typeset every expression and printed each command as unsupported, so the absences
      // below are its verdict, not math that never reached it.
      const rendered = [...container.querySelectorAll('.katex-html')].map((e) => e.textContent)
      expect(rendered).toHaveLength(commands.length)
      commands.forEach(([name], i) => expect(rendered[i]).toContain(name))
      expect(container.querySelector('a, img, #api, .sidebar, [data-foo]')).toBeNull()
      expect(container.querySelector('[style*="position"]')).toBeNull()
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('[htmlExtension]'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  // streamdown 2.6 (#550) changed its sanitize schema twice; neither change may reach the DOM here.
  it('an incomplete streamed link renders as text, never as a link (2.6 lets `streamdown:` through)', () => {
    // remend completes a dangling `[text](https://exa` to `[text](streamdown:incomplete-link)`, and
    // 2.6's schema allows that scheme. The app's `a` override is the gate: only http(s) links.
    const { container } = render(
      <AssistantMarkdown streaming text={'See [the report](https://exa'} />
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('the report')
  })

  it('every id taken from the model text keeps its user-content- prefix (2.6 stopped re-prefixing)', () => {
    // 2.6 sets sanitize's clobberPrefix to '', leaving remark-rehype as the only prefixer. Names
    // like `api` or `document` must never become bare ids that could clobber a window global.
    const { container } = render(
      <AssistantMarkdown text={'Two claims[^api][^document].\n\n[^api]: One.\n\n[^document]: Two.'} />
    )
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id)
    expect(ids).toContain('user-content-fn-api')
    // `footnote-label` is remark-rehype's fixed heading id, not taken from the text.
    expect(ids.filter((id) => id !== 'footnote-label' && !id.startsWith('user-content-'))).toEqual([])
    expect(container.querySelector('[name]')).toBeNull()
  })
})

// Streamdown styles its chrome with Tailwind utilities, which this app does not load, so any
// layout it leaves to a utility class has to be supplied here. jsdom computes no layout: these pin
// the inputs; the measured proof (a real Electron render) is in architecture.md's DEP-6 record.
describe('AssistantMarkdown layout without Tailwind (#550)', () => {
  it('caps neither tables nor code blocks (2.6 defaults would let a tall one draw over what follows)', () => {
    const table = '| # | Name |\n|---|---|\n' + Array.from({ length: 20 }, (_, i) => `| ${i} | Row ${i} |`).join('\n')
    const code = '```js\n' + Array.from({ length: 30 }, (_, i) => `const a${i} = ${i}`).join('\n') + '\n```'
    const { container } = render(<AssistantMarkdown text={`${table}\n\n${code}`} />)
    const tableWrapper = container.querySelector('table')?.parentElement
    const codeBody = container.querySelector('[data-streamdown="code-block-body"]') as HTMLElement | null
    expect(tableWrapper).toBeTruthy()
    expect(codeBody).toBeTruthy()
    expect(tableWrapper!.style.maxHeight).toBe('')
    expect(codeBody!.style.maxHeight).toBe('')
  })

  it('styles.css breaks a code block into its lines (Streamdown leaves that to `block`)', () => {
    const stylesCss = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8')
    expect(stylesCss).toMatch(
      /\[data-streamdown="code-block-body"\] code > span\s*\{\s*display:\s*block;\s*\}/
    )
    // …and those are the elements Streamdown renders one per line.
    const { container } = render(<AssistantMarkdown text={'```js\nconst a = 1\n\nconst b = 2\n```'} />)
    const lines = container.querySelectorAll('[data-streamdown="code-block-body"] code > span')
    expect([...lines].map((l) => l.textContent)).toEqual(['const a = 1', '\n', 'const b = 2'])
  })

  it('styles.css zeroes a list item’s paragraph margins wherever the component renders (#685)', () => {
    // Streamdown 2.7 unwraps an item's only <p> and keeps the <p>s of an item with several, so where a
    // <p> inside a list item keeps a margin, one list is spaced unevenly. The Review item and the
    // Translate outputs have no Markdown rules of their own, so the rule keys on the component's root.
    const { container } = render(<AssistantMarkdown text={'1. Heizung\n\n2. Strom\n\n   inkl. Zähler\n\n3. Müll'} />)
    expect([...container.querySelectorAll('li')].map((li) => li.querySelectorAll(':scope > p').length)).toEqual([0, 2, 0])
    expect(container.querySelector('ol')!.closest('.assistant-md')).toBe(container.firstElementChild)
    const stylesCss = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8')
    expect(stylesCss).toMatch(/(^|\n)\.assistant-md li > p\s*\{\s*margin:\s*0;\s*\}/)
  })
})

describe('AssistantMarkdown math (KaTeX)', () => {
  it('renders block math as real KaTeX output with the matching JS/CSS version', () => {
    // Smoke test for the version-skew blocker: rehype-katex must render with the same katex
    // VERSION whose CSS/fonts AssistantMarkdown loads. With a skew, KaTeX either misrenders or
    // warns; package.json pins ~0.16.47 to match @streamdown/math's chain (two installed copies of
    // that version today, #698) — assert it actually typesets.
    const { container } = render(<AssistantMarkdown text={'$$\\frac{1}{2}$$'} />)
    const katexRoot = container.querySelector('.katex')
    expect(katexRoot, 'expected a .katex element from rehype-katex').not.toBeNull()
    // Real typeset output (the fraction bar), not the raw TeX fallback. The raw TeX still
    // appears inside the MathML <annotation> — that is correct KaTeX output, not a failure.
    expect(container.querySelector('.katex .frac-line')).not.toBeNull()
  })

  it('renders LaTeX-style \\[ … \\] display math (the form local models actually emit)', () => {
    // Regression: remark-math only parses $/$$ delimiters, so model-emitted \[ … \] silently
    // degraded to literal "[ … ]" (commonmark ate the backslashes). AssistantMarkdown normalizes
    // bracket delimiters to $$ before Streamdown.
    const { container } = render(
      <AssistantMarkdown
        text={'The series:\n\n\\[ \\pi = 4 \\sum_{k=0}^{\\infty} \\frac{(-1)^k}{2k+1} \\]\n\nconverges.'}
      />
    )
    expect(container.querySelector('.katex'), 'expected \\[ … \\] to typeset').not.toBeNull()
    expect(
      container.querySelector('.katex-display'),
      'own-line \\[ … \\] should be DISPLAY math'
    ).not.toBeNull()
  })

  it('renders LaTeX-style \\( … \\) inline math', () => {
    const { container } = render(
      <AssistantMarkdown text={'Einstein: \\( E = mc^2 \\) obviously.'} />
    )
    expect(container.querySelector('.katex'), 'expected \\( … \\) to typeset').not.toBeNull()
    expect(container.querySelector('.katex-display')).toBeNull() // inline, not display
  })

  it('does NOT convert bracket delimiters inside code', () => {
    const { container } = render(
      <AssistantMarkdown text={'```\n\\[ \\pi \\]\n```\n\nand inline `\\( x \\)` too'} />
    )
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('\\[ \\pi \\]')
  })

  it('leaves dollar prose alone (single $ is not math)', () => {
    const { container } = render(<AssistantMarkdown text={'costs $5 and $10 respectively'} />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$5 and $10')
  })

  it('promotes a single-$ span that looks like math to INLINE KaTeX (#501)', () => {
    // remark-math's own single-dollar mode stays off (it would claim "$5 and $10" too); the
    // normalization promotes only spans passing Pandoc's shape rule AND a math-content rule.
    for (const text of ['$E = mc^2$', '$m$', '$\\alpha_i$', '$x^2 + y^2$']) {
      const { container } = render(<AssistantMarkdown text={text} />)
      expect(container.querySelector('.katex'), `expected ${text} to typeset`).not.toBeNull()
      expect(container.querySelector('.katex-display'), `${text} is inline math`).toBeNull()
    }
  })

  it('promotes BOTH pairs in a sentence, and a span closed before punctuation (#501)', () => {
    const two = render(<AssistantMarkdown text={'$a=1$ and $b=2$'} />)
    expect(two.container.querySelectorAll('.katex')).toHaveLength(2)
    // The closer is followed by `-`: allowed (only a digit right after it would disqualify it).
    const axis = render(<AssistantMarkdown text={'The $x$-axis'} />)
    expect(axis.container.querySelector('.katex'), 'expected $x$ to typeset').not.toBeNull()
  })

  it('leaves currency, ranges and env vars as prose — the #501 promotion is not greedy', () => {
    for (const text of [
      'It costs $5 and $10',
      'between $5 and $10 per month',
      'US$ 20',
      'paid $5, $10 or $20',
      '$HOME/$USER are env vars'
    ]) {
      const { container } = render(<AssistantMarkdown text={text} />)
      expect(container.querySelector('.katex'), `${text} must stay prose`).toBeNull()
      expect(container.textContent).toContain(text)
    }
  })

  it('an escaped \\$ pair and a $ pair spanning two lines stay prose (#501)', () => {
    const escaped = render(<AssistantMarkdown text={'costs \\$5 and \\$10'} />)
    expect(escaped.container.querySelector('.katex')).toBeNull()
    expect(escaped.container.textContent).toContain('$5 and $10')
    // Inline math never spans a line break, so this is two literal dollars, not one span.
    const wrapped = render(<AssistantMarkdown text={'$a =\nb$'} />)
    expect(wrapped.container.querySelector('.katex')).toBeNull()
    expect(wrapped.container.textContent).toContain('$a =')
    expect(wrapped.container.textContent).toContain('b$')
  })

  it('does NOT promote single $ inside code (#501)', () => {
    const { container } = render(
      <AssistantMarkdown text={'```\n$x^2$\n```\n\nand inline `$y_1$` too'} />
    )
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$x^2$')
    expect(container.textContent).toContain('$y_1$')
  })

  it('leaves existing $$ math untouched: inline stays inline, own-line stays display (#501)', () => {
    const inline = render(<AssistantMarkdown text={'an $$x^2$$ inline'} />)
    expect(inline.container.querySelector('.katex'), 'expected $$…$$ to typeset').not.toBeNull()
    expect(inline.container.querySelector('.katex-display')).toBeNull()
    const display = render(<AssistantMarkdown text={'$$\n x \n$$'} />)
    expect(
      display.container.querySelector('.katex-display'),
      'own-line $$ block must stay DISPLAY math'
    ).not.toBeNull()
  })

  it('STREAMING: an unclosed trailing \\[ … typesets progressively (remend handler)', () => {
    // Mid-stream the closing \] has not arrived yet, so the whole-text normalization cannot
    // claim it — the custom remend handler completes the tail to closed $$ each flush.
    const { container } = render(
      <AssistantMarkdown text={'The series:\n\n\\[ \\pi = 4 \\sum_{k=0}^{\\infty}'} streaming />
    )
    expect(container.querySelector('.katex'), 'unclosed \\[ tail should typeset').not.toBeNull()
    expect(container.querySelector('.katex-display'), 'own-line \\[ tail is DISPLAY math').not.toBeNull()
  })

  it('STREAMING: an unclosed trailing \\( … typesets inline', () => {
    const { container } = render(<AssistantMarkdown text={'Einstein: \\( E = mc^2'} streaming />)
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('.katex-display')).toBeNull()
  })

  it('STREAMING: an unclosed \\[ inside a code fence stays verbatim', () => {
    const { container } = render(<AssistantMarkdown text={'```\n\\[ \\pi'} streaming />)
    expect(container.querySelector('.katex')).toBeNull()
  })

  it('STREAMING: a tail with an UNCLOSED BRACE GROUP still typesets (balanced + validated)', () => {
    // Field report (chudnovsky series mid-stream): the partial ends inside \frac{…'s first
    // group, so naive completion hands KaTeX invalid TeX → raw error text. The handler now
    // balances braces, appends a pending empty group where needed, and validates with KaTeX
    // before emitting $$.
    const { container } = render(
      <AssistantMarkdown
        text={'\\[ \\frac{1}{\\pi} = 12 \\sum_{k=0}^{\\infty} \\frac{(-1)^k (6k)! (13591409 + 5451401'}
        streaming
      />
    )
    expect(container.querySelector('.katex-display'), 'balanced partial should typeset').not.toBeNull()
    expect(container.querySelector('.katex-error'), 'must not render as a KaTeX error').toBeNull()
  })

  it('STREAMING: an unsalvageable partial is HIDDEN, not shown as raw TeX or an error', () => {
    // \left( with no \right cannot be balanced by brace-closing — hold the math back this
    // flush instead of flashing raw TeX; it appears once enough streams in to parse.
    const { container } = render(
      <AssistantMarkdown text={'so:\n\n\\[ \\left( x + 1'} streaming />
    )
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('.katex-error')).toBeNull()
    expect(container.textContent).not.toContain('\\left')
    expect(container.textContent).toContain('so:')
  })

  it('STREAMING: a half-streamed $ … tail typesets instead of flashing raw TeX (#501)', () => {
    const { container } = render(<AssistantMarkdown text={'Einstein: $E = mc^'} streaming />)
    expect(container.querySelector('.katex'), 'unclosed $ tail should typeset').not.toBeNull()
    expect(container.querySelector('.katex-display')).toBeNull()
    // The dangling `^` is cut by the completion, and no raw delimiter is left on screen.
    expect(container.textContent).not.toContain('mc^')
    expect(container.textContent).not.toContain('$E')
  })

  it('STREAMING: an ambiguous currency tail stays literal (#501)', () => {
    // Mid-stream "$5 and the" carries no TeX signal and has no closer to judge it by — the
    // static pass would keep it prose, so the streaming pass must not claim it either.
    const { container } = render(<AssistantMarkdown text={'it costs $5 and the'} streaming />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$5 and the')
  })

  it('STREAMING: an unsalvageable $ tail is HIDDEN, not shown as raw TeX or an error (#501)', () => {
    const { container } = render(<AssistantMarkdown text={'so:\n\n$\\left( x + 1'} streaming />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('.katex-error')).toBeNull()
    expect(container.textContent).not.toContain('\\left')
    expect(container.textContent).toContain('so:')
  })

  it('STREAMING: a $ tail inside an unclosed code fence stays verbatim (#501)', () => {
    const { container } = render(<AssistantMarkdown text={'```\n$x^2'} streaming />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$x^2')
  })

  it('STATIC: an unclosed \\[ stays literal (no remend on persisted turns — self-healing)', () => {
    // A prose bracket that never closes would render as math only while streaming; the
    // persisted re-render (static mode, no remend) shows it literally again.
    const { container } = render(<AssistantMarkdown text={'see \\[ this never closes'} />)
    expect(container.querySelector('.katex')).toBeNull()
  })

  it('the app and rehype-katex resolve one katex install, not two copies of it (#698)', async () => {
    // The CSS/fonts and the partial-TeX check (`completePartialTex`) come from the katex OUR
    // imports resolve; the math HTML comes from the katex rehype-katex resolves. KaTeX requires
    // matched JS/CSS versions (PR review blocker 2), and two copies of one version are two copies
    // in the renderer bundle (#698: four nested 0.16.47 installs, two of them bundled). Node's own
    // lookup paths are walked package by package: @streamdown/math and rehype-katex are ESM-only
    // and do not export their package.json, so require.resolve cannot reach them by name.
    const { existsSync, realpathSync } = await import('node:fs')
    const { createRequire } = await import('node:module')
    const { join, dirname } = await import('node:path')
    const packageDir = (fromDir: string, name: string): string | undefined =>
      createRequire(join(fromDir, 'noop.js'))
        .resolve.paths(name)
        ?.map((dir) => join(dir, name))
        .find((dir) => existsSync(join(dir, 'package.json')))
    const appDir = join(__dirname, '..', '..')
    const ourKatex = dirname(createRequire(join(appDir, 'package.json')).resolve('katex/package.json'))
    const streamdownMath = packageDir(appDir, '@streamdown/math')
    expect(streamdownMath, '@streamdown/math must be installed').toBeTruthy()
    const rehypeKatex = packageDir(streamdownMath!, 'rehype-katex')
    expect(rehypeKatex, 'rehype-katex must be installed (via @streamdown/math)').toBeTruthy()
    const rkKatex = dirname(createRequire(join(rehypeKatex!, 'package.json')).resolve('katex/package.json'))
    expect(realpathSync(rkKatex), 'rehype-katex must render with the katex install the app imports').toBe(
      realpathSync(ourKatex)
    )
  })

  // The bundle itself (#698): an import of another katex entry file (`katex/dist/katex.mjs`
  // beside rehype-katex's `katex`) would bundle two copies from one install, which the test above
  // cannot see. Runs against out/renderer; CI builds before it tests, and a local run without a
  // build skips (the csp-build-output idiom).
  const assets = join(__dirname, '..', '..', 'out', 'renderer', 'assets')
  it.skipIf(!existsSync(assets))('the built renderer carries KaTeX once (#698)', () => {
    // One literal of KaTeX's parser per copy: `ParseError`'s message prefix.
    const copies = readdirSync(assets)
      .filter((f) => f.endsWith('.js'))
      .reduce((n, f) => n + readFileSync(join(assets, f), 'utf8').split('KaTeX parse error').length - 1, 0)
    expect(copies, 'KaTeX copies in out/renderer/assets/*.js').toBe(1)
  })
})
