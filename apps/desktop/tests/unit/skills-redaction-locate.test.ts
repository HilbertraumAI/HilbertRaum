import { describe, it, expect } from 'vitest'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import {
  buildLocateWindows,
  entityLocateSchema,
  locateEntities,
  parseLocateReply,
  LOCATE_CATEGORIES,
  MAX_LOCATED_ENTITIES,
  type LocatedEntity
} from '../../src/main/services/skills/tools/redaction-locate'
import {
  verifyAndSweepEntities,
  redactWithEntities,
  MIN_ENTITY_CHARS
} from '../../src/main/services/skills/tools/redaction'
import { applySpans } from '../../src/main/services/skills/tools/span-transform'

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
    expect(found.entities.some((e) => e.text === 'Jane Doe')).toBe(true)
    expect(found.truncated).toBe(false)
    expect(calls[0].messages[0].content).toContain('names')
  })

  // #134 (skills-pipeline audit 2026-08-09, RUN-3): the accumulator used to concatenate every window's
  // proposals with NO dedupe and NO global cap — on a large PII-dense document the list overflowed the
  // tool schema's `maxItems: 4096` and the run failed AFTER the full multi-minute locate pass. Now:
  // duplicate proposal strings collapse (the 8-line window overlap re-proposes them; the sweep is
  // text-keyed anyway), the unique list is capped at MAX_LOCATED_ENTITIES (== the tool schema cap, so
  // the seam can never overflow the gate), a hit cap stops paying for further windows, and `truncated`
  // reports the cap honestly so the seam can say so instead of silently under-masking.
  it('#134: de-duplicates identical proposal strings across windows (the overlap re-proposes them)', async () => {
    const text = Array.from({ length: 50 }, (_, i) => (i === 35 ? 'Signed, Jane Doe' : `line ${i + 1}`)).join('\n')
    // Line 36 sits in BOTH windows (33..40 overlap) — each window proposes the same string.
    const runtime = scriptedRuntime(({ messages }) =>
      messages[1].content.includes('Jane Doe')
        ? JSON.stringify({ entities: [{ text: 'Jane Doe', category: 'name', line: 36 }] })
        : JSON.stringify({ entities: [] })
    )
    const { entities, truncated } = await locateEntities(text, '', { runtime, signal: new AbortController().signal })
    expect(entities.filter((e) => e.text === 'Jane Doe')).toHaveLength(1)
    expect(truncated).toBe(false)
  })

  it('#134: caps unique proposals at MAX_LOCATED_ENTITIES, reports truncated, and stops early', async () => {
    expect(MAX_LOCATED_ENTITIES).toBe(4096) // == the redact_document schema's entities maxItems
    const text = Array.from({ length: 1300 }, (_, i) => `line ${i + 1}`).join('\n')
    const windows = buildLocateWindows(text)
    expect(windows.length).toBeGreaterThan(34) // enough saturated windows to overflow the cap
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    // Every window returns 128 UNIQUE proposals (keyed off its own first global line number). The
    // texts are SHORT so the whole reply stays under the locate stream's runaway char cap — a real
    // grammar-constrained reply is similarly dense.
    const runtime = scriptedRuntime(({ messages }) => {
      const firstLine = messages[1].content.split('\t')[0]
      return JSON.stringify({
        entities: Array.from({ length: 128 }, (_, i) => ({
          text: `w${firstLine}x${i}`,
          category: 'name',
          line: 1
        }))
      })
    }, calls)
    const { entities, truncated } = await locateEntities(text, '', { runtime, signal: new AbortController().signal })
    expect(entities).toHaveLength(MAX_LOCATED_ENTITIES) // never more than the tool gate accepts
    expect(truncated).toBe(true) // the cap is reported honestly
    expect(calls.length).toBeLessThan(windows.length) // a full cap stops paying for further windows
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

  // #128 (skills-pipeline audit 2026-08-09, RUN-1): URL_RE matches the █ mask character, so the floor's
  // URL pass can produce a span CONTAINING an earlier-pass email mask (or a swept entity mask) — the
  // union handed to the DOCX writer was NOT "mutually disjoint" as its comment claimed. Under perChar
  // the union is now resolved through the same `applySpans` overlap rule the .txt path applies: the
  // outer mask wins, contained spans drop, and `totalRedactions` counts masked REGIONS (not the
  // detector-hit sum that double-counted the nested item).
  it('#128: a URL with an embedded e-mail resolves to ONE disjoint masked region', () => {
    const input = 'See https://x.co/?e=a@b.co&l=de ok'
    const url = 'https://x.co/?e=a@b.co&l=de'
    const r = redactWithEntities(input, [], 'perChar')
    // The flat text masks the whole URL (email pass first, URL pass over the mask).
    expect(r.text).toBe(`See ${'█'.repeat(url.length)} ok`)
    // The writer span set is genuinely disjoint: ascending, non-overlapping…
    let end = 0
    for (const s of [...r.spans].sort((a, b) => a.start - b.start)) {
      expect(s.start).toBeGreaterThanOrEqual(end)
      end = s.start + s.length
    }
    // …and reproduces the flat text exactly (the invariant the old comment only claimed).
    expect(applySpans(input, r.spans).text).toBe(r.text)
    // One masked region — not the detector-hit sum of 2 (email + url).
    expect(r.totalRedactions).toBe(1)
  })

  it('#128: an entity mask swallowed by a URL span stays one region (entity ∪ floor union)', () => {
    const input = 'Link https://x.co/JaneDoe/profile end'
    const url = 'https://x.co/JaneDoe/profile'
    const r = redactWithEntities(input, [entity('JaneDoe')], 'perChar')
    expect(r.text).toBe(`Link ${'█'.repeat(url.length)} end`)
    expect(applySpans(input, r.spans).text).toBe(r.text)
    expect(r.totalRedactions).toBe(1)
  })

  it('#128: disjoint spans keep the additive count (the non-nested behaviour is unchanged)', () => {
    const input = 'Jane Doe: jane.doe@example.com and https://example.com/x'
    const r = redactWithEntities(input, [entity('Jane Doe')], 'perChar')
    expect(r.totalRedactions).toBe(3) // entity + email + url, all disjoint
    expect(applySpans(input, r.spans).text).toBe(r.text)
  })
})
