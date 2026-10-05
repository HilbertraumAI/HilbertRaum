import { describe, it, expect } from 'vitest'
import type { SkillTool } from '../../src/shared/types'
import type { ModelRuntime } from '../../src/main/services/runtime'
import { buildLocateWindows } from '../../src/main/services/skills/tools/locate-windows'
import { locateEntities, parseLocateReply } from '../../src/main/services/skills/tools/redaction-locate'
import { locateDocumentEdits, parseEditReply } from '../../src/main/services/skills/tools/document-edit-locate'
import { redactDocumentTool } from '../../src/main/services/skills/tools/redaction'
import { applyDocumentEditsTool } from '../../src/main/services/skills/tools/document-edit'
import { validateToolInput } from '../../src/main/services/skills/tool-registry'
import { scriptedRuntime, type ScriptedCall } from '../helpers/scripted-runtime'

// What the redaction (§21) and document-edit (§22) locate passes share (#583; architecture.md "Skills —
// design record"): the overlapping, globally line-numbered windows both walk, and a reply parser that
// must hand the tool gate only input its schema accepts.

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

// [line count, each window's [first, last] global line] — 40-line windows stepping by 32. 40 and 72 end
// exactly on a window's end (no tail window); 41 and 73 are one line past it — the rows a `>=` → `>`
// slip or a dropped break in the builder turns red.
const SIZES: Array<[number, Array<[number, number]>]> = [
  [0, []],
  [3, [[1, 3]]],
  [40, [[1, 40]]],
  [41, [[1, 40], [33, 41]]],
  [50, [[1, 40], [33, 50]]],
  [72, [[1, 40], [33, 72]]],
  [73, [[1, 40], [33, 72], [65, 73]]]
]

describe('buildLocateWindows — line-numbered overlapping windows', () => {
  it.each(SIZES)('%i lines ⇒ windows %j', (n, ranges) => {
    expect(buildLocateWindows(lines(n)).map((w) => [w.startLine, w.endLine])).toEqual(ranges)
  })

  it('numbers lines globally and overlaps so a boundary span is seen whole', () => {
    const windows = buildLocateWindows(lines(50))
    // The overlap: lines 33..40 appear in BOTH windows (so a span straddling line 40 is whole once).
    expect(windows[0].numbered).toContain('40\tline 40')
    expect(windows[1].numbered).toContain('33\tline 33')
    // Global numbering: the second window's first line carries its GLOBAL number, not a window-local 1.
    expect(windows[1].numbered.startsWith('33\t')).toBe(true)
  })

  it('a single short document is one window covering every line', () => {
    const windows = buildLocateWindows('a\nb\nc')
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ startLine: 1, endLine: 3 })
    expect(windows[0].numbered).toBe('1\ta\n2\tb\n3\tc')
  })
})

// The same table through each tool's public locate pass: one model call per window, fed its numbered lines.
type Locate = (text: string, deps: { runtime: ModelRuntime; signal: AbortSignal }) => Promise<unknown>

describe.each<[string, Locate, string]>([
  ['locateEntities', (text, deps) => locateEntities(text, '', deps), '{"entities": []}'],
  ['locateDocumentEdits', (text, deps) => locateDocumentEdits(text, 'der → die', deps), '{"edits": []}']
])('%s — one model call per window', (_name, locate, emptyReply) => {
  it.each(SIZES)('%i lines ⇒ calls over %j', async (n, ranges) => {
    const calls: ScriptedCall[] = []
    await locate(lines(n), { runtime: scriptedRuntime(emptyReply, calls), signal: new AbortController().signal })
    // Each call's user message is its window's numbered lines; read back the first and last global number.
    const fed = calls.map(({ messages }) => {
      const numbered = messages[1].content.split('\n')
      return [parseInt(numbered[0], 10), parseInt(numbered[numbered.length - 1], 10)]
    })
    expect(fed).toEqual(ranges)
  })
})

// #583: the tool schemas cap the strings at 160 (redaction `text`) and 200 (edit `find`/`replace`) UTF-16
// units, but llama-server's grammar bounds code points and a swapped runtime may ignore the schema. One
// over-long proposal made the gate refuse the WHOLE input after the full locate pass (the #134 failure
// class), so the parser drops it — never clips it, a clipped `find` would splice the wrong text.
const ASTRAL = String.fromCodePoint(0x1d49c) // one code point, two UTF-16 units

interface ParserRow {
  name: string
  parse: (reply: string) => unknown[]
  tool: SkillTool
  key: string
  overLong: object[]
  atCap: object
}

describe('locate replies — a proposal over the tool schema maxLength is dropped (#583)', () => {
  it.each<ParserRow>([
    {
      name: 'parseLocateReply → redact_document',
      parse: parseLocateReply,
      tool: redactDocumentTool,
      key: 'entities',
      // 81 code points (inside a code-point bound of 160) but 161 UTF-16 units.
      overLong: [{ text: ASTRAL.repeat(80) + 'a', category: 'name', line: 1 }],
      atCap: { text: ASTRAL.repeat(80), category: 'name', line: 2 }
    },
    {
      name: 'parseEditReply → apply_document_edits',
      parse: parseEditReply,
      tool: applyDocumentEditsTool,
      key: 'edits',
      overLong: [
        { line: 1, find: 'f'.repeat(201), occurrence: 1, replace: 'r' },
        { line: 1, find: 'f', occurrence: 1, replace: 'r'.repeat(201) }
      ],
      atCap: { line: 2, find: 'f'.repeat(200), occurrence: 1, replace: 'r'.repeat(200) }
    }
  ])('$name', ({ parse, tool, key, overLong, atCap }) => {
    const parsed = parse(JSON.stringify({ [key]: [...overLong, atCap] }))
    expect(validateToolInput(tool, { documentId: 'd', [key]: parsed })).toEqual([])
    expect(parsed).toEqual([atCap])
  })
})
