import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  planRuntimeDownload,
  requiredInstallFiles,
  selectRuntimeBuilds,
  sha256Of,
  sidecarFamilySpec
} from '../../src/main/services/assets'
import type { RuntimeBuild, RuntimeFamily } from '../../src/shared/runtime-sources'
import { makeTarGz, makeZip } from '../helpers/archives'
import { committedRuntimeSources } from '../helpers/catalog'
import { testBudgetMs } from '../helpers/hang-budget'
import { writeDriveFile } from '../helpers/manifest-fixtures'
import { repoText } from '../helpers/repo-files'
import { SCRIPT_LEGS, downloadEnv, isolatedScripts, outputOf, scriptRoot } from '../helpers/script-legs'

// fetch-runtime past its download (#769): extract, flatten, materialise links, check completeness, write the marker. About
// 170 lines per twin that no row ran before a tag; the .ps1 half ran nowhere, because release.yml fetches with the .sh.
// Each row builds its archive in code, serves it from a file:// URL and runs the real script on a bracketed drive root,
// offline. The dry-run rows hold both twins' flat parsers to the app's own reading of the committed runtime-sources.yaml.

const VERSION = 'b9585'
const ICU = ['icudt74.dll', 'icuin74.dll', 'icuio74.dll', 'icutu74.dll', 'icuuc74.dll']

interface Pin {
  family: 'llama_cpp' | 'kiwix_tools'
  os: 'win' | 'linux'
  backend: string
  extractTo: string
  runtimeFiles?: string[]
}
const LINUX: Pin = { family: 'llama_cpp', os: 'linux', backend: 'vulkan', extractTo: 'runtime/llama.cpp/linux' }
const WIN: Pin = { family: 'llama_cpp', os: 'win', backend: 'vulkan', extractTo: 'runtime/llama.cpp/win' }
const KIWIX_WIN: Pin = { family: 'kiwix_tools', os: 'win', backend: 'cpu', extractTo: 'runtime/kiwix-tools/win', runtimeFiles: ICU }

/** `archive` behind a file:// URL. Never under the bracketed root: curl reads `[1]` in a URL as a glob. */
function serve(name: string, archive: Buffer): string {
  const file = join(mkdtempSync(join(tmpdir(), 'hilbertraum-fr-src-')), name)
  writeFileSync(file, archive)
  return pathToFileURL(file).href
}

/** A drive whose runtime-sources.yaml pins one build of `pin`'s family: `url`, verified against `sha`. */
function pinnedDrive(pin: Pin, url: string, sha: string): string {
  const root = scriptRoot('fr-install-')
  const head =
    pin.family === 'kiwix_tools'
      ? ['kiwix_tools:', "  version: '3.8.1'", '  executables: [kiwix-serve, kiwix-manage, kiwix-search]', '  builds:']
      : ['llama_cpp:', `  version: ${VERSION}`, '  builds:']
  const build = [
    `    - os: ${pin.os}`,
    '      arch: x64',
    `      backend: ${pin.backend}`,
    `      url: ${url}`,
    `      sha256: ${sha}`,
    `      extract_to: ${pin.extractTo}`,
    ...(pin.runtimeFiles ? [`      runtime_files: [${pin.runtimeFiles.join(', ')}]`] : [])
  ]
  writeDriveFile(root, 'model-manifests/runtime-sources.yaml', [...head, ...build, ''].join('\n'))
  return root
}

/** An install already on the drive: `files` (name -> bytes) and a marker for `version`. */
function installed(dir: string, files: Record<string, string>, version: string): void {
  for (const [name, bytes] of Object.entries(files)) writeDriveFile(dir, name, bytes)
  writeFileSync(join(dir, '.hilbertraum-runtime.json'), JSON.stringify({ version, backend: 'vulkan', os: 'win', arch: 'x64' }))
}

const markerOf = (dir: string): unknown => JSON.parse(readFileSync(join(dir, '.hilbertraum-runtime.json'), 'utf8'))
const listing = (dir: string): string[] => readdirSync(dir).sort()

/**
 * A `tar` that is not Windows' own, first on PATH. From a PowerShell started inside Git Bash the first `tar` is Git's GNU tar,
 * which reads the `C:` of an archive path as a remote host and extracts nothing (#767). Only PowerShell resolves a `.cmd`;
 * bash never sees this one.
 */
function decoyTarDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-decoy-tar-'))
  writeFileSync(join(dir, 'tar.cmd'), "@echo decoy tar: not Windows' own 1>&2\r\n@exit /b 2\r\n")
  return dir
}

// The release tarballs nest everything under one top directory and carry version links, listed before what they name.
const SERVER = 'linux server bytes'
const LIB = 'libllama bytes'
const nestedLinuxBuild = (extra: Parameters<typeof makeTarGz>[0] = []): Buffer =>
  makeTarGz([
    { name: `llama-${VERSION}/`, dir: true },
    { name: `llama-${VERSION}/llama-server`, data: Buffer.from(SERVER), mode: 0o755 },
    { name: `llama-${VERSION}/libllama.so`, symlink: 'libllama.so.0' },
    { name: `llama-${VERSION}/libllama.so.0`, symlink: 'libllama.so.0.0.1' },
    { name: `llama-${VERSION}/libllama.so.0.0.1`, data: Buffer.from(LIB) },
    ...extra
  ])
const winBuild = (exe: string): Buffer =>
  makeZip([
    { name: 'llama-server.exe', data: Buffer.from(exe) },
    { name: 'ggml.dll', data: Buffer.from('ggml') }
  ])

// A shell + curl + tar per row: well under a second on Linux, a few seconds under PowerShell or Git Bash on a loaded runner.
vi.setConfig({ testTimeout: testBudgetMs(90_000) })

// The installs run a copy of scripts/ with no repo catalog beside it, under dead proxies: a regression that misses the
// drive's yaml stops there instead of fetching the repo's real pins.
const SCRIPTS_COPY = isolatedScripts()

