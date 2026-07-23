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
  // `txt` joined the filter with licenses/ (LIC-1, 2026-07-12b): the pinned license
  // texts are inlined verbatim into the generated DRIVE-NOTICES.md, so a stray byte
  // there ships onto every drive. The only pre-existing .txt under the covered roots
  // are two plain-ASCII test fixtures (byte-checked when the root was added).
  //
  // AUD-06: `sh|ps1|cmd|command` joined the filter too. Before that, the scripts/ walk below
  // covered only the .mjs files there — the 6 .sh + 8 .ps1 provisioning scripts, which are the
  // ONLY way a fresh machine builds a drive, were unguarded, as were the drive-root launchers
  // (see the launchers/ case below). Both nets share this filter, and the BOM half is the one
  // with teeth for these types: a UTF-8 BOM in front of `#!` breaks shebang recognition, so a
  // BOM'd .sh/.command stops launching with no error a buyer could act on. .ps1/.cmd are kept
  // in the NUL half regardless — a NUL makes git treat the file as binary and ripgrep skip it,
  // which is what let the original class hide.
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(p))
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|json|css|md|html|yml|yaml|txt|sh|ps1|cmd|command)$/.test(entry.name))
        out.push(p)
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

  // LIC-1 (full-audit 2026-07-12b): licenses/*.txt are the pinned upstream license texts
  // that generate-drive-notices.mjs inlines verbatim into DRIVE-NOTICES.md (which ships
  // at the root of every prepared drive) — the same byte-trap class as the manifests.
  it('holds no 0x00 byte in any licenses/ file either', () => {
    const offenders = walk(join(process.cwd(), '..', '..', 'licenses')).filter((p) =>
      readFileSync(p).includes(0)
    )
    expect(offenders).toEqual([])
  })

  // AUD-06: launchers/ was walked by NEITHER net. Its four files (the .cmd, the .command, the
  // .sh and the READ ME FIRST.txt) are copied VERBATIM onto the root of every commercial drive
  // by the drive-build script — they are the first thing a buyer double-clicks, and nothing
  // downstream re-encodes or validates them. Small tree, no node_modules, so the recursive walk
  // is safe.
  it('holds no 0x00 byte in any drive-root launcher file either', () => {
    const files = walk(join(process.cwd(), '..', '..', 'launchers'))
    expect(files.length).toBeGreaterThanOrEqual(4) // the walk really walked (not a moved root)
    expect(files.filter((p) => readFileSync(p).includes(0))).toEqual([])
  })
})

