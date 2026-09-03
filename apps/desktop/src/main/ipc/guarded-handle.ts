import { ipcMain, type IpcMainInvokeEvent } from 'electron'

// Every `ipcMain.handle` in the main process goes through `guardedHandle` (#252): the
// handler body runs only for an event whose `sender` (a WebContents) is in the trusted
// set — today the main window alone. The OCR rasterizer window's preload only `send`s
// (its replies are `ipcMain.on` listeners that check identity themselves) and the print
// window has no preload, so neither is trusted for `handle` channels. Today no other
// WebContents can invoke; the guard is load-bearing the moment a webview or a second
// window exists. The repo-hygiene test bans bare `ipcMain.handle(` under `src/main/ipc/**`
// so a registrar cannot bypass it.

/** The set of WebContents ids allowed to invoke `handle` channels. */
export interface TrustedSenders {
  isTrusted(webContentsId: number | undefined): boolean
}

export interface MutableTrustedSenders extends TrustedSenders {
  add(webContentsId: number): void
  delete(webContentsId: number): void
  size(): number
}

/** Production set: empty until `createWindow` adds the main window's `webContents.id`. */
export function createTrustedSenders(): MutableTrustedSenders {
  const ids = new Set<number>()
  return {
    add: (id) => {
      ids.add(id)
    },
    delete: (id) => {
      ids.delete(id)
    },
    size: () => ids.size,
    isTrusted: (id) => typeof id === 'number' && ids.has(id)
  }
}

/** Test-only: the fake IPC harness passes senders with no `webContents.id`. Never used in
 *  production (`index.ts` builds the real set). */
export const ANY_SENDER: TrustedSenders = { isTrusted: () => true }

export class UntrustedSenderError extends Error {
  constructor() {
    super('IPC refused: untrusted sender')
    this.name = 'UntrustedSenderError'
  }
}

/** Handler shape `ipcMain.handle` accepts. */
export type GuardedHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown

export interface GuardedHandleOptions {
  trustedSenders: TrustedSenders
  /** Content-free refusal log (channel name only — never arguments). */
  log?: { warn(msg: string, meta?: unknown): void }
}

/**
 * `ipcMain.handle(channel, …)` with the sender check in front. A refused invoke rejects
 * the renderer's promise with a content-free error and never runs `handler`.
 */
export function guardedHandle(
  channel: string,
  handler: GuardedHandler,
  opts: GuardedHandleOptions
): void {
  const { trustedSenders, log } = opts
  if (typeof trustedSenders?.isTrusted !== 'function') {
    // Fail closed and LOUD at registration: a context without the set would otherwise
    // refuse every invoke at runtime with no hint where the wiring went missing.
    throw new Error(`guardedHandle(${channel}): no trustedSenders in the context`)
  }
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const id = (event as { sender?: { id?: unknown } } | null | undefined)?.sender?.id
    if (!trustedSenders.isTrusted(typeof id === 'number' ? id : undefined)) {
      log?.warn('IPC refused: untrusted sender', { channel })
      throw new UntrustedSenderError()
    }
    return handler(event, ...(args as never[]))
  })
}

/** The registrar-side binding: `const handle = guardedHandleFor(ctx)` then `handle(ch, fn)`. */
export function guardedHandleFor(
  ctx: GuardedHandleOptions
): (channel: string, handler: GuardedHandler) => void {
  return (channel, handler) => guardedHandle(channel, handler, ctx)
}
