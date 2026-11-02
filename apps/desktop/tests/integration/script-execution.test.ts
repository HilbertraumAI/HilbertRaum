import { describe, it, expect, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateManifest, type ModelManifest } from '../../src/shared/manifest'
import { DRIVE_LICENSE_ARTIFACTS } from '../../src/main/services/commercial-drive'
import { buildChecksumsJson, buildPolicyJson, DRIVE_LAYOUT_DIRS, type ChecksumsJson } from '../../src/main/services/drive'
import { REPO_ROOT, repoText } from '../helpers/repo-files'
import { SCRIPT_LEGS, outputOf } from '../helpers/script-legs'
import { sha256, writeDriveFile } from '../helpers/manifest-fixtures'
import { testBudgetMs } from '../helpers/hang-budget'

// Executes the drive-builder scripts (#233, #234) — unlike script-drift.test.ts, which is
// text-only by charter. Every case is OFFLINE and deterministic: the fetch cases stop before
// any download (a dry run, a placeholder hash refused, or the install skipped), the builder
// cases run only its verify-only gate or its up-front refusal, and prepare-drive runs without
// its assets flag, so it fetches nothing. The .ps1 leg runs on Windows, the .sh leg elsewhere
// (CI runs `npm test` on both).

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
    '    - os: win',
    '      arch: x64',
    '      backend: cpu',
    '      url: https://example.invalid/llama-b9585-bin-win-cpu-x64.zip',
    `      sha256: ${sha}`,
    '      extract_to: runtime/llama.cpp/win/cpu',
    '    - os: mac',
    '      arch: arm64',
    '      backend: metal',
    '      url: https://example.invalid/llama-b9585-bin-macos-arm64.tar.gz',
    `      sha256: ${sha}`,
    '      extract_to: runtime/llama.cpp/mac',
    '    - os: linux',
    '      arch: x64',
    '      backend: cpu',
    '      url: https://example.invalid/llama-b9585-bin-ubuntu-x64.tar.gz',
    `      sha256: ${sha}`,
    '      extract_to: runtime/llama.cpp/linux/cpu',
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

function scratchTarget(sha: string, edit: (yaml: string) => string = (y) => y): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-exec-'))
  mkdirSync(join(root, 'model-manifests'), { recursive: true })
  writeFileSync(join(root, 'model-manifests', 'runtime-sources.yaml'), edit(runtimeSourcesYaml(sha)))
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

// Hand-written key order on purpose: this is what the scripts' flat parsers read.
const manifestYaml = (fields: { id: string; localPath: string; sha256: string; status?: string }, extra: string[] = []): string =>
  [
    `id: ${fields.id}`,
    `display_name: ${fields.id}`,
    'family: shard-test',
    'role: chat',
    'format: gguf',
    'runtime: llama_cpp',
    'license: test',
    'size_on_disk_gb: 0.000001',
    'recommended_min_ram_gb: 1',
    'recommended_ram_gb: 1',
    'recommended_context_tokens: 2048',
    `local_path: ${fields.localPath}`,
    `sha256: ${fields.sha256}`,
    'license_review:',
    `  status: ${fields.status ?? 'approved'}`,
    '  reviewed_by: test',
    "  reviewed_at: '2026-09-07'",
    '  notes: test fixture',
    ...extra,
    ''
  ].join('\n')

const APP_VERSION = (JSON.parse(repoText('apps', 'desktop', 'package.json')) as { version: string }).version
const SELLABLE_BUILDS = [
  { family: 'llama_cpp', version: 'b9585', os: 'win', arch: 'x64', backend: 'vulkan', dir: 'runtime/llama.cpp/win', bin: 'llama-server.exe' },
  { family: 'llama_cpp', version: 'b9585', os: 'win', arch: 'x64', backend: 'cpu', dir: 'runtime/llama.cpp/win/cpu', bin: 'llama-server.exe' },
  { family: 'llama_cpp', version: 'b9585', os: 'mac', arch: 'arm64', backend: 'metal', dir: 'runtime/llama.cpp/mac', bin: 'llama-server' },
  { family: 'llama_cpp', version: 'b9585', os: 'linux', arch: 'x64', backend: 'vulkan', dir: 'runtime/llama.cpp/linux', bin: 'llama-server' },
  { family: 'llama_cpp', version: 'b9585', os: 'linux', arch: 'x64', backend: 'cpu', dir: 'runtime/llama.cpp/linux/cpu', bin: 'llama-server' },
  { family: 'whisper_cpp', version: 'v1.8.6', os: 'win', arch: 'x64', backend: 'cpu', dir: 'runtime/whisper.cpp/win', bin: 'whisper-cli.exe' }
]

