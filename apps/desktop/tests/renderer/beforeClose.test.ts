// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWindowSaveRequest } from '../../src/main/close-guard'
import {
  BEFORE_CLOSE_SAVE_BOUND_MS,
  installBeforeCloseBridge,
  registerBeforeClose
} from '../../src/renderer/lib/beforeClose'
import {
  REVIEW_LOCK_FLUSH_BOUND_MS,
  REVIEW_SAVE_DEBOUNCE_MS,
  editReviewItem,
  getReviewSessionSnapshot,
  openReviewSession,
  purgeReviewSession
} from '../../src/renderer/lib/reviewSession'
import type { PreloadApi } from '../../src/preload/index'
import type { SaveBeforeCloseResult } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeItem, reviewMain, stubReviewApi } from '../helpers/evidenceReview'

// #888: closing the window saves the review edits first. Main's real save request
// (`main/close-guard.ts`), the real preload (`onSaveBeforeClose`, with `electron` mocked into a
// two-ended wire) and the real renderer bridge + review store, end to end: what main gets back
// when the window closes with an edit inside its 600 ms pause, one whose write fails, one whose
// write hangs, and nothing open at all. The main-side guard (close once, re-quit, the dialog) is
// tests/unit/close-guard.test.ts's; the language pick's registrant is I18n.test.tsx's.

const wire = vi.hoisted(() => ({
  api: undefined as unknown,
  /** The preload's `ipcRenderer.on` listeners, by channel. */
  renderer: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  /** Where the preload's `ipcRenderer.send` arrives (main's `ipcMain`). */
  toMain: (_channel: string, _payload: unknown): void => undefined
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      wire.api = api
    }
  },
  ipcRenderer: {
    invoke: async () => undefined,
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      wire.renderer.set(channel, listener)
    },
    removeListener: (channel: string) => {
      wire.renderer.delete(channel)
    },
    send: (channel: string, payload: unknown) => wire.toMain(channel, payload)
  },
  webUtils: { getPathForFile: () => '' }
}))

/** Main's side of the window: `ipcMain` and the window's `webContents`, wired to the preload. */
function mainSide(): () => Promise<SaveBeforeCloseResult | null> {
  const ipcMain = new EventEmitter()
  const webContents = Object.assign(new EventEmitter(), {
    send: (channel: string, ...args: unknown[]) => wire.renderer.get(channel)?.({}, ...args),
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoading: () => false
  })
  wire.toMain = (channel, payload) => void ipcMain.emit(channel, { sender: webContents }, payload)
  return createWindowSaveRequest({ ipc: ipcMain, webContents })
}

let uninstall: () => void = () => {}

beforeEach(async () => {
  purgeReviewSession()
  await import('../../src/preload/index')
  uninstall = installBeforeCloseBridge(wire.api as PreloadApi)
})

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    uninstall()
    vi.useRealTimers()
    purgeReviewSession()
  }
})

async function openReview(): Promise<ReturnType<typeof reviewMain>> {
  const detail = makeDetail({ items: [makeItem({ id: 'p1', ordinal: 0 })] })
  const main = reviewMain(detail)
  stubReviewApi(main.api)
  await openReviewSession({ reviewId: detail.id })
  main.order.length = 0
  return main
}

describe('saving before the window closes (#888)', () => {
  it('writes a review edit still inside its 600 ms pause before it answers, then answers saved', async () => {
    vi.useFakeTimers()
    const main = await openReview()
    const ask = mainSide()
    editReviewItem('p1', { reviewerNote: 'typed just before closing' })
    const write = main.holdNext('item')
    let answer: SaveBeforeCloseResult | null | undefined
    void ask().then((a) => (answer = a))
    await vi.advanceTimersByTimeAsync(0)
    // The edit went out at once, not after the pause, and main has no answer while it is written.
    expect(main.order).toEqual(['item:p1'])
    expect(answer).toBeUndefined()
    write.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(answer).toEqual({ unsaved: false })
    expect(main.db().items[0]!.reviewerNote).toBe('typed just before closing')
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    expect(main.order).toEqual(['item:p1']) // written once
  })

  it('a write that fails answers unsaved, and the edit stays queued on screen', async () => {
    const main = await openReview()
    const ask = mainSide()
    editReviewItem('p1', { reviewerNote: 'the drive is full' })
    main.failNext('item')
    expect(await ask()).toEqual({ unsaved: true })
    expect(getReviewSessionSnapshot()).toMatchObject({ saveState: 'error' })
    expect(getReviewSessionSnapshot().detail!.items[0]!.reviewerNote).toBe('the drive is full')
  })

  it('a write that never answers is answered unsaved at the window’s own bound, before main gives up', async () => {
    vi.useFakeTimers()
    const main = await openReview()
    const ask = mainSide()
    editReviewItem('p1', { reviewerNote: 'the drive hangs' })
    main.holdNext('item') // never released
    let answer: SaveBeforeCloseResult | null | undefined
    void ask().then((a) => (answer = a))
    await vi.advanceTimersByTimeAsync(REVIEW_LOCK_FLUSH_BOUND_MS - 1)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    // An answer, not main's "no answer" (null) at CLOSE_SAVE_BOUND_MS: main asks the user.
    expect(answer).toEqual({ unsaved: true })
  })

  it('with nothing open (the lock screen) it answers saved and calls nothing', async () => {
    stubReviewApi() // afterEach: any bridge call is an unmocked one and fails the row
    expect(await mainSide()()).toEqual({ unsaved: false })
  })

  it('a registrant that throws counts as unsaved, and every other registrant still saves', async () => {
    const main = await openReview()
    const ask = mainSide()
    const unregister = registerBeforeClose(() => {
      throw new Error('a store bug')
    })
    try {
      editReviewItem('p1', { reviewerNote: 'still written' })
      expect(await ask()).toEqual({ unsaved: true })
      expect(main.db().items[0]!.reviewerNote).toBe('still written')
    } finally {
      unregister()
    }
  })

  // Review round 2 (S1): a registrant that never settles must not hold back the others' answer past main's bound:
  // main would then close without asking, over a review change that could not be saved.
  it('a registrant that never settles is answered unsaved at the bridge’s bound, while the review still saves', async () => {
    vi.useFakeTimers()
    const main = await openReview()
    const ask = mainSide()
    const unregister = registerBeforeClose(() => new Promise<never>(() => undefined))
    try {
      editReviewItem('p1', { reviewerNote: 'saved meanwhile' })
      let answer: SaveBeforeCloseResult | null | undefined
      void ask().then((a) => (answer = a))
      await vi.advanceTimersByTimeAsync(BEFORE_CLOSE_SAVE_BOUND_MS - 1)
      expect(answer).toBeUndefined()
      expect(main.db().items[0]!.reviewerNote).toBe('saved meanwhile')
      await vi.advanceTimersByTimeAsync(1)
      expect(answer).toEqual({ unsaved: true }) // an answer, not main's null: the user is asked
    } finally {
      unregister()
    }
  })

  it('main.tsx installs the bridge before the first render', () => {
    // Source-text pin (the shutdown.test.ts idiom): main.tsx renders the app on import.
    const src = readFileSync(join(__dirname, '../../src/renderer/main.tsx'), 'utf8')
    expect(src).toMatch(/installBeforeCloseBridge\(window\.api\)[\s\S]*createRoot\(container\)\.render/)
  })
})
