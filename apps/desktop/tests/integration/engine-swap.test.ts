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
  rmWaits: null as ((path: string) => Promise<void> | null) | null,
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
      const wait = seams.rmWaits?.(String(args[0]))
      if (wait) await wait
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { stringify } from 'yaml'
import {
  EngineDownloadManager,
  engineFolderDeletesSettled,
  engineStatus,
  extractWithTar,
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
import { makeSizeOnlyZip, makeTarGz, makeZip } from '../helpers/archives'
import { runToEnd } from '../helpers/download-fixtures'
import { hangBudgetMs } from '../helpers/hang-budget'
import { fingerprintTree } from '../helpers/read-only-witness'
import { initBinaryVerification, verifyBinaryBeforeSpawn } from '../../src/main/services/binary-verifier'
import { allowReading, denyReading, verifierInert } from '../helpers/binary-fixtures'
import { engineSpawnsHeld } from '../../src/main/services/runtime/spawn-gate'

afterEach(() => {
  seams.renameRefuses = null
  seams.renameSyncRefuses = null
  seams.rmRefuses = null
  seams.rmWaits = null
  seams.onRename = null
})

const HOST_OS = hostRuntimeOs()
const HOST_ARCH = hostRuntimeArch()
const BIN = llamaServerBinaryName()
const BODY = Buffer.from('engine-archive-bytes')
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const ALLOW = { policyAllows: true, settingAllows: true }

/** The pin: llama.cpp b200, a main build and its `cpu/` net inside it, both for this host. */
function makeDrive(
  archive: Buffer = BODY,
  folder = 'drive',
  opts: { mainRuntimeFiles?: string[] } = {}
): { rootPath: string; manifestsDir: string } {
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
          {
            ...build('vulkan', `runtime/llama.cpp/${HOST_OS}`, 'llama-main'),
            ...(opts.mainRuntimeFiles ? { runtime_files: opts.mainRuntimeFiles } : {})
          },
          build('cpu', `runtime/llama.cpp/${HOST_OS}/cpu`, 'llama-cpu')
        ]
      }
    })
  )
  return { rootPath, manifestsDir }
}

const liveDir = (root: string): string => join(root, 'runtime', 'llama.cpp', HOST_OS)
const netDir = (root: string): string => join(liveDir(root), 'cpu')

/**
 * An engine copy in `dir`: its program (content `<label> <version>`) and its marker, either left out. `records`
 * gives the marker a `binaries` map naming the program and these further files (written too, unless `exe`
 * is false for the program), as every install since #234 writes it.
 */
function copy(
  dir: string,
  version: string,
  opts: { label?: string; exe?: boolean; marker?: boolean; backend?: string; records?: string[] } = {}
): void {
  mkdirSync(dir, { recursive: true })
  if (opts.exe !== false) writeFileSync(join(dir, BIN), `${opts.label ?? 'engine'} ${version}`)
  for (const file of opts.records ?? []) writeFileSync(join(dir, file), `${file} ${version}`)
  if (opts.marker !== false) {
    const binaries = opts.records
      ? Object.fromEntries([BIN, ...opts.records].map((name) => [name, 'a'.repeat(64)]))
      : undefined
    writeRuntimeMarker(dir, {
      version,
      backend: opts.backend ?? 'vulkan',
      os: HOST_OS,
      arch: HOST_ARCH,
      ...(binaries ? { binaries } : {})
    })
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

/** Every downloaded archive left anywhere under the drive's `runtime/`, relative with `/`. */
function archivesUnder(root: string): string[] {
  const base = join(root, 'runtime')
  if (!existsSync(base)) return []
  return (readdirSync(base, { recursive: true }) as string[])
    .map((p) => p.split(/[\\/]/).join('/'))
    .filter((p) => p.endsWith('.zip') || p.endsWith('.tar.gz'))
    .sort()
}

async function recover(root: string, manifestsDir: string): Promise<void> {
  recoverEngineSwaps(root, manifestsDir)
  await engineFolderDeletesSettled()
}

/**
 * T8.5c: every entry under `dir` by its path relative to it (`/`), each file by the SHA-256 of its bytes, each
 * folder as `dir`; `{}` when `dir` is not there. Two equal answers mean the tree is byte-identical.
 */
function contentDigest(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {}
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name)
    const rel = full.slice(dir.length + 1).split(/[\\/]/).join('/')
    out[rel] = entry.isDirectory() ? 'dir' : sha256(readFileSync(full))
  }
  return out
}

// ---- The start recovery: one disk layout per place a kill can land -------------------------------

