// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, screen, within } from '@testing-library/react'
import { Composer } from '../../src/renderer/chat/Composer'
import { DepthMenu } from '../../src/renderer/chat/DepthMenu'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { SkillPicker } from '../../src/renderer/chat/SkillPicker'
import { clearDocTaskSession } from '../../src/renderer/lib/doctasks'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { t } from '../../src/shared/i18n'
import { makeDocumentInfo, makeSkillInfo } from '../helpers/chat-fixtures'
import { renderInLanguage } from '../helpers/render-language'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { appStatus } from '../helpers/status'

// #803 (open-issues wave, owner call G-9 and owner round W5-1): the layout at the 880×600 minimum
// window. jsdom lays nothing out, so no row here can see a control past the window's edge; what a
// row can see is which declaration WINS. The real styles.css is parsed by jsdom (its CSSOM expands
// `padding` and `flex` into longhands) and `cascaded()` below picks the winner the way a browser
// does: every rule with a selector the element matches at rest (`Element.matches`, so ancestors and
// combinators count), `!important` first, then specificity, then source order. A row therefore holds
// the outcome, not a rule's text: a reorder that keeps it stays green, one that loses it goes red.
// jsdom's own getComputedStyle is not used: it lets a later, less specific shorthand overwrite an
// earlier, more specific longhand (it gives the filter 10 px where Chromium draws 32 px, fix 1's very
// case). A rule inside @media counts as applying, and a winner that comes from one is reported with
// its condition, so it fails the row: a rule there that undoes a fix turns the row red, and so does
// a fix that lives only there. Limits (none reachable in today's sheet): `text-wrap` set after
// `white-space` is not read; `display` is not pinned (the label's ellipsis needs the trigger to stay
// a flex container); `@layer` would be read as plain source order and nested rules are not walked.
// Rows 1, 5 and 6 read the real components' markup; rows 2 to 4 build bare elements with the class
// names ChatScreen.tsx and App.tsx render (rendering those screens is heavy), so a markup change
// there is the walk's to catch. The behavioural proof is the real-app walk at 880×600: rect checks
// for Send, the rail foot, the labels.

const STYLES = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8')

/** Every style rule in source order, with the condition of the at-rule it sits in (null: none). */
let rules: Array<{ rule: CSSStyleRule; condition: string | null }> = []

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.appendChild(style)
  const walk = (list: CSSRuleList, condition: string | null): void => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) rules.push({ rule, condition })
      else if ('cssRules' in rule) walk((rule as CSSMediaRule).cssRules, (rule as CSSMediaRule).media?.mediaText ?? rule.cssText.split('{')[0].trim())
    }
  }
  rules = []
  walk((style.sheet as CSSStyleSheet).cssRules, null)
})

afterEach(() => {
  cleanup()
  clearDocTaskSession()
  document.body.replaceChildren()
  window.localStorage.clear()
})

/** A selector list split at its top-level commas. */
function splitList(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(list.slice(start).trim())
  return out
}

type Specificity = [number, number, number]
const compare = (a: Specificity, b: Specificity): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const highest = (list: Specificity[]): Specificity => [...list].sort(compare)[list.length - 1]

