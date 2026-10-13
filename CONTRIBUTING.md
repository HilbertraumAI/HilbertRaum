# Contributing — HilbertRaum

Thanks for your interest! This project values **privacy, portability, and boring reliable tech**.
By participating you agree to abide by our [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License and CLA

The HilbertRaum software is licensed under **[GPL-3.0-or-later](LICENSE)**, and the core will
stay under GPL-3.0-or-later — see the promise in the [README](README.md#license).

Before we can merge your first pull request, you need to sign our
**[Contributor License Agreement (CLA)](.github/CLA.md)**. The CLA bot prompts you automatically
on the PR; signing is a single PR comment and is required only once. (Make sure the e-mail on
your commits is linked to your GitHub account, or the bot can't attribute your signature.)

**Why a CLA?** We plan to fund the open development of HilbertRaum by also offering the software
under commercial licenses (dual licensing) — for example tailor-made solutions for small
businesses. The CLA gives the project the right to do that with your contribution too. You keep
all rights to your own work and can use it however you like. A plain DCO sign-off is not
sufficient for this, which is why we ask for the CLA.

If you contribute as part of your job, your employer may need to sign the
[Corporate CLA](.github/CLA-corporate.md) — ask us, we will sort it out quickly.

**Third-party code:** do not paste in code you did not write. If a dependency or snippet is
needed, flag it in the PR so we can check the license (GPL-3.0-or-later compatibility) — see
also CLA §7 for submissions on behalf of third parties.

## Ground rules (non-negotiable)
- No cloud dependencies, hosted AI APIs, telemetry, or analytics.
- Keep the app fully usable offline.
- Never commit model weights, user data, embeddings, logs, or generated files.
- No hardcoded absolute developer paths; support Windows/macOS/Linux.
- Keep service boundaries clean so runtimes can be swapped.

## Workflow
1. Read [`BUILD_STATE.md`](BUILD_STATE.md) and [`CLAUDE.md`](CLAUDE.md) (hard rules + the per-phase ritual).
2. Work one **phase / vertical slice** at a time.
3. Add tests for new logic (`npm test`); keep `npm run typecheck` clean.
4. **Update docs and `BUILD_STATE.md` at the end of each phase** (mandatory ritual).
5. Open a focused PR referencing the phase/milestone.

## Commits & pull requests
- **IMPORTANT: no direct pushes to `master`.** The repo is public; `master` is protected
  (`ci-success` required, changes through pull requests). This applies to maintainers and
  automation too: never use bypass rights to push to `master` directly, docs included.
- Commit messages follow **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, …), often
  scoped (e.g. `feat(image-understanding): …`). Keep each PR a focused vertical slice.
- A PR is not done until: `npm test` is green, `npm run typecheck` is clean, affected `docs/` are
  updated, and `BUILD_STATE.md` records the change (the mandatory per-phase ritual).

## Dev setup
Requires **Node.js ≥ 22.12** (Node 24 recommended), per `package.json` `engines`. For the repo layout
and a map of the docs, see the **[README](README.md)** ("For developers" + "Documentation").
```bash
npm ci              # fresh clone AND after every pull — installs exactly per package-lock.json
npm run dev
npm test            # the whole suite (root; delegates to the apps/desktop workspace)
npm run typecheck
npm run test:coverage  # optional: suite + V8 coverage report (writes coverage/, gitignored; not a CI gate)
```

**Behind a TLS-intercepting corporate proxy, `npm ci` can hang silently.** Run the one-shot
bootstrap `scripts/setup-dev.{ps1,sh}` instead of a bare `npm ci`: it probes for and sets
`NODE_OPTIONS=--use-system-ca` (Node ≥ 22.15) so the install reads the system cert store, then runs
`npm ci` + build + test. (Older Node continues without the flag; last resort, dev-only:
`npm config set strict-ssl false`.)

**Install with `npm ci`, not `npm install`** (issue #49): different npm versions compute the
lockfile's `peer` flags differently, so a plain `npm install` under another npm rewrites
`package-lock.json` and leaves it permanently dirty (and the next `git pull` complains). `npm ci`
installs exactly what the lockfile pins and never rewrites it. If you hit the dirty-lockfile loop:
`git checkout -- package-lock.json && npm ci`. Only use `npm install` when you deliberately change
dependencies, with the pinned npm version (`packageManager` in `package.json`, `npm@11.6.2` — the
version the committed lockfile is canonical under; with corepack enabled it is picked up
automatically).

**Faster test iteration** (the whole suite is large). From the repo root:
```bash
npm test -- tests/unit/some-file.test.ts                  # one file
npm test -- tests/unit/some-file.test.ts -t "a name"      # tests in that file whose name contains "a name"
npm test -- -t "a test-name substring"                    # by name across the suite (still loads every file)
npm run test:watch --workspace apps/desktop -- tests/unit/some-file.test.ts   # watch mode
```
- **The test path is relative to `apps/desktop`**, where the test script runs. A path that starts with
  `apps/desktop/` matches nothing: vitest prints "No test files found" and exits with code 1.
- **Windows PowerShell with a `Restricted` or `AllSigned` execution policy** refuses both `npm` and
  `npx`, because their `.ps1` launchers are unsigned. Type `npm.cmd` / `npx.cmd` instead, for example
  `npm.cmd test -- tests/unit/some-file.test.ts`.
- **Windows: run the tests from the path as the file system spells it (`C:\…`, not `c:\…`).** Some
  terminals, VS Code's among them, open in `c:\…`. Builds and `npm run dev` work from either
  spelling. Vitest does not: from `c:\…` it stops at once with a message naming the real spelling.
  Change to it (PowerShell: `Set-Location 'C:\path\to\HilbertRaum'`) and run again. The cause and the
  build-side fix: [`docs/packaging.md`](docs/packaging.md) "Build paths — design record (#646)".
- **From `apps/desktop`** the direct forms work too: `npx vitest run tests/unit/some-file.test.ts`,
  `npx vitest run -t "a test-name substring"` and `npm run test:watch`.
- **Window security wiring is pin-tested.** The `webPreferences` hardening flags, the CSP
  strings, and the window-open policy live in `apps/desktop/src/main/window-security.ts`,
  pinned literal-by-literal by `tests/unit/window-security.test.ts` — do **not** edit CSP or
  `webPreferences` inline in `index.ts`/the OCR rasterizer; change the module next to its tests
  (a deliberate change there is a deliberate security decision).
- **Temp roots are cleaned up by the harness (issue #335).** A suite may mint its scratch root
  with `mkdtempSync(join(tmpdir(), 'hilbertraum-<suite>-'))` (or an `hr-` prefix) and forget it:
  `tests/setup-temp-roots.ts` records every such root a file creates directly under the OS temp
  dir and removes them in that file's `afterAll`; a root an open sqlite handle still locks on
  Windows is swept by `tests/global-temp-roots.ts` after the forks exit (design and the pure
  helpers: `tests/helpers/temp-roots.ts`). Before this, a full run left ~2,500 roots behind.
  Still close your DB handles in a teardown where you can (the Performance fixture's
  `closePerformanceFixture()` is the model) — the sweep is the safety net, not the plan.
- **No fixed sleeps in tests — gate on observable state.** A `setTimeout(r, N)` that waits for
  "the loop to probably get there" flakes under parallel-fork CPU starvation. Instead, expose a
  "reached" flag/promise from the fake seam or poll-until on observable state with a hard
  timeout ceiling — exemplars: `tests/integration/ocr-task.test.ts` (the `rasterizeReached`
  gate replacing a fixed `sleep(30)`), `tests/integration/vision-runtime.test.ts` (the
  injected-clock idle-teardown interlock) and `tests/integration/lock-admission-race.test.ts`
  (the `settleEntered` gate plus the `settleOutcomes` recorder: the settle's own verdict instead
  of a wall clock measured against the very production bound under test, #389). The rare *justified* fixed sleep — a
  wall-clock advance for timestamp ordering, a timeout simulation where the timer IS the semantics, a
  single-macrotask hop with no observable — must carry a comment saying so; everything else
  is a bug.
- **Type renderer stub payloads — don't reach for `as never`.** `stubApi(overrides)` takes
  `Partial<PreloadApi>` (`tests/helpers/renderer.ts`) so a stub's shape is checked against the real
  preload bridge; a blanket `... as never` opts it out, and a later shared-type rename leaves the
  stub compiling against a stale shape (vacuous green). Build payloads with typed factories that
  return the real shared type (the `runtimeStatus`/`appStatus`/`docTask` pattern in
  `HomeScreenPoll`/`TranslateScreen`/`fileTranslateSession`); for a deliberately-partial "keep the
  shell calm" payload use a narrow, named `as unknown as <Type>` at exactly that value, never a
  blanket `} as never)`. A one-way ratchet (`tests/unit/as-never-ratchet.test.ts`) fails if the
  tests/ `as never` count climbs — the remaining casts get converted **fix-when-touched** (lower
  the ratchet baseline when you remove some).
- **An eval measures production, not a copy of it.** The skill-trigger eval once scored its corpus
  through a hand-written copy of the selector, and its auto-fire gate never compared that copy with
  production; it stayed green while production missed the bar. Drive the production entry point —
  `tests/eval/skill-triggers.ts` runs every row through `suggestSkillsForTurn` /
  `resolveAutoFireSkill` on a real temp database.
- **A negative must fail for the reason its title gives.** `not.toContain`, `toEqual([])`,
  `toBeNull()` and "nothing persisted" checks pass just as well when the input never reaches the
  guard you mean (a reader that throws before any persist step; an ID that a filler check rejects
  before the totals reader). Make the input reach that guard, and break the guard once to watch the
  test go red.
- **Write invisible characters as `\u` escapes, never raw.** A fixture with a raw NBSP / U+2011 /
  U+2007 looks like its ASCII sibling; whitespace normalisation (an editor, a formatter, some
  editing tools) silently turns the Unicode row into a duplicate. Check the diff after editing such
  a fixture.
- **One behavioural row per listed keyword.** A parity test (SKILL.md ⇔ vocabulary) cannot see a
  term dropped from both lists; the trigger corpus pins each listed keyword with a question that hits
  only that keyword.
- **Shared skills test setup lives in `tests/helpers/`** — `db-fixtures` (temp roots, fresh DBs),
  `doc-fixtures`, `skill-fixtures` (SKILL.md packages, skill dirs), `skill-contexts`,
  `audit-capture`, `db-spy`, `scripted-runtime`, `skills-world` (the skills-IPC and RAG-ask
  contexts; the importing file must `vi.mock('electron', …)`) and `chat-fixtures`. Extend them
  rather than copying setup into a new suite; keep a local copy only where it deliberately differs.
- **Pin the bound that ships, not a shorter test-only one.** `RuntimeManager` once took timing
  options only tests passed: they proved a 50 ms teardown bound and a 0 or 60,000 ms probe TTL while
  5 s and 10 s shipped, and a probe test passed with the start's probe time never recorded. Drive
  the real constant with fake timers (`vi.useFakeTimers({ toFake: ['performance'] })` for a
  `performance.now()` clock) and advance to just past it, and to just short of it.
- **`expect(() => fn()).not.toThrow()` proves nothing when `fn` is async**: a rejection is not a
  throw. Await the outcome, or call `fn` again and assert what the guard re-armed.
- **The start-ladder fake lives in `tests/helpers/ladder-harness.ts`** (fake rungs and their stderr,
  the probe, prefetch, warm-up and every ladder hook recorded), shared by `runtime-ladder.test.ts`
  and `placement-wiring.test.ts`. Its `chatCalls` records only the fake llama's stream, never the
  mock's: a "never warms up / never prefetches" negative reads the ladder's own `warmups` /
  `prefetchEvents`. Suites whose rungs are the real `LlamaServer` keep their own harnesses.
- **The llama-server sidecar fakes live in `tests/helpers/fake-sidecar.ts`**, shared by the
  embedder, reranker, vision and translation suites: `FakeChild`, `GatedChild` (holds its exit
  until `releaseExit()`), `exitingChild` (writes stderr and dies before it is healthy), `fakeSpawn`
  (a fresh child per spawn), `sseBody`, `fakeIdleClock` and `loadingSidecar` (`/health` answers
  503 until loaded; a hanging probe would hide a mutation that cancels the start). Extend the
  helper instead of declaring another child class in a suite.
- **A fake event must reach a live listener.** `LlamaServer` stops hearing a child once its own
  teardown has started, so the vision and translation rows "a late crash does not clobber the newer
  instance" emitted an `exit` nothing listened to, and stayed green with the runtimes' "is this
  still my server?" check deleted. Send an event the code still hears (there: the old child's
  `error`, then its `exit`), and break the guard once to watch the row go red.
- **Where several guards stop the same harm, assert what the one you mean prevents.** A lock
  during translation's GPU start is kept off the CPU rung by more than one check, so "one spawn"
  stayed true with the start-abort check deleted; only the device-fallback note, which that check
  alone prevents, showed the break.
- **The doc-task world lives in `tests/helpers/doctask-fixtures.ts`**: `docTaskWorld` (temp root,
  DB, document store), `importText` / `importWords` through the real ingestion pipeline,
  `docTaskManager` on harmless default deps, `docTaskRuntime` (scripted, abort-aware, counts
  concurrency) and `waitTerminal`. The ModelSlotArbiter fake clock is `tests/helpers/slot-clock.ts`.
  Ten suites used to carry their own copies.
- **A registrar's locked-vault proof is its `MODULES` entry in `ipc-lock-coverage.test.ts`**, which
  drives every channel and names each exempt one with its reason. A hand-picked lock test in the
  module's own suite drifts: docs-ipc's checked 5 of the 14 gated `docs:*` channels, and
  doctasks-ipc's checked 1 of 3.
- **An IPC copy of a service guard needs an IPC-specific risk** (routing, a sender check, the lock
  gate, error mapping). doctasks-ipc re-proved the manager's "refuse while chat streams" and
  "exactly two documents" checks through a handler that forwards them unchanged, while the one IPC
  risk there, routing a cancel to the right task id (#157), had no test.
- **When a delay starts guarding an action, negatives about that action must look past the delay.**
  After #399 put a 90 s wait before a parked build resumes, "release is idempotent" and "only after
  the last chat" only armed the fake timer, so `resumed === false` held with the guard deleted.
  Advance the clock past the shipped delay, or assert the armed timer (`slotClock().pending()`).
- **A fake cipher must change the bytes.** With an identity "cipher", an export that read the
  `.enc` file without decrypting it returned the right bytes, and the test stayed green.
- **Reset renderer stores with the production purge, not a test-only reset.** Call
  `clearDocTaskSession()` / `clearFileTranslate()` / `clearTranslateSession()` after RTL
  `cleanup()`. The removed `…ForTests` resets zeroed generation counters, which production never
  does, so a stale callback from one test could match the next test's first generation.
- **Measure a complexity bound in process CPU time, at an input a wrong walk cannot finish
  quickly.** Vitest cannot time out synchronous code: an input no walk can finish hangs the fork
  instead of failing. And at 1,000,000 pages a page-by-page walk passed in milliseconds.
  `doctasks-windows`'s M-2 row walks 2e9 declared pages under `process.cpuUsage()`.
- **Count memo re-renders on the test side.** `tests/helpers/render-counter.ts` wraps the
  production `memo(...)` component (keeping its compare function) inside a `vi.mock`, so no
  production module needs a DEV-only counter. Keep a positive control that shows the counter moves.

The same `typecheck`/`build`/`test` chain runs in CI on every PR and on pushes to `master`
(`.github/workflows/ci.yml`); a branch pushed **without** an open PR intentionally gets no CI — the
PR is the gate, so open a **draft PR** to run CI on a work-in-progress branch. The env-gated
`HILBERTRAUM_*` manual smoke matrix stays a separate human gate (see
[`docs/packaging.md`](docs/packaging.md)).

**Don't put `node_modules` on an NTFS volume mounted on Linux.** `npm install` downloads
Electron's ~100 MB platform binary and unpacks it with `extract-zip`; on an ntfs-3g/FUSE mount
the unzip can *silently* drop the binary (you get an empty `dist/locales/` and nothing else),
which later surfaces as electron-vite's opaque `Electron uninstall` error. The root
`postinstall` (`scripts/verify-electron.mjs`) now detects this on **every** `npm install`,
force-re-extracts from the cached download, and — if the mount genuinely can't hold the binary —
fails with a clear message instead of letting the breakage surface later. The fix is to keep
`node_modules` on a native filesystem (ext4/Btrfs/APFS); the portable HilbertRaum **drive** can
still be NTFS. Override the check with `HILBERTRAUM_SKIP_ELECTRON_CHECK=1` if needed.

## Code style
- TypeScript, strict mode. Prefer small, well-named modules.
- Each backend service hides behind an interface (see [`docs/architecture.md`](docs/architecture.md)
  "Swappable interfaces (spec §9.2)") so it stays swappable.
- Match the surrounding code's style and comment density.

## Scripts mirror canonical TypeScript modules
The self-contained shell scripts (`scripts/*.{ps1,sh}`) re-implement logic whose canonical,
unit-tested source lives in `apps/desktop/src/main/services/` (`drive.ts`, `assets.ts`,
`commercial-drive.ts`, `launcher.ts`). **When you change one side, change the other in the same
PR.** Script↔TS drift in safety-critical paths (hash verification, the commercial ship gate) was
the root cause of both Critical findings in the post-MVP audits — treat any divergence as a bug.

## Security issues
Report suspected vulnerabilities **privately** per [`SECURITY.md`](SECURITY.md) — do **not** open a
public issue or PR for an undisclosed vulnerability.

## License
HilbertRaum is licensed **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)). Public contributions are
distributed under GPL-3.0-or-later; in addition, the [CLA](#license-and-cla) grants the Project
the right to also offer the software under commercial licenses (dual licensing).
