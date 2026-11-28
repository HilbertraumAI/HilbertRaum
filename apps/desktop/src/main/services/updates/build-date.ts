// The build date this build embeds (app-update W-17, F-12; docs/app-updates.md §5.10, "The build date's reader"): the
// release commit's committer date, which the build step (apps/desktop/build-date-plugin.ts) writes into the git-ignored
// build-date.json beside this file before the main bundle is made. Read only by the build that carries it.
//
// The file is taken through Vite's import.meta.glob with one literal pattern: the bundler embeds the file's value at
// build time and gives an empty map when the file is missing, so nothing statically needs a file that may not exist
// (the typecheck, vitest, a first build). The main tsconfig carries no Vite client types, so the call is typed by the
// interface below; Vite reads the call once the types are stripped, so its arguments stay literals.
//
// Its value is the object's own `commit_date` when that is a string in §2.4's `issued` grammar, else null (missing,
// null, or malformed: the age reminder and the support notices stay silent). `updates:status` answers it as `buildDate`
// (update-service-deps.ts hands it to the service), which keeps the value in the main bundle, where the release guard
// finds it (§5.10, "The guard's build-date check"). In a test run the file is absent or a developer's leftover, so no
// row reads this value: the support computation takes the date as an argument (§8.4).

import { parseIssued } from './payload'

/** The one form of Vite's import.meta.glob used here: one file, eager, its default export. */
interface BuildDateGlob {
  glob(pattern: './build-date.json', options: { readonly eager: true; readonly import: 'default' }): Readonly<Record<string, unknown>>
}

/** The build-date file's value as the reader takes it: its own `commit_date` in the `issued` grammar, else null. */
export function parseBuildDate(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || !Object.hasOwn(json, 'commit_date')) return null
  const value = (json as Record<string, unknown>).commit_date
  return parseIssued(value) !== null ? (value as string) : null
}

const files = (import.meta as unknown as BuildDateGlob).glob('./build-date.json', { eager: true, import: 'default' })

/** The build date, `YYYY-MM-DDTHH:MM:SSZ`, or null for a build that carries none. */
export const embeddedBuildDate: string | null = parseBuildDate(Object.hasOwn(files, './build-date.json') ? files['./build-date.json'] : undefined)
