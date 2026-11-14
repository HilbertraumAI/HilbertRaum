// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { tNodes } from '../../src/renderer/i18nNodes'
import { t, type UiLanguage } from '../../src/shared/i18n'

// `tNodes` (#804): a catalog pattern rendered around React nodes, so a join that carries markup
// (the bold role name of a Performance row, the glyph before a review decision) still takes the
// language's own pattern. English joins with a plain ": ", so the screens' English rows cannot tell
// the pattern from a hard-coded join; these rows use languages whose pattern differs. Compared by
// code point (U+00A0 spelled out): testing-library's text matchers fold U+00A0 into a space.

afterEach(cleanup)

const shown = (s: string | null | undefined): string => (s ?? '').split(String.fromCharCode(0xa0)).join('<nbsp>')
const bound = (lang: UiLanguage) => (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
  t(lang, key, params)

describe('tNodes — a catalog pattern around React nodes (#804)', () => {
  it('puts the French no-break space before the colon and keeps the label’s markup', () => {
    const { container } = render(
      <p>{tNodes(bound('fr'), 'common.labelValue', { label: <strong>Discussion</strong>, value: 'Qwen3 4B' })}</p>
    )
    const p = container.querySelector('p')!
    expect(shown(p.textContent)).toBe('Discussion<nbsp>: Qwen3 4B')
    expect(p.firstElementChild?.tagName).toBe('STRONG')
    expect(p.querySelector('strong')?.textContent).toBe('Discussion')
  })

  it('follows the order of the language’s pattern (Turkish puts the percent sign first)', () => {
    const { container } = render(<p>{tNodes(bound('tr'), 'common.percent', { pct: <b>15</b> })}</p>)
    const p = container.querySelector('p')!
    expect(p.textContent).toBe('%15')
    expect(p.lastElementChild?.tagName).toBe('B')
  })
})
