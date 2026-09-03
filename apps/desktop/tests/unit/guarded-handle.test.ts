import { describe, it, expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

// #252: every `ipcMain.handle` in the main process is registered through `guardedHandle`,
// which runs the handler body only for a sender in the trusted set (the main window's
// WebContents id in production). The fake harness passes `ANY_SENDER`; this file drives
// the guard itself with real sets, and one real registrar with a NON-permissive set.

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test', getPath: () => '', getLocale: () => 'en' },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  clipboard: { writeText: () => {} }
}))

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANY_SENDER,
  UntrustedSenderError,
  createTrustedSenders,
  guardedHandle,
  guardedHandleFor,
  type TrustedSenders
} from '../../src/main/ipc/guarded-handle'
import { registerAuditIpc } from '../../src/main/ipc/registerAuditIpc'
import { log as appLog } from '../../src/main/services/logging'
import { openDatabase } from '../../src/main/services/db'
import type { AppContext } from '../../src/main/services/context'
import { IPC } from '../../src/shared/ipc'
import { makeEvent } from '../helpers/ipc'

const SECRET_ARG = 'ARG_SENTINEL_never_logged'

function quietLog(): { warn: ReturnType<typeof vi.fn>; lines: string[] } {
  const lines: string[] = []
  const warn = vi.fn((msg: string, meta?: unknown) => {
    lines.push(`${msg} ${JSON.stringify(meta ?? null)}`)
  })
  return { warn, lines }
}

describe('guardedHandle (#252)', () => {
  it('refuses a foreign webContents id with a content-free log, and the handler never runs', async () => {
    handlers.clear()
    const trusted = createTrustedSenders()
    trusted.add(7)
    const body = vi.fn(() => 'ran')
    const log = quietLog()
    guardedHandle('t:refuse', body, { trustedSenders: trusted, log })
    const fn = handlers.get('t:refuse')!
    await expect(Promise.resolve().then(() => fn(makeEvent(99), SECRET_ARG))).rejects.toBeInstanceOf(
      UntrustedSenderError
    )
    expect(body).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.lines.join('\n')).toContain('t:refuse')
    expect(log.lines.join('\n')).not.toContain(SECRET_ARG)
  })

  it('without an injected logger the refusal goes to the app log (production wiring), still content-free', async () => {
    handlers.clear()
    const warn = vi.spyOn(appLog, 'warn').mockImplementation(() => {})
    try {
      const trusted = createTrustedSenders()
      trusted.add(7)
      guardedHandle('t:applog', () => 'ran', { trustedSenders: trusted })
      await expect(
        Promise.resolve().then(() => handlers.get('t:applog')!(makeEvent(8), SECRET_ARG))
      ).rejects.toBeInstanceOf(UntrustedSenderError)
      expect(warn).toHaveBeenCalledTimes(1)
      const said = JSON.stringify(warn.mock.calls[0])
      expect(said).toContain('t:applog')
      expect(said).not.toContain(SECRET_ARG)
    } finally {
      warn.mockRestore()
    }
  })

  it('the trusted id passes and the handler sees the event and its arguments', async () => {
    handlers.clear()
    const trusted = createTrustedSenders()
    trusted.add(7)
    const body = vi.fn((_e: IpcMainInvokeEvent, a: string) => `ok:${a}`)
    guardedHandle('t:pass', body, { trustedSenders: trusted })
    const event = makeEvent(7)
    expect(await handlers.get('t:pass')!(event, 'x')).toBe('ok:x')
    expect(body).toHaveBeenCalledWith(event, 'x')
  })

  it('a sender without an id is refused by a real set (fail closed) — and passes only ANY_SENDER', async () => {
    handlers.clear()
    const trusted = createTrustedSenders()
    trusted.add(7)
    guardedHandle('t:noid', () => 'ran', { trustedSenders: trusted })
    await expect(Promise.resolve().then(() => handlers.get('t:noid')!(makeEvent()))).rejects.toThrow(
      /untrusted sender/
    )
    await expect(Promise.resolve().then(() => handlers.get('t:noid')!(null))).rejects.toThrow(/untrusted sender/)

    guardedHandle('t:any', () => 'ran', { trustedSenders: ANY_SENDER })
    expect(await handlers.get('t:any')!(makeEvent())).toBe('ran')
    expect(await handlers.get('t:any')!(makeEvent(12345))).toBe('ran')
  })

  it('a deleted id is refused again (the set is live, not a snapshot)', async () => {
    handlers.clear()
    const trusted = createTrustedSenders()
    trusted.add(7)
    guardedHandle('t:live', () => 'ran', { trustedSenders: trusted })
    expect(await handlers.get('t:live')!(makeEvent(7))).toBe('ran')
    trusted.delete(7)
    expect(trusted.size()).toBe(0)
    await expect(Promise.resolve().then(() => handlers.get('t:live')!(makeEvent(7)))).rejects.toThrow(
      /untrusted sender/
    )
  })

  it('registration without a trusted set fails loudly instead of refusing every call later', () => {
    handlers.clear()
    const noSet = { trustedSenders: undefined } as unknown as { trustedSenders: TrustedSenders }
    expect(() => guardedHandle('t:missing', () => 'ran', noSet)).toThrow(/no trustedSenders/)
    expect(handlers.has('t:missing')).toBe(false)
  })

  it('a real registrar through a NON-permissive set: the main-window id passes, a foreign id is refused', async () => {
    // The substitute for the live launch smoke where electron.exe cannot run: the audit
    // registrar is wired exactly as production wires it, with a set holding one fake
    // main-window id. The main-window path reaches the handler body (a real query on a real
    // SQLite file); the foreign path never does.
    handlers.clear()
    const MAIN_WINDOW_ID = 4242
    const trustedSenders = createTrustedSenders()
    trustedSenders.add(MAIN_WINDOW_ID)
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-guard-')), 'test.sqlite'))
    const ctx = {
      db,
      workspace: { isUnlocked: () => true, isLocking: () => false },
      trustedSenders
    } as unknown as AppContext
    registerAuditIpc(ctx)
    const fn = handlers.get(IPC.getAuditEvents)!
    expect(fn).toBeDefined()
    expect(await fn(makeEvent(MAIN_WINDOW_ID), 10)).toEqual([])
    await expect(Promise.resolve().then(() => fn(makeEvent(MAIN_WINDOW_ID + 1), 10))).rejects.toThrow(
      /untrusted sender/
    )
    await expect(Promise.resolve().then(() => fn(makeEvent(), 10))).rejects.toThrow(/untrusted sender/)
  })

  it('guardedHandleFor(ctx) binds the context set for a registrar', async () => {
    handlers.clear()
    const trusted = createTrustedSenders()
    trusted.add(3)
    const ipcHandle = guardedHandleFor({ trustedSenders: trusted })
    ipcHandle('t:bound', () => 'ran')
    expect(await handlers.get('t:bound')!(makeEvent(3))).toBe('ran')
    await expect(Promise.resolve().then(() => handlers.get('t:bound')!(makeEvent(4)))).rejects.toThrow(
      /untrusted sender/
    )
  })
})
