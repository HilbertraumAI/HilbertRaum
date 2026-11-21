import { describe, it, expect, vi, afterEach } from 'vitest'
// Same mock as engine-download.test.ts: the manager never touches electron; this only makes
// `registerEngineIpc.ts` (whose module top imports ipcMain) importable transitively.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
// A path the installer's clean-up cannot delete, the way an antivirus scan holds a fresh DLL (#986:
// the staging folder it sits in).
const seams = vi.hoisted(() => ({ rmRefuses: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const mocked = {
    ...orig,
    rm: async (...args: Parameters<typeof orig.rm>) => {
      if (seams.rmRefuses && String(args[0]).endsWith(seams.rmRefuses)) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return orig.rm(...args)
    }
  }
  return { ...mocked, default: mocked }
})
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import {
  EngineDownloadManager,
  assertExtractedSymlinksContained,
  engineFolderDeletesSettled,
  engineStatus,
  hostRuntimeArch,
  hostRuntimeOs,
  recoverEngineSwaps,
  type ExtractFn
} from '../../src/main/services/runtime-download'
import { llamaServerBinaryName } from '../../src/main/services/runtime/sidecar'
import { runtimeMarkerPath, writeRuntimeMarker } from '../../src/main/services/assets'
import { tMain } from '../../src/main/services/i18n'
import type { EngineDownloadJob } from '../../src/shared/types'
import { bodyFetch, runToEnd } from '../helpers/download-fixtures'
import { hangBudgetMs } from '../helpers/hang-budget'
import { fingerprintTree } from '../helpers/read-only-witness'

// SEC-2 (full-audit 2026-07-12): the in-app engine extractor relies on the OS tar's implicit
// refusal of `..` members; its residual soft spot was a SYMLINK member resolving outside the
// install dir. `install()` now sweeps the final extracted layout and refuses the install when
// any link escapes. These tests drive the sweep directly (crafted directory states — Windows
// junctions, which need no privilege, or posix symlinks) and once end-to-end through the
// manager with an injected escaping extractor.

afterEach(() => {
  seams.rmRefuses = null
})

/** Create a directory-flavored link that works unprivileged on every OS. */
function plantDirLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

// TQ-2 (full-audit 2026-07-12b): junctions always store ABSOLUTE targets, so the sweep's
// relative-target branch (`resolve(dirname(p), target)`) is only reachable via a true symlink
// with a relative stored target. On POSIX that is always creatable; on Windows a 'dir' symlink
// needs SeCreateSymbolicLinkPrivilege (admin or Developer Mode) — probe once and gate the
// relative-target tests on the result so they run wherever the OS allows (always on the
// Ubuntu CI leg) instead of failing with EPERM.
const canPlantRelativeLink = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'hr-contain-probe-'))
  try {
    symlinkSync(join('..', 'probe-target'), join(probe, 'probe-link'), 'dir')
    return true
  } catch (err) {
    // Only the missing Windows privilege may skip the rows: ENOSPC, EACCES and the like are real failures.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
    return false
  }
})()

// CODE-46's rule (ingestion.test.ts): a skip must be visible, and the Linux CI leg must really run the rows.
if (!canPlantRelativeLink) {
  console.warn(
    'engine-extract-containment.test: relative symlinks need Developer Mode/admin on Windows; ' +
      'the 2 TQ-2 relative-target rows are SKIPPED here.'
  )
}
it.runIf(Boolean(process.env.CI) && process.platform === 'linux')(
  'relative symlinks can be planted on Linux CI, so the TQ-2 rows actually run',
  () => {
    expect(canPlantRelativeLink).toBe(true)
  }
)

