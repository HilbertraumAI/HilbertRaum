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
- Commit messages follow **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, …), often
  scoped (e.g. `feat(image-understanding): …`). Keep each PR a focused vertical slice.
- A PR is not done until: `npm test` is green, `npm run typecheck` is clean, affected `docs/` are
  updated, and `BUILD_STATE.md` records the change (the mandatory per-phase ritual).

## Dev setup
Requires **Node.js ≥ 22.5** (Node 24 recommended), per `package.json` `engines`. For the repo layout
and a map of the docs, see the **[README](README.md)** ("For developers" + "Documentation").
```bash
npm ci              # fresh clone AND after every pull — installs exactly per package-lock.json
npm run dev
npm test            # the whole suite (root; delegates to the apps/desktop workspace)
npm run typecheck
npm run test:coverage  # optional: suite + V8 coverage report (writes coverage/, gitignored; not a CI gate)
```

**Install with `npm ci`, not `npm install`** (issue #49): different npm versions compute the
lockfile's `peer` flags differently, so a plain `npm install` under another npm rewrites
`package-lock.json` and leaves it permanently dirty (and the next `git pull` complains). `npm ci`
installs exactly what the lockfile pins and never rewrites it. If you hit the dirty-lockfile loop:
`git checkout -- package-lock.json && npm ci`. Only use `npm install` when you deliberately change
dependencies, with the pinned npm version (`packageManager` in `package.json`, `npm@11.6.2` — the
version the committed lockfile is canonical under; with corepack enabled it is picked up
automatically).

**Faster test iteration** (run from the app workspace — the whole suite is large):
```bash
cd apps/desktop
npx vitest run tests/unit/some-file.test.ts   # one file
npx vitest -t "a test-name substring"          # one test (by name filter)
npm run test:watch                              # watch mode (re-runs affected tests on save)
```
- **Window security wiring is pin-tested.** The `webPreferences` hardening flags, the CSP
  strings, and the window-open policy live in `apps/desktop/src/main/window-security.ts`,
  pinned literal-by-literal by `tests/unit/window-security.test.ts` — do **not** edit CSP or
  `webPreferences` inline in `index.ts`/the OCR rasterizer; change the module next to its tests
  (a deliberate change there is a deliberate security decision).
- **No fixed sleeps in tests — gate on observable state.** A `setTimeout(r, N)` that waits for
  "the loop to probably get there" flakes under parallel-fork CPU starvation. Instead, expose a
  "reached" flag/promise from the fake seam or poll-until on observable state with a hard
  timeout ceiling — exemplars: `tests/integration/ocr-task.test.ts` (the `rasterizeReached`
  gate replacing a fixed `sleep(30)`) and `tests/integration/vision-runtime.test.ts` (the
  injected-clock idle-teardown interlock). The rare *justified* fixed sleep — a wall-clock
  advance for timestamp ordering, a timeout simulation where the timer IS the semantics, a
  single-macrotask hop with no observable — must carry a comment saying so; everything else
  is a bug.

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
- Each backend service hides behind an interface (see spec §9.2) so it stays swappable.
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
