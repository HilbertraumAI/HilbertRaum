import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

// #758: the offline tripwire asks at every remote connect whether the app is offline right now, through the
// reader `getPolicy` gives the Privacy screen (`currentPolicyStatus`). Decided once at startup, it stayed armed
// after an encrypted workspace's unlock, so every download the user accepted was recorded as a violation, and
// it never armed on a plaintext workspace that went offline later. Each row walks one of the issue's two
// sessions through the real vault, the real settings IPC and a real policy file, and at every step holds the
// tripwire to what `getPolicy` says. The guard's own contract (asked at the connect, loopback first, a throw
// counts as offline) is policy.test.ts's "offline self-check".

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' },
  clipboard: { writeText: () => undefined }
}))

import { registerCoreIpc } from '../../src/main/ipc/registerCoreIpc'
import { assertOfflinePosture } from '../../src/main/services/offlineGuard'
import { DEFAULT_POLICY, currentPolicyStatus } from '../../src/main/services/policy'
import type { AppContext } from '../../src/main/services/context'
import type { KdfParams } from '../../src/main/services/security/crypto'
import { WorkspaceController, createEncryptedVaultOnDisk, vaultPathsFrom } from '../../src/main/services/workspace-vault'
import { IPC } from '../../src/shared/ipc'
import type { PolicyStatus, PrivacyPolicy } from '../../src/shared/types'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { repoText } from '../helpers/repo-files'

const handlers = ipcState.handlers as unknown as IpcHandlers
const PASSWORD = 'right-password'
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

/** A drive's `config/policy.json`: downloads allowed (a Kit that lists models for in-app download) or not. */
function policyJson(allowModelDownloads: boolean): string {
  return JSON.stringify({ network: { allow_model_downloads: allowModelDownloads, allow_update_checks: false } })
}

let uninstallGuard: () => void = () => {}

beforeEach(() => {
  ipcState.handlers.clear()
  // Every socket stays a stub: the guard wraps it, so nothing leaves the machine.
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
    return this
  })
})

afterEach(() => {
  uninstallGuard()
  uninstallGuard = () => {}
  vi.restoreAllMocks()
})

/**
 * A scratch drive root with `policy.json`, the workspace `open` builds on it, the core IPC registered, and the
 * tripwire installed exactly as `initBackend` does. `step(label)` reads `getPolicy` and makes one remote attempt;
 * its row is `[label, what the Privacy screen says, whether the tripwire recorded it]`.
 */
function session(open: (vp: ReturnType<typeof vaultPathsFrom>) => WorkspaceController, isDev: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-tripwire-'))
  const configPath = join(root, 'config')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(join(root, 'workspace'), { recursive: true })
  writeFileSync(join(configPath, 'policy.json'), policyJson(true))
  const ctrl = open(vaultPathsFrom({ configPath, dbPath: join(root, 'workspace', 'hilbertraum.sqlite') }))
  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { configPath },
    isDev,
    workspace: ctrl,
    get db() {
      return ctrl.requireDb()
    }
  } as unknown as AppContext
  registerCoreIpc(ctx)
  const recorded: string[] = []
  uninstallGuard = assertOfflinePosture({
    readPosture: () => currentPolicyStatus(ctx),
    log: () => undefined,
    warn: () => undefined,
    onViolation: (host) => recorded.push(host)
  })
  let attempt = 0
  const step = async (label: string): Promise<[string, boolean, boolean]> => {
    const { result } = await invoke(handlers, IPC.getPolicy)
    const host = `host-${++attempt}.example.com`
    new net.Socket().connect(443, host)
    return [label, (result as PolicyStatus).offlineMode, recorded.includes(host)]
  }
  return { ctrl, configPath, step }
}

describe('offline tripwire: records a connection opened while getPolicy says offline (#758)', () => {
  it('an encrypted workspace: watched while locked, silent once unlocked with network allowed, watched again after a lock', async () => {
    const { ctrl, step } = session((vp) => {
      createEncryptedVaultOnDisk(vp, PASSWORD, FAST_KDF)
      const c = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      c.init()
      return c
    }, false)
    const rows = [await step('locked at startup')]
    ctrl.unlock(PASSWORD) // the setting is on by default, the policy allows downloads: online
    rows.push(await step('unlocked: a download the user accepts'))
    ctrl.lock() // owner call: locked reads as offline, as in getPolicy and the download gates
    rows.push(await step('locked again'))
    expect(rows).toEqual([
      ['locked at startup', true, true],
      ['unlocked: a download the user accepts', false, false],
      ['locked again', true, true]
    ])
  })

  it('a plaintext workspace online at startup: watched once the setting goes off, and while the policy file allows no network', async () => {
    const { configPath, step } = session((vp) => {
      const c = new WorkspaceController(vp, DEFAULT_POLICY, true) // dev: a plaintext workspace opens at startup
      c.init()
      return c
    }, true)
    const rows = [await step('online at startup')]
    await invoke(handlers, IPC.updateSettings, { allowNetwork: false })
    rows.push(await step('the setting switched off'))
    await invoke(handlers, IPC.updateSettings, { allowNetwork: true })
    rows.push(await step('the setting back on'))
    writeFileSync(join(configPath, 'policy.json'), policyJson(false)) // read live: the file's size changes
    rows.push(await step('the policy file now allows no network'))
    expect(rows).toEqual([
      ['online at startup', false, false],
      ['the setting switched off', true, true],
      ['the setting back on', false, false],
      ['the policy file now allows no network', true, true]
    ])
  })
})

// index.ts pulls in the whole Electron main process and cannot be imported here: a source pin, the idiom of
// answer-speed-wiring.test.ts. The rows above prove `currentPolicyStatus` is the right reader; this says
// `initBackend` hands the tripwire that reader, not a reading taken once at startup.
describe('wiring pin: initBackend gives the tripwire the getPolicy reader (#758)', () => {
  const indexSrc = repoText('apps', 'desktop', 'src', 'main', 'index.ts')
  const start = indexSrc.indexOf('function initBackend(')
  const initBackend = indexSrc.slice(start, indexSrc.indexOf('function createWindow(', start))
  const PIN = /assertOfflinePosture\(\s*\{\s*readPosture:\s*\(\)\s*=>\s*currentPolicyStatus\(/

  it('assertOfflinePosture is given readPosture: () => currentPolicyStatus(…)', () => {
    expect(initBackend).toMatch(PIN)
    // The control: the same slice handing over a startup snapshot fails the pin.
    const mutated = initBackend.replace(/readPosture:\s*\(\)\s*=>\s*currentPolicyStatus\(/, 'readPosture: () => atStartup, ignored: currentPolicyStatus(')
    expect(mutated).not.toBe(initBackend)
    expect(mutated).not.toMatch(PIN)
  })
})
