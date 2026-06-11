# Known limitations & accepted trade-offs

_Last updated: 2026-06-11._

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
- **A pre-Phase-32 build cannot open a v2 (envelope) vault.** New vaults — and any vault after
  its first password change — use the descriptor-v2 envelope (`security-model.md`). An older
  app version derives the correct KEK and even passes the verifier, but then tries to decrypt
  the data files with it and fails the GCM tag, surfacing "Could not open the workspace".
  Nothing is harmed or written; opening the drive with a current build works. Accepted: drives
  ship the app alongside the data, so version skew requires deliberately mixing an old app
  with a new workspace.
- **Password-change edge: a post-commit swap interruption can briefly wedge one document.**
  If the one-time v1→v2 migration is interrupted AFTER its descriptor commit but mid file-swap
  (e.g. a transiently locked file on Windows), a not-yet-swapped document sidecar stays under
  the retired key until the next app start, whose recovery rolls it forward; previewing or
  re-indexing exactly that document in the SAME session fails with a friendly error. No data
  loss; self-heals on restart.
- **The persisted checksum cache trusts size+mtime.** Model weights are SHA-256-hashed once and the
  result is cached (in memory and in `AppSettings.checksumCache`) keyed by `(path, size, mtime)` —
  re-hashing multi-GB GGUFs on every visit/launch cost minutes of USB I/O. A same-size,
  mtime-preserving in-place tamper is therefore not re-detected by the app's routine checks (mtime
  is attacker-forgeable anyway). Mitigations: the AI Model screen's **Verify checksum** forces a real
  re-hash, and the ship-time gates (`verify-models --strict`, `assertCommercialDrive`) always hash
  fully.

## Spec features intentionally not built (MVP scope)

- **No dedicated Onboarding wizard (spec §7.1).** The `WorkspaceGate` (create-password / unlock),
  the automatic first-run benchmark, and the Home screen together cover the spec §17 first-run flow.
- ~~`ChatOptions.mode` (Fast/Balanced/Deep) is dead plumbing~~ **Shipped in Phase 20**
  (post-mvp-functionality-plan §8): the composer's answer-depth selector maps to Qwen3's
  native thinking switch (`chat_template_kwargs.enable_thinking` at the pinned b9585) with
  live collapsed reasoning in Deep mode. Accepted edges: the depth choice is
  per-conversation **per session** (not persisted to the DB), and document answers always
  run Balanced (deep-grounded is a wave-2 question).
- ~~`runtime_events` table (spec §8) is created but never written~~ **Shipped in Phase 19**:
  it now holds the local audit log (Diagnostics → Activity), pruned to 5 000 rows on insert.
- **Model states `ready` / `not_recommended` are declared but never produced.**
- ~~GPU detection is permanently `null`~~ **Superseded by Phases 14–16:** the drive's own
  `llama-server --list-devices` is the offline, native-free probe, and the benchmark's GPU
  profile bump is live (conservatively gated — see the GPU section below and
  [`benchmark.md`](benchmark.md)).
- ~~No per-document "ask selected documents" scope (spec §10.4)~~ **Shipped in Phase 17**
  (post-mvp-functionality-plan §5.3): Documents-screen selection → scoped document Q&A with
  removable chips; the scope persists on the conversation.
- **Settings lacks the spec §10.6 Models/Performance/About sections** (Models has its own screen;
  Diagnostics shows version/runtime/model info).
- **No `sample-contract.pdf` fixture** for the canonical spec §17 demo script.
- **Manifest fields `supports_tools` / `bundled_on_preconfigured_drive` are unused**
  (`supports_thinking_mode` became load-bearing in Phase 20 — it gates the Deep answer mode).
  In particular the bundled flag's intent (don't preload the big models on a commercial drive) is
  unimplemented — the pipeline fetches all six weights (~37 GB); curate with
  `fetch-models --only <id>`.
- ~~No in-app model downloader (plan §12.3, deferred)~~ **Shipped in Phase 18**
  (post-mvp-functionality-plan §6): policy ∧ Settings-toggle ∧ per-download confirmation, `.part`
  staging with verify-before-rename, Range resume, one download at a time. Accepted edges:
  - **The startup offline tripwire is not re-evaluated mid-session.** Toggling `allowNetwork` on
    and downloading in the same session leaves the (detection-only, never-blocking) guard
    installed, so the sanctioned download is logged as a remote-connection notice. Cosmetic;
    a restart re-derives the posture.
  - **Download progress display is per-renderer-session.** The job itself runs in the main
    process and survives navigation; after an app restart the progress card is gone but the kept
    `.part` resumes on the next Download click.
  - ~~No audit-log records yet~~ `model_download_started/verified/failed` are recorded since
    Phase 19.
- **Drive updates are manual — Phase 22 (signed offline update bundles, spec §12.3) is still
  OPEN.** There is no update mechanism yet; the `updates/` and `workspace/backups/` directories
  are not created. The manual procedure is documented in [`drive-layout.md`](drive-layout.md)
  ("Updating a drive"). **Blocker: the key-management design** — who holds the signing key and
  where it lives (dev-machine key vs. an offline-born production key; HSM/hardware-token class
  questions), what public key drives trust (and whether DIY drives trust a repo key or generate
  their own), offline key rotation/continuity, and rollback protection. Deliberately **not yet
  decided** (discussed 2026-06-10, decision deferred); Phase 22 needs its own short design doc
  (`docs/update-bundles-plan.md`, outline in
  [`post-mvp-functionality-plan.md`](post-mvp-functionality-plan.md) §10) before any code.
  One constraint already understood from that discussion: a trust anchor cannot be
  retroactively strengthened, so whatever key signs during development must never anchor
  commercial drives — the production key would be a different, offline-generated key.

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
- **Audit log (Phase 19) accepted edges:** events recorded while the vault is locked are
  buffered in memory only — quitting the app before the next unlock drops them (bounded buffer,
  oldest dropped past 100). Lock-on-**quit** and the implicit stop during a model *switch* are
  not audited (only the explicit "Lock now" / stop actions are). A download that completes
  against a placeholder manifest hash records no `model_download_verified` event (checksum
  honesty — the AI Model screen shows UNVERIFIED).

