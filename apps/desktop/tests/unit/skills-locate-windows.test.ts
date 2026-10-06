import { describe, it, expect } from 'vitest'
import type { SkillTool } from '../../src/shared/types'
import type { ModelRuntime } from '../../src/main/services/runtime'
import {
  buildLocateWindows,
  estimateLocateTokens,
  splitLocateWindow
} from '../../src/main/services/skills/tools/locate-windows'
import { locateEntities, parseLocateReply } from '../../src/main/services/skills/tools/redaction-locate'
import {
  locateDocumentEdits,
  MAX_LOCATED_EDIT_CHARS,
  parseEditReply
} from '../../src/main/services/skills/tools/document-edit-locate'
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

// #622: windows sized to the model's context. Real token counts of numbered locate lines (synthetic
// documents), captured 2026-10-06 with llama-server b11146 `/tokenize`: [label, line, Qwen3 4B, Qwen3.5 9B].
// The app's plain word estimate (`approxTokenCount` × 2.2) gives the bank-statement line 53 — half its cost.
const MEASURED: Array<[string, string, number, number]> = [
  ['register', '2\t  Contact via Jonas Wagner at Nordlicht Consulting GmbH, phone +49 761 550001.', 28, 28],
  [
    'English paragraph',
    '1\tParagraph 1. In the matter concerning our client Marie Wolf, residing at Gartenstrasse 3, 79098 Freiburg, the firm confirms that the power of attorney dated in the spring quarter remains in force and that all correspondence with the opposing counsel shall continue to be routed through this office. Marie Wolf has asked that the supporting records held at the Nordlicht Consulting GmbH archive be reviewed once more before the hearing, and that any remaining questions about the settlement terms be answered in writing within the agreed period.',
    108,
    106
  ],
  [
    'German paragraph',
    '1\tAbsatz 1. In der Angelegenheit unserer Mandantin Marie Wolf, wohnhaft in der Gartenstraße 3, 79098 Freiburg im Breisgau, bestätigt die Kanzlei, dass die im Frühjahr erteilte Vollmacht weiterhin wirksam ist und sämtliche Korrespondenz mit der gegnerischen Prozessbevollmächtigten ausschließlich über diese Kanzlei zu führen ist. Marie Wolf bittet darum, die bei der Nordlicht Beratungsgesellschaft mbH archivierten Unterlagen vor der mündlichen Verhandlung nochmals zu prüfen und offene Fragen zur Vergleichsvereinbarung fristgerecht schriftlich zu beantworten.',
    171,
    131
  ],
  [
    'bank statement',
    '1\t2026-03-02  Überweisung an Marie Wolf, IBAN DE89 3704 0044 0532 0130 01, Verwendungszweck Rechnung 2026-0037 vom 2026-02-02, Betrag -1.011,90 EUR, Saldo 12.023,67 EUR',
    106,
    101
  ]
]

describe('estimateLocateTokens — the window budget is never under-counted (#622)', () => {
  it.each(MEASURED)('%s: at least the measured tokens of both tokenizers', (_label, line, qwen3, qwen35) => {
    expect(estimateLocateTokens(line)).toBeGreaterThanOrEqual(Math.max(qwen3, qwen35))
  })
})

/** ~540-character paragraphs, one per line — a DOCX paragraph is one line of the locate input. */
const paragraphs = (n: number): string =>
  Array.from(
    { length: n },
    (_, i) =>
      `Paragraph ${i + 1}. In the matter concerning our client Person${i + 1} Example, the firm confirms that the ` +
      'power of attorney remains in force and that all correspondence with the opposing counsel shall continue ' +
      'to be routed through this office. The client has asked that the supporting records held at the archive ' +
      'be reviewed once more before the hearing, and that any remaining questions about the settlement terms be ' +
      'answered in writing within the agreed period, as discussed with the partners at the last meeting.'
  ).join('\n')

/**
 * A piece starts at a word start and ends at a word end. Starting at "…Bil|der Text" would show the
 * model "der Text", and its edit "der → die, occurrence 1" would land inside "Bilder" (#622 review).
 */
function expectWholeWords(line: string, offset: number, length: number): void {
  const end = offset + length
  expect(offset === 0 || /\s/.test(line[offset - 1]), `piece at ${offset} starts mid-word`).toBe(true)
  expect(end === line.length || /\s/.test(line[end - 1]) || /\s/.test(line[end]), `piece ends mid-word at ${end}`).toBe(true)
}

/** The [start, end) character ranges of each line that some window's segments cover. */
function covered(windows: ReturnType<typeof buildLocateWindows>): Map<number, Array<[number, number]>> {
  const out = new Map<number, Array<[number, number]>>()
  for (const w of windows) {
    for (const s of w.segments) {
      const ranges = out.get(s.line) ?? []
      ranges.push([s.offset, s.offset + s.text.length])
      out.set(s.line, ranges)
    }
  }
  return out
}

