import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

// Nested-live-region guard (#436).
//
// The M-U1 discipline says a live region must be MOUNTED BEFORE its text arrives, so assistive
// tech hears a text change inside a present region rather than a pre-filled region appearing.
// The app grew always-mounted wrappers everywhere for exactly that — and then defeated two of
// them by nesting `role="status"` INSIDE the wrapper. `status` is not a quiet label: it carries
// an implicit `aria-live="polite"`, so it becomes the nearest live-region ancestor of the text
// and is itself inserted already full. Narrator (2026-09-09) heard nothing from `ErrorBanner`
// — the shared failure surface of 11 screens plus the workspace gate — for as long as it shipped
// that way, and `aria-live="off"` on the inner node does NOT rescue it; the role has to go.
//
// So: no live-region element in the renderer may contain another one. This is a syntactic guard
// over JSX with STRING-LITERAL attributes, which is precisely the shape both real defects had
// (`<Banner tone="error" role="status">` inside `<div role="alert" aria-live="assertive">`).
//
// Known limits, stated so nobody reads more assurance into a green run than it earns:
//   - A child COMPONENT that renders a live region internally (e.g. <Toast/>) is invisible here;
//     the scan does not resolve component bodies.
//   - A role supplied by a computed expression (`role={cond ? 'status' : undefined}`) is skipped.
// Both are only reachable by ear. The by-ear leg stays the acceptance for #436/#437.

const LIVE_ROLES = new Set(['alert', 'status', 'log', 'timer', 'marquee'])

/** The renderer is the only tree with JSX; main/preload have none to scan. */
function listRendererFiles(): string[] {
  const root = join(process.cwd(), 'src', 'renderer')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.tsx')) files.push(full)
    }
  }
  walk(root)
  return files
}

function attrs(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes
}

/** The string-literal value of `name` on this element, or undefined (absent / computed). */
function literalAttr(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | undefined {
  for (const prop of attrs(node).properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name) continue
    const init = prop.initializer
    if (init && ts.isStringLiteral(init)) return init.text
    // `role={'status'}` — a literal wearing braces is still a literal.
    if (init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) {
      return init.expression.text
    }
    return undefined
  }
  return undefined
}

/** Does this element declare a live region via a literal `role` or `aria-live`? */
function isLiveRegion(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  const role = literalAttr(node, 'role')
  if (role !== undefined && LIVE_ROLES.has(role)) return true
  const live = literalAttr(node, 'aria-live')
  return live === 'polite' || live === 'assertive'
}

function tagOf(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText()
}

interface Violation {
  file: string
  line: number
  outer: string
  inner: string
}

function findNestedLiveRegions(file: string): Violation[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Violation[] = []
  const relative = file.replace(/[\\/]+/g, '/').split('/src/renderer/')[1] ?? file

  // `outer` is the nearest enclosing live region, or null. Depth-first so the nearest one wins.
  const walk = (node: ts.Node, outer: { tag: string } | null): void => {
    let nextOuter = outer
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (isLiveRegion(node)) {
        if (outer) {
          found.push({
            file: relative,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            outer: outer.tag,
            inner: tagOf(node)
          })
        }
        nextOuter = { tag: tagOf(node) }
      }
    }
    ts.forEachChild(node, (child) => walk(child, nextOuter))
  }
  walk(source, null)
  return found
}

describe('no live region nests inside another (#436)', () => {
  it('finds no nested live-region role anywhere in the renderer', () => {
    const violations = listRendererFiles().flatMap(findNestedLiveRegions)
    const rendered = violations.map((v) => `${v.file}:${v.line} <${v.inner}> inside <${v.outer}>`)
    expect(rendered).toEqual([])
  })

  // The guard is worth nothing if it cannot see the shape that actually shipped. Both fixtures
  // are the real defects, reduced: ErrorBanner's wrapper and the ModelsScreen download panel.
  it('detects the shape that shipped (a Banner role="status" inside an alert wrapper)', () => {
    const fixture = join(process.cwd(), 'tests', 'unit', '__live-region-fixture__.tsx')
    const source = ts.createSourceFile(
      fixture,
      `export const X = () => (
         <div className="error-banner-region" role="alert" aria-live="assertive">
           {show && <Banner tone="error" role="status">{message}</Banner>}
         </div>
       )`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    // Re-run the same walk over the fixture text via the shared helper's parse path.
    const found: string[] = []
    const walk = (node: ts.Node, outer: string | null): void => {
      let next = outer
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (isLiveRegion(node)) {
          if (outer) found.push(`${tagOf(node)} inside ${outer}`)
          next = tagOf(node)
        }
      }
      ts.forEachChild(node, (child) => walk(child, next))
    }
    walk(source, null)
    expect(found).toEqual(['Banner inside div'])
  })

  it('accepts the fixed shape (the nested Banner carries no role)', () => {
    const source = ts.createSourceFile(
      'ok.tsx',
      `export const X = () => (
         <div className="error-banner-region" role="alert" aria-live="assertive">
           {show && <Banner tone="error" role={null}>{message}</Banner>}
         </div>
       )`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const found: string[] = []
    const walk = (node: ts.Node, outer: string | null): void => {
      let next = outer
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (isLiveRegion(node)) {
          if (outer) found.push(tagOf(node))
          next = tagOf(node)
        }
      }
      ts.forEachChild(node, (child) => walk(child, next))
    }
    walk(source, null)
    expect(found).toEqual([])
  })
})
