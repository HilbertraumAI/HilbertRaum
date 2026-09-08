// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import { I18nProvider } from '../../src/renderer/i18n'
import type { AppStatus, MovedDriveNotice, PreflightResult, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// §5 item 22 (a), owner decision 2026-09-08: the moved-drive check (`prepareFirstBenchmark`)
// runs after every unlock and used to be SILENT. It either restores this computer's stored
// result — re-measuring nothing, so the figures on Performance are dated — or owes a background
// measurement. Home now says which. The three properties under test are the ones that make the
// notice honest rather than decorative:
//
//   1. the two cases do not share a message (a restore is not a measurement);
//   2. while a check is genuinely running, NO action is offered — the notice must never ask for
//      a check that is already under way;
//   3. an ordinary launch shows nothing at all.

const APP_STATUS = {
  workspaceMode: 'plaintext_dev',
  activeModelId: 'qwen3-chat'
} as unknown as AppStatus

const PREFLIGHT = { ok: true, problems: [], slowDriveWarning: null } as unknown as PreflightResult

const RUNTIME: RuntimeStatus = {
  running: true,
  modelId: 'qwen3-chat',
  port: 1,
  healthy: true,
  message: 'Running'
}

afterEach(cleanup)

/** Home with the moved-drive read stubbed; returns the `performance:changed` subscriber. */
function renderHome(notice: MovedDriveNotice | null, over: Record<string, unknown> = {}): { fire: () => void } {
  let subscriber: (() => void) | null = null
  stubApi({
    getAppStatus: vi.fn(async () => APP_STATUS),
    listDocuments: vi.fn(async () => []),
    runPreflight: vi.fn(async () => PREFLIGHT),
    getRuntimeStatus: vi.fn(async () => RUNTIME),
    getMovedDriveNotice: vi.fn(async () => notice),
    onPerformanceChanged: vi.fn((cb: () => void) => {
      subscriber = cb
      return () => {
        subscriber = null
      }
    }),
    ...over
  })
  render(
    <I18nProvider>
      <HomeScreen onNavigate={vi.fn()} />
    </I18nProvider>
  )
  return { fire: () => subscriber?.() }
}

describe('HomeScreen — the moved-drive notice (§5 item 22 (a))', () => {
  it('a RESTORED result says nothing was measured just now, dates the figures, and offers the check', async () => {
    renderHome({ kind: 'restored', ranAt: '2026-08-14T09:00:00Z' })
    const note = await screen.findByText(/This drive was last used on a different computer/)
    // The distinguishing half: the user is told the figures are OLD, with the date they carry.
    expect(note).toHaveTextContent('nothing was measured just now')
    expect(note.textContent).toMatch(/8\/14\/2026/)
    // This case needs a check, so it offers one — reusing the Performance screen's own wording.
    expect(screen.getByRole('button', { name: 'Check this computer' })).toBeInTheDocument()
  })

  it('a restored result with an UNKNOWN date says the same thing without printing "Invalid Date"', async () => {
    // The PR #303 audit H1 sentinel: a legacy blob normalizes to `ranAt: ''`.
    renderHome({ kind: 'restored', ranAt: '' })
    const note = await screen.findByText(/This drive was last used on a different computer/)
    expect(note).toHaveTextContent('nothing was measured just now')
    expect(note.textContent).not.toMatch(/Invalid Date/)
    expect(screen.getByRole('button', { name: 'Check this computer' })).toBeInTheDocument()
  })

  it('a NEW computer says a check is running and offers NO action — one is already under way', async () => {
    renderHome({ kind: 'measuring' })
    const note = await screen.findByText(/This drive has not been used on this computer before/)
    expect(note).toHaveTextContent('A check is running in the background')
    // The teeth of the decision: the notice must not imply a check is needed while one runs.
    expect(screen.queryByRole('button', { name: 'Check this computer' })).not.toBeInTheDocument()
    // And it must not borrow the restore's message either — the two cases are different facts.
    expect(screen.queryByText(/nothing was measured just now/)).not.toBeInTheDocument()
  })

  it('an owed check that never ran offers one, and does not claim a check is running', async () => {
    renderHome({ kind: 'owed' })
    const note = await screen.findByText(/This drive has not been checked on this computer yet/)
    expect(note.textContent).not.toMatch(/running in the background/)
    expect(screen.getByRole('button', { name: 'Check this computer' })).toBeInTheDocument()
  })

  it('the ordinary case shows NO notice at all', async () => {
    renderHome(null)
    // Wait for the mount reads to settle, so this is an absence and not a race.
    await screen.findByText('Workspace')
    expect(screen.queryByText(/This drive/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check this computer' })).not.toBeInTheDocument()
  })

  it('a failed read shows no notice rather than half a message', async () => {
    renderHome(null, {
      getMovedDriveNotice: vi.fn(async () => {
        throw new Error('locked')
      })
    })
    await screen.findByText('Workspace')
    expect(screen.queryByText(/This drive/)).not.toBeInTheDocument()
  })

  it('the notice corrects itself on the performance push, without a remount', async () => {
    // The background measurement this notice announces finishes (or is skipped) under an open
    // Home, so the screen re-reads on `performance:changed` — the same push Performance uses.
    let notice: MovedDriveNotice | null = { kind: 'measuring' }
    const { fire } = renderHome(notice, {
      getMovedDriveNotice: vi.fn(async () => notice)
    })
    await screen.findByText(/A check is running in the background/)

    notice = null
    fire()
    await waitFor(() => expect(screen.queryByText(/A check is running/)).not.toBeInTheDocument())
  })

  it('the action opens the Performance screen, where the check lives', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    stubApi({
      getAppStatus: vi.fn(async () => APP_STATUS),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(async () => PREFLIGHT),
      getRuntimeStatus: vi.fn(async () => RUNTIME),
      getMovedDriveNotice: vi.fn(async (): Promise<MovedDriveNotice> => ({ kind: 'restored', ranAt: '2026-08-14T09:00:00Z' })),
      onPerformanceChanged: vi.fn(() => () => {}),
      // The teeth: Home never runs the benchmark itself — since item 22 (b) the Performance
      // screen is the one place the check is started from.
      runBenchmark: vi.fn()
    })
    render(
      <I18nProvider>
        <HomeScreen onNavigate={onNavigate} />
      </I18nProvider>
    )
    await user.click(await screen.findByRole('button', { name: 'Check this computer' }))
    expect(onNavigate).toHaveBeenCalledWith('performance')
    expect(window.api.runBenchmark).not.toHaveBeenCalled()
  })
})
