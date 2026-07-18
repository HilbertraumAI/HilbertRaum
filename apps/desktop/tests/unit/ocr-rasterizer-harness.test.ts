import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// OCR-R P5 (ocr-audit 2026-07-18, test-gap #2) — the rasterizer WIRING harness against a
// FAKE electron (the evidence-pack-print-pdf.test.ts pattern). rasterizer.ts drives a
// hidden BrowserWindow through the OCR_RASTER request/reply protocol; before this file
// only the extracted RasterReplySlot was under test — the window lifecycle (destroy on
// success/error/timeout/abort), the one-run in-use latch, the 60 s step timeout, the
// sender-spoof gate, ipcMain listener teardown, and P4's `render-process-gone` fast-fail
// (BE-7) all shipped untested. What a fake electron CANNOT prove — that pdfjs really
// renders in the packaged hidden window — is the packaged-build OCR smoke's job
// (release acceptance, docs/packaging.md).

interface FakeWebContents {
  eventListeners: Map<string, Array<(...a: unknown[]) => void>>
  on: (event: string, fn: (...a: unknown[]) => void) => void
  removeListener: (event: string, fn: (...a: unknown[]) => void) => void
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

interface FakeWin {
  opts: Record<string, unknown>
  webContents: FakeWebContents
  destroyed: boolean
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  destroy: () => void
}

const fake = vi.hoisted(() => {
  const state = {
    windows: [] as FakeWin[],
    /** ipcMain.on registry — teardown leaves every channel EMPTY (asserted per test). */
    ipcListeners: new Map<string, Array<(event: unknown, payload: unknown) => void>>(),
    /** Behavior knobs, reset per test. */
    loadFile: undefined as ((path: string) => Promise<void>) | undefined,
    constructorThrows: false,
    /** The scripted fake renderer: reacts to webContents.send(channel, payload). */
    onSend: undefined as
      | ((win: FakeWin, channel: string, payload: Record<string, unknown>) => void)
      | undefined
  }
  /** Deliver a renderer→main frame (as the preload's ipcRenderer.send would). */
  const emitIpc = (channel: string, event: unknown, payload: unknown): void => {
    for (const fn of [...(state.ipcListeners.get(channel) ?? [])]) fn(event, payload)
  }
  return { state, emitIpc }
})

vi.mock('electron', () => {
  const { state } = fake
  class BrowserWindow {
    opts: Record<string, unknown>
    webContents: FakeWebContents
    destroyed = false
    loadFile = vi.fn(async (path: string) => {
      await (state.loadFile?.(path) ?? Promise.resolve())
    })
    loadURL = vi.fn(async () => {})
    constructor(opts: Record<string, unknown>) {
      if (state.constructorThrows) throw new Error('window construction failed')
      this.opts = opts
      const eventListeners = new Map<string, Array<(...a: unknown[]) => void>>()
      const self = this
      this.webContents = {
        eventListeners,
        on(event: string, fn: (...a: unknown[]) => void) {
          eventListeners.set(event, [...(eventListeners.get(event) ?? []), fn])
        },
        removeListener(event: string, fn: (...a: unknown[]) => void) {
          eventListeners.set(
            event,
            (eventListeners.get(event) ?? []).filter((f) => f !== fn)
          )
        },
        setWindowOpenHandler: vi.fn(),
        send: vi.fn((channel: string, payload: Record<string, unknown>) => {
          state.onSend?.(self as unknown as FakeWin, channel, payload)
        })
      }
      state.windows.push(this as unknown as FakeWin)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  return {
    BrowserWindow,
    ipcMain: {
      on: (channel: string, fn: (event: unknown, payload: unknown) => void): void => {
        state.ipcListeners.set(channel, [...(state.ipcListeners.get(channel) ?? []), fn])
      },
      removeListener: (channel: string, fn: (event: unknown, payload: unknown) => void): void => {
        state.ipcListeners.set(
          channel,
          (state.ipcListeners.get(channel) ?? []).filter((f) => f !== fn)
        )
      }
    }
  }
})

import {
  rasterizePdfWithHiddenWindow,
  RASTER_STEP_TIMEOUT_MS
} from '../../src/main/services/ocr/rasterizer'
import { SECURE_WINDOW_WEB_PREFERENCES } from '../../src/main/window-security'
import { OCR_RASTER } from '../../src/shared/ipc'

const PDF = Buffer.from('%PDF-1.4 fake')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

beforeEach(() => {
  fake.state.windows = []
  fake.state.ipcListeners = new Map()
  fake.state.loadFile = undefined
  fake.state.constructorThrows = false
  fake.state.onSend = undefined
  // Force the prod loadFile branch (a dev-server env var would divert to loadURL).
  delete process.env['ELECTRON_RENDERER_URL']
})

afterEach(() => {
  vi.useRealTimers()
})

const lastWin = (): FakeWin => {
  const win = fake.state.windows.at(-1)
  if (!win) throw new Error('no window was created')
  return win
}

/** Reply frame carrying the WINDOW's own sender — the only sender the collector accepts. */
const reply = (win: FakeWin, channel: string, payload: Record<string, unknown>): void => {
  fake.emitIpc(channel, { sender: win.webContents }, payload)
}

/** Script a well-behaved renderer: opens to `pageCount` pages, answers every render. */
const wellBehavedRenderer = (pageCount: number): void => {
  fake.state.onSend = (win, channel, payload) => {
    queueMicrotask(() => {
      if (channel === OCR_RASTER.open) reply(win, OCR_RASTER.opened, { pageCount })
      if (channel === OCR_RASTER.render) {
        reply(win, OCR_RASTER.page, { pageNumber: payload.pageNumber, png: PNG })
      }
    })
  }
}

const RASTER_CHANNELS = [OCR_RASTER.opened, OCR_RASTER.page, OCR_RASTER.error]

/** Every teardown invariant that must hold after ANY completed run. */
function expectFullTeardown(win: FakeWin): void {
  expect(win.destroyed).toBe(true)
  for (const ch of RASTER_CHANNELS) {
    expect(fake.state.ipcListeners.get(ch) ?? [], `ipcMain listener leaked on ${ch}`).toHaveLength(0)
  }
  expect(
    win.webContents.eventListeners.get('render-process-gone') ?? [],
    'render-process-gone listener leaked'
  ).toHaveLength(0)
}

describe('rasterizePdfWithHiddenWindow — window creation and hardening wiring', () => {
  it('creates a hidden, taskbar-skipped window with the shared hardening prefs + the ocr preload', async () => {
    wellBehavedRenderer(1)
    await rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })
    const win = lastWin()
    expect(win.opts.show).toBe(false)
    expect(win.opts.skipTaskbar).toBe(true)
    const prefs = win.opts.webPreferences as Record<string, unknown>
    expect(prefs).toEqual({ preload: prefs.preload, ...SECURE_WINDOW_WEB_PREFERENCES })
    expect(String(prefs.preload)).toMatch(/[\\/]preload[\\/]ocr\.js$/)
    expect(win.loadFile).toHaveBeenCalledTimes(1)
    expect(String(win.loadFile.mock.calls[0]![0])).toMatch(/[\\/]renderer[\\/]ocr\.html$/)
  })

  it('denies window-open and BOTH navigation events (SEC-3: the worker page never navigates)', async () => {
    wellBehavedRenderer(1)
    await rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })
    const win = lastWin()
    const openHandler = win.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => {
      action: string
    }
    expect(openHandler()).toEqual({ action: 'deny' })
    for (const event of ['will-navigate', 'will-redirect']) {
      const listeners = win.webContents.eventListeners.get(event) ?? []
      expect(listeners, `${event} must be guarded`).toHaveLength(1)
      // Deny-ALL: even the window's own file:// shell is prevented.
      const preventDefault = vi.fn()
      listeners[0]!({ preventDefault }, 'file:///anything.html')
      expect(preventDefault).toHaveBeenCalled()
    }
  })
})

