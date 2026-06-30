// Shared Documents-screen vocabulary (DX-3 split, full-audit-2026-06-29 follow-up Phase 8).
// A leaf module (no React, no cycles) so the screen and its extracted sibling components
// (DocRow / SectionRail / PreviewModal) all reference the SAME section/view types and the
// remembered-UI localStorage keys without importing each other. Relocation only — these were
// module-scope in `DocumentsScreen.tsx`; behavior is unchanged.

/**
 * The Documents section-rail selection (plan §12.1). The built-in containers
 * (library/temporary/generated/archived/all) plus a project, plus the Phase-E
 * query-time smart views (recent/unfiled/needsReindex/large/failed/audio/ocr — §7.6).
 */
export type DocSection =
  | { kind: 'library' | 'temporary' | 'generated' | 'archived' | 'all' }
  | { kind: 'recent' | 'unfiled' | 'needsReindex' | 'large' | 'failed' | 'audio' | 'ocr' }
  | { kind: 'project'; id: string }

/** The rare, diagnostic smart views — folded behind the Views "More" disclosure so the
 *  common filters stay visible and empty diagnostics don't sit on screen. */
export type RareViewKind = 'large' | 'failed' | 'audio' | 'ocr'

/** Remembered collapse state for the Documents sub-nav (section rail). A UI preference, not
 *  user data → localStorage, outside the encrypted workspace. Exported for tests. */
export const RAIL_COLLAPSED_KEY = 'hilbertraum.docs.railCollapsed'
/** Remembered open/closed state of the Views "More" disclosure (rare diagnostic views). */
export const VIEWS_MORE_KEY = 'hilbertraum.docs.viewsMoreOpen'
