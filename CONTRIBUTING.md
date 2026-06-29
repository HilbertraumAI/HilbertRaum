# Contributing — HilbertRaum

Thanks for your interest! This project values **privacy, portability, and boring reliable tech**.
By participating you agree to abide by our [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

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
npm install
npm run dev
npm test            # the whole suite (root; delegates to the apps/desktop workspace)
npm run typecheck
```

**Faster test iteration** (run from the app workspace — the whole suite is large):
```bash
cd apps/desktop
npx vitest run tests/unit/some-file.test.ts   # one file
npx vitest -t "a test-name substring"          # one test (by name filter)
npm run test:watch                              # watch mode (re-runs affected tests on save)
```
The same `typecheck`/`build`/`test` chain runs in CI on every push/PR (`.github/workflows/ci.yml`);
the env-gated `HILBERTRAUM_*` manual smoke matrix stays a separate human gate (see
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
