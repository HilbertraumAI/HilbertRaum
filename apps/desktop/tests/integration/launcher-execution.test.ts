import { describe, it, expect, vi } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { REPO_ROOT } from '../helpers/repo-files'
import { bashLegSkipped, outputOf } from '../helpers/script-legs'
import { hangBudgetMs, testBudgetMs } from '../helpers/hang-budget'

// Executes the drive-root launchers (#235, #257). Every launcher derives the drive root from
// its own location, so each case copies the launcher into a scratch root beside 0-byte app
// artifacts. Two app versions on one drive must be refused, naming both, before anything is
// started or written; `--check` (`.sh` / `.command`) and `/check` (`.cmd`) resolve the app and
// exit without starting it — the single-artifact control. The `.command`'s ditto-zip cache path
// runs under a `ditto` stub. The `.cmd` leg runs on Windows, the two bash legs elsewhere (Git Bash
// on a Windows dev box: HILBERTRAUM_SCRIPT_SH_LEG=1).

const LAUNCHERS = join(REPO_ROOT, 'launchers')
const CMD = 'Start HilbertRaum.cmd'
const COMMAND = 'Start HilbertRaum.command'
const SH = 'start-hilbertraum.sh'

// A launcher that reaches its launch line on a 0-byte artifact hangs (Windows shows an error
// dialog for a bad exe) — the child is killed well before vitest's own budget so the failure
// carries the launcher's output.
const CHILD_TIMEOUT_MS = hangBudgetMs(10_000)
vi.setConfig({ testTimeout: testBudgetMs(60_000) })

const REFUSAL = /More than one HilbertRaum app was found on this drive/
const NOT_STARTED = /Nothing was started/

function scratchRoot(launcher: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-launcher-'))
  copyFileSync(join(LAUNCHERS, launcher), join(root, launcher))
  return root
}

/** An exec-able stand-in that records the two variables a launcher must hand the app. */
function stubApp(path: string, record: string): void {
  // /bin/bash, not env: a launcher that wipes the environment must fail on the recorded values, not on "bash not found".
  writeFileSync(path, `#!/bin/bash\nprintf '%s\\n%s\\n' "$HILBERTRAUM_DRIVE_ROOT" "$HILBERTRAUM_MANIFESTS_DIR" > "$(dirname "$0")/${record}"\n`)
  chmodSync(path, 0o755)
}

/** The scratch root's random name proves the value came from the launcher's own location. */
function expectDriveEnv(recorded: string, root: string): void {
  const [driveRoot, manifestsDir] = recorded.trim().split('\n')
  expect(basename(driveRoot)).toBe(basename(root))
  expect(manifestsDir).toBe(`${driveRoot}/model-manifests`)
}

/**
 * The lines --check prints (troubleshooting.md "Two app versions on the drive"). `Manifests  :` reads back the variable the
 * app gets, so a launcher that points the app at another drive's manifests fails here; the `.cmd` launch itself is never run.
 */
function expectCheckLines(out: string, root: string): void {
  const lines = out.split(/\r?\n/)
  expect(lines.find((l) => l.includes('Drive root :')), out).toContain(basename(root))
  const manifests = lines.find((l) => l.includes('Manifests  :'))?.trimEnd().replace(/\\/g, '/') ?? ''
  expect(manifests.split('/').slice(-2), out).toEqual([basename(root), 'model-manifests'])
}

/** 0-byte artifacts, the NEWER name created first so a creation-order pick cannot pass. */
function twoArtifacts(root: string, names: [string, string]): void {
  writeFileSync(join(root, names[1]), '')
  writeFileSync(join(root, names[0]), '')
}

const runCmd = (root: string, args: string[]): SpawnSyncReturns<string> =>
  spawnSync('cmd.exe', ['/d', '/c', `""${join(root, CMD)}"${args.map((a) => ` ${a}`).join('')}"`], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: true,
    windowsHide: true
  })

const runBash = (
  root: string,
  launcher: string,
  args: string[],
  env: Record<string, string> = {}
): SpawnSyncReturns<string> =>
  spawnSync('bash', [join(root, launcher), ...args], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  })

const bashSyntaxOk = (launcher: string): SpawnSyncReturns<string> =>
  spawnSync('bash', ['-n', join(LAUNCHERS, launcher)], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS })

