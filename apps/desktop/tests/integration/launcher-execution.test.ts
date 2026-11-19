import { describe, it, expect, vi } from 'vitest'
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { REPO_ROOT } from '../helpers/repo-files'
import { bashLegSkipped, outputOf } from '../helpers/script-legs'
import { hangBudgetMs, testBudgetMs, until, within } from '../helpers/hang-budget'

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
  // without a Mac: it logs each call and, by DITTO_MODE, unpacks a stub bundle (ok), fails (fail), unpacks nothing (empty)
  // or a bundle without its app binary (nobin). It writes the bundle in two halves; with DITTO_GATE set it stops between
  // them until the row lets it go on, so a row can start a second launch while the first one is unpacking (#887).
  describe('unpacking the .app.zip into the local cache', () => {
    const zip = zips[1]
    const cached = basename(zip, '.zip')
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH'
    const firstHalf = (caches: string): string => join(caches, cached, 'HilbertRaum.app', 'Contents', 'Frameworks', 'first-half')

    type DittoMode = 'ok' | 'fail' | 'empty' | 'nobin'
    interface Started {
      exited: Promise<{ status: number | null; out: string }>
      kill(): void
    }
    interface Drive {
      root: string
      caches: string
      run(mode: DittoMode): SpawnSyncReturns<string>
      /** A launch that runs beside the test, for the rows where two launches overlap. */
      start(mode: DittoMode, env: Record<string, string>): Started
      /** Puts an `mv` stub first on PATH that, with MV_GATE set, waits before it moves. */
      stubMv(): void
      /** A gate file prefix for DITTO_GATE / MV_GATE: the stub writes `<gate>.started` and waits for `<gate>.go`. */
      gate(name: string): string
      reached(gate: string): Promise<void>
      release(gate: string): void
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
      const waitFor = (variable: string): string[] => [
        `if [ -n "\${${variable}:-}" ]; then`,
        `  : > "$${variable}.started"`,
        `  while [ ! -e "$${variable}.go" ]; do sleep 0.05; done`,
        'fi'
      ]
      writeFileSync(
        join(stubs, 'ditto'),
        [
          '#!/bin/bash',
          'echo "$*" >> "$DITTO_LOG"',
          'case "$DITTO_MODE" in fail) exit 1 ;; empty) exit 0 ;; esac',
          'mkdir -p "$4/HilbertRaum.app/Contents/Frameworks"',
          ': > "$4/HilbertRaum.app/Contents/Frameworks/first-half"',
          ...waitFor('DITTO_GATE'),
          // A zip extractor re-creates a parent folder that went missing meanwhile.
          'mkdir -p "$4/HilbertRaum.app/Contents/MacOS" || exit 1',
          'if [ "$DITTO_MODE" = nobin ]; then exit 0; fi',
          'cp "$DITTO_APP" "$4/HilbertRaum.app/Contents/MacOS/HilbertRaum"',
          ''
        ].join('\n')
      )
      chmodSync(join(stubs, 'ditto'), 0o755)
      // The inherited key, whatever its case: Windows env names are case-insensitive, and Git Bash converts a Windows
      // `Path` itself (a `C:` entry in a POSIX PATH would split at its colon).
      const env = (mode: DittoMode, extra: Record<string, string> = {}): Record<string, string> => ({
        HOME: home,
        [pathKey]: `${stubs}${delimiter}${process.env[pathKey] ?? ''}`,
        DITTO_LOG: log,
        DITTO_MODE: mode,
        DITTO_APP: app,
        ...extra
      })
      return {
        root,
        caches: join(home, 'Library', 'Caches', 'HilbertRaum'),
        run: (mode) => runBash(root, COMMAND, [], env(mode)),
        // Git Bash's bash.exe puts its own /usr/bin ahead of the PATH it inherits, which hides an `mv` stub (a `ditto` one
        // has nothing to hide behind). The inner bash keeps the PATH it is given, and `exec` keeps the PID.
        start: (mode, extra) => {
          const child = spawn('bash', ['-c', 'PATH="$(cd "$1" && pwd):$PATH"; exec bash "$2"', 'launch', stubs, join(root, COMMAND)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env(mode, extra) }
          })
          let out = ''
          child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
          child.stderr.setEncoding('utf8').on('data', (d: string) => (out += d))
          const exited = new Promise<{ status: number | null; out: string }>((resolve) =>
            child.on('close', (status) => resolve({ status, out }))
          )
          return { exited, kill: () => child.kill() }
        },
        // /bin/mv exists on macOS, on the usrmerged Ubuntu runners and in Git Bash.
        stubMv: () => {
          writeFileSync(join(stubs, 'mv'), ['#!/bin/bash', ...waitFor('MV_GATE'), 'exec /bin/mv "$@"', ''].join('\n'))
          chmodSync(join(stubs, 'mv'), 0o755)
        },
        gate: (name) => join(stubs, `gate-${name}`),
        reached: (gate) => until(() => existsSync(`${gate}.started`), `${basename(gate)} reached its stub`, 10_000),
        release: (gate) => writeFileSync(`${gate}.go`, ''),
        dittoCalls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
      }
    }

    /**
     * A PID the launcher's `kill -0` sees as running. Under Git Bash node's `child.pid` is the Windows PID, which MSYS
     * `kill -0` cannot see, so the child prints its own `$$` (the same number on Linux and macOS).
     */
    async function livePid(): Promise<{ pid: string; stop(): void }> {
      const child = spawn('bash', ['-c', 'echo $$; exec sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'] })
      const stop = (pid?: string): void => {
        if (pid) spawnSync('bash', ['-c', 'kill "$1" 2>/dev/null; true', '_', pid])
        child.kill()
      }
      try {
        const pid = await within(
          new Promise<string>((resolve) => {
            let buf = ''
            child.stdout.setEncoding('utf8').on('data', (d: string) => {
              buf += d
              if (buf.includes('\n')) resolve(buf.slice(0, buf.indexOf('\n')).trim())
            })
          }),
          'the stand-in for a running launch printed its PID',
          10_000
        )
        return { pid, stop: () => stop(pid) }
      } catch (e) {
        stop()
        throw e
      }
    }

    /** The PID of a bash that has exited and been reaped: `kill -0` fails on it. */
    const deadPid = (): string => spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()

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

    // A partial unpack is `<zip name>.partial.<pid of the start writing it>`. One whose start has ended is swept; a name
    // that is no PID is swept too (`kill -0 0` succeeds, so `.partial.0` would otherwise stay forever).
    it.each([
      ['the PID of a start that has ended', deadPid],
      ['0', () => '0'],
      ['no number', () => 'abc']
    ])('sweeps a partial unpack left behind whose name holds %s (#887)', (_, suffix) => {
      const drive = zipDrive()
      mkdirSync(join(drive.caches, `${cached}.partial.${suffix()}`, 'HilbertRaum.app'), { recursive: true })
      const r = drive.run('ok')
      expect(r.status, outputOf(r)).toBe(0)
      expect(readdirSync(drive.caches)).toEqual([cached])
    })

    // #887: every start used to delete every partial unpack, so a second double-click during the first unpack deleted the
    // folder the first start was still writing into.
    it('keeps the partial unpack of a start that is still running (#887)', async () => {
      const drive = zipDrive()
      const live = await livePid()
      try {
        const partial = join(drive.caches, `${cached}.partial.${live.pid}`)
        mkdirSync(partial, { recursive: true })
        writeFileSync(join(partial, 'still-unpacking'), '')
        const r = drive.run('ok')
        expect(r.status, outputOf(r)).toBe(0)
        expect(existsSync(join(partial, 'still-unpacking'))).toBe(true)
        expect(existsSync(join(drive.caches, cached, 'HilbertRaum.app'))).toBe(true)
      } finally {
        live.stop()
      }
    })

    it('two starts during one unpack both start the app, and the copy they run is complete (#887)', async () => {
      const drive = zipDrive()
      const [one, two] = [drive.gate('ditto-1'), drive.gate('ditto-2')]
      const starts: Started[] = []
      try {
        starts.push(drive.start('ok', { DITTO_GATE: one }))
        await drive.reached(one)
        starts.push(drive.start('ok', { DITTO_GATE: two }))
        await drive.reached(two)
        drive.release(one)
        const first = await within(starts[0].exited, 'the first start ended', 10_000)
        drive.release(two)
        const second = await within(starts[1].exited, 'the second start ended', 10_000)
        expect(first.status, first.out).toBe(0)
        expect(second.status, second.out).toBe(0)
        expect(existsSync(firstHalf(drive.caches)), 'the half unpacked before the second start').toBe(true)
        expect(readdirSync(drive.caches)).toEqual([cached])
      } finally {
        for (const gate of [one, two]) drive.release(gate)
        for (const s of starts) s.kill()
      }
    })

    // `mv` onto a folder that exists moves the source INTO it: two starts that both found no cache before either published
    // would leave a second ~400 MB copy inside the first.
    it('two starts that publish at the same moment leave one copy in the cache, nothing nested (#887)', async () => {
      const drive = zipDrive()
      drive.stubMv()
      const [one, two] = [drive.gate('mv-1'), drive.gate('mv-2')]
      const starts: Started[] = []
      try {
        starts.push(drive.start('ok', { MV_GATE: one }))
        await drive.reached(one)
        starts.push(drive.start('ok', { MV_GATE: two }))
        await drive.reached(two)
        drive.release(one)
        const first = await within(starts[0].exited, 'the first start ended', 10_000)
        drive.release(two)
        const second = await within(starts[1].exited, 'the second start ended', 10_000)
        expect(first.status, first.out).toBe(0)
        expect(second.status, second.out).toBe(0)
        expect(readdirSync(join(drive.caches, cached))).toEqual(['HilbertRaum.app'])
        expect(readdirSync(drive.caches)).toEqual([cached])
      } finally {
        for (const gate of [one, two]) drive.release(gate)
        for (const s of starts) s.kill()
      }
    })

    // Root-owned files from a `sudo` start, or a read-only folder, used to stop every later start at the sweep with a raw
    // `rm` error. NTFS ignores the mode and root may delete anything, so the row needs a POSIX desk and a normal user.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'a leftover partial unpack the sweep cannot remove does not stop the start (#887)',
      () => {
        const drive = zipDrive()
        const locked = join(drive.caches, `${cached}.partial.${deadPid()}`, 'locked')
        mkdirSync(locked, { recursive: true })
        writeFileSync(join(locked, 'f'), '')
        chmodSync(locked, 0o555)
        try {
          const r = drive.run('ok')
          expect(r.status, outputOf(r)).toBe(0)
          expect(existsSync(join(drive.caches, cached, 'HilbertRaum.app'))).toBe(true)
        } finally {
          chmodSync(locked, 0o755)
        }
      }
    )

    // An archive that unpacks to no .app (a zip made without --keepParent) used to be published as the cache, and every
    // later start then refused it without unpacking again (#769). So did a bundle without its app binary, after which every
    // start told the user to get past Gatekeeper (#887).
    it.each([
      ['fails', 'fail', /Could not unpack '.*HilbertRaum-0\.1\.59-mac-arm64\.app\.zip'/],
      ['unpacks no .app', 'empty', /found no \.app inside it/],
      ['unpacks an .app without its app binary', 'nobin', /found no \.app inside it/]
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
