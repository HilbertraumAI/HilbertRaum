// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { initTheme, resolveTheme, setThemeSetting } from '../../src/renderer/theme'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 23 theming: the theme module owns `data-theme` on <html>; tokens.css makes
// `:root` light and `[data-theme="dark"]` the dark overrides.

/** Minimal fake for `matchMedia('(prefers-color-scheme: dark)')` with a firable listener. */
function fakeMedia(initialDark: boolean) {
  let listener: (() => void) | null = null
  const media = {
    matches: initialDark,
    addEventListener: (_: string, fn: () => void) => {
      listener = fn
    }
  }
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi.fn(() => media)
  return {
    setOsDark(dark: boolean) {
      media.matches = dark
      listener?.()
    }
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
  delete document.documentElement.dataset.theme
  // Reset module state for the next test (module-level setting survives between tests).
  setThemeSetting('system')
})

describe('resolveTheme', () => {
  it('maps the setting + OS preference to the applied theme', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('theme application on <html>', () => {
  it('initTheme follows the OS and stays live while the setting is system (the pre-unlock gate posture)', () => {
    const os = fakeMedia(true)
    initTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')
    // OS theme changes while on 'system' → live flip (no reload).
    os.setOsDark(false)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('resolves to light when matchMedia is unavailable', () => {
    initTheme()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('setThemeSetting flips data-theme; an explicit choice overrides the OS', () => {
    const os = fakeMedia(false)
    initTheme()
    expect(document.documentElement.dataset.theme).toBe('light')
    setThemeSetting('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    // An OS change must NOT override an explicit choice…
    os.setOsDark(false)
    expect(document.documentElement.dataset.theme).toBe('dark')
    // …until the user goes back to 'system'.
    setThemeSetting('system')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('Settings Appearance card', () => {
  function stubSettings(initial: AppSettings) {
    let current = initial
    const updateSettings = vi.fn(async (patch: Partial<AppSettings>) => {
      current = { ...current, ...patch }
      return current
    })
    stubApi({
      getSettings: vi.fn(async () => current),
      updateSettings
    })
    return { updateSettings }
  }

  it('persists the choice and applies data-theme immediately', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS, theme: 'system' })
    render(<SettingsScreen />)
    const dark = await screen.findByRole('button', { name: 'Dark' })
    await userEvent.click(dark)
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' })
    expect(document.documentElement.dataset.theme).toBe('dark')

    await userEvent.click(screen.getByRole('button', { name: 'Light' }))
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'light' })
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('marks the saved choice as selected', async () => {
    stubSettings({ ...DEFAULT_SETTINGS, theme: 'dark' })
    render(<SettingsScreen />)
    const dark = await screen.findByRole('button', { name: 'Dark' })
    expect(dark).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false')
  })
})
