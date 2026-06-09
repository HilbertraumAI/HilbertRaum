import { vi } from 'vitest'

// Lightweight harness for testing the `register*Ipc` handlers in a node-env vitest run.
//
// The handlers call `ipcMain.handle(channel, fn)` at registration. A test file mocks
// 'electron' (via `vi.hoisted` + `vi.mock`) so `ipcMain.handle` records each handler into
// a shared `Map`, then drives the handlers directly with a fake `IpcMainInvokeEvent`. This
// exercises the REAL handler glue (guards, the in-flight concurrency map, error→result
// mapping, the streaming sender) without Electron — only the IPC transport is faked.

export type IpcHandler = (event: FakeIpcEvent, ...args: unknown[]) => unknown
export type IpcHandlers = Map<string, IpcHandler>

/** A fake `IpcMainInvokeEvent`: records what the handler streams back to the renderer. */
export interface FakeIpcEvent {
  sender: {
    send: ReturnType<typeof vi.fn>
    isDestroyed: () => boolean
  }
}

export function makeEvent(): FakeIpcEvent {
  return { sender: { send: vi.fn(), isDestroyed: () => false } }
}

/** Build the fake `ipcMain` whose `handle` records handlers into `handlers`. */
export function fakeIpcMain(handlers: IpcHandlers): {
  handle: (channel: string, fn: IpcHandler) => void
  removeHandler: (channel: string) => void
} {
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel)
  }
}

/** Invoke a registered handler with a fresh event; returns `{ result, event }`. */
export async function invoke(
  handlers: IpcHandlers,
  channel: string,
  ...args: unknown[]
): Promise<{ result: unknown; event: FakeIpcEvent }> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`No IPC handler registered for "${channel}"`)
  const event = makeEvent()
  const result = await fn(event, ...args)
  return { result, event }
}

/** Invoke a registered handler with a caller-supplied event (to inspect streamed sends). */
export function invokeWithEvent(
  handlers: IpcHandlers,
  channel: string,
  event: FakeIpcEvent,
  ...args: unknown[]
): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`No IPC handler registered for "${channel}"`)
  return fn(event, ...args)
}
