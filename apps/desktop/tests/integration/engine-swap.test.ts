import { describe, it, expect, vi, afterEach } from 'vitest'
// #986: the engine install never deletes first. It stages the new copy in `<os>.new/` (marker inside,
// written last), moves the install to `<os>.old/` and `.new` in, carries the `cpu/` net over, and
// deletes `.old` after the job; the next start finishes or rolls back a swap a kill interrupted. The
// seams are the module's own file and timer calls: `rename` and `rm` (node:fs/promises) refuse as a
// row scripts, the way Windows answers while an antivirus scan holds a file; `renameSync` (node:fs)
// for the start's renames; and the retry's wait (node:timers/promises) returns at once.
const seams = vi.hoisted(() => ({
  renameRefuses: null as ((from: string, to: string) => string | null) | null,
  renameSyncRefuses: null as ((from: string, to: string) => string | null) | null,
  rmRefuses: null as ((path: string) => boolean) | null,
  onRename: null as ((from: string, to: string) => void) | null
}))
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted`), { code })
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const mocked = {
    ...orig,
    rename: async (from: Parameters<typeof orig.rename>[0], to: Parameters<typeof orig.rename>[1]) => {
      seams.onRename?.(String(from), String(to))
      const code = seams.renameRefuses?.(String(from), String(to))
      if (code) throw errno(code)
      return orig.rename(from, to)
    },
    rm: async (...args: Parameters<typeof orig.rm>) => {
      if (seams.rmRefuses?.(String(args[0]))) throw errno('EBUSY')
      return orig.rm(...args)
    }
  }
  return { ...mocked, default: mocked }
})
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  const mocked = {
    ...orig,
    renameSync: (from: Parameters<typeof orig.renameSync>[0], to: Parameters<typeof orig.renameSync>[1]) => {
      const code = seams.renameSyncRefuses?.(String(from), String(to))
      if (code) throw errno(code)
      return orig.renameSync(from, to)
    }
  }
  return { ...mocked, default: mocked }
})
vi.mock('node:timers/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:timers/promises')>()
  const mocked = { ...orig, setTimeout: async () => undefined }
  return { ...mocked, default: mocked }
})

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { stringify } from 'yaml'
import {
  EngineDownloadManager,
  engineFolderDeletesSettled,
  engineStatus,
  hostRuntimeArch,
  hostRuntimeOs,
  recoverEngineSwaps,
  resolveTarBinary,
  type EngineJobEnd,
  type ExtractFn
} from '../../src/main/services/runtime-download'
import { llamaServerBinaryName } from '../../src/main/services/runtime/sidecar'
import { runtimeMarkerPath, writeRuntimeMarker, type FetchFn } from '../../src/main/services/assets'
import { tMain } from '../../src/main/services/i18n'
import type { EngineDownloadJob } from '../../src/shared/types'
import { makeTarGz, makeZip } from '../helpers/archives'
import { runToEnd } from '../helpers/download-fixtures'
import { hangBudgetMs } from '../helpers/hang-budget'
import { fingerprintTree } from '../helpers/read-only-witness'

afterEach(() => {
  seams.renameRefuses = null
  seams.renameSyncRefuses = null
  seams.rmRefuses = null
  seams.onRename = null
})

const HOST_OS = hostRuntimeOs()
const HOST_ARCH = hostRuntimeArch()
const BIN = llamaServerBinaryName()
const BODY = Buffer.from('engine-archive-bytes')
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const ALLOW = { policyAllows: true, settingAllows: true }

/** The pin: llama.cpp b200, a main build and its `cpu/` net inside it, both for this host. */
function makeDrive(archive: Buffer = BODY, folder = 'drive'): { rootPath: string; manifestsDir: string } {
  const rootPath = join(mkdtempSync(join(tmpdir(), 'hr-engine-swap-')), folder)
  mkdirSync(rootPath, { recursive: true })
  const manifestsDir = mkdtempSync(join(tmpdir(), 'hr-engine-swap-pins-'))
  const ext = archive[0] === 0x1f ? 'tar.gz' : 'zip'
  const build = (backend: string, extractTo: string, name: string) => ({
    os: HOST_OS,
    arch: HOST_ARCH,
    backend,
    url: `https://example.test/${name}.${ext}`,
    sha256: sha256(archive),
    extract_to: extractTo
  })
  writeFileSync(
    join(manifestsDir, 'runtime-sources.yaml'),
    stringify({
      llama_cpp: {
        version: 'b200',
        builds: [
          build('vulkan', `runtime/llama.cpp/${HOST_OS}`, 'llama-main'),
          build('cpu', `runtime/llama.cpp/${HOST_OS}/cpu`, 'llama-cpu')
        ]
      }
    })
  )
  return { rootPath, manifestsDir }
}