/** A drive that passes every check for win-x64, with one weight and no ocr: block, so a row can flip one input. */
function sellableDrive(): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-sellable-'))
  const yaml: string[] = []
  for (const family of ['llama_cpp', 'whisper_cpp']) {
    const builds = SELLABLE_BUILDS.filter((b) => b.family === family)
    yaml.push(`${family}:`, `  version: ${builds[0].version}`, '  builds:')
    for (const b of builds) {
      yaml.push(
        `    - os: ${b.os}`,
        `      arch: ${b.arch}`,
        `      backend: ${b.backend}`,
        `      url: https://example.invalid/${family}-${b.os}-${b.backend}.zip`,
        `      sha256: ${REAL_SHA}`,
        `      extract_to: ${b.dir}`
      )
    }
  }
  writeDriveFile(root, 'model-manifests/runtime-sources.yaml', `${yaml.join('\n')}\n`)
  for (const b of SELLABLE_BUILDS) {
    const hash = writeDriveFile(root, `${b.dir}/${b.bin}`, `${b.dir} binary`)
    writeDriveFile(
      root,
      `${b.dir}/.hilbertraum-runtime.json`,
      JSON.stringify({ version: b.version, backend: b.backend, os: b.os, arch: b.arch, binaries: { [b.bin]: hash } })
    )
  }
  const weight = writeDriveFile(root, 'models/chat/drive-model.gguf', 'weight bytes')
  writeDriveFile(
    root,
    'model-manifests/drive-model.yaml',
    manifestYaml({ id: 'drive-model', localPath: 'models/chat/drive-model.gguf', sha256: weight })
  )
  writeDriveFile(root, 'config/policy.json', JSON.stringify(buildPolicyJson(), null, 2))
  writeDriveFile(root, 'app-skills/demo/SKILL.md', '---\nid: demo\n---\n')
  mkdirSync(join(root, 'user-skills'))
  for (const name of DRIVE_LICENSE_ARTIFACTS) writeDriveFile(root, name, name)
  writeDriveFile(root, `HilbertRaum-${APP_VERSION}-portable.exe`, 'app')
  writeDriveFile(root, 'Start HilbertRaum.cmd', 'launcher')
  return root
}

/** Rewrites one key of the drive's policy, as a drive owner or a stale build would leave it. */
function patchPolicy(root: string, section: string, key: string, value: boolean): void {
  const file = join(root, 'config', 'policy.json')
  const policy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
  policy[section][key] = value
  writeFileSync(file, JSON.stringify(policy, null, 2))
}

/** One OCR file. It stays the last block of the yaml, as it is in the committed one. */
const ocrBlock = (sha: string): string =>
  [
    'ocr:',
    '  version: 4.0.0_best_int',
    '  files:',
    '    - lang: deu',
    '      url: https://example.invalid/deu.traineddata.gz',
    `      sha256: ${sha}`,
    '      dest: ocr/deu.traineddata.gz',
    ''
  ].join('\n')

const downloadLines = (name: string, sha: string, withdrawn?: string): string[] => [
  'download:',
  `  url: https://example.invalid/${name}`,
  `  sha256: ${sha}`,
  '  size_bytes: 9',
  '  license_url: https://example.invalid/LICENSE',
  ...(withdrawn ? [`  withdrawn: "${withdrawn}"`] : [])
]

const fetchable = (id: string, o: { sha?: string; status?: string; withdrawn?: string; extra?: string[] } = {}): string =>
  manifestYaml({ id, localPath: `models/chat/${id}.gguf`, sha256: o.sha ?? REAL_SHA, status: o.status }, [
    ...downloadLines(`${id}.gguf`, o.sha ?? REAL_SHA, o.withdrawn),
    ...(o.extra ?? [])
  ])

const MMPROJ_LINES = [
  'mmproj:',
  '  local_path: models/vision/v2-mm.gguf',
  `  sha256: ${REAL_SHA}`,
  '  download:',
  '    url: https://example.invalid/v2-mm.gguf',
  `    sha256: ${REAL_SHA}`
]
const FILES_LINES = [
  'files:',
  '  - local_path: models/chat/s-2.gguf',
  `    sha256: ${REAL_SHA}`,
  '    download:',
  '      url: https://example.invalid/s-2.gguf',
  `      sha256: ${REAL_SHA}`,
  '      size_bytes: 9'
]

function modelsTarget(manifests: string[], driveFiles: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-models-'))
  mkdirSync(join(root, 'model-manifests'), { recursive: true })
  manifests.forEach((y, i) => writeFileSync(join(root, 'model-manifests', `m${i}.yaml`), y))
  for (const [rel, content] of Object.entries(driveFiles)) writeDriveFile(root, rel, content)
  return root
}

const KIWIX_WIN = ['kiwix-serve.exe', 'kiwix-manage.exe', 'kiwix-search.exe', 'icudt74.dll', 'icuin74.dll', 'icuio74.dll', 'icutu74.dll', 'icuuc74.dll']

/** A kiwix_tools install: `present` on disk, `hashed` recorded in its marker. */
function installKiwixWin(root: string, present: readonly string[], hashed: readonly string[]): void {
  const dir = join(root, 'runtime', 'kiwix-tools', 'win')
  mkdirSync(dir, { recursive: true })
  for (const name of present) writeFileSync(join(dir, name), 'fake')
  const binaries = Object.fromEntries(hashed.map((n) => [n, REAL_SHA]))
  writeFileSync(
    join(dir, '.hilbertraum-runtime.json'),
    JSON.stringify({ version: '3.8.1', backend: 'cpu', os: 'win', arch: 'x64', binaries })
  )
}

