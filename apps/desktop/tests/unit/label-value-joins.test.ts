import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'

// Label-value joins built in code (#804, open-issues wave owner call G-4). A ": " or a spaced dash
// typed between a label and its value follows English typography in every interface language:
// French writes U+00A0 before a colon, and Spanish, French, Italian, Dutch, Polish and Turkish do
// not use the em dash there. The renderer joins with the catalog's `common.labelValue` instead (`t`
// for a string, `tNodes` in renderer/i18nNodes.tsx when the label carries markup).
//
// A syntactic scan of src/renderer/**/*.tsx for the join shapes the renderer has used: a JSX colon
// right after an expression or an element (`{label}: {value}`, `{label}:{' '}`,
// `</strong>: {value}`), a template `${label}: ${value}` or `… — ${value}`, and a `': '` or `' — '`
// string. What it cannot see: a join assembled from variables (`label + sep + value`) or one in a
// .ts file (the renderer has none today). The copied reports keep their plain joins on purpose (a
// pasted report stays searchable), so their builders are on ALLOWED below, each with its reason.

interface Join {
  /** Path under src/renderer, with forward slashes. */
  file: string
  line: number
  /** The nearest named function around the join ('' at module level). */
  scope: string
  shape: string
  /** The source text of the join's node. */
  text: string
}

const DASH = ' — '

/** The name of the nearest named function (a declaration, a method, or a function bound to a const). */
function scopeOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText()
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text
    }
  }
  return ''
}

/** Every join shape in one file's source. */
function joinsIn(file: string, source: string): Join[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Join[] = []
  const add = (node: ts.Node, shape: string, text = node.getText(sf)): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    found.push({ file, line, scope: scopeOf(node), shape, text })
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && (node.text === ': ' || node.text === DASH)) {
      add(node, `the string ${JSON.stringify(node.text)}`)
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head, ...node.templateSpans.map((span) => span.literal)]
      parts.forEach((part, i) => {
        const before = i > 0
        const after = i < parts.length - 1
        if (before && after && part.text.startsWith(': ')) add(node, 'a template ${label}: ${value}')
        if (after && part.text.endsWith(DASH)) add(node, 'a template … — ${value}')
      })
    }
    if (ts.isJsxText(node) && node.text.trimStart().startsWith(':')) {
      const siblings = (node.parent as ts.JsxElement | ts.JsxFragment).children
      const previous = siblings[siblings.indexOf(node) - 1]
      if (
        previous &&
        (ts.isJsxExpression(previous) || ts.isJsxElement(previous) || ts.isJsxSelfClosingElement(previous))
      ) {
        add(node, 'a JSX colon after an expression or an element', `${previous.getText(sf)}${node.getText(sf)}`.trim())
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function rendererJoins(): Join[] {
  const root = join(process.cwd(), 'src', 'renderer')
  const joins: Join[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.tsx')) {
        joins.push(...joinsIn(relative(root, full).split('\\').join('/'), readFileSync(full, 'utf8')))
      }
    }
  }
  walk(root)
  return joins
}

/** The joins that stay, each with its reason. An entry names a file and a function, or a file and
 *  the join's exact source text; a file alone covers the whole file. */
const ALLOWED: ReadonlyArray<{ file: string; scope?: string; text?: string; reason: string }> = [
  {
    file: 'screens/PerformanceScreen.tsx',
    scope: 'buildReport',
    reason:
      'the Performance Copy report: its code-built joins stay a plain ": " so a pasted report is searchable (open-issues wave G-4)'
  },
  {
    file: 'screens/settings/DiagnosticsTab.tsx',
    scope: 'buildAppRuntimeReport',
    reason: 'the App & runtime Copy report: plain ": " joins, searchable when pasted (open-issues wave G-4)'
  },
  {
    file: 'screens/settings/DiagnosticsTab.tsx',
    scope: 'buildBenchmarkReport',
    reason: 'the Hardware benchmark Copy report: plain ": " joins, searchable when pasted (open-issues wave G-4)'
  },
  {
    file: 'App.tsx',
    text: "`HilbertRaum — ${t('nav.home')}`",
    reason:
      'the brand link’s tooltip and accessible name: the product name, then the screen it opens; left as is (open-issues wave G-4)'
  },
  {
    file: 'screens/ReviewScreen.tsx',
    text: "`${t('review.selection.remove')} — ${t('review.item.aria', { n: index + 1 })}`",
    reason: 'an accessible name: the action, then the item it acts on, not a label and its value; left as is (#804)'
  },
  {
    file: 'preview/preview.tsx',
    reason: 'the screenshot harness’s own case labels, developer text that no app screen shows'
  }
]

