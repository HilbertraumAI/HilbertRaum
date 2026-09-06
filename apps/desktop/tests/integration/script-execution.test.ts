import { describe, it, expect, vi } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Executes the drive-builder scripts (#233, #234) — unlike script-drift.test.ts, which is
// text-only by charter. Every case is OFFLINE and deterministic: the fetch-runtime cases
// stop before any download (placeholder hash refused, or the install skipped), and the
// builder cases run only its verify-only gate or its up-front refusal. The .ps1 leg runs
// on Windows, the .sh leg elsewhere (CI runs `npm test` on both).

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const SCRIPTS = join(REPO_ROOT, 'scripts')
const GATE_TOOL = join(REPO_ROOT, 'apps', 'desktop', 'out', 'tools', 'assert-commercial-drive.mjs')
const toolBuilt = existsSync(GATE_TOOL)
if (!toolBuilt) {
  console.warn(`script-execution: ${GATE_TOOL} is not built (run \`npm run build\`) — the gate cases are skipped`)
}

// The child is killed before vitest's own budget (below) expires, so a hung script fails
// with its output attached instead of as a bare test timeout.
const CHILD_TIMEOUT_MS = 60_000

const PLACEHOLDER = 'REPLACE_WITH_REAL_HASH'
const REAL_SHA = 'a'.repeat(64)

/** A runtime-sources.yaml whose sha256 fields are all `sha`; URLs on a reserved TLD. */
function runtimeSourcesYaml(sha: string): string {
  return [
    'llama_cpp:',
    '  version: b9585',
    '  builds:',
    '    - os: win',
    '      arch: x64',
    '      backend: vulkan',
    '      url: https://example.invalid/llama-b9585-bin-win-vulkan-x64.zip',
    `      sha256: ${sha}`,
    '      extract_to: runtime/llama.cpp/win',
    '    - os: linux',
    '      arch: x64',
    '      backend: vulkan',
    '      url: https://example.invalid/llama-b9585-bin-ubuntu-vulkan-x64.tar.gz',
    `      sha256: ${sha}`,
    '      extract_to: runtime/llama.cpp/linux',
    'kiwix_tools:',
    "  version: '3.8.1'",
    '  optional: true',
    '  executables: [kiwix-serve, kiwix-manage, kiwix-search]',
    '  builds:',
    '    - os: win',
    '      arch: x64',
    '      backend: cpu',
    '      url: https://example.invalid/kiwix-tools_win-x86_64-3.8.1.zip',
    `      sha256: ${sha}`,
    '      extract_to: runtime/kiwix-tools/win',
    '      runtime_files: [icudt74.dll, icuin74.dll, icuio74.dll, icutu74.dll, icuuc74.dll]',
    '    - os: mac',
    '      arch: arm64',
    '      backend: cpu',
    '      url: https://example.invalid/kiwix-tools_macos-arm64-3.8.1.tar.gz',
    `      sha256: ${sha}`,
    '      extract_to: runtime/kiwix-tools/mac',
    '    - os: mac',
    '      arch: x64',
    '      backend: cpu',
    '      url: https://example.invalid/kiwix-tools_macos-x86_64-3.8.1.tar.gz',
    `      sha256: ${sha}`,
    '      extract_to: runtime/kiwix-tools/mac',
    '    - os: linux',
    '      arch: x64',
    '      backend: cpu',
    '      url: https://example.invalid/kiwix-tools_linux-x86_64-3.8.1.tar.gz',
    `      sha256: ${sha}`,
    '      extract_to: runtime/kiwix-tools/linux',
    'ocr:',
    '  version: 4.0.0_best_int',
    '  files:',
    '    - lang: deu',
    '      url: https://example.invalid/deu.traineddata.gz',
    `      sha256: ${sha}`,
    '      dest: ocr/deu.traineddata.gz',
    ''
  ].join('\n')
}

function scratchTarget(sha: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-exec-'))
  mkdirSync(join(root, 'model-manifests'), { recursive: true })
  writeFileSync(join(root, 'model-manifests', 'runtime-sources.yaml'), runtimeSourcesYaml(sha))
  return root
}

/** A win vulkan install: binary + marker (hashless unless `withHash`). */
function installWinBuild(root: string, withHash: boolean): void {
  const dir = join(root, 'runtime', 'llama.cpp', 'win')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'llama-server.exe'), 'fake-binary')
  const marker: Record<string, unknown> = { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' }
  if (withHash) marker.binaries = { 'llama-server.exe': REAL_SHA }
  writeFileSync(join(dir, '.hilbertraum-runtime.json'), JSON.stringify(marker))
}

