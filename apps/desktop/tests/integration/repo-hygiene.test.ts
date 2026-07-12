import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Issue #49: different npm versions compute the lockfile `peer` flags differently (a
// long-standing npm/Arborist behaviour), so with an unpinned npm every contributor's
// `npm install` rewrote package-lock.json — a permanently dirty lockfile and a broken
// `git pull` loop. The committed lockfile is canonical under the pinned version below;
// installs go through `npm ci` (CI, setup-dev, CONTRIBUTING), which never rewrites it.
describe('repo hygiene — lockfile discipline (issue #49)', () => {
  const rootPkg = JSON.parse(
    readFileSync(join(process.cwd(), '..', '..', 'package.json'), 'utf8')
  ) as { packageManager?: string; engines?: Record<string, string> }

  it('pins the npm version the committed lockfile is canonical under', () => {
    // Exact-version corepack pin. If you bump this, regenerate package-lock.json with the
    // new version in the same commit (npm install --package-lock-only) — the pin and the
    // lockfile must stay canonical together.
    expect(rootPkg.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/)
  })

  it('declares the npm engines floor alongside the node one', () => {
    expect(rootPkg.engines?.node).toBeDefined()
    expect(rootPkg.engines?.npm).toBeDefined()
  })
})

// full-audit 2026-07-11 CODE-24/DOC-12: `analysis/extract.ts` carried a LITERAL NUL byte (a
// hash-domain separator) which made git treat the file as binary — unreviewable text diffs, and
// ripgrep silently skips it (the audit's own greps missed the file). It was rewritten to the
// escape form (byte-identical). This net bans any new literal NUL in source-code files under
// src/**, tests/**, and the repo docs/** so the whole class can't regress: a domain separator or delimiter
// must always be written as an escape. tests/ is included because the class immediately
// recurred there — the CODE-24 fix's own test file shipped with 2 literal NULs in comments,
// caught by review, not by the original src-only net. The extension filter deliberately
// excludes the legitimate BINARY fixtures under tests/ (the .png vision chart, the local-only
// real-data .pdf corpus) — only text/source files must be NUL-free.
describe('repo hygiene — no literal NUL bytes in source (CODE-24)', () => {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(p))
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|json|css|md|html|yml|yaml)$/.test(entry.name)) out.push(p)
    }
    return out
  }

  it('holds no 0x00 byte in any src file (git must see them all as text)', () => {
    const offenders = walk(join(process.cwd(), 'src')).filter((p) => readFileSync(p).includes(0))
    expect(offenders).toEqual([])
  })

  it('holds no 0x00 byte in any tests source file either', () => {
    const offenders = walk(join(process.cwd(), 'tests')).filter((p) =>
      readFileSync(p).includes(0)
    )
    expect(offenders).toEqual([])
  })

  // The class recurred a THIRD time, in docs/: the §47 audit ledger's own CODE-24/DOC-12 row in
  // docs/architecture.md shipped with a literal NUL (the same authoring-tool escape trap), which
  // made every plain grep over that file silently stop mid-file — including the §-anchor
  // retirement legend at its end. Docs are grep-navigated reference material, so they get the
  // same net (the extension filter keeps it to text files).
  it('holds no 0x00 byte in any docs file either', () => {
    const offenders = walk(join(process.cwd(), '..', '..', 'docs')).filter((p) =>
      readFileSync(p).includes(0)
    )
    expect(offenders).toEqual([])
  })

  // …and a FOURTH time, in BUILD_STATE.md, while WRITING UP the docs/ recurrence — the journal
  // entry describing the escape trap fell into it. Root-level .md files (BUILD_STATE, CLAUDE,
  // README, …) are scanned non-recursively: the repo root also holds node_modules, which must
  // never be walked.
  it('holds no 0x00 byte in any repo-root markdown file either', () => {
    const root = join(process.cwd(), '..', '..')
    const offenders = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/.test(e.name))
      .map((e) => join(root, e.name))
      .filter((p) => readFileSync(p).includes(0))
    expect(offenders).toEqual([])
  })

  // full-audit 2026-07-12 TQ-1: `app-skills/*/SKILL.md` ships to the drive and is PARSED for
  // YAML frontmatter — the exact class where a stray byte breaks the skill silently (a BOM
  // recently broke a skill file's frontmatter detection). `.github/*.md` (the CLA texts) is
  // public-facing. Both trees hold only text files under the extension filter (SKILL.md +
  // example .md + schema .json + workflow .yml since the 2026-07-12b widening below) and
  // neither contains node_modules, so the recursive walk is safe.
  it('holds no 0x00 byte in any app-skills or .github text file either', () => {
    const repoRoot = join(process.cwd(), '..', '..')
    const offenders = [
      ...walk(join(repoRoot, 'app-skills')),
      ...walk(join(repoRoot, '.github'))
    ].filter((p) => readFileSync(p).includes(0))
    expect(offenders).toEqual([])
  })

  // full-audit 2026-07-12b TQ-1: the nets never covered .mjs/.cjs/.mts/.yml/.yaml or the
  // scripts/ trees — yet `scripts/lib/shipped-packages.mjs` is IMPORTED by a CI test (a BOM
  // there breaks the suite with an opaque parse error), `apps/desktop/scripts/*.mjs` are
  // executed by node/electron, and `model-manifests/**/*.yaml` are runtime-parsed by the
  // packaged app. The extension filter above now covers those types; this walks the three
  // missing roots (none contains node_modules).
  it('holds no 0x00 byte in any scripts or model-manifests file either', () => {
    const repoRoot = join(process.cwd(), '..', '..')
    const offenders = [
      ...walk(join(repoRoot, 'scripts')),
      ...walk(join(process.cwd(), 'scripts')),
      ...walk(join(repoRoot, 'model-manifests'))
    ].filter((p) => readFileSync(p).includes(0))
    expect(offenders).toEqual([])
  })
})

