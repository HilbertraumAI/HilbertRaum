import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { ServeFakeChild } from '../helpers/zim-fakes'
import { until } from '../helpers/hang-budget'

function fakeSpawn(): { spawn: SpawnFn; calls: Array<{ command: string; args: string[] }>; child: ServeFakeChild } {
  const calls: Array<{ command: string; args: string[] }> = []
  const child = new ServeFakeChild(777, 'exit-on-sigterm')
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
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
  // #301 P5, finding L9 (plan §9.19 (e)): `platform` is injected, not read from
  // `process.platform`, so both native-separator branches are pinned independently of the
  // host running the test — replaces the earlier "assert shape, not separators" hedge.
  it('normalizes forward-slash argv paths to backslashes when platform is win32', async () => {
    const { spawn, calls, child } = fakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/dir/library.xml', '/zim/sub/a.zim', spawn, {
      platform: 'win32'
    })
    queueMicrotask(() => child.emit('exit', 0, null))
    await expect(done).resolves.toBeUndefined()
    expect(calls[0]?.args[0]).toBe('\\lib\\dir\\library.xml')
    expect(calls[0]?.args[2]).toBe('\\zim\\sub\\a.zim')
  })

  it('leaves forward-slash argv paths unchanged when platform is linux', async () => {
    const { spawn, calls, child } = fakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/dir/library.xml', '/zim/sub/a.zim', spawn, {
      platform: 'linux'
    })
    queueMicrotask(() => child.emit('exit', 0, null))
    await expect(done).resolves.toBeUndefined()
    // The whole spawn: kiwix-manage's CLI is `LIBRARY add ZIM`, in that order.
    expect(calls[0]).toEqual({
      command: '/bin/kiwix-manage',
      args: ['/lib/dir/library.xml', 'add', '/zim/sub/a.zim']
    })
  })

  it('rejects with the stderr tail on a non-zero exit', async () => {
    const { spawn, child } = fakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/bad.zim', spawn)
    queueMicrotask(() => {
      child.stderr.emit('data', 'Cannot add ZIM /zim/bad.zim to the library.')
      child.emit('exit', 1, null)
    })
    await expect(done).rejects.toThrow(/code 1 — Cannot add ZIM/)
  })

  it('rejects on a spawn error', async () => {
    const { spawn, child } = fakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn)
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
    await expect(done).rejects.toThrow(/ENOENT/)
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