## Retrieval quality (Phase 21, [`rag-design.md`](rag-design.md) §11)

- **`ragMinSimilarity` still defaults to 0 (unmeasured).** The research gate (retrieval-plan §1.3)
  required real E5 score distributions from an indexed corpus; the provisioned test drive was not
  attached, so the floor keeps its locked default. Pending manual item: relevant + irrelevant query
  batches on the `D:\` test drive, then promote a measured default (the floor's semantics under
  reranking — cosine, pre-rerank — are already decided, D12).
- **Reranker latency on CPU is estimated, not measured.** The reranker is pinned to CPU and scores
  up to 2×`topKInitial` truncated candidates per question (estimate: single-digit seconds on a
  mid-range CPU). `PAID_RERANK_SMOKE` reports the real number; the candidate cap + word-truncation
  budgets are the tuning levers. Until measured, the reranker stays an opt-in (provision-the-GGUF)
  feature and is never bundled by default.
- **The FTS5 index duplicates chunk text inside the workspace DB** (a self-contained table was
  chosen over external-content on `chunks`' implicit rowid, which VACUUM may renumber). Bounded by
  the 1 000-chunk/file cap; encrypted at rest with the same DB file.
- **Keyword search is embedder-visibility-scoped by design**: a document whose vectors were
  produced by a different embedder is not keyword-searchable either, until re-indexed — that is
  the Phase-17 honesty rule, not a gap (`REINDEX_NEEDED_ANSWER` tells the user what to do).

## GPU acceleration (Phases 14–16, [`gpu-support-plan.md`](gpu-support-plan.md))

- **Integrated GPUs (Intel Iris Xe / UHD, AMD APU "Radeon Graphics") gain little.** They share
  system RAM, so token generation is often near CPU speed (~1–2×); prompt processing improves
  more (2–4×). This is honest physics, not a bug — the app still uses them automatically when
  the driver is stable, but the hardware-profile bump deliberately ignores them so the model
  recommendation stays RAM-based.
- **Vulkan slower than CPU is possible** on weak-iGPU + fast-CPU machines. v1 does **not**
  auto-benchmark CPU vs GPU and pick a winner (decided, gpu-support-plan §1); the Settings
  "Use GPU acceleration" toggle covers that case.
- **`win/arm64` and `mac/x64` ship no sidecar build** (decided, gpu-support-plan §1). mac/x64 = Intel
  Macs: upstream builds them with Metal **off** and macOS has no Vulkan, so GPU acceleration is
  impossible there regardless; Apple discontinued the line in 2023.
- **Intel Macs are not supported by prepared drives at all** (pre-existing gap surfaced while
  planning the GPU work, not introduced by it): a drive's `mac/` dir holds an **arm64** binary
  that exists but cannot execute on x64, so the runtime selector picks the real backend and
  `start()` fails with a spawn error instead of falling back to the mock — and the fallback
  ladder's rungs 2–3 reuse the same wrong-arch binary. A DIY Intel-Mac user could drop a
  self-built x64 `llama-server` into `runtime/llama.cpp/mac/`; prepared drives do not.
- **A failed first GPU start auto-disables GPU persistently** (`gpuAutoDisabled`) even when the
  underlying cause was not the GPU (e.g. a corrupt model file failing rung 1). Harmless — the
  CPU rungs still run and Diagnostics → "Try GPU again" clears the flag in one click.
- **The probe labels; the ladder guarantees.** `--list-devices` proves enumeration, not stable
  inference — a driver can enumerate fine and crash on the first compute submit. That case is
  handled by the crash auto-fallback (one CPU restart + a friendly notice); the in-flight reply
  is lost, same as today's crash handling.

## Accessibility (Phase-27 WCAG 2.2 AA sweep — consciously accepted)

The Phase-27 sweep contrast-audited every role-token pairing in both themes (fix applied:
`--border-strong` → `--n-500`, the only sub-3:1 non-text boundary that was the SOLE component
identifier), added forced-colors (Windows High Contrast) rules for the two custom-drawn
controls (Switch, strength meter), and verified the reduced-motion kill-switch. Accepted
as-is, with reasons:

- **Hairline `--border` separators are ~1.3:1.** They are decorative row/card separators,
  never the sole identifier of a component (cards pair them with surface fill + shadow;
  inputs use `--border-strong`). WCAG 1.4.11 applies to required boundaries only.
- **The fatal "app could not start" screen shows the raw error string.** §7 keeps error
  codes inside Diagnostics, but when the backend never came up Diagnostics is unreachable —
  the raw string (plus the log pointer) is the only diagnostic the user can relay.
- **The Documents screen's per-row selection checkbox is 15px.** Under the 24px target
  minimum, but WCAG 2.5.8 is satisfied via the spacing exception: the row is ≥40px tall and
  no other target falls within the 24px circle around it.
- **The bundled main process can contain a duplicated, tree-shaken copy of a module**
  (observed: `workspace-vault`'s `WrongPasswordError`/`shredFile`), which breaks cross-copy
  `instanceof`. The wrong-password mapping now also matches `err.name`; other duplications
  are benign (pure functions). Root cause in electron-vite/rollup module ids — not chased
  in this phase.
