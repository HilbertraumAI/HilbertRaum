import { describe, it, expect } from 'vitest'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import {
  buildLocateWindows,
  entityLocateSchema,
  locateEntities,
  parseLocateReply,
  LOCATE_CATEGORIES,
  type LocatedEntity
} from '../../src/main/services/skills/tools/redaction-locate'
import {
  verifyAndSweepEntities,
  redactWithEntities,
  MIN_ENTITY_CHARS
} from '../../src/main/services/skills/tools/redaction'

// Phase 7 (beta-feedback-2026-07, #22 part 2, D73/D75/D78; architecture.md "Skills — design record"
// §21). The locate half (runtime-touching) + the verify/sweep half (deterministic, runtime-free) of
// redaction v2 — the model ONLY locates spans; the app verifies each verbatim and sweeps every
// occurrence. The MockRuntime ignores `responseSchema`, so `parseLocateReply` re-validates in code and
// these tests drive a scripted runtime returning fixture entities.

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

const entity = (text: string, category: LocatedEntity['category'] = 'name', line = 1): LocatedEntity => ({
  text,
  category,
  line
})

describe('redaction-locate — the grammar contract (D55)', () => {
  it('constrains entities to a fixed category enum + verbatim text + a 1-based line', () => {
    const schema = entityLocateSchema() as any
    const item = schema.properties.entities.items
    expect(item.required).toEqual(['text', 'category', 'line'])
    expect(item.properties.category.enum).toEqual([...LOCATE_CATEGORIES])
    expect(item.additionalProperties).toBe(false)
    expect(item.properties.line.minimum).toBe(1)
  })
})

