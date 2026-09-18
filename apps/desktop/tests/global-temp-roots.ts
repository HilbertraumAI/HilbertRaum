// Vitest global setup (issue #335): the post-run half of the temp-root hygiene — see
// `tests/helpers/temp-roots.ts`. Runs in the main vitest process. `setup` mints the run's
// deferred-list file and hands its path to the forks through the environment (child processes
// inherit it); `teardown` runs after every fork has exited — so no handle a fork held locks its
// files any more — and sweeps the roots the per-file teardown could not remove. Since #460 that
// teardown closes the sqlite handles first, so this sweep is the RARE path again: ~1,500 roots
// per windows run before, 1 after — and that one is `tests/unit/temp-roots.test.ts` exercising
// the deferral on purpose. A count above 1 is a new leak worth a look. One summary line; never
// throws.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFERRED_ROOTS_ENV, sweepDeferredRoots } from './helpers/temp-roots'

export default function setup(): () => Promise<void> {
  // Not a `hilbertraum-*` / `hr-*` name on purpose: the list must never count as a leaked root.
  const listFile = join(tmpdir(), `vitest-deferred-temp-roots-${process.pid}.txt`)
  writeFileSync(listFile, '', 'utf8')
  process.env[DEFERRED_ROOTS_ENV] = listFile
  return async () => {
    try {
      const { removed, remaining } = await sweepDeferredRoots(listFile)
      if (removed > 0 || remaining.length > 0) {
        console.log(
          `temp roots: ${removed} deferred root(s) removed after the workers exited` +
            (remaining.length > 0 ? `; ${remaining.length} could not be removed: ${remaining.slice(0, 3).join(', ')}${remaining.length > 3 ? ', …' : ''}` : '')
        )
      }
    } catch (err) {
      console.log(`temp roots: the post-run sweep failed (${String(err)})`)
    }
  }
}
