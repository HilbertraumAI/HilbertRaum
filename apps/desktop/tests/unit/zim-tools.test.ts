import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { log } from '../../src/main/services/logging'
import type { SpawnFn } from '../../src/main/services/runtime/sidecar'
import {
  kiwixManageAdd,
  kiwixManageBinaryName,
  kiwixServeBinaryName,
  kiwixToolsDir,
  resolveKiwixManagePath,
  resolveKiwixServePath
} from '../../src/main/services/zim/tools'
import { ServeFakeChild, spawnErrorLike } from '../helpers/zim-fakes'
import { until } from '../helpers/hang-budget'

interface SpawnCall {
  command: string
  args: string[]
  cwd: string | undefined
}

function fakeSpawn(): { spawn: SpawnFn; calls: SpawnCall[]; child: ServeFakeChild } {
  const calls: SpawnCall[] = []
  const child = new ServeFakeChild(777, 'exit-on-sigterm')
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd === undefined ? undefined : String(options.cwd) })
    return child
  }
  return { spawn, calls, child }
}

describe('kiwix binary discovery', () => {
  it('finds kiwix-serve under runtime/kiwix-tools/<os>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-kiwix-'))
    // The drive layout spelled out, not built from the resolver's own helpers.
    const bin = join(root, 'runtime', 'kiwix-tools', 'win', 'kiwix-serve.exe')
    mkdirSync(join(root, 'runtime', 'kiwix-tools', 'win'), { recursive: true })
    writeFileSync(bin, 'x')
    expect(resolveKiwixServePath(root, 'win32', {})).toBe(bin)
    expect(resolveKiwixServePath(mkdtempSync(join(tmpdir(), 'hilbertraum-kiwix-empty-')), 'win32', {})).toBeNull()
  })

  it('honours HILBERTRAUM_KIWIX_BIN in dev only (M-5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-kiwix-'))
    const explicit = join(dir, 'my-kiwix-serve')
    writeFileSync(explicit, 'x')
    expect(
      resolveKiwixServePath('/nope', 'linux', { HILBERTRAUM_KIWIX_BIN: explicit }, { isDev: true })
    ).toBe(explicit)
    // Packaged build (default opts): the override is ignored, not honoured.
    expect(resolveKiwixServePath('/nope', 'linux', { HILBERTRAUM_KIWIX_BIN: explicit })).toBeNull()
  })

  it('resolves kiwix-manage as a sibling of the resolved kiwix-serve', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-kiwix-'))
    const dir = kiwixToolsDir(root, 'linux')
    mkdirSync(dir, { recursive: true })
    const serve = join(dir, kiwixServeBinaryName('linux'))
    writeFileSync(serve, 'x')
    expect(resolveKiwixManagePath(serve, 'linux')).toBeNull() // manage absent
    const manage = join(dir, kiwixManageBinaryName('linux'))
    writeFileSync(manage, 'x')
    expect(resolveKiwixManagePath(serve, 'linux')).toBe(manage)
    expect(resolveKiwixManagePath(null, 'linux')).toBeNull()
  })

  it('names the executables per platform', () => {
    expect(kiwixServeBinaryName('win32')).toBe('kiwix-serve.exe')
    expect(kiwixServeBinaryName('linux')).toBe('kiwix-serve')
    expect(kiwixManageBinaryName('win32')).toBe('kiwix-manage.exe')
    expect(kiwixManageBinaryName('darwin')).toBe('kiwix-manage')
  })
})

