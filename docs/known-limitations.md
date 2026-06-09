# Known limitations & accepted trade-offs

_Last updated: 2026-06-10._

The MVP (Phases 0–13) is feature-complete. Four post-MVP multi-persona audit rounds (2026-06-09)
found and fixed every Critical, High, and Medium finding plus the actionable Lows — see
BUILD_STATE §8 for the remediation summary; the full final audit report is preserved in git history
(`docs/audit-2026-06-09-multi-persona.md`, removed after remediation). What remains below are the
**consciously-accepted** product/architecture decisions and inherent limitations.

## Security & privacy

The encrypted-workspace limitations — a decrypted working copy on disk while unlocked, unencrypted
logs, best-effort shredding on SSDs, no password recovery — are documented in
[`security-model.md`](security-model.md) ("Threat notes / known limitations"). In addition:

- **The offline guard is detection-only and Node-socket-scoped.** It wraps
  `net.Socket.prototype.connect`, logs remote connection attempts, and never blocks (blocking
  app-wide risks breaking loopback IPC and the sidecars). Electron's own `net` module would bypass
  it. The offline guarantee is a property of the code + CSP + deny-by-default policy; the guard is
  a tripwire, not an enforcement layer.
- **`importDocuments` accepts caller-supplied paths.** The IPC handler trusts renderer-supplied
  file paths rather than honouring only picker-returned ones. Hardening against a compromised
  renderer is deferred (the renderer is already sandboxed with context isolation).
- **Archive extraction trusts verified archives.** `fetch-runtime` rejects `extract_to` escapes,
  and archives are SHA-256-verified before extraction — but member paths inside an archive are only
  as trustworthy as the pinned hash in `runtime-sources.yaml`.

## Spec features intentionally not built (MVP scope)

- **No dedicated Onboarding wizard (spec §7.1).** The `WorkspaceGate` (create-password / unlock),
  the automatic first-run benchmark, and the Home screen together cover the spec §17 first-run flow.
- **`ChatOptions.mode` (Fast/Balanced/Deep) is dead plumbing** — accepted over IPC, read by
  nothing; there is no "Fast Mode" UI concept.
- **`runtime_events` table (spec §8) is created but never written.**
- **Model states `ready` / `not_recommended` are declared but never produced.**
- **GPU detection is permanently `null`** — there is no safe cross-platform, offline, native-free
  probe; the benchmark's GPU profile bump stays dormant.
- **No per-document "ask selected documents" scope (spec §10.4)** — Ask Documents always searches
  the whole corpus.
- **Settings lacks the spec §10.6 Models/Performance/About sections** (Models has its own screen;
  Diagnostics shows version/runtime/model info).
- **No `sample-contract.pdf` fixture** for the canonical spec §17 demo script.
- **Manifest fields `supports_thinking_mode` / `supports_tools` / `bundled_on_preconfigured_drive`
  are parsed but unused.** In particular the bundled flag's intent (don't preload the big models on
  a commercial drive) is unimplemented — the pipeline fetches all six weights (~37 GB); curate with
  `fetch-models --only <id>`.
- **No in-app model downloader** (plan §12.3, deferred). Provisioning is script-time on the
  builder's machine; the policy (`network.allow_model_downloads`, deny-by-default) and the user
  `allowNetwork` gate are already in place for when it lands.
- **Drive updates are manual.** There is no spec §12.3 update mechanism; the `updates/` and
  `workspace/backups/` directories are not created. The manual procedure is documented in
  [`drive-layout.md`](drive-layout.md) ("Updating a drive").

## Engineering trade-offs (noted, intentionally unchanged)

- The per-import `jobs` map in `registerDocsIpc` is never pruned (tiny, ephemeral, per-process).
- `getSettings` does not type-guard stored JSON values (the privacy-critical network path is
  double-gated by the policy AND).
- `expandPaths` follows directory symlinks during import expansion.
- Sidecar port selection has a small TOCTOU window between `findFreePort()` and the spawn (no
  retry-on-bind-failure); the startup error is diagnosable via the captured stderr tail.
- The shell scripts re-implement logic whose canonical source is TypeScript (`drive.ts`,
  `assets.ts`, `commercial-drive.ts`, `launcher.ts`). Parity is maintained by convention + review,
  not code generation — see the rule in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
- Docs copied onto a prepared drive (user-guide, troubleshooting) contain repo-relative links that
  do not resolve when read from the drive.
