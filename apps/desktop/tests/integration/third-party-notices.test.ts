import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { computeShippedPackages } from '../../../../scripts/lib/shipped-packages.mjs'

// LIC-2 (full-audit 2026-07-12, owner-approved): packaged builds bundle ~226 npm packages
// (app.asar production closure + the Vite-inlined renderer libs, which are a subset of it) —
// pdfjs-dist and tesseract.js are Apache-2.0 (NOTICE-preservation on redistribution), KaTeX
// ships SIL-OFL-1.1 fonts, and MIT/BSD/ISC all require keeping the copyright notice. The
// committed THIRD-PARTY-NOTICES.md aggregates them and ships beside app.asar as an
// extraResource. These tests keep it HONEST: the file's machine-readable package list must
// exactly match the shipped set recomputed from package-lock.json + electron-builder.yml
// (the same computation the generator uses — scripts/lib/shipped-packages.mjs), so any
// dependency change fails the gate until the file is regenerated.

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const NOTICES = join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md')
const REGEN = 'run `node scripts/generate-third-party-notices.mjs` and commit the result'

describe('THIRD-PARTY-NOTICES.md ships and stays fresh (LIC-2)', () => {
  it('exists, is non-trivial, and is byte-clean (LF-only, no NUL, no BOM)', () => {
    expect(existsSync(NOTICES), `THIRD-PARTY-NOTICES.md missing — ${REGEN}`).toBe(true)
    const raw = readFileSync(NOTICES)
    expect(raw.byteLength).toBeGreaterThan(100 * 1024) // 226 license texts ≈ 400 KB
    expect(raw.includes(0), 'literal NUL byte in THIRD-PARTY-NOTICES.md').toBe(false)
    expect(raw.includes(0x0d), 'CR line ending in THIRD-PARTY-NOTICES.md').toBe(false)
    expect(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, 'UTF-8 BOM').toBe(false)
  })

  it('its package list EXACTLY matches the shipped set from the lockfile + builder yml', () => {
    const text = readFileSync(NOTICES, 'utf8')
    const m = text.match(/^## Shipped packages \(\d+\)\n\n```\n([\s\S]*?)\n```/m)
    expect(m, `machine-readable "## Shipped packages" block missing — ${REGEN}`).toBeTruthy()
    const listed = m![1].split('\n')
    const computed = computeShippedPackages(REPO_ROOT).map((p) => `${p.name}@${p.version}`)
    expect(
      listed,
      `THIRD-PARTY-NOTICES.md is STALE (shipped dependency set changed) — ${REGEN}`
    ).toEqual(computed)
  })

  it('every shipped package has its own license section', () => {
    const text = readFileSync(NOTICES, 'utf8')
    const missing = computeShippedPackages(REPO_ROOT).filter(
      (p) => !text.includes(`\n### ${p.name}@${p.version}\n`)
    )
    expect(missing.map((p) => `${p.name}@${p.version}`), `sections missing — ${REGEN}`).toEqual(
      []
    )
  })

  it('carries the SIL OFL 1.1 notice for the KaTeX fonts while katex ships', () => {
    const shipsKatex = computeShippedPackages(REPO_ROOT).some((p) => p.name === 'katex')
    expect(shipsKatex).toBe(true) // if katex is ever dropped, retire this test with it
    const text = readFileSync(NOTICES, 'utf8')
    expect(text).toContain('KaTeX fonts')
    expect(text).toContain('SIL Open Font License, Version 1.1')
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1')
  })

  it('every non-optional peer of a shipped package is itself shipped (full-audit 2026-07-12b TQ-3)', () => {
    // The freshness gate above recomputes the shipped set via the SAME lib as the generator
    // (scripts/lib/shipped-packages.mjs), so a closure-computation bug — e.g. the TQ-3 peer
    // fold regressing — would pass both sides. This assertion is the independent belt: it
    // re-derives the peer requirement straight from the lockfile entries of the shipped set
    // and checks against shipped package NAMES (npm 7+ auto-installs required peers and
    // electron-builder ships them, so a missing one would ship un-noticed).
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<
        string,
        {
          peerDependencies?: Record<string, string>
          peerDependenciesMeta?: Record<string, { optional?: boolean }>
        }
      >
    }
    const shipped = computeShippedPackages(REPO_ROOT)
    const shippedNames = new Set(shipped.map((p) => p.name))
    const missing: string[] = []
    for (const p of shipped) {
      const entry = lock.packages[p.lockPath]
      for (const peer of Object.keys(entry?.peerDependencies ?? {})) {
        if (entry.peerDependenciesMeta?.[peer]?.optional) continue
        if (!shippedNames.has(peer)) missing.push(`${p.name}@${p.version} → peer ${peer}`)
      }
    }
    expect(
      missing,
      'required peer of a shipped package is NOT shipped — closure bug, or a deliberate ' +
        'yml negation of a peer (then extend this test to accept it explicitly)'
    ).toEqual([])
  })

  it('electron-builder ships the file beside app.asar via extraResources', () => {
    const cfg = parse(
      readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')
    ) as { extraResources?: Array<{ from?: string; to?: string }> }
    const entry = (cfg.extraResources ?? []).find((e) =>
      (e.from ?? '').includes('THIRD-PARTY-NOTICES.md')
    )
    expect(entry, 'extraResources entry for THIRD-PARTY-NOTICES.md missing').toBeTruthy()
    expect(entry!.from).toBe('../../THIRD-PARTY-NOTICES.md')
    expect(entry!.to).toBe('THIRD-PARTY-NOTICES.md')
  })

  // LIC-2 (full-audit 2026-07-12b): the artifact must also carry the project's OWN
  // GPL-3.0-or-later text — the root LICENSE is outside the apps/desktop build context,
  // so without this extraResources entry the packaged app ships the GPL only as the
  // package.json SPDX string.
  it('electron-builder ships the project LICENSE beside app.asar as LICENSE.txt', () => {
    const cfg = parse(
      readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')
    ) as { extraResources?: Array<{ from?: string; to?: string }> }
    const entry = (cfg.extraResources ?? []).find((e) => e.from === '../../LICENSE')
    expect(entry, 'extraResources entry for the project LICENSE missing').toBeTruthy()
    expect(entry!.to).toBe('LICENSE.txt')
  })
})
