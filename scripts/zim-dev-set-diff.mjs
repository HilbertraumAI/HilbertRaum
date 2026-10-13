// Knowledge-pack converter word check — stage A of the acceptance read (docs/rag-design.md §17,
// "Shipping rule for knowledge-pack changes").
//
// Converts every cached article with two versions of the ZIM converter (`html.ts` and its
// siblings at two git refs, or a ref and the working tree) and compares what retrieval reads:
// the title, the number and labels of the segments, and every segment's words. When all of that
// is identical for every article, the acceptance read cannot differ: the arm's admission windows,
// its chunks, the overlap picker, the reranker and the prompt all read words, never whitespace.
// Only the latency floors are outside this check, and they move by the conversion's own cost.
//
// No dependency beyond Node 24 (type stripping) and git. Nothing is written to the repository;
// the base version's files are copied to a temporary directory.
//
// Usage (from the repo root):
//   node --no-warnings scripts/zim-dev-set-diff.mjs --pages <dir> [--base <ref>] [--head <ref>] [--json <file>]
//     --pages  a directory of cached article HTML (*.html, searched recursively); defaults to
//              $HILBERTRAUM_ZIM_DEVSET_PAGES. Each top-level subdirectory is reported as a group.
//     --base   git ref of the version before the change (default: origin/master)
//     --head   git ref of the version after it (default: the working tree)
//     --json   also write the full report as JSON
//
// Exit code: 0 = every article reads the same words (the read is identical by construction),
// 1 = at least one article differs (run the full acceptance read), 2 = usage or setup error.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// html.ts imports its siblings without an extension (the bundler's convention); resolve a
// relative, extension-less specifier to its `.ts` file so Node's type stripping can load it.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\\.\\.?\\//.test(specifier) || /\\.[cm]?[jt]s$/.test(specifier)) throw err
    return next(specifier + '.ts', context)
  }
}`)}`
)

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const ZIM_DIR = 'apps/desktop/src/main/services/zim'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const pagesDir = flag('--pages', process.env.HILBERTRAUM_ZIM_DEVSET_PAGES)
const baseRef = flag('--base', 'origin/master')
const headRef = flag('--head', null)
const jsonOut = flag('--json', null)

function fail(message) {
  console.error(`zim-dev-set-diff: ${message}`)
  process.exit(2)
}
/** A setup error once the temporary directory exists: thrown, so the cleanup below still runs. */
class SetupError extends Error {}
if (!pagesDir || !existsSync(pagesDir) || !statSync(pagesDir).isDirectory()) {
  fail('give --pages <dir> (or HILBERTRAUM_ZIM_DEVSET_PAGES): a directory of cached article *.html files')
}

