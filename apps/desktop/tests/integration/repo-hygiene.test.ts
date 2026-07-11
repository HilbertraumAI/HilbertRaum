import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

// full-audit 2026-07-11 CODE-24/DOC-12: `analysis/extract.ts` carried a LITERAL NUL byte (a
// hash-domain separator) which made git treat the file as binary — unreviewable text diffs, and
// ripgrep silently skips it (the audit's own greps missed the file). It was rewritten to the
// escape form (byte-identical). This net bans any new literal NUL in source-code files under
// src/**, tests/**, and the repo docs/** so the whole class can't regress: a domain separator or delimiter
// must always be written as an escape. tests/ is included because the class immediately
// recurred there — the CODE-24 fix's own test file shipped with 2 literal NULs in comments,
// caught by review, not by the original src-only net. The extension filter deliberately
// excludes the legitimate BINARY fixtures under tests/ (the .png vision chart, the local-only
// real-data .pdf corpus) — only text/source files must be NUL-free.
describe('repo hygiene — no literal NUL bytes in source (CODE-24)', () => {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(p))
      else if (/\.(ts|tsx|js|jsx|json|css|md|html)$/.test(entry.name)) out.push(p)
    }
    return out
  }

  it('holds no 0x00 byte in any src file (git must see them all as text)', () => {
    const offenders = walk(join(process.cwd(), 'src')).filter((p) => readFileSync(p).includes(0))
    expect(offenders).toEqual([])
  })

  it('holds no 0x00 byte in any tests source file either', () => {
    const offenders = walk(join(process.cwd(), 'tests')).filter((p) =>
      readFileSync(p).includes(0)
    )
    expect(offenders).toEqual([])
  })

  // The class recurred a THIRD time, in docs/: the §47 audit ledger's own CODE-24/DOC-12 row in
  // docs/architecture.md shipped with a literal NUL (the same authoring-tool escape trap), which
  // made every plain grep over that file silently stop mid-file — including the §-anchor
  // retirement legend at its end. Docs are grep-navigated reference material, so they get the
  // same net (the extension filter keeps it to text files).
  it('holds no 0x00 byte in any docs file either', () => {
    const offenders = walk(join(process.cwd(), '..', '..', 'docs')).filter((p) =>
      readFileSync(p).includes(0)
    )
    expect(offenders).toEqual([])
  })

  // …and a FOURTH time, in BUILD_STATE.md, while WRITING UP the docs/ recurrence — the journal
  // entry describing the escape trap fell into it. Root-level .md files (BUILD_STATE, CLAUDE,
  // README, …) are scanned non-recursively: the repo root also holds node_modules, which must
  // never be walked.
  it('holds no 0x00 byte in any repo-root markdown file either', () => {
    const root = join(process.cwd(), '..', '..')
    const offenders = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/.test(e.name))
      .map((e) => join(root, e.name))
      .filter((p) => readFileSync(p).includes(0))
    expect(offenders).toEqual([])
  })
})

// BUILD_STATE.md restructure (2026-07-12): the handoff file had grown to 1.48 MB / ~11,200
// lines (272 dated entries + retired handoff sections) — larger than any context window and
// beyond a single Read pass, so its own "read this FIRST" instruction silently failed: a
// fresh session got the newest journal entries and never reached the live §1–§9 sections.
// Closed waves' dated entries now retire verbatim (newest-first) to docs/build-log.md and the
// §4 data contracts live in docs/data-contracts.md; this budget makes the retention rule in
// BUILD_STATE's header mechanical instead of human-remembered. If this test fails, MOVE the
// oldest closed waves' entries to the top of docs/build-log.md — do not raise the numbers.
describe('repo hygiene — BUILD_STATE.md stays a one-pass handoff file (retention budget)', () => {
  it('stays under the retention budget (archive closed waves to docs/build-log.md)', () => {
    const raw = readFileSync(join(process.cwd(), '..', '..', 'BUILD_STATE.md'))
    expect(raw.byteLength).toBeLessThanOrEqual(300 * 1024)
    expect(raw.toString('utf8').split('\n').length).toBeLessThanOrEqual(2000)
  })
})
