import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import * as ts from 'typescript'
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
import { APP_SCHEME } from '../../src/main/app-protocol'

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
      // #564: OFF — NODE_OPTIONS and NODE_EXTRA_CA_CERTS no longer reach the main process. The
      // in-app downloads trust the OS certificate store instead (services/net/trust.ts), where
      // TLS-scanning antivirus and proxies install their root; on until #564 (owner decision, #562).
      enableNodeOptionsEnvironmentVariable: false,
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

// App-update W-15 (spike 8; docs/app-updates.md §8.7): on Windows the profile is `%APPDATA%\<app.getName()>`, and Electron
// takes that name from the packaged package.json, `productName` if present, else `name`. Today it is the `name`, so every
// version, Kit, exe name, folder and drive letter shares `%APPDATA%\@hilbertraum\desktop`. The single-instance lock, the
// workspace of an app started without a drive, and the UI preferences hang on that path, and a release that moved it
// could not be told from a first start: two versions on one computer would stop excluding each other, on Kits already
// sold. So the five things that decide it are pinned for ever. These rows read names; the path itself is read on the
// built artifact by release.yml's build-win step (the last row here reads that step on every PR).
describe("the user-data folder's name never moves (app-update W-15, spike 8)", () => {
  const PROFILE_NAME = '@hilbertraum/desktop'
  const desktopPkg = JSON.parse(repoText('apps', 'desktop', 'package.json')) as Record<string, unknown>
  const rel = (path: string): string => relative(REPO_ROOT, path).split(sep).join('/')
  // What a build or a start can be changed through: the start files, every script (the drive builders, the release
  // tools, the app's own script folder) and the workflows. `/./`: every file, whatever its extension.
  const scriptFiles = (): string[] =>
    ['launchers', 'scripts', join('apps', 'desktop', 'scripts'), join('.github', 'workflows')].flatMap((root) =>
      filesUnder(join(REPO_ROOT, root), /./)
    )
  // Every `extraMetadata` in a text that is not `extraMetadata.version`, with the up to 24 characters behind it. The
  // lookahead consumes nothing, so a second override inside those characters is matched too.
  const extraMetadataOverrides = (text: string): string[] =>
    [...text.matchAll(/extraMetadata(?=(.{0,24}))/g)].filter((m) => !/^\.version\b/.test(m[1]!)).map((m) => `${m[0]}${m[1]}`)

  it('(i) apps/desktop/package.json is named @hilbertraum/desktop', () => {
    expect(desktopPkg.name).toBe(PROFILE_NAME)
  })

  // electron-builder copies `extraMetadata` over the packaged package.json, so a `name` or `productName` there moves the
  // profile exactly as the source field would. `-c.extraMetadata.version` stays allowed: the version is not in the path.
  it('(ii) no productName reaches the packaged package.json, and nothing overrides its name', () => {
    expect(Object.keys(desktopPkg)).not.toContain('productName')
    // A `build` object in package.json would be a second electron-builder config beside electron-builder.yml.
    expect(desktopPkg.build).toBeUndefined()
    const extra = (builderConfig().extraMetadata ?? {}) as Record<string, unknown>
    expect(Object.keys(extra).filter((key) => key !== 'version')).toEqual([])
    const texts = [join(REPO_ROOT, 'package.json'), join(DESKTOP_ROOT, 'package.json'), ...scriptFiles()]
    const offenders = texts.flatMap((path) => extraMetadataOverrides(readFileSync(path, 'utf8')).map((found) => `${rel(path)}: ${found}`))
    expect(offenders, 'only extraMetadata.version may be set').toEqual([])
  })

  // The scan above judges every `extraMetadata` in a text, also a second one right behind an allowed one: a build
  // command that already sets the version is where a name override would be added.
  it('(ii) the scan reads every extraMetadata override on a line, not only the first', () => {
    expect(extraMetadataOverrides('electron-builder --win portable -c.extraMetadata.version=$V')).toEqual([])
    expect(extraMetadataOverrides('electron-builder -c.extraMetadata.version=$V -c.extraMetadata.name=x')).toEqual(['extraMetadata.name=x'])
    expect(extraMetadataOverrides('"-c.extraMetadata.version=$v" "-c.extraMetadata.productName=X"')).toEqual([
      'extraMetadata.productName=X"'
    ])
    expect(extraMetadataOverrides('electron-builder -c.extraMetadata.versionName=1')).toEqual(['extraMetadata.versionName=1'])
  })

  const PROFILE_PATH_NAMES = ['userData', 'appData', 'sessionData']
  it("(iii) src/main moves userData only for a dev run, never renames the app, and takes the lock at module top level after that", () => {
    const sources = filesUnder(join(DESKTOP_ROOT, 'src', 'main'), /\.ts$/).map((path) =>
      ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    )
    const where = (n: ts.Node): string => {
      const source = n.getSourceFile()
      return `${rel(source.fileName)}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
    }
    const calleeName = (n: ts.CallExpression): string | undefined =>
      ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : undefined
    const setPathCalls: ts.CallExpression[] = []
    const renames: string[] = []
    const lockCalls: ts.CallExpression[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n)
        const first = n.arguments[0]
        // Three path names move the profile: `userData` itself, `appData` (userData is derived from it, `<appData>\<name>`,
        // when first asked for) and `sessionData` (Local Storage and the caches). A setPath whose first argument is not
        // a plain string cannot be judged, so it counts as one of them.
        if (name === 'setPath' && !(first !== undefined && ts.isStringLiteralLike(first) && !PROFILE_PATH_NAMES.includes(first.text))) setPathCalls.push(n)
        if (name === 'setName') renames.push(where(n))
        if (name === 'requestSingleInstanceLock') lockCalls.push(n)
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === 'name' &&
        ts.isIdentifier(n.left.expression) &&
        n.left.expression.text === 'app'
      ) {
        renames.push(where(n))
      }
      ts.forEachChild(n, visit)
    }
    for (const source of sources) visit(source)

    expect(renames, 'app.setName(...) and app.name = ... move the profile').toEqual([])

    // The one setPath of a profile path: `if (isDev) app.setPath('userData', ...)`, a statement of main/index.ts itself,
    // where `isDev` is `!app.isPackaged`. A packaged build never takes it. `appData` and `sessionData` are never set,
    // not even there. A move made after the lock is one only this row sees: the lock's file is already at the old path
    // then, so release.yml's start of the built exe still finds it.
    expect(setPathCalls.map((c) => rel(c.getSourceFile().fileName))).toEqual(['apps/desktop/src/main/index.ts'])
    const setPath = setPathCalls[0]!
    const index = setPath.getSourceFile()
    const guard = setPath.parent.parent
    const moved = setPath.arguments[0]
    expect(moved !== undefined && ts.isStringLiteralLike(moved) ? moved.text : moved?.getText(), `${where(setPath)} sets`).toBe('userData')
    expect(
      ts.isExpressionStatement(setPath.parent) &&
        ts.isIfStatement(guard) &&
        guard.parent === index &&
        guard.thenStatement === setPath.parent &&
        guard.elseStatement === undefined &&
        ts.isIdentifier(guard.expression) &&
        guard.expression.text === 'isDev',
      `${where(setPath)} is "if (isDev) app.setPath('userData', ...)" at module top level`
    ).toBe(true)
    const isDevInits = index.statements.flatMap((s) =>
      ts.isVariableStatement(s)
        ? s.declarationList.declarations.filter((d) => ts.isIdentifier(d.name) && d.name.text === 'isDev').map((d) => d.initializer?.getText())
        : []
    )
    expect(isDevInits).toEqual(['!app.isPackaged'])

    // The lock is keyed on userData: taken once, by a statement of main/index.ts itself (not inside a function, a
    // branch or a block), after the dev move.
    expect(lockCalls.map((c) => rel(c.getSourceFile().fileName))).toEqual(['apps/desktop/src/main/index.ts'])
    const lock = lockCalls[0]!
    let top: ts.Node = lock
    const nested: string[] = []
    while (top.parent !== index) {
      top = top.parent
      if (ts.isFunctionLike(top) || ts.isBlock(top) || ts.isIfStatement(top) || ts.isConditionalExpression(top)) nested.push(ts.SyntaxKind[top.kind]!)
    }
    expect(nested, `${where(lock)} sits inside`).toEqual([])
    expect(index.statements.indexOf(top as ts.Statement)).toBeGreaterThan(index.statements.indexOf(guard as ts.Statement))
  })

  // A start with `--user-data-dir` gets a profile and a lock of its own (spike 8, case d2: both instances run). Three
  // dev tools pass a scratch one on purpose, so that a measurement never opens the computer's real profile.
  const PROFILE_SWITCH_TOOLS = ['scripts/verify-mac-build.sh', 'scripts/check-netlog.mjs', 'scripts/release/run-hold.ps1']
  it('(iv) no start file, script, workflow or app source passes the app a profile switch', () => {
    const scanned = scriptFiles().filter((path) => !PROFILE_SWITCH_TOOLS.includes(rel(path)))
    for (const tool of PROFILE_SWITCH_TOOLS) expect(existsSync(join(REPO_ROOT, tool)), tool).toBe(true)
    const switches = scanned.flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/--user-data-dir|--profile-directory/gi)].map((m) => `${rel(path)}: ${m[0]}`)
    )
    expect(switches).toEqual([])
    // What goes into the build or runs inside it: the build config (`linux.executableArgs` is the AppImage's start
    // line), the npm scripts of both package.json files, and the app's own source. There the switch's bare name is
    // refused, so `appendSwitch('user-data-dir', ...)` counts too.
    const pkgScripts = (path: string): Array<[string, string]> =>
      Object.entries((JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}).map(
        ([name, command]): [string, string] => [`${rel(path)} scripts.${name}`, command]
      )
    const builderConfigs = readdirSync(DESKTOP_ROOT).filter((name) => /^electron-builder\b/.test(name))
    expect(builderConfigs).toEqual(['electron-builder.yml'])
    const built: Array<[string, string]> = [
      ...[...builderConfigs.map((name) => join(DESKTOP_ROOT, name)), ...filesUnder(join(DESKTOP_ROOT, 'src'), /\.(ts|tsx|html)$/)].map(
        (path): [string, string] => [rel(path), readFileSync(path, 'utf8')]
      ),
      ...pkgScripts(join(REPO_ROOT, 'package.json')),
      ...pkgScripts(join(DESKTOP_ROOT, 'package.json'))
    ]
    expect(built.filter(([label]) => label.includes(' scripts.')).length, 'the scan found the npm scripts').toBeGreaterThan(10)
    expect(built.flatMap(([label, text]) => [...text.matchAll(/user-data-dir|profile-directory/gi)].map((m) => `${label}: ${m[0]}`))).toEqual([])
    // The start files' other way to move it: the folder the profile is derived from (`%APPDATA%`, `$XDG_CONFIG_HOME`,
    // `$HOME`) set for the app they start.
    const envMoves = filesUnder(join(REPO_ROOT, 'launchers'), /./).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/\b(APPDATA|LOCALAPPDATA|USERPROFILE|XDG_CONFIG_HOME|HOME)=/g)].map((m) => `${rel(path)}: ${m[0]}`)
    )
    expect(envMoves).toEqual([])
  })

  // None of these four moves the Windows profile, and each is fixed for another reason: `appId` is the macOS bundle id,
  // `productName` and `executableName` name the artifacts the start files look for, and the stored pages' origin is the
  // scheme. (The PR #30 rows above and app-protocol.test.ts read three of them for their own reasons.)
  it('(v) appId, the app scheme, productName and executableName stay', () => {
    const cfg = builderConfig()
    expect({ appId: cfg.appId, scheme: APP_SCHEME, productName: cfg.productName, executableName: cfg.executableName }).toEqual({
      appId: 'space.hilbertraum.app',
      scheme: 'hilbertraum',
      productName: 'HilbertRaum',
      executableName: 'HilbertRaum'
    })
  })

  // Rows (i)-(iii) pin what the path derives from; only a start of the built exe reads the path itself (T1.11 S8-1). The
  // step can run only where a build was packaged, so its wiring is read here: it starts the portable exe package:win
  // made, with a scratch drive root and no profile switch (row (iv) scans the workflows), and looks for the profile
  // under the name pinned in (i).
  it("release.yml build-win starts the packaged exe and looks for its profile under %APPDATA%\\@hilbertraum\\desktop", () => {
    interface Step {
      run?: string
      env?: Record<string, string>
      if?: unknown
      'continue-on-error'?: unknown
    }
    const workflow = parseYaml(repoText('.github', 'workflows', 'release.yml')) as {
      jobs: Record<string, { steps: Step[]; needs?: string | string[]; if?: unknown; 'continue-on-error'?: unknown }>
    }
    const steps = workflow.jobs['build-win'].steps
    const profile = `'${PROFILE_NAME.replace('/', '\\')}'`
    const found = steps.filter((s) => (s.run ?? '').includes(`Join-Path $env:APPDATA ${profile}`))
    expect(found, `one build-win step reads Join-Path $env:APPDATA ${profile}`).toHaveLength(1)
    const step = found[0]!
    expect(steps.indexOf(step)).toBeGreaterThan(steps.findIndex((s) => s.run === 'npm run package:win'))
    const artifact = (builderConfig().portable?.artifactName ?? '').replace('${version}', '*')
    expect(step.run).toContain(`apps/desktop/release/${artifact}`)
    expect(step.env?.HILBERTRAUM_DRIVE_ROOT).toMatch(/^\$\{\{ runner\.temp \}\}./)
    // The step blocks the release: it always runs, its failure fails build-win, and the job that publishes waits for
    // build-win.
    expect(step.if, 'the step has no if:').toBeUndefined()
    expect(step['continue-on-error'], 'the step has no continue-on-error').toBeUndefined()
    expect(workflow.jobs['build-win']['continue-on-error'], 'build-win has no continue-on-error').toBeUndefined()
    expect([workflow.jobs.release.needs].flat()).toContain('build-win')
  })
})

// App-update W-3 (F-3; docs/app-updates.md §2.7, "The release guard's reading"; T4.3): each build leg checks that the
// app.asar it just packaged embeds this checkout's keys.json, by running updates-bundle-check.test.ts with
// HILBERTRAUM_PACKED_ASAR naming that asar (its packed row fails when the named file is missing). A workflow change first
// runs at a dispatch or a tag, so the three steps' wiring is read here on every PR: the command (the file path; `-t`
// alone would collect and import every test file), the asar path electron-builder writes on each runner (its output
// directory and productName), the order after the package step, and nothing that lets a red step pass. The steps never set
// HILBERTRAUM_PACKED_REQUIRED, which demands the executable too (the #769 rows above). The mac leg resolves its
// `release/mac-<arch>/` folder in the step, with a Bash 3.2 script that refuses anything but one match.
describe("release.yml's three build legs check the packed app's embedded update keys (app-update W-3)", () => {
  interface Step {
    name?: string
    run?: string
    uses?: string
    with?: Record<string, unknown>
    env?: Record<string, string>
    if?: unknown
    'continue-on-error'?: unknown
    'working-directory'?: string
  }
  interface Job {
    steps: Step[]
    needs?: string | string[]
    'continue-on-error'?: unknown
  }
  const TEST_FILE = 'tests/unit/updates-bundle-check.test.ts'
  const COMMAND = `npx vitest run ${TEST_FILE}`
  const cfg = builderConfig()
  const output = (cfg.directories as { output: string }).output
  const jobs = (parseYaml(repoText('.github', 'workflows', 'release.yml')) as { jobs: Record<string, Job> }).jobs

  const LEGS: ReadonlyArray<{ job: string; packageRun: string; anchor: string; isAnchor: (s: Step) => boolean }> = [
    { job: 'build-win', packageRun: 'npm run package:win', anchor: 'the #769 packaged-app check', isAnchor: (s) => s.env?.[PACKED_ENV.required] !== undefined },
    { job: 'build-mac', packageRun: 'npm run package', anchor: 'the ad-hoc sign and zip', isAnchor: (s) => (s.run ?? '').split('\n').some((l) => l.trim().startsWith('codesign --force ')) },
    { job: 'build-linux', packageRun: 'npm run package', anchor: 'the AppImage upload', isAnchor: (s) => s.with?.name === 'linux-appimage' }
  ]

  it.each(LEGS)('$job runs the key check once, after its package step and after $anchor, and nothing lets it pass red', ({ job, packageRun, isAnchor }) => {
    expect(existsSync(join(DESKTOP_ROOT, TEST_FILE)), TEST_FILE).toBe(true)
    const steps = jobs[job]!.steps
    const found = steps.filter((s) => (s.run ?? '').includes(TEST_FILE))
    expect(found, `${job} has one step that runs ${TEST_FILE}`).toHaveLength(1)
    const step = found[0]!
    expect(step['working-directory']).toBe('apps/desktop')
    const packageAt = steps.findIndex((s) => s.run === packageRun)
    expect(packageAt, `${job} runs ${packageRun}`).toBeGreaterThan(-1)
    const anchorAt = steps.findIndex(isAnchor)
    expect(anchorAt, `${job} has the step the check follows`).toBeGreaterThan(packageAt)
    expect(steps.indexOf(step), 'the check reads the build that step packaged').toBeGreaterThan(anchorAt)
    expect(step.if, 'the step has no if:').toBeUndefined()
    expect(step['continue-on-error'], 'the step has no continue-on-error').toBeUndefined()
    expect(jobs[job]!['continue-on-error'], `${job} has no continue-on-error`).toBeUndefined()
    expect([jobs.release!.needs].flat(), `the release job waits for ${job}`).toContain(job)
    expect(`${JSON.stringify(step.env ?? {})} ${step.run}`).not.toContain(PACKED_ENV.required)
  })

  it('build-win and build-linux name the unpacked app.asar electron-builder leaves in place', () => {
    for (const [job, unpacked] of [['build-win', 'win-unpacked'], ['build-linux', 'linux-unpacked']] as const) {
      const step = jobs[job]!.steps.find((s) => (s.run ?? '').includes(TEST_FILE))
      expect({ env: step?.env, run: step?.run }, job).toEqual({ env: { [PACKED_ENV.asar]: `${output}/${unpacked}/resources/app.asar` }, run: COMMAND })
    }
  })

  it("build-mac resolves release/mac*/ to exactly one app.asar in the step, in Bash 3.2's syntax", () => {
    const step = jobs['build-mac']!.steps.find((s) => (s.run ?? '').includes(TEST_FILE))
    expect(step?.env).toEqual(undefined)
    const code = (step?.run ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
    expect(code).toEqual([
      'set -euo pipefail',
      `set -- ${output}/mac*/${cfg.productName}.app/Contents/Resources/app.asar`,
      expect.stringMatching(/^if \[ "\$#" -ne 1 \] \|\| \[ ! -f "\$1" \]; then echo .+ >&2; exit 1; fi$/),
      `${PACKED_ENV.asar}="$1" ${COMMAND}`
    ])
  })
})
