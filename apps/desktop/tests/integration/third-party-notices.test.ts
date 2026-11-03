import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import { builderFileNegations, computeShippedPackages } from '../../../../scripts/lib/shipped-packages.mjs'
import {
  KNOWN_EXTRA_NOTICES,
  LEPTONICA_LICENSE,
  OFL_1_1_LICENSE
} from '../../../../scripts/lib/extra-notices.mjs'
import { buildThirdPartyNotices } from '../../../../scripts/lib/third-party-notices.mjs'
import { asarPackageIds, packedArtifact, packedNodeModules, type LockPackages } from '../helpers/asar-layout'
import { builderConfig, DESKTOP_ROOT, filesUnder, lockPackages, REPO_ROOT, repoText } from '../helpers/repo-files'

// LIC-2 (full-audit 2026-07-12, owner-approved): packaged builds bundle ~224 npm packages
// (app.asar production closure + the Vite-inlined renderer libs, which are a subset of it) —
// pdfjs-dist and tesseract.js are Apache-2.0 (NOTICE-preservation on redistribution), KaTeX
// ships SIL-OFL-1.1 fonts, and MIT/BSD/ISC all require keeping the copyright notice. The
// committed THIRD-PARTY-NOTICES.md aggregates them and ships beside app.asar as an
// extraResource. These tests keep it HONEST: the file's machine-readable package list must
// exactly match the shipped set recomputed from package-lock.json + electron-builder.yml
// (the same computation the generator uses — scripts/lib/shipped-packages.mjs), so any
// dependency change fails the gate until the file is regenerated, and the whole file must equal
// what the generator's builder (scripts/lib/third-party-notices.mjs) writes (#769).

const NOTICES = join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md')
const REGEN = 'run `node scripts/generate-third-party-notices.mjs` and commit the result'

