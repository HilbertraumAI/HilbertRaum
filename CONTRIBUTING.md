# Contributing — HilbertRaum

Thanks for your interest! This project values **privacy, portability, and boring reliable tech**.

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

## Dev setup
```bash
npm install
npm run dev
npm test
```

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