for (const leg of SCRIPT_LEGS) {
  describe.skipIf(leg.skip)(`fetch-runtime installs — ${leg.name}`, () => {
    const f = leg.flag
    const fetchRuntime = (root: string, args: string[], env = downloadEnv()) =>
      leg.run(`fetch-runtime.${leg.ext}`, [f('Target'), root, ...args], { env, scriptsDir: SCRIPTS_COPY })

    it("a linux tar.gz beside a cpu/ safety net: its own top dir is flattened, a link listed before its target is materialised, the marker hashes the binary, with Windows' own tar (#769, #767)", () => {
      const archive = nestedLinuxBuild()
      const root = pinnedDrive(LINUX, serve(`llama-${VERSION}-bin-ubuntu-vulkan-x64.tar.gz`, archive), sha256Of(archive))
      const dir = join(root, ...LINUX.extractTo.split('/'))
      writeDriveFile(dir, 'cpu/llama-server', 'cpu build')
      const r = fetchRuntime(root, [f('Os'), 'linux'], downloadEnv(decoyTarDir()))
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(listing(dir)).toEqual(['.hilbertraum-runtime.json', 'cpu', 'libllama.so', 'libllama.so.0', 'libllama.so.0.0.1', 'llama-server'])
      expect(readFileSync(join(dir, 'llama-server'), 'utf8')).toBe(SERVER)
      expect(listing(join(dir, 'cpu'))).toEqual(['llama-server'])
      // A real link where the file system holds one, a copy where it cannot: either way the name opens the library.
      for (const name of ['libllama.so', 'libllama.so.0']) expect(readFileSync(join(dir, name), 'utf8'), name).toBe(LIB)
      expect(markerOf(dir)).toEqual({ version: VERSION, backend: 'vulkan', os: 'linux', arch: 'x64', binaries: { 'llama-server': sha256Of(SERVER) } })
    })

    it('a Windows zip re-fetched over a stale build: the old files go, the cpu/ safety net stays (#769)', () => {
      const archive = winBuild('new build')
      const root = pinnedDrive(WIN, serve(`llama-${VERSION}-bin-win-vulkan-x64.zip`, archive), sha256Of(archive))
      const dir = join(root, ...WIN.extractTo.split('/'))
      installed(dir, { 'llama-server.exe': 'old build', 'stale.dll': 'old', 'cpu/llama-server.exe': 'cpu build' }, 'b1')
      const r = fetchRuntime(root, [f('Os'), 'win'])
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).toContain('present but install marker is missing or differs')
      expect(listing(dir)).toEqual(['.hilbertraum-runtime.json', 'cpu', 'ggml.dll', 'llama-server.exe'])
      expect(readFileSync(join(dir, 'llama-server.exe'), 'utf8')).toBe('new build')
      expect(readFileSync(join(dir, 'cpu', 'llama-server.exe'), 'utf8')).toBe('cpu build')
      expect(markerOf(dir)).toEqual({ version: VERSION, backend: 'vulkan', os: 'win', arch: 'x64', binaries: { 'llama-server.exe': sha256Of('new build') } })
    })

    // #729: every llama.cpp archive since v0.8.0 carries llama-connect, the `llama-server --connect` tunnel.
    it('a Windows zip carrying llama-connect.exe: installed without it, the marker records only the server (#729)', () => {
      const archive = makeZip([
        { name: 'llama-server.exe', data: Buffer.from('new build') },
        { name: 'llama-connect.exe', data: Buffer.from('tunnel') },
        { name: 'ggml.dll', data: Buffer.from('ggml') }
      ])
      const root = pinnedDrive(WIN, serve(`llama-${VERSION}-bin-win-vulkan-x64.zip`, archive), sha256Of(archive))
      const r = fetchRuntime(root, [f('Os'), 'win'])
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).toContain('left out: llama-connect.exe')
      const dir = join(root, ...WIN.extractTo.split('/'))
      expect(listing(dir)).toEqual(['.hilbertraum-runtime.json', 'ggml.dll', 'llama-server.exe'])
      expect(markerOf(dir)).toEqual({ version: VERSION, backend: 'vulkan', os: 'win', arch: 'x64', binaries: { 'llama-server.exe': sha256Of('new build') } })
    })

    it('a nested linux tar.gz carrying llama-connect: it is left out after the flatten, even when the yaml lists it (#729)', () => {
      const archive = nestedLinuxBuild([{ name: `llama-${VERSION}/llama-connect`, data: Buffer.from('tunnel'), mode: 0o755 }])
      const root = pinnedDrive(LINUX, serve(`llama-${VERSION}-bin-ubuntu-vulkan-x64.tar.gz`, archive), sha256Of(archive))
      const yaml = join(root, 'model-manifests', 'runtime-sources.yaml')
      writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(`  version: ${VERSION}\n`, `  version: ${VERSION}\n  executables: [llama-server, llama-connect]\n`))
      const r = fetchRuntime(root, [f('Os'), 'linux'])
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).toContain('left out: llama-connect')
      const dir = join(root, ...LINUX.extractTo.split('/'))
      expect(listing(dir)).toEqual(['.hilbertraum-runtime.json', 'libllama.so', 'libllama.so.0', 'libllama.so.0.0.1', 'llama-server'])
      expect(markerOf(dir)).toEqual({ version: VERSION, backend: 'vulkan', os: 'linux', arch: 'x64', binaries: { 'llama-server': sha256Of(SERVER) } })
    })

    it('an archive that fails its pin: exit 1, the archive deleted, the installed build untouched (#769)', () => {
      const root = pinnedDrive(WIN, serve(`llama-${VERSION}-bin-win-vulkan-x64.zip`, winBuild('new build')), sha256Of('another archive'))
      const dir = join(root, ...WIN.extractTo.split('/'))
      installed(dir, { 'llama-server.exe': 'old build' }, 'b1')
      const r = fetchRuntime(root, [f('Os'), 'win'])
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toContain('archive checksum mismatch')
      expect(listing(dir)).toEqual(['.hilbertraum-runtime.json', 'llama-server.exe'])
      expect(readFileSync(join(dir, 'llama-server.exe'), 'utf8')).toBe('old build')
      expect(markerOf(dir)).toMatchObject({ version: 'b1' })
    })

    it('a placeholder pin outside commercial mode: installed, UNVERIFIED, and the marker records no binary hash (#769)', () => {
      const root = pinnedDrive(WIN, serve(`llama-${VERSION}-bin-win-vulkan-x64.zip`, winBuild('new build')), 'REPLACE_WITH_REAL_HASH')
      const r = fetchRuntime(root, [f('Os'), 'win'])
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).toContain('archive UNVERIFIED')
      const dir = join(root, ...WIN.extractTo.split('/'))
      expect(readFileSync(join(dir, 'llama-server.exe'), 'utf8')).toBe('new build')
      expect(markerOf(dir)).toEqual({ version: VERSION, backend: 'vulkan', os: 'win', arch: 'x64' })
    })

    it('a kiwix zip one ICU dll short: the completeness check names it and no marker is written (#769)', () => {
      const members = ['kiwix-serve.exe', 'kiwix-manage.exe', 'kiwix-search.exe', ...ICU.slice(0, -1)]
      const archive = makeZip(members.map((name) => ({ name: `kiwix-tools_win-x86_64-3.8.1/${name}`, data: Buffer.from(name) })))
      const root = pinnedDrive(KIWIX_WIN, serve('kiwix-tools_win-x86_64-3.8.1.zip', archive), sha256Of(archive))
      const r = fetchRuntime(root, [f('Family'), 'kiwix_tools', f('Os'), 'win', f('Arch'), 'x64'])
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toMatch(/required file\(s\) missing .*icuuc74\.dll/)
      const dir = join(root, ...KIWIX_WIN.extractTo.split('/'))
      expect(existsSync(join(dir, 'kiwix-serve.exe')), 'flattened out of the archive top dir').toBe(true)
      expect(existsSync(join(dir, '.hilbertraum-runtime.json'))).toBe(false)
    })

    it("a tar.gz that tar cannot read: tar's own error is printed, not a guess at the archive layout (#767)", () => {
      const whole = nestedLinuxBuild()
      const archive = whole.subarray(0, whole.length >> 1)
      const root = pinnedDrive(LINUX, serve(`llama-${VERSION}-bin-ubuntu-vulkan-x64.tar.gz`, archive), sha256Of(archive))
      const r = fetchRuntime(root, [f('Os'), 'linux'])
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toContain('tar could not extract')
      // GNU tar (via gzip) and bsdtar, in their own words.
      expect(out).toMatch(/unexpected end of file|truncated gzip input/i)
      expect(out).not.toContain('layout may have changed')
      expect(existsSync(join(root, ...LINUX.extractTo.split('/'), '.hilbertraum-runtime.json'))).toBe(false)
    })

    it('a link whose name leaves the extract dir is refused, never copied out of it (#767)', () => {
      // Both tars refuse a member name holding `..`, so the link is missing on every platform and reaches the materialiser.
      const archive = nestedLinuxBuild([{ name: `llama-${VERSION}/../../escaped`, symlink: `linux/llama-${VERSION}/llama-server` }])
      const root = pinnedDrive(LINUX, serve(`llama-${VERSION}-bin-ubuntu-vulkan-x64.tar.gz`, archive), sha256Of(archive))
      const r = fetchRuntime(root, [f('Os'), 'linux'])
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toContain('points outside')
      expect(existsSync(join(root, 'runtime', 'llama.cpp', 'escaped'))).toBe(false)
    })

    // The control of the row above: a `..` that stays inside the archive is an ordinary relative link. Where tar cannot make
    // links (Windows, exFAT) a guard that refused every `..` failed the install, after the old build was gone.
    it('a link whose target climbs out of its own folder but stays in the archive is followed (#767)', () => {
      const ggml = 'libggml bytes'
      const archive = nestedLinuxBuild([
        { name: `llama-${VERSION}/bin/`, dir: true },
        { name: `llama-${VERSION}/bin/libggml.so`, symlink: '../lib/libggml.so.1' },
        { name: `llama-${VERSION}/lib/`, dir: true },
        { name: `llama-${VERSION}/lib/libggml.so.1`, data: Buffer.from(ggml) }
      ])
      const root = pinnedDrive(LINUX, serve(`llama-${VERSION}-bin-ubuntu-vulkan-x64.tar.gz`, archive), sha256Of(archive))
      const r = fetchRuntime(root, [f('Os'), 'linux'])
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).not.toContain('points outside')
      expect(readFileSync(join(root, ...LINUX.extractTo.split('/'), 'bin', 'libggml.so'), 'utf8')).toBe(ggml)
    })

    it('an OCR file present with the wrong bytes is deleted and fetched whole, not resumed onto (AUD-24)', () => {
      // The same length as the real file: curl -C - resumes at the end of what is on disk, so without the delete it asks for
      // nothing and the wrong bytes stay.
      const real = 'deu traineddata'
      const root = scriptRoot('fr-ocr-')
      const yaml = ['ocr:', '  version: 4.0.0_best_int', '  files:', '    - lang: deu']
      yaml.push(`      url: ${serve('deu.traineddata.gz', Buffer.from(real))}`, `      sha256: ${sha256Of(real)}`, '      dest: ocr/deu.traineddata.gz', '')
      writeDriveFile(root, 'model-manifests/runtime-sources.yaml', yaml.join('\n'))
      writeDriveFile(root, 'ocr/deu.traineddata.gz', 'X'.repeat(real.length))
      const r = fetchRuntime(root, [f('Family'), 'ocr'])
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).toContain('present but hash differs')
      expect(readFileSync(join(root, 'ocr', 'deu.traineddata.gz'), 'utf8')).toBe(real)
    })

    // No curl.exe on PATH. The .ps1 carries no downloader of its own: its last resort, Invoke-WebRequest and then a WebClient
    // line, was the download line antivirus heuristics flag (Norton quarantined a copy, #767), and every Windows from 10 1803
    // on ships curl.exe. Exit 3, as the .sh twin exits with no downloader.
    it.runIf(leg.ext === 'ps1').each(['a runtime archive', 'an OCR file'])('with no curl.exe on PATH, fetching %s stops naming curl.exe (exit 3)', (what) => {
      const { PATH = '', ...rest } = downloadEnv()
      const noCurl = { ...rest, PATH: PATH.split(delimiter).filter((dir) => !existsSync(join(dir, 'curl.exe'))).join(delimiter) }
      let root: string
      let r: ReturnType<typeof fetchRuntime>
      if (what === 'a runtime archive') {
        const archive = winBuild('new build')
        root = pinnedDrive(WIN, serve(`llama-${VERSION}-bin-win-vulkan-x64.zip`, archive), sha256Of(archive))
        r = fetchRuntime(root, [f('Os'), 'win'], noCurl)
      } else {
        const real = 'deu traineddata'
        root = scriptRoot('fr-ocr-')
        const yaml = ['ocr:', '  version: 4.0.0_best_int', '  files:', '    - lang: deu']
        yaml.push(`      url: ${serve('deu.traineddata.gz', Buffer.from(real))}`, `      sha256: ${sha256Of(real)}`, '      dest: ocr/deu.traineddata.gz', '')
        writeDriveFile(root, 'model-manifests/runtime-sources.yaml', yaml.join('\n'))
        r = fetchRuntime(root, [f('Family'), 'ocr'], noCurl)
      }
      const out = outputOf(r)
      expect(r.status, out).toBe(3)
      expect(out).toContain('No downloader found (need curl.exe')
      expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz')) || existsSync(join(root, ...WIN.extractTo.split('/'), 'llama-server.exe'))).toBe(false)
    })
  })
}

