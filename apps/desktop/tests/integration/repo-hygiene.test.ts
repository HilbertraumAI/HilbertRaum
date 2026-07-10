import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Issue #49: different npm versions compute the lockfile `peer` flags differently (a
// long-standing npm/Arborist behaviour), so with an unpinned npm every contributor's
// `npm install` rewrote package-lock.json — a permanently dirty lockfile and a broken
// `git pull` loop. The committed lockfile is canonical under the pinned version below;
// installs go through `npm ci` (CI, setup-dev, CONTRIBUTING), which never rewrites it.
describe('repo hygiene — lockfile discipline (issue #49)', () => {
  const rootPkg = JSON.parse(
    readFileSync(join(process.cwd(), '..', '..', 'package.json'), 'utf8')
  ) as { packageManager?: string; engines?: Record<string, string> }

  it('pins the npm version the committed lockfile is canonical under', () => {
    // Exact-version corepack pin. If you bump this, regenerate package-lock.json with the
    // new version in the same commit (npm install --package-lock-only) — the pin and the
    // lockfile must stay canonical together.
    expect(rootPkg.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/)
  })

  it('declares the npm engines floor alongside the node one', () => {
    expect(rootPkg.engines?.node).toBeDefined()
    expect(rootPkg.engines?.npm).toBeDefined()
  })
})
