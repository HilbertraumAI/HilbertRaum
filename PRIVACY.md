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

- Imported documents (a full copy of each imported file is stored in your workspace)
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

Today the app ships **no downloader at all** — the setting above is a forward-looking gate and
enabling it changes nothing in the current version (models are added with the offline
`fetch-models`/`prepare-drive` scripts on a separate machine). If an in-app downloader ships
later, it will run only when that setting AND the drive policy permit it, and even then your
prompts and documents are never transmitted.

## Deleting your data

Your data lives in your workspace directory. To delete everything, delete the `workspace/` folder
(and, if you want, the `models/` and `logs/` folders) on your drive or app-data location. In-app
export/delete controls are planned.

## Encryption

An encrypted workspace option protects your data at rest with a password you choose. The password is
**never stored**; only a salt and key-derivation parameters are kept.

**What is encrypted** (encrypted workspace mode): the workspace database — chat history, extracted
text, chunks, embeddings, settings — and the **stored copies of your imported documents**
(`workspace/documents/`, encrypted with the same vault key).

**What is not encrypted:** the AI model files (public weights, not your data), the app itself, and
the local log file (`logs/app.log`). Logs never contain document contents or chat text, but may
contain file names or paths. While the workspace is **unlocked**, a decrypted working copy of the
database exists on disk (and a transient decrypted copy of a document exists briefly during
re-indexing); both are shredded on lock/quit, and any crash leftovers are shredded at next startup.
Documents imported **before** encryption support existed (or into a plaintext workspace) remain
plaintext until re-indexed. See [`docs/security-model.md`](docs/security-model.md).
