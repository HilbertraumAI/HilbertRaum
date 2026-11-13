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
  return the real shared type (`runtimeStatus`/`appStatus` in `tests/helpers/status.ts`, the `docTask`
  pattern in `TranslateScreen`/`fileTranslateSession`); for a deliberately-partial "keep the
  shell calm" payload use a narrow, named `as unknown as <Type>` at exactly that value, never a
  blanket `} as never)`. A one-way ratchet (`tests/unit/as-never-ratchet.test.ts`) fails if the
  tests/ `as never` count climbs — the remaining casts get converted **fix-when-touched** (lower
  the ratchet baseline when you remove some).
- **A test or eval measures production, not a copy of it.** The skill-trigger eval once scored its corpus
  through a hand-written copy of the selector, and its auto-fire gate never compared that copy with
  production; it stayed green while production missed the bar. Drive the production entry point —
  `tests/eval/skill-triggers.ts` runs every row through `suggestSkillsForTurn` /
  `resolveAutoFireSkill` on a real temp database. The same held for two ZIM rows: one ran a retyped
  copy of the pack-routing SQL, another rebuilt the arm's admission loop from its parts
  (`composeAdmitted`); both proved the copy whatever production did.
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
- **Shared skills, chat and RAG test setup lives in `tests/helpers/`** — `db-fixtures` (temp roots, fresh DBs,
  `openRawDb` / `legacyDbPath` for a file an older schema wrote), `doc-fixtures` (`seedEmbeddedDoc` takes pages,
  sections, a foreign embedding model, `fully_chunked` and `origin_json`; `seedReadyTree` for a one-level ready deep
  index; `seedMixedCorpus` for the document listings), `skill-fixtures` (SKILL.md packages,
  skill dirs), `skill-contexts`, `audit-capture`, `db-spy` (`countPrepares`, and `capturePrepares` to EXPLAIN the
  statement production prepares), `scripted-runtime` (incl. `failingRuntime`), `compaction-fixtures`
  (`compactionRuntime`, `appendTurns`, `WIDE_WINDOW`), `skills-world` (the skills-IPC and RAG-ask contexts; the importing file
  must `vi.mock('electron', …)`) and `chat-fixtures`. Extend them rather than copying setup into a new suite; keep
  a local copy only where it deliberately differs. The chat and RAG suites carried ten copies of `seedDocument`,
  which stored a word count where production stores `approxTokenCount`, and three of the compaction runtime.
- **Pin the bound that ships, not a shorter test-only one.** `RuntimeManager` once took timing
  options only tests passed: they proved a 50 ms teardown bound and a 0 or 60,000 ms probe TTL while
  5 s and 10 s shipped, and a probe test passed with the start's probe time never recorded. Drive
  the real constant with fake timers (`vi.useFakeTimers({ toFake: ['performance'] })` for a
  `performance.now()` clock) and advance to just past it, and to just short of it. A shorter seam can
  also prove a different mechanism: a 300 ms `articleTimeoutMs` cut the ZIM article read before the
  shipped 1 s idle detector could fire, so the "stalled read" row proved the timeout, not the detector.
- **A once-per-process latch makes every later "stays silent" row vacuous.** kiwix-serve warns about a
  hand-placed bundle once per process: after any earlier row trips the warning, a "does not warn" row
  passes with the check deleted, and the `…ForTests` reset that hid this kept a test-only export
  alive. Assert the silence before anything trips the latch, in a file of its own if need be (each
  test file is a fresh fork).
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
  (a fresh child per spawn), the SSE bodies, `fakeIdleClock` and `loadingSidecar` (`/health` answers
  503 until loaded; a hanging probe would hide a mutation that cancels the start). Extend the
  helper instead of declaring another child class in a suite. The bodies differ in where the chunk boundaries
  fall, which is what a framing row is about: `sseBody` (one chunk, or `chunkSize`-byte pieces that can split a frame
  or a UTF-8 character), `sseFrames` (each entry one chunk), `sidecarBody` (written by hand, stays open).
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
- **The whole-document RAG harness lives in `tests/helpers/whole-doc-fixtures.ts`** (`germanDoc`,
  `wholeDocHarness`, `answerWholeDoc`), and `scripted-runtime`'s `finishScriptedRuntime` is the one fake
  that scripts finish reasons, caps and a Stop. The whole-doc truncation and map-reduce suites carried
  verbatim copies of the harness, and rag.test and the map-reduce suite each had their own finish fake.