describe('kiwixManageAdd', () => {
  // The whole spawn — kiwix-manage's CLI is `LIBRARY add ZIM`, in that order — and what a refusal
  // means. `platform` is injected, not read from `process.platform` (#301 P5, finding L9), so every
  // branch is pinned independently of the host.
  //
  // #787: on Windows the pinned build mis-reads any non-ASCII character of its narrow argv, so the
  // child starts in the library's folder and gets the library by its bare name; a non-ASCII archive
  // path goes relative to that folder when that is ASCII. The working directory is never the
  // archive's folder (Windows searches it for DLLs). Each Windows row is a layout measured on the
  // real kiwix-tools 3.8.1 (2026-11-08). `nonAsciiArgv` says no ASCII spelling existed — the
  // residual `path-unsupported` keys on it.
  const JUERGEN = 'C:\\Users\\Jürgen\\AppData\\Roaming\\HilbertRaum'
  const JUERGEN_META = `${JUERGEN}\\workspace\\zim-transient\\meta-3`
  it.each([
    {
      name: 'forward slashes on win32 become native backslashes',
      platform: 'win32' as const,
      library: '/lib/dir/library.xml',
      zim: '/zim/sub/a.zim',
      cwd: '\\lib\\dir',
      args: ['library.xml', 'add', '\\zim\\sub\\a.zim'],
      nonAsciiArgv: false
    },
    {
      name: 'linux passes the archive as given, any character, from the library folder',
      platform: 'linux' as const,
      library: '/lib/dir/library.xml',
      zim: '/home/jürgen/zim/a.zim',
      cwd: '/lib/dir',
      args: ['library.xml', 'add', '/home/jürgen/zim/a.zim'],
      nonAsciiArgv: false
    },
    {
      name: 'an ASCII Kit keeps the archive absolute',
      platform: 'win32' as const,
      library: 'D:\\workspace\\zim-transient\\library.12.xml',
      zim: 'D:\\zim\\wiki.zim',
      cwd: 'D:\\workspace\\zim-transient',
      args: ['library.12.xml', 'add', 'D:\\zim\\wiki.zim'],
      nonAsciiArgv: false
    },
    {
      name: "a non-ASCII root reaches the drive's zim folder relative to the library",
      platform: 'win32' as const,
      library: `${JUERGEN_META}\\library.xml`,
      zim: `${JUERGEN}\\zim\\wiki.zim`,
      cwd: JUERGEN_META,
      args: ['library.xml', 'add', '..\\..\\..\\zim\\wiki.zim'],
      nonAsciiArgv: false
    },
    {
      name: 'a root outside cp1252 likewise',
      platform: 'win32' as const,
      library: 'C:\\山田\\workspace\\zim-transient\\library.4.xml',
      zim: 'C:\\山田\\zim\\wiki.zim',
      cwd: 'C:\\山田\\workspace\\zim-transient',
      args: ['library.4.xml', 'add', '..\\..\\zim\\wiki.zim'],
      nonAsciiArgv: false
    },
    {
      name: 'a non-ASCII root keeps an ASCII archive on another drive absolute',
      platform: 'win32' as const,
      library: `${JUERGEN_META}\\library.xml`,
      zim: 'E:\\packs\\wiki.zim',
      cwd: JUERGEN_META,
      args: ['library.xml', 'add', 'E:\\packs\\wiki.zim'],
      nonAsciiArgv: false
    },
    {
      name: 'another folder of the same non-ASCII account relative to the library',
      platform: 'win32' as const,
      library: `${JUERGEN_META}\\library.xml`,
      zim: 'C:\\Users\\Jürgen\\Downloads\\wiki.zim',
      cwd: JUERGEN_META,
      args: ['library.xml', 'add', '..\\..\\..\\..\\..\\..\\Downloads\\wiki.zim'],
      nonAsciiArgv: false
    },
    {
      name: "a non-ASCII folder outside the app's own as it is, never from that folder",
      platform: 'win32' as const,
      library: 'D:\\workspace\\zim-transient\\meta-5\\library.xml',
      zim: 'C:\\Users\\Jörg\\Downloads\\wiki.zim',
      cwd: 'D:\\workspace\\zim-transient\\meta-5',
      args: ['library.xml', 'add', 'C:\\Users\\Jörg\\Downloads\\wiki.zim'],
      nonAsciiArgv: true
    },
    {
      name: 'a non-ASCII file name has no ASCII spelling',
      platform: 'win32' as const,
      library: 'D:\\workspace\\zim-transient\\meta-6\\library.xml',
      zim: 'D:\\zim\\Wiki für Kinder.zim',
      cwd: 'D:\\workspace\\zim-transient\\meta-6',
      args: ['library.xml', 'add', 'D:\\zim\\Wiki für Kinder.zim'],
      nonAsciiArgv: true
    },
    {
      name: 'nor does an archive under an unrelated non-ASCII folder, the root non-ASCII too',
      platform: 'win32' as const,
      library: `${JUERGEN_META}\\library.xml`,
      zim: 'E:\\Bücher\\wiki.zim',
      cwd: JUERGEN_META,
      args: ['library.xml', 'add', 'E:\\Bücher\\wiki.zim'],
      nonAsciiArgv: true
    }
  ])('spawns $name (#787)', async (row) => {
    const { spawn, calls, child } = fakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', row.library, row.zim, spawn, { platform: row.platform })
    queueMicrotask(() => child.emit('exit', 1, null))
    const err = await done.then(() => null, (e: unknown) => e)
    expect(calls).toEqual([{ command: '/bin/kiwix-manage', args: row.args, cwd: row.cwd }])
    expect(err).toMatchObject({ kind: 'exit', nonAsciiArgv: row.nonAsciiArgv, message: 'kiwix-manage exited with code 1' })
  })

  // #787: the child starts in the library's folder, and a relative command holding a separator is
  // looked up from the CHILD's working directory — a dev run's relative drive root would miss it.
  it('spawns a relative command as an absolute one (#787)', async () => {
    const { spawn, calls, child } = fakeSpawn()
    const done = kiwixManageAdd(join('tools', 'kiwix-manage'), '/lib/library.xml', '/zim/a.zim', spawn)
    queueMicrotask(() => child.emit('exit', 0, null))
    await done
    expect(calls[0]?.command).toBe(resolve('tools', 'kiwix-manage'))
  })

  // #712: what kiwix-manage prints names the archive ("Cannot add ZIM <path>") or the library
  // ("Cannot write the library <path>"), and Node's spawn error names the binary; the rejection
  // carries the kind, the exit code or the errno code — never any of them.
  it('a non-zero exit rejects as `exit` with its code, never with what the child printed (#712)', async () => {
    const { spawn, child } = fakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/bad.zim', spawn)
    queueMicrotask(() => {
      child.stderr.emit('data', 'Cannot add ZIM /zim/bad.zim to the library.')
      child.emit('exit', 1, null)
    })
    const err = await done.then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ kind: 'exit', childState: 'exited', message: 'kiwix-manage exited with code 1' })
  })

  it('a spawn error rejects as `spawn` with its errno code, never the binary path (#712)', async () => {
    const { spawn, child } = fakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn)
    queueMicrotask(() => child.emit('error', spawnErrorLike('/bin/kiwix-manage', ['/lib/library.xml', 'add', '/zim/a.zim'])))
    const err = await done.then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ kind: 'spawn', childState: 'exited', message: 'kiwix-manage failed to launch (ENOENT)' })
  })

  // #715: every other row injects millisecond bounds. These are the shipped ones, driven on fake
  // timers to just short of each and onto it: 30 s for the whole run, then kill(), 1 s, SIGKILL,
  // 2 s before the call gives up as `uncertain`.
  it('runs under the shipped bounds: 30 s, then a polite kill, 1 s, SIGKILL, 2 s', async () => {
    const child = new ServeFakeChild(778, 'ignore-all')
    const spawned: string[] = []
    const spawn: SpawnFn = (command) => {
      spawned.push(command)
      return child
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    try {
      let settled = false
      const outcome = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn).then(
        () => null,
        (err: unknown) => err
      )
      void outcome.then(() => (settled = true))
      await until(() => spawned.length === 1, 'the manager spawn after the verifier')

      await vi.advanceTimersByTimeAsync(30_000 - 1)
      expect(child.killCalls).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(child.killCalls).toEqual([undefined])
      await vi.advanceTimersByTimeAsync(1_000 - 1)
      expect(child.killCalls).toEqual([undefined])
      await vi.advanceTimersByTimeAsync(1)
      expect(child.killCalls).toEqual([undefined, 'SIGKILL'])
      await vi.advanceTimersByTimeAsync(2_000 - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(await outcome).toMatchObject({ kind: 'timeout', childState: 'uncertain' })
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
      child.emit('exit', null, 'SIGKILL') // leaves the crash-reap registry
    }
  })
})
