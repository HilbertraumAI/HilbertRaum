// The UI catalogs as the i18n hygiene suites see them (i18n record §5, D-L9): which files under
// `src/shared/i18n/` are catalogs, and the catalog of each registered language. A catalog is
// `src/shared/i18n/<code>.ts` exporting `const <code>`, which `index.ts` puts into `CATALOGS`;
// the registry (`languages.ts`) says which codes exist. Reading the files by that convention
// means a language registered later is covered by every suite here without touching them.
import { join } from 'node:path'
import type { UiLanguage } from '../../src/shared/i18n'
import { DESKTOP_ROOT } from './repo-files'

export const I18N_DIR: string = join(DESKTOP_ROOT, 'src', 'shared', 'i18n')

/** The modules under `shared/i18n/` that are code, not catalogs. */
const NON_CATALOG_MODULES: readonly string[] = ['index.ts', 'languages.ts']

/**
 * Whether `path` is a catalog module: any TypeScript file under `shared/i18n/` other than the
 * two code modules, nested ones included. Deliberately wide: a scan that skips catalogs
 * (they declare every key, so scanning one would mark every key used) skips anything that
 * could be one, and `registeredCatalogCode` then decides whether it really is.
 */
export function isCatalogPath(path: string): boolean {
  const normalized = path.split('\\').join('/')
  const at = normalized.lastIndexOf('/shared/i18n/')
  if (at === -1 || !/\.tsx?$/.test(normalized)) return false
  return !NON_CATALOG_MODULES.includes(normalized.slice(at + '/shared/i18n/'.length))
}

/** The language `path` is the catalog of (`shared/i18n/<code>.ts`, `code` in `codes`), else null. */
export function registeredCatalogCode(path: string, codes: readonly string[]): string | null {
  const match = /\/shared\/i18n\/([^/]+)\.ts$/.exec(path.split('\\').join('/'))
  return match !== null && codes.includes(match[1]) ? match[1] : null
}

// The direct children only: a nested file is never a registered catalog (see above).
const CATALOG_MODULES = import.meta.glob<Record<string, unknown>>('../../src/shared/i18n/*.ts', {
  eager: true
})

/** The catalog of a registered language, as `t` reads it. Throws when the file convention is broken. */
export function catalogOf(code: UiLanguage): Readonly<Record<string, string>> {
  const catalog = CATALOG_MODULES[`../../src/shared/i18n/${code}.ts`]?.[code]
  if (typeof catalog !== 'object' || catalog === null) {
    throw new Error(
      `'${code}' is registered but has no catalog: src/shared/i18n/${code}.ts must export const ${code}`
    )
  }
  return catalog as Record<string, string>
}
