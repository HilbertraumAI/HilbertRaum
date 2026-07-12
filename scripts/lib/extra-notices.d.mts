// Type declarations for extra-notices.mjs so the vitest freshness gate
// (apps/desktop/tests/integration/third-party-notices.test.ts) can import the
// EXACT pinned texts the generator emits without a TS build step for scripts/.
export interface ExtraNotice {
  /** provenance: exactly where the pinned text was taken from at review time */
  comment: string
  /** the verbatim license text pinned from upstream (LF-only, trimmed) */
  text: string
}
export declare const KNOWN_EXTRA_NOTICES: Record<string, ExtraNotice>
export declare const LEPTONICA_LICENSE: string
