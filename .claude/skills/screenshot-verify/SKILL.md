---
name: screenshot-verify
description: Capture pixel screenshots of HilbertRaum renderer UI (components/screens) without the full Electron app, model, or workspace — to visually verify and refine a UI change. Use after editing renderer components/CSS, or when asked to "show", "screenshot", or "verify the look" of the UI.
---

# screenshot-verify

Render real renderer components with the **real `tokens.css` + `styles.css`** and a **mock `window.api`**,
then screenshot them with the already-installed Electron (`webContents.capturePage()` — no Playwright,
no new deps, no GUI/workspace/model). Deterministic, offline.

> **Headless boxes need POSIX.** On a headless Linux box the capture needs `xvfb-run` +
> `ELECTRON_DISABLE_SANDBOX` (macOS works without xvfb). On a **Windows machine with a real
> display session it runs natively** (verified 2026-07-09) — no xvfb, just strip the agent's
> `ELECTRON_RUN_AS_NODE` from the environment:
>
> ```bash
> cd apps/desktop && npm run preview:build && \
>   env -u ELECTRON_RUN_AS_NODE npx electron scripts/screenshot.mjs <case…>
> ```
>
> Caveat: the (hidden) window height is clamped to the physical display, so a case taller than
> the screen gets cut — capture the rest with a one-off `executeJavaScript('window.scrollTo(…)')`
> before `capturePage()`, or fall back to `npm run dev` eyeballing.

## Run it

The capture needs GL libraries (the nix dev shell provides them) + a virtual display, so run inside the
dev shell:

```bash
nix develop --command bash -c 'cd apps/desktop && npm run screenshot'
# or specific cases:
nix develop --command bash -c 'cd apps/desktop && npm run preview:build && \
  ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a electron --no-sandbox scripts/screenshot.mjs documents'
```

PNGs land in `apps/desktop/screenshots/<case>.png` (git-ignored). Then **Read** each PNG to inspect it.

## How it works (the moving parts)

- `apps/desktop/src/renderer/preview/preview.tsx` — the harness. A `?case=<id>` selector renders one
  component/screen wrapped in `I18nProvider` + `ToastProvider`, with a Proxy `window.api` that returns a
  harmless default (`async () => null`) for any method, overriding the few that need real shapes
  (`listCollections`, `listDocuments`, …). Mock data is inline.
- `apps/desktop/vite.preview.config.ts` — builds the harness to static files in `out/preview`
  (`npm run preview:build`), reusing the renderer's `@shared`/`@renderer` aliases.
- `apps/desktop/scripts/screenshot.mjs` — Electron main that loads each built case over `file://` in a
  hidden window and writes `capturePage()` to a PNG.

## Add a case

1. In `preview.tsx`, add an entry to `CASES`: a `label` + a `node` (render the component with mock props;
   add window.api overrides if it calls a method on mount).
2. Optionally add a window size in `SIZES` in `screenshot.mjs` (wide for a full screen, narrow for a
   sidebar/popover).
3. Run with the case id: `… scripts/screenshot.mjs <id>`.

## Gotchas (already handled in the script — keep them if you edit it)

- **`--no-sandbox` must be a real CLI flag** to the electron binary (the `app.commandLine` switch alone
  is too late for the zygote → `whenReady` hangs).
- **Do NOT top-level `await app.whenReady()`** in the ESM main — the entry module must finish evaluating
  before `ready` fires, so it deadlocks. Use `app.whenReady().then(…)`.
- **Add a no-op `app.on('window-all-closed', …)`** — destroying the only window otherwise auto-quits the
  app before the next case.
- Needs a display: wrap with `xvfb-run -a` on a headless box.

## Scope

For controlled, fast visual checks of components/screens. It is NOT an end-to-end test of the real app
(no real IPC/model/workspace) — for that, drive the packaged app. Behaviour is covered by the vitest
renderer tests; this skill is for the *look*.