/** Selectors Level 4 specificity of one complex selector (ids, classes/attributes/pseudo-classes, types). */
function specificity(selector: string): Specificity {
  const s: Specificity = [0, 0, 0]
  let rest = selector.replace(/:(not|is|has|where)\(((?:[^()]|\([^()]*\))*)\)/g, (_m, fn: string, args: string) => {
    // :not() / :is() / :has() count as their most specific argument; :where() counts nothing.
    if (fn !== 'where') highest(splitList(args).map(specificity)).forEach((n, i) => (s[i] += n))
    return ' '
  })
  rest = rest.replace(/\[[^\]]*\]/g, () => (s[1]++, ' '))
  rest = rest.replace(/::[\w-]+(\([^)]*\))?/g, () => (s[2]++, ' '))
  rest = rest.replace(/:[\w-]+(\([^)]*\))?/g, () => (s[1]++, ' '))
  rest = rest.replace(/#[\w-]+/g, () => (s[0]++, ' '))
  rest = rest.replace(/\.[\w-]+/g, () => (s[1]++, ' '))
  s[2] += (rest.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length
  return s
}

/** Shorthands jsdom's CSSOM keeps whole, read as the longhand a row asks for (left-to-right text). */
const SHORTHANDS: Record<string, Array<[string, (value: string) => string]>> = {
  'padding-left': [
    ['padding-inline-start', (v) => v],
    ['padding-inline', (v) => v.split(/\s+/)[0]]
  ],
  'overflow-x': [['overflow', (v) => v.split(/\s+/)[0]]],
  'overflow-y': [['overflow', (v) => v.split(/\s+/).at(-1) ?? v]],
  'min-width': [['min-inline-size', (v) => v]],
  'min-height': [['min-block-size', (v) => v]],
  'row-gap': [['gap', (v) => v.split(/\s+/)[0]]],
  'column-gap': [['gap', (v) => v.split(/\s+/).at(-1) ?? v]],
  'flex-wrap': [['flex-flow', (v) => v.split(/\s+/).find((word) => word.includes('wrap')) ?? 'nowrap']]
}

/**
 * The value the cascade gives `property` on `element` at rest ('' when no rule sets it). A winner
 * from inside an at-rule comes back as `<value> (only under <condition>)`, which no row accepts.
 */
function cascaded(element: Element, property: string): string {
  const names: Array<[string, (value: string) => string]> = [[property, (v) => v], ...(SHORTHANDS[property] ?? [])]
  let best: { value: string; important: boolean; spec: Specificity; order: number; condition: string | null } | null =
    null
  for (const [order, { rule, condition }] of rules.entries()) {
    const matching = splitList(rule.selectorText).filter((selector) => {
      try {
        return element.matches(selector)
      } catch {
        return false
      }
    })
    // Within one rule the later declaration wins (`gap: 12px; row-gap: 4px`).
    const items = Array.from({ length: rule.style.length }, (_, i) => rule.style.item(i))
    const declared = names
      .filter(([name]) => rule.style.getPropertyValue(name) !== '')
      .sort(([a], [b]) => items.lastIndexOf(a) - items.lastIndexOf(b))
      .at(-1)
    if (matching.length === 0 || !declared) continue
    const [name, read] = declared
    const decl = {
      value: read(rule.style.getPropertyValue(name)),
      important: rule.style.getPropertyPriority(name) === 'important',
      spec: highest(matching.map(specificity)),
      order,
      condition
    }
    const wins =
      best === null ||
      (decl.important !== best.important ? decl.important : (compare(decl.spec, best.spec) || decl.order - best.order) > 0)
    if (wins) best = decl
  }
  if (best === null) return ''
  return best.condition === null ? best.value : `${best.value} (only under ${best.condition})`
}

/** `cascaded` for an inherited property: the value of the nearest element up the tree that sets it. */
function inherited(element: Element, property: string): string {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = cascaded(node, property)
    if (value !== '') return value
  }
  return ''
}

/** A bare element carrying the classes the component renders, appended under `parent`. */
function el(tag: string, className: string, parent: Element = document.body): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  parent.appendChild(node)
  return node
}

