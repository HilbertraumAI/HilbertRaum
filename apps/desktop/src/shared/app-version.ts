// #896: the comparison behind the skills "needs a newer HilbertRaum" gate (`skillNeedsNewerApp`,
// shared/skill-manifest.ts): the same comparison the model gate makes (`manifestNeedsNewerApp`, shared/manifest.ts),
// which keeps its own copy (below). PURE (no node:, no electron, no I/O), so main, preload and renderer can import it. Each gate keeps its own parse
// of the two version strings and its own answer for a side it cannot read (the model gate fails safe, the skills gate
// fails open); only the comparison of what they read is this one rule, so the two cannot drift apart again on the one
// input where they once did: a pre-release app whose core equals the minimum.
//
// The FROZEN model gate keeps its own copy of these lines instead of importing them: `shared/manifest.ts` is also
// loaded by `scripts/measure-manifest-read.mjs` through Node's type stripping, which resolves no extensionless import
// (`performance-notify.test.ts` runs that script). The agreement matrix in `tests/unit/skill-manifest.test.ts` holds
// the two gates to the same answer on every version both can read.

/** A version's MAJOR.MINOR.PATCH, as numbers. */
export type VersionCore = readonly [number, number, number]

/** The running app's version as a gate read it: its core, and whether a `-pre.release` suffix follows the core. */
export interface AppVersionRead {
  core: VersionCore
  prerelease: boolean
}

/**
 * True when the app falls short of `min`. The three parts compare as numbers (`0.1.100` is newer than `0.1.65`); on
 * an equal core a pre-release app is OLDER than the release (semver: `0.1.66-beta.1` does not meet `0.1.66`). Build
 * metadata has no say (semver: no precedence), so a caller never reports it as a pre-release.
 */
export function appOlderThanMinimum(app: AppVersionRead, min: VersionCore): boolean {
  for (let i = 0; i < 3; i++) {
    if (app.core[i] !== min[i]) return app.core[i] < min[i]
  }
  return app.prerelease // the same release: a pre-release of it does not meet it
}
