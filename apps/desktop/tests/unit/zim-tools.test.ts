import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'
import {
  kiwixManageAdd,
  kiwixManageBinaryName,
  kiwixServeBinaryName,
  kiwixToolsDir,
  resolveKiwixManagePath,
  resolveKiwixServePath
} from '../../src/main/services/zim/tools'

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 777
  killed = false
  stderr = new EventEmitter()
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'))
    return true
  }
}

function fakeSpawn(): { spawn: SpawnFn; calls: Array<{ command: string; args: string[] }>; child: FakeChild } {
  const calls: Array<{ command: string; args: string[] }> = []
  const child = new FakeChild()
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
    return child
  }
  return { spawn, calls, child }
}

describe('kiwix binary discovery', () => {
  it('finds kiwix-serve under runtime/kiwix-tools/<os>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-kiwix-'))
    const dir = kiwixToolsDir(root, 'win32')
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, kiwixServeBinaryName('win32'))
    writeFileSync(bin, 'x')
    expect(resolveKiwixServePath(root, 'win32', {})).toBe(bin)
    expect(resolveKiwixServePath(mkdtempSync(join(tmpdir(), 'empty-')), 'win32', {})).toBeNull()
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
  it('spawns `kiwix-manage LIBRARY add ZIM` and resolves on exit 0', async () => {
    const { spawn, calls, child } = fakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn)
    queueMicrotask(() => child.emit('exit', 0, null))
    await expect(done).resolves.toBeUndefined()
    expect(calls[0]?.command).toBe('/bin/kiwix-manage')
    expect(calls[0]?.args[1]).toBe('add')
  })

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
    expect(calls[0]?.args[0]).toBe('/lib/dir/library.xml')
    expect(calls[0]?.args[2]).toBe('/zim/sub/a.zim')
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
})