// A shell + a node child per case: well under a second on Linux, several seconds under
// PowerShell or Git Bash on a loaded Windows runner — give every case in this file real headroom.
const CASE_TIMEOUT_MS = testBudgetMs(90_000)
vi.setConfig({ testTimeout: CASE_TIMEOUT_MS })

// `toolBuilt` skips every gate row below, so a build that stops writing the tool must not read as a pass.
it.runIf(process.env.CI)('the canonical gate tool is built on CI, so a skipped gate row is never a pass', () => {
  expect(existsSync(GATE_TOOL)).toBe(true)
})

it.runIf(process.platform === 'darwin')('bash on PATH is the stock 3.2 the sh leg claims to run under (#753)', () => {
  expect(spawnSync('bash', ['--version'], { encoding: 'utf8' }).stdout).toMatch(/^GNU bash, version 3\.2\./)
})

for (const leg of SCRIPT_LEGS) {
  describe.skipIf(leg.skip)(`script execution — ${leg.name}`, () => {
    const builder = `build-commercial-drive.${leg.ext}`
    const fetcher = `fetch-runtime.${leg.ext}`
    const f = leg.flag

    // The drive's policy is the drive owner's to edit, so a re-run must leave it alone unless told
    // otherwise. build-commercial-drive passes the flag on purpose; every other caller must not need to.
    describe('prepare-drive keeps an existing config', () => {
      it('skips an edited config file on a re-run and rewrites it only with the force flag', () => {
        const preparer = `prepare-drive.${leg.ext}`
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-prep-'))
        const configFile = (name: string): string => join(root, 'config', name)
        const first = leg.run(preparer, [f('Target'), root])
        expect(first.status, outputOf(first)).toBe(0)
        const files = ['drive.json', 'policy.json']
        for (const name of files) writeFileSync(configFile(name), '{"edited":true}')

        const again = leg.run(preparer, [f('Target'), root])
        expect(again.status, outputOf(again)).toBe(0)
        for (const name of files) {
          expect(readFileSync(configFile(name), 'utf8')).toBe('{"edited":true}')
          expect(outputOf(again)).toContain(`skip config/${name}`)
        }

        const forced = leg.run(preparer, [f('Target'), root, f('Force')])
        expect(forced.status, outputOf(forced)).toBe(0)
        expect(JSON.parse(readFileSync(configFile('drive.json'), 'utf8')).product).toBe('HilbertRaum')
        expect(JSON.parse(readFileSync(configFile('policy.json'), 'utf8')).workspace.encryption_required).toBe(true)
      })
    })

    describe('prepare-drive lays out a drive', () => {
      it('creates every layout dir and copies the notices, manifests, skills and docs (LIC-1)', () => {
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-layout-'))
        const r = leg.run(`prepare-drive.${leg.ext}`, [f('Target'), root])
        expect(r.status, outputOf(r)).toBe(0)
        for (const dir of DRIVE_LAYOUT_DIRS) expect(existsSync(join(root, ...dir.split('/'))), dir).toBe(true)
        for (const name of DRIVE_LICENSE_ARTIFACTS) expect(statSync(join(root, name)).size, name).toBeGreaterThan(0)
        expect(existsSync(join(root, 'model-manifests', 'runtime-sources.yaml'))).toBe(true)
        expect(existsSync(join(root, 'model-manifests', 'vision', 'qwen2.5-vl-3b-instruct-q4.yaml'))).toBe(true)
        expect(readdirSync(join(root, 'app-skills')).some((d) => existsSync(join(root, 'app-skills', d, 'SKILL.md')))).toBe(true)
        for (const doc of ['user-guide.md', 'troubleshooting.md', 'PRIVACY.md']) {
          expect(existsSync(join(root, 'docs', doc)), doc).toBe(true)
        }
        expect(readdirSync(join(root, 'user-skills'))).toEqual([])
      })
    })

    describe('build-commercial-drive verify-only gate (#233)', () => {
      it.skipIf(!toolBuilt)('runs the canonical gate offline and prints NOT SELLABLE for an empty target', () => {
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-gate-'))
        const r = leg.run(builder, [f('Target'), root, f('VerifyOnly')])
        const out = outputOf(r)
        expect(r.status, out).toBe(1)
        expect(out).toContain('NOT SELLABLE')
        expect(out).toContain('Canonical gate:')
        // The tool's own lines. The pre-flight below would print NOT SELLABLE with the gate gone.
        expect(out).toContain('assert-commercial-drive:')
        expect(out).toContain('model-manifests/ missing on the drive')
        expect(out).toContain('canonical gate: not sellable (exit 1')
        // These two are the native pre-flight's.
        expect(out).toContain('config/policy.json missing')
        expect(out).toContain('model-manifests missing on the drive')
        expect(out).not.toMatch(/^\s*SELLABLE:/m)
        expect(out).not.toContain('Done. Test the drive')
      })

      it('rejects an unknown platform label before doing anything (exit 2)', () => {
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-plat-'))
        const r = leg.run(builder, [f('Target'), root, f('VerifyOnly'), f('Platforms'), 'win-arm64'])
        expect(r.status, outputOf(r)).toBe(2)
        expect(outputOf(r)).toContain('win-arm64')
        expect(outputOf(r)).not.toContain('Build a COMMERCIAL')
      })

      it('refuses to proceed when a differently named app artifact already sits at the root', () => {
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-prior-'))
        writeFileSync(join(root, 'HilbertRaum-0.1.58-portable.exe'), 'old')
        const src = mkdtempSync(join(tmpdir(), 'hilbertraum-script-artifact-'))
        const artifact = join(src, 'HilbertRaum-0.1.59-portable.exe')
        writeFileSync(artifact, 'new')
        const r = leg.run(builder, [f('Target'), root, f('AppArtifact'), artifact, f('DryRun')])
        const out = outputOf(r)
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
        const out = outputOf(r)
        expect(r.status, out).toBe(1)
        expect(out).toMatch(/placeholder/i)
        expect(existsSync(join(root, 'runtime'))).toBe(false)
      })

      it('does not SKIP a hashless (legacy) install: the placeholder is refused instead', () => {
        const root = scratchTarget(PLACEHOLDER)
        installWinBuild(root, false)
        const r = leg.run(fetcher, commercialArgs(root))
        const out = outputOf(r)
        expect(r.status, out).toBe(1)
        expect(out).toMatch(/placeholder/i)
        expect(out).not.toMatch(/skip \(/)
      })

      it('without the flag a hashless install is still skipped (DIY tolerance unchanged)', () => {
        const root = scratchTarget(PLACEHOLDER)
        installWinBuild(root, false)
        const r = leg.run(fetcher, [f('Target'), root, f('Os'), 'win'])
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        expect(out).toMatch(/skip \(/)
      })

      it('a hashed, matching install is skipped in commercial mode too (nothing to re-fetch)', () => {
        const root = scratchTarget(PLACEHOLDER)
        installWinBuild(root, true)
        const r = leg.run(fetcher, commercialArgs(root))
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        expect(out).toMatch(/skip \(/)
      })

      it('a dry run in commercial mode reports the placeholder as a failure (exit 1)', () => {
        const root = scratchTarget(PLACEHOLDER)
        const r = leg.run(fetcher, commercialArgs(root, [f('DryRun')]))
        const out = outputOf(r)
        expect(r.status, out).toBe(1)
        expect(out).toMatch(/placeholder/i)
      })

      it('the OCR family refuses a placeholder before any download too', () => {
        const root = scratchTarget(PLACEHOLDER)
        const r = leg.run(fetcher, [f('Target'), root, f('Family'), 'ocr', f('Commercial')])
        const out = outputOf(r)
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
        ['win', 'x64', KIWIX_WIN],
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
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        expect(out).toMatch(/dry run/i)
        expect(out).toContain(`build: ${os}/${arch} cpu @ 3.8.1`)
        for (const file of files) expect(out, `${os}/${arch}: expected ${file} in the plan`).toContain(file)
        // Nothing extracted — dry run touches no network and creates no runtime/ tree.
        expect(existsSync(join(root, 'runtime', 'kiwix-tools'))).toBe(false)
      })
    })

    // #310: verify-models must enumerate every file a multi-file weight declares, not just the
    // primary GGUF — this executes the real script against a small on-disk shard set with REAL
    // sha256 hashes, entirely offline (verify-models never touches the network).
    describe('verify-models enumerates every declared file (#310)', () => {
      const verifier = `verify-models.${leg.ext}`

      /** A three-file shard model (shard 1 + two declared siblings) plus a single-file model. */
      function buildTempDrive(withThirdShard: boolean): { root: string; manifests: ModelManifest[] } {
        const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-verify-'))
        mkdirSync(join(root, 'model-manifests'), { recursive: true })
        mkdirSync(join(root, 'models', 'chat'), { recursive: true })

        const c1 = 'shard-one', c2 = 'shard-two', c3 = 'shard-three', cs = 'single-file-weight'
        const [sha1, sha2, sha3, shaS] = [c1, c2, c3, cs].map(sha256)

        writeFileSync(join(root, 'models', 'chat', 'x-00001-of-00003.gguf'), c1)
        writeFileSync(join(root, 'models', 'chat', 'x-00002-of-00003.gguf'), c2)
        if (withThirdShard) writeFileSync(join(root, 'models', 'chat', 'x-00003-of-00003.gguf'), c3)
        writeFileSync(join(root, 'models', 'chat', 'single.gguf'), cs)

        const shardYaml = manifestYaml(
          { id: 'shard-test-chat', localPath: 'models/chat/x-00001-of-00003.gguf', sha256: sha1 },
          [
            'files:',
            '  - local_path: models/chat/x-00002-of-00003.gguf',
            `    sha256: ${sha2}`,
            '  - local_path: models/chat/x-00003-of-00003.gguf',
            `    sha256: ${sha3}`
          ]
        )
        const singleYaml = manifestYaml({
          id: 'single-test-chat',
          localPath: 'models/chat/single.gguf',
          sha256: shaS
        })

        writeFileSync(join(root, 'model-manifests', 'shard-test.yaml'), shardYaml)
        writeFileSync(join(root, 'model-manifests', 'single-test.yaml'), singleYaml)

        const manifests = [shardYaml, singleYaml].map((y) => {
          const result = validateManifest(parseYaml(y))
          if (!result.ok) throw new Error(`fixture manifest invalid: ${result.errors.join('; ')}`)
          return result.manifest as ModelManifest
        })
        return { root, manifests }
      }

      const sortedEntries = (entries: ChecksumsJson['entries']): ChecksumsJson['entries'] =>
        [...entries].sort((a, b) => `${a.id}:${a.local_path}`.localeCompare(`${b.id}:${b.local_path}`))

      it('--generate reports every shard VERIFIED with an (file N/M) label and matches buildChecksumsJson', async () => {
        const { root, manifests } = buildTempDrive(true)
        const r = leg.run(verifier, [f('Target'), root, f('Generate')])
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        expect(out).toContain('(file 2/3)')
        expect(out).toContain('(file 3/3)')
        expect(out).toContain('shard-test-chat')
        expect(out).toContain('single-test-chat')
        // Every reported line for these two models is VERIFIED — real hashes, present files.
        for (const line of out.split('\n')) {
          if (line.includes('shard-test-chat') || line.includes('single-test-chat')) {
            expect(line, `expected VERIFIED: ${line}`).toContain('VERIFIED')
          }
        }
        const checksumsPath = join(root, 'config', 'checksums.json')
        expect(existsSync(checksumsPath)).toBe(true)
        const written = JSON.parse(readFileSync(checksumsPath, 'utf8')) as ChecksumsJson
        const expected = await buildChecksumsJson(root, manifests)
        expect(sortedEntries(written.entries)).toEqual(sortedEntries(expected.entries))
      })

      it('a missing declared sibling reports MISSING with its (file N/M) label and fails --strict', () => {
        const { root } = buildTempDrive(false)
        const r = leg.run(verifier, [f('Target'), root, f('Strict')])
        const out = outputOf(r)
        expect(r.status, out).toBe(1)
        expect(out).toContain('MISSING')
        expect(out).toContain('(file 3/3)')
        expect(out).toMatch(/MISSING\s+shard-test-chat \(file 3\/3\)/)
      })
    })

    // Real manifests, the real script, no network: a dry run stops short of every download. Each row has
    // an absent primary and a size_bytes: the flat parsers differ past those two, and that is a defect
    // of its own, not a shape to pin here.
    describe('fetch-models plans offline (--dry-run)', () => {
      interface PlanRow {
        manifests: string[]
        files?: Record<string, string>
        extra?: string[]
        status: number
        contains: string[]
        absent?: string[]
      }
      const pending = [fetchable('p-model', { status: 'pending' })]
      const verified = { 'models/chat/v-model.gguf': 'bytes' }
      const rows: Array<[string, PlanRow]> = [
        [
          'plans an absent approved model: its fetch line, URL and path',
          {
            manifests: [fetchable('a-model')],
            status: 0,
            contains: ['fetch  a-model', 'https://example.invalid/a-model.gguf', '-> models/chat/a-model.gguf', 'Planned 1 | fetched 0 | skipped 0']
          }
        ],
        [
          'blocks a model whose review is not approved (exit 1)',
          {
            manifests: pending,
            status: 1,
            contains: ['BLOCK  p-model', `Re-run with ${f('AcceptLicense')}`, 'One or more models failed'],
            absent: ['fetch  p-model']
          }
        ],
        [
          '--accept-license lets the same model through with a note',
          { manifests: pending, extra: [f('AcceptLicense')], status: 0, contains: ['note   p-model', 'fetch  p-model'], absent: ['BLOCK'] }
        ],
        [
          'a withdrawn source is skipped ahead of the license gate',
          {
            manifests: [fetchable('w-model', { status: 'pending', withdrawn: '2026-11-02: removed upstream, issue 196' })],
            status: 0,
            contains: ['SKIP   w-model: upstream source withdrawn', 'Planned 1 | fetched 0 | skipped 1'],
            absent: ['BLOCK', 'fetch  w-model']
          }
        ],
        [
          '--only picks one model',
          {
            manifests: [fetchable('a-model'), fetchable('b-model')],
            extra: [f('Only'), 'b-model'],
            status: 0,
            contains: ['fetch  b-model', 'Planned 1'],
            absent: ['fetch  a-model']
          }
        ],
        [
          'a present verified weight is skipped with no license prompt',
          {
            manifests: [fetchable('v-model', { status: 'pending', sha: sha256('bytes') })],
            files: verified,
            status: 0,
            contains: ['skip   v-model (present + verified)'],
            absent: ['BLOCK']
          }
        ],
        [
          'a withdrawn model already on the drive still verifies',
          {
            manifests: [fetchable('v-model', { sha: sha256('bytes'), withdrawn: '2026-11-02: removed upstream, issue 196' })],
            files: verified,
            status: 0,
            contains: ['skip   v-model (present + verified)'],
            absent: ['upstream source withdrawn']
          }
        ],
        [
          'a present file with a placeholder hash is skipped, unverified',
          {
            manifests: [fetchable('h-model', { sha: PLACEHOLDER })],
            files: { 'models/chat/h-model.gguf': 'bytes' },
            status: 0,
            contains: ['skip   h-model (present; placeholder hash'],
            absent: ['fetch  h-model']
          }
        ],
        [
          'a present file with the wrong hash is planned as a redo, and left alone',
          {
            manifests: [fetchable('r-model', { sha: sha256('expected') })],
            files: { 'models/chat/r-model.gguf': 'other' },
            status: 0,
            contains: ['redo   r-model (present but checksum mismatch', 'fetch  r-model']
          }
        ],
        [
          'a vision pair plans both files',
          {
            manifests: [fetchable('v2-model', { extra: MMPROJ_LINES })],
            status: 0,
            contains: ['fetch  v2-model', 'fetch  v2-model (mmproj)', 'https://example.invalid/v2-mm.gguf']
          }
        ],
        [
          'a files: member is planned with its (file 2/2) label',
          {
            manifests: [fetchable('s-model', { extra: FILES_LINES })],
            status: 0,
            contains: ['fetch  s-model (file 2/2)', 'https://example.invalid/s-2.gguf', '-> models/chat/s-2.gguf']
          }
        ]
      ]

      it.each(rows)('%s', (_title, row) => {
        const root = modelsTarget(row.manifests, row.files)
        const r = leg.run(`fetch-models.${leg.ext}`, [f('Target'), root, f('DryRun'), ...(row.extra ?? [])])
        const out = outputOf(r)
        expect(r.status, out).toBe(row.status)
        for (const text of row.contains) expect(out).toContain(text)
        for (const text of row.absent ?? []) expect(out).not.toContain(text)
        // A dry run writes nothing, and leaves what is there alone.
        if (!row.files) expect(existsSync(join(root, 'models'))).toBe(false)
        for (const [rel, content] of Object.entries(row.files ?? {})) {
          expect(readFileSync(join(root, ...rel.split('/')), 'utf8')).toBe(content)
        }
      })
    })

    // M18: the yaml on a drive is user-writable, so a tampered path must not write outside the root.
    describe('fetch-runtime escape guards (M18)', () => {
      const EXTRACT_TO = 'extract_to: runtime/llama.cpp/win'
      const OCR_DEST = 'dest: ocr/deu.traineddata.gz'
      const rows: Array<[string, string[], string, string, string]> = [
        ['a parent-relative extract_to is refused (exit 2)', [f('Os'), 'win'], EXTRACT_TO, 'extract_to: ../outside', 'extract_to escapes the drive root'],
        ['an absolute extract_to is refused (exit 2)', [f('Os'), 'win'], EXTRACT_TO, 'extract_to: /outside', 'extract_to escapes the drive root'],
        ['a drive-letter extract_to is refused (exit 2)', [f('Os'), 'win'], EXTRACT_TO, 'extract_to: C:/outside', 'extract_to escapes the drive root'],
        ['a parent-relative ocr dest is refused (exit 2)', [f('Family'), 'ocr'], OCR_DEST, 'dest: ../deu.traineddata.gz', 'ocr dest escapes the drive root'],
        ['an absolute ocr dest is refused (exit 2)', [f('Family'), 'ocr'], OCR_DEST, 'dest: /deu.traineddata.gz', 'ocr dest escapes the drive root']
      ]

      it.each(rows)('%s', (_title, args, from, to, message) => {
        const root = scratchTarget(REAL_SHA, (y) => y.replace(from, to))
        const r = leg.run(fetcher, [f('Target'), root, ...args, f('DryRun')])
        const out = outputOf(r)
        expect(r.status, out).toBe(2)
        expect(out).toContain(message)
        expect(existsSync(join(root, 'runtime'))).toBe(false)
        expect(existsSync(join(root, 'ocr'))).toBe(false)
      })
    })

    // A silent miss here would disable verification for good (the audited C1 bug).
    describe('fetch-runtime refuses a pin it cannot verify', () => {
      const drop = (line: string) => (y: string) => y.replace(line, '')
      const rows: Array<[string, (y: string) => string, string[], string]> = [
        ['a selected build with no url', drop('      url: https://example.invalid/llama-b9585-bin-win-vulkan-x64.zip\n'), [f('Os'), 'win'], "is missing 'url'"],
        ['a selected build with no sha256', drop(`      sha256: ${REAL_SHA}\n`), [f('Os'), 'win'], "is missing 'sha256'"],
        ['a selected build with no extract_to', drop('      extract_to: runtime/llama.cpp/win\n'), [f('Os'), 'win'], "is missing 'extract_to'"],
        ['an os with no build', (y) => y, [f('Os'), 'freebsd'], 'No runtime build for os=freebsd'],
        ['an arch with no build', (y) => y, [f('Os'), 'win', f('Arch'), 'arm64'], 'No runtime build for os=win arch=arm64'],
        ['a family the yaml does not declare', (y) => y, [f('Family'), 'whisper_cpp'], 'missing whisper_cpp.version'],
        ['an ocr file with no url', drop('      url: https://example.invalid/deu.traineddata.gz\n'), [f('Family'), 'ocr'], "ocr.files (deu): missing 'url'"],
        ['a yaml with no ocr block', (y) => y.slice(0, y.indexOf('\nocr:\n') + 1), [f('Family'), 'ocr'], 'no ocr block']
      ]

      it.each(rows)('%s', (_title, edit, args, message) => {
        const root = scratchTarget(REAL_SHA, edit)
        const r = leg.run(fetcher, [f('Target'), root, ...args, f('DryRun')])
        const out = outputOf(r)
        expect(r.status, out).toBe(2)
        expect(out).toContain(message)
      })
    })

    describe('fetch-runtime re-fetches what the marker cannot vouch for', () => {
      const markerFile = (root: string): string => join(root, 'runtime', 'llama.cpp', 'win', '.hilbertraum-runtime.json')
      const withMarker = (fields: Record<string, string>) => (root: string) =>
        writeFileSync(markerFile(root), JSON.stringify({ version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64', ...fields }))
      const markers: Array<[string, (root: string) => void]> = [
        ['a stale version', withMarker({ version: 'b1' })],
        ['a stale backend', withMarker({ backend: 'cpu' })],
        ['a missing marker', (root) => rmSync(markerFile(root))],
        ['an unreadable marker', (root) => writeFileSync(markerFile(root), 'not json')]
      ]

      it.each(markers)('%s: the present binary is re-fetched, not skipped', (_title, marker) => {
        const root = scratchTarget(REAL_SHA)
        installWinBuild(root, false)
        marker(root)
        const r = leg.run(fetcher, [f('Target'), root, f('Os'), 'win', f('DryRun')])
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        expect(out).toContain('present but install marker is missing or differs')
        expect(out).not.toMatch(/skip \(/)
      })

      const kiwix: Array<[string, (root: string) => void, string[], string, boolean]> = [
        ['a half-installed multi-file family is re-fetched', (root) => installKiwixWin(root, ['kiwix-serve.exe'], KIWIX_WIN), [], 'one or more required files are missing', false],
        [
          'one required file with no recorded hash is re-fetched in commercial mode',
          (root) => installKiwixWin(root, KIWIX_WIN, KIWIX_WIN.slice(0, -1)),
          [f('Commercial')],
          'records no binary hash for one or more required files',
          false
        ],
        ['a complete family with every file hashed is skipped in commercial mode', (root) => installKiwixWin(root, KIWIX_WIN, KIWIX_WIN), [f('Commercial')], 'already installed', true]
      ]

      it.each(kiwix)('%s', (_title, install, commercial, line, skipped) => {
        const root = scratchTarget(REAL_SHA)
        install(root)
        const r = leg.run(fetcher, [f('Target'), root, f('Family'), 'kiwix_tools', f('Os'), 'win', f('Arch'), 'x64', f('DryRun'), ...commercial])
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        expect(out).toContain(line)
        expect(/skip \(/.test(out)).toBe(skipped)
      })
    })

    // build-commercial-drive provisions every OS from one host, so it leans on both rules. Each CI leg has
    // one discriminating row: mac on x64 hosts, linux on the arm64 macOS runner.
    describe('fetch-runtime picks a build', () => {
      const rows: Array<[string, string[], string, string]> = [
        ['the default is the first build listed for the OS', [f('Os'), 'win'], 'win/x64 vulkan', 'runtime/llama.cpp/win'],
        ['--os alone ignores the host arch (mac)', [f('Os'), 'mac'], 'mac/arm64 metal', 'runtime/llama.cpp/mac'],
        ['--os alone ignores the host arch (linux)', [f('Os'), 'linux'], 'linux/x64 vulkan', 'runtime/llama.cpp/linux'],
        ['--backend cpu selects the safety net', [f('Os'), 'win', f('Backend'), 'cpu'], 'win/x64 cpu', 'runtime/llama.cpp/win/cpu']
      ]

      it.each(rows)('%s', (_title, args, build, dir) => {
        const root = scratchTarget(REAL_SHA)
        const r = leg.run(fetcher, [f('Target'), root, ...args, f('DryRun')])
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        expect(out).toContain(`build: ${build} @ b9585`)
        const into = out.replace(/\\/g, '/').split(/\r?\n/).find((l) => l.includes('into:'))
        expect(into?.trim().endsWith(dir), into).toBe(true)
      })
    })

    // The positive is what makes every NOT SELLABLE row mean something: a gate that can never pass would
    // pass all of them. The drive holds one weight and at most one OCR file.
    describe('build-commercial-drive verdict on a complete scratch drive (#233, #234)', () => {
      const verify = (root: string) => leg.run(builder, [f('Target'), root, f('VerifyOnly'), f('Platforms'), 'win-x64'])
      const rm = (root: string, rel: string): void => rmSync(join(root, ...rel.split('/')), { recursive: true })
      const appendOcr = (root: string): void =>
        appendFileSync(join(root, 'model-manifests', 'runtime-sources.yaml'), ocrBlock(sha256('deu')))

      it.skipIf(!toolBuilt)('a complete drive reaches SELLABLE from the canonical verdict (exit 0)', () => {
        const r = verify(sellableDrive())
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        expect(out).toContain(`SELLABLE: canonical gate passed for win-x64 at ${APP_VERSION}.`)
        expect(out).toContain('SELLABLE: every check passed')
        expect(out).not.toContain('NOT SELLABLE')
      })

      const flips: Array<[string, (root: string) => void, string]> = [
        ['encryption off', (root) => patchPolicy(root, 'workspace', 'encryption_required', false), 'policy: encryption not required'],
        ['plaintext on', (root) => patchPolicy(root, 'workspace', 'allow_plaintext_dev_mode', true), 'policy: plaintext allowed'],
        ['update checks on', (root) => patchPolicy(root, 'network', 'allow_update_checks', true), 'policy: update checks allowed'],
        ['telemetry on', (root) => patchPolicy(root, 'network', 'allow_telemetry', true), 'policy: telemetry allowed'],
        ['sha256 match off', (root) => patchPolicy(root, 'models', 'require_sha256_match', false), 'policy: sha256 match not required'],
        ['a workspace database', (root) => writeDriveFile(root, 'workspace/hilbertraum.sqlite.enc', 'db'), 'user data present: workspace/hilbertraum.sqlite.enc'],
        ['an imported document', (root) => writeDriveFile(root, 'workspace/documents/a.enc', 'doc'), 'user data present: workspace/documents/*'],
        ['no app skills', (root) => rm(root, 'app-skills'), 'no app skills provisioned'],
        ['a user skill', (root) => writeDriveFile(root, 'user-skills/mine/SKILL.md', 'skill'), 'user skill present on a drive meant to ship empty: user-skills/mine'],
        [
          'a pending license review',
          (root) =>
            writeDriveFile(
              root,
              'model-manifests/drive-model.yaml',
              manifestYaml({ id: 'drive-model', localPath: 'models/chat/drive-model.gguf', sha256: sha256('weight bytes'), status: 'pending' })
            ),
          'license_review not approved: drive-model'
        ],
        ['an empty notice', (root) => writeDriveFile(root, 'DRIVE-NOTICES.md', ''), 'license/attribution artifact missing or empty at the drive root: DRIVE-NOTICES.md'],
        ['a missing engine binary', (root) => rm(root, 'runtime/llama.cpp/win/cpu/llama-server.exe'), 'runtime: llama-server.exe missing under runtime/llama.cpp/win/cpu'],
        ['a missing install marker', (root) => rm(root, 'runtime/llama.cpp/mac/.hilbertraum-runtime.json'), 'runtime: no .hilbertraum-runtime.json install marker under runtime/llama.cpp/mac'],
        [
          'a stale install marker',
          (root) =>
            writeDriveFile(
              root,
              'runtime/whisper.cpp/win/.hilbertraum-runtime.json',
              JSON.stringify({ version: 'v0.0.1', backend: 'cpu', os: 'win', arch: 'x64' })
            ),
          'runtime: runtime/whisper.cpp/win marker does not match the pinned'
        ],
        ['a missing ocr file', appendOcr, 'ocr: ocr/deu.traineddata.gz missing'],
        // On Git Bash a backslash target reads ANY OCR file as a mismatch, so ubuntu and macOS are this row's honest sh legs.
        [
          'an ocr file with the wrong bytes',
          (root) => {
            appendOcr(root)
            writeDriveFile(root, 'ocr/deu.traineddata.gz', 'other')
          },
          'ocr: ocr/deu.traineddata.gz checksum mismatch'
        ],
        ['a changed weight', (root) => writeDriveFile(root, 'models/chat/drive-model.gguf', 'other'), 'weights: not every weight is VERIFIED (strict verify failed)']
      ]

      // Four spaces: the native list. The tool's own list has two.
      it.skipIf(!toolBuilt).each(flips)('%s: the pre-flight refuses it', (_title, flip, line) => {
        const root = sellableDrive()
        flip(root)
        const r = verify(root)
        const out = outputOf(r)
        expect(r.status, out).toBe(1)
        expect(out).toContain('NOT SELLABLE')
        expect(out).toContain(`    - ${line}`)
        expect(out).not.toContain('SELLABLE: canonical gate passed')
      })

      it.skipIf(!toolBuilt)('a drive only the canonical gate refuses is NOT SELLABLE', () => {
        const root = sellableDrive()
        rmSync(join(root, `HilbertRaum-${APP_VERSION}-portable.exe`))
        const r = verify(root)
        const out = outputOf(r)
        expect(r.status, out).toBe(1)
        expect(out).toContain('no app artifact at the drive root')
        expect(out).toContain('    - canonical gate: not sellable (exit 1')
        expect(out).not.toContain('SELLABLE: canonical gate passed')
      })
    })

    // The whole dry pipeline (six child fetch runs, all dry) takes ~30 s per leg and needs
    // -AcceptLicense to get past the license-blocked model in step 2 — opt in locally.
    describe.skipIf(!process.env.HILBERTRAUM_SCRIPT_DRY_RUN)('full -DryRun pipeline (opt-in)', () => {
      it.skipIf(!toolBuilt)(
        'a dry run reaches the canonical verdict: NOT SELLABLE on an empty target',
        () => {
          const root = mkdtempSync(join(tmpdir(), 'hilbertraum-script-dry-'))
          const r = leg.run(builder, [f('Target'), root, f('AcceptLicense'), f('DryRun')], { timeoutMs: 240_000 })
          const out = outputOf(r)
          expect(r.status, out).toBe(1)
          expect(out).toContain('NOT SELLABLE')
          expect(out).toContain('[7]')
          expect(out).toContain('assert-commercial-drive:')
          expect(out).not.toContain('Done. Test the drive')
        },
        testBudgetMs(300_000)
      )
    })
  })
}
