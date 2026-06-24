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
})
