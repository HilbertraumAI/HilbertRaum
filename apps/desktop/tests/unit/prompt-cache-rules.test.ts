import { describe, it, expect } from 'vitest'
import {
  PROMPT_CACHE_MAX_MIB,
  PROMPT_CACHE_RAM_DIVISOR,
  promptCacheRamMib,
  promptCacheServerArgs
} from '../../src/shared/prompt-cache-rules'

// Issue #512, owner decisions 1 and 2. The #399 family list is gone (qwen3.5 and gemma4 restore on
// b11146); every chat model gets a RAM-scaled `--cache-ram`, and a manifest that still cannot
// restore opts out with `disable_prompt_cache: true` → the code-owned `--cache-ram 0`.

const GiB = 1024 ** 3

describe('prompt-cache RAM ceiling (#512 decision 2)', () => {
  it('is 1/8 of total RAM, never more than llama.cpp’s 8,192 MiB default', () => {
    expect(PROMPT_CACHE_MAX_MIB).toBe(8192)
    expect(PROMPT_CACHE_RAM_DIVISOR).toBe(8)
    expect(promptCacheRamMib(8 * GiB)).toBe(1024)
    expect(promptCacheRamMib(16 * GiB)).toBe(2048)
    expect(promptCacheRamMib(32 * GiB)).toBe(4096)
    expect(promptCacheRamMib(64 * GiB)).toBe(8192)
    expect(promptCacheRamMib(128 * GiB)).toBe(8192)
  })

  it('rounds down on the odd totals real machines report', () => {
    // An "8 GB" laptop reports less than 8 GiB (firmware and iGPU reservations); a "16 GB" one the
    // same. The ceiling follows what the OS reports, rounded down to whole MiB.
    expect(promptCacheRamMib(7.84 * GiB)).toBe(Math.floor((7.84 * 1024) / 8))
    expect(promptCacheRamMib(15.8 * GiB)).toBe(Math.floor((15.8 * 1024) / 8))
    expect(Number.isInteger(promptCacheRamMib(63.7 * GiB))).toBe(true)
  })

  it('a junk RAM reading falls back to the ceiling (what llama.cpp uses with no flag)', () => {
    for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(promptCacheRamMib(junk)).toBe(8192)
    }
  })
})

describe('prompt-cache server args (#512 decisions 1 + 2)', () => {
  it('passes the RAM-scaled ceiling by default — every chat model, no family list', () => {
    expect(promptCacheServerArgs({ totalRamBytes: 16 * GiB })).toEqual(['--cache-ram', '2048'])
    expect(promptCacheServerArgs({ totalRamBytes: 64 * GiB, disablePromptCache: false })).toEqual([
      '--cache-ram',
      '8192'
    ])
  })

  it('disable_prompt_cache: true wins with --cache-ram 0, whatever the RAM', () => {
    for (const gb of [8, 16, 32, 64, 128]) {
      expect(promptCacheServerArgs({ totalRamBytes: gb * GiB, disablePromptCache: true })).toEqual([
        '--cache-ram',
        '0'
      ])
    }
  })

  it('always emits exactly one --cache-ram, as an adjacent flag/value pair', () => {
    // A malformed pair here breaks EVERY chat model start on every machine.
    for (const disablePromptCache of [true, false, undefined]) {
      const args = promptCacheServerArgs({ totalRamBytes: 32 * GiB, disablePromptCache })
      expect(args).toHaveLength(2)
      expect(args[0]).toBe('--cache-ram')
      expect(args[1]).toMatch(/^\d+$/)
    }
  })
})