// --- Dry runs over the committed runtime-sources.yaml -------------------------------------------------------------------
// committed-catalog reads the yaml through the app's parser. Nothing ran the scripts' flat parsers over it (#769): a key
// the twins read differently from the app would plan another URL, dir or file set than the app installs and the sell gate
// checks. Each ask is one the drive builder makes. These run the repo's own scripts/: the #516 Note reads the repo's yaml
// beside them, and a dry run downloads nothing.

const sources = committedRuntimeSources()

interface Ask {
  title: string
  args: Array<[string, string]>
  family: RuntimeFamily
  build: RuntimeBuild
}

function builderAsks(): Ask[] {
  const asks: Ask[] = []
  const ask = (family: RuntimeFamily, build: RuntimeBuild, args: Array<[string, string]>): void => {
    const all: Array<[string, string]> = family === 'llama_cpp' ? args : [['Family', family], ...args]
    asks.push({ title: `${family}, ${args.map(([k, v]) => `${k} ${v}`).join(' ')}`, args: all, family, build })
  }
  for (const family of ['llama_cpp', 'whisper_cpp'] as const) {
    const fam = sources.families?.[family]
    if (!fam) throw new Error(`the committed yaml has no ${family} block`)
    for (const os of ['win', 'mac', 'linux'] as const) {
      // The default build is asked for by its OS alone, every other one by its backend too (the builder's cpu safety net).
      selectRuntimeBuilds(fam, { os }).forEach((build, i) => ask(family, build, i === 0 ? [['Os', os]] : [['Os', os], ['Backend', build.backend]]))
    }
  }
  const kiwix = sources.families?.kiwix_tools
  if (!kiwix) throw new Error('the committed yaml has no kiwix_tools block')
  for (const build of kiwix.builds) ask('kiwix_tools', build, [['Os', build.os], ['Arch', build.arch]])
  return asks
}

