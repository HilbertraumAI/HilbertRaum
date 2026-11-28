import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { build, type Rollup } from 'vite'
import { tempRoot } from '../helpers/db-fixtures'
import { DESKTOP_ROOT } from '../helpers/repo-files'

// The build date's reader (app-update W-17, F-12; docs/app-updates.md §5.10, "The build date's reader"): build-date.ts
// takes build-date.json through Vite's import.meta.glob, so what the app reads is what Vite makes of that call: the
// glob's key, its form (the cast esbuild strips) and the default import. The release guard sees only that the date's
// literal stands in the bundle (§5.10, "The guard's build-date check"), so a reader whose lookup misses the embedded file
// would pass it and every Kit of that build would stay silent (T6.4a review B M-1). Here: the real build-date.ts and every
// file of its folder, copied as they are into a scratch folder (never this checkout's own build-date.json, which is absent
// or a developer's leftover), built through this tree's Vite in memory (build.write: false) with a build-date.json of
// each kind, and the result run by Node.
//
// Why its own file, and in tests/integration: it builds through Vite and runs a second Node, a seam across the bundler
// that build-date.test.ts's unit rows (which watch child_process) should not share.

const UPDATES = join(DESKTOP_ROOT, 'src', 'main', 'services', 'updates')
const SHARED_UPDATES = join(DESKTOP_ROOT, 'src', 'shared', 'updates')
const DATE = '2027-03-15T09:30:00Z'

/** The reader built as the main target builds it, with `fileText` as its build-date.json (null: no file), then run:
 *  the value of its `embeddedBuildDate`. */
async function builtReaderValue(fileText: string | null): Promise<unknown> {
  const scratch = tempRoot('build-date-reader')
  const updates = join(scratch, 'src', 'main', 'services', 'updates')
  cpSync(UPDATES, updates, { recursive: true, filter: (path) => basename(path) !== 'build-date.json' })
  cpSync(SHARED_UPDATES, join(scratch, 'src', 'shared', 'updates'), { recursive: true })
  if (fileText !== null) writeFileSync(join(updates, 'build-date.json'), fileText)
  const entry = join(updates, 'reader-entry.ts')
  writeFileSync(entry, "import { embeddedBuildDate } from './build-date'\nconsole.log(JSON.stringify({ embeddedBuildDate }))\n")
  const result = await build({
    root: updates,
    configFile: false,
    logLevel: 'silent',
    build: { write: false, minify: false, ssr: entry, rollupOptions: { external: [/^node:/], output: { format: 'es' } } },
    ssr: { noExternal: true }
  })
  const [output] = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[]
  const chunk = output!.output.find((o): o is Rollup.OutputChunk => o.type === 'chunk' && o.isEntry)
  const script = join(scratch, 'reader.mjs')
  writeFileSync(script, chunk!.code)
  return (JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' })) as { embeddedBuildDate: unknown }).embeddedBuildDate
}

describe("the build date's reader, built through Vite and run (record §5.10, \"The build date's reader\")", () => {
  it('a dated build-date.json gives that date; a null one and none at all give null', async () => {
    const dated = await builtReaderValue(`{"commit_date":"${DATE}"}\n`)
    const nullFile = await builtReaderValue('{"commit_date":null}\n')
    const noFile = await builtReaderValue(null)
    expect({ dated, nullFile, noFile }).toStrictEqual({ dated: DATE, nullFile: null, noFile: null })
  })
})
