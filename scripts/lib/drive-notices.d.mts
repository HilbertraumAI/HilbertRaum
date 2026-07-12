// Type declarations for drive-notices.mjs so the vitest freshness gate
// (apps/desktop/tests/integration/drive-notices.test.ts) can recompute the EXACT
// output the generator writes without a TS build step for scripts/.
export declare function buildDriveNotices(repoRoot: string): string