describe('assertExtractedSymlinksContained (SEC-2)', () => {
  it('passes a plain extracted tree (no links)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hr-contain-plain-'))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'llama-server'), 'binary')
    writeFileSync(join(root, 'sub', 'lib.so'), 'lib')
    await expect(assertExtractedSymlinksContained(root)).resolves.toBeUndefined()
  })

  it('passes a link that resolves INSIDE the install dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hr-contain-good-'))
    mkdirSync(join(root, 'sub'))
    plantDirLink(join(root, 'sub'), join(root, 'alias'))
    await expect(assertExtractedSymlinksContained(root)).resolves.toBeUndefined()
  })

  it('refuses a top-level link escaping to an outside directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hr-contain-esc-'))
    const outside = mkdtempSync(join(tmpdir(), 'hr-contain-outside-'))
    plantDirLink(outside, join(root, 'evil'))
    await expect(assertExtractedSymlinksContained(root)).rejects.toThrow(
      /escapes the install dir/
    )
  })

  it('refuses an escaping link buried in a NESTED directory (post-flatten leftovers)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hr-contain-nested-'))
    const outside = mkdtempSync(join(tmpdir(), 'hr-contain-outside2-'))
    mkdirSync(join(root, 'release', 'lib'), { recursive: true })
    writeFileSync(join(root, 'release', 'lib', 'ok.so'), 'lib')
    plantDirLink(outside, join(root, 'release', 'lib', 'evil'))
    await expect(assertExtractedSymlinksContained(root)).rejects.toThrow(
      /escapes the install dir/
    )
  })

  // `relative` returns a bare '..' here, not a `..<sep>`-led path: the one escape the prefix test
  // alone would miss. The link's parent is this row's own folder, never the shared tmpdir.
  it('refuses a link to the EXACT parent of the install dir', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hr-contain-parent-'))
    const root = join(parent, 'install')
    mkdirSync(root)
    plantDirLink(parent, join(root, 'up'))
    await expect(assertExtractedSymlinksContained(root)).rejects.toThrow(/escapes the install dir/)
  })

  // TQ-2 (full-audit 2026-07-12b): all tests above store ABSOLUTE targets to EXISTING dirs, so
  // the relative-target branch and the "broken link is still caught" claim in the sweep's
  // doc-comment were never exercised. The three tests below pin them: a relative `../..`-style
  // escape, a relative target that is legitimately contained (anchors the resolution to
  // `dirname(p)`, NOT the install root — resolving against the root would false-positive it),
  // and a DANGLING escaping link (lexical readlink-based resolution must catch it; a
  // realpath-based rewrite would throw ENOENT instead of the containment error).
  it.runIf(canPlantRelativeLink)(
    'refuses a RELATIVE-target link escaping from a nested dir (TQ-2)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'hr-contain-rel-esc-'))
      mkdirSync(join(root, 'release', 'lib'), { recursive: true })
      // Stored target ../../../<name>: three levels up from release/lib/ = the tmpdir root,
      // one above the install dir — an escape only the relative branch can detect.
      symlinkSync(
        join('..', '..', '..', 'hr-contain-rel-victim'),
        join(root, 'release', 'lib', 'evil'),
        'dir'
      )
      await expect(assertExtractedSymlinksContained(root)).rejects.toThrow(
        /escapes the install dir/
      )
    }
  )

  it.runIf(canPlantRelativeLink)(
    'passes a RELATIVE-target link that resolves INSIDE from its nested dir (TQ-2)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'hr-contain-rel-good-'))
      mkdirSync(join(root, 'lib'))
      mkdirSync(join(root, 'sub'))
      // ../lib from sub/ = <root>/lib — inside. Mis-anchoring the relative resolution to the
      // install ROOT instead of the link's OWN directory would resolve this to a sibling of
      // the root and wrongly refuse a legitimate archive.
      symlinkSync(join('..', 'lib'), join(root, 'sub', 'alias'), 'dir')
      await expect(assertExtractedSymlinksContained(root)).resolves.toBeUndefined()
    }
  )

  it('refuses a DANGLING link whose outside target no longer exists (TQ-2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hr-contain-dangling-'))
    const outside = mkdtempSync(join(tmpdir(), 'hr-contain-gone-'))
    plantDirLink(outside, join(root, 'evil'))
    rmSync(outside, { recursive: true, force: true }) // the link now dangles (works for junctions too)
    await expect(assertExtractedSymlinksContained(root)).rejects.toThrow(
      /escapes the install dir/
    )
  })

  // An INSIDE directory whose name merely starts with '..' (legal on every OS) must not trip
  // the escape check — the `..` test is segment-aware (`..` alone or `..<sep>`-led), not a
  // bare startsWith over the relative path.
  it('does not false-positive on an inside directory named with a dot-dot prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hr-contain-dots-'))
    const dotty = join(root, '..inside')
    mkdirSync(dotty)
    plantDirLink(dotty, join(root, 'alias'))
    await expect(assertExtractedSymlinksContained(root)).resolves.toBeUndefined()
  })
})

// End-to-end: an archive whose extraction plants an escaping link fails the INSTALL (the job
// reports `failed`, no marker is written), while the same flow with a clean archive succeeds.
// Mirrors the engine-download.test.ts harness: injected fetch + extractor, zero network/shell.
const BODY = 'llama-server-release-archive-bytes'
const REAL_SHA = createHash('sha256').update(BODY).digest('hex')
const HOST_OS = hostRuntimeOs()
const HOST_ARCH = hostRuntimeArch()
const BIN_NAME = llamaServerBinaryName()

