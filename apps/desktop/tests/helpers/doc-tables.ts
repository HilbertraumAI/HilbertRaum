// The tables of a committed markdown doc, for rows that hold an inventory the doc keeps to the code or the committed
// catalog (ocr-pins: the OCR asset table; committed-catalog: the download hosts and the runtime hash tables, #769).
// Text only, like repo-files.ts: no src/main imports.
import { repoText } from './repo-files'

const HEADING = /^(#+)\s/
const FENCE = /^\s*```/
const SEPARATOR_CELL = /^:?-+:?$/

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * The body rows of every table in one section of a repo markdown file, each as its trimmed cells without the outer
 * pipes (`cells[0]` is the first column). The section starts at the one heading line that begins with `heading` (its
 * `#` marks included) and runs to the next heading of the same or a higher level. Lines inside a ``` fence are neither
 * headings nor rows. Header rows and `|---|` separators are dropped; a `|` inside a cell is not supported (no table
 * read here has one). Throws unless exactly one heading matches, so a renamed or duplicated heading fails the row
 * instead of reading nothing.
 */
export function docTableRows(heading: string, ...rel: string[]): string[][] {
  const level = HEADING.exec(heading)?.[1].length
  if (level === undefined) throw new Error(`not a markdown heading: "${heading}"`)
  let fenced = false
  const lines = repoText(...rel)
    .split(/\r?\n/)
    .map((text) => {
      const fence = FENCE.test(text)
      if (fence) fenced = !fenced
      return { text, prose: !fence && !fenced }
    })
  const headingLevel = (i: number): number | undefined =>
    lines[i].prose ? HEADING.exec(lines[i].text)?.[1].length : undefined
  const starts = lines.flatMap((line, i) => (headingLevel(i) !== undefined && line.text.startsWith(heading) ? [i] : []))
  if (starts.length !== 1) {
    throw new Error(`${rel.join('/')}: ${starts.length} headings start with "${heading}", expected exactly 1`)
  }
  let end = starts[0] + 1
  for (; end < lines.length; end++) {
    const at = headingLevel(end)
    if (at !== undefined && at <= level) break
  }

  const rows: string[][] = []
  let table: string[][] = []
  const flush = (): void => {
    // Everything up to the `|---|` separator is the header; a block without one is kept whole.
    const separator = table.findIndex((cells) => cells.every((cell) => SEPARATOR_CELL.test(cell)))
    rows.push(...table.slice(separator + 1))
    table = []
  }
  for (const { text, prose } of lines.slice(starts[0] + 1, end)) {
    if (prose && text.trimStart().startsWith('|')) table.push(cellsOf(text))
    else if (table.length > 0) flush()
  }
  if (table.length > 0) flush()
  return rows
}
