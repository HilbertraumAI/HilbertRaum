import { describe, it, expect } from 'vitest'
import {
  PROMPT_CACHE_RESTORE_BROKEN_FAMILIES,
  promptCacheServerArgs
} from '../../src/shared/prompt-cache-rules'

// Issue #399 D5, extended by #446. The rule is a NAMED list with a measured basis, not an inline
// literal at the argv call site, so these tests can pin (a) the measured split, (b) that the
// default for anything unmeasured is cache-ON, and (c) that the flag we emit is the one the pinned
// binary takes. The families come from the fourteen-model sweep recorded in model-benchmarks.md
// §6.6 ("2026-09-09 correction (#399)") plus the three models #446 added ("2026-09-10 addition
// (#446)"); the four RESTORED rows below are its positive controls.

describe('prompt-cache family rule (#399 D5)', () => {
  it('disables the host prompt cache for every family measured to lose the restore', () => {
    // RE-PREFILLED in the sweep: qwen3.5 / qwen3.6 / qwen3.8 by recurrent state (all three report
    // arch `qwen35`), gemma4 by sliding window.
    for (const family of ['qwen3.5', 'qwen3.6', 'qwen3.8', 'gemma4']) {
      expect(promptCacheServerArgs(family)).toEqual(['--cache-ram', '0'])
    }
  })

  it('leaves every family that DID restore alone — argv byte-identical to before #399', () => {
    // The sweep's four positive controls, by the `family:` their manifests declare. `granite` is
    // the one #446 added: measured, and measured to RESTORE (22 of 1,414 tokens re-prefilled).
    for (const family of ['qwen3', 'mistral3', 'granite']) {
      expect(promptCacheServerArgs(family)).toEqual([])
    }
  })

  it('defaults an UNMEASURED family to cache-ON (the deliberate safe direction)', () => {
    // #446 measured the last two families that had no verdict, so every `family:` in today's
    // catalog is now on one side of the split — which is exactly why the examples here must be
    // families that do NOT exist in the catalog. This test is not about qwen3.6 or granite; it is
    // about the family somebody adds NEXT, before anyone has run the sweep against it. Turning the
    // cache off on a model that CAN restore costs real restores on every hand-back; leaving it on
    // for one that cannot merely continues a waste we can bound. So an unknown family, and a model
    // with no family at all, must add nothing to the argv.
    for (const family of ['llama9', 'phi-next', 'qwen4', 'gemma5']) {
      expect(promptCacheServerArgs(family)).toEqual([])
    }
    expect(promptCacheServerArgs(null)).toEqual([])
    expect(promptCacheServerArgs(undefined)).toEqual([])
    expect(promptCacheServerArgs('')).toEqual([])
  })

  it('matches the family exactly — no prefix or substring creep', () => {
    // `qwen3` must not be caught by `qwen3.5`, and `qwen3.5` must not swallow a future
    // `qwen3.5x`. A prefix match here would silently disable the cache on models that restore.
    expect(promptCacheServerArgs('qwen3')).toEqual([])
    expect(promptCacheServerArgs('qwen3.55')).toEqual([])
    expect(promptCacheServerArgs('qwen3.65')).toEqual([])
    expect(promptCacheServerArgs('gemma4x')).toEqual([])
    expect(promptCacheServerArgs('GEMMA4')).toEqual([]) // manifests are lower-case
  })

  it('emits the flag the pinned b9849 binary actually takes', () => {
    // `-cram, --cache-ram N` — "default: 8192, -1 = no limit, 0 = disable". Verified against
    // `llama-server.exe --help` on the pin (799fcc04a) before this shipped. A malformed arg here
    // breaks EVERY chat model start on every machine, not just the affected families.
    const args = promptCacheServerArgs('gemma4')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('--cache-ram')
    expect(args[1]).toBe('0')
  })

  it('the exported list is exactly the four families measured to lose the restore', () => {
    // A guard against quietly widening the rule: adding a family here requires a measurement, and
    // this expectation is the place where that measurement has to be produced. It went from three
    // to four on 2026-09-10 because #446 fetched qwen3.6's weights and ran the #399 protocol
    // against both quants — not because qwen3.6 looked like the families around it. Anything else
    // arriving in this array without an evidence file under
    // eval/results/hardware/*/issue*-arch-sweep-* behind it is the failure this test exists to
    // catch.
    expect([...PROMPT_CACHE_RESTORE_BROKEN_FAMILIES].sort()).toEqual([
      'gemma4',
      'qwen3.5',
      'qwen3.6',
      'qwen3.8'
    ])
  })
})
