import { afterEach, describe, it, expect, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import {
  EngineDownloadManager,
  engineFolderDeletesSettled,
  makeTarExtractor,
  type EngineJobEnd,
  type ExtractFn,
  type ExtractSpawn
} from '../../src/main/services/runtime-download'
import { runtimeMarkerPath, writeRuntimeMarker, type FetchFn } from '../../src/main/services/assets'
import { tMain } from '../../src/main/services/i18n'
import type { EngineDownloadJob } from '../../src/shared/types'
import { makeTarGz, type TarEntry } from '../helpers/archives'
import { runToEnd } from '../helpers/download-fixtures'
import { hangBudgetMs } from '../helpers/hang-budget'

// #1045 (T8.5c, R2 M-2): the macOS and Linux llama.cpp release tarballs carry version links (`libllama.so` →
// `libllama.so.0` → `libllama.so.0.0.1`), and exFAT, the Kit's file system, holds no links. tar then fails each
// link member and exits non-zero, and the in-app install failed every time: "Install again" and an in-app update
// never worked on a Kit's Mac or Linux engine. Since #1045 the install does what `scripts/fetch-runtime.sh` does
// (its `stays_inside` rule included): after a tar that ran to its end and failed, each link the archive lists that
// is missing becomes a copy of its target (several passes, for chained links); a link whose name or target leaves
// the folder refuses the install; and tar's failure stands when a member the archive lists is still missing.
//
// The archive is built here (`makeTarGz`) and unpacked by the OS's own tar. A drive that refuses links is stood in
// for at the extractor's existing `spawn` seam (`makeTarExtractor({ spawn })`): the real tar runs with the link
// members left out, and the child reports the exit such a drive gives. The link listing the install reads is the
// real tar's (`tar -tvzf -`). The Windows release archives are zips, which carry no links: not part of #1045.

const VERSION = 'b200'
const RELEASE = `llama-${VERSION}`
const ARCHIVE_NAME = `llama-${VERSION}-bin-ubuntu-vulkan-x64.tar.gz`
const LINUX = { platform: 'linux' as const, arch: 'x64' }
const ALLOW = { policyAllows: true, settingAllows: true }
const SERVER = 'linux server b200'
const LIB = 'libllama bytes'
const LINKS = [`${RELEASE}/libllama.so`, `${RELEASE}/libllama.so.0`]
const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')

/** The release's layout: one top folder, the server, and a library behind two chained links, listed before it. */
const release = (extra: TarEntry[] = []): Buffer =>
  makeTarGz([
    { name: `${RELEASE}/`, dir: true },
    { name: `${RELEASE}/llama-server`, data: Buffer.from(SERVER), mode: 0o755 },
    { name: `${RELEASE}/libllama.so`, symlink: 'libllama.so.0' },
    { name: `${RELEASE}/libllama.so.0`, symlink: 'libllama.so.0.0.1' },
    { name: `${RELEASE}/libllama.so.0.0.1`, data: Buffer.from(LIB) },
    ...extra
  ])

const liveDir = (root: string): string => join(root, 'runtime', 'llama.cpp', 'linux')

/** A Linux drive with llama.cpp b150 installed; `pin` then makes b200 from an archive its pin. */
function linuxDrive(): { rootPath: string; manifestsDir: string; pin: (archive: Buffer) => void } {
  const rootPath = join(mkdtempSync(join(tmpdir(), 'hr-engine-links-')), 'drive')
  const manifestsDir = mkdtempSync(join(tmpdir(), 'hr-engine-links-pins-'))
  const live = liveDir(rootPath)
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'llama-server'), 'engine b150')
  writeRuntimeMarker(live, { version: 'b150', backend: 'vulkan', os: 'linux', arch: 'x64' })
  const pin = (archive: Buffer): void => {
    const build = { os: 'linux', arch: 'x64', backend: 'vulkan', url: `https://example.test/${ARCHIVE_NAME}`, sha256: sha256(archive) }
    const yaml = { llama_cpp: { version: VERSION, builds: [{ ...build, extract_to: 'runtime/llama.cpp/linux' }] } }
    writeFileSync(join(manifestsDir, 'runtime-sources.yaml'), stringify(yaml))
  }
  return { rootPath, manifestsDir, pin }
}

/** Every entry under `dir` by its relative path, each file by its bytes' SHA-256: equal answers are identical trees. */
function contentDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name)
    out[full.slice(dir.length + 1).split(/[\\/]/).join('/')] = entry.isDirectory() ? 'dir' : sha256(readFileSync(full))
  }
  return out
}

