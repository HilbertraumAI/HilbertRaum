// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { getConfig } from '@testing-library/react'
import { hangBudgetMs } from '../helpers/hang-budget'

// #915: testing-library's `waitFor` / `find*By*` give up after 1 s unless told otherwise, and that default never
// follows the CI-aware `testTimeout`. `tests/setup.ts` raises it once for every jsdom file. A source grep (the
// repo-hygiene row "every wait takes its ceiling from hang-budget") cannot prove the setup line took effect, so this
// row reads the live config through RTL, which shares one instance with `@testing-library/dom` and merges rather
// than resets on its own import-time `configure`.
describe('testing-library wait default (#915)', () => {
  it('asyncUtilTimeout is the hang budget, not the 1 s library default', () => {
    expect(getConfig().asyncUtilTimeout).toBe(hangBudgetMs(5_000))
  })
})