const liveDir = (root: string): string => join(root, 'runtime', 'llama.cpp', HOST_OS)
const netDir = (root: string): string => join(liveDir(root), 'cpu')

/** An engine copy in `dir`: its program (content `<label> <version>`) and its marker, either left out. */
function copy(dir: string, version: string, opts: { label?: string; exe?: boolean; marker?: boolean; backend?: string } = {}): void {
  mkdirSync(dir, { recursive: true })
  if (opts.exe !== false) writeFileSync(join(dir, BIN), `${opts.label ?? 'engine'} ${version}`)
  if (opts.marker !== false) {
    writeRuntimeMarker(dir, { version, backend: opts.backend ?? 'vulkan', os: HOST_OS, arch: HOST_ARCH })
  }
}
const net = (dir: string, version: string, opts: { exe?: boolean; marker?: boolean } = {}): void =>
  copy(dir, version, { ...opts, label: 'net', backend: 'cpu' })

/** `<program content>|<marker version>` (`-` for either missing), or `absent`. */
function summary(dir: string): string {
  if (!existsSync(dir)) return 'absent'
  const exe = existsSync(join(dir, BIN)) ? readFileSync(join(dir, BIN), 'utf8') : '-'
  let marker = '-'
  try {
    marker = (JSON.parse(readFileSync(runtimeMarkerPath(dir), 'utf8')) as { version: string }).version
  } catch {
    /* none */
  }
  return `${exe}|${marker}`
}

/** The five folders the main build's swap and its net's swap use. */
function layout(root: string): Record<string, string> {
  const live = liveDir(root)
  return {
    live: summary(live),
    net: summary(join(live, 'cpu')),
    staging: summary(`${live}.new`),
    previous: summary(`${live}.old`),
    netStaging: summary(join(live, 'cpu.new')),
    netPrevious: summary(join(live, 'cpu.old'))
  }
}
const NOTHING_LEFT = { staging: 'absent', previous: 'absent', netStaging: 'absent', netPrevious: 'absent' }

async function recover(root: string, manifestsDir: string): Promise<void> {
  recoverEngineSwaps(root, manifestsDir)
  await engineFolderDeletesSettled()
}

// ---- The start recovery: one disk layout per place a kill can land -------------------------------

interface CrashLayout {
  name: string
  build: (root: string) => void
  expected: Record<string, string>
}

