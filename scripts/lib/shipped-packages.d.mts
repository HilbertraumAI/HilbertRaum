// Type declarations for shipped-packages.mjs so the vitest freshness gate
// (apps/desktop/tests/integration/third-party-notices.test.ts) can import the
// EXACT computation the generator uses without a TS build step for scripts/.
export interface ShippedPackage {
  name: string
  version: string
  /** lockfile / node_modules path of one physical copy, relative to the repo root */
  lockPath: string
}
export declare const RENDERER_BUNDLED_DEV_DEPS: string[]
export declare function computeShippedPackages(repoRoot: string): ShippedPackage[]
