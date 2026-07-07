import { describe, it, expect } from 'vitest'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import {
  buildEditWindows,
  editLocateSchema,
  locateDocumentEdits,
  parseEditReply,
  type LocatedEdit
} from '../../src/main/services/skills/tools/document-edit-locate'
import { verifyAndSpliceEdits } from '../../src/main/services/skills/tools/document-edit'

// Phase 8 (beta-feedback-2026-07, #23, D76/D75/D78; architecture.md "Skills — design record" §22). The
// locate half (runtime-touching) + the verify/splice half (deterministic, runtime-free) of format-preserving
// targeted edits — the model ONLY locates occurrence-anchored find→replace edits; the app verifies each
// `find` verbatim at its {line, occurrence} anchor and splices `replace` for that ONE occurrence (D76
// precision). The MockRuntime ignores `responseSchema`, so `parseEditReply` re-validates in code and these
// tests drive a scripted runtime returning fixture edits.

/** A scripted runtime whose `chatStream` replies with `reply(call)` token-by-token. */
function scriptedRuntime(
  reply: (call: { messages: ChatMessage[]; options?: RuntimeChatOptions }) => string,
  calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
): ModelRuntime {
  return {
    modelId: 'mock',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      calls.push({ messages, options })
      for (const tok of reply({ messages, options }).match(/\S+\s*/g) ?? []) {
        if (options?.signal?.aborted) return
        yield tok
      }
    }
  }
}

const edit = (find: string, replace: string, line = 1, occurrence = 1): LocatedEdit => ({
  line,
  find,
  occurrence,
  replace
})

describe('document-edit-locate — the grammar contract (D55)', () => {
  it('constrains edits to a verbatim find + a replace + a 1-based line + a 1-based occurrence', () => {
    const schema = editLocateSchema() as any
    const item = schema.properties.edits.items
    expect(item.required).toEqual(['line', 'find', 'occurrence', 'replace'])
    expect(item.additionalProperties).toBe(false)
    expect(item.properties.find.minLength).toBe(1)
    expect(item.properties.replace.minLength).toBe(0) // an empty replace is a deletion
    expect(item.properties.line.minimum).toBe(1)
    expect(item.properties.occurrence.minimum).toBe(1)
  })
})

describe('document-edit-locate — line-numbered overlapping windows', () => {
  it('empty text yields no windows', () => {
    expect(buildEditWindows('')).toEqual([])
  })

  it('numbers lines globally and overlaps so a boundary edit is seen whole', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    const windows = buildEditWindows(text)
    // 50 lines, 40-line windows stepping by 32 ⇒ two windows, the second starting at global line 33.
    expect(windows).toHaveLength(2)
    expect(windows[0].startLine).toBe(1)
    expect(windows[1].startLine).toBe(33)
    expect(windows[0].numbered).toContain('40\tline 40')
    expect(windows[1].numbered.startsWith('33\t')).toBe(true) // GLOBAL numbering, not a window-local 1
  })

  it('a single short document is one window covering every line', () => {
    const windows = buildEditWindows('a\nb\nc')
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ startLine: 1, endLine: 3 })
    expect(windows[0].numbered).toBe('1\ta\n2\tb\n3\tc')
  })
})

describe('document-edit-locate — parseEditReply re-validates (mock ignores the schema)', () => {
  it('keeps valid edits and drops an empty find', () => {
    const reply = JSON.stringify({
      edits: [
        { line: 2, find: 'Vollmachtgeber', occurrence: 1, replace: 'Vollmachtgeberin' },
        { line: 1, find: '', occurrence: 1, replace: 'x' }, // empty find — nothing to anchor, dropped
        { line: 3, find: 'der', occurrence: 2, replace: 'die' }
      ]
    })
    expect(parseEditReply(reply)).toEqual([
      { line: 2, find: 'Vollmachtgeber', occurrence: 1, replace: 'Vollmachtgeberin' },
      { line: 3, find: 'der', occurrence: 2, replace: 'die' }
    ])
  })

  it('malformed JSON yields no edits (that window contributes nothing, never a hard fail)', () => {
    expect(parseEditReply('not json at all')).toEqual([])
    expect(parseEditReply('{"edits": "nope"}')).toEqual([])
  })

  it('a missing/invalid line or occurrence defaults to 1; an empty replace is kept (a deletion)', () => {
    const out = parseEditReply(JSON.stringify({ edits: [{ find: 'foo', replace: '' }] }))
    expect(out).toEqual([{ line: 1, find: 'foo', occurrence: 1, replace: '' }])
  })
})