const git = (...args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

/** The converter's directory at `ref`, copied to a temporary directory; returns html.ts's path. */
function checkoutConverter(ref, into) {
  let commit
  try {
    commit = git('rev-parse', '--verify', `${ref}^{commit}`).trim()
  } catch {
    throw new SetupError(`unknown git ref: ${ref}`)
  }
  const files = git('ls-tree', '-r', '--name-only', commit, '--', ZIM_DIR).split('\n').filter((f) => f.endsWith('.ts'))
  if (!files.includes(`${ZIM_DIR}/html.ts`)) throw new SetupError(`${ref} has no ${ZIM_DIR}/html.ts`)
  for (const file of files) {
    const target = join(into, ...file.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, git('show', `${commit}:${file}`))
  }
  return { commit, htmlTs: join(into, ...ZIM_DIR.split('/'), 'html.ts') }
}

const tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-diff-'))
let exitCode = 2
try {
  const base = checkoutConverter(baseRef, join(tmp, 'base'))
  const head = headRef
    ? checkoutConverter(headRef, join(tmp, 'head'))
    : { commit: 'working tree', htmlTs: join(repoRoot, ...ZIM_DIR.split('/'), 'html.ts') }
  const before = await import(pathToFileURL(base.htmlTs).href)
  const after = await import(pathToFileURL(head.htmlTs).href)

  const pages = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.toLowerCase().endsWith('.html')) pages.push(path)
    }
  }
  walk(pagesDir)
  pages.sort()
  if (pages.length === 0) throw new SetupError(`no *.html files under ${pagesDir}`)

  const words = (text) => text.split(/\s+/).filter(Boolean)
  const groups = new Map()
  const changed = []
  for (const page of pages) {
    const rel = relative(pagesDir, page)
    const group = rel.includes(sep) ? rel.split(sep)[0] : '.'
    const g = groups.get(group) ?? { articles: 0, identical: 0, whitespaceOnly: 0, wordsChanged: 0 }
    groups.set(group, g)
    g.articles += 1
    const html = readFileSync(page, 'utf8')
    const a = before.zimArticleToSegments(html)
    const b = after.zimArticleToSegments(html)
    const why = []
    if (a.title !== b.title) why.push(`title ${JSON.stringify(a.title)} → ${JSON.stringify(b.title)}`)
    if (a.segments.length !== b.segments.length) why.push(`segments ${a.segments.length} → ${b.segments.length}`)
    else if (a.segments.some((s, i) => s.sectionLabel !== b.segments[i].sectionLabel)) why.push('a segment label changed')
    const wa = a.segments.map((s) => words(s.text))
    const wb = b.segments.map((s) => words(s.text))
    if (why.length === 0 && wa.some((w, i) => w.join(' ') !== wb[i].join(' '))) why.push('words changed')
    if (why.length === 0) {
      if (a.segments.every((s, i) => s.text === b.segments[i].text)) g.identical += 1
      else g.whitespaceOnly += 1
      continue
    }
    g.wordsChanged += 1
    const flatA = wa.flat()
    const flatB = wb.flat()
    let at = 0
    while (at < flatA.length && flatA[at] === flatB[at]) at += 1
    changed.push({
      page: rel,
      why: why.join('; '),
      words: `${flatA.length} → ${flatB.length}`,
      firstDifference: { before: flatA.slice(at, at + 12).join(' '), after: flatB.slice(at, at + 12).join(' ') }
    })
  }

  const total = [...groups.values()].reduce(
    (t, g) => ({
      articles: t.articles + g.articles,
      identical: t.identical + g.identical,
      whitespaceOnly: t.whitespaceOnly + g.whitespaceOnly,
      wordsChanged: t.wordsChanged + g.wordsChanged
    }),
    { articles: 0, identical: 0, whitespaceOnly: 0, wordsChanged: 0 }
  )
  console.log(`base ${baseRef} (${base.commit.slice(0, 8)}) → head ${headRef ?? 'working tree'} (${head.commit.slice(0, 8)})`)
  console.log('group                                   articles  identical  whitespace-only  WORDS CHANGED')
  for (const [name, g] of [...groups].sort()) {
    console.log(
      `${name.padEnd(40)}${String(g.articles).padStart(8)}${String(g.identical).padStart(11)}${String(g.whitespaceOnly).padStart(17)}${String(g.wordsChanged).padStart(15)}`
    )
  }
  for (const c of changed.slice(0, 20)) {
    console.log(`  ${c.page}: ${c.why} (words ${c.words}); before "${c.firstDifference.before}" | after "${c.firstDifference.after}"`)
  }
  if (changed.length > 20) console.log(`  … and ${changed.length - 20} more (see --json)`)
  const identical = total.wordsChanged === 0
  console.log(
    identical
      ? `VERDICT: WORDS IDENTICAL on all ${total.articles} articles — the acceptance read is identical by construction (latency aside).`
      : `VERDICT: WORDS CHANGED on ${total.wordsChanged} of ${total.articles} articles — run the full acceptance read.`
  )
  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        { base: { ref: baseRef, commit: base.commit }, head: { ref: headRef ?? 'working tree', commit: head.commit }, total, groups: Object.fromEntries(groups), changed, identical },
        null,
        1
      )
    )
  }
  exitCode = identical ? 0 : 1
} catch (err) {
  if (!(err instanceof SetupError)) throw err
  console.error(`zim-dev-set-diff: ${err.message}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(exitCode)
