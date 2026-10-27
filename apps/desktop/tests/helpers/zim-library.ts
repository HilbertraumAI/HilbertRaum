import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import { readZimHeader } from '../../src/main/services/zim/identity'
import type { PackDeps } from '../../src/main/services/zim/packs'

// The `<book …/>` element a fake kiwix-manage appends to a library.xml (#301). The real
// `kiwix-manage LIBRARY add ZIM` reads the archive's 80-byte header and records its UUID as the
// book id, so the default id here is READ FROM THE FILE (`readZimHeader`): the manager and the
// header agree by construction, exactly as they do with the real binary. A suite that needs a
// manager that disagrees (a name-derived id, the "cannot register" negative) writes its own line.
//
// Defaults are the common case of the suites; a suite passes the attributes it asserts.

export interface LibraryBookOptions {
  /** Default: the archive's own header UUID. */
  id?: string
  /** Default: `Title of <leaf>`. */
  title?: string
  /** Default `Test archive`; null leaves the attribute out. */
  description?: string | null
  language?: string
  date?: string
  /** Default 41; null leaves the attribute out. */
  articleCount?: number | null
  /** Default 7; null leaves the attribute out. */
  mediaCount?: number | null
  /** The archive's `tags` (e.g. `_ftindex:yes`); absent by default. */
  tags?: string | null
}

/** One `<book …/>` line for `zimPath`, its path forward-slashed as kiwix-manage writes it. */
export function libraryBookXml(zimPath: string, o: LibraryBookOptions = {}): string {
  const attrs: string[] = [
    `id="${o.id ?? readZimHeader(zimPath).uuid}"`,
    `path="${zimPath.replace(/\\/g, '/')}"`,
    `title="${o.title ?? `Title of ${basename(zimPath)}`}"`
  ]
  const description = o.description === undefined ? 'Test archive' : o.description
  if (description !== null) attrs.push(`description="${description}"`)
  attrs.push(`language="${o.language ?? 'deu'}"`, `date="${o.date ?? '2026-07-01'}"`)
  if (o.tags != null) attrs.push(`tags="${o.tags}"`)
  const articleCount = o.articleCount === undefined ? 41 : o.articleCount
  if (articleCount !== null) attrs.push(`articleCount="${articleCount}"`)
  const mediaCount = o.mediaCount === undefined ? 7 : o.mediaCount
  if (mediaCount !== null) attrs.push(`mediaCount="${mediaCount}"`)
  return `<book ${attrs.join(' ')} />\n`
}

export function appendLibraryBook(libraryXmlPath: string, zimPath: string, o?: LibraryBookOptions): void {
  appendFileSync(libraryXmlPath, libraryBookXml(zimPath, o))
}

/**
 * A `PackDeps['manageAdd']` that answers like a successful kiwix-manage. `book` picks the
 * attributes per archive; an archive whose leaf contains `rejectLeaf` fails with the real
 * binary's message (`Cannot add ZIM <path> to the library.`).
 */
export function manageAddFromHeader(
  o: { book?: (zimPath: string) => LibraryBookOptions; rejectLeaf?: string } = {}
): PackDeps['manageAdd'] {
  return async (libraryXmlPath, zimPath) => {
    if (o.rejectLeaf !== undefined && basename(zimPath).includes(o.rejectLeaf)) {
      throw new Error(`Cannot add ZIM ${zimPath} to the library.`)
    }
    appendLibraryBook(libraryXmlPath, zimPath, o.book?.(zimPath))
  }
}