describe.skipIf(process.platform !== 'win32')('Start HilbertRaum.cmd (Windows)', () => {
  const two: [string, string] = ['HilbertRaum-0.1.57-portable.exe', 'HilbertRaum-0.1.59-portable.exe']

  it('refuses two portable apps, naming both, and starts nothing', () => {
    const root = scratchRoot(CMD)
    twoArtifacts(root, two)
    const r = runCmd(root, [])
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(two[0])
    expect(out).toContain(two[1])
  })

  it('/check refuses two portable apps the same way', () => {
    const root = scratchRoot(CMD)
    twoArtifacts(root, two)
    const r = runCmd(root, ['/check'])
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(two[0])
    expect(out).toContain(two[1])
  })

  it('/check with one app names it and starts nothing (exit 0)', () => {
    const root = scratchRoot(CMD)
    writeFileSync(join(root, two[1]), '')
    const r = runCmd(root, ['/check'])
    const out = outputOf(r)
    expect(r.status, out).toBe(0)
    expect(out).toContain(two[1])
    expect(out).toMatch(NOT_STARTED)
    expectCheckLines(out, root)
  })

  it('/check with no app fails with the existing not-found message', () => {
    const root = scratchRoot(CMD)
    const r = runCmd(root, ['/check'])
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(out).toMatch(/Could not find the HilbertRaum app/)
  })
})

// Git Bash exists on the Windows CI runner too — the bash legs are gated so they run once.
describe.skipIf(bashLegSkipped)('start-hilbertraum.sh (Linux)', () => {
  const two: [string, string] = ['HilbertRaum-0.1.57.AppImage', 'HilbertRaum-0.1.59.AppImage']

  const stubAppImage = (root: string, name: string): void => stubApp(join(root, name), `launched-${name}.txt`)
  const launched = (root: string, name: string): boolean => existsSync(join(root, `launched-${name}.txt`))

  it('parses under bash -n and runs under set -euo pipefail (#257)', () => {
    expect(bashSyntaxOk(SH).status).toBe(0)
    expect(readFileSync(join(LAUNCHERS, SH), 'utf8')).toMatch(/^set -euo pipefail$/m)
  })

  it('refuses two AppImages, naming both, and starts neither', () => {
    const root = scratchRoot(SH)
    stubAppImage(root, two[1])
    stubAppImage(root, two[0])
    const r = runBash(root, SH, [])
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(two[0])
    expect(out).toContain(two[1])
    expect(launched(root, two[0])).toBe(false)
    expect(launched(root, two[1])).toBe(false)
  })

  it('--check refuses two AppImages the same way', () => {
    const root = scratchRoot(SH)
    twoArtifacts(root, two)
    const r = runBash(root, SH, ['--check'])
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(two[0])
    expect(out).toContain(two[1])
  })

  it('--check with one AppImage names it and starts nothing (exit 0)', () => {
    const root = scratchRoot(SH)
    stubAppImage(root, two[1])
    const r = runBash(root, SH, ['--check'])
    const out = outputOf(r)
    expect(r.status, out).toBe(0)
    expect(out).toContain(two[1])
    expect(out).toMatch(NOT_STARTED)
    expect(launched(root, two[1])).toBe(false)
    expectCheckLines(out, root)
  })

  // The other two launchers have this row; this one words its message for an AppImage (#769).
  it.each([[[]], [['--check']]])('with no AppImage (arguments %j) it fails with its not-found message', (args) => {
    const root = scratchRoot(SH)
    const r = runBash(root, SH, args)
    const out = outputOf(r)
    expect(r.status, out).toBe(1)
    expect(out).toMatch(/Could not find the HilbertRaum AppImage on this drive/)
    expect(out).not.toMatch(NOT_STARTED)
  })

  it('with one AppImage and no argument it starts it (no unbound-variable abort)', () => {
    const root = scratchRoot(SH)
    stubAppImage(root, two[1])
    const r = runBash(root, SH, [])
    const out = outputOf(r)
    expect(r.status, out).toBe(0)
    expect(out).not.toMatch(/unbound variable/)
    expect(launched(root, two[1])).toBe(true)
    // The stub saw the drive root the launcher derived from its own location.
    expectDriveEnv(readFileSync(join(root, `launched-${two[1]}.txt`), 'utf8'), root)
  })
})