const isAllowed = (j: Join, entry: (typeof ALLOWED)[number]): boolean =>
  j.file === entry.file &&
  (entry.scope === undefined || j.scope === entry.scope) &&
  (entry.text === undefined || j.text === entry.text)

describe('label-value joins in the renderer come from the catalog (#804)', () => {
  it.each([
    ['a JSX colon after an expression', "<p>{t('a')}: {b}</p>"],
    ['a JSX colon before a spacer', "<li>{t('a')}:{' '}{n}</li>"],
    ['a JSX colon after an element', '<p><strong>{a}</strong>: {b}</p>'],
    ['a colon string', "<p><strong>{a}</strong>{': '}{b}</p>"],
    ['a dash string', "<dd>{a}{' — '}<a href={h}>{l}</a></dd>"],
    ['a template colon join', 'const s = `${a}: ${b}`'],
    ['a template colon join with more after it', 'const s = `${a}: ${b} (${c})`'],
    ['a template dash join', 'const s = `${a} — ${b}`'],
    ['a template dash join after fixed text', 'const s = `Name — ${b}`']
  ])('finds %s', (_label, source) => {
    expect(joinsIn('fixture.tsx', source)).toHaveLength(1)
  })

  it.each([
    ['the catalog pattern', "const s = t('common.labelValue', { label: a, value: b })"],
    ['an object literal’s key and value', "const MIME = { 'image/png': 'PNG' }"],
    ['a destructured parameter’s type', 'function F({ a }: { a: string }) { return a }'],
    ['a colon inside JSX text', '<p>Note: {a}</p>'],
    ['a host and port', 'const s = `${host}:${port}`'],
    ['a template that ends in a colon', 'const s = `${a}: `'],
    ['a comment', '// {a}: {b} and `${a}: ${b}`']
  ])('leaves %s alone', (_label, source) => {
    expect(joinsIn('fixture.tsx', source)).toEqual([])
  })

  it('names the function a join sits in', () => {
    const source = [
      'function buildReport() { return [1].map((n) => `${a}: ${n}`) }',
      'const row = () => `${a}: ${b}`',
      'const top = `${a}: ${b}`'
    ].join('\n')
    expect(joinsIn('fixture.tsx', source).map((j) => j.scope)).toEqual(['buildReport', 'row', ''])
  })

  it('src/renderer has no join outside the allowed ones', () => {
    const offenders = rendererJoins().filter((j) => !ALLOWED.some((entry) => isAllowed(j, entry)))
    expect(
      offenders.map((j) => `${j.file}:${j.line} ${j.shape}: ${j.text}`),
      'a label and a value joined in code: use t("common.labelValue", { label, value }), or tNodes ' +
        '(renderer/i18nNodes.tsx) when the label carries markup. A join that must stay (a copied ' +
        'report’s plain ": ") goes on ALLOWED with its reason.'
    ).toEqual([])
  })

  it('every allowed entry still matches a join', () => {
    const joins = rendererJoins()
    const stale = ALLOWED.filter((entry) => !joins.some((j) => isAllowed(j, entry)))
    expect(stale.map((entry) => `${entry.file} ${entry.scope ?? entry.text ?? ''}`)).toEqual([])
  })
})