/** The files the app requires of an install of `build`, by name: what its marker must hash and the sell gate checks. */
function appRequiredFiles(family: RuntimeFamily, build: RuntimeBuild): string[] {
  const fam = sources.families![family]!
  const spec = sidecarFamilySpec(family)!
  const plan = planRuntimeDownload(tmpdir(), build, fam.version, spec.binaryBase, {
    alsoRequired: spec.alsoRequired,
    declaredExecutables: fam.executables
  })
  return requiredInstallFiles(plan).map((p) => basename(p))
}

/** A drive carrying the committed yaml (or `yaml`), as prepare-drive copies it. */
function committedDrive(yaml = repoText('model-manifests', 'runtime-sources.yaml')): string {
  const root = scriptRoot('fr-plan-')
  mkdirSync(join(root, 'model-manifests'))
  writeFileSync(join(root, 'model-manifests', 'runtime-sources.yaml'), yaml)
  return root
}

for (const leg of SCRIPT_LEGS) {
  describe.skipIf(leg.skip)(`fetch-runtime plans the committed yaml — ${leg.name}`, () => {
    const f = leg.flag
    const dryRun = (root: string, args: Array<[string, string]>) =>
      leg.run(`fetch-runtime.${leg.ext}`, [f('Target'), root, ...args.flatMap(([k, v]) => [f(k), v]), f('DryRun')])

    it.each(builderAsks().map((a) => [a.title, a] as const))(
      '%s: the plan is the app’s reading of the committed yaml, with no #516 Note',
      (_title, ask) => {
        const root = committedDrive()
        const r = dryRun(root, ask.args)
        const out = outputOf(r)
        expect(r.status, out).toBe(0)
        const version = sources.families![ask.family]!.version
        expect(out).toContain(`build: ${ask.build.os}/${ask.build.arch} ${ask.build.backend} @ ${version}`)
        expect(out).toContain(`url:   ${ask.build.url}`)
        const line = (key: string): string => out.split(/\r?\n/).find((l) => l.trimStart().startsWith(key)) ?? ''
        expect(line('into:').replace(/\\/g, '/').trim().endsWith(ask.build.extractTo), line('into:')).toBe(true)
        const planned = line('files:').replace('files:', '').split(/[\s,]+/).filter(Boolean)
        expect(planned.sort()).toEqual(appRequiredFiles(ask.family, ask.build).sort())
        expect(out).not.toContain('Note:')
        expect(existsSync(join(root, 'runtime')), 'a dry run creates nothing').toBe(false)
      }
    )

    it('Family ocr: every language file the app reads, at its dest, from its url', () => {
      const ocr = sources.ocr
      if (!ocr) throw new Error('the committed yaml has no ocr block')
      const r = dryRun(committedDrive(), [['Family', 'ocr']])
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).toContain(`(data ${ocr.version})`)
      for (const file of ocr.files) {
        expect(out).toContain(`${file.lang}: ${file.dest}`)
        expect(out).toContain(`would fetch ${file.url}`)
      }
      expect(out.match(/would fetch /g)).toHaveLength(ocr.files.length)
    })

    it('a drive whose yaml pins an older llama_cpp than the repo plans the drive’s pin and prints the #516 Note', () => {
      const repoVersion = sources.families!.llama_cpp!.version
      const committed = repoText('model-manifests', 'runtime-sources.yaml')
      const older = committed.replace(/^(llama_cpp:\r?\n\s+version:\s*)\S+/m, '$1b1')
      expect(older, 'the llama_cpp version line moved').not.toBe(committed)
      const r = dryRun(committedDrive(older), [['Os', 'win']])
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).toContain(' @ b1')
      expect(out).toContain(`Note: the drive's runtime-sources.yaml pins llama_cpp b1; this repo pins ${repoVersion}.`)
    })
  })
}