/**
 * The OS's tar on a drive that holds no links: it writes every other member and fails each of `refused` (here they
 * are left out of the real tar's run), then exits non-zero, as GNU tar does there (2; bsdtar exits 1). `hold`: a tar
 * wedged after its last write, whose exit comes only once the extractor kills it. `short`: members tar wrote only
 * half of (an I/O error on a stick, a full drive). `folders`: members with a folder in their place, left out of the
 * run too. `linkAt`: a link to the folder tar unpacks in, as tar makes one on a drive that does hold links (a
 * junction on Windows, which needs no privilege and which Node reads as a symbolic link; a symbolic link elsewhere).
 */
function tarOnLinklessDrive(
  refused: string[],
  opts: { hold?: boolean; short?: string[]; folders?: string[]; linkAt?: string } = {}
): ExtractSpawn {
  return (command, args, options) => {
    const left = [...refused, ...(opts.folders ?? [])]
    const real = spawn(command, [...left.flatMap((m) => ['--exclude', m]), ...args], options)
    const at = (member: string): string => join(String(options.cwd), ...member.split('/'))
    const realDone = new Promise<number | null>((resolve) =>
      real.on('close', (code) => {
        for (const m of opts.short ?? []) truncateSync(at(m), Math.floor(statSync(at(m)).size / 2))
        for (const m of opts.folders ?? []) mkdirSync(at(m), { recursive: true })
        if (opts.linkAt) symlinkSync(String(options.cwd), at(opts.linkAt), 'junction')
        resolve(code)
      })
    )
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter
    const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.emit('exit', code, signal)
      child.emit('close', code, signal)
    }
    real.on('error', (err) => child.emit('error', err))
    if (opts.hold) {
      Object.assign(child, { kill: () => (void realDone.then(() => exit(null, 'SIGTERM')), true) })
    } else {
      Object.assign(child, { kill: (signal?: NodeJS.Signals) => real.kill(signal) })
      void realDone.then((code) => exit(code === 0 ? 2 : code, null))
    }
    return child
  }
}

/** A manager whose download serves `archive`, unpacked by `extractImpl` (default: the real `extractWithTar`). */
function manager(archive: Buffer, extractImpl?: ExtractFn): { mgr: EngineDownloadManager; logs: Array<[string, unknown]> } {
  const logs: Array<[string, unknown]> = []
  const fetchImpl = (async () =>
    new Response(new Uint8Array(archive), {
      status: 200,
      headers: { 'content-length': String(archive.length) }
    })) as unknown as FetchFn
  const log = (m: string, meta?: unknown): void => void logs.push([m, meta])
  return { mgr: new EngineDownloadManager({ fetchImpl, log, ...(extractImpl ? { extractImpl } : {}) }), logs }
}

/** Update the Linux drive to b200: the job and its audit end, once its run and the deletes it queued have settled. */
async function update(
  rootPath: string,
  manifestsDir: string,
  mgr: EngineDownloadManager
): Promise<{ job: EngineDownloadJob; ends: EngineJobEnd[] }> {
  const ends: EngineJobEnd[] = []
  mgr.onSettled((_job, end) => ends.push(end))
  const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['llama_cpp'], update: true, ...LINUX })
  const job = await runToEnd(mgr, started.jobId)
  await vi.waitFor(() => expect(mgr.activeJob()).toBeNull(), { timeout: hangBudgetMs(5000) })
  await engineFolderDeletesSettled()
  return { job, ends }
}

const marker = (dir: string): unknown => JSON.parse(readFileSync(runtimeMarkerPath(dir), 'utf8'))
const B200_MARKER = {
  version: VERSION,
  backend: 'vulkan',
  os: 'linux',
  arch: 'x64',
  binaries: { 'llama-server': sha256(SERVER), 'libllama.so': sha256(LIB), 'libllama.so.0': sha256(LIB), 'libllama.so.0.0.1': sha256(LIB) }
}

/** Whether this host's file system takes a file link from this user (Windows refuses one without Developer Mode). */
function hostMakesFileLinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'hr-engine-links-probe-'))
  writeFileSync(join(dir, 'target'), 'x')
  try {
    symlinkSync('target', join(dir, 'link'), 'file')
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  delete process.env.HILBERTRAUM_EXTRACT_DEADLINE_MS
})