- **A registrar's locked-vault proof is its `MODULES` entry in `ipc-lock-coverage.test.ts`**, which
  drives every channel and names each exempt one with its reason. A hand-picked lock test in the
  module's own suite drifts: docs-ipc's checked 5 of the 14 gated `docs:*` channels, and
  doctasks-ipc's checked 1 of 3. A module with its own locked sentence names it (`lockedCopy`): the shared
  "Workspace is locked." prefix matched chat throwing the benchmark's sentence.
- **An IPC copy of a service guard needs an IPC-specific risk** (routing, a sender check, the lock
  gate, error mapping). doctasks-ipc re-proved the manager's "refuse while chat streams" and
  "exactly two documents" checks through a handler that forwards them unchanged, while the one IPC
  risk there, routing a cancel to the right task id (#157), had no test.
- **When a delay starts guarding an action, negatives about that action must look past the delay.**
  After #399 put a 90 s wait before a parked build resumes, "release is idempotent" and "only after
  the last chat" only armed the fake timer, so `resumed === false` held with the guard deleted.
  Advance the clock past the shipped delay, or assert the armed timer (`slotClock().pending()`).
- **A fake cipher must change the bytes.** With an identity "cipher", an export that read the
  `.enc` file without decrypting it returned the right bytes, and the test stayed green. Use
  `tests/helpers/test-cipher.ts`: `testCipher()` is the vault's real AES-256-GCM under a random key, and
  `recordingCipher()` also records which decrypt a reader used and where it decrypted to. Seven suites
  had their own copy, and two docs-ipc rows used identity ciphers.
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
  That wrapper never sees a component's own state updates, so `HomeScreenPoll` counts commits with a
  `<Profiler>` instead, with a row that shows a changed poll does commit.
- **A media query that changes mid-test** uses the one firable `matchMedia` fake in
  `tests/helpers/match-media.ts` (Theme, ReviewGateA11y, ReviewScreen and ChatRestructure's narrow-window fold):
  `fakeMatchMedia(matches)` before the render, `removeMatchMedia()` in `afterEach`.
- **A status flip is not a settled run.** Every download manager's `cancel()` sets `cancelled` at once,
  so a "wait" on the status passes with the run still unwinding. Rows that checked a `.part` or a rename
  "after cancel" read too early and stayed green with the abort check deleted. All three managers keep
  `activeJob()` held until the run settles, and `runToEnd` in `tests/helpers/download-fixtures.ts` waits
  on that: a poll of the status alone let the engine's cancel-during-the-hash row pass with both of its
  guards deleted (#753).
- **A row over the committed catalog proves only what the catalog can reach.** A guard no committed input reaches gets an
  altered copy of the catalog in the row, or stays with its synthetic owner.
- **Committed files and the two script legs** have shared readers: `tests/helpers/repo-files.ts` (`REPO_ROOT`, `repoText`,
  `builderConfig`, `lockPackages`, `modelManifestDocs`, no `src/main` import), `catalog.ts` (`committedManifests`,
  `committedRuntimeSources`) and `script-legs.ts` (`SCRIPT_LEGS`, `extractScriptArray`). The list readers throw on nothing, so
  a rule row cannot pass on an empty walk. `extractScriptArray` closes on a line that is exactly `)`: a parser that stopped at
  the first `)` compared one default model of five, on a parenthesis in a comment, from the day it was written.
- **The bash legs on a Windows desk** need `C:\Program Files\Git\bin` first on `PATH` and `HILBERTRAUM_SCRIPT_SH_LEG=1`: from
  PowerShell, plain `bash` is WSL's and fails every `.sh` row. Run those suites on their own. Git Bash's forks are slow under
  load, and inside a full run the builder's gate row can reach the 60 s child kill. No CI leg runs them that way.
- **A script row runs on `scriptRoot()`**, a drive root named `Kit [1]`: a `[` read as a wildcard by a non-literal
  PowerShell path made `fetch-models` fall back to the repo's catalog (#767). **A row that really downloads** also passes
  `env: downloadEnv()` (no aria2c on `PATH`: every CI image ships it and it reads no `file://` URL; every proxy variable
  names a dead port) and `scriptsDir: isolatedScripts()` (a copy of the scripts with no repo catalog beside it). Run an
  old or mutated script the same way, or dry: a pre-fix `fetch-models.ps1` on a bracketed root started a real 1.6 GB
  download from the repo's catalog. The shipped `.ps1` scripts carry no PowerShell download line (`script-drift`):
  a `WebClient` one got a copy of `fetch-models.ps1` quarantined by Norton.
- **Prove a cache hit with a swap behind the cache, not a counter.** Rewrite the file with the same size
  and mtime: a stale value proves no read, and it needs no probe in production (`policy.test.ts`, F-30).
  Keep a changed-signature row beside it, or a cache that never re-reads passes.
- **The manifest and download fixtures** are `tests/helpers/manifest-fixtures.ts` (`rawManifest`,
  `validManifest`, `manifestsDirWith`, `verifiedManifest`, …) and `download-fixtures.ts` (`bodyFetch`,
  `hangingFetch`, `rangeFetch`, `routedFetch`, `runToEnd`). `download-fixtures` has no `node:fs` or main-service
  value import, so it stays safe beside a `vi.mock` of either. `binary-fixtures.ts` (`binaryWithMarker`,
  `verifierInert`) is for suites that drive the real pre-spawn verifier. `seeded-db.ts` is `seededFreshDb`, apart from
  `db-fixtures` so that the skills suites do not load `services/settings`.
- **Home, AI Model and the whole App start from shared stubs**: `stubHomeApi` and `renderHome`
  (`tests/helpers/home-screen.tsx`), `stubModelsApi` and `modelsScreenStubs` (`model-fixtures.ts`), `appShellStubs`
  (`app-shell.ts`). Those screens' own reads and `useEngineProblems` no longer tolerate a missing channel, because the
  preload ships inside the app. `useOcrInstall` still does.
- **A screen error boundary can hide a missing stub.** With that tolerance gone, Home crashed under AppLock and
  ReviewLockSeam, and both stayed green: the boundary caught it and their rows read only the nav rail. In a full-App
  suite, use `appShellStubs` and read the run's `stubApi: unmocked` warnings. A suite that adds a screen's reads to
  `chatScreenStubs` keeps them separate, since `appShellStubs` would replace its running model with a stopped one.
- **A date a screen prints takes a local time in the fixture, with no `Z`.** `2026-08-14T09:00:00Z` is the 13th at
  UTC−11 and `2026-06-15T11:58:00Z` the 16th at UTC+14, and no UTC instant is one calendar day everywhere. To check a
  suite, run it with `$env:TZ='Pacific/Pago_Pago'` and with `'Pacific/Kiritimati'`.
- **A row that reads the host pins it.** CI runs Windows, Linux and macOS, and RAM differs per host.
  Two performance rows would fail on Apple Silicon while docs/benchmark.md said they held "on every
  host", and a recommended-context row would fail under 8 GB. Pin with `pinPlatform`
  (`tests/helpers/performance-fixture.ts`) and a hoisted `vi.mock('node:os')` for RAM, and expect a
  literal, not a value derived from the host.
- **Taking a sleep out of a negative moves its proof.** picker-seams' "refreshes nothing" rows slept 50 ms,
  then checked the probe. Without the sleep they only hold while the refresh reaches the probe before the
  job settles, so the positive row now asserts exactly that. Otherwise a refresh that moves later turns
  every negative vacuous without a failure.
- **An `expect` inside a callback production catches cannot fail.** A read-speed row asserted inside its
  observer, and `record()` swallows an observer's throw. Capture the value in the callback and assert after.
- **A spread of `Record<string, unknown>` is an untyped stub.** The Performance screen's `install` took its
  overrides that way, so a renamed bridge method still compiled. `installPerformance` takes
  `Partial<PreloadApi>`. The same suite's mounts called two unstubbed methods in all 107 tests.
- **The benchmark and Performance fixtures** are `tests/helpers/performance-fixture.ts` (main side:
  `fakeGpuProbe`, `withLlamaBinary`, `firstBenchmarkNow`), `chat-runtime-stub.ts` (`stubChatRuntime`, `committingRuntime`,
  `runningManager`, `START_READS`) and `gpu-fixtures.ts` (`CARDS`, `CATALOG_MANIFESTS`, `idleOccupancy`), which load no IPC registrar, so
  a service suite needs no `electron` mock, `benchmark-records.ts` (pure record builders, safe in jsdom) and
  `performance-screen.tsx` (the screen's `installPerformance`, `startOwnRun`, `copiedReport`). `deferred` is
  `tests/helpers/deferred.ts`.
- **A fake missing a member can fail inside a catch-all.** With `startModelRuntime`'s `?.` gone, a bare fake's `TypeError`
  lands in `maybeAutoStartActiveModel`'s catch or the benchmark's `'failed'` outcome, and a "does not start" or
  "reports failed" row stays green for the wrong reason. After removing a tolerance, compare the run's
  `is not a function` count with master's, and list the tests that reach the read without the member.
- **`seededDb` opens the root's one file.** Two `seededDb(root)` calls on one root are two handles on the
  same data, so first-benchmark-scheduler's "legacy blob" cases ran against the earlier case's history.
  Give a case that needs its own workspace its own `freshRoot()`.
- **The OCR fakes live in `tests/helpers/ocr-fixtures.ts`**: `fakeOcrEngine` (text per page, confidence,
  languages, call count), `fakeRasterizer` (honours the page list a re-run asks for, #575), `importScan`
  (a scan through the real pipeline, asserting it fails as a detected scan) and `ocrDrive` (a temp drive
  with language files). The two OCR task suites each carried their own rasterizer, and one copy had
  stopped honouring the page list.
- **ZIM test setup lives in `tests/helpers/zim-*.ts`**: `zim-fakes` (`ServeFakeChild`,
  `fakeManageSpawn`, `zimServiceDeps`, marker binaries, `expectAbortError`), `zim-library` (library
  XML books, `manageAddFromHeader`), `zim-http` (`/raw` answers with Range and stalls),
  `zim-retrieval-fixtures` (`archiveCandidate`, `testArm`, `searchXml`), `zim-header` (archive
  headers) and `zim-smoke-env` (the manual smoke's gate); the renderer pack suites share
  `knowledge-pack-fixtures`. The ZIM suites used to carry their own fake children, library XML and
  `/raw` responders.
- **A skipped `describe` still runs its body at collection.** `describe.skipIf(!built)` skips the tests,
  not the code between them: `ocr-decoder-assets` read `out/renderer/assets` in the describe body, so a
  fresh checkout's `npm test` before a build failed the whole file instead of skipping it. Read build
  output, drives or other optional inputs in `beforeAll` or inside the tests.
- **A test that cannot run here says so.** A row that `return`s early when the environment lacks
  something (no symlink privilege, a link that cannot be created) is reported as passed. Use
  `ctx.skip()` or `it.runIf` / `it.skipIf`, so the run shows the skip.
- **Search the raw value, not its JSON encoding.** A "never logs the drive path" negative over
  `JSON.stringify(meta)` passes on Windows even when the path is logged: JSON doubles every backslash,
  so `C:\…` never appears in the string. Check each logged value, or search the encoded form.
- **Behaviour overrides in your shell do not reach `npm test` (#687).** `tests/setup-env-scrub.ts`, the
  first `setupFiles` entry, deletes the `HILBERTRAUM_*` / `HR_*` overrides `src/` reads (caps,
  timeouts, `HR_FORCE_REINDEX`, …) before each test file loads. A new override read in `src/` goes on
  its `SCRUBBED_ENV` list (`tests/unit/env-scrub.test.ts` fails until it does). A row that dials a
  cap down (the ingestion caps have no injection parameter; `resolveIngestionLimits()` reads the env
  at call time) sets it with `vi.stubEnv` and calls `vi.unstubAllEnvs()` after.
- **A doc that names a test as its guard is a claim about that test.** model-policy.md said the OCR
  drift test checks `OCR_PINS` against its table "and fails until they agree"; the test never read
  the table, and the pinned sizes were checked nowhere. Make the test check what the doc says, or fix the
  doc in the same change.
- **To show a test pins a shipped constant, mutate where it is used, not where it is defined.** A test
  that imports `DEFAULT_OCR_PAGE_TIMEOUT_MS` moves with any edit to the constant and stays green. Handing the
  code a copy of the value is the same blind spot: read-chat-sse passed `readChatSSE` its own copy of the 30 s /
  120 s idle budgets through a parameter only tests used, so changing either in `llama.ts` left the suite green.
- **A one-document scope is read whole, not retrieved.** Since #643 `askDocuments` reads a single fitting document
  in order instead of calling `retrieve()`, so an IPC scope test with one small document proves the whole read:
  collections-ipc's pinned-document row stayed green with `generateGroundedAnswer` ignoring its `scope`. Give a
  retrieval-scope test two documents (rag-scope's two identical ones), or one too large to read whole.
- **An `every()` over an empty result passes.** rag-scope's scoped-retrieval row checked that every chunk came from
  the scoped document; that document scored below the similarity floor, so nothing came back and the row passed with
  the scope filter deleted. Assert the exact list, or that it is not empty, before quantifying over it.
- **A positive row must reach the branch its title names.** chat-compaction's "still fits the context window after
  compaction" used a 1,500-token window the compacted history never exceeded, so the trim it claimed never ran.
  Size the input past the branch's threshold and break the branch once to watch the row go red.
- **ChatScreen suites start from `tests/helpers/chat-screen.tsx`** and call `assertNoUnexpectedApiCalls()` in
  `afterEach`. `chatScreenStubs` gives every call an idle chat screen makes a typed answer; `renderChatScreen`,
  `fakeChatStream`, `deferred`, `chatDropBridge` and `flushFakeTimers` replace the per-suite copies. Before it each
  suite stubbed its own subset, the chat structure suites printed 495 unmocked-call warnings per run, and an unmocked
  read resolving `undefined` quietly decided which branch a row reached. The renderer factories sit beside it:
  `chat-fixtures` (conversations, messages, citations, documents), `status` (`runtimeStatus`), `render-language`,
  `drop`, `transcript` and `vision-fixtures`. The jsdom `scrollTo` shim lives in `tests/setup.ts`.
- **A renderer fake sends what main sends.** ImagesScreen fired a `done` with an empty answer and an
  `imageAnalyze` reply of `{ state: 'starting' }`; main routes an empty answer to `error: 'emptyResponse'` and answers
  `'queued'`. ChatCompaction fed the documents-only 'analysis' notice to a plain-chat send. Such a row proves a branch
  no user reaches; build the event from the main-side shape and name the line it comes from.
- **Never swallow a `findBy*` rejection.** `findByText(/start chatting/i).catch(() => undefined)` waited for copy
  ChatScreen never renders, so each of ChatAttach's eleven calls burned the full timeout and proved nothing. To check
  that something is absent, settle on a state that proves the effect ran, then use `queryBy*`.
- **React 18 has no setState-after-unmount warning.** ChatUnmount asserted that `console.error` stayed silent after
  unmount, which cannot fail on React 18. Assert an effect the guard prevents instead: no `listDocuments` refresh from
  an attach-poll tick that resolves after unmount.
- **Assert translated copy in a second language when the English text equals its source.** Dictation's mic-blocked
  row matched the English constant DictationButton translates from, so deleting the translation lookup stayed green.
  The row now renders German.
- **Fake only the clock the code reads.** Under vitest's full fake timers `findBy*`, `waitFor` and every `userEvent`
  call hang: each finishes through React Testing Library's async wrapper, which drains on a `setTimeout(0)` it
  advances only through Jest's `jest.advanceTimersByTime`, and `userEvent` also waits its keystroke delay on the faked
  `setTimeout`. A global `jest` shim would fix the first and not the second (each `userEvent.setup` would still need
  `advanceTimers: vi.advanceTimersByTime` or `delay: null`), so the suite has none (#745). With the whole clock faked,
  settle with `flushFakeTimers()` (`tests/helpers/chat-screen.tsx`) and type with `fireEvent`. Dictation's no-signal
  rows fake `setInterval`, `clearInterval` and `Date` only and drive the shipped 2 s default, where a test-only 80 ms
  prop used to stand in for it. The conversation-search debounce row types with `fireEvent.change`.

The same `typecheck`/`build`/`test` chain runs in CI on every PR and on pushes to `master`
(`.github/workflows/ci.yml`); a branch pushed **without** an open PR intentionally gets no CI — the
PR is the gate, so open a **draft PR** to run CI on a work-in-progress branch. The env-gated
`HILBERTRAUM_*` manual smoke matrix stays a separate human gate (see
[`docs/packaging.md`](docs/packaging.md)).

**Don't put `node_modules` on an NTFS volume mounted on Linux.** Since Electron 42 the install
itself downloads nothing: Electron fetches its ~100 MB platform binary lazily, the first time
something runs it (`npm run dev`, a build, an Electron-launching test), and unpacks it with
`extract-zip`. On an ntfs-3g/FUSE mount the unzip can *silently* drop the binary (you get an
empty `dist/locales/` and nothing else), which surfaces as electron-vite's opaque `Electron
uninstall` error. The root `postinstall` (`scripts/verify-electron.mjs`) runs on every
`npm ci` / `npm install`: when it finds a half-extracted download (`path.txt` written, the binary
missing or empty) it re-extracts from the cached download, and if the mount genuinely can't hold
the binary it fails with a clear message instead of letting the breakage surface later. The fix
is to keep `node_modules` on a native filesystem (ext4/Btrfs/APFS); the portable HilbertRaum
**drive** can still be NTFS. Override the check with `HILBERTRAUM_SKIP_ELECTRON_CHECK=1` if needed.

## Code style
- TypeScript, strict mode. Prefer small, well-named modules.
- Each backend service hides behind an interface (see [`docs/architecture.md`](docs/architecture.md)
  "Swappable interfaces (spec §9.2)") so it stays swappable.
- Match the surrounding code's style and comment density.

## Translating the interface
The interface is available in ten languages: English, German, Spanish, French, Italian, Dutch,
Polish, Turkish, Russian and Ukrainian. The design is recorded in
[`docs/architecture.md`](docs/architecture.md) "Internationalization — design record" (cited
below as "the i18n record").

### UI text
Interface copy lives in the catalogs under `apps/desktop/src/shared/i18n/`: `en.ts` is the source
of truth, `languages.ts` is the registry of languages, and each language has its own catalog
(`de.ts`, `es.ts`, `fr.ts`, `it.ts`, `nl.ts`, `pl.ts`, `tr.ts`, `ru.ts`, `uk.ts`). A pull request
that adds or changes UI text writes it in **all ten** catalogs. `npm run typecheck` fails on a
missing or misspelt key, and `tests/unit/i18n.test.ts` fails on an empty value or a placeholder
that differs from English.
Typecheck checks presence, not freshness: when you change an English value, update its
translations by hand, because nothing marks them as stale.

- **Where each language's rules live.** [`docs/design-guidelines.md`](docs/design-guidelines.md)
  §7 has one "microcopy" section per language ("German microcopy", then Russian, French, Spanish,
  Italian, Dutch, Polish, Turkish and Ukrainian): the glossary, the form of address (German *du*,
  Russian *вы*, French *vous*, Spanish *tú*, Italian *tu*, Dutch *je*, Polish *ty*, Turkish *siz*,
  Ukrainian *ви*) and the typography. Each glossary is also the comment block at the top of that
  language's catalog file, and each punctuation, script and placeholder rule of the style guide
  is also an entry in that language's `TYPOGRAPHY_RULES` list in `tests/unit/i18n.test.ts`, as
  are, for some languages, the wrong forms of address a pattern can catch (French *tu*, Russian
  *ты*, Dutch *u*, Polish *Pan*, Turkish *sen*); change them together. The glossary, the spelling
  and the rest of the form of address (such as a Polish verb that shows a gender) are not tested:
  the reviewer checks them.
- **Text stored in the database stays English.** A message the app writes to the database or to
  the settings (a document's error, a fixed answer, a default title) is written with
  `t('en', …)` and translated when it is shown, through the display map
  (`renderer/lib/displayMap.ts`; i18n record §3.3 Rule 1). These keys sit in the persist-canonical
  section of `en.ts`; changing one of their English values breaks the match for rows already
  stored. A message the main process shows right away goes through `tMain(…)` (Rule 2). Prompts
  sent to the AI model stay English.
- **A key that shows a number** is a `.one`/`.other` pair rendered with `tCount`, or it goes on
  the reviewed `NON_GRAMMATICAL` list in `tests/unit/i18n.test.ts`; the test says which.
- **The bank-statement skill's two routed questions** (`chat.skill.summarize.question`,
  `chat.skill.categorize.breakdownQuestion`) are recognised by their exact text in every language
  (i18n record §3.3 Rule 3). Changing either wording, in any language, changes what the skill
  recognises: a conversation saved with the old wording then gets a model answer instead of the
  checked figures when it is regenerated in a language whose text the English and German word
  lists don't catch.
- **Other checks that read the translations:** `tests/unit/i18n.test.ts` (each catalog has
  exactly English's keys, without `packExport.*` for a language that writes no evidence packs,
  plus its language's plural forms; no empty value, English's placeholders, and the typography
  rules of its language), `tests/unit/rail-labels.test.ts` (no navigation
  label has an invisible break or a word longer than the rail allows), the plural-layout row in
  `tests/integration/repo-hygiene.test.ts` (all forms of a plural key on consecutive lines, in
  CLDR order), and `tests/unit/i18n-unused-keys.test.ts` (unused keys, and no interface language
  named in `src/` outside the registry and a reviewed list of sites, such as the two
  `zim/tables.ts` checks for the HTML table-row tag `<tr>`, which spells the Turkish code).

### How a new translation is checked
Translations are drafted from the language's style guide and glossary (its "microcopy" section),
then checked by a second reviewer — a native speaker, or a second AI model that translates the
text back into English and compares it with the original. Findings have three severities:

- **S1, meaning or safety:** the text says something different from English (a claim weakened or
  overstated, a privacy or security statement wrong) or a placeholder is lost or changed.
- **S2, consistency:** a glossary term not used, the wrong form of address or register, a quoted
  button or screen name that doesn't match its real label, or text left untranslated.
- **S3, style:** correct but awkward, too long, or a better word exists.

S1 and S2 findings are fixed before the pull request merges; S3 findings at the translator's
judgement. A catalog nobody has reviewed natively keeps `nativeReviewed: false` in the registry.

### Adding a language
1. Add its entry to `UI_LANGUAGES` in `apps/desktop/src/shared/i18n/languages.ts`. The order is
   the order in the language picker: English first (it is the fallback), then Deutsch, then the
   other languages whose own names are written in Latin letters, in alphabetical order of those
   names (Español, Français, Italiano, Nederlands, Polski, Türkçe), then the Cyrillic ones, also
   alphabetical (Русский, Українська). The entry holds `code` (the lower-case primary language
   subtag, such as `uk`, never a country code such as `ua`), `nativeName` (its own name),
   `nativeReviewed: false` until a native speaker has reviewed it, `evidencePack: false`
   (evidence packs stay English or German), `plural: cldrPlural('<code>')` and
   `pluralCategories` (the forms `Intl.PluralRules` gives that language, in CLDR order).
2. Write `apps/desktop/src/shared/i18n/<code>.ts` as `export const <code>: UiCatalog<'<code>'>`,
   with its glossary as the header comment. Typecheck then asks for every key and every extra
   plural form, and refuses `packExport.*` keys.
3. Import it in `index.ts` and add it to `CATALOGS`. Don't re-export it from `index.ts` (only `en`
   and `de` are exported there): a named export such as `it` would shadow vitest's global `it`.
   Tests read catalogs through `catalogOf(code)` (`tests/helpers/i18n-catalogs.ts`).
4. Add `TYPOGRAPHY_RULES.<code>` in `tests/unit/i18n.test.ts` (typecheck asks for it): the
   punctuation, script, address-form and placeholder rules of its style guide.
5. Add a `localized.<code>` title and description to each bundled skill's `app-skills/*/SKILL.md`
   (`tests/integration/skills-skillmd-parity.test.ts` checks every one), and its titles to the
   titles tables in [`docs/skills-overview.md`](docs/skills-overview.md): a column in the last
   table, or a new table once that one has as many languages as the first.
6. Add a "<Language> microcopy" section to `docs/design-guidelines.md` §7.
7. Check the layout in the running app: a word that doesn't fit a fixed-width surface such as the
   navigation rail takes a shorter synonym from the glossary, never an abbreviation.
8. Update the docs that list the languages: the language paragraph in
   [`docs/user-guide.md`](docs/user-guide.md) (Settings → General → Language), the
   "Internationalization" section of [`docs/known-limitations.md`](docs/known-limitations.md)
   (native-review status), the `uiLanguage` codes in
   [`docs/data-contracts.md`](docs/data-contracts.md), the i18n record in
   [`docs/architecture.md`](docs/architecture.md) (its opening paragraph, D-L7 and D-L10), the
   language list at the top of this section, and a `CHANGELOG.md` entry.

## Scripts mirror canonical TypeScript modules
The self-contained shell scripts (`scripts/*.{ps1,sh}`) re-implement logic whose canonical,
unit-tested source lives in `apps/desktop/src/main/services/` (`drive.ts`, `assets.ts`,
`commercial-drive.ts`). **When you change one side, change the other in the same
PR.** Script↔TS drift in safety-critical paths (hash verification, the commercial ship gate) was
the root cause of both Critical findings in the post-MVP audits — treat any divergence as a bug.

## Security issues
Report suspected vulnerabilities **privately** per [`SECURITY.md`](SECURITY.md) — do **not** open a
public issue or PR for an undisclosed vulnerability.

## License
HilbertRaum is licensed **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)). Public contributions are
distributed under GPL-3.0-or-later; in addition, the [CLA](#license-and-cla) grants the Project
the right to also offer the software under commercial licenses (dual licensing).
