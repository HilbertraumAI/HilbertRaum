# Privacy Notice — Private AI Drive Lite

_Last updated: 2026-06-09 (Phase 8)_

Private AI Drive Lite runs AI models **locally** on your laptop. This document explains, in plain
language, what the app does and does not do with your data.

## The short version

> Offline Mode is on. Private AI Drive Lite runs the AI model on your laptop.
> Your prompts, documents, embeddings, and chat history stay local.

This app does not send your data to cloud AI providers.

## No telemetry, no cloud

- **No telemetry.** We do not collect usage statistics.
- **No analytics.** No tracking of any kind.
- **No remote crash reporting.** Crashes are logged locally only.
- **No prompt upload.** What you type is processed locally.
- **No document upload.** Imported files are processed locally.
- **No embedding upload.** Vector indexes stay local.
- **No automatic model downloads** unless you explicitly opt in.

## What data is stored, and where

All of the following are stored **locally**, inside your workspace (on the drive or in your app-data
folder):

- Imported documents (or references to them, depending on your setting)
- Extracted text and document chunks
- Embeddings / the local vector index
- Chat history (conversations and messages)
- Generated outputs
- Local debug/audit logs
- App settings

## Offline mode

By default the app makes **no network calls** in its core path. There is a visible **Offline Mode**
indicator (the sidebar badge and the **Privacy & Offline** screen). The only optional network
feature is downloading/updating models, which is **off by default** and must be explicitly enabled
in Settings:

```
[ ] Allow internet access for model downloads and updates
```

Even with that setting on, network access is only used if a drive **policy** permits it. A signed
`config/policy.json` can disable network entirely — it can only restrict, never expand, what the
toggle allows. The effective state is `policy AND your setting`. Telemetry is **always off** and has
no toggle. A startup self-check logs the offline posture and flags (logs, never sends) any attempt
to reach a remote host while offline; local-only connections (`127.0.0.1`/`localhost`) are exempt.

## Model downloads / updates caveat

If — and only if — you enable the setting above, the app may contact a model source you choose to
download model files. Even then, your prompts and documents are never transmitted.

## Deleting your data

Your data lives in your workspace directory. To delete everything, delete the `workspace/` folder
(and, if you want, the `models/` and `logs/` folders) on your drive or app-data location. In-app
export/delete controls are planned.

## Encryption

An encrypted workspace option protects your data at rest with a password you choose. The password is
**never stored**; only a salt and key-derivation parameters are kept. See
[`docs/security-model.md`](docs/security-model.md).