// Each layout is the disk a kill, an unplug or a crash leaves at one point of the swap (the main build
// with its `cpu/` net inside it, b150 → b200). Before #986 no start looked at any of them: the rows
// whose install folder is missing or empty were a drive with no engine.
const CRASH_LAYOUTS: CrashLayout[] = [
  {
    name: 'an update killed while it was still unpacking',
    build: (root) => {
      copy(liveDir(root), 'b150')
      net(netDir(root), 'b150')
      copy(`${liveDir(root)}.new`, 'b200', { marker: false })
    },
    expected: { live: 'engine b150|b150', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    // The new copy was whole, but nothing installed had been touched: the old engine stays.
    name: 'an update killed after staging, before its first rename',
    build: (root) => {
      copy(liveDir(root), 'b150')
      net(netDir(root), 'b150')
      copy(`${liveDir(root)}.new`, 'b200')
    },
    expected: { live: 'engine b150|b150', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    name: 'an update killed between its two renames',
    build: (root) => {
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
      copy(`${liveDir(root)}.new`, 'b200')
    },
    expected: { live: 'engine b200|b200', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    // #986 gap 1: the new copy is complete but has no net yet; deleting `.old` would delete the only net.
    name: 'an update killed after its second rename, before the cpu/ net was carried over',
    build: (root) => {
      copy(liveDir(root), 'b200')
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
    },
    expected: { live: 'engine b200|b200', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    name: 'killed while the replaced copy was being deleted (its marker already gone)',
    build: (root) => {
      copy(liveDir(root), 'b200')
      net(netDir(root), 'b150')
      copy(`${liveDir(root)}.old`, 'b150', { marker: false })
    },
    expected: { live: 'engine b200|b200', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    // #986 gap 2: the install folder exists (the archive's download made it) but holds no engine.
    name: 'a first install killed before its first rename',
    build: (root) => {
      mkdirSync(liveDir(root), { recursive: true })
      copy(`${liveDir(root)}.new`, 'b200')
    },
    expected: { live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT }
  },
  {
    name: 'a first install killed between its renames',
    build: (root) => {
      mkdirSync(`${liveDir(root)}.old`, { recursive: true })
      copy(`${liveDir(root)}.new`, 'b200')
    },
    expected: { live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT }
  },
  {
    // A marker alone is not a copy: the program went (a scanner took it) after the swap began.
    name: 'an update killed between its renames whose new program was taken since',
    build: (root) => {
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
      copy(`${liveDir(root)}.new`, 'b200', { exe: false })
    },
    expected: { live: 'engine b150|b150', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    // #986 gap 3: a delete of `.old` cut short on exFAT (creation order: the marker, written last, goes
    // last) kept the marker over a missing program. Not trusted; its net is carried out before it goes.
    name: 'a replaced copy whose delete kept only its marker, beside no install',
    build: (root) => {
      copy(`${liveDir(root)}.old`, 'b150', { exe: false })
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
    },
    expected: { live: '-|-', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    name: 'the cpu/ net’s own swap killed between its renames',
    build: (root) => {
      copy(liveDir(root), 'b200')
      net(join(liveDir(root), 'cpu.old'), 'b150')
      net(join(liveDir(root), 'cpu.new'), 'b200')
    },
    expected: { live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT }
  }
]

describe('recoverEngineSwaps: the start finishes or rolls back an interrupted swap (#986)', () => {
  it.each(CRASH_LAYOUTS)('$name', async ({ build, expected }) => {
    const { rootPath, manifestsDir } = makeDrive()
    build(rootPath)
    await recover(rootPath, manifestsDir)
    expect(layout(rootPath)).toEqual(expected)
  })

  it('an install with nothing beside it is not touched', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    net(netDir(rootPath), 'b150')
    const before = fingerprintTree(join(rootPath, 'runtime'))
    await recover(rootPath, manifestsDir)
    expect(fingerprintTree(join(rootPath, 'runtime'))).toEqual(before)
  })

  // Frozen in the first Kit release: the app-update plan installs a later engine into
  // `<os>@<pin>/` beside this one. The start must only ever act on its own two exact names.
  it('acts on the exact .new and .old names only: other folders beside the install stay as they are', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    copy(`${liveDir(rootPath)}.new`, 'b200', { marker: false })
    const others = [`${liveDir(rootPath)}@b300`, `${liveDir(rootPath)}@b300.new`, `${liveDir(rootPath)}.new.keep`]
    copy(others[0], 'b300')
    copy(others[1], 'b300', { marker: false })
    copy(others[2], 'b300')
    const before = others.map((d) => fingerprintTree(d))
    await recover(rootPath, manifestsDir)
    expect(summary(`${liveDir(rootPath)}.new`)).toBe('absent')
    expect(others.map((d) => fingerprintTree(d))).toEqual(before)
    expect(others.map((d) => existsSync(d))).toEqual([true, true, true])
  })

  // #986 gap 3: a delete cut short must leave the copy unmarked, so no later start takes it for whole.
  it('deletes a replaced copy marker first: a delete that is cut short leaves it unmarked', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b200')
    copy(`${liveDir(rootPath)}.old`, 'b150')
    seams.rmRefuses = (p) => p === `${liveDir(rootPath)}.old`
    await recover(rootPath, manifestsDir)
    expect(summary(`${liveDir(rootPath)}.old`)).toBe('engine b150|-')
    expect(summary(liveDir(rootPath))).toBe('engine b200|b200')
  })

  it('a start rename that is refused leaves the layout no worse: the old copy comes back when the new one cannot', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(`${liveDir(rootPath)}.old`, 'b150')
    copy(`${liveDir(rootPath)}.new`, 'b200')
    seams.renameSyncRefuses = (from) => (from === `${liveDir(rootPath)}.new` ? 'EPERM' : null)
    await recover(rootPath, manifestsDir)
    expect(summary(liveDir(rootPath))).toBe('engine b150|b150')
    // The refused new copy stays for the next start, which finds the install complete and drops it.
    expect(summary(`${liveDir(rootPath)}.new`)).toBe('engine b200|b200')
  })
})

// ---- The swap inside a job ----------------------------------------------------------------------

/** An extractor that writes the new program into the folder it is given (the net's: `<os>/cpu.new`). */
const newEngine: ExtractFn = async (_archive, destDir) => {
  await writeFile(join(destDir, BIN), /[\\/]cpu\.new$/.test(destDir) ? 'net b200' : 'engine b200')
}

/** A manager whose download serves `archive`; `extract: 'os-tar'` runs the real `extractWithTar`. */
function manager(opts: { extract?: ExtractFn | 'os-tar'; archive?: Buffer } = {}): EngineDownloadManager {
  const archive = opts.archive ?? BODY
  const fetchImpl = (async () =>
    new Response(new Uint8Array(archive), {
      status: 200,
      headers: { 'content-length': String(archive.length) }
    })) as unknown as FetchFn
  if (opts.extract === 'os-tar') return new EngineDownloadManager({ fetchImpl })
  return new EngineDownloadManager({ fetchImpl, extractImpl: opts.extract ?? newEngine })
}

/** The job's end once its run, and the background deletes it queued, have settled. */
async function settle(mgr: EngineDownloadManager, jobId: string): Promise<EngineDownloadJob> {
  const job = await runToEnd(mgr, jobId)
  await vi.waitFor(() => expect(mgr.activeJob()).toBeNull(), { timeout: hangBudgetMs(5000) })
  await engineFolderDeletesSettled()
  return job
}

const update = { families: ['llama_cpp' as const], update: true as const }

describe('the staged swap in an engine job (#986)', () => {
  // #986 gap 1: the `cpu/` net lives inside the main folder; the main build's swap must not lose it.
  it('an update swaps the new copy in, carries the cpu/ net over and deletes the replaced copy after the job', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    net(netDir(rootPath), 'b200') // current: only the main build is updated
    // W-67 / lens F CE-F1: the new copy carries its marker before anything moves, so a kill after the
    // first rename leaves a copy the start can trust.
    const atFirstRename: string[] = []
    seams.onRename = (from) => {
      if (from === liveDir(rootPath)) atFirstRename.push(summary(`${liveDir(rootPath)}.new`))
    }
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(atFirstRename).toEqual(['engine b200|b200'])
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT })
  })

  it('a stale .new and .old an earlier session left go before the swap, which then goes through', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    copy(`${liveDir(rootPath)}.new`, 'b100', { marker: false })
    writeFileSync(join(`${liveDir(rootPath)}.new`, 'stale.dll'), 'from an older build')
    copy(`${liveDir(rootPath)}.old`, 'b100')
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
    // Two builds never mix: nothing of the stale staging folder reached the install.
    expect(existsSync(join(liveDir(rootPath), 'stale.dll'))).toBe(false)
  })

  it('a stale .old that cannot be deleted fails the job before the install folder is touched', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    copy(`${liveDir(rootPath)}.old`, 'b100')
    seams.rmRefuses = (p) => p === `${liveDir(rootPath)}.old`
    const before = fingerprintTree(liveDir(rootPath))
    const mgr = manager()
    const ends: EngineJobEnd[] = []
    mgr.onSettled((_job, end) => ends.push(end))
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    const job = await settle(mgr, started.jobId)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.filesInUse') })
    expect(ends.map((e) => e.reason)).toEqual(['filesInUse'])
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(summary(`${liveDir(rootPath)}.new`)).toBe('absent')
  })

  it.runIf(process.platform === 'win32')(
    'on Windows, a held handle on the new copy is waited out and the swap goes through',
    async () => {
      const { rootPath, manifestsDir } = makeDrive()
      copy(liveDir(rootPath), 'b150')
      let refusals = 3
      seams.renameRefuses = (from) => (from === `${liveDir(rootPath)}.new` && refusals-- > 0 ? 'EPERM' : null)
      const mgr = manager()
      const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
      expect((await settle(mgr, started.jobId)).status).toBe('done')
      expect(refusals).toBe(-1)
      expect(summary(liveDir(rootPath))).toBe('engine b200|b200')
    }
  )

  it('a new copy that cannot be moved in puts the installed copy back: files in use, the old engine as it was', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    net(netDir(rootPath), 'b200') // current: a one-step job, so no archive passes through `cpu/`
    const before = fingerprintTree(liveDir(rootPath))
    seams.renameRefuses = (from) => (from === `${liveDir(rootPath)}.new` ? 'EPERM' : null)
    const mgr = manager()
    const ends: EngineJobEnd[] = []
    mgr.onSettled((_job, end) => ends.push(end))
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    const job = await settle(mgr, started.jobId)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.filesInUse') })
    expect(ends.map((e) => e.reason)).toEqual(['filesInUse'])
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(layout(rootPath)).toEqual({ live: 'engine b150|b150', net: 'net b200|b200', ...NOTHING_LEFT })
  })

  it('an install that cannot be moved aside is never touched', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    const before = fingerprintTree(liveDir(rootPath))
    seams.renameRefuses = (from, to) => (from === liveDir(rootPath) && to === `${liveDir(rootPath)}.old` ? 'EBUSY' : null)
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect(await settle(mgr, started.jobId)).toMatchObject({ status: 'failed', error: tMain('main.engine.filesInUse') })
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(layout(rootPath)).toEqual({ live: 'engine b150|b150', net: 'absent', ...NOTHING_LEFT })
  })

  it('when neither copy can be moved back, both stay, and the next start moves the new one in', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    seams.renameRefuses = (from) => (from === `${liveDir(rootPath)}.new` || from === `${liveDir(rootPath)}.old` ? 'EPERM' : null)
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect((await settle(mgr, started.jobId)).status).toBe('failed')
    expect(layout(rootPath)).toMatchObject({ live: 'absent', staging: 'engine b200|b200', previous: 'engine b150|b150' })
    seams.renameRefuses = null
    await recover(rootPath, manifestsDir)
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
  })

  // #986 changes #516's rule: a cancel is honoured until the swap's first rename. One that lands after
  // tar has finished, while the new copy is still being flattened, checked and marked, still stops it.
  it('a cancel that lands while the unpacked copy is still being checked is honoured: nothing is replaced', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    const before = fingerprintTree(liveDir(rootPath))
    const box: { mgr?: EngineDownloadManager; jobId?: string; cancelledAt?: string } = {}
    // The release nests the program one folder down, so the flatten moves it up: the cancel lands there.
    const nested: ExtractFn = async (_archive, destDir) => {
      mkdirSync(join(destDir, 'Release'))
      await writeFile(join(destDir, 'Release', BIN), 'engine b200')
    }
    seams.onRename = (from) => {
      if (from.endsWith(join('Release', BIN)) && box.jobId) box.cancelledAt = box.mgr!.cancel(box.jobId).status
    }
    box.mgr = manager({ extract: nested })
    const started = await box.mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    box.jobId = started.jobId
    const job = await settle(box.mgr, started.jobId)
    expect(box.cancelledAt).toBe('cancelled')
    expect(job.status).toBe('cancelled')
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(layout(rootPath)).toEqual({ live: 'engine b150|b150', net: 'absent', ...NOTHING_LEFT })
  })

  // …and a cancel after the first rename arrives too late.
  it('a cancel that lands during the swap is too late: the step finishes', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    const box: { mgr?: EngineDownloadManager; jobId?: string; cancelledAt?: string } = {}
    seams.onRename = (from) => {
      if (from === liveDir(rootPath) && box.jobId) {
        box.cancelledAt = box.mgr!.cancel(box.jobId).status
      }
    }
    box.mgr = manager()
    const started = await box.mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    box.jobId = started.jobId
    await vi.waitFor(() => expect(box.mgr!.activeJob()).toBeNull(), { timeout: hangBudgetMs(5000) })
    await engineFolderDeletesSettled()
    // The cancel really landed, on the first rename of the swap, and the job took it.
    expect(box.cancelledAt).toBe('cancelled')
    expect(box.mgr.get(started.jobId).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
  })

})