describe('document-edit-locate — locateDocumentEdits over the runtime', () => {
  it('runs one call per window at temperature 0 with the schema, collecting proposals + the instruction', async () => {
    const text = Array.from({ length: 50 }, (_, i) => (i === 44 ? 'Signed, Vollmachtgeber' : `line ${i + 1}`)).join('\n')
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(
      ({ messages }) =>
        messages[1].content.includes('Vollmachtgeber')
          ? JSON.stringify({ edits: [{ line: 45, find: 'Vollmachtgeber', occurrence: 1, replace: 'Vollmachtgeberin' }] })
          : JSON.stringify({ edits: [] }),
      calls
    )
    const found = await locateDocumentEdits(text, 'Vollmachtgeber → Vollmachtgeberin', {
      runtime,
      signal: new AbortController().signal
    })
    expect(calls.length).toBe(2) // two windows
    expect(calls[0].options?.temperature).toBe(0)
    expect(calls[0].options?.responseSchema).toBeTruthy()
    expect(found.some((e) => e.find === 'Vollmachtgeber')).toBe(true)
    // The instruction (the CORE input) rides into the locate system prompt.
    expect(calls[0].messages[0].content).toContain('Vollmachtgeber → Vollmachtgeberin')
  })

  it('propagates an abort as an AbortError (the seam maps it to a calm cancel)', async () => {
    const controller = new AbortController()
    controller.abort()
    const runtime = scriptedRuntime(() => JSON.stringify({ edits: [] }))
    await expect(
      locateDocumentEdits('a\nb', 'change a to b', { runtime, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('document-edit verify + splice (D75/D76)', () => {
  it('replaces ONLY the anchored occurrence — an identical string elsewhere is untouched', () => {
    const text = 'der Kläger und der Beklagte hier.'
    // Change the SECOND 'der' to 'die'; the first 'der' must survive verbatim (D76 precision).
    const { text: out, applied, dropped } = verifyAndSpliceEdits(text, [edit('der', 'die', 1, 2)])
    expect(out).toBe('der Kläger und die Beklagte hier.')
    expect(applied).toBe(1)
    expect(dropped).toBe(0)
  })

  it('a German agreement-style multi-pair edit: one pair + one occurrence-anchored pronoun, byte-identity elsewhere', () => {
    const text = ['Der Vollmachtgeber erteilt die Vollmacht.', 'der Erbe und der Verwalter sind benannt.'].join('\n')
    const edits: LocatedEdit[] = [
      { line: 1, find: 'Vollmachtgeber', occurrence: 1, replace: 'Vollmachtgeberin' },
      { line: 2, find: 'der', occurrence: 2, replace: 'die' } // only the 2nd 'der' on line 2 (agreement)
    ]
    const { text: out, applied, dropped } = verifyAndSpliceEdits(text, edits)
    expect(out).toBe(['Der Vollmachtgeberin erteilt die Vollmacht.', 'der Erbe und die Verwalter sind benannt.'].join('\n'))
    expect(applied).toBe(2)
    expect(dropped).toBe(0)
    // Byte-identity outside the two edited spans (D58): the untouched first 'der' + the surrounding prose.
    expect(out).toContain('der Erbe und ') // the first 'der' on line 2 survived verbatim
    expect(out).toContain(' erteilt die Vollmacht.')
  })

  it('drops an edit whose find is not present verbatim at its anchor (hallucination is impossible, D75)', () => {
    const text = 'Only Jane here.'
    const { text: out, applied, dropped } = verifyAndSpliceEdits(text, [edit('Ghost', 'Casper')])
    expect(out).toBe(text) // unchanged
    expect(applied).toBe(0)
    expect(dropped).toBe(1)
  })

  it('drops an edit anchored to the WRONG line (the string exists, but not there)', () => {
    const text = ['plain first line', 'the target is here'].join('\n')
    // 'target' exists on line 2, but the edit anchors it to line 1 ⇒ dropped, byte-identity holds.
    const { text: out, applied, dropped } = verifyAndSpliceEdits(text, [edit('target', 'goal', 1, 1)])
    expect(out).toBe(text)
    expect(applied).toBe(0)
    expect(dropped).toBe(1)
  })

  it('drops an out-of-range occurrence (only one occurrence, but occurrence 2 requested)', () => {
    const { applied, dropped } = verifyAndSpliceEdits('one der only', [edit('der', 'die', 1, 2)])
    expect(applied).toBe(0)
    expect(dropped).toBe(1)
  })

  it('an empty replace deletes the anchored occurrence (byte-identity elsewhere)', () => {
    const { text: out, applied } = verifyAndSpliceEdits('remove XX please', [edit('XX ', '')])
    expect(out).toBe('remove please')
    expect(applied).toBe(1)
  })

  it('two edits targeting the SAME occurrence: the second is dropped, never double-spliced', () => {
    const { text: out, applied, dropped } = verifyAndSpliceEdits('der test', [edit('der', 'die'), edit('der', 'das')])
    expect(out).toBe('die test') // the first edit wins; the overlapping second is skipped
    expect(applied).toBe(1)
    expect(dropped).toBe(1)
  })
})