describe('THIRD-PARTY-NOTICES.md ships and stays fresh (LIC-2)', () => {
  it('exists, is non-trivial, and is byte-clean (LF-only, no NUL, no BOM)', () => {
    expect(existsSync(NOTICES), `THIRD-PARTY-NOTICES.md missing — ${REGEN}`).toBe(true)
    const raw = readFileSync(NOTICES)
    expect(raw.byteLength).toBeGreaterThan(100 * 1024) // 224 license texts ≈ 400 KB
    expect(raw.includes(0), 'literal NUL byte in THIRD-PARTY-NOTICES.md').toBe(false)
    expect(raw.includes(0x0d), 'CR line ending in THIRD-PARTY-NOTICES.md').toBe(false)
    expect(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, 'UTF-8 BOM').toBe(false)
  })

  // #769: the rows below read parts of the file; this one holds every byte, so a hand edit of a license text or a
  // generator change that nobody regenerated fails here.
  it('is byte-identical to a regeneration from the lockfile + the installed packages (#769)', () => {
    expect(
      readFileSync(NOTICES, 'utf8'),
      `THIRD-PARTY-NOTICES.md is STALE (a license text, the generator or the shipped set changed) — ${REGEN}`
    ).toBe(buildThirdPartyNotices(REPO_ROOT))
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

  // #548: the notices decide "shipped" from lockfile paths minus the negations, while
  // electron-builder applies the negations to the RE-HOISTED layout it packs. Before #536 the two
  // disagreed: app.asar carried tinyexec 1.2.4, which the notices left out with the mermaid chain.
  it('names exactly the packages electron-builder packs into app.asar (#548)', () => {
    const negations = builderFileNegations(REPO_ROOT)
    const packed = packedNodeModules(lockPackages())
      .filter((p) => !negations.some((rx) => rx.test(p.dest + '/x.js')))
      .map((p) => p.id)
    const noticed = computeShippedPackages(REPO_ROOT).map((p) => `${p.name}@${p.version}`)
    expect(noticed.sort(), 'the notices and app.asar disagree about what ships').toEqual(
      [...new Set(packed)].sort()
    )
  })

  // #769: the row above compares the notices with the modelled layout; these two read a real build
  // (HILBERTRAUM_PACKED_ASAR, which release.yml's build-win sets to the build it just packaged).
  const { asar: packedAsar } = packedArtifact()
  it.skipIf(!packedAsar)('lists exactly the name@version set a real app.asar carries (#769)', () => {
    const listed = /^## Shipped packages \(\d+\)\n\n```\n([\s\S]*?)\n```/m.exec(readFileSync(NOTICES, 'utf8'))
    expect(listed, `machine-readable "## Shipped packages" block missing — ${REGEN}`).toBeTruthy()
    expect(asarPackageIds(packedAsar!), 'the notices and the real app.asar disagree about what ships').toEqual(
      listed![1].split('\n').sort()
    )
  })

  it.skipIf(!packedAsar)('a real build ships the committed notices and license beside its app.asar (#769)', () => {
    const resources = dirname(packedAsar!)
    expect(readFileSync(join(resources, 'THIRD-PARTY-NOTICES.md'), 'utf8')).toBe(readFileSync(NOTICES, 'utf8'))
    expect(readFileSync(join(resources, 'LICENSE.txt'), 'utf8')).toBe(repoText('LICENSE'))
  })

  it('every shipped package has its own license section', () => {
    const text = readFileSync(NOTICES, 'utf8')
    const missing = computeShippedPackages(REPO_ROOT).filter(
      (p) => !text.includes(`\n### ${p.name}@${p.version}\n`)
    )
    expect(missing.map((p) => `${p.name}@${p.version}`), `sections missing — ${REGEN}`).toEqual(
      []
    )
    expect(text, 'a package with no license text (LIC-3): pin it in KNOWN_EXTRA_NOTICES').not.toContain(
      'No license file is distributed inside this package'
    )
    expect(text, 'a section written from lockfile metadata on a host that lacks the package').not.toContain(
      'could not be reproduced here'
    )
  })

  it('carries the SIL OFL 1.1 notice for the KaTeX fonts while katex ships', () => {
    const shipsKatex = computeShippedPackages(REPO_ROOT).some((p) => p.name === 'katex')
    expect(shipsKatex).toBe(true) // if katex is ever dropped, retire this test with it
    const text = readFileSync(NOTICES, 'utf8')
    expect(text).toContain('KaTeX fonts')
    expect(text).toContain('SIL Open Font License, Version 1.1')
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(text.includes(OFL_1_1_LICENSE), `verbatim OFL 1.1 text missing — ${REGEN}`).toBe(true)
  })

  // LIC-3 (full-audit 2026-07-12b): six shipped packages publish no license file in
  // their tarball, so the generator emits texts pinned from upstream at review time
  // (scripts/lib/extra-notices.mjs). If an upstream starts shipping a license file,
  // the generator drops the pinned text on the next regeneration (the freshness gate
  // forces one) and this test then fails — remove the stale map entry and regenerate.
  it('carries the pinned license text for every shipped package in KNOWN_EXTRA_NOTICES (LIC-3)', () => {
    const text = readFileSync(NOTICES, 'utf8')
    const shippedNames = new Set(computeShippedPackages(REPO_ROOT).map((p) => p.name))
    for (const [name, entry] of Object.entries(KNOWN_EXTRA_NOTICES)) {
      if (!shippedNames.has(name)) continue
      expect(
        text.includes(entry.text),
        `pinned license text for ${name} missing from THIRD-PARTY-NOTICES.md — ${REGEN}`
      ).toBe(true)
    }
    // The map exists for the shipped set; a key that no longer ships is dead weight.
    const dead = Object.keys(KNOWN_EXTRA_NOTICES).filter((n) => !shippedNames.has(n))
    expect(dead, 'KNOWN_EXTRA_NOTICES entry for a package that no longer ships').toEqual([])
  })

  // LIC-3 (full-audit 2026-07-12b): tesseract.js-core's WASM statically links
  // leptonica, whose license the published package does not reproduce.
  it('carries the leptonica attribution while tesseract.js-core ships (LIC-3)', () => {
    const ships = computeShippedPackages(REPO_ROOT).some((p) => p.name === 'tesseract.js-core')
    expect(ships).toBe(true) // if tesseract.js-core is ever dropped, retire this test with it
    const text = readFileSync(NOTICES, 'utf8')
    expect(text).toContain('Leptonica (statically linked into the tesseract WASM binaries)')
    expect(
      text.includes(LEPTONICA_LICENSE),
      `verbatim leptonica license text missing — ${REGEN}`
    ).toBe(true)
  })

  it('every non-optional peer of a shipped package is itself shipped (full-audit 2026-07-12b TQ-3)', () => {
    // The freshness gate above recomputes the shipped set through the generator's own lib, so a bug in that walk passes both
    // sides. This row re-reads each required peer from the shipped set's lockfile entries and checks it against shipped NAMES.
    // On today's tree every required peer is also a normal dependency (56 edges, none peer-only), so this fires on a negated
    // peer; a peer-only one makes computeShippedPackages throw (#768, the fixture row below). electron-builder's collector
    // follows dependencies + optionalDependencies only, so a pure peer would be noticed but not packed.
    const lock = lockPackages()
    const shipped = computeShippedPackages(REPO_ROOT)
    const shippedNames = new Set(shipped.map((p) => p.name))
    const missing: string[] = []
    for (const p of shipped) {
      const entry = lock[p.lockPath]
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

  /** The shipped set of a scratch repo: this lockfile, and one package negation in electron-builder.yml. */
  function shippedFrom(packages: LockPackages): ReturnType<typeof computeShippedPackages> {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-shipped-'))
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true })
    writeFileSync(
      join(root, 'apps', 'desktop', 'electron-builder.yml'),
      stringify({ files: ['out/**/*', '!**/node_modules/negated/**'] })
    )
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages }))
    return computeShippedPackages(root)
  }

  // alpha's required peer is also Zeta's dependency (every required peer of today's tree is reached that way, TQ-3).
  const shippedFixture = (): LockPackages => ({
    'apps/desktop': { name: 'app', dependencies: { alpha: '*', Zeta: '*', negated: '*' } },
    'node_modules/alpha': {
      version: '1.0.0',
      license: 'MIT',
      dependencies: { dup: '*', multi: '*' },
      optionalDependencies: { maybe: '*' },
      peerDependencies: { 'req-peer': '*', 'opt-peer': '*' },
      peerDependenciesMeta: { 'opt-peer': { optional: true } }
    },
    'node_modules/Zeta': { version: '1.0.0', dependencies: { dup: '*', multi: '*', 'req-peer': '*' } },
    'node_modules/dup': { version: '4.0.0' },
    'node_modules/Zeta/node_modules/dup': { version: '4.0.0' },
    'node_modules/multi': { version: '1.0.0' },
    'node_modules/Zeta/node_modules/multi': { version: '2.0.0' },
    'node_modules/maybe': { version: '1.1.0' },
    'node_modules/req-peer': { version: '2.0.0' },
    'node_modules/opt-peer': { version: '3.0.0' },
    'node_modules/negated': { version: '9.0.0' }
  })

  it('computes the shipped set: dependency and optional edges in, an optional peer and negated packages out, one entry per name@version, code-unit order', () => {
    const shipped = shippedFrom(shippedFixture())
    expect(shipped.map((p) => `${p.name}@${p.version}`)).toEqual([
      'Zeta@1.0.0',
      'alpha@1.0.0',
      'dup@4.0.0',
      'maybe@1.1.0',
      'multi@1.0.0',
      'multi@2.0.0',
      'req-peer@2.0.0'
    ])
    expect(shipped.find((p) => p.name === 'alpha')?.lockLicense).toBe('MIT')
    expect(shipped.find((p) => p.name === 'dup')?.lockLicense).toBeNull()
  })

  // #768, owner call: npm installs a required peer, electron-builder does not pack one, so the notices would name a
  // package app.asar lacks. A peer that no dependency edge reaches is refused, with the fix.
  it('refuses a required peer that only a peer edge reaches, naming it and the fix (#768)', () => {
    const packages = shippedFixture()
    packages['node_modules/Zeta'].dependencies = { dup: '*', multi: '*' }
    expect(() => shippedFrom(packages)).toThrow(
      /^req-peer is a required peer of alpha@1\.0\.0 that no dependency edge reaches: .* Add req-peer to the dependencies of apps\/desktop\/package\.json\.$/
    )
  })

  // DEP-6: a license file inside a path the build excludes does not ship, so the generator skips it (`shipsFile`).
  it('reproduces no license of a file the build excludes, and keeps its siblings (DEP-6)', () => {
    const text = readFileSync(NOTICES, 'utf8')
    expect(text).not.toContain('standard_fonts/')
    expect(text).toContain('#### `cmaps/LICENSE`')
  })

  // The renderer bundle inlines whatever it imports, so a devDependency import would ship with no notice.
  it('shipped source imports only production dependencies, electron and Node builtins', () => {
    const { dependencies } = JSON.parse(repoText('apps', 'desktop', 'package.json')) as {
      dependencies: Record<string, string>
    }
    const allowed = new Set([...Object.keys(dependencies), 'electron', ...builtinModules])
    const importRx =
      /^(?:import|export)\s[^'"`;=(]*?\sfrom\s+['"]([^'"./][^'"]*)['"]|^import\s+['"]([^'"./][^'"]*)['"]|\bimport\(\s*['"]([^'"./][^'"]*)['"]\s*\)|\brequire\(\s*['"]([^'"./][^'"]*)['"]\s*\)/gm
    const seen = new Set<string>()
    for (const p of filesUnder(join(DESKTOP_ROOT, 'src'), /(?<!\.d)\.tsx?$/)) {
      for (const m of readFileSync(p, 'utf8').matchAll(importRx)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
        if (spec.startsWith('node:') || spec.startsWith('@shared/') || spec.startsWith('@renderer/')) continue
        seen.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
      }
    }
    expect(seen).toContain('react') // the walk read the source
    expect([...seen].filter((p) => !allowed.has(p))).toEqual([])
  })

  // LIC-2 (full-audit 2026-07-12b): the artifact must also carry the project's OWN
  // GPL-3.0-or-later text — the root LICENSE is outside the apps/desktop build context,
  // so without this extraResources entry the packaged app ships the GPL only as the
  // package.json SPDX string.
  it('electron-builder ships exactly the manifests, the notices and the license beside app.asar', () => {
    const resources = builderConfig().extraResources as Array<{ from: string; to: string }>
    expect(resources).toEqual([
      { from: '../../model-manifests', to: 'model-manifests' },
      { from: '../../THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' },
      { from: '../../LICENSE', to: 'LICENSE.txt' }
    ])
    for (const { from } of resources) expect(existsSync(join(DESKTOP_ROOT, from)), from).toBe(true)
  })
})