// #856 + #986: the real default extractor, through the OS's own tar, unpacking in the staging folder
// beside an install under a non-ASCII folder name: the archive is moved in, tar gets `./<name>`.
const OS_TAR = resolveTarBinary()
describe.skipIf(!isAbsolute(OS_TAR))('the staged swap with the OS tar (#856, #986)', () => {
  it('an update unpacks the real archive in .new and swaps it over the installed copy', async () => {
    const top = { name: BIN, data: Buffer.from('engine b200 from tar') }
    const nested = { name: 'Release/ggml.txt', data: Buffer.from('nested file') }
    const archive =
      process.platform === 'win32' ? makeZip([top, nested]) : makeTarGz([top, { name: 'Release/', dir: true }, nested])
    const { rootPath, manifestsDir } = makeDrive(archive, 'Олена 日本')
    copy(liveDir(rootPath), 'b150')
    writeFileSync(join(liveDir(rootPath), 'old-only.dll'), 'a file the new build no longer ships')
    // What tar left in `.new` by the time the swap began: the whole new copy, marked.
    const staged: string[] = []
    seams.onRename = (from) => {
      if (from === liveDir(rootPath)) staged.push(summary(`${liveDir(rootPath)}.new`))
    }
    const mgr = manager({ archive, extract: 'os-tar' })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(staged).toEqual(['engine b200 from tar|b200'])
    expect(readFileSync(join(liveDir(rootPath), BIN), 'utf8')).toBe('engine b200 from tar')
    expect(readFileSync(join(liveDir(rootPath), 'Release', 'ggml.txt'), 'utf8')).toBe('nested file')
    // Two builds never mix: what only the old copy had went with it.
    expect(existsSync(join(liveDir(rootPath), 'old-only.dll'))).toBe(false)
    expect(readdirSync(liveDir(rootPath)).filter((n) => n.endsWith('.zip') || n.endsWith('.tar.gz'))).toEqual([])
    expect(layout(rootPath)).toMatchObject({ live: 'engine b200 from tar|b200', ...NOTHING_LEFT })
    expect(engineStatus(rootPath, manifestsDir).engineVersions?.[0]).toMatchObject({ installed: 'b200', relation: 'current' })
  })
})