// full-audit 2026-07-12 TQ-1 (BOM half): a UTF-8 BOM is the same authoring-tool byte-trap as
// the literal NUL, with a nastier failure mode for `app-skills/*/SKILL.md` — the frontmatter
// parser looks for `---` at byte 0, so a BOM'd skill file silently stops being a skill. Ban
// the first-3-bytes EF BB BF signature across every root the NUL net covers (same extension
// filter; PowerShell 5.1 writes BOM'd UTF-8 by default on this dev machine, so the class is
// one careless `Out-File` away).
describe('repo hygiene — no UTF-8 BOM in any covered text file (TQ-1)', () => {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(p))
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|json|css|md|html|yml|yaml)$/.test(entry.name)) out.push(p)
    }
    return out
  }
  const hasBom = (p: string): boolean => {
    const b = readFileSync(p)
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  }

  // 2026-07-12b TQ-1: same three extra roots as the NUL net — scripts/ (root + apps/desktop;
  // shipped-packages.mjs is imported by a CI test, the walk-*.mjs are executed) and
  // model-manifests/ (runtime-parsed .yaml). The shared extension filter also gained
  // mjs|cjs|mts|yml|yaml, which pulls the .github workflow .yml files into this net too.
  it('no src/tests/scripts/docs/app-skills/.github/model-manifests/root-md file starts with EF BB BF', () => {
    const repoRoot = join(process.cwd(), '..', '..')
    const files = [
      ...walk(join(process.cwd(), 'src')),
      ...walk(join(process.cwd(), 'tests')),
      ...walk(join(process.cwd(), 'scripts')),
      ...walk(join(repoRoot, 'scripts')),
      ...walk(join(repoRoot, 'model-manifests')),
      ...walk(join(repoRoot, 'docs')),
      ...walk(join(repoRoot, 'app-skills')),
      ...walk(join(repoRoot, '.github')),
      ...readdirSync(repoRoot, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.md$/.test(e.name))
        .map((e) => join(repoRoot, e.name))
    ]
    expect(files.length).toBeGreaterThan(500) // the walk really walked (not a moved root)
    expect(files.filter(hasBom)).toEqual([])
  })
})

