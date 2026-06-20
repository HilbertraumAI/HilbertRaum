# Privacy Notice — HilbertRaum

_Last updated: 2026-06-20 (Image understanding — local vision analysis + encrypted, deletable history)_

HilbertRaum runs AI models **locally** on your laptop. This document explains, in plain
language, what the app does and does not do with your data.

## The short version

> Offline Mode is on. HilbertRaum runs the AI model on your laptop.
> Your prompts, documents, embeddings, and chat history stay local.

This app does not send your data to cloud AI providers.

## No telemetry, no cloud

- **No telemetry.** We do not collect usage statistics.
- **No analytics.** No tracking of any kind.
- **No remote crash reporting.** Crashes are logged locally only.
- **No prompt upload.** What you type is processed locally.
- **No document upload.** Imported files are processed locally.
- **No audio upload.** Imported recordings are transcribed **on this device** by a local
  speech-recognition model (whisper.cpp) — no cloud speech service is ever involved.
- **No microphone data leaves this device, and none is kept.** Voice dictation (the mic in the
  chat message box) records only while you ask it to, turns the speech into text with the same
  local model, puts the text in the message box for you to review, and securely deletes the
  recording. Dictations are not saved, not logged, and never sent anywhere — the message itself
  is only sent to the local model when you press Send.
- **No scan or photo upload.** Reading scanned PDFs and photos of pages (OCR) happens **on this device** with a local recognition engine and language files stored on the drive — no cloud OCR service is ever involved, and the app never fetches language data at run time.
- **No image upload.** When you ask questions about a picture (the **Images** screen), the image is
  analyzed **on this device** by a local vision model — the bytes are never sent off-device, and no
  cloud image service is ever involved.
- **No embedding upload.** Vector indexes stay local.
- **No automatic model downloads** unless you explicitly opt in.

## What data is stored, and where

All of the following are stored **locally**, inside your workspace (on the drive or in your app-data
folder):

- Imported documents (a full copy of each imported file is stored in your workspace —
  including audio recordings)
- Extracted text and document chunks (for recordings: the locally produced transcript; for scans/photos: the locally recognized text)
- Embeddings / the local vector index
- Chat history (conversations and messages)
- Image-analysis history (each picture you analyze on the **Images** screen, plus its questions and
  answers, is saved so you can revisit it — stored in `workspace/images/`; deletable at any time)
- Generated outputs
- Local debug/audit logs
- App settings

## Offline mode

The app's **core path — chat, documents, indexing, search — always stays local** and makes no
network calls. A visible indicator (in the chat header; clicking it opens
Settings → **Privacy & data**) tells you the current state honestly: **Local · Offline** when
no network is permitted, or "Downloads allowed — chats and documents stay local" when it is. The
only optional network feature is downloading/updating models + the AI engine. That setting is now
**on by default** so a fresh install can fetch models out of the box — but it stays bounded:
every download is explicit and confirmed, and you can turn it off in Settings:

```
[x] Allow internet access for model downloads and updates
```

Even with that setting on, network access is only used if a drive **policy** permits it. A
`config/policy.json` can disable network entirely — it can only restrict, never expand, what the
toggle allows. The effective state is `policy AND your setting`. Telemetry is **always off** and has
no toggle. A startup self-check logs the offline posture and flags (logs, never sends) any attempt
to reach a remote host while offline; local-only connections (`127.0.0.1`/`localhost`) are exempt.

## Model downloads — the app's only network feature

The **only** thing the app can use the internet for is fetching a model file you ask for, from the
**Models** screen. Three things must all be true before a single byte moves:

1. The drive's policy permits model downloads (prepared commercial drives ship with this **off**).
2. You left the Settings checkbox above on (it is **on** by default for a fresh install, unless the
   drive's policy disables it) — or turned it back on if you had switched it off.
3. You confirmed that specific download in a dialog showing its size, license, and source address —
   including explicitly accepting the model's license when it hasn't been pre-reviewed.

The request goes only to the address printed in the model's local manifest; nothing about you, your
prompts, or your documents is sent. There are **no update checks, no model catalog, and no
background downloads** — with the checkbox off (or no internet at all) the app is fully usable and
makes no network calls. Every downloaded file is checked against its expected checksum before the
app will use it.

## Deleting your data

Your data lives in your workspace directory. **In-app deletion** is available for individual items:
you can delete documents, conversations, and image analyses from within the app — on an encrypted
workspace this **shreds** the stored encrypted copy. You can also **export** outputs (document
summaries/translations, chat transcripts) through an explicit save dialog. To delete **everything**
at once, delete the `workspace/` folder (and, if you want, the `models/` and `logs/` folders) on
your drive or app-data location.

## Encryption

An encrypted workspace option protects your data at rest with a password you choose. The password is
**never stored**. The unencrypted vault descriptor (`config/workspace.json`) holds only: a random
salt, the key-derivation parameters, an authenticated verifier (a small known value sealed under the
derived key, used to check your password before the database is touched), and a copy of the random
data key sealed under your password. None of these reveal your password or your plaintext data.

**What is encrypted** (encrypted workspace mode): the workspace database — chat history, extracted
text, chunks, embeddings, settings — the **stored copies of your imported documents**
(`workspace/documents/`), the **analyzed-image history** (`workspace/images/`), and the **local
diagnostics log** (`logs/app.log.enc`) — all encrypted with the same vault key. The log never contains document contents or chat text, but may contain
file names or paths, which is why it is encrypted too. (Lines written *before* you unlock are kept
in memory only and never reach disk.)

**What is not encrypted:** the AI model files (public weights, not your data), the app itself, and
the vault descriptor `config/workspace.json` (the salt, KDF parameters, verifier, and
password-wrapped data key described under *Encryption* below — it must be readable before you unlock,
and holds no password or plaintext data).
While the workspace is **unlocked**, a decrypted working copy of the
database exists on disk (and a transient decrypted copy of a document or image exists briefly during
re-indexing or when you open an image-analysis entry); these are shredded on lock/quit, and any
crash leftovers under `workspace/documents/` and `workspace/images/` are shredded at next startup.
Documents imported **before** encryption support existed (or into a plaintext workspace) remain
plaintext until re-indexed. See [`docs/security-model.md`](docs/security-model.md).