interface CrashLayout {
  name: string
  build: (root: string) => void
  expected: Record<string, string>
  /** The pin, when the row needs another one (a pin that requires one more file). */
  drive?: { mainRuntimeFiles?: string[] }
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
    // #986 review: the spare name held an incomplete leftover, and the start gave up on every start.
    // It goes first now (marker first), then the move.
    name: 'a broken install beside a whole old copy and a partial new one',
    build: (root) => {
      mkdirSync(liveDir(root), { recursive: true })
      writeFileSync(join(liveDir(root), 'llama-main.zip'), 'a download the app never unpacked')
      copy(`${liveDir(root)}.new`, 'b200', { marker: false })
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
    },
    expected: { live: 'engine b150|b150', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    // The mirror case, with the only net in the incomplete leftover at the spare name: it is carried out first.
    name: 'a broken install beside a whole new copy and a partial old one that holds the net',
    build: (root) => {
      mkdirSync(liveDir(root), { recursive: true })
      copy(`${liveDir(root)}.new`, 'b200')
      copy(`${liveDir(root)}.old`, 'b150', { exe: false, marker: false })
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
    },
    expected: { live: 'engine b200|b200', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    // #986 review 2: the install folder in the way of two whole copies holds no engine, so it goes and the
    // new copy moves in. It used to be left, and every start and every job after it too.
    name: 'two whole copies beside an empty install folder',
    build: (root) => {
      mkdirSync(liveDir(root), { recursive: true })
      copy(`${liveDir(root)}.new`, 'b200')
      copy(`${liveDir(root)}.old`, 'b150')
    },
    expected: { live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT }
  },
  {
    // …and a net it holds goes into the copy that becomes the install first.
    name: 'two whole copies beside an install folder that holds only the net',
    build: (root) => {
      net(netDir(root), 'b150')
      copy(`${liveDir(root)}.new`, 'b200')
      copy(`${liveDir(root)}.old`, 'b150')
    },
    expected: { live: 'engine b200|b200', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    // #986 review 2: a net's own swap left unfinished inside the replaced copy (whole nets in cpu.new and
    // cpu.old) is finished there before the copy is deleted.
    name: 'a replaced copy holding an unfinished net swap, beside a whole new copy',
    build: (root) => {
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu.new'), 'b200')
      net(join(`${liveDir(root)}.old`, 'cpu.old'), 'b150')
      copy(`${liveDir(root)}.new`, 'b200')
    },
    expected: { live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT }
  },
  {
    // #986 review 2: each copy is judged by its OWN marker. The pin now requires one more file, which the
    // old b150 copy never had; it is still the whole copy to roll back to.
    name: 'a pin that adds a file: the old copy still rolls back',
    drive: { mainRuntimeFiles: ['newdep.dll'] },
    build: (root) => {
      copy(`${liveDir(root)}.old`, 'b150', { records: [] })
      copy(`${liveDir(root)}.new`, 'b200', { records: ['newdep.dll'], exe: false })
    },
    expected: { live: 'engine b150|b150', net: 'absent', ...NOTHING_LEFT }
  },
  {
    name: 'a pin that adds a file: an update killed before its first rename keeps the old engine',
    drive: { mainRuntimeFiles: ['newdep.dll'] },
    build: (root) => {
      copy(liveDir(root), 'b150', { records: [] })
      copy(`${liveDir(root)}.new`, 'b200', { records: ['newdep.dll'] })
    },
    expected: { live: 'engine b150|b150', net: 'absent', ...NOTHING_LEFT }
  },
  {
    // #986 review 2: an empty cpu/ in the install used to shadow the only net in .old, which then went.
    name: 'an empty cpu/ in the install beside the only net in the replaced copy',
    build: (root) => {
      copy(liveDir(root), 'b200')
      mkdirSync(netDir(root))
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
    },
    expected: { live: 'engine b200|b200', net: 'net b150|b150', ...NOTHING_LEFT }
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
  it.each(CRASH_LAYOUTS)('$name', async ({ build, expected, drive }) => {
    const { rootPath, manifestsDir } = makeDrive(BODY, 'drive', drive)
    build(rootPath)
    await recover(rootPath, manifestsDir)
    expect(layout(rootPath)).toEqual(expected)
    expect(archivesUnder(rootPath)).toEqual([])
  })

  // #986 review: what the start could not do (a refused move or delete) is a warning; what it did, information.
  it('reports what it could not do as a warning, and what it did as information', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(`${liveDir(rootPath)}.old`, 'b150')
    copy(`${liveDir(rootPath)}.new`, 'b200')
    seams.renameSyncRefuses = (from) => (from === `${liveDir(rootPath)}.new` ? 'EPERM' : null)
    const info: string[] = []
    const warn: string[] = []
    recoverEngineSwaps(rootPath, manifestsDir, { log: (m) => info.push(m), warn: (m) => warn.push(m) })
    await engineFolderDeletesSettled()
    expect(warn).toEqual(['Engine swap recovery: a folder could not be moved; left as it is'])
    expect(info).toEqual([])
    seams.renameSyncRefuses = null
    copy(`${liveDir(rootPath)}.old`, 'b100')
    seams.rmRefuses = (p) => p === `${liveDir(rootPath)}.old`
    recoverEngineSwaps(rootPath, manifestsDir, { log: (m) => info.push(m), warn: (m) => warn.push(m) })
    await engineFolderDeletesSettled()
    expect(info).toEqual(['Engine swap recovery: the install is complete; its leftovers are deleted'])
    expect(warn.slice(1)).toEqual(['Could not remove an engine folder'])
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

// T8.5c (R2 M-1 = R1 F-5): a marker the start cannot read just now (an antivirus holding it, a denied read) is no
// verdict, as at the pre-spawn check (#1012 round 6): the family's folders stay exactly as they are for this start,
// and the next start decides. It read as "no marker", so the start deleted the only whole copy, rolled an update
// back or replaced a whole `cpu/` net on it. The hold is real (`denyReading`: a deny-read ACL on Windows, mode 000
// elsewhere); `stat` still answers, the read fails.
interface HeldLayout {
  name: string
  build: (root: string) => void
  /** The copy whose marker is held. */
  held: (root: string) => string
  /** `recoverEngineSwaps`' label for it, relative to the family folder. */
  label: string
  /** What the next start, with the marker readable again, makes of the layout. */
  healed: Record<string, string>
}
const HELD_LAYOUTS: HeldLayout[] = [
  {
    name: 'a first install killed between its renames: the only whole copy is in .new',
    build: (root) => {
      mkdirSync(`${liveDir(root)}.old`, { recursive: true })
      copy(`${liveDir(root)}.new`, 'b200')
    },
    held: (root) => `${liveDir(root)}.new`,
    label: `${HOST_OS}.new`,
    healed: { live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT }
  },
  {
    name: 'an update killed between its renames whose new program was taken since: the only whole copy is in .old',
    build: (root) => {
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
      copy(`${liveDir(root)}.new`, 'b200', { exe: false })
    },
    held: (root) => `${liveDir(root)}.old`,
    label: `${HOST_OS}.old`,
    healed: { live: 'engine b150|b150', net: 'net b150|b150', ...NOTHING_LEFT }
  },
  {
    name: 'an update killed before its cleanup: the new install beside a whole .old',
    build: (root) => {
      copy(liveDir(root), 'b200')
      net(netDir(root), 'b200')
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
    },
    held: (root) => liveDir(root),
    label: HOST_OS,
    healed: { live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT }
  },
  {
    name: 'the same layout with the install’s own cpu/ net held: the net in .old would replace it',
    build: (root) => {
      copy(liveDir(root), 'b200')
      net(netDir(root), 'b200')
      copy(`${liveDir(root)}.old`, 'b150')
      net(join(`${liveDir(root)}.old`, 'cpu'), 'b150')
    },
    held: (root) => netDir(root),
    label: `${HOST_OS}/cpu`,
    healed: { live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT }
  },
  {
    name: 'the cpu/ net’s own swap killed between its renames, the new net in cpu.new',
    build: (root) => {
      copy(liveDir(root), 'b200')
      net(join(liveDir(root), 'cpu.old'), 'b150')
      net(join(liveDir(root), 'cpu.new'), 'b200')
    },
    held: (root) => join(liveDir(root), 'cpu.new'),
    label: `${HOST_OS}/cpu.new`,
    healed: { live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT }
  }
]

describe('recoverEngineSwaps: a marker it cannot read just now leaves the layout as it is (T8.5c)', () => {
  it.each(HELD_LAYOUTS)('$name', async ({ build, held, label, healed }) => {
    const { rootPath, manifestsDir } = makeDrive()
    build(rootPath)
    const runtime = join(rootPath, 'runtime')
    const before = contentDigest(runtime)
    const marker = runtimeMarkerPath(held(rootPath))
    const warn: Array<[string, unknown]> = []
    const info: string[] = []
    denyReading(marker)
    try {
      recoverEngineSwaps(rootPath, manifestsDir, { log: (m) => info.push(m), warn: (m, meta) => warn.push([m, meta]) })
      await engineFolderDeletesSettled()
    } finally {
      allowReading(marker)
    }
    expect(contentDigest(runtime)).toEqual(before)
    expect(info).toEqual([])
    // Content-free: the family, the copy's folder by its layout name, the error's code; never a path or a message.
    expect(warn).toEqual([
      [
        'Engine swap recovery: a marker could not be read just now; this family is left as it is',
        { family: 'llama_cpp', marker: label, code: expect.stringMatching(/^(EPERM|EACCES)$/) }
      ]
    ])
    // Readable again, the next start decides as it always did.
    await recover(rootPath, manifestsDir)
    expect(layout(rootPath)).toEqual(healed)
  })

  // …and an engine job's own recovery and its leftover guard read the same: the family is refused as files in use
  // with the copies left as they are. The job used to roll an update back and install the pin over it, or delete the
  // only whole copy as a stale `.new` and download it again.
  it.each([
    {
      name: 'the new install beside a whole .old, its marker held: a reinstall',
      build: (root: string) => {
        copy(liveDir(root), 'b200')
        copy(`${liveDir(root)}.old`, 'b150')
      },
      held: liveDir,
      request: { families: ['llama_cpp' as const], reinstall: true as const },
      // The whole family: the archive the job downloads into the install folder goes again.
      kept: (root: string) => [join(root, 'runtime')]
    },
    {
      name: 'the only whole copy in .new, its marker held: a first install',
      build: (root: string) => {
        mkdirSync(`${liveDir(root)}.old`, { recursive: true })
        copy(`${liveDir(root)}.new`, 'b200')
      },
      held: (root: string) => `${liveDir(root)}.new`,
      request: {},
      // The download makes the install folder (`fetchArchive`), so the leftovers are compared.
      kept: (root: string) => [`${liveDir(root)}.new`, `${liveDir(root)}.old`]
    }
  ])('an engine job over $name leaves the copies as they are and fails as files in use', async ({ build, held, request, kept }) => {
    const { rootPath, manifestsDir } = makeDrive()
    build(rootPath)
    const before = kept(rootPath).map(contentDigest)
    const marker = runtimeMarkerPath(held(rootPath))
    const mgr = manager()
    const ends: EngineJobEnd[] = []
    mgr.onSettled((_job, end) => ends.push(end))
    denyReading(marker)
    let job: EngineDownloadJob
    try {
      const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...request })
      job = await settle(mgr, started.jobId)
    } finally {
      allowReading(marker)
    }
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.filesInUse') })
    expect(ends.map((e) => e.reason)).toEqual(['filesInUse'])
    expect(kept(rootPath).map(contentDigest)).toEqual(before)
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

/**
 * How a swap's refused rename ends (#986 review 3): a held handle on Windows is "files in use"; on macOS and
 * Linux the same codes mean a real refusal, which ends as the install error it is.
 */
const heldEnd =
  process.platform === 'win32'
    ? { reason: 'filesInUse', matches: (error: string | null) => error === tMain('main.engine.filesInUse') }
    : { reason: 'install', matches: (error: string | null) => error !== null && error !== tMain('main.engine.filesInUse') }

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

  // #1000: the spawn gate covers exactly what it protects, the renames. It used to be held from before the
  // unpack, so a wedged tar or a slow stick held every spawn of the family for as long.
  it('the gate is held from the pause to the last swap only: open while the copies unpack, closed at every rename', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    net(netDir(rootPath), 'b150')
    const seen: string[] = []
    const held = (): string => (engineSpawnsHeld('llama_cpp') ? 'held' : 'open')
    const extract: ExtractFn = async (archive, destDir, signal) => {
      seen.push(`unpack ${held()}`)
      await newEngine(archive, destDir, signal)
    }
    seams.onRename = (from) => {
      // The swaps' renames and the carry, never the archives' moves into the staging folders.
      if (!from.endsWith('.zip')) seen.push(`rename ${held()}`)
    }
    const mgr = manager({ extract })
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: ALLOW,
      ...update,
      beforeReplace: async () => {
        seen.push(`pause ${held()}`)
      }
    })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    seen.push(`after ${held()}`)
    // Two unpacks, the pause, the net's two renames, the main build's two renames and its carry.
    expect(seen).toEqual([
      'unpack open',
      'unpack open',
      'pause held',
      'rename held',
      'rename held',
      'rename held',
      'rename held',
      'rename held',
      'after open'
    ])
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT })
  })

  // #998 round 1: a job whose main build cannot be unpacked leaves its family as it was, and the net it already
  // staged (`<os>/cpu.new`, whole and marked) is deleted in the background. Before round 1 the next job's
  // recovery ran before those deletes: over a broken net it moved that copy in, without the gate or the
  // pause, while its delete still waited in the queue. Now a job waits for the queued deletes first, and a
  // copy that is not swapped in loses its marker at once.
  const reinstallBoth = {
    families: ['llama_cpp' as const],
    reinstall: true as const,
    reinstallBuilds: { llama_cpp: { main: true, cpuNet: true } }
  }
  /** A manager whose main-build unpack fails while `failMain.on`, logging to `logs`. */
  function failingMainManager(failMain: { on: boolean }, logs: string[], root: string): EngineDownloadManager {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(BODY), { status: 200, headers: { 'content-length': String(BODY.length) } })) as unknown as FetchFn
    return new EngineDownloadManager({
      fetchImpl,
      log: (m) => logs.push(m),
      extractImpl: async (archive, destDir, signal) => {
        if (failMain.on && destDir === `${liveDir(root)}.new`) throw new Error('tar exited with code 1')
        await newEngine(archive, destDir, signal)
      }
    })
  }

  it('a job waits for the deletes an earlier job queued before its own recovery runs (#998 round 1)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b200')
    net(netDir(rootPath), 'b150', { exe: false }) // a broken net: the reason for the reinstall
    const stagedNet = join(liveDir(rootPath), 'cpu.new')
    let release: () => void = () => undefined
    const held = new Promise<void>((r) => (release = r))
    seams.rmWaits = (p) => (p === stagedNet ? held : null)
    const failMain = { on: true }
    const logs: string[] = []
    const mgr = failingMainManager(failMain, logs, rootPath)
    const first = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...reinstallBoth })
    expect((await runToEnd(mgr, first.jobId)).status).toBe('failed')
    await vi.waitFor(() => expect(mgr.activeJob()).toBeNull(), { timeout: hangBudgetMs(5000) })
    // The staged net's delete is still in the queue; the retry starts now.
    failMain.on = false
    const second = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...reinstallBoth })
    expect(logs.filter((m) => m.startsWith('Engine swap recovery'))).toEqual([])
    release()
    expect((await settle(mgr, second.jobId)).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT })
  })

  it('a staged copy that is not swapped in is un-marked at once: a refused delete leaves no copy to roll in (#998 round 1)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b200')
    net(netDir(rootPath), 'b150', { exe: false })
    const stagedNet = join(liveDir(rootPath), 'cpu.new')
    seams.rmRefuses = (p) => p === stagedNet || p === runtimeMarkerPath(stagedNet)
    const mgr = failingMainManager({ on: true }, [], rootPath)
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...reinstallBoth })
    expect((await settle(mgr, started.jobId)).status).toBe('failed')
    // The delete was refused: the copy is still there, but no longer marked.
    expect(summary(stagedNet)).toBe('net b200|-')
    seams.rmRefuses = null
    await recover(rootPath, manifestsDir)
    // So nothing completes the swap the job decided against: the broken net stays for the next repair.
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: '-|b150', ...NOTHING_LEFT })
  })

  // #1000: every step's leftovers are judged before any step stages. A reinstall of both builds over a net
  // whose program is gone (#678's "re-fetched all the same") stages its new net in `<os>/cpu.new` first; judged
  // after that, the main build's guard took the job's own staged net for a leftover and stopped the job.
  it('a reinstall of both builds over an incomplete cpu/ net: the net the job staged is never taken for a leftover (#1000)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b200')
    net(netDir(rootPath), 'b150', { exe: false })
    const mgr = manager()
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: ALLOW,
      families: ['llama_cpp'],
      reinstall: true,
      reinstallBuilds: { llama_cpp: { main: true, cpuNet: true } }
    })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT })
  })

  // #998: the cpu/ net, and a net swap left inside an install, carry markers of their own. A main build's
  // marker never records them, even when its archive brings a folder of that name: the carry replaces it.
  it('a main copy whose archive brings its own cpu/ folder records none of it in its marker (#998)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    net(netDir(rootPath), 'b200')
    const withCpu: ExtractFn = async (archive, destDir, signal) => {
      await newEngine(archive, destDir, signal)
      mkdirSync(join(destDir, 'cpu'))
      await writeFile(join(destDir, 'cpu', 'stray.dll'), 'from the archive')
    }
    const mgr = manager({ extract: withCpu })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    const marker = JSON.parse(readFileSync(runtimeMarkerPath(liveDir(rootPath)), 'utf8')) as { binaries: Record<string, string> }
    expect(Object.keys(marker.binaries)).toEqual([BIN])
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT })
  })

  // #998: the check right before the swap reads the staged copy's own marker, so a DLL a scanner takes from
  // the fresh copy while the model pauses stops the step too, not only a missing program.
  it('a file the staged marker records that is gone at the swap fails the step and keeps the installed engine (#998)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    const before = fingerprintTree(liveDir(rootPath))
    const withDll: ExtractFn = async (archive, destDir, signal) => {
      await newEngine(archive, destDir, signal)
      await writeFile(join(destDir, 'ggml.dll'), 'ggml b200')
    }
    const mgr = manager({ extract: withDll })
    const ends: EngineJobEnd[] = []
    mgr.onSettled((_job, end) => ends.push(end))
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: ALLOW,
      ...update,
      beforeReplace: async () => {
        rmSync(join(`${liveDir(rootPath)}.new`, 'ggml.dll'))
      }
    })
    const job = await settle(mgr, started.jobId)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.binaryMissing') })
    expect(ends.map((e) => e.reason)).toEqual(['incomplete'])
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(layout(rootPath)).toEqual({ live: 'engine b150|b150', net: 'absent', ...NOTHING_LEFT })
  })

  it('a stale .new and .old an earlier session left go before the swap, which then goes through', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    copy(`${liveDir(rootPath)}.new`, 'b100', { marker: false })
    writeFileSync(join(`${liveDir(rootPath)}.new`, 'stale.dll'), 'from an older build')
    copy(`${liveDir(rootPath)}.old`, 'b100')
    // The first delete of the stale `.new` (in the background) is refused: the stage removes it itself.
    let staleDeletes = 0
    seams.rmRefuses = (p) => p === `${liveDir(rootPath)}.new` && staleDeletes++ === 0
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
    expect(job.status).toBe('failed')
    expect(heldEnd.matches(job.error)).toBe(true)
    expect(ends.map((e) => e.reason)).toEqual([heldEnd.reason])
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
    const refused = await settle(mgr, started.jobId)
    expect(refused.status).toBe('failed')
    expect(heldEnd.matches(refused.error)).toBe(true)
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

  // #986 review: the message after that keep-both end says "try again in a minute"; this is the retry.
  it('“try again” after a swap that kept both copies works: the next job in the session installs the new engine', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    seams.renameRefuses = (from) => (from === `${liveDir(rootPath)}.new` || from === `${liveDir(rootPath)}.old` ? 'EPERM' : null)
    const mgr = manager()
    const first = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    const refused = await settle(mgr, first.jobId)
    expect(refused.status).toBe('failed')
    expect(heldEnd.matches(refused.error)).toBe(true)
    expect(layout(rootPath)).toMatchObject({ live: 'absent', staging: 'engine b200|b200', previous: 'engine b150|b150' })
    seams.renameRefuses = null
    // The engine reads as missing now, so the screen offers the install.
    const again = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    expect((await settle(mgr, again.jobId)).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
    expect(archivesUnder(rootPath)).toEqual([])
  })

  // #986 review: a retry must never delete what the last attempt kept. It finishes that swap first, before
  // its own download, so even a retry that fails itself leaves the new engine installed.
  it('a retry after a swap that kept both copies finishes it first, even when the retry itself fails', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(`${liveDir(rootPath)}.new`, 'b200')
    copy(`${liveDir(rootPath)}.old`, 'b150')
    const mgr = manager({
      extract: async () => {
        throw new Error('tar exited with code 1')
      }
    })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['llama_cpp'] })
    expect((await settle(mgr, started.jobId)).status).toBe('failed')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
    expect(archivesUnder(rootPath)).toEqual([])
  })

  // #986 review: a carry refused in an earlier job left the only cpu/ net in `.old`. The next job carries it
  // in before anything else (it used to delete `.old` with the net as a stale leftover).
  it('a job after a refused carry carries the cpu/ net in first and keeps it', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b200')
    copy(`${liveDir(rootPath)}.old`, 'b150')
    net(join(`${liveDir(rootPath)}.old`, 'cpu'), 'b150')
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['llama_cpp'], reinstall: true })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b150|b150', ...NOTHING_LEFT })
  })

  it('…and when that carry is refused again, the job stops before it deletes the only net', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b200')
    copy(`${liveDir(rootPath)}.old`, 'b150')
    net(join(`${liveDir(rootPath)}.old`, 'cpu'), 'b150')
    const before = fingerprintTree(liveDir(rootPath))
    seams.renameSyncRefuses = (from) => (from === join(`${liveDir(rootPath)}.old`, 'cpu') ? 'EPERM' : null)
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['llama_cpp'], reinstall: true })
    expect(await settle(mgr, started.jobId)).toMatchObject({ status: 'failed', error: tMain('main.engine.filesInUse') })
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(summary(join(`${liveDir(rootPath)}.old`, 'cpu'))).toBe('net b150|b150')
    seams.renameSyncRefuses = null
    await recover(rootPath, manifestsDir)
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b150|b150', ...NOTHING_LEFT })
  })

  // #986 review 3: the job's own recovery moved the kept new copy in; the job then failed at its download.
  // The program at those paths is another one now: a verdict cached for the old one must not stand, and
  // the consumers (the re-arm, the probe refresh) must hear of it.
  it('a copy a job’s recovery moves in drops the cached verdicts and is told, even when the job then fails', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const live = liveDir(rootPath)
    const program = join(live, BIN)
    initBinaryVerification(false) // as packaged: verdicts are cached for the session
    try {
      // Earlier this session: a copy whose program does not match its marker, refused and cached.
      copy(live, 'b150', { records: [] })
      await expect(verifyBinaryBeforeSpawn(program)).resolves.toBe('mismatch')
      // Then a swap kept both copies: the install folder gone, the new copy whole and right in `.new`.
      renameSync(live, `${live}.old`)
      copy(`${live}.new`, 'b200')
      writeRuntimeMarker(`${live}.new`, {
        version: 'b200',
        backend: 'vulkan',
        os: HOST_OS,
        arch: HOST_ARCH,
        binaries: { [BIN]: sha256(Buffer.from('engine b200')) }
      })
      const mgr = new EngineDownloadManager({
        fetchImpl: (async () => {
          throw new TypeError('fetch failed')
        }) as unknown as FetchFn,
        extractImpl: newEngine
      })
      const told: Array<[string[], Partial<Record<string, string[]>>]> = []
      mgr.onInstalled((families, programs) => told.push([families, programs]))
      const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['llama_cpp'] })
      expect((await settle(mgr, started.jobId)).status).toBe('failed')
      expect(summary(live)).toBe('engine b200|b200')
      await expect(verifyBinaryBeforeSpawn(program)).resolves.toBe('ok')
      expect(told).toEqual([[['llama_cpp'], { llama_cpp: [program] }]])
    } finally {
      verifierInert()
    }
  })

  // #986 review 2: two whole copies beside an empty install folder (a refused recovery rename, then a job's
  // download made the folder) used to fail every job `filesInUse` and every start left them.
  it('a job over two whole copies beside an empty install folder installs the engine', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    mkdirSync(liveDir(rootPath), { recursive: true })
    copy(`${liveDir(rootPath)}.new`, 'b200')
    copy(`${liveDir(rootPath)}.old`, 'b150')
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
  })

  // #986 review 2: the net's OWN swap ended keep-both, so there is no `<os>/cpu/`, and the retry plans the main
  // build alone. Its swap would have moved both whole nets away with the old copy and deleted them.
  it('a retry that plans the main build alone first finishes the net’s unfinished swap and keeps the net', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    net(join(liveDir(rootPath), 'cpu.new'), 'b200')
    net(join(liveDir(rootPath), 'cpu.old'), 'b150')
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect(mgr.jobPreview(started.jobId)?.items.map((i) => i.safetyNet)).toEqual([false])
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT })
  })

  it('…and when that net swap cannot be finished, the job stops before it moves the nets away', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    net(join(liveDir(rootPath), 'cpu.new'), 'b200')
    net(join(liveDir(rootPath), 'cpu.old'), 'b150')
    const before = fingerprintTree(liveDir(rootPath))
    const held = [join(liveDir(rootPath), 'cpu.new'), join(liveDir(rootPath), 'cpu.old')]
    seams.renameSyncRefuses = (from) => (held.includes(from) ? 'EPERM' : null)
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect(await settle(mgr, started.jobId)).toMatchObject({ status: 'failed', error: tMain('main.engine.filesInUse') })
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
  })

  // #986 review: the cpu/ net's archive downloads into `<os>/cpu/`. With the main build first, its swap moved
  // that archive into `.old/cpu/`, and a refused carry left the net step without it and the archive inside
  // `cpu/` for good. The net goes first now; the main build's carry takes the NEW net across.
  it('an update of both builds whose carry is refused loses no net and strands no archive', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    net(netDir(rootPath), 'b150')
    seams.renameRefuses = (from) => (from === join(`${liveDir(rootPath)}.old`, 'cpu') ? 'EPERM' : null)
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    // The new net waits in the replaced copy, which is kept for the carry.
    expect(summary(join(`${liveDir(rootPath)}.old`, 'cpu'))).toBe('net b200|b200')
    expect(archivesUnder(rootPath)).toEqual([])
    seams.renameRefuses = null
    await recover(rootPath, manifestsDir)
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT })
    expect(archivesUnder(rootPath)).toEqual([])
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

  it('a first install, with a cpu/ net pinned, installs the main build alone and leaves no archive', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const mgr = manager()
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
    expect(archivesUnder(rootPath)).toEqual([])
  })

  it('a reinstall of the cpu/ net alone swaps it inside the install and leaves the main build as it was', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b200')
    net(netDir(rootPath), 'b150')
    const mainBefore = readFileSync(join(liveDir(rootPath), BIN), 'utf8')
    const mgr = manager()
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: ALLOW,
      families: ['llama_cpp'],
      reinstall: true,
      reinstallBuilds: { llama_cpp: { main: false, cpuNet: true } }
    })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(readFileSync(join(liveDir(rootPath), BIN), 'utf8')).toBe(mainBefore)
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'net b200|b200', ...NOTHING_LEFT })
    expect(archivesUnder(rootPath)).toEqual([])
  })

  // #986 review: a cancel that lands while the swap deletes a stale `.old` is honoured: the signal is
  // checked again right before the first rename.
  it('a cancel that lands while a stale .old is deleted, just before the swap, is honoured', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    copy(`${liveDir(rootPath)}.old`, 'b100')
    const before = fingerprintTree(liveDir(rootPath))
    const box: { mgr?: EngineDownloadManager; jobId?: string; cancelledAt?: string } = {}
    seams.rmRefuses = (p) => {
      if (p !== `${liveDir(rootPath)}.old`) return false
      // A delete before phase 2 (the job's own recovery queues one) is refused; the swap's own meets the cancel.
      if (!box.jobId || box.mgr!.get(box.jobId).status !== 'extracting') return true
      box.cancelledAt = box.mgr!.cancel(box.jobId).status
      return false
    }
    box.mgr = manager()
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
    // The cancel really landed, on the first rename of the swap, and was too late: the status never
    // read 'cancelled' (#986 review 3: it used to, and then flipped to 'done').
    expect(box.cancelledAt).toBe('extracting')
    expect(box.mgr.get(started.jobId).status).toBe('done')
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
  })

  // #986 review 3: a cancel during the swap's SECOND rename: the job's status never reads 'cancelled', the
  // job ends 'done', and its audit record has no cancel in it.
  it('a cancel during the swap’s second rename never shows the job cancelled, and it ends done', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    const box: { mgr?: EngineDownloadManager; jobId?: string } = {}
    const seen: string[] = []
    seams.onRename = (from) => {
      if (from === `${liveDir(rootPath)}.new` && box.jobId) {
        seen.push(box.mgr!.cancel(box.jobId).status, box.mgr!.get(box.jobId).status)
      }
    }
    box.mgr = manager()
    const ends: EngineJobEnd[] = []
    box.mgr.onSettled((_job, end) => ends.push(end))
    const started = await box.mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    box.jobId = started.jobId
    const job = await settle(box.mgr, started.jobId)
    expect(seen).toEqual(['extracting', 'extracting'])
    expect(job.status).toBe('done')
    expect(ends.map((e) => e.reason)).toEqual([null])
    expect(layout(rootPath)).toEqual({ live: 'engine b200|b200', net: 'absent', ...NOTHING_LEFT })
  })

  // #986 review 3: a cancel that lands while a swap ends keep-both must not hide it: the install folder is
  // gone for the moment, and "Cancelled" would say nothing happened.
  it('a cancel during a swap that ends keeping both copies reports that end, not a cancel', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    const box: { mgr?: EngineDownloadManager; jobId?: string; cancelledAt?: string } = {}
    seams.onRename = (from) => {
      if (from === `${liveDir(rootPath)}.new` && box.jobId && !box.cancelledAt) box.cancelledAt = box.mgr!.cancel(box.jobId).status
    }
    seams.renameRefuses = (from) => (from === `${liveDir(rootPath)}.new` || from === `${liveDir(rootPath)}.old` ? 'EPERM' : null)
    box.mgr = manager()
    const ends: EngineJobEnd[] = []
    box.mgr.onSettled((_job, end) => ends.push(end))
    const started = await box.mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    box.jobId = started.jobId
    const job = await settle(box.mgr, started.jobId)
    expect(job.status).toBe('failed')
    expect(heldEnd.matches(job.error)).toBe(true)
    expect(ends.map((e) => e.reason)).toEqual([heldEnd.reason])
    expect(layout(rootPath)).toMatchObject({ live: 'absent', staging: 'engine b200|b200', previous: 'engine b150|b150' })
  })

  // #986 review 3: only a held handle is "files in use". A drive that cannot be written fails as the install
  // error it is, with its own audit reason, and nothing is touched.
  it('a rename refused because the drive cannot be written is an install error, not files in use', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    copy(liveDir(rootPath), 'b150')
    const before = fingerprintTree(liveDir(rootPath))
    seams.renameRefuses = (from, to) => (from === liveDir(rootPath) && to === `${liveDir(rootPath)}.old` ? 'EROFS' : null)
    const mgr = manager()
    const ends: EngineJobEnd[] = []
    mgr.onSettled((_job, end) => ends.push(end))
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    const job = await settle(mgr, started.jobId)
    expect(job.status).toBe('failed')
    expect(job.error).not.toBe(tMain('main.engine.filesInUse'))
    expect(job.error).toContain('EROFS')
    expect(ends.map((e) => e.reason)).toEqual(['install'])
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(layout(rootPath)).toEqual({ live: 'engine b150|b150', net: 'absent', ...NOTHING_LEFT })
  })

  // #986: a full drive used to fail half-way through the extraction, after the old copy was deleted.
  it('a drive without room to unpack refuses with the figures before the pause, and nothing is touched', async () => {
    // A directory claiming 10,000 members of ~4.3 GB: more than any disk has free.
    const archive = makeSizeOnlyZip(10_000, 0xfffffffe)
    const { rootPath, manifestsDir } = makeDrive(archive)
    copy(liveDir(rootPath), 'b150')
    net(netDir(rootPath), 'b200')
    const before = fingerprintTree(liveDir(rootPath))
    let extracted = 0
    let paused = 0
    const mgr = manager({
      archive,
      extract: async () => {
        extracted++
      }
    })
    const ends: EngineJobEnd[] = []
    mgr.onSettled((_job, end) => ends.push(end))
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: ALLOW,
      ...update,
      beforeReplace: async () => {
        paused++
      }
    })
    const job = await settle(mgr, started.jobId)
    expect(job.status).toBe('failed')
    // The refusal names both figures: the copy around them is the catalog's, the needed one in GB.
    const [head, middle, tail] = tMain('main.engine.notEnoughSpace', { needed: '\u0000', free: '\u0000' }).split('\u0000')
    expect(job.error!.startsWith(head)).toBe(true)
    expect(job.error).toContain(middle)
    expect(job.error!.endsWith(tail)).toBe(true)
    expect(job.error!.slice(head.length, job.error!.indexOf(middle))).toMatch(/GB$/)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ reason: 'noSpace' })
    expect(ends[0].space!.neededBytes).toBeGreaterThan(10_000 * 0xfffffffe)
    expect(ends[0].space!.neededBytes).toBeGreaterThan(ends[0].space!.freeBytes)
    expect({ extracted, paused }).toEqual({ extracted: 0, paused: 0 })
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(layout(rootPath)).toEqual({ live: 'engine b150|b150', net: 'net b200|b200', ...NOTHING_LEFT })
  })
})

