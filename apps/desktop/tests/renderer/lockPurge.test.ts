// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { purgeSessionStores } from '../../src/renderer/lib/lockPurge'
import {
  adoptActiveJob,
  getTranslateSession,
  resetTranslateSessionForTests
} from '../../src/renderer/lib/translateSession'
import {
  getFileTranslate,
  translateDroppedFiles,
  resetFileTranslateSessionForTests
} from '../../src/renderer/lib/fileTranslateSession'
import {
  getVisionSession,
  loadSession,
  resetVisionSessionForTests,
  type SelectedImage
} from '../../src/renderer/lib/visionSession'
import type { ImageTurn } from '../../src/renderer/images'
import {
  getReviewSessionSnapshot,
  openReviewSession,
  editReviewItem,
  resetReviewSessionForTests
} from '../../src/renderer/lib/reviewSession'
import { stubApi } from '../helpers/renderer'
import { makeDetail } from '../helpers/evidenceReview'

// TA-2 / H3: the renderer lock purge used to be a dead screen effect (gated on a component-state
// `locked` flag that lock unmounts before it can fire). It now lives at the real seam,
// `App.lockNow` → `purgeSessionStores`. This suite pins the helper: all FOUR module-level session
// stores (text translation, document translation, vision, evidence review — EP-1 plan §7.5)
// return to their EMPTY snapshots, and the mid-stream "stuck busy" shape is cleared (no
// re-adoption of a job main has already aborted). The review store's FLUSH-before-lock ordering
// is pinned separately in ReviewLockSeam.test.tsx — this file covers the purge half.

const CHOICE = { sourceLang: 'de', targetLang: 'en' } as const

const RUNNING_TRANSLATE = { jobId: 'j9', state: 'translating' as const, text: 'geheim' }

function fakeImage(): SelectedImage {
  return {
    decoded: { dataUrl: 'data:image/png;base64,AA', mimeType: 'image/png', width: 1, height: 1 } as never,
    name: 'secret.png',
    sizeBytes: 42
  }
}

const HIST_TURN: ImageTurn = { id: 't1', question: 'what is this?', answer: 'a secret', state: 'done', error: null }

afterEach(() => {
  resetTranslateSessionForTests()
  resetFileTranslateSessionForTests()
  resetVisionSessionForTests()
  resetReviewSessionForTests()
  vi.restoreAllMocks()
})

describe('purgeSessionStores — the real lock seam (TA-2)', () => {
  it('drops resident content from all four session stores', async () => {
    stubApi({
      // Text translation: a still-running job re-adopted into the store (source/translation resident).
      getActiveTranslateJob: vi.fn(async () => RUNNING_TRANSLATE),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {}),
      // Document translation: import never resolves, so the store stays 'importing'/busy.
      getDroppedFilePath: vi.fn(() => 'C:\\docs\\secret.pdf'),
      importDocuments: vi.fn(() => new Promise(() => {})),
      // Evidence review: an open review with a pending (unsaved) note edit resident.
      getEvidenceReview: vi.fn(async () => makeDetail())
    } as never)

    // Seed the document store FIRST — `runImport` clears the text store as it starts, so seeding the
    // text store afterwards is the realistic order (each path resets the other on a real start).
    void translateDroppedFiles([new File(['%PDF'], 'secret.pdf', { type: 'application/pdf' })], CHOICE)
    expect(getFileTranslate().state).toBe('importing')
    expect(getFileTranslate().busy).toBe(true)

    await adoptActiveJob()
    expect(getTranslateSession().output).toBe('geheim')
    expect(getTranslateSession().activeJobId).toBe('j9')

    loadSession(fakeImage(), [HIST_TURN], 'sess1')
    expect(getVisionSession().selected).not.toBeNull()
    expect(getVisionSession().turns).toHaveLength(1)

    // Evidence review: decrypted answer/source snapshots + an unsaved note resident.
    await openReviewSession({ reviewId: 'r1' })
    editReviewItem('i1', { reviewerNote: 'resident plaintext note' })
    expect(getReviewSessionSnapshot().detail).not.toBeNull()
    expect(getReviewSessionSnapshot().saveState).toBe('pending')

    purgeSessionStores()

    // Text store back to EMPTY.
    expect(getTranslateSession()).toMatchObject({
      activeJobId: null,
      output: '',
      state: 'idle',
      error: null,
      translating: false
    })
    // Document store back to EMPTY.
    expect(getFileTranslate()).toMatchObject({
      state: 'idle',
      fileName: null,
      output: '',
      busy: false,
      resultDocumentId: null
    })
    // Vision store back to EMPTY.
    expect(getVisionSession()).toMatchObject({
      selected: null,
      turns: [],
      sessionId: null,
      activeJobId: null,
      analyzing: false
    })
    // Review store back to EMPTY — detail AND the pending (unsaved) edit are gone. The
    // flush of that edit happens BEFORE lockWorkspace (App.lockNow — ReviewLockSeam pins
    // the order); by purge time nothing may remain resident.
    expect(getReviewSessionSnapshot()).toMatchObject({
      detail: null,
      loading: false,
      openError: null,
      saveState: 'idle',
      saveError: null
    })
  })

  it('clears the stuck-busy text shape so a later adopt with no active job stays idle', async () => {
    // A mid-stream text session locks while `translating: true`; main's `jobs.stop()` emits no
    // `trError`, so before TA-2 the store returned after unlock stuck busy. Purge resets it, and a
    // subsequent remount `adoptActiveJob()` (no active main job) must leave it idle, not re-stuck.
    stubApi({
      getActiveTranslateJob: vi.fn(async () => RUNNING_TRANSLATE),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    } as never)
    await adoptActiveJob()
    expect(getTranslateSession().translating).toBe(true)

    purgeSessionStores()
    expect(getTranslateSession().translating).toBe(false)
    expect(getTranslateSession().state).toBe('idle')

    // Main reports nothing running now (the job was aborted at lock) — adopt is a clean no-op.
    stubApi({ getActiveTranslateJob: vi.fn(async () => null) } as never)
    await adoptActiveJob()
    expect(getTranslateSession().activeJobId).toBeNull()
    expect(getTranslateSession().translating).toBe(false)
    expect(getTranslateSession().state).toBe('idle')
  })
})
