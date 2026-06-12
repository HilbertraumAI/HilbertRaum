import type { ThemeSetting } from '@shared/types'

// Theme resolution (design-guidelines §5).
//
// tokens.css defines `:root` as the LIGHT theme and `[data-theme="dark"]` as the dark
// overrides; this module owns the `data-theme` attribute on <html>. The current
// AppSettings.theme is pushed in via `setThemeSetting` once the workspace is unlocked
// (settings live in the possibly-encrypted DB, unreadable before that) — until then the
// app, including the WorkspaceGate, follows the OS via `prefers-color-scheme`.

let setting: ThemeSetting = 'system'
let media: MediaQueryList | null = null

/** Pure mapping from a setting + the OS preference to the applied theme. */
export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): 'light' | 'dark' {
  if (setting === 'system') return prefersDark ? 'dark' : 'light'
  return setting
}

function apply(): void {
  const prefersDark = media?.matches ?? false
  document.documentElement.dataset.theme = resolveTheme(setting, prefersDark)
}

/**
 * Apply a (possibly changed) theme setting. Called when settings load after unlock,
 * when the Settings screen changes the Appearance choice, and with 'system' when the
 * workspace locks (back to the pre-unlock OS-following posture).
 */
export function setThemeSetting(next: ThemeSetting): void {
  setting = next
  apply()
}

/**
 * Install once at startup (before first render): applies the OS theme immediately and
 * keeps 'system' live as the OS theme changes. Safe where matchMedia is missing
 * (jsdom) — resolves to light.
 */
export function initTheme(): void {
  media = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
  media?.addEventListener?.('change', apply)
  apply()
}
