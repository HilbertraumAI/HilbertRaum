// Type declarations for shipped-packages.mjs so the vitest freshness gate
// (apps/desktop/tests/integration/third-party-notices.test.ts) can import the
// EXACT computation the generator uses without a TS build step for scripts/.
export interface ShippedPackage {
  name: string
  version: string
  /** lockfile / node_modules path of one physical copy, relative to the repo root */
  lockPath: string
  /** the lockfile entry's license id, for a package not installed on this host */
  lockLicense: string | null
}
export declare const RENDERER_BUNDLED_DEV_DEPS: string[]
export declare function globToRegExp(glob: string): RegExp
export declare function builderFileNegations(repoRoot: string): RegExp[]
export declare function computeShippedPackages(repoRoot: string): ShippedPackage[]
