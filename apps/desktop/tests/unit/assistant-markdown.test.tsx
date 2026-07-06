// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AssistantMarkdown } from '../../src/renderer/chat/Transcript'

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