describe('rasterizePdfWithHiddenWindow — success path', () => {
  it('walks every page in order, resolves the page count, and tears everything down', async () => {
    wellBehavedRenderer(3)
    const pages: Array<[number, string]> = []
    let reportedCount = 0
    const result = await rasterizePdfWithHiddenWindow(PDF, {
      onPageCount: (n) => {
        reportedCount = n
      },
      onPage: (pageNumber, png) => {
        pages.push([pageNumber, png.toString('hex')])
      }
    })
    expect(result).toEqual({ pageCount: 3 })
    expect(reportedCount).toBe(3)
    expect(pages).toEqual([
      [1, Buffer.from(PNG).toString('hex')],
      [2, Buffer.from(PNG).toString('hex')],
      [3, Buffer.from(PNG).toString('hex')]
    ])
    expectFullTeardown(lastWin())
  })

  it('one run at a time: a concurrent second call fails fast, the latch releases afterwards', async () => {
    // First run parks forever on the `opened` reply…
    fake.state.onSend = () => {}
    const controller = new AbortController()
    const first = rasterizePdfWithHiddenWindow(PDF, { onPage: () => {}, signal: controller.signal })
    await vi.waitFor(() => expect(lastWin().webContents.send).toHaveBeenCalled())
    // …so the overlapping second call must be refused without touching the first.
    await expect(rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })).rejects.toThrow(
      'PDF rasterizer is busy'
    )
    expect(fake.state.windows).toHaveLength(1) // the busy-reject never created a window
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    // Latch released: a fresh run now succeeds end to end.
    wellBehavedRenderer(1)
    await expect(rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })).resolves.toEqual({
      pageCount: 1
    })
  })

  it('window construction failure resets the latch instead of wedging the rasterizer', async () => {
    fake.state.constructorThrows = true
    await expect(rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })).rejects.toThrow(
      'window construction failed'
    )
    fake.state.constructorThrows = false
    wellBehavedRenderer(1)
    await expect(rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })).resolves.toEqual({
      pageCount: 1
    })
  })
})