function makeDrive(): { rootPath: string; manifestsDir: string } {
  const rootPath = mkdtempSync(join(tmpdir(), 'hr-contain-root-'))
  const manifestsDir = mkdtempSync(join(tmpdir(), 'hr-contain-manifests-'))
  const yaml = stringify({
    llama_cpp: {
      version: 'btest',
      builds: [
        {
          os: HOST_OS,
          arch: HOST_ARCH,
          backend: 'cpu',
          url: 'https://example.test/llama-server.zip',
          sha256: REAL_SHA,
          extract_to: `runtime/llama.cpp/${HOST_OS}`
        }
      ]
    }
  })
  writeFileSync(join(manifestsDir, 'runtime-sources.yaml'), yaml)
  return { rootPath, manifestsDir }
}

describe('EngineDownloadManager refuses an archive planting an escaping link (SEC-2)', () => {
  const liveDir = (rootPath: string): string => join(rootPath, 'runtime', 'llama.cpp', HOST_OS)

  /** The job's end, once its run and the background deletes it queued have settled. */
  async function settle(mgr: EngineDownloadManager, jobId: string): Promise<EngineDownloadJob> {
    const job = await runToEnd(mgr, jobId)
    await vi.waitFor(() => expect(mgr.activeJob()).toBeNull(), { timeout: hangBudgetMs(5000) })
    await engineFolderDeletesSettled()
    return job
  }

  // #752 + #986: every way an extraction can fail. Each one runs as a first install (nothing of the
  // refused archive may read as installed) and over an installed engine (that copy must stay exactly
  // as it was: before #986 it was already deleted when the failure came).
  interface Failure {
    name: string
    extract: (ctx: { outside: string; cancel: () => void }) => ExtractFn
    status: 'failed' | 'cancelled'
    error?: string
  }
  const FAILURES: Failure[] = [
    {
      name: 'an archive planting escaping links',
      extract: ({ outside }) => async (_archive, destDir) => {
        await writeFile(join(destDir, BIN_NAME), 'binary')
        plantDirLink(outside, join(destDir, 'evil'))
        plantDirLink(outside, join(destDir, 'evil-too')) // the sweep stops at the first; the clear-up meets this one
      },
      status: 'failed',
      error: tMain('main.engine.extractFailed')
    },
    {
      // A tar that fails after writing never reaches the sweep, so its files and links would otherwise stay.
      name: 'a tar that fails past the binary',
      extract: ({ outside }) => async (_archive, destDir) => {
        await writeFile(join(destDir, BIN_NAME), 'binary')
        plantDirLink(outside, join(destDir, 'evil'))
        throw new Error('tar exited with code 1')
      },
      status: 'failed',
      error: tMain('main.engine.extractFailed')
    },
    {
      // tar has exited, so the sweep still runs: a cancel landing on a refusal keeps nothing either.
      name: 'a cancel that lands while the archive is being refused',
      extract: ({ outside, cancel }) => async (_archive, destDir) => {
        await writeFile(join(destDir, BIN_NAME), 'binary')
        plantDirLink(outside, join(destDir, 'evil'))
        cancel()
      },
      status: 'cancelled'
    },
    {
      // Past the extraction too: the archive unpacked, and the install still failed.
      name: 'a marker that cannot be written',
      extract: () => async (_archive, destDir) => {
        await writeFile(join(destDir, BIN_NAME), 'binary')
        mkdirSync(runtimeMarkerPath(destDir)) // a real errno on every OS
      },
      status: 'failed'
    },
    {
      name: 'a link posing as the cpu/ net',
      extract: ({ outside }) => async (_archive, destDir) => {
        plantDirLink(outside, join(destDir, 'a-evil'))
        plantDirLink(outside, join(destDir, 'cpu'))
      },
      status: 'failed'
    }
  ]

  async function runFailure(f: Failure, rootPath: string, manifestsDir: string, outside: string): Promise<EngineDownloadJob> {
    const box: { mgr?: EngineDownloadManager; jobId?: string } = {}
    const extractImpl = f.extract({ outside, cancel: () => box.mgr!.cancel(box.jobId!) })
    box.mgr = new EngineDownloadManager({ fetchImpl: bodyFetch(BODY), extractImpl })
    const started = await box.mgr.start({
      rootPath,
      manifestsDir,
      gates: { policyAllows: true, settingAllows: true },
      families: ['llama_cpp']
    })
    box.jobId = started.jobId
    return settle(box.mgr, started.jobId)
  }

  it.each(FAILURES)('first install, $name: nothing of the refused archive stays installed (#752)', async (f) => {
    const { rootPath, manifestsDir } = makeDrive()
    const outside = mkdtempSync(join(tmpdir(), 'hr-contain-victim-'))
    writeFileSync(join(outside, 'keep.txt'), 'x')
    const job = await runFailure(f, rootPath, manifestsDir, outside)
    expect(job.status).toBe(f.status)
    if (f.error) expect(job.error).toBe(f.error)
    // A binary left behind with no marker read as installed, and the verifier let it through as `skip-legacy`.
    expect(readdirSync(liveDir(rootPath))).toEqual([])
    expect(engineStatus(rootPath, manifestsDir).installed).toBe(false)
    // #986: and no half copy waits beside it.
    expect(existsSync(`${liveDir(rootPath)}.new`)).toBe(false)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true) // no link was followed
  })

  it.each(FAILURES)('over an installed engine, $name: the installed copy stays exactly as it was (#986)', async (f) => {
    const { rootPath, manifestsDir } = makeDrive()
    const outside = mkdtempSync(join(tmpdir(), 'hr-contain-victim-'))
    writeFileSync(join(outside, 'keep.txt'), 'x')
    const live = liveDir(rootPath)
    mkdirSync(join(live, 'cpu'), { recursive: true })
    writeFileSync(join(live, BIN_NAME), 'the old engine')
    writeFileSync(join(live, 'ggml-vulkan.dll'), 'its library')
    writeRuntimeMarker(live, { version: 'bold', backend: 'cpu', os: HOST_OS, arch: HOST_ARCH })
    writeFileSync(join(live, 'cpu', BIN_NAME), 'safety net')
    const before = fingerprintTree(live)
    const job = await runFailure(f, rootPath, manifestsDir, outside)
    expect(job.status).toBe(f.status)
    if (f.error) expect(job.error).toBe(f.error)
    expect(fingerprintTree(live)).toEqual(before)
    expect(readFileSync(join(live, BIN_NAME), 'utf8')).toBe('the old engine')
    expect(engineStatus(rootPath, manifestsDir).engineVersions?.[0]?.installed).toBe('bold')
    expect(existsSync(`${live}.new`)).toBe(false)
    expect(existsSync(`${live}.old`)).toBe(false)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  // #752 used to clear the install one entry at a time so one locked file could not spare the binary
  // after it. #986: the failed copy is in `.new`, never in the install folder. A `.new` that cannot be
  // deleted (a scanner holds it) stays unmarked and unread, and the next start deletes it.
  it('a staging folder that cannot be deleted stays unmarked beside an untouched install, and the next start deletes it (#986)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const live = liveDir(rootPath)
    const LOCKED = '0-locked.dll'
    const failingExtract: ExtractFn = async (_archive, destDir) => {
      await writeFile(join(destDir, LOCKED), 'scanned by the antivirus')
      await writeFile(join(destDir, BIN_NAME), 'binary')
      seams.rmRefuses = '.new'
      throw new Error('tar exited with code 1')
    }
    const mgr = new EngineDownloadManager({ fetchImpl: bodyFetch(BODY), extractImpl: failingExtract })
    const started = await mgr.start({ rootPath, manifestsDir, gates: { policyAllows: true, settingAllows: true } })
    expect((await settle(mgr, started.jobId)).status).toBe('failed')
    expect(readdirSync(live)).toEqual([])
    expect(readdirSync(`${live}.new`)).toEqual(expect.arrayContaining([LOCKED, BIN_NAME]))
    expect(existsSync(runtimeMarkerPath(`${live}.new`))).toBe(false)
    expect(engineStatus(rootPath, manifestsDir).installed).toBe(false)
    seams.rmRefuses = null
    recoverEngineSwaps(rootPath, manifestsDir)
    await engineFolderDeletesSettled()
    expect(existsSync(`${live}.new`)).toBe(false)
  })

  it('a clean archive through the same flow still installs (no false positive)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const cleanExtract: ExtractFn = async (_archive, destDir) => {
      await writeFile(join(destDir, BIN_NAME), 'binary')
    }
    const mgr = new EngineDownloadManager({ fetchImpl: bodyFetch(BODY), extractImpl: cleanExtract })
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: { policyAllows: true, settingAllows: true }
    })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('done')
    // The positive that pins the refused row's "no marker": same path expression.
    expect(existsSync(runtimeMarkerPath(join(rootPath, 'runtime', 'llama.cpp', HOST_OS)))).toBe(true)
  })
})
