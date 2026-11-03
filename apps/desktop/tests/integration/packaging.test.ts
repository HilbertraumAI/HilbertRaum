import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
// The glob → RegExp translation is shared with asar-unpack-closure.test.ts (#232).
import { globToRegExp } from '../helpers/globs'
import {
  asarPackageDirs,
  builderFile,
  packedArtifact,
  packedFuseWire,
  packedNodeModules,
  packedPathExists,
  PACKED_ENV,
  type LockPackages,
  type PackedPackage
} from '../helpers/asar-layout'
import { builderConfig, DESKTOP_ROOT, filesUnder, lockPackages, REPO_ROOT, repoText } from '../helpers/repo-files'
import { KIT_PLATFORM_SPECS } from '../../src/main/services/commercial-drive'

// L18 (audit-2026-06-13): @napi-rs/canvas is an OPTIONAL transitive dep of pdfjs-dist —
// a platform-specific native `.node` (Skia) the app's code never imports (pdf.js tries to at its
// first import and does without it: pdf-parser-packaged.test.ts runs the parser that way, #685).
// electron-builder's collector would otherwise pack the win32 `.node` into app.asar, breaking the pure-JS /
// cross-OS portable posture (a Windows binary shipped on a macOS/Linux drive). The
// exclusion is invisible until release packaging, so guard it here in the green gate.

describe('electron-builder packaging excludes the @napi-rs/canvas native binary (L18)', () => {
  it('the exclusion glob actually matches the platform-specific native package paths', () => {
    const exclusion = (builderConfig().files ?? []).find((f) => f.startsWith('!') && /@napi-rs\/canvas/.test(f))
    expect(exclusion, 'expected a "!**/@napi-rs/canvas*/**"-style exclusion in files').toBeTruthy()
    const rx = globToRegExp(exclusion!.slice(1))
    for (const p of [
      'node_modules/@napi-rs/canvas/index.js',
      'node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
      'node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
      'apps/desktop/node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node'
    ]) {
      expect(rx.test(p), `exclusion should match ${p}`).toBe(true)
    }
  })
})

// Wave DEP-6: pdfjs-dist's standard_fonts/ does not ship. pdf.js reads those files only
// through `standardFontDataUrl`, which the app never sets, and the LiberationSans files in
// it are Liberation 1.07.4 under GPL v2 with a physical-product clause (pdfjs-dist 6.3
// corrected their notice from OFL). Starting to load standard fonts means revisiting both.
describe('electron-builder packaging excludes pdfjs-dist standard fonts', () => {
  const exclusion = (builderConfig().files ?? []).find(
    (f) => f.startsWith('!') && f.includes('pdfjs-dist/standard_fonts')
  )

  it('negates standard_fonts/ and nothing else of pdfjs-dist', () => {
    expect(exclusion, 'expected a "!**/node_modules/pdfjs-dist/standard_fonts/**" exclusion').toBeTruthy()
    const rx = globToRegExp(exclusion!.slice(1))
    for (const p of [
      'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
      'node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb',
      'node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION'
    ]) {
      expect(rx.test(p), `should exclude ${p}`).toBe(true)
    }
    for (const p of [
      'node_modules/pdfjs-dist/package.json',
      'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      'node_modules/pdfjs-dist/wasm/openjpeg.wasm',
      'node_modules/pdfjs-dist/cmaps/Identity-H.bcmap'
    ]) {
      expect(rx.test(p), `should keep ${p}`).toBe(false)
    }
  })

  it('the app never points pdf.js at standard fonts (the exclusion is only safe while so)', () => {
    const source = filesUnder(join(DESKTOP_ROOT, 'src'), /\.(ts|tsx|mjs|js|html)$/)
    expect(source.filter((p) => /standardFontDataUrl|standard_fonts/.test(readFileSync(p, 'utf8')))).toEqual([])
  })
})

