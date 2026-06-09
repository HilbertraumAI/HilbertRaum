# Phase 8 kickoff prompt — privacy & offline hardening

> Paste this as the kickoff prompt for the next session. It mirrors the Phase 6/7 handoff style.

---

You are continuing work on the **Private AI Drive Lite** project (an open-source, offline,
local-LLM desktop app) located at `f:\_coding\ai_drive`.

## START BY READING, IN THIS ORDER

1. **`BUILD_STATE.md`** — the live handoff/state file (current status, decisions, data
   contracts, next actions, risks). Source of truth for where we are. Read **§5 (START OF
   PHASE 8)** carefully, the **Settings storage** + **Core IPC (Phase 1 live)** contract
   sections, and the **Decisions log** (especially `allowNetwork` default-false →
   `AppStatus.offlineMode`, and the no-network test pattern).
2. **`docs/IMPLEMENTATION_PLAN.md`** — read the **Phase 8** section AND the **"Per-phase
   ritual"** (§3).
3. **`CLAUDE.md`** — the hard rules (no cloud, no telemetry, local-only, no hosted AI APIs,
   swappable interfaces per spec §9.2). **Phase 8 is the phase that makes these rules
   *enforced and visible*, not just observed.**
4. **`CLAUDE_Private_AI_Drive_Lite_MVP.md`** — the source of truth for *what* to build:
   - **§3.5 (Security baseline)** + **§3.6 (Offline mode)** — the visible indicator copy
     ("Offline Mode: ON", "Network access disabled by policy", "No prompts or files leave this
     device") and the settings checkbox (default **unchecked**).
   - **§6 drive layout** — `config/drive.json` + `config/policy.json` shapes (the
     `network`/`workspace`/`models` policy blocks; `allow_network_by_default: false`).
   - **§7.10 (Privacy/offline module)** + **§7.11 (Diagnostics)** — responsibilities + the
     required privacy UI text. *"Diagnostics must not upload logs."*
   - **§18.1 (Offline statement)** — the exact privacy/offline copy to render.
   - **Milestone 8** (acceptance) + **Step 10**.

## CONTEXT: Phases 0–7 are complete and committed (latest commit `34095ca` "Phase 7 / Milestone 7: hardware benchmark & model recommendation")

- **Phase 7** delivered `services/benchmark.ts` (local-only hardware detection + bounded
  in-workspace drive probe + optional tokens/sec + spec §11.3 profile classification + manifest
  recommendation + §11.4 friendly warnings), the `runBenchmark` IPC (`benchmark:run`) persisting
  to `settings.lastBenchmark`, the replacement of the old `LITE`/`UNKNOWN` profile stubs with the
  real persisted profile (`getAppStatus.hardwareProfile` + `buildModelList`), and a fleshed-out
  `DiagnosticsScreen`.
- **All 119 tests pass**; typecheck clean; `NODE_OPTIONS=--use-system-ca npm run build` green
  (main bundle 63.25 kB). No new dependencies. The benchmark path is guarded by a **no-network
  assertion** (spy `http`/`https`/`net`/`net.Socket`/`fetch`) — **reuse this exact pattern** for
  the Phase-8 startup self-check.

### Things already in place for Phase 8 (do not rebuild)

- **`AppSettings.allowNetwork`** (default **false**, in `DEFAULT_SETTINGS`) already exists and
  already drives **`AppStatus.offlineMode = !allowNetwork`** (`registerCoreIpc.ts`). The
  **Settings screen** (`SettingsScreen.tsx`) already renders the checkbox *"Allow internet access
  for model downloads and updates"* wired to `updateSettings({ allowNetwork })`. Phase 8 makes
  this **policy-aware + authoritative + visible**, it does not invent it.
- **Workspace/paths** (`services/workspace.ts`): `resolvePaths(...)` already returns
  `configPath` (`<root>/config`) and computes `isPreparedDrive` by checking
  `config/drive.json`. So the policy/drive files have a known home. `DriveStatus` already exposes
  `rootPath`/`workspacePath`/`modelsPath`/`logsPath` for the "where your data lives" panel.
- **Local-only logger** (`services/logging.ts`): rotating `app.log` under `logsPath`, never
  uploads. The privacy/diagnostics copy can state this as fact; just confirm nothing else writes
  logs off-device.
- **Security posture in `main/index.ts`** is already hardened: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`; `will-navigate` blocks remote
  origins; `setWindowOpenHandler` opens external links in the OS browser (deny in-app). Phase 8
  **adds a CSP + a network self-check on top**, it doesn't redo this.
- **Privacy nav already exists**: `App.tsx` routes `privacy` → a
  `PlaceholderScreen title="Privacy & Offline Mode" phase="Phase 8"`, and the sidebar has a
  static `offline-badge`. Replace the placeholder with a real screen; make the badge reflect the
  live status.
- **`developerMode` + `workspaceMode`** already on `AppSettings` (`plaintext_dev` default);
  encryption itself is **Phase 9** — Phase 8 only **clearly separates + labels** plaintext dev
  mode and warns, it does not encrypt.
- **No-network test pattern** is established in `tests/integration/rag.test.ts` and
  `tests/integration/benchmark.test.ts`.

## YOUR TASK: Implement Phase 8 — "Privacy & offline hardening" (spec Milestone 8 / Step 10)

Follow `BUILD_STATE` §5 and the Phase 8 plan section, in order:

1. **`services/policy.ts` (new) — load + merge the privacy policy.** A pure, testable loader
   that reads `config/policy.json` and `config/drive.json` (both **optional** — dev falls back to
   defaults) and merges them over a **deny-by-default** `DEFAULT_POLICY` (network off, telemetry
   off). Model the spec §6 shape: `network { allowModelDownloads, allowUpdateChecks,
   allowTelemetry }`, `workspace { encryptionRequired, allowPlaintextDevMode }`, `models
   { allowUnverifiedModels, requireManifest, requireSha256Match }`. Resolve the **effective
   network permission** = policy permits **AND** the user's `allowNetwork` setting (a signed
   policy file can *forbid* network even if the user toggles it on; the toggle can only enable
   what policy allows). Keep it **pure** (parse takes the file contents / a config dir; no
   surprises), resilient to malformed/missing JSON (→ safe defaults + a warning, never a throw).

2. **Offline status surface + startup self-check.**
   - Make `AppStatus` policy-aware: `offlineMode` should reflect the **effective** state (policy
     ∧ setting), and consider adding `networkAllowed: boolean` so the UI can distinguish
     "off by choice" from "disabled by policy" (spec §3.6 wording). Add a **`getPolicy()` IPC**
     (new channel `policy:get` in `shared/ipc.ts`) returning the effective policy + derived
     flags; expose on preload `api` + `PreloadApi`.
   - Add a **startup self-check** (`assertOfflinePosture()` or similar, called in `initBackend()`)
     that **logs** the offline posture and installs a lightweight guard which flags any outbound
     **non-loopback** connection while offline (spec §3.6 "no network calls by design"). **Crucial
     caveat:** must allow `127.0.0.1`/`localhost` (the dev renderer URL today, and the future
     Phase-10 llama.cpp sidecar on 127.0.0.1) — only remote origins are a violation. Keep it
     defensive (log, don't crash the app), and gate the noisy part behind dev/`developerMode` if
     needed.

3. **`PrivacyScreen.tsx` (new) — the Privacy & Offline page.** Replace the `privacy`
   `PlaceholderScreen` in `App.tsx`. Render (spec §7.10 + §18.1, verbatim where given):
   - The offline statement copy ("Offline Mode is on. … Your prompts, documents, embeddings, and
     chat history stay local.") and the no-cloud explanation.
   - **Where your data lives** — reuse `getDriveStatus()` to show workspace / models / logs /
     drive-root paths.
   - The **current network state** (off by default; "disabled by policy" when policy forbids),
     and the §3.6 "warn before any network action" framing.
   - A clear, **separated** note about **plaintext developer mode** vs the encrypted default
     (Phase 9), and that **logs are local-only and never uploaded** (spec §7.11).
   - Wire the sidebar `offline-badge` (and Home's "Offline Mode" stat) to the **live** status.

4. **Content-Security-Policy (defense in depth, spec §3.5).** Add a strict CSP so the renderer
   cannot reach remote origins (e.g. `default-src 'self'`; no remote `connect-src`/`img-src`).
   Apply via `session.defaultSession.webRequest.onHeadersReceived` (or a production-only meta
   tag). **Dev caveat:** Vite HMR needs `ws://localhost` + `'unsafe-inline'`/eval in dev — apply
   the strict policy in **production** and a HMR-compatible one in dev, or you'll break
   `npm run dev`. Verify the existing `will-navigate` / `setWindowOpenHandler` guards still hold.

5. **Audit pass (no-network + logs-local).** Sweep the **core path** for any accidental network
   (there shouldn't be any) and confirm **no log/crash data leaves the device**. Capture the
   result as a test (below), not just prose.

6. **Tests** (keep all **119** existing green): policy parsing (valid file, missing file →
   defaults, malformed → defaults + warning), **deny-by-default** (no files → network off),
   effective-permission logic (policy forbids ⇒ off even when the user setting is on; both on ⇒
   on), the `getPolicy`/`offlineMode`/`networkAllowed` derivation, the **startup self-check
   allows loopback but flags a remote connection**, and a **no-network integration assertion
   across the core path** (settings + status + policy load make zero `http`/`https`/`net`/
   `Socket`/`fetch` calls — reuse the Phase-7 spy pattern). Use the `freshDb` + vitest-spy
   patterns from Phases 5–7.

7. **Ritual:** add/refresh docs — `docs/security-model.md` (security baseline, CSP, the offline
   self-check + loopback exception, policy precedence) and finalize a `PRIVACY.md` (the §18.1 /
   §7.10 user-facing statement); bump any `_Last updated_`. Update `BUILD_STATE.md` (mark Phase 8
   done; add contracts for `policy.ts` / `getPolicy` / policy precedence / the self-check; set
   Phase 9 — encrypted workspace — as next actions; log decisions [policy shape + deny-by-default,
   effective-permission rule, loopback exception, CSP dev-vs-prod split, logs-local guarantee] and
   any risks). Commit.

## Notes / gotchas

- **Policy precedence:** a (future signed) `policy.json` is **authoritative** — it can only
  *restrict*, never expand, what the user setting permits. Effective network = `policy ∧ setting`.
  Telemetry is **always** off (no toggle).
- **Loopback is not "network".** The offline self-check must permit `127.0.0.1`/`localhost`
  (dev renderer now; llama.cpp sidecar in Phase 10) and only treat **remote** origins as a
  violation — otherwise you'll break dev and Phase 10. Real runtimes MUST bind 127.0.0.1 only
  (already a documented rule).
- **Don't break dev.** A too-strict CSP or an over-eager net guard will break `npm run dev`
  (Vite HMR over `ws://localhost`) and the dev renderer load (`http://localhost`). Split
  dev-vs-prod behavior and keep the loopback exception.
- **No new deps expected.** JSON policy parsing is built-in `JSON.parse`. If you must add one,
  install with `NODE_OPTIONS=--use-system-ca npm install <pkg>` (TLS-intercepting proxy,
  BUILD_STATE R6).
- **Encryption is Phase 9, not here.** Phase 8 separates/labels plaintext dev mode and warns; it
  does not implement encryption.
- **User-facing copy** comes straight from spec §3.6 / §7.10 / §18.1 — use it verbatim where the
  spec gives exact text.

## ENVIRONMENT NOTES (important)

- **Verify commands** (from repo root): `npm run typecheck`, `npm test`, and
  `NODE_OPTIONS=--use-system-ca npm run build`. **Green = typecheck + test + build.** ESLint is
  NOT installed; `npm run lint` fails by design and is NOT part of green. Live `npm run dev` is a
  manual step — don't block on it (but **do** make sure your CSP/net-guard changes don't break the
  dev renderer load).
- **All 119 existing tests must stay green.** Platform is Windows/PowerShell; `node:sqlite` lives
  in Electron's bundled Node (loaded via `createRequire` in `db.ts`) — tests run under system Node
  via vitest. `.all(param)` / `.get(param)` bind positional params (pass them).
- The register*Ipc modules import `electron`, so (as in prior phases) **test the services
  directly** (`policy.ts`, `getSettings`/status derivation) rather than the ipcMain handlers.

## END-OF-PHASE RITUAL (mandatory — a phase is not done until this is complete)

1. `npm test` (all green) + `npm run typecheck` (clean) + `NODE_OPTIONS=--use-system-ca npm run
   build` (green).
2. Update affected docs: `docs/security-model.md` + `PRIVACY.md` (the offline/privacy statement),
   bump `_Last updated_`.
3. Update `BUILD_STATE.md`: mark Phase 8 done, refresh data contracts (policy service / `getPolicy`
   / effective-network rule / offline self-check / CSP), set Phase 9 as next actions, log new
   decisions and any risks.
4. Commit referencing **"Phase 8 / Milestone 8"**. Use `git -C f:/_coding/ai_drive` for git (note:
   forward slashes — backslashes get mangled by the Bash tool), and end the commit message with:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   (When committing via the Bash tool, pass the message with a here-doc `-F -`, **not** PowerShell
   `@'...'@`.)

When done, report what was built, test results, and what Phase 9 will tackle.
