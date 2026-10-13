import { describe, it, expect } from 'vitest'
import { contentHashOf } from '../../src/main/services/analysis/extract'

// full-audit 2026-07-11 CODE-24/DOC-12: the per-chunk cache/resume key is
// sha256(text + NUL + TYPE_SET_VERSION). The NUL domain separator used to be a LITERAL 0x00
// byte in the template literal, which made git treat extract.ts as binary. Rewriting it as the
// `\u0000` escape (this suite's edit) MUST keep the hash input byte-identical — otherwise every
// persisted `extraction_records` `__scan__` marker would miss and re-run the model over the
// whole corpus. These constants were captured against the pre-edit (literal-NUL) code; they must
// stay green after the escape lands. Do NOT regenerate them to "fix" a failure — a changed hash
// here means the domain-separator bytes drifted (a real cache-invalidating regression).
describe('contentHashOf — byte-identity of the NUL domain separator (CODE-24)', () => {
  // sha256(<input> + '\u0000' + 'v1'), hex. Frozen; see comment above.
  const cases: Array<[string, string]> = [
    ['hello world extraction', '1da30309776a438e002b2d7dc9e333db3a6f8baa6e162eafdfad81c807d470b9'],
    ['', '9d0727eaa35cfb8038c15459141ba4199aa4a06cab03fb87656a99f4c6bd5beb'],
    ['a', '1a37fe9800fe6df7d6965fff053dc190a2da1482b4cbfeac625719170a5c29e9'],
    ['ünïcödé — 中文 😀', '5cc52e921adc35dee1d6d6282996cb42e344362d823534500c024d7ce38cfd6c'],
    ['line1\nline2\ttab', '1742bfed0b912071e49f13f1b0dad31dd8b9343967de4c43722ee4507ab99ed1']
  ]

  for (const [text, hash] of cases) {
    it(`hashes ${JSON.stringify(text)} to the frozen digest`, () => {
      expect(contentHashOf(text)).toBe(hash)
    })
  }
})
