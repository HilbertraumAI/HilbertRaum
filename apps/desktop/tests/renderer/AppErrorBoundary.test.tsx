// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Audit FE-1 (integration) — a screen render throw must show the localized per-screen fallback
// while the nav rail (rendered OUTSIDE the boundary) stays alive, and navigating away must
// re-mount the boundary and clear the error. Force the default Home screen to throw, and give a
// lightweight stand-in for a second destination to prove the reset-on-nav.
vi.mock('../../src/renderer/screens/HomeScreen', () => ({
  HomeScreen: (): JSX.Element => {
    throw new Error('home screen render boom')
  }
}))
vi.mock('../../src/renderer/screens/SkillsScreen', () => ({
  SkillsScreen: (): JSX.Element => <div>skills screen ok</div>
}))

import { App } from '../../src/renderer/App'
import { UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { DEFAULT_SETTINGS, type AppSettings, type PolicyStatus, type WorkspaceStateInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

const unlocked: WorkspaceStateInfo = {
  state: 'unlocked',
  mode: 'plaintext_dev',
  plaintextAllowed: true,
  encryptionRequired: false
}

const offlinePolicy = { offlineMode: true } as PolicyStatus

function stubShell(settings: AppSettings = DEFAULT_SETTINGS): void {
  stubApi({
    getWorkspaceState: vi.fn(async () => unlocked),
    getPolicy: vi.fn(async () => offlinePolicy),
    getSettings: vi.fn(async () => settings),
    onRuntimeNotice: vi.fn(() => () => {}) as never
  } as never)
}

// React logs the caught render error to console.error — silence the noise.
let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  errSpy.mockRestore()
  window.localStorage.clear()
})

describe('App — per-screen error boundary (FE-1)', () => {
  it('shows the localized fallback and keeps the nav rail alive when a screen throws', async () => {
    stubShell()
    render(<App />)
    // The throwing Home screen shows the localized fallback (not a blank window)…
    expect(await screen.findByText('Something went wrong on this screen')).toBeInTheDocument()
    // …and the nav rail survived (it lives outside the boundary), so the user is not trapped.
    const nav = screen.getByRole('navigation')
    expect(within(nav).getByRole('button', { name: /Skills/ })).toBeInTheDocument()
  })

  it('resets the boundary when navigating to another screen (re-mount clears the error)', async () => {
    const user = userEvent.setup()
    stubShell()
    render(<App />)
    await screen.findByText('Something went wrong on this screen')
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Skills/ }))
    // The fresh screen renders and the fallback is gone — navigating away cleared the boundary.
    expect(await screen.findByText('skills screen ok')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong on this screen')).not.toBeInTheDocument()
  })

  it('renders the fallback in German when the UI language resolves to de', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    stubShell({ ...DEFAULT_SETTINGS, uiLanguage: 'de' })
    render(<App />)
    expect(
      await screen.findByText('Auf diesem Bildschirm ist etwas schiefgelaufen')
    ).toBeInTheDocument()
  })
})
