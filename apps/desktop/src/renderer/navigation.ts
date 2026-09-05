// Central navigation resolution (design-guidelines §2). The app has 8 real screens (Home is
// reached through the brand mark since the 2026-09-05 rail rework: rail = Chat · Documents ·
// Translate · Images ‖ AI Model · Performance ‖ Settings); everything else screens may ask
// for is a VIRTUAL target resolved here:
//   - 'performance'            → the Performance screen (2026-09 performance wave)
//   - 'ask-documents'          → Chat screen opened in documents mode
//   - 'settings:privacy'       → Settings, "Privacy & data" tab
//   - 'settings:diagnostics'   → Settings, "Diagnostics (advanced)" tab
//   - 'settings:skills' / 'skills' → Settings, "Skills" tab (rail rework 2026-09-05: Skills
//     moved back from a rail destination into Settings; both spellings resolve there so every
//     entry point from either era keeps working).
//   - 'privacy' / 'diagnostics' → legacy aliases for the two above, from when these
//     were real screens; every old entry point (offline badge, banners, screen hints)
//     must keep working through them.
// Pure function so the alias table is unit-testable without rendering the app shell.

export type ScreenId =
  | 'home'
  | 'chat'
  | 'documents'
  | 'translate'
  | 'images'
  | 'models'
  | 'performance'
  | 'settings'
  // Evidence review workspace (EP-1 plan §7.1): a full-window screen with NO nav-rail entry.
  // Deliberately NOT resolvable via resolveNavTarget — without a review/message id in App's
  // handoff slot the screen has nothing to show, so 'review' as a plain target falls through
  // to home and the screen is reachable ONLY via App.openReview (the chatScope idiom).
  | 'review'

export type SettingsTab = 'general' | 'privacy' | 'skills' | 'diagnostics'

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
    case 'skills':
      return { screen: 'settings', settingsTab: 'skills' }
    case 'home':
    case 'documents':
    case 'translate':
    case 'images':
    case 'models':
    case 'performance':
      return { screen: target }
    default:
      // Unknown target: land somewhere sensible rather than rendering nothing.
      // 'review' lands here ON PURPOSE (see the ScreenId note): the review screen is
      // meaningless without App's handoff slot, so it never resolves as a plain target.
      return { screen: 'home' }
  }
}
