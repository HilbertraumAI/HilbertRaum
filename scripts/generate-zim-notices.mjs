#!/usr/bin/env node
// Generates one licence/attribution notice per ZIM archive on a drive (#339 P8-4 §4).
//
//   node scripts/generate-zim-notices.mjs --target <drive root> --tools-dir <dir with kiwix-manage> [--dry-run]
//
// Enumerates `<target>/zim/*.zim` (the same filter the app uses — see
// apps/desktop/src/main/services/zim/packs.ts, `readdirSync(...).filter(f =>
// f.toLowerCase().endsWith('.zim'))`), registers each archive into a throwaway
// `kiwix-manage <library.xml> add <zim>` library, and writes `zim/NOTICES/<uuid>.md` from
// whatever the library entry declares. `zim/NOTICES/` is NOT an app-visible directory (the
// app's own *.zim filter never sees it) and is never written at app runtime — this is a
// build-time step only, run after both the kiwix-tools binaries and the ZIM packs are on the
// drive.
//
// Knowable offline: `kiwix-manage`'s `<book …/>` attributes (title, description, language,
// date, articleCount, mediaCount, path, tags) — see `KiwixBook` in
// apps/desktop/src/main/services/zim/client.ts. NOT knowable: creator, publisher, source URL,
// flavour, scraper, or licence — the app reads no `M/` metadata namespace, so this generator
// does not either. The notice states plainly what is NOT known rather than guessing.
//
// Exit codes: 0 ok (including "no archives found") · 1 kiwix-manage failed on some archive ·
// 2 usage error.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const USAGE =
  'usage: node scripts/generate-zim-notices.mjs --target <drive root> --tools-dir <dir with kiwix-manage> [--dry-run]'

function parseArgs(argv) {
  let target = ''
  let toolsDir = ''
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} needs a value`)
      i++
      return v
    }
    if (a === '--target') target = next()
    else if (a === '--tools-dir') toolsDir = next()
    else if (a === '--dry-run') dryRun = true
    else if (a === '-h' || a === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}\n${USAGE}`)
      process.exit(2)
    }
  }
  if (!target) {
    console.error(`--target is required\n${USAGE}`)
    process.exit(2)
  }
  if (!toolsDir) {
    console.error(`--tools-dir is required\n${USAGE}`)
    process.exit(2)
  }
  return { target: resolve(target), toolsDir: resolve(toolsDir), dryRun }
}

/** XML entity decode covering the handful kiwix-manage emits (&amp; &lt; &gt; &quot; &apos;
 *  plus numeric refs) — the same small set `decodeEntities` (zim/html.ts) unescapes. */