describe.skipIf(bashLegSkipped)('Start HilbertRaum.command (macOS)', () => {
  const zips: [string, string] = ['HilbertRaum-0.1.57-mac-arm64.app.zip', 'HilbertRaum-0.1.59-mac-arm64.app.zip']

  function extractedApp(root: string, name: string): void {
    mkdirSync(join(root, name, 'Contents', 'MacOS'), { recursive: true })
  }

  /** A scratch HOME: the refusal must land before the launcher writes its unpack cache. */
  function scratchHome(): string {
    return mkdtempSync(join(tmpdir(), 'hilbertraum-launcher-home-'))
  }
  const cacheTouched = (home: string): boolean => existsSync(join(home, 'Library'))

  it('parses under bash -n and runs under set -euo pipefail', () => {
    expect(bashSyntaxOk(COMMAND).status).toBe(0)
    expect(readFileSync(join(LAUNCHERS, COMMAND), 'utf8')).toMatch(/^set -euo pipefail$/m)
  })

  it('refuses two extracted .app bundles, naming both', () => {
    const root = scratchRoot(COMMAND)
    const home = scratchHome()
    extractedApp(root, 'HilbertRaum.app')
    extractedApp(root, 'HilbertRaum 2.app')
    const r = runBash(root, COMMAND, [], { HOME: home })
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toMatch(/^\s+HilbertRaum\.app$/m)
    expect(out).toContain('HilbertRaum 2.app')
  })

  it('refuses two .app.zip archives, naming both, before touching the unpack cache', () => {
    const root = scratchRoot(COMMAND)
    const home = scratchHome()
    twoArtifacts(root, zips)
    const r = runBash(root, COMMAND, [], { HOME: home })
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(zips[0])
    expect(out).toContain(zips[1])
    expect(cacheTouched(home)).toBe(false)
  })

  it('refuses an extracted .app beside a newer .app.zip (the .app used to win silently)', () => {
    const root = scratchRoot(COMMAND)
    const home = scratchHome()
    extractedApp(root, 'HilbertRaum.app')
    writeFileSync(join(root, zips[1]), '')
    const r = runBash(root, COMMAND, [], { HOME: home })
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toMatch(/^\s+HilbertRaum\.app$/m)
    expect(out).toContain(zips[1])
  })

  it('--check with one zip names it, writes nothing under $HOME and starts nothing', () => {
    const root = scratchRoot(COMMAND)
    const home = scratchHome()
    writeFileSync(join(root, zips[1]), '')
    const r = runBash(root, COMMAND, ['--check'], { HOME: home })
    const out = outputOf(r)
    expect(r.status, out).toBe(0)
    expect(out).toContain(zips[1])
    expect(out).toMatch(NOT_STARTED)
    expect(cacheTouched(home)).toBe(false)
  })

  it('--check with one extracted .app names it and starts nothing', () => {
    const root = scratchRoot(COMMAND)
    extractedApp(root, 'HilbertRaum.app')
    const r = runBash(root, COMMAND, ['--check'], { HOME: scratchHome() })
    const out = outputOf(r)
    expect(r.status, out).toBe(0)
    expect(out).toContain('HilbertRaum.app')
    expect(out).toMatch(NOT_STARTED)
    expectCheckLines(out, root)
  })

  it("with one extracted .app and no argument it starts the bundle with the drive's variables", () => {
    const root = scratchRoot(COMMAND)
    extractedApp(root, 'HilbertRaum.app')
    const macos = join(root, 'HilbertRaum.app', 'Contents', 'MacOS')
    stubApp(join(macos, 'HilbertRaum'), 'launched.txt')
    const r = runBash(root, COMMAND, [], { HOME: scratchHome() })
    expect(r.status, outputOf(r)).toBe(0)
    expectDriveEnv(readFileSync(join(macos, 'launched.txt'), 'utf8'), root)
  })

  it('--check with no app fails with the existing not-found message', () => {
    const root = scratchRoot(COMMAND)
    const r = runBash(root, COMMAND, ['--check'], { HOME: scratchHome() })
    const out = outputOf(r)
    expect(r.status, out).not.toBe(0)
    expect(out).toMatch(/Could not find the HilbertRaum app/)
  })

  // The normal Mac path: exFAT holds no symlinks, so the drive carries the ditto-zip and the launcher unpacks it once into
  // $HOME/Library/Caches (#769). A `ditto` stub first on PATH stands in for macOS's own, so the bash legs reach this path
  // without a Mac: it logs each call and, by DITTO_MODE, unpacks a stub bundle (ok), fails (fail) or unpacks nothing (empty).
  describe('unpacking the .app.zip into the local cache', () => {
    const zip = zips[1]
    const cached = basename(zip, '.zip')
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH'

    interface Drive {
      root: string
      caches: string
      run(mode: 'ok' | 'fail' | 'empty'): SpawnSyncReturns<string>
      dittoCalls(): string[]
    }

    function zipDrive(): Drive {
      const root = scratchRoot(COMMAND)
      writeFileSync(join(root, zip), '')
      const home = scratchHome()
      const stubs = mkdtempSync(join(tmpdir(), 'hilbertraum-launcher-ditto-'))
      const app = join(stubs, 'app', 'HilbertRaum')
      mkdirSync(join(stubs, 'app'))
      stubApp(app, 'launched.txt')
      const log = join(stubs, 'ditto.log')
      writeFileSync(log, '')
      writeFileSync(
        join(stubs, 'ditto'),
        [
          '#!/bin/bash',
          'echo "$*" >> "$DITTO_LOG"',
          'case "$DITTO_MODE" in fail) exit 1 ;; empty) exit 0 ;; esac',
          'mkdir -p "$4/HilbertRaum.app/Contents/MacOS"',
          'cp "$DITTO_APP" "$4/HilbertRaum.app/Contents/MacOS/HilbertRaum"',
          ''
        ].join('\n')
      )
      chmodSync(join(stubs, 'ditto'), 0o755)
      return {
        root,
        caches: join(home, 'Library', 'Caches', 'HilbertRaum'),
        // The inherited key, whatever its case: Windows env names are case-insensitive, and Git Bash converts a Windows
        // `Path` itself (a `C:` entry in a POSIX PATH would split at its colon).
        run: (mode) =>
          runBash(root, COMMAND, [], {
            HOME: home,
            [pathKey]: `${stubs}${delimiter}${process.env[pathKey] ?? ''}`,
            DITTO_LOG: log,
            DITTO_MODE: mode,
            DITTO_APP: app
          }),
        dittoCalls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
      }
    }

    it("unpacks the zip once, publishes it in $HOME's cache and starts the cached bundle with the drive's variables; the next start reuses it", () => {
      const drive = zipDrive()
      const first = drive.run('ok')
      expect(first.status, outputOf(first)).toBe(0)
      expect(drive.dittoCalls()).toEqual([expect.stringContaining(zip)])
      expect(readdirSync(drive.caches)).toEqual([cached])
      const record = join(drive.caches, cached, 'HilbertRaum.app', 'Contents', 'MacOS', 'launched.txt')
      expectDriveEnv(readFileSync(record, 'utf8'), drive.root)

      rmSync(record)
      const second = drive.run('ok')
      expect(second.status, outputOf(second)).toBe(0)
      expect(drive.dittoCalls()).toHaveLength(1)
      expectDriveEnv(readFileSync(record, 'utf8'), drive.root)
    })

    it('sweeps a partial unpack that a killed run left behind', () => {
      const drive = zipDrive()
      mkdirSync(join(drive.caches, `${cached}.partial.999`, 'HilbertRaum.app'), { recursive: true })
      const r = drive.run('ok')
      expect(r.status, outputOf(r)).toBe(0)
      expect(readdirSync(drive.caches)).toEqual([cached])
    })

    // An archive that unpacks to no .app (a zip made without --keepParent) used to be published as the cache, and every
    // later start then refused it without unpacking again (#769).
    it.each([
      ['fails', 'fail', /Could not unpack '.*HilbertRaum-0\.1\.59-mac-arm64\.app\.zip'/],
      ['unpacks no .app', 'empty', /found no \.app inside it/]
    ] as const)('when ditto %s it publishes nothing, leaves no partial, and the next start unpacks again', (_, mode, message) => {
      const drive = zipDrive()
      for (const attempt of [1, 2]) {
        const r = drive.run(mode)
        const out = outputOf(r)
        expect(r.status, out).toBe(1)
        expect(out).toMatch(message)
        expect(readdirSync(drive.caches), `attempt ${attempt}`).toEqual([])
        expect(drive.dittoCalls()).toHaveLength(attempt)
      }
    })

    it('refuses a cache with no .app (published before #769), naming the folder to delete, and unpacks nothing', () => {
      const drive = zipDrive()
      mkdirSync(join(drive.caches, cached), { recursive: true })
      const r = drive.run('ok')
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toMatch(new RegExp(`'.*Library/Caches/HilbertRaum/${cached.replace(/\./g, '\\.')}' is incomplete`))
      expect(out).not.toMatch(/Could not start the app binary/)
      expect(drive.dittoCalls()).toEqual([])
    })
  })
})