describe('#803 layout at 880×600 — what the stylesheet cascade decides', () => {
  it("the Documents filter's icon padding survives `.text-input` (fix 1)", async () => {
    // The real screen's filter (it shows once there is a document). It carries both classes, and
    // `.text-input`'s `padding: 8px 10px` comes later in the file, so a one-class rule lost the left
    // padding and the magnifier sat on the placeholder ("lter by name…").
    // What the screen reads at mount: one indexed document, no projects, nothing running.
    stubApi({
      listDocuments: vi.fn(async () => [makeDocumentInfo()]),
      listCollections: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => appStatus()),
      getReindexAllJob: vi.fn(async () => null),
      getActiveImportJob: vi.fn(async () => null)
    })
    renderInLanguage(<DocumentsScreen />, 'en')
    const input = await screen.findByRole('searchbox', { name: t('en', 'docs.filter.aria') })
    expect(cascaded(input, 'padding-left')).toBe('32px')
    expect(cascaded(input, 'min-height')).toBe('36px')
    assertNoUnexpectedApiCalls()
  })

  it('the chat column has no min-content floor, so its `1fr` track fits the window (fix 2a)', () => {
    const main = el('section', 'chat-main', el('div', 'chat-layout'))
    expect(cascaded(main, 'min-width')).toBe('0px')
  })

  it('the rail scrolls with no scrollbar taking label width (fix 2b)', () => {
    // The labels are sized to the pixel (German «Einstellungen» has 0.3 px of headroom in the
    // 106 px column), so a classic ~15 px bar would clip them exactly when the rail scrolls.
    const rail = el('nav', 'sidebar', el('div', 'app-shell'))
    expect(cascaded(rail, 'overflow-y')).toBe('auto')
    expect(cascaded(rail, 'min-height')).toBe('0px')
    expect(cascaded(rail, 'scrollbar-width')).toBe('none')
  })

  it('the rail never scrolls sideways: a label wider than the column clips at its edge (owner round W5-6)', () => {
    // With `overflow-y: auto` alone the x axis computes to `auto` too, so a too-wide label would
    // let the rail scroll sideways with no visible bar.
    const rail = el('nav', 'sidebar', el('div', 'app-shell'))
    expect({ x: cascaded(rail, 'overflow-x'), y: cascaded(rail, 'overflow-y') }).toEqual({ x: 'hidden', y: 'auto' })
  })

  it("none of the rail's children shrinks, so the rail scrolls instead (owner round W5-1)", () => {
    // The rail's children as App.tsx renders them (the lock button only in an encrypted
    // workspace). Without this the global `button { min-height: 24px }` let the brand, the lock
    // button and the indicator squeeze to 24 px, and "Lock now" drew over the indicator's icon.
    const rail = el('nav', 'sidebar', el('div', 'app-shell'))
    const children = [
      'brand',
      'nav-list',
      'nav-list nav-group',
      'nav-list nav-bottom',
      'lock-btn',
      'local-indicator local-indicator-sidebar'
    ].map((cls) => el(cls.startsWith('nav-list') ? 'ul' : 'button', cls, rail))
    expect(children.map((c) => `${c.className}: ${cascaded(c, 'flex-shrink')}`)).toEqual(
      children.map((c) => `${c.className}: 0`)
    )
  })

  it('a `.nowrap` phrase does not break inside, on the Performance tile and the Diagnostics card (#805 S3, owner round W5-4)', () => {
    // `keepTogether` puts "(12 cores)" in this span (the screens' rows pin that); both containers
    // allow a break anywhere (`overflow-wrap: anywhere`), which a nowrap span leaves no opportunity for.
    const onTile = el('span', 'nowrap', el('div', 'perf-tile-sub', el('div', 'perf-tile')))
    const inCard = el('span', 'nowrap', el('dd', '', el('dl', 'kv')))
    expect([inherited(onTile, 'white-space'), inherited(inCard, 'white-space')]).toEqual(['nowrap', 'nowrap'])
  })

  it("the composer footer moves a control that doesn't fit to the next row (owner round W5-3)", () => {
    // A 100-case live measurement (owner round W5-3) found a wrapping footer clean in every case,
    // where squeezing or capping the triggers drew text outside its box.
    const footer = renderFooter()
    expect(cascaded(footer, 'flex-wrap')).toBe('wrap')
    expect(cascaded(footer, 'row-gap')).toBe('4px')
  })

  it('the skill trigger stays on one line and past a whole row ends in "…"; ⓘ × keep their size (owner rounds W5-1…W5-5)', () => {
    const footer = renderFooter()
    const title = makeSkillInfo().title
    // The trigger never wraps and keeps `.footer-menu-btn`'s cap (100%: a whole footer row). Its
    // group never shrinks (the next row pins that), so the trigger gives way only when its name is
    // longer than a whole row: then it shrinks beside ⓘ × (which don't) and its label ends in "…"
    // (measured in Chromium: with the trigger rigid, ⓘ × ran 72 px past the footer).
    const held = (b: HTMLElement) => ({
      shrinks: cascaded(b, 'flex-shrink') !== '0',
      noWrap: cascaded(b, 'white-space') === 'nowrap',
      maxWidth: cascaded(b, 'max-width')
    })
    const triggerTexts = [
      t('en', 'chat.skill.trigger', { label: title }),
      t('en', 'chat.skill.trigger', { label: t('en', 'chat.skill.none') })
    ]
    const triggers = triggerTexts.map((name) => ({ name, trigger: screen.getByRole('button', { name }) }))
    const others = {
      scopeChip: within(footer.querySelector<HTMLElement>('.scope-footer-wrap')!).getByRole('button'),
      depth: screen.getByRole('button', { name: /^Answer detail: / }),
      info: screen.getByRole('button', { name: t('en', 'chat.skill.infoButton', { title }) }),
      clear: screen.getByRole('button', { name: t('en', 'chat.skill.clear', { title }) }),
      hint: screen.getByRole('button', { name: t('en', 'chat.skill.suggestedHint', { title }) })
    }
    // No button the render produced is left unchecked.
    expect(footer.querySelectorAll('button')).toHaveLength(triggers.length + Object.keys(others).length)
    for (const { name, trigger } of triggers) {
      expect(held(trigger)).toEqual({ shrinks: true, noWrap: true, maxWidth: '100%' })
      // Past the cap the element holding the text ellipsises (it inherits the trigger's nowrap).
      // The caret sits beside it, not inside it (inside, it would be clipped with the text), and
      // no rule resets its automatic minimum width, so it never shrinks.
      const label = within(trigger).getByText(name)
      expect(label).not.toBe(trigger)
      expect({
        minWidth: cascaded(label, 'min-width'),
        overflowX: cascaded(label, 'overflow-x'),
        textOverflow: cascaded(label, 'text-overflow'),
        whiteSpace: inherited(label, 'white-space')
      }).toEqual({ minWidth: '0px', overflowX: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
      const caret = trigger.querySelector('[aria-hidden="true"]')!
      expect(caret.textContent).toBe('▾')
      expect(caret.parentElement).toBe(trigger)
      expect(cascaded(caret, 'min-width')).toBe('')
    }
    const keepSize = new Set<HTMLElement>([others.info, others.clear])
    for (const [name, button] of Object.entries(others)) {
      expect(held(button), name).toEqual({ shrinks: !keepSize.has(button), noWrap: false, maxWidth: '100%' })
    }
  })

  it('the skill trigger and its ⓘ × wrap onto a new footer row as one; the hint stays outside (owner round W5-5)', () => {
    const footer = renderFooter()
    const title = makeSkillInfo().title
    const active = screen.getByRole('button', { name: t('en', 'chat.skill.trigger', { label: title }) })
    const idle = screen.getByRole('button', { name: t('en', 'chat.skill.trigger', { label: t('en', 'chat.skill.none') }) })
    const info = screen.getByRole('button', { name: t('en', 'chat.skill.infoButton', { title }) })
    const clear = screen.getByRole('button', { name: t('en', 'chat.skill.clear', { title }) })
    const hint = screen.getByRole('button', { name: t('en', 'chat.skill.suggestedHint', { title }) })
    // One footer item per picker: the active one holds its trigger, ⓘ and × in that order, the idle
    // one its trigger alone; the hint (an alternative to an active trigger) is a footer item itself.
    const groups = [
      { group: active.parentElement!, members: [active, info, clear] },
      { group: idle.parentElement!, members: [idle] }
    ]
    for (const { group, members } of groups) {
      expect(group.parentElement).toBe(footer)
      expect(group.children).toHaveLength(members.length)
      members.forEach((member, i) => expect(group.children[i]).toBe(member))
      // It lays them out 12 px apart, as the footer spaces its items, and never shrinks below its
      // natural width up to a whole row: that is what holds "Skill: No skill" at full width now
      // that the trigger itself may give way inside it.
      expect({
        display: cascaded(group, 'display'),
        flexShrink: cascaded(group, 'flex-shrink'),
        columnGap: cascaded(group, 'column-gap'),
        maxWidth: cascaded(group, 'max-width')
      }).toEqual({ display: 'inline-flex', flexShrink: '0', columnGap: '12px', maxWidth: '100%' })
    }
    expect(cascaded(footer, 'column-gap')).toBe('12px')
    expect(hint.parentElement).toBe(footer)
  })
})

/**
 * The real Composer with every button these four components render in this state: the scope chip,
 * the depth menu, an active skill's trigger with its ⓘ and ×, and an idle trigger with its
 * suggestion hint. Not covered: ScopePopover's "Add documents" button (no indexed document) and
 * SkillRunBar's target chooser. (The scope chip and the depth menu never share a footer.)
 * Returns the footer row: the element the Composer puts the footer nodes in.
 */
function renderFooter(): HTMLElement {
  const skill = makeSkillInfo()
  const noop = (): void => {}
  renderInLanguage(
    <Composer
      value=""
      onChange={noop}
      onSend={noop}
      onStop={noop}
      streaming={false}
      placeholder="Ask about your documents…"
      sendLabel="Ask"
      footer={
        <>
          <span className="scope-footer-wrap">
            <ScopePopover docs={[makeDocumentInfo()]} collections={[]} scope={null} onChangeScope={noop} />
          </span>
          <DepthMenu value="balanced" onChange={noop} supportsThinking={false} />
          <SkillPicker skills={[skill]} value={skill.installId} onChange={noop} onInfo={noop} onClear={noop} />
          <SkillPicker skills={[skill]} value={null} onChange={noop} suggestion={{ installId: skill.installId, title: skill.title }} />
        </>
      }
    />,
    'en'
  )
  const footer = document.querySelector('.scope-footer-wrap')?.parentElement
  if (!footer) throw new Error('the Composer rendered no footer')
  return footer
}