// T8.5c (R1 F-2): F-24 promises that this release never touches a later version's engine folders: its install lives
// beside this one as `<os>@<pin>/` (built in `<os>@<pin>.new/`), and an update file's engine archives wait in
// `updates/engines/<version>/`. The start's row above holds the start to it; these hold every kind of engine job:
// each such folder is byte-identical after the job and after the deletes it queued.
describe('an engine job leaves a later version’s engine folders as they are (T8.5c)', () => {
  /** The folders a later version owns, filled as it fills them: a marked pin folder with its net, a half-built one. */
  function laterVersion(root: string): string[] {
    const pin = `${liveDir(root)}@b300`
    copy(pin, 'b300', { records: ['ggml.dll'] })
    net(join(pin, 'cpu'), 'b300')
    copy(`${pin}.new`, 'b300', { marker: false })
    const engines = join(root, 'updates', 'engines', '0.2.0')
    mkdirSync(engines, { recursive: true })
    writeFileSync(join(engines, `llama-b300-bin-${HOST_OS}-vulkan-${HOST_ARCH}.zip`), 'a staged engine archive')
    return [pin, `${pin}.new`, join(root, 'updates', 'engines')]
  }

  /** An extractor that cancels its own job, then writes the copy: the stage meets the cancel after the unpack. */
  const cancelling = (box: { mgr?: EngineDownloadManager; jobId?: string }): ExtractFn => async (archive, destDir, signal) => {
    box.mgr!.cancel(box.jobId!)
    await newEngine(archive, destDir, signal)
  }
  const failing: ExtractFn = async () => {
    throw new Error('tar exited with code 2')
  }
  const reinstallNet = {
    families: ['llama_cpp' as const],
    reinstall: true as const,
    reinstallBuilds: { llama_cpp: { main: false, cpuNet: true } }
  }

  it.each([
    { name: 'a first install', setup: () => undefined, request: {}, extract: 'new', end: 'done' },
    { name: 'an update', setup: (r: string) => copy(liveDir(r), 'b150'), request: update, extract: 'new', end: 'done' },
    {
      name: 'a reinstall of the main build',
      setup: (r: string) => copy(liveDir(r), 'b200'),
      request: { families: ['llama_cpp' as const], reinstall: true as const },
      extract: 'new',
      end: 'done'
    },
    {
      name: 'a reinstall of the cpu/ net alone',
      setup: (r: string) => {
        copy(liveDir(r), 'b200')
        net(netDir(r), 'b150')
      },
      request: reinstallNet,
      extract: 'new',
      end: 'done'
    },
    { name: 'an update whose unpack fails', setup: (r: string) => copy(liveDir(r), 'b150'), request: update, extract: 'fail', end: 'failed' },
    { name: 'a cancelled update', setup: (r: string) => copy(liveDir(r), 'b150'), request: update, extract: 'cancel', end: 'cancelled' }
  ])('$name', async ({ setup, request, extract, end }) => {
    const { rootPath, manifestsDir } = makeDrive()
    setup(rootPath)
    const later = laterVersion(rootPath)
    const before = later.map(contentDigest)
    const box: { mgr?: EngineDownloadManager; jobId?: string } = {}
    box.mgr = manager({ extract: extract === 'fail' ? failing : extract === 'cancel' ? cancelling(box) : newEngine })
    const started = await box.mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...request })
    box.jobId = started.jobId
    expect((await settle(box.mgr, started.jobId)).status).toBe(end)
    expect(later.map(contentDigest)).toEqual(before)
    expect(before.every((d) => Object.keys(d).length > 0)).toBe(true)
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

  /** The platform's release format holding `files` (name → content); a tar.gz lists each folder too. */
  function osArchive(files: Array<[string, string]>): Buffer {
    const entries = files.map(([name, data]) => ({ name, data: Buffer.from(data) }))
    if (process.platform === 'win32') return makeZip(entries)
    const folders = [...new Set(files.flatMap(([name]) => name.split('/').slice(0, -1).map((_, i, all) => `${all.slice(0, i + 1).join('/')}/`)))]
    return makeTarGz([...folders.map((name) => ({ name, dir: true as const })), ...entries])
  }

  // #998: tar's exit code is not a completeness signal. A scanner that takes a file tar just wrote, before
  // the copy is marked, went unseen: the copy was swapped in without it (a missing `ggml-vulkan.dll` then
  // runs on the CPU, missing CPU variants are blamed on the model). The archive's own list now decides.
  it('a member the archive lists that is gone after the extraction fails the step and keeps the installed engine (#998)', async () => {
    const archive = osArchive([
      [BIN, 'engine b200 from tar'],
      ['ggml.dll', 'ggml']
    ])
    const { rootPath, manifestsDir } = makeDrive(archive)
    copy(liveDir(rootPath), 'b150')
    const before = fingerprintTree(liveDir(rootPath))
    const scanned: ExtractFn = async (archivePath, destDir, signal, log) => {
      await extractWithTar(archivePath, destDir, signal, log)
      rmSync(join(destDir, 'ggml.dll'))
    }
    const mgr = manager({ archive, extract: scanned })
    const ends: EngineJobEnd[] = []
    mgr.onSettled((_job, end) => ends.push(end))
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    const job = await settle(mgr, started.jobId)
    expect(job).toMatchObject({ status: 'failed', error: tMain('main.engine.extractFailed') })
    expect(ends.map((e) => e.reason)).toEqual(['incomplete'])
    expect(fingerprintTree(liveDir(rootPath))).toEqual(before)
    expect(layout(rootPath)).toEqual({ live: 'engine b150|b150', net: 'absent', ...NOTHING_LEFT })
  })

  // …and the same check reads each member where the flatten put it, never expects a file the family leaves
  // out, and the marker records every file the copy holds.
  it('every member is checked where the flatten put it, and the marker records each file but the left-out llama-connect (#998, #729)', async () => {
    const connect = process.platform === 'win32' ? 'llama-connect.exe' : 'llama-connect'
    const release = 'llama-b200-bin'
    const files: Array<[string, string]> = [
      [`${release}/${BIN}`, 'engine b200 from tar'],
      [`${release}/ggml.dll`, 'ggml'],
      [`${release}/backends/ggml-cpu.dll`, 'cpu variant'],
      [`${release}/${connect}`, 'tunnel'],
      ['LICENSE', 'licence']
    ]
    const archive = osArchive(files)
    const { rootPath, manifestsDir } = makeDrive(archive)
    copy(liveDir(rootPath), 'b150')
    const mgr = manager({ archive, extract: 'os-tar' })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...update })
    expect((await settle(mgr, started.jobId)).status).toBe('done')
    expect(existsSync(join(liveDir(rootPath), connect))).toBe(false)
    const marker = JSON.parse(readFileSync(runtimeMarkerPath(liveDir(rootPath)), 'utf8')) as { binaries: Record<string, string> }
    expect(marker.binaries).toEqual({
      [BIN]: sha256(Buffer.from('engine b200 from tar')),
      'ggml.dll': sha256(Buffer.from('ggml')),
      'backends/ggml-cpu.dll': sha256(Buffer.from('cpu variant')),
      LICENSE: sha256(Buffer.from('licence'))
    })
    expect(layout(rootPath)).toMatchObject({ live: 'engine b200 from tar|b200', ...NOTHING_LEFT })
  })
})
