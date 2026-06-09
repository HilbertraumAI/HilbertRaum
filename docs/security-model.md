# Security model — Private AI Drive Lite

_Last updated: 2026-06-09 (Phase 8)_

This document describes the local threat model, the security baseline (spec §3.5), the offline
posture (spec §3.6), and how the privacy policy is loaded and enforced. Encryption-at-rest is
designed here but implemented in **Phase 9**.

## Assets we protect
- Imported documents, extracted text, document chunks
- Embeddings / the local vector index
- Chat history and generated outputs
- Local logs and settings
- (Phase 9) the workspace encryption key material

## Threats considered
- Accidental data exfiltration to a cloud AI provider or telemetry endpoint.
- A compromised or overly-permissive renderer reaching a remote origin.
- A malformed or hostile config file weakening the offline posture.
- Plaintext data at rest on a removable/shared drive (mitigated by Phase 9 encryption; until then,
  clearly labelled).

## Security baseline (spec §3.5)

| Control | Where |
|---|---|
| Context isolation, no node integration, sandboxed renderer | `main/index.ts` `webPreferences` |
| Renderer talks only to a typed `contextBridge` (`window.api`) | `preload/index.ts` |
| `will-navigate` blocks remote origins | `main/index.ts` |
| `setWindowOpenHandler` opens external links in the OS browser, denies in-app | `main/index.ts` |
| **Content-Security-Policy** (meta tag + response header) | `renderer/index.html`, `main/index.ts` |
| **No network in the core path** + startup self-check tripwire | `services/offlineGuard.ts` |
| No model weights / user data in version control | `.gitignore` |
| Encrypted workspace option (Phase 9) | `services/security/` |

### Content-Security-Policy (dev vs prod)
A strict CSP is applied as a response header via `session.webRequest.onHeadersReceived`, on top of
the `index.html` meta tag (defence in depth).

- **Production** (strict): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'`. No remote origins are reachable from the renderer.
- **Development** (HMR-compatible): relaxes `connect-src` to allow `ws://localhost:*` /
  `http://localhost:*` and permits `'unsafe-inline'`/`'unsafe-eval'` for Vite hot-reload. Without
  this split, `npm run dev` would break.

## Offline posture (spec §3.6)

The app makes **no outbound network calls in its core path** — this is a property of the code, not a
firewall. Two layers make it visible and defensible:

### 1. Policy precedence (`services/policy.ts`)
`config/policy.json` and `config/drive.json` are **optional** (developer runs fall back to defaults)
and are merged over a **deny-by-default** `DEFAULT_POLICY` where **network and telemetry are off**.
The policy models the spec §6 shape (`network` / `workspace` / `models` blocks).

A (future signed) `policy.json` is **authoritative**: it can only **restrict**, never expand, what
the user setting permits. The effective network permission is therefore:

```
networkAllowedByPolicy = policy.network.allowModelDownloads || policy.network.allowUpdateChecks
networkAllowed         = networkAllowedByPolicy && userSetting.allowNetwork
offlineMode            = !networkAllowed
```

Consequences:
- **No config files → offline.** The deny-by-default policy keeps the app offline even if the user
  toggles `allowNetwork` on (there is no policy granting network).
- **Policy forbids → offline**, regardless of the user toggle ("Network access disabled by policy").
- **Policy permits + user opts in → network allowed** (the only path to any network use, today only
  the future model-download feature).
- **Telemetry is always off** — there is no toggle and the app emits none.

The renderer distinguishes "off by choice" from "disabled by policy" via `PolicyStatus`
(`getPolicy()` IPC) and shows it on the **Privacy & Offline** screen and the sidebar badge.

### 2. Startup self-check (`services/offlineGuard.ts`)
At startup (`initBackend()`), `assertOfflinePosture()` logs the offline posture and, in
dev/developer mode, installs a defensive tripwire over `net.Socket.prototype.connect`. While
offline, any connection to a **remote** host is logged as a violation.

**Loopback is not "network".** `127.0.0.0/8`, `::1`, and `localhost` are explicitly exempt — the dev
renderer loads from `http://localhost` today and the Phase-10 `llama.cpp` sidecar binds `127.0.0.1`.
Only genuinely remote origins are flagged. The guard **only logs; it never blocks or throws**, so a
wrong host guess can never break local IPC or the future sidecar. Real runtimes MUST bind
`127.0.0.1` only.

## Logs are local-only (spec §7.11)
`services/logging.ts` writes a rotating `app.log` under the workspace `logs/` directory and never
uploads. Diagnostics surfaces local data only; it transmits nothing off-device.

## Workspace modes
- `plaintext_dev` — developer speed; data stored unencrypted. **Clearly labelled** on the Privacy
  screen and Settings; not the commercial default.
- `encrypted` — **Phase 9.** Password-derived key (Argon2id, `scrypt` fallback if the native module
  is unavailable on Node 24), AES-256-GCM at rest, whole-DB-file encryption (no SQLCipher under
  `node:sqlite`). Password is **never stored**; only salt + KDF parameters are kept.

## Out of scope (MVP)
- OS-level firewall enforcement (offline is by design + policy/UX, not a hard network block).
- Multi-user access controls, enterprise admin/policy signing infrastructure, hardware DRM.

## Future improvements
- Sign `policy.json` and verify the signature before honouring it (enterprise edition).
- Optional OS-level network denylist / firewall helper.
- Field-level encryption of sensitive rows in addition to whole-file encryption.