interface Leg {
  name: string
  skip: boolean
  run: (script: string, args: string[]) => SpawnSyncReturns<string>
  ext: 'ps1' | 'sh'
  flag: (name: string) => string
}

const LEGS: Leg[] = [
  {
    name: 'PowerShell scripts (.ps1)',
    skip: process.platform !== 'win32',
    ext: 'ps1',
    flag: (n) => `-${n}`,
    run: (script, args) =>
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(SCRIPTS, script), ...args],
        { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, windowsHide: true }
      )
  },
  {
    name: 'bash scripts (.sh)',
    // Git Bash on a Windows dev box can run this leg too: HILBERTRAUM_SCRIPT_SH_LEG=1.
    skip: process.platform === 'win32' && !process.env.HILBERTRAUM_SCRIPT_SH_LEG,
    ext: 'sh',
    flag: (n) => `--${n.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    run: (script, args) =>
      spawnSync('bash', [join(SCRIPTS, script), ...args], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS })
  }
]

const text = (r: SpawnSyncReturns<string>): string => `${r.stdout ?? ''}\n${r.stderr ?? ''}`

// A shell + a node child per case: well under a second on Linux, several seconds under
// PowerShell or Git Bash on a loaded Windows runner — give every case in this file real headroom.
const CASE_TIMEOUT_MS = 90_000
vi.setConfig({ testTimeout: CASE_TIMEOUT_MS })

for (const leg of LEGS) {
  describe.skipIf(leg.skip)(`script execution — ${leg.name}`, () => {
    const builder = `build-commercial-drive.${leg.ext}`
    const fetcher = `fetch-runtime.${leg.ext}`
    const f = leg.flag

    describe('build-commercial-drive verify-only gate (#233)', () => {
      it.skipIf(!toolBuilt)('runs the canonical gate offline and prints NOT SELLABLE for an empty target', () => {
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-gate-'))
        const r = leg.run(builder, [f('Target'), root, f('VerifyOnly')])
        const out = text(r)
        expect(r.status, out).toBe(1)
        expect(out).toContain('NOT SELLABLE')
        expect(out).toContain('Canonical gate:')
        // An EMPTY target has no drive declaration, so the canonical gate reports
        // missing policy/manifests rather than platform-specific app artifacts.
        // The tool filename is not part of either script's successful invocation output.
        expect(out).toContain('config/policy.json missing')
        expect(out).toContain('model-manifests missing on the drive')
        expect(out).not.toMatch(/^\s*SELLABLE:/m)
        expect(out).not.toContain('Done. Test the drive')
      })

      it('rejects an unknown platform label before doing anything (exit 2)', () => {
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-plat-'))
        const r = leg.run(builder, [f('Target'), root, f('VerifyOnly'), f('Platforms'), 'win-arm64'])
        expect(r.status, text(r)).toBe(2)
        expect(text(r)).toContain('win-arm64')
      })

      it('refuses to proceed when a differently named app artifact already sits at the root', () => {
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-prior-'))
        writeFileSync(join(root, 'HilbertRaum-0.1.58-portable.exe'), 'old')
        const src = mkdtempSync(join(tmpdir(), 'hilbertraum-script-artifact-'))
        const artifact = join(src, 'HilbertRaum-0.1.59-portable.exe')
        writeFileSync(artifact, 'new')
        const r = leg.run(builder, [f('Target'), root, f('AppArtifact'), artifact, f('DryRun')])
        const out = text(r)
        expect(r.status, out).toBe(1)
        expect(out).toContain('HilbertRaum-0.1.58-portable.exe')
        expect(out).not.toContain('[1]') // refused before step 1 ran
        expect(existsSync(join(root, 'HilbertRaum-0.1.59-portable.exe'))).toBe(false)
      })
    })

    describe('fetch-runtime commercial mode (#234)', () => {
      const commercialArgs = (root: string, extra: string[] = []): string[] => [
        f('Target'),
        root,
        f('Os'),
        'win',
        f('Commercial'),
        ...extra
      ]

      it('refuses a placeholder archive hash BEFORE any download: nothing extracted, no marker', () => {
        const root = scratchTarget(PLACEHOLDER)
        const r = leg.run(fetcher, commercialArgs(root))
        const out = text(r)
        expect(r.status, out).toBe(1)
        expect(out).toMatch(/placeholder/i)
        expect(existsSync(join(root, 'runtime'))).toBe(false)
      })

      it('does not SKIP a hashless (legacy) install: the placeholder is refused instead', () => {
        const root = scratchTarget(PLACEHOLDER)
        installWinBuild(root, false)
        const r = leg.run(fetcher, commercialArgs(root))
        const out = text(r)
        expect(r.status, out).toBe(1)
        expect(out).toMatch(/placeholder/i)
        expect(out).not.toMatch(/skip \(/)
      })

      it('without the flag a hashless install is still skipped (DIY tolerance unchanged)', () => {
        const root = scratchTarget(PLACEHOLDER)
        installWinBuild(root, false)
        const r = leg.run(fetcher, [f('Target'), root, f('Os'), 'win'])
        const out = text(r)
        expect(r.status, out).toBe(0)
        expect(out).toMatch(/skip \(/)
      })

      it('a hashed, matching install is skipped in commercial mode too (nothing to re-fetch)', () => {
        const root = scratchTarget(PLACEHOLDER)
        installWinBuild(root, true)
        const r = leg.run(fetcher, commercialArgs(root))
        const out = text(r)
        expect(r.status, out).toBe(0)
        expect(out).toMatch(/skip \(/)
      })

      it('a dry run in commercial mode reports the placeholder as a failure (exit 1)', () => {
        const root = scratchTarget(PLACEHOLDER)
        const r = leg.run(fetcher, commercialArgs(root, [f('DryRun')]))
        const out = text(r)
        expect(r.status, out).toBe(1)
        expect(out).toMatch(/placeholder/i)
      })

      it('the OCR family refuses a placeholder before any download too', () => {
        const root = scratchTarget(PLACEHOLDER)
        const r = leg.run(fetcher, [f('Target'), root, f('Family'), 'ocr', f('Commercial')])
        const out = text(r)
        expect(r.status, out).toBe(1)
        expect(out).toMatch(/placeholder/i)
        expect(existsSync(join(root, 'ocr')) ? readdirSync(join(root, 'ocr')) : []).toEqual([])
      })
    })

    // #339 P8-3: kiwix_tools is the first multi-file, multi-build OPTIONAL family the
    // scripts fetch. A dry run for each of the four pinned builds (win + the two mac archs
    // + linux) must print that build's full required-file plan (the executables the yaml's
    // `executables:` declares, plus win's ICU `runtime_files:`) without touching the
    // network, and must never require --Family/--family to guess right without --os/--arch.
    describe('fetch-runtime kiwix_tools family — dry run enumerates every build (#339 P8-3)', () => {
      it.each([
        ['win', 'x64', ['kiwix-serve.exe', 'kiwix-manage.exe', 'kiwix-search.exe', 'icudt74.dll', 'icuin74.dll', 'icuio74.dll', 'icutu74.dll', 'icuuc74.dll']],
        ['mac', 'arm64', ['kiwix-serve', 'kiwix-manage', 'kiwix-search']],
        ['mac', 'x64', ['kiwix-serve', 'kiwix-manage', 'kiwix-search']],
        ['linux', 'x64', ['kiwix-serve', 'kiwix-manage', 'kiwix-search']]
      ] as const)('%s/%s: prints the required-file plan, offline, exit 0', (os, arch, files) => {
        const root = scratchTarget(REAL_SHA)
        const r = leg.run(fetcher, [
          f('Target'),
          root,
          f('Family'),
          'kiwix_tools',
          f('Os'),
          os,
          f('Arch'),
          arch,
          f('DryRun')
        ])
        const out = text(r)
        expect(r.status, out).toBe(0)
        expect(out).toMatch(/dry run/i)
        for (const file of files) expect(out, `${os}/${arch}: expected ${file} in the plan`).toContain(file)
        // Nothing extracted — dry run touches no network and creates no runtime/ tree.
        expect(existsSync(join(root, 'runtime', 'kiwix-tools'))).toBe(false)
      })
    })

    // The whole dry pipeline (six child fetch runs, all dry) takes ~30 s per leg and needs
    // -AcceptLicense to get past the license-blocked model in step 2 — opt in locally.
    describe.skipIf(!process.env.HILBERTRAUM_SCRIPT_DRY_RUN)('full -DryRun pipeline (opt-in)', () => {
      it.skipIf(!toolBuilt)(
        'a dry run reaches the canonical verdict: NOT SELLABLE on an empty target',
        () => {
          const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-dry-'))
          const r = leg.run(builder, [f('Target'), root, f('AcceptLicense'), f('DryRun')])
          const out = text(r)
          expect(r.status, out).toBe(1)
          expect(out).toContain('NOT SELLABLE')
          expect(out).toContain('[7]')
          expect(out).not.toContain('Done. Test the drive')
        },
        300_000
      )
    })
  })
}