describe('redaction-locate — line-numbered overlapping windows', () => {
  it('empty text yields no windows', () => {
    expect(buildLocateWindows('')).toEqual([])
  })

  it('numbers lines globally and overlaps so a boundary entity is seen whole', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    const windows = buildLocateWindows(text)
    // 50 lines, 40-line windows stepping by 32 ⇒ two windows, the second starting at global line 33.
    expect(windows).toHaveLength(2)
    expect(windows[0].startLine).toBe(1)
    expect(windows[1].startLine).toBe(33)
    // The overlap: lines 33..40 appear in BOTH windows (so an entity straddling line 40 is whole once).
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

describe('redaction-locate — parseLocateReply re-validates (mock ignores the schema)', () => {
  it('keeps valid entities and drops empty text / off-enum category', () => {
    const reply = JSON.stringify({
      entities: [
        { text: 'Jane Doe', category: 'name', line: 2 },
        { text: '', category: 'name', line: 1 }, // empty text — dropped
        { text: 'X', category: 'colour', line: 1 }, // off-enum category — dropped
        { text: '42 Main St', category: 'address', line: 3 }
      ]
    })
    const out = parseLocateReply(reply)
    expect(out).toEqual([
      { text: 'Jane Doe', category: 'name', line: 2 },
      { text: '42 Main St', category: 'address', line: 3 }
    ])
  })

  it('malformed JSON yields no entities (that window contributes nothing, never a hard fail)', () => {
    expect(parseLocateReply('not json at all')).toEqual([])
    expect(parseLocateReply('{"entities": "nope"}')).toEqual([])
  })

  it('a missing/invalid line defaults to 1 (a soft anchor — the sweep is global anyway)', () => {
    const out = parseLocateReply(JSON.stringify({ entities: [{ text: 'ACME', category: 'org' }] }))
    expect(out).toEqual([{ text: 'ACME', category: 'org', line: 1 }])
  })
})

describe('redaction-locate — locateEntities over the runtime', () => {
  it('runs one call per window at temperature 0 with the schema, collecting proposals', async () => {
    const text = Array.from({ length: 50 }, (_, i) => (i === 44 ? 'Signed, Jane Doe' : `line ${i + 1}`)).join('\n')
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(
      ({ messages }) =>
        messages[1].content.includes('Jane Doe')
          ? JSON.stringify({ entities: [{ text: 'Jane Doe', category: 'name', line: 45 }] })
          : JSON.stringify({ entities: [] }),
      calls
    )
    const found = await locateEntities(text, 'names', { runtime, signal: new AbortController().signal })
    expect(calls.length).toBe(2) // two windows
    expect(calls[0].options?.temperature).toBe(0)
    expect(calls[0].options?.responseSchema).toBeTruthy()
    // The entity on line 45 (in the second window) is collected; the instruction rode into the prompt.
    expect(found.some((e) => e.text === 'Jane Doe')).toBe(true)
    expect(calls[0].messages[0].content).toContain('names')
  })

  it('propagates an abort as an AbortError (the seam maps it to a calm cancel)', async () => {
    const controller = new AbortController()
    controller.abort()
    const runtime = scriptedRuntime(() => JSON.stringify({ entities: [] }))
    await expect(locateEntities('a\nb', 'names', { runtime, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

describe('redaction verify + sweep (D75)', () => {
  it('verifies a proposed span verbatim and sweeps ALL its occurrences', () => {
    const text = 'Jane Doe met Jane Doe near the office.'
    const { spans, counts, dropped } = verifyAndSweepEntities(text, [entity('Jane Doe')], 'token')
    expect(spans).toHaveLength(2) // both occurrences swept from one confirmation
    expect(counts.name).toBe(1) // one DISTINCT confirmed entity
    expect(dropped).toBe(0)
  })

  it('drops a proposal that is not present verbatim (hallucination is impossible)', () => {
    const { spans, dropped } = verifyAndSweepEntities('Only Jane here.', [entity('John Smith')], 'token')
    expect(spans).toHaveLength(0)
    expect(dropped).toBe(1)
  })

  it('drops a too-short or letter-less proposal (no masking half the document)', () => {
    const text = 'St 12 on St. 34'
    const short = verifyAndSweepEntities(text, [entity('St')], 'token') // < MIN_ENTITY_CHARS
    expect(short.spans).toHaveLength(0)
    expect(short.dropped).toBe(1)
    expect('St'.length).toBeLessThan(MIN_ENTITY_CHARS)
    const numeric = verifyAndSweepEntities('id 123 123', [entity('123', 'other')], 'token')
    expect(numeric.spans).toHaveLength(0) // no letter ⇒ dropped
    expect(numeric.dropped).toBe(1)
  })

  it('de-duplicates the same string across proposals (swept once, counted once, not re-dropped)', () => {
    const text = 'ACME and ACME'
    const { spans, counts, dropped } = verifyAndSweepEntities(
      text,
      [entity('ACME', 'org'), entity('ACME', 'org')],
      'token'
    )
    expect(spans).toHaveLength(2) // ACME masked at both occurrences, once
    expect(counts.org).toBe(1)
    expect(dropped).toBe(0) // the duplicate is already-covered, NOT an unverifiable drop
  })
})

describe('redactWithEntities — entities + the deterministic floor', () => {
  it('masks located entities AND the regex floor, per-char length preserved (D74/D75)', () => {
    const input = 'Jane Doe: jane.doe@example.com'
    const r = redactWithEntities(input, [entity('Jane Doe')], 'perChar')
    expect(r.text.length).toBe(input.length) // per-char masks preserve length
    expect(r.text).not.toContain('Jane Doe')
    expect(r.text).not.toContain('jane.doe@example.com')
    expect(r.entityCounts.name).toBe(1)
    expect(r.counts.email).toBe(1)
    expect(r.entityMaskCount).toBe(1)
    expect(r.totalRedactions).toBe(2) // one entity occurrence + one e-mail
    // Byte-identity OUTSIDE the masked spans (D58): the ": " separator survives verbatim.
    expect(r.text).toContain(': ')
  })

  it('empty entities is exactly the deterministic floor (the model-unavailable degrade)', () => {
    const input = 'Call +43 660 1234567 today.'
    const r = redactWithEntities(input, [], 'perChar')
    expect(r.entityCounts).toEqual({ name: 0, address: 0, org: 0, other: 0 })
    expect(r.entityMaskCount).toBe(0)
    expect(r.droppedEntities).toBe(0)
    expect(r.counts.phone).toBe(1)
    expect(r.totalRedactions).toBe(1)
    expect(r.text).not.toContain('+43 660 1234567')
  })

  it('reports the dropped-unverifiable count honestly (D78)', () => {
    const r = redactWithEntities('Jane Doe only.', [entity('Jane Doe'), entity('Ghost Name')], 'perChar')
    expect(r.entityCounts.name).toBe(1)
    expect(r.droppedEntities).toBe(1) // 'Ghost Name' was not present verbatim
  })
})