function decodeXmlEntities(value) {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** One attribute out of a `<book …/>` tag's attribute string; double-quoted values only —
 *  kiwix-manage always double-quotes, matching client.ts `attrValue`'s supported input. */
function attrValue(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? decodeXmlEntities(m[1]) : null
}

/**
 * Parse `<book …/>` elements out of a kiwix-manage library.xml. The outer regex is
 * character-identical to `parseLibraryXml` (apps/desktop/src/main/services/zim/client.ts:167)
 * — keep in sync with that file if kiwix-manage's output shape ever changes.
 */
function parseLibraryXml(xml) {
  const books = []
  for (const m of xml.matchAll(/<book\s+([^>]*?)\/?>/g)) {
    const attrs = m[1]
    const id = attrValue(attrs, 'id')
    if (!id) continue
    books.push({
      id,
      title: attrValue(attrs, 'title'),
      description: attrValue(attrs, 'description'),
      language: attrValue(attrs, 'language'),
      date: attrValue(attrs, 'date'),
      articleCount: attrValue(attrs, 'articleCount'),
      mediaCount: attrValue(attrs, 'mediaCount'),
      tags: attrValue(attrs, 'tags')
    })
  }
  return books
}

function resolveManagePath(toolsDir) {
  const win = join(toolsDir, 'kiwix-manage.exe')
  const posix = join(toolsDir, 'kiwix-manage')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  throw new Error(`kiwix-manage not found under ${toolsDir} (looked for kiwix-manage(.exe))`)
}

/** The generated per-archive notice. LF-only, no BOM. States plainly what is not knowable. */
function buildNoticeMd(book, leaf) {
  const value = (v, fallback = 'not recorded') => (v === null || v === '' ? fallback : v)
  const lines = []
  lines.push(`# ${value(book.title, leaf)} — knowledge pack notice`)
  lines.push('')
  lines.push(`- **Archive file:** ${leaf}`)
  lines.push(`- **UUID:** ${book.id}`)
  lines.push(`- **Language:** ${value(book.language)}`)
  lines.push(`- **ZIM date:** ${value(book.date)}`)
  lines.push(`- **Articles:** ${value(book.articleCount)} · **Media:** ${value(book.mediaCount)}`)
  lines.push(`- **Tags:** ${value(book.tags, 'none recorded')}`)
  lines.push('')
  lines.push('## Description')
  lines.push('')
  lines.push(value(book.description, '(none recorded)'))
  lines.push('')
  lines.push('## Content licence')
  lines.push('')
  lines.push(
    "This notice is generated entirely from what the archive's own library metadata declares " +
      '(openZIM/Kiwix `kiwix-manage` output) — HilbertRaum reads no `M/` metadata namespace, so ' +
      'the creator, publisher, source URL, scraper, flavour and licence of THIS SPECIFIC archive ' +
      'are NOT knowable offline and are not stated here.'
  )
  lines.push('')
  lines.push(
    'Most kiwix-tools knowledge packs are produced by the openZIM / Kiwix projects from a public ' +
      'source. Archives derived from Wikimedia projects (Wikipedia, Wiktionary, …) are licensed ' +
      '**CC BY-SA 4.0**: reuse requires attribution to each article\'s contributors and share-alike ' +
      'for derivative works. The live version of an article is normally available at ' +
      '`https://<language>.wikipedia.org/wiki/<title>` (network required — offline, the article ' +
      'and its edit history live only inside this archive). Embedded media (images, audio) may ' +
      'carry separate licences recorded on their own description pages. Archives from other ' +
      'sources carry their own terms, which this notice cannot state without the network access ' +
      'this product deliberately does not use.'
  )
  lines.push('')
  lines.push(
    "If the archive's own welcome/front page carries upstream attribution or licence text, that " +
      'page is the more specific and authoritative source — open the archive in the knowledge-pack ' +
      'viewer to read it.'
  )
  lines.push('')
  const output = lines.join('\n')
  if (output.includes('\r')) throw new Error('generated notice must be LF-only')
  return output
}

function main() {
  const { target, toolsDir, dryRun } = parseArgs(process.argv.slice(2))
  const managePath = resolveManagePath(toolsDir)

  const zimDir = join(target, 'zim')
  const leaves = existsSync(zimDir)
    ? readdirSync(zimDir).filter((f) => f.toLowerCase().endsWith('.zim'))
    : []
  if (leaves.length === 0) {
    console.log(`no *.zim archives found under ${zimDir} — nothing to do`)
    process.exit(0)
  }

  const noticesDir = join(target, 'zim', 'NOTICES')
  let failed = false
  let written = 0

  for (const leaf of leaves) {
    const zimPath = join(zimDir, leaf)
    const metaDir = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-notice-'))
    const libraryXmlPath = join(metaDir, 'library.xml')
    try {
      const result = spawnSync(managePath, [libraryXmlPath, 'add', zimPath], { encoding: 'utf8' })
      if (result.status !== 0) {
        console.error(`kiwix-manage failed on ${leaf}: ${result.stderr || result.error || `exit ${result.status}`}`)
        failed = true
        continue
      }
      const books = parseLibraryXml(readFileSync(libraryXmlPath, 'utf8'))
      const book = books[0]
      if (!book) {
        console.error(`kiwix-manage produced no book entry for ${leaf}`)
        failed = true
        continue
      }
      const notice = buildNoticeMd(book, leaf)
      if (dryRun) {
        console.log(`dry-run  ${leaf}  uuid=${book.id}`)
      } else {
        mkdirSync(noticesDir, { recursive: true })
        writeFileSync(join(noticesDir, `${book.id}.md`), notice, 'utf8')
        console.log(`ok  ${leaf}  -> zim/NOTICES/${book.id}.md`)
      }
      written++
    } finally {
      try {
        rmSync(metaDir, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }

  console.log(
    `zim notices: ${written}/${leaves.length} archive(s) ${dryRun ? 'checked (dry run)' : 'written'} into ${noticesDir}`
  )
  process.exit(failed ? 1 : 0)
}

main()