describe('buildLocateWindows — a token budget (#622)', () => {
  it('keeps every window within the budget and still covers every line, in order', () => {
    const text = paragraphs(44)
    const windows = buildLocateWindows(text, { maxTokens: 600 })
    for (const w of windows) expect(estimateLocateTokens(w.numbered)).toBeLessThanOrEqual(600)
    expect(windows.map((w) => w.startLine)).toEqual([...windows.map((w) => w.startLine)].sort((a, b) => a - b))
    const ranges = covered(windows)
    text.split('\n').forEach((line, i) => {
      expect(ranges.get(i + 1)?.some(([a, b]) => a === 0 && b === line.length), `line ${i + 1}`).toBe(true)
    })
  })

  it('splits a line over the budget into verbatim, overlapping pieces: any span a pass may propose is whole in one', () => {
    const line = paragraphs(20).replaceAll('\n', ' ') // one 10,800-character line, e.g. a .txt without line breaks
    const windows = buildLocateWindows(line, { maxTokens: 600 })
    expect(windows.length).toBeGreaterThan(1)
    for (const w of windows) {
      expect(w.segments).toHaveLength(1) // two pieces of one line never share a window
      const [s] = w.segments
      expect(s.text).toBe(line.slice(s.offset, s.offset + s.text.length))
      expectWholeWords(line, s.offset, s.text.length)
      expect(estimateLocateTokens(w.numbered)).toBeLessThanOrEqual(600)
    }
    const pieces = covered(windows).get(1) ?? []
    const span = MAX_LOCATED_EDIT_CHARS // the longest: an edit `find` (redaction entities stop at 160)
    for (let p = 0; p + span <= line.length; p += 13) {
      expect(pieces.some(([a, b]) => a <= p && b >= p + span), `span at ${p}`).toBe(true)
    }
  })

  // A heading and an address block, then a dense paragraph whose pieces fill the budget: the overlap
  // after the short lines must not produce a window that only repeats them (a model call for nothing).
  it('never builds a window that only repeats the previous one', () => {
    const head = Array.from({ length: 30 }, (_, i) => `Short line ${i + 1}`).join('\n')
    const windows = buildLocateWindows(`${head}\n${paragraphs(10).replaceAll('\n', ' ')}`, { maxTokens: 600 })
    const key = (s: { line: number; offset: number }): string => `${s.line}:${s.offset}`
    for (let i = 1; i < windows.length; i++) {
      const before = new Set(windows[i - 1].segments.map(key))
      expect(windows[i].segments.some((s) => !before.has(key(s))), `window ${i + 1}`).toBe(true)
    }
  })

  it('halves a one-piece window into two shorter, overlapping whole-word pieces (a reply cut short)', () => {
    const line = paragraphs(4).replaceAll('\n', ' ')
    const [whole] = buildLocateWindows(line)
    const halves = splitLocateWindow(whole)
    expect(halves).not.toBeNull()
    const [a, b] = (halves ?? []).map((w) => w.segments[0])
    expect(a.offset).toBe(0)
    expect(b.offset + b.text.length).toBe(line.length)
    expect(b.offset).toBeLessThanOrEqual(a.text.length - MAX_LOCATED_EDIT_CHARS) // the overlap holds any span
    for (const p of [a, b]) {
      expect(p.text.length).toBeLessThan(line.length)
      expect(p.text).toBe(line.slice(p.offset, p.offset + p.text.length))
      expectWholeWords(line, p.offset, p.text.length)
    }
  })

  it('builds the same windows for a short-line document with or without a budget', () => {
    expect(buildLocateWindows(lines(73), { maxTokens: 1000 })).toEqual(buildLocateWindows(lines(73)))
  })

  // The issue's bound, at the walk: every request's system prompt + window + reply room, by the estimate
  // pinned above, stays inside the context the model was launched with.
  it.each([4096, 8192])('every locate request and its reply room fit a %i-token context', async (context) => {
    const calls: ScriptedCall[] = []
    const runtime: ModelRuntime = { ...scriptedRuntime('{"entities": []}', calls), contextWindow: () => context }
    await locateEntities(paragraphs(44), '', { runtime, signal: new AbortController().signal })
    expect(calls.length).toBeGreaterThan(0)
    for (const { messages, options } of calls) {
      const prompt = estimateLocateTokens(messages[0].content) + estimateLocateTokens(messages[1].content)
      expect(prompt + (options?.maxTokens ?? Infinity)).toBeLessThanOrEqual(context)
    }
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