describe('engine archives with version links on a drive that holds no links (#1045)', () => {
  // macOS and Linux only: the Windows engine archives are zips without links, which the repair never reads (out of scope).
  it('chained links become copies of their targets, and the update installs', async () => {
    const { rootPath, manifestsDir, pin } = linuxDrive()
    const archive = release()
    pin(archive)
    const { mgr, logs } = manager(archive, makeTarExtractor({ spawn: tarOnLinklessDrive(LINKS) }))
    const { job, ends } = await update(rootPath, manifestsDir, mgr)
    expect(job.status, job.error ?? '').toBe('done')
    expect(ends.map((e) => e.reason)).toEqual([null])
    const live = liveDir(rootPath)
    const files = readdirSync(live, { withFileTypes: true }).filter((e) => !e.isDirectory())
    expect(files.map((e) => e.name).sort()).toEqual(['.hilbertraum-runtime.json', 'libllama.so', 'libllama.so.0', 'libllama.so.0.0.1', 'llama-server'])
    // Every name the loader opens is there with the library's bytes, as a file of its own.
    for (const name of ['libllama.so', 'libllama.so.0']) {
      expect(lstatSync(join(live, name)).isFile(), name).toBe(true)
      expect(readFileSync(join(live, name), 'utf8'), name).toBe(LIB)
    }
    expect(marker(live)).toEqual(B200_MARKER)
    // Content-free: the pinned archive's name, tar's exit code, how many copies.
    expect(logs).toContainEqual([
      'tar failed, and every member the archive lists is there with its links copied',
      { archive: ARCHIVE_NAME, exitCode: 2, copies: 2 }
    ])
  })

  // fetch-runtime.sh's `stays_inside` rule: the archive names both ends of a link, and neither may leave the folder,
  // by its text (an absolute name) or once `..` is resolved. Each target is a file there, so only the rule stops it.
  it.each([
    {
      name: 'a target that climbs out of the folder',
      link: (): TarEntry => ({ name: `${RELEASE}/libescape.so`, symlink: '../../../../secret.so' })
    },
    {
      name: 'an absolute target',
      link: (root: string): TarEntry => ({ name: `${RELEASE}/libescape.so`, symlink: join(root, 'secret.so') })
    },
    {
      // Both tars refuse such a member themselves.
      name: 'a name that climbs out of the folder',
      link: (): TarEntry => ({ name: `${RELEASE}/../../libescape.so`, symlink: `linux.new/${RELEASE}/libllama.so.0.0.1` })
    }
  ])('a link with $name refuses the install: nothing copied out, nothing swapped', async ({ link }) => {
    const { rootPath, manifestsDir, pin } = linuxDrive()
    const entry = link(rootPath)
    expect('symlink' in entry && entry.symlink.length < 100).toBe(true) // ustar's link-name field
    const archive = release([entry])
    pin(archive)
    writeFileSync(join(rootPath, 'secret.so'), 'not an engine file')
    const before = contentDigest(join(rootPath, 'runtime'))
    const { mgr } = manager(archive, makeTarExtractor({ spawn: tarOnLinklessDrive([...LINKS, entry.name]) }))
    const { job, ends } = await update(rootPath, manifestsDir, mgr)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.extractFailed') })
    expect(ends.map((e) => e.reason)).toEqual(['install'])
    expect(contentDigest(join(rootPath, 'runtime'))).toEqual(before)
    expect(readFileSync(join(rootPath, 'secret.so'), 'utf8')).toBe('not an engine file')
    expect(existsSync(join(rootPath, 'runtime', 'llama.cpp', 'libescape.so'))).toBe(false)
  })

  // Any other failure is real: a member tar could not write (here left out of its run, as a refused write or a file
  // an antivirus took) is still missing after the link copies, so tar's failure stands, as before #1045.
  it('a member that is really missing fails the install with tar’s failure, and nothing is swapped', async () => {
    const { rootPath, manifestsDir, pin } = linuxDrive()
    const archive = release([{ name: `${RELEASE}/libggml.so`, data: Buffer.from('ggml') }])
    pin(archive)
    const before = contentDigest(join(rootPath, 'runtime'))
    const { mgr, logs } = manager(archive, makeTarExtractor({ spawn: tarOnLinklessDrive([...LINKS, `${RELEASE}/libggml.so`]) }))
    const { job, ends } = await update(rootPath, manifestsDir, mgr)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.extractFailed') })
    expect(ends.map((e) => e.reason)).toEqual(['install'])
    expect(contentDigest(join(rootPath, 'runtime'))).toEqual(before)
    expect(logs).toContainEqual([
      'tar failed and files the archive lists are still missing after the link copies',
      { archive: ARCHIVE_NAME, exitCode: 2, count: 1, missing: [`${RELEASE}/libggml.so`] }
    ])
  })

  // #1045 round 2: presence is not enough. A member tar wrote short (an I/O error on a stick, a full drive) is there,
  // and the marker would record its bytes as the engine's: on a failed tar every regular member must be the size the
  // archive gives, or tar's failure stands. (The links' copies count by their presence; their target is sized.)
  it('a member tar wrote short fails the install with tar’s failure, and nothing is swapped', async () => {
    const { rootPath, manifestsDir, pin } = linuxDrive()
    const archive = release()
    pin(archive)
    const before = contentDigest(join(rootPath, 'runtime'))
    const lib = `${RELEASE}/libllama.so.0.0.1`
    const { mgr, logs } = manager(archive, makeTarExtractor({ spawn: tarOnLinklessDrive(LINKS, { short: [lib] }) }))
    const { job, ends } = await update(rootPath, manifestsDir, mgr)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.extractFailed') })
    expect(ends.map((e) => e.reason)).toEqual(['install'])
    expect(contentDigest(join(rootPath, 'runtime'))).toEqual(before)
    expect(logs).toContainEqual([
      'tar failed and files the archive lists cannot be sized or are not the size it gives',
      { archive: ARCHIVE_NAME, exitCode: 2, count: 1, files: [lib] }
    ])
  })

  // …and a member that cannot be sized (something other than a file in its place) is no mend either.
  it('a member that cannot be sized fails the install with tar’s failure, and nothing is swapped', async () => {
    const { rootPath, manifestsDir, pin } = linuxDrive()
    const ggml = `${RELEASE}/libggml.so`
    const archive = release([{ name: ggml, data: Buffer.from('ggml') }])
    pin(archive)
    const before = contentDigest(join(rootPath, 'runtime'))
    const { mgr, logs } = manager(archive, makeTarExtractor({ spawn: tarOnLinklessDrive(LINKS, { folders: [ggml] }) }))
    const { job, ends } = await update(rootPath, manifestsDir, mgr)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.extractFailed') })
    expect(ends.map((e) => e.reason)).toEqual(['install'])
    expect(contentDigest(join(rootPath, 'runtime'))).toEqual(before)
    expect(logs).toContainEqual([
      'tar failed and files the archive lists cannot be sized or are not the size it gives',
      { archive: ARCHIVE_NAME, exitCode: 2, count: 1, files: [ggml] }
    ])
  })

  // T8.5c round 3 (R2 N-2): the repair is for a drive that holds no links. On one that does, a link tar made could
  // take a copy outside the folder whatever the names say, so a stage holding any link is never repaired and tar's
  // failure stands, as before #1045. The link here is contained (it names the folder itself): any link at all is enough.
  it('a stage that holds a link is not repaired: tar’s failure stands, and nothing is swapped', async () => {
    const { rootPath, manifestsDir, pin } = linuxDrive()
    const archive = release()
    pin(archive)
    const before = contentDigest(join(rootPath, 'runtime'))
    const { mgr, logs } = manager(archive, makeTarExtractor({ spawn: tarOnLinklessDrive(LINKS, { linkAt: `${RELEASE}/folder-link` }) }))
    const { job, ends } = await update(rootPath, manifestsDir, mgr)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.extractFailed') })
    expect(ends.map((e) => e.reason)).toEqual(['install'])
    expect(contentDigest(join(rootPath, 'runtime'))).toEqual(before)
    expect(logs).toContainEqual(['tar failed and the folder holds a link: no repair', { archive: ARCHIVE_NAME, exitCode: 2 }])
  })

  // Only a tar that ran to its end is mended: one stopped by the deadline (or a cancel) may have cut a member short.
  it('a tar stopped at the deadline is never mended, though every member it wrote is there', async () => {
    process.env.HILBERTRAUM_EXTRACT_DEADLINE_MS = '300'
    const { rootPath, manifestsDir, pin } = linuxDrive()
    const archive = release()
    pin(archive)
    const before = contentDigest(join(rootPath, 'runtime'))
    const { mgr } = manager(archive, makeTarExtractor({ spawn: tarOnLinklessDrive(LINKS, { hold: true }), graceMs: 50 }))
    const { job, ends } = await update(rootPath, manifestsDir, mgr)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.extractFailed') })
    expect(ends.map((e) => e.reason)).toEqual(['install'])
    expect(contentDigest(join(rootPath, 'runtime'))).toEqual(before)
  })

  // The OS's own tar, no stand-in: where it can make links (Linux, macOS, Windows in Developer Mode) they stay links
  // and nothing is copied; where the file system refuses them (Windows otherwise, as exFAT does on a Kit) tar fails
  // each link member, and the install copies them.
  const links = hostMakesFileLinks()
  it(`the OS tar: ${links ? 'the links it makes stay links' : 'the links this host refuses become copies'}`, async () => {
    const { rootPath, manifestsDir, pin } = linuxDrive()
    const archive = release()
    pin(archive)
    const { mgr, logs } = manager(archive)
    const { job } = await update(rootPath, manifestsDir, mgr)
    expect(job.status, job.error ?? '').toBe('done')
    const live = liveDir(rootPath)
    for (const name of ['libllama.so', 'libllama.so.0']) {
      expect(lstatSync(join(live, name)).isSymbolicLink(), name).toBe(links)
      expect(readFileSync(join(live, name), 'utf8'), name).toBe(LIB)
    }
    expect(marker(live)).toEqual(B200_MARKER)
    expect(logs.some(([m]) => m.startsWith('tar failed, and every member the archive lists is there'))).toBe(!links)
  })
})