describe('rasterizePdfWithHiddenWindow — failure paths destroy the window', () => {
  it('an error frame from the renderer rejects with its message and tears down', async () => {
    fake.state.onSend = (win, channel) => {
      if (channel === OCR_RASTER.open) {
        queueMicrotask(() => reply(win, OCR_RASTER.error, { message: 'bad xref table' }))
      }
    }
    await expect(rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })).rejects.toThrow(
      'bad xref table'
    )
    expectFullTeardown(lastWin())
  })

  it('a wedged renderer hits the 60 s step timeout — not a hang — and tears down', async () => {
    vi.useFakeTimers()
    fake.state.onSend = () => {} // never answers the open request
    const run = rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })
    const failed = expect(run).rejects.toThrow('The page took too long to render')
    // One tick short of the ceiling: still pending (the timeout is exactly 60 s, no less).
    await vi.advanceTimersByTimeAsync(RASTER_STEP_TIMEOUT_MS - 1)
    expect(lastWin().destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await failed
    expectFullTeardown(lastWin())
  })

  it('abort mid-run rejects with AbortError and tears down; a pre-aborted signal never opens a window', async () => {
    fake.state.onSend = () => {} // park on `opened` so the abort races nothing
    const controller = new AbortController()
    const run = rasterizePdfWithHiddenWindow(PDF, { onPage: () => {}, signal: controller.signal })
    await vi.waitFor(() => expect(lastWin().webContents.send).toHaveBeenCalled())
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expectFullTeardown(lastWin())

    // Pre-aborted: fail before any window exists.
    const preAborted = new AbortController()
    preAborted.abort()
    const windowsBefore = fake.state.windows.length
    await expect(
      rasterizePdfWithHiddenWindow(PDF, { onPage: () => {}, signal: preAborted.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.state.windows).toHaveLength(windowsBefore)
  })

  it('render-process-gone fails the run IMMEDIATELY (BE-7 fast-fail, no 60 s burn per step)', async () => {
    // Real timers: the rejection must arrive without ANY clock advance — that is the teeth
    // of P4's fast-fail (pre-fix, a dead renderer silently waited out the step timeout).
    fake.state.onSend = (win, channel) => {
      if (channel === OCR_RASTER.open) {
        queueMicrotask(() => reply(win, OCR_RASTER.opened, { pageCount: 2 }))
      }
      if (channel === OCR_RASTER.render) {
        // The renderer dies instead of answering the first page render.
        queueMicrotask(() => {
          for (const fn of win.webContents.eventListeners.get('render-process-gone') ?? []) {
            fn({}, { reason: 'oom' })
          }
        })
      }
    }
    await expect(rasterizePdfWithHiddenWindow(PDF, { onPage: () => {} })).rejects.toThrow(
      'The renderer process ended while rendering the PDF'
    )
    expectFullTeardown(lastWin())
  })
})

describe('rasterizePdfWithHiddenWindow — sender-spoof gate', () => {
  it('a reply from a FOREIGN sender is ignored on every channel (only our window is trusted)', async () => {
    const foreign = { sender: { id: 'not-our-webcontents' } }
    fake.state.onSend = (win, channel, payload) => {
      queueMicrotask(() => {
        if (channel === OCR_RASTER.open) {
          // Spoofed frames first — page-count lie AND a spoofed error frame. Both must
          // be dropped: the run neither adopts pageCount 99 nor fails with 'spoofed'.
          fake.emitIpc(OCR_RASTER.opened, foreign, { pageCount: 99 })
          fake.emitIpc(OCR_RASTER.error, foreign, { message: 'spoofed failure' })
          reply(win, OCR_RASTER.opened, { pageCount: 1 })
        }
        if (channel === OCR_RASTER.render) {
          fake.emitIpc(OCR_RASTER.page, foreign, { pageNumber: payload.pageNumber, png: new Uint8Array([0xff]) })
          reply(win, OCR_RASTER.page, { pageNumber: payload.pageNumber, png: PNG })
        }
      })
    }
    const pages: string[] = []
    const result = await rasterizePdfWithHiddenWindow(PDF, {
      onPage: (_n, png) => {
        pages.push(png.toString('hex'))
      }
    })
    expect(result).toEqual({ pageCount: 1 }) // the spoofed 99 never landed
    expect(pages).toEqual([Buffer.from(PNG).toString('hex')]) // nor the spoofed page bytes
    expectFullTeardown(lastWin())
  })
})
