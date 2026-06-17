// Central navigation resolution (design-guidelines §2). The app has 6 real
// destinations; everything else screens may ask for is a VIRTUAL target resolved here:
//   - 'ask-documents'          → Chat screen opened in documents mode
//   - 'settings:privacy'       → Settings, "Privacy & data" tab
//   - 'settings:diagnostics'   → Settings, "Diagnostics (advanced)" tab
//   - 'settings:skills'        → legacy alias for the 'skills' screen, from when Skills was a
//     Settings tab; kept working so old entry points still resolve.
//   - 'privacy' / 'diagnostics' → legacy aliases for the two above, from when these
//     were real screens; every old entry point (offline badge, banners, screen hints)
//     must keep working through them.
// Pure function so the alias table is unit-testable without rendering the app shell.

export type ScreenId = 'home' | 'chat' | 'documents' | 'models' | 'skills' | 'settings'

export type SettingsTab = 'general' | 'privacy' | 'diagnostics'

export interface NavResolution {
  screen: ScreenId
  /** Set when the target picks a Settings tab (plain 'settings' opens General). */
  settingsTab?: SettingsTab
  /** Set when the target picks the Chat screen's composer mode. */
  chatMode?: 'chat' | 'documents'
}

export function resolveNavTarget(target: string): NavResolution {
  switch (target) {
    case 'ask-documents':
      return { screen: 'chat', chatMode: 'documents' }
    case 'chat':
      return { screen: 'chat', chatMode: 'chat' }
    case 'settings':
      return { screen: 'settings', settingsTab: 'general' }
    case 'settings:privacy':
    case 'privacy':
      return { screen: 'settings', settingsTab: 'privacy' }
    case 'settings:diagnostics':
    case 'diagnostics':
      return { screen: 'settings', settingsTab: 'diagnostics' }
    case 'settings:skills':
      return { screen: 'skills' }
    case 'home':
    case 'documents':
    case 'models':
    case 'skills':
      return { screen: target }
    default:
      // Unknown target: land somewhere sensible rather than rendering nothing.
      return { screen: 'home' }
  }
}
