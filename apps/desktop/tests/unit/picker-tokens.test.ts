import { describe, it, expect } from 'vitest'
import { createPickerTokens, PICKER_TOKEN_CAP } from '../../src/main/ipc/picker-tokens'

// The picker capability tokens that bind a main-owned OS dialog to the paths it returned
// (documents since D1; skills since #240). Extracted from registerDocsIpc.ts unchanged in
// behaviour: single-use on consume, a bounded FIFO map, no clock — a token lives until it is
// consumed or evicted by the cap (there is deliberately no time-based expiry; the map is
// process-local and dies with the session).

describe('picker tokens', () => {
  it('mints distinct opaque tokens and hands the bound value back once on consume', () => {
    const tokens = createPickerTokens<string[]>()
    const a = tokens.mint(['/a.txt'])
    const b = tokens.mint(['/b.txt'])
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(tokens.peek(b)).toEqual(['/b.txt'])
    expect(tokens.consume(a)).toEqual(['/a.txt'])
    expect(tokens.consume(a)).toBeUndefined() // spent
    expect(tokens.consume(b)).toEqual(['/b.txt']) // consuming `a` touched nothing else
  })

  it('peek reads without spending; consume spends', () => {
    const tokens = createPickerTokens<string>()
    const t = tokens.mint('/pkg.skill.zip')
    expect(tokens.peek(t)).toBe('/pkg.skill.zip')
    expect(tokens.peek(t)).toBe('/pkg.skill.zip')
    expect(tokens.consume(t)).toBe('/pkg.skill.zip')
    expect(tokens.peek(t)).toBeUndefined()
  })

  it('junk never resolves: non-strings, the empty string, unknown ids', () => {
    const tokens = createPickerTokens<string[]>()
    const real = tokens.mint(['/a.txt'])
    for (const junk of [undefined, null, 42, '', 'not-a-token', {}]) {
      expect(tokens.peek(junk)).toBeUndefined()
      expect(tokens.consume(junk)).toBeUndefined()
    }
    // The junk lookups neither spent nor evicted the real token.
    expect(tokens.consume(real)).toEqual(['/a.txt'])
  })

  it('evicts the oldest unconsumed token past the cap (bounded map)', () => {
    const tokens = createPickerTokens<number>(3)
    const first = tokens.mint(1)
    const second = tokens.mint(2)
    const third = tokens.mint(3)
    const fourth = tokens.mint(4)
    expect(tokens.consume(first)).toBeUndefined() // evicted
    // Only the oldest went.
    expect(tokens.consume(second)).toBe(2)
    expect(tokens.consume(third)).toBe(3)
    expect(tokens.consume(fourth)).toBe(4)
  })

  it('the default cap is the documents cap (16)', () => {
    expect(PICKER_TOKEN_CAP).toBe(16)
    const tokens = createPickerTokens<number>()
    const ids = Array.from({ length: PICKER_TOKEN_CAP + 5 }, (_, i) => tokens.mint(i))
    // Exactly 16 survive: the five oldest are evicted, the sixth still redeems (a cap of 15 or 17
    // reds one of the two).
    expect(tokens.consume(ids[4])).toBeUndefined()
    expect(tokens.consume(ids[5])).toBe(5)
  })
})
