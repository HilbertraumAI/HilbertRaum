// Type declarations for third-party-notices.mjs so the vitest freshness gate
// (apps/desktop/tests/integration/third-party-notices.test.ts) can recompute the EXACT
// output the generator writes without a TS build step for scripts/.
export declare function buildThirdPartyNotices(
  repoRoot: string,
  options?: { warn?: (line: string) => void }
): string
