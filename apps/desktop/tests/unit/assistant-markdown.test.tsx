// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
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
    // mermaid plugin is passed (mdPlugins = { math }); wiring one in makes that chain a live
    // attack surface — this pin fails and forces a re-triage. Ledger: architecture.md
    // "Dependabot triage — design record (wave DEP-3)".
    const { container } = render(
      <AssistantMarkdown text={'```mermaid\ngraph TD; A-->B\n```'} />
    )
    // Streamdown stamps plugin-rendered diagrams with this attribute (the chart itself mounts
    // async behind Suspense, so asserting on <svg> would never fire).
    expect(container.querySelector('[data-streamdown="mermaid-block"]')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('graph TD; A-->B')
  })
})

describe('AssistantMarkdown math (KaTeX)', () => {
  it('renders block math as real KaTeX output with the matching JS/CSS version', () => {
    // Smoke test for the version-skew blocker: rehype-katex must render with the SAME katex
    // whose CSS/fonts Transcript.tsx loads. With a skew, KaTeX either misrenders or warns; a
    // deduped single install (package.json pins ~0.16.47 to match @streamdown/math's chain)
    // resolves 'katex' to one copy — assert it actually typesets.
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

  it('the installed katex package is a single, deduped version', async () => {
    // Filesystem walk mirroring node resolution (@streamdown/math and rehype-katex are
    // ESM-only, so require.resolve cannot chain through them). The CSS/fonts come from the
    // katex OUR import resolves; the math HTML comes from the katex rehype-katex resolves —
    // KaTeX requires matched JS/CSS versions (PR review blocker 2).
    const { readFileSync, existsSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const version = (p: string) =>
      (JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')) as { version: string }).version
    // The copy OUR `import 'katex/dist/katex.min.css'` resolves (CSS + fonts):
    const ourKatex = dirname(require.resolve('katex/package.json'))
    // The copy rehype-katex resolves (renders the math HTML) — check the app-local and the
    // hoisted workspace-root install locations, then node's lookup order for its katex.
    const appNm = join(__dirname, '..', '..', 'node_modules')
    const rootNm = join(__dirname, '..', '..', '..', '..', 'node_modules')
    const rkDir = [
      join(appNm, 'rehype-katex'),
      join(rootNm, '@streamdown/math/node_modules/rehype-katex'),
      join(rootNm, 'rehype-katex')
    ].find(existsSync)
    expect(rkDir, 'rehype-katex must be installed (via @streamdown/math)').toBeTruthy()
    const rkKatex = [
      join(rkDir!, 'node_modules/katex'),
      join(dirname(rkDir!), 'katex'),
      join(rootNm, 'katex')
    ].find(existsSync)
    expect(rkKatex, 'rehype-katex must resolve a katex install').toBeTruthy()
    expect(
      version(rkKatex!),
      'katex CSS/fonts version must equal the version rehype-katex renders with'
    ).toBe(version(ourKatex))
  })
})