// full-audit 2026-07-12 DOC-1 (hand-off from the Phase-2 de-linkify): docs/build-log.md is the
// FROZEN archive of retired BUILD_STATE entries, relocated from the repo root — where every
// relative `](target)` used to resolve. Phase 2 de-linkified all 258 relocation-broken links
// (targets → inline code, prose byte-identical); the ONLY live relative link left is the
// header's `../BUILD_STATE.md`. This pins that state: any future retirement pass that pastes
// entries in WITH their links (or a "helpful" re-linkify) fails here instead of publishing a
// wall of dead links. Code spans are stripped first (CommonMark pairing) because the archive
// legitimately holds `](…)` sequences inside inline code — a regex/call-syntax fragment and a
// stray-backtick paragraph that never rendered as links (6 such false positives at Phase 2).
describe('repo hygiene — docs/build-log.md holds no relative markdown links (DOC-1)', () => {
  /** Strip fenced blocks + inline code spans (a run of N backticks closes at the next run of
   *  exactly N; an unclosed run is literal text — the CommonMark rule, which is what makes the
   *  archive's stray-backtick paragraph a non-link). */
  const stripCode = (s: string): string => {
    const noFences = s.replace(/^```[\s\S]*?^```/gm, '')
    let out = ''
    let i = 0
    while (i < noFences.length) {
      if (noFences[i] === '`') {
        let n = 1
        while (noFences[i + n] === '`') n++
        let j = i + n
        let closed = -1
        while (j < noFences.length) {
          if (noFences[j] === '`') {
            let m = 1
            while (noFences[j + m] === '`') m++
            if (m === n) {
              closed = j + m
              break
            }
            j += m
          } else j++
        }
        if (closed === -1) {
          out += noFences.slice(i, i + n)
          i += n
        } else i = closed
      } else {
        out += noFences[i]
        i++
      }
    }
    return out
  }

  it('the only relative link is the header ../BUILD_STATE.md pointer, and it resolves', () => {
    const buildLog = join(process.cwd(), '..', '..', 'docs', 'build-log.md')
    const text = stripCode(readFileSync(buildLog, 'utf8'))
    const targets: string[] = []
    for (const m of text.matchAll(/\[[^\]\n]*\]\(([^()\s]+)\)/g)) targets.push(m[1])
    const relativeTargets = targets.filter((t) => !/^https?:\/\//.test(t) && !t.startsWith('#'))
    expect(relativeTargets).toEqual(['../BUILD_STATE.md'])
    for (const t of relativeTargets) {
      expect(existsSync(resolve(dirname(buildLog), t.split('#')[0])), `${t} resolves`).toBe(true)
    }
  })
})

// BUILD_STATE.md restructure (2026-07-12): the handoff file had grown to 1.48 MB / ~11,200
// lines (272 dated entries + retired handoff sections) — larger than any context window and
// beyond a single Read pass, so its own "read this FIRST" instruction silently failed: a
// fresh session got the newest journal entries and never reached the live §1–§9 sections.
// Closed waves' dated entries now retire verbatim (newest-first) to docs/build-log.md and the
// §4 data contracts live in docs/data-contracts.md; this budget makes the retention rule in
// BUILD_STATE's header mechanical instead of human-remembered. If this test fails, MOVE the
// oldest closed waves' entries to the top of docs/build-log.md — do not raise the numbers.
describe('repo hygiene — BUILD_STATE.md stays a one-pass handoff file (retention budget)', () => {
  it('stays under the retention budget (archive closed waves to docs/build-log.md)', () => {
    const raw = readFileSync(join(process.cwd(), '..', '..', 'BUILD_STATE.md'))
    expect(raw.byteLength).toBeLessThanOrEqual(300 * 1024)
    expect(raw.toString('utf8').split('\n').length).toBeLessThanOrEqual(2000)
  })
})
