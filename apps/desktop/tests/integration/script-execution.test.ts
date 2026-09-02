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
        { encoding: 'utf8', timeout: 120_000, windowsHide: true }
      )
  },
  {
    name: 'bash scripts (.sh)',
    // Git Bash on a Windows dev box can run this leg too: HILBERTRAUM_SCRIPT_SH_LEG=1.
    skip: process.platform === 'win32' && !process.env.HILBERTRAUM_SCRIPT_SH_LEG,
    ext: 'sh',
    flag: (n) => `--${n.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    run: (script, args) =>
      spawnSync('bash', [join(SCRIPTS, script), ...args], { encoding: 'utf8', timeout: 120_000 })
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
        expect(out).toContain('assert-commercial-drive')
        // The verdict is the canonical gate's: it names the missing platform artifacts.
        expect(out).toMatch(/no app artifact/i)
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