// streamdown 2.6 dropped its hard dependency on mermaid (#550), and with it the ~136 MB
// mermaid/cytoscape/d3/dagre/roughjs chain that DEP-3 kept out of app.asar with ~40 `files:`
// negations. Mermaid diagrams are an opt-in streamdown plugin now (`@streamdown/mermaid`), which
// this app does not install (mdPlugins = { math }; assistant-markdown.test.tsx pins the fence).
// If mermaid re-enters the production graph (that plugin adopted, or a dependency pulling it in),
// app.asar would carry the whole chain and DOMPurify would be live in the renderer: this goes red
// so that is decided rather than inherited. The DEP-3 negation block is in git history.
describe('mermaid stays out of the production graph (streamdown 2.6, #550)', () => {
  it('no mermaid package is reachable from apps/desktop', () => {
    const names = packedNodeModules(lockPackages()).map((p) => p.dest.replace(/^.*node_modules\//, ''))
    expect(names).toContain('streamdown') // the walk does reach the chat renderer
    expect(names.filter((n) => n === 'mermaid' || n.startsWith('@mermaid-js/'))).toEqual([])
  })
})

// #548: a negation is checked where electron-builder PACKS each package, not at its lockfile path.
// The collector re-hoists the production graph and applies the negations to that layout, so a
// package nested under a negated parent can land at `node_modules/<name>` and ship past the
// parent's negation (`tinyexec`, until #536). `packedNodeModules` (tests/helpers/asar-layout.ts)
// replays it. Every packed package is a production one, so no package-level negation may cover
// one, except the deliberate L18 canvas exclusion (an optional native dep the app never imports).
describe('files negations never remove a package the app needs (#548)', () => {
  it('no negation but the canvas one covers a package where electron-builder packs it', () => {
    const negations = (builderConfig().files ?? [])
      .filter((f) => f.startsWith('!') && !f.includes('@napi-rs/canvas'))
      .map((f) => globToRegExp(f.slice(1)))
    const removed = packedNodeModules(lockPackages()).filter((p) =>
      negations.some((rx) => rx.test(p.dest + '/x.js'))
    )
    expect(
      removed.map((p: PackedPackage) => `${p.dest} (${p.id})`),
      'these packages are needed by the production graph but excluded from app.asar — remove their negation'
    ).toEqual([])
  })

  // The row above probes a package's top directory, so a negation of one of its sub-paths escapes it.
  it('files is exactly the app bundle, package.json and the four negations', () => {
    expect(builderConfig().files).toEqual([
      'out/**/*',
      '!out/preview/**',
      '!out/tools/**',
      'package.json',
      '!**/node_modules/@napi-rs/canvas*/**',
      '!**/node_modules/pdfjs-dist/standard_fonts/**'
    ])
  })

  it('every files and asarUnpack glob has a shape the coarse translator reads', () => {
    const cfg = builderConfig()
    const globs = [...(cfg.files ?? []), ...(cfg.asarUnpack ?? [])]
    expect(globs.length).toBeGreaterThan(0)
    // Braces come out as literals, ? stays a regex quantifier and a trailing `.*` keeps a raw dot-star: such a negation
    // would be a silent no-op in the notices and in these gates, though electron-builder would honour it.
    expect(globs.filter((g) => /[{}?[\]()]|\.\*/.test(g))).toEqual([])
  })
})

// #548: the layout model itself. The two fixtures are the shapes that decide where a nested
// package lands; the last check compares the model with a real build when one is pointed at.
describe('the app.asar layout model (#548)', () => {
  it('hoists a nested package to the top when only a dev package held that slot (the tinyexec escape)', () => {
    // The pre-#536 shape: vitest 3's tinyexec 0.3 held the top-level slot, so @antfu/install-pkg's
    // 1.2.4 sat nested under the negated `@antfu/` in the lockfile.
    const packages: LockPackages = {
      'apps/desktop': { name: 'app', dependencies: { streamdown: '^1.0.0' } },
      'node_modules/streamdown': { version: '1.0.0', dependencies: { mermaid: '^1.0.0' } },
      'node_modules/mermaid': { version: '1.0.0', dependencies: { '@antfu/install-pkg': '^1.0.0' } },
      'node_modules/@antfu/install-pkg': { version: '1.0.0', dependencies: { tinyexec: '^1.0.0' } },
      'node_modules/@antfu/install-pkg/node_modules/tinyexec': { version: '1.2.4' },
      'node_modules/tinyexec': { version: '0.3.2', dev: true }
    }
    const antfu = globToRegExp('**/node_modules/@antfu/**')
    // What the lockfile-path check saw…
    expect(antfu.test('node_modules/@antfu/install-pkg/node_modules/tinyexec/x.js')).toBe(true)
    // …and where electron-builder put it.
    const tinyexec = packedNodeModules(packages).find((p) => p.id === 'tinyexec@1.2.4')
    expect(tinyexec?.dest).toBe('node_modules/tinyexec')
    expect(antfu.test(`${tinyexec?.dest}/x.js`)).toBe(false)
  })

  it('keeps a conflicting copy nested under its parent', () => {
    const packages: LockPackages = {
      'apps/desktop': { name: 'app', dependencies: { streamdown: '^1.0.0', 'react-markdown': '^1.0.0' } },
      'node_modules/streamdown': { version: '1.0.0', dependencies: { marked: '^17.0.0', mermaid: '^1.0.0' } },
      'node_modules/react-markdown': { version: '1.0.0', dependencies: { marked: '^17.0.0' } },
      'node_modules/marked': { version: '17.0.6' },
      'node_modules/mermaid': { version: '1.0.0', dependencies: { marked: '^16.0.0' } },
      'node_modules/mermaid/node_modules/marked': { version: '16.4.2' }
    }
    const dests = Object.fromEntries(packedNodeModules(packages).map((p) => [p.id, p.dest]))
    expect(dests['marked@17.0.6']).toBe('node_modules/marked')
    expect(dests['marked@16.4.2']).toBe('node_modules/mermaid/node_modules/marked')
  })

  it('breaks a tie in npm child order, whatever order the lockfile lists the dependencies (marked 17 over mermaid 16)', () => {
    // One dependent each, the #550 shape: the hoister takes the first child it meets, so `.sort(byNpmOrder)` decides.
    const packages: LockPackages = {
      'apps/desktop': { name: 'app', dependencies: { streamdown: '^1.0.0' } },
      'node_modules/streamdown': { version: '1.0.0', dependencies: { mermaid: '^1.0.0', marked: '^17.0.0' } },
      'node_modules/marked': { version: '17.0.6' },
      'node_modules/mermaid': { version: '1.0.0', dependencies: { marked: '^16.0.0' } },
      'node_modules/mermaid/node_modules/marked': { version: '16.4.2' }
    }
    const dests = Object.fromEntries(packedNodeModules(packages).map((p) => [p.id, p.dest]))
    expect(dests['marked@17.0.6']).toBe('node_modules/marked')
    expect(dests['marked@16.4.2']).toBe('node_modules/mermaid/node_modules/marked')
  })

  // release.yml's build-win runs it on the build it packaged (#769); by hand, after a package build:
  // HILBERTRAUM_PACKED_ASAR=release/win-unpacked/resources/app.asar npm test -- tests/integration/packaging.test.ts
  const { asar: packedAsar } = packedArtifact()
  it.skipIf(!packedAsar)('names exactly the package directories of a real app.asar', () => {
    const negations = (builderConfig().files ?? [])
      .filter((f) => f.startsWith('!'))
      .map((f) => globToRegExp(f.slice(1)))
    const predicted = packedNodeModules(lockPackages())
      .map((p) => p.dest)
      .filter((dest) => !negations.some((rx) => rx.test(dest + '/x.js')))
    expect(asarPackageDirs(packedAsar!)).toEqual([...new Set(predicted)].sort())
  })
})

// CODE-1 (full-audit 2026-07-12b): `npm run preview:build` / `screenshot` emit the dev-only
// screenshot-verify preview harness (incl. staged demo chats) to out/preview/, and
// `electron-vite build` clears only out/main|preload|renderer — without a negation a local
// `npm run package` after a screenshot run folds the whole harness into app.asar (dead weight
// plus a discoverable staged demo chat inside a released artifact). Pin the negation like the
// standard-fonts one above: it must exist AND actually match the harness output paths
// while leaving the real out/main|preload|renderer bundles packaged.
describe('electron-builder packaging excludes the dev-only preview harness (CODE-1)', () => {
  it('negates out/preview and only out/preview', () => {
    const files = builderConfig().files ?? []
    const exclusion = files.find((f) => f.startsWith('!') && f.includes('out/preview'))
    expect(exclusion, 'expected a "!out/preview/**" exclusion in files').toBeTruthy()
    const rx = globToRegExp(exclusion!.slice(1))
    for (const p of ['out/preview/preview.html', 'out/preview/assets/preview-x.js']) {
      expect(rx.test(p), `exclusion should match ${p}`).toBe(true)
    }
    for (const p of ['out/main/index.mjs', 'out/preload/index.mjs', 'out/renderer/index.html']) {
      expect(rx.test(p), `exclusion must NOT match the shipped bundle path ${p}`).toBe(false)
    }
  })
})

// #233: out/tools/ holds the drive builders' gate tool, a build-machine tool run with plain node. `npm run build` writes it,
// and release.yml then runs `package:win` on the same tree.
describe('electron-builder packaging excludes the drive builders\' gate tool (#233)', () => {
  it('negates out/tools and only out/tools', () => {
    const exclusion = (builderConfig().files ?? []).find((f) => f.startsWith('!') && f.includes('out/tools'))
    expect(exclusion, 'expected a "!out/tools/**" exclusion in files').toBeTruthy()
    const rx = globToRegExp(exclusion!.slice(1))
    expect(rx.test('out/tools/assert-commercial-drive.mjs')).toBe(true)
    for (const p of ['out/main/index.mjs', 'out/preload/index.mjs', 'out/renderer/index.html']) {
      expect(rx.test(p), `exclusion must NOT match the shipped bundle path ${p}`).toBe(false)
    }
  })
})

// TQ-4 (full-audit 2026-07-12b, §48 LIC-1 follow-up): the desktop package.json `license` field
// is what electron-builder stamps into the artifact metadata; it must never drift from the
// repo-root GPL-3.0-or-later declaration (LICENSE file + root package.json).
describe('desktop package license matches the repo license (TQ-4)', () => {
  it('apps/desktop and root package.json both declare GPL-3.0-or-later', () => {
    const license = (...rel: string[]): unknown => (JSON.parse(repoText(...rel)) as { license?: string }).license
    expect(license('apps', 'desktop', 'package.json')).toBe('GPL-3.0-or-later')
    expect(license('package.json')).toBe('GPL-3.0-or-later')
  })
})

// #769: release.yml compares the tag with apps/desktop/package.json's version alone, and electron-builder stamps that one
// into the artifact, so a bump that misses the root package.json or the lockfile would ship unnoticed.
describe('the release version is one number (#769)', () => {
  it('the root and desktop package.json and the lockfile carry the same version', () => {
    const version = (...rel: string[]): unknown => (JSON.parse(repoText(...rel)) as { version?: string }).version
    const lock = JSON.parse(repoText('package-lock.json')) as { version?: string; packages: Record<string, { version?: string }> }
    const desktop = version('apps', 'desktop', 'package.json')
    expect(desktop).toMatch(/^\d+\.\d+\.\d+$/)
    expect({
      'package.json': version('package.json'),
      'package-lock.json version': lock.version,
      'package-lock.json packages[""]': lock.packages['']?.version,
      'package-lock.json packages["apps/desktop"]': lock.packages['apps/desktop']?.version
    }).toEqual({
      'package.json': desktop,
      'package-lock.json version': desktop,
      'package-lock.json packages[""]': desktop,
      'package-lock.json packages["apps/desktop"]': desktop
    })
  })
})

// PR #30 (portable-build-cleanup): electron-builder derives the per-platform executable /
// AppImage name from the npm package name, which in this workspace is the scoped
// "@hilbertraum/desktop" → "@hilbertraumdesktop"; the '@' is an unsafe path char and the build
// fails (first on the linux AppImage target, then mac/win once the package was renamed). A
// top-level `executableName` pins a path-safe name for every platform. Guard it in the green
// gate — the failure only surfaces when someone runs `npm run package`, never in typecheck/test.
describe('electron-builder pins a path-safe executableName (PR #30)', () => {
  it('sets a top-level executableName equal to productName', () => {
    const cfg = builderConfig()
    expect(cfg.productName, 'productName present').toBe('HilbertRaum')
    expect(cfg.executableName, 'executableName present and matches productName').toBe(
      cfg.productName
    )
    expect(cfg.executableName).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('no per-platform section overrides executableName with a conflicting value', () => {
    const cfg = builderConfig()
    for (const section of ['win', 'mac', 'linux', 'portable'] as const) {
      const override = cfg[section]?.executableName
      // A platform may repeat the same name, but must never disagree with the top-level pin.
      if (override !== undefined) {
        expect(override, `${section}.executableName must match the top-level pin`).toBe(
          cfg.executableName
        )
      }
    }
  })

  it('the portable artifact name is the one the launcher, the sell gate and the release upload expect', () => {
    const pattern = builderConfig().portable?.artifactName ?? ''
    expect(pattern.replace('${version}', '9.9.9')).toBe(KIT_PLATFORM_SPECS['win-x64'].artifact('9.9.9'))
    const glob = pattern.replace('${version}', '*')
    expect(repoText('launchers', 'Start HilbertRaum.cmd')).toContain(glob)
    expect(repoText('.github', 'workflows', 'release.yml')).toContain(`apps/desktop/release/${glob}`)
  })

  it('the release jobs\' targets and the mac entitlements file stay what those jobs build on', () => {
    const cfg = builderConfig()
    expect(cfg.win?.target).toEqual(['portable'])
    expect(cfg.mac?.target).toEqual(['dir'])
    expect(cfg.linux?.target).toEqual(['AppImage'])
    expect(cfg.npmRebuild).toBe(false)
    for (const key of ['entitlements', 'entitlementsInherit']) {
      expect(existsSync(join(DESKTOP_ROOT, String(cfg.mac?.[key]))), key).toBe(true)
    }
  })
})

// DEP-1 §5 follow-up #1, discharged by wave DEP-4 (plan P1). `electron-builder.yml`'s
// `electronVersion:` — NOT the npm `electron` devDependency — selects the runtime that is
// actually packaged: electron-builder 26 runs from apps/desktop and cannot resolve the hoisted
// `^`-range devDep, so the field is a hand-maintained pin. DEP-1 §4(b) records what that costs:
// the first `package:win` of that wave silently shipped Electron 37 after the devDep had been
// bumped to 39, and it was caught only because a human happened to notice. The failure is
// invisible to typecheck, test and CI — it surfaces only in the bytes of a release artifact,
// which is the worst possible place to find a stale, still-vulnerable runtime.
//
// The lockfile is the source of truth here, not `node_modules`: it is committed, deterministic,
// and it is what `npm ci` installs on every CI leg and release runner. A node_modules-only check
// would false-pass against a stale local install. The installed copy is checked too, but only
// when present — CI legs set ELECTRON_SKIP_BINARY_DOWNLOAD and a slimmed context may have no
// electron at all.
describe('electron-builder.yml electronVersion tracks the electron devDependency (DEP-1 §5 #1)', () => {
  /** The version the lockfile pins for the hoisted root `node_modules/electron`. */
  function lockedElectronVersion(): string {
    const entry = lockPackages()['node_modules/electron']
    expect(entry?.version, 'package-lock.json pins node_modules/electron').toBeTruthy()
    return entry!.version!
  }

  it('electronVersion EQUALS the electron version pinned in package-lock.json', () => {
    // `electronVersion: 43.0` is valid YAML and parses to the number 43 — electron-builder
    // would then look for a nonexistent "43" release. Two dots keep it a string; no String() here.
    const pinned = builderConfig().electronVersion
    expect(
      pinned,
      'electron-builder.yml packages this exact runtime — if it disagrees with the lockfile, ' +
        'the release artifact ships a different Electron than the one CI tested (DEP-1 §4(b))'
    ).toBe(lockedElectronVersion())
  })

  // A row holding electronVersion to the declared caret range retired with #770 (owner call): `npm ci` installs the
  // lockfile's version, which can only satisfy that range, so the row above is the guard.
  it('the INSTALLED electron agrees too, when node_modules is present', (ctx) => {
    const manifest = join(REPO_ROOT, 'node_modules', 'electron', 'package.json')
    if (!existsSync(manifest)) {
      expect(process.env.CI, 'CI runs npm ci, so electron is installed at the repo root').toBeFalsy()
      ctx.skip()
    }
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }
    expect(version, 'a stale node_modules would package a runtime nobody tested').toBe(
      String(builderConfig().electronVersion)
    )
  })
})

// #560 + #562: the packaged binary's fuses. electron-builder flips them via @electron/fuses before
// signing; an option name it does not map is IGNORED SILENTLY (the fuse would keep its default),
// hence the exact pin and one mapping check per option. Measured, with the reasons, in
// docs/architecture.md "Electron fuses — design record (#562)"; the built exe's wire is re-checked
// by hand (docs/packaging.md "Electron fuses").
const FUSE_OPTIONS: ReadonlyArray<readonly [yamlKey: string, fuse: string, wireAt: number]> = [
  ['runAsNode', 'RunAsNode', 0],
  ['enableNodeOptionsEnvironmentVariable', 'EnableNodeOptionsEnvironmentVariable', 2],
  ['enableNodeCliInspectArguments', 'EnableNodeCliInspectArguments', 3],
  ['enableEmbeddedAsarIntegrityValidation', 'EnableEmbeddedAsarIntegrityValidation', 4],
  ['onlyLoadAppFromAsar', 'OnlyLoadAppFromAsar', 5],
  ['grantFileProtocolExtraPrivileges', 'GrantFileProtocolExtraPrivileges', 7]
]

describe('electron-builder.yml electronFuses (#560, #562)', () => {
  it('pins the fuse set exactly', () => {
    expect(builderConfig().electronFuses).toEqual({
      // #562: ELECTRON_RUN_AS_NODE and --inspect no longer reach the main process.
      runAsNode: false,
      enableNodeCliInspectArguments: false,
      // #562, owner decision: stays ON — off, NODE_EXTRA_CA_CERTS is dropped and the in-app
      // downloads fail behind TLS-scanning antivirus / proxies (measured).
      enableNodeOptionsEnvironmentVariable: true,
      // #562: a modified app.asar ends the app; only app.asar is ever loaded.
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      // #560: file:// pages lose the extra privileges (the app's pages are on hilbertraum://app).
      grantFileProtocolExtraPrivileges: false,
      resetAdHocDarwinSignature: true
    })
  })

  /** The whole wire `scripts/verify-mac-build.sh` checks a built binary against: the six fuses above plus Electron's defaults. */
  const expectedWire = (): string =>
    /^EXPECTED_WIRE="(\d{9})"$/m.exec(repoText('scripts', 'verify-mac-build.sh'))?.[1] ?? ''

  it('verify-mac-build.sh expects the wire electronFuses sets', () => {
    const wire = expectedWire()
    const fuses = builderConfig().electronFuses ?? {}
    expect(FUSE_OPTIONS.map(([, , at]) => wire[at])).toEqual(FUSE_OPTIONS.map(([key]) => (fuses[key] ? '1' : '0')))
  })

  // #769: the rows here read the yml and the installed electron-builder; this one reads the wire off a real packaged
  // executable (HILBERTRAUM_PACKED_EXE; release.yml's build-win names the one it just built), decoded by the
  // @electron/fuses that electron-builder flips the fuses with.
  const { exe: packedExe } = packedArtifact()
  it.skipIf(!packedExe)('a real packaged executable carries the expected fuse wire (#562, #769)', async () => {
    expect(await packedFuseWire(packedExe!)).toBe(expectedWire())
  })

  it('keeps what the integrity fuses need: an asar, and the header hash electron-builder writes', () => {
    const cfg = builderConfig()
    // onlyLoadAppFromAsar loads nothing but app.asar; without the hash the binary refuses to start.
    expect(cfg.asar).toBe(true)
    expect(cfg.disableAsarIntegrity).toBeUndefined()
  })

  it('the installed electron-builder still maps every option to its fuse (a rename would be a silent no-op)', () => {
    const src = builderFile('out', 'platformPackager.js')
    expect(
      [...FUSE_OPTIONS.map(([key]) => key), 'resetAdHocDarwinSignature'].sort(),
      'a new yml fuse needs a row in FUSE_OPTIONS'
    ).toEqual(Object.keys(builderConfig().electronFuses ?? {}).sort())
    for (const [key, fuse] of FUSE_OPTIONS) {
      const assignment = String.raw`config\[FuseV1Options\.` + fuse + String.raw`\]\s*=\s*fuses\.` + key + String.raw`\b`
      expect(src, key).toMatch(new RegExp(assignment))
    }
    expect(src).toMatch(/resetAdHocDarwinSignature:\s*fuses\.resetAdHocDarwinSignature/)
  })

  it('the installed electron-builder still computes the asar hash and writes it where Electron reads it', () => {
    const packager = builderFile('out', 'platformPackager.js')
    const framework = builderFile('out', 'electron', 'ElectronFramework.js')
    const mac = builderFile('out', 'electron', 'electronMac.js')
    const win = builderFile('out', 'electron', 'electronWin.js')
    expect(packager).toMatch(/asarIntegrity\s*=\s*await \(0, integrity_1\.computeData\)/)
    // Windows: the exe's INTEGRITY/ELECTRONASAR resource; macOS: Info.plist ElectronAsarIntegrity.
    expect(framework).toMatch(/addWinAsarIntegrity\)\(executable, options\.asarIntegrity\)/)
    expect(win).toMatch(/type:\s*"INTEGRITY"/)
    expect(win).toMatch(/id:\s*"ELECTRONASAR"/)
    expect(mac).toMatch(/appPlist\.ElectronAsarIntegrity\s*=/)
  })
})

// #769: release.yml's build-win runs this file, third-party-notices.test.ts and asar-unpack-closure.test.ts against the
// build it just packaged, naming it through HILBERTRAUM_PACKED_ASAR / _EXE. Unset, every real-archive row skips, so the
// step also sets HILBERTRAUM_PACKED_REQUIRED=1: a renamed variable or a moved build then fails here instead.
describe('the real-archive rows cannot skip where a build is required (#769)', () => {
  const packed = packedArtifact()
  it.runIf(packed.required)('HILBERTRAUM_PACKED_REQUIRED: the packaged app.asar and executable are both named and exist', () => {
    expect(packedPathExists(packed.asar), `${PACKED_ENV.asar} names ${packed.asar ?? 'nothing'}`).toBe(true)
    expect(packedPathExists(packed.exe), `${PACKED_ENV.exe} names ${packed.exe ?? 'nothing'}`).toBe(true)
  })

  // A workflow change first runs at a tag, so the step's wiring is read here, on every PR: the variables the rows read,
  // the paths electron-builder writes (its output directory and executableName), and the three files.
  it('release.yml build-win runs these files on the packaged build after package:win, with the guard on', () => {
    interface Step {
      run?: string
      env?: Record<string, string>
      'working-directory'?: string
    }
    const workflow = parseYaml(repoText('.github', 'workflows', 'release.yml')) as { jobs: Record<string, { steps: Step[] }> }
    const steps = workflow.jobs['build-win'].steps
    const step = steps.find((s) => s.env?.[PACKED_ENV.required] !== undefined)
    expect(step, `build-win has a step that sets ${PACKED_ENV.required}`).toBeDefined()
    const cfg = builderConfig()
    const unpacked = `${(cfg.directories as { output: string }).output}/win-unpacked`
    expect(step!['working-directory']).toBe('apps/desktop')
    expect(step!.env).toEqual({
      [PACKED_ENV.asar]: `${unpacked}/resources/app.asar`,
      [PACKED_ENV.exe]: `${unpacked}/${cfg.executableName}.exe`,
      [PACKED_ENV.required]: '1'
    })
    const files = (step!.run ?? '').split(/\s+/).filter((arg) => arg.endsWith('.test.ts'))
    expect(files.sort()).toEqual([
      'tests/integration/asar-unpack-closure.test.ts',
      'tests/integration/packaging.test.ts',
      'tests/integration/third-party-notices.test.ts'
    ])
    for (const file of files) expect(existsSync(join(DESKTOP_ROOT, file)), file).toBe(true)
    const packageAt = steps.findIndex((s) => s.run === 'npm run package:win')
    expect(packageAt, 'build-win runs npm run package:win').toBeGreaterThan(-1)
    expect(steps.indexOf(step!), 'the check runs on the build package:win made').toBeGreaterThan(packageAt)
  })
})
