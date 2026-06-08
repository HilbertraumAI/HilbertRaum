# Security Policy — Private AI Drive Lite

_Last updated: 2026-06-09_

## Supported versions

This project is a pre-1.0 MVP. Security fixes target the `main` branch only until a stable release
is tagged.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers (a dedicated security contact
will be published before any public release). Do not open public issues for undisclosed
vulnerabilities. There is **no paid bug bounty** at this stage.

## Local threat model (summary)

Private AI Drive Lite is a **local-first, offline** application. Full details live in
[`docs/security-model.md`](docs/security-model.md).

### Assets we protect
- Imported documents, extracted text, embeddings
- Chat history and generated outputs
- Local logs and settings
- The workspace encryption key material

### Primary mitigations
- **No network in the core path** — no cloud, telemetry, or remote endpoints.
- **Context-isolated, sandboxed renderer** — the UI has no direct Node/file/network access; it only
  calls a typed, audited bridge.
- **Strict Content-Security-Policy** — no remote origins are permitted.
- **No model weights or user data in version control.**
- **Encrypted workspace option** — password-derived key (Argon2id, scrypt fallback), AES-256-GCM at
  rest; password never stored.

## Known limitations
- Offline enforcement in the MVP is by **design + policy/UX**, not a hard OS-level firewall.
- The MVP may permit a **plaintext developer workspace** for speed; this is clearly separated and is
  not the commercial default.
- Local-model answers can be wrong or incomplete (hallucination risk); the app is honest about this.
- Scanned-PDF OCR is **not** included in Lite.

## Out of scope (MVP)
- Multi-user access controls, enterprise admin/policy enforcement, hardware DRM/dongles.