// full-audit 2026-07-12 TQ-1 (BOM half): a UTF-8 BOM is the same authoring-tool byte-trap as
// the literal NUL, with a nastier failure mode for `app-skills/*/SKILL.md` — the frontmatter
// parser looks for `---` at byte 0, so a BOM'd skill file silently stops being a skill. Ban
// the first-3-bytes EF BB BF signature across every root the NUL net covers (same extension
// filter; PowerShell 5.1 writes BOM'd UTF-8 by default on this dev machine, so the class is
// one careless `Out-File` away).
describe('repo hygiene — no UTF-8 BOM in any covered text file (TQ-1)', () => {
  // Same filter as the NUL net above (incl. the LIC-1 `txt` widening for licenses/ and the
  // AUD-06 `sh|ps1|cmd|command` widening — see that net's comment for why shell scripts and
  // the drive-root launchers are the highest-stakes members of this class).
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(p))
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|json|css|md|html|yml|yaml|txt|sh|ps1|cmd|command)$/.test(entry.name))
        out.push(p)
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
  //
  // AUD-06 added launchers/ (the four files copied verbatim onto every commercial drive's root)
  // and, via the shared filter, the scripts/*.{sh,ps1} that were previously invisible to this
  // walk. This is the net that MATTERS for those types: a UTF-8 BOM sits in front of the `#!`,
  // so the kernel/Finder no longer sees a shebang and the launcher silently stops launching on
  // the buyer's machine — no error message, no log, nothing to bisect. The class is one careless
  // `Out-File` away on any Windows dev box (PowerShell 5.1 writes BOM'd UTF-8 by default).
  it('no src/tests/scripts/launchers/docs/app-skills/.github/model-manifests/root-md file starts with EF BB BF', () => {
    const repoRoot = join(process.cwd(), '..', '..')
    const files = [
      ...walk(join(process.cwd(), 'src')),
      ...walk(join(process.cwd(), 'tests')),
      ...walk(join(process.cwd(), 'scripts')),
      ...walk(join(repoRoot, 'scripts')),
      ...walk(join(repoRoot, 'launchers')), // AUD-06: shipped verbatim to the drive root
      ...walk(join(repoRoot, 'model-manifests')),
      ...walk(join(repoRoot, 'licenses')), // LIC-1: pinned texts inlined into DRIVE-NOTICES.md
      ...walk(join(repoRoot, 'docs')),
      ...walk(join(repoRoot, 'app-skills')),
      ...walk(join(repoRoot, '.github')),
      ...readdirSync(repoRoot, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.md$/.test(e.name))
        .map((e) => join(repoRoot, e.name))
    ]
    expect(files.length).toBeGreaterThan(500) // the walk really walked (not a moved root)
    // AUD-06 sub-assertion: the shebang-bearing shipped artifacts are IN the list above. Without
    // this, a future narrowing of the extension filter (or a moved launchers/ root) would take
    // them back out of the walk and leave the net green over a smaller world.
    const covered = files.map((p) => p.replace(/\\/g, '/'))
    for (const shipped of [
      'launchers/start-hilbertraum.sh',
      'launchers/Start HilbertRaum.command',
      'launchers/Start HilbertRaum.cmd',
      'scripts/prepare-drive.sh',
      'scripts/prepare-drive.ps1'
    ]) {
      expect(covered.some((p) => p.endsWith(shipped)), `${shipped} is inside the BOM walk`).toBe(true)
    }
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

// AUD-02 structural latch. Every CONTENT-bearing admission check in main must go through the
// shared `workspaceAdmitsWork(workspace)` predicate (`isUnlocked() && !isLocking()`), never a
// bare `workspace.isUnlocked()`. Reason: `isUnlocked()` means only "the workspace DB handle is
// non-null", and that handle is nulled by the very LAST step of a multi-second, AWAITED lock
// teardown (sidecar suspend, in-flight stream settle, doc-task settle, resident-vector purge).
// Every `ipcMain.handle` yields the main thread at each of those awaits, so an invoke landing
// seconds after the user clicked "Lock now" was dispatched and ADMITTED with `isUnlocked()`
// still true — and the admitted work then lazily RESPAWNED the sidecar the teardown had just
// killed, leaving a multi-GB child holding document-derived text alive while the UI reports the
// workspace locked. ~15 IPC modules were converted from the bare check to the predicate.
//
// Why a repo-level text latch rather than a behavioural test: the IPC lock-coverage meta-test
// exercises handlers with a `{ isUnlocked: () => false }` stand-in, and a BARE `isUnlocked()`
// check satisfies that stand-in exactly as well as the predicate does. A silent drift back to
// the bare form is therefore invisible to every existing behavioural test. This enumerates the
// bare call sites that remain and pins the set.
describe('repo hygiene — bare workspace.isUnlocked() call sites stay allowlisted (AUD-02)', () => {
  const MAIN = join(process.cwd(), 'src', 'main')

  const tsFiles = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...tsFiles(p))
      else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(p)
    }
    return out
  }

  /** Drop comment-only lines and any trailing `// …` tail — the conversion left a lot of prose
   *  that legitimately NAMES `isUnlocked()` while explaining why it must not be used. */
  const codeOf = (line: string): string => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
    return line.replace(/\/\/.*$/, '')
  }

  /**
   * The bare call sites that are NOT admission points. Each is a status/lifecycle read: it asks
   * "is the DB readable right now?" to decide whether a *value* can be fetched (or to drive the
   * lock lifecycle itself), and answering "yes" during a teardown costs nothing — no work is
   * started, no sidecar is respawned.
   *
   * ADD AN ENTRY HERE ONLY IF THE NEW SITE IS ALSO A STATUS/LIFECYCLE READ. If the site decides
   * whether to DO work on behalf of the renderer (start a stream, spawn/ensure a sidecar, run a
   * job, write to the workspace), it is an admission point: use `workspaceAdmitsWork(...)`
   * instead and do not extend this list.
   */
  const ALLOWLIST = [
    // Startup language resolution: reads the uiLanguage setting iff the plaintext-dev workspace
    // is already open at boot. Runs before any lock can be in flight.
    'src/main/index.ts :: if (workspace.isUnlocked()) {',
    // Startup offline-posture log: a locked DB makes `allowNetwork` unreadable → treated as off.
    // A pure read that fail-closes; it never enables anything.
    'src/main/index.ts :: const unlocked = workspace.isUnlocked()',
    // `allowNetworkSetting()` — the network-ceiling READ. Locked ⇒ false (safe default). The
    // module's real admission check (`requireUnlocked`) uses the predicate.
    "src/main/ipc/registerCoreIpc.ts :: ctx.workspace.isUnlocked() ? getSettings(ctx.db).allowNetwork : false",
    // `getAppStatus` — the status surface itself. It must stay answerable DURING a teardown
    // (that is how the renderer learns to swap to the lock gate); it starts no work.
    'src/main/ipc/registerCoreIpc.ts :: const unlocked = ctx.workspace.isUnlocked()',
    // Download gate: the *setting* half of `policyAllows ∧ settingAllows`. Reading it while
    // locking is harmless — the handlers that act on the gate admit via the predicate.
    'src/main/ipc/registerDownloadIpc.ts :: const settingAllows = ctx.workspace.isUnlocked() && getSettings(ctx.db).allowNetwork',
    // Engine-download gate: same shape, same reasoning as the model-download gate above.
    'src/main/ipc/registerEngineIpc.ts :: const settingAllows = ctx.workspace.isUnlocked() && getSettings(ctx.db).allowNetwork',
    // The lock latch's own disarm-on-failure path: it must disarm ONLY while the workspace is
    // genuinely still open. A lock that already closed the DB must KEEP the latch, so the bare
    // check is precisely the intended question here — `workspaceAdmitsWork` would be false
    // mid-teardown and would skip the disarm, stranding the session.
    'src/main/ipc/registerWorkspaceIpc.ts :: if (ctx.workspace.isUnlocked()) ctx.workspace.cancelLock()',
    // Vision status: a display-only availability probe. Locked ⇒ fall back to the build's isDev
    // and a cache miss; it computes install state, it does not load a model.
    'src/main/services/vision/status.ts :: const unlocked = ctx.workspace.isUnlocked()',
    // The predicate itself — this is the one place the bare read is the definition.
    'src/main/services/workspace-vault.ts :: return workspace.isUnlocked() && workspace.isLocking?.() !== true',
    // `getState()` — the controller's own unlocked/locked/uninitialized report.
    "src/main/services/workspace-vault.ts :: const state = this.isUnlocked() ? 'unlocked' : this.vaultExistsOnDisk() ? 'locked' : 'uninitialized'",
    // `unlock()`'s already-open early return — deliberately BEFORE `beginSession()` so an unlock
    // landing mid-teardown cannot disarm the latch or advance the session epoch.
    'src/main/services/workspace-vault.ts :: if (this.isUnlocked()) return this.getState()',
    // `create()`'s refusal to re-create over an open workspace.
    "src/main/services/workspace-vault.ts :: if (this.isUnlocked()) throw new Error('Workspace is already initialized.')"
  ].sort()

  it('every bare isUnlocked() call site under src/main is a known status/lifecycle read', () => {
    const found = new Set<string>()
    const unclassified: string[] = []
    for (const file of tsFiles(MAIN)) {
      const rel = file.slice(join(process.cwd()).length + 1).replace(/\\/g, '/')
      for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
        const code = codeOf(rawLine)
        for (const m of code.matchAll(/isUnlocked\s*(?:\?\.)?\s*\(\s*\)/g)) {
          const before = code.slice(0, m.index)
          const after = code.slice(m.index + m[0].length)
          const entry = `${rel} :: ${code.trim().replace(/\s+/g, ' ')}`
          if (/[.?]\s*$/.test(before)) found.add(entry) // a real `receiver.isUnlocked()` call
          else if (/^\s*:/.test(after)) continue // `isUnlocked(): boolean` — a declaration
          else unclassified.push(entry) // e.g. a destructured/aliased call — fail closed
        }
      }
    }

    // A receiver-less call would slip past the classifier above; refuse to guess.
    expect(unclassified, 'unrecognised isUnlocked() call shape — widen this classifier').toEqual([])

    expect(
      [...found].sort(),
      'A bare `workspace.isUnlocked()` under src/main changed. If the new/changed site decides ' +
        'whether to DO work for the renderer (start a stream, spawn a sidecar, run a job, write ' +
        'to the workspace), it is an ADMISSION point: switch it to `workspaceAdmitsWork(...)` — ' +
        'a bare check admits work for the whole multi-second lock teardown, which then respawns ' +
        'the sidecars the teardown just killed. Only extend the ALLOWLIST above (with a comment ' +
        'saying why) when the site is a pure status/lifecycle READ.'
    ).toEqual(ALLOWLIST)
  })
})
