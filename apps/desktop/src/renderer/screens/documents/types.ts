// Shared Documents-screen vocabulary (DX-3 split, full-audit-2026-06-29 follow-up Phase 8).
// A leaf module (no React, no cycles) so the screen and its extracted sibling components
// (DocRow / SectionRail / PreviewModal) all reference the SAME section/view types and the
// remembered-UI localStorage keys without importing each other.

/**
 * The Documents section-rail selection (plan §12.1; regrouped design-guidelines §11.16). The
 * built-in containers (library/temporary/generated/archived/all) plus a project, plus the
 * query-time smart views: 'recent' (an ordering), 'unfiled' (no project), and 'attention' —
 * the ONE diagnostic view, the union of failed imports and stale embeddings (§11.16 retired
 * the size / audio / scan views: they were not problems, so they earned no rail entry).
 */
export type DocSection =
  | { kind: 'library' | 'temporary' | 'generated' | 'archived' | 'all' }
  | { kind: 'recent' | 'unfiled' | 'attention' }
  | { kind: 'project'; id: string }

/** The system locations that fold behind the rail's "More" disclosure (§11.16). */
export type LocationKind = 'library' | 'temporary' | 'generated' | 'archived'

/**
 * The Documents screen's two modes (§11.16): the user's own files, or the knowledge-pack
 * management panel — one destination, a segmented switch in the header. A pack is not a
 * document, so the packs mode renders no section rail and no document affordances.
 */
export type DocumentsMode = 'documents' | 'packs'

/** Per-section document counts the rail shows beside each entry (§11.16). */
export interface RailCounts {
  all: number
  attention: number
  unfiled: number
  library: number
  temporary: number
  generated: number
  archived: number
  /** Documents per project id (active AND archived projects). */
  projects: Record<string, number>
}

/** Remembered collapse state for the Documents sub-nav (section rail). A UI preference, not
 *  user data → localStorage, outside the encrypted workspace. Exported for tests. */
export const RAIL_COLLAPSED_KEY = 'hilbertraum.docs.railCollapsed'
/** Remembered open/closed state of the rail's "More" disclosure (the system locations). */
export const LOCATIONS_MORE_KEY = 'hilbertraum.docs.locationsMoreOpen'
