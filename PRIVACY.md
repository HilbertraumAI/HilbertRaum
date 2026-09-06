# Privacy Notice — HilbertRaum

HilbertRaum runs AI models **locally** on your laptop. This document explains, in plain
language, what the app does and does not do with your data.

## The short version

> Offline Mode is on. HilbertRaum runs the AI model on your laptop.
> Your prompts, documents, embeddings, and chat history stay local.

This app does not send your data to cloud AI providers. One optional feature lets other programs
*on your own computer* use your model — it is off by default, never touches the internet, and is
described under "Letting other apps on this computer use your model" below.

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
- **No translation upload.** When you translate text or a whole document (the **Translate** screen),
  the translation is produced **on this device** by a local translation model — your text and
  documents are never sent off-device, and no cloud translation service is ever involved.
- **No embedding upload.** Vector indexes stay local.
- **No automatic downloads.** Models, the AI engine, and the optional knowledge-pack tools are
  only ever fetched after you explicitly opt in.

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
- Translated documents (a document you translate on the **Translate** screen is saved into your
  workspace like any other document, in `workspace/documents/`)
- Generated outputs
- Local debug/audit logs
- App settings- Hardware check history (up to eight records of the computers this drive has been checked on —
  processor, memory, graphics card, the model that was recommended, and when — plus the
  graphics-card probe and where each model last landed; no computer names, user names or serial
  numbers; nothing is sent anywhere)
- Knowledge packs (offline ZIM archives, e.g. an offline Wikipedia) are used in place —
  never copied, and never encrypted by the workspace vault. The original file stays on disk
  after you lock the workspace and after you remove a pack's registration from the app
  (removing a pack only forgets it — the file itself is untouched). Each pack's title,
  language and file location are stored as workspace metadata, inside the encrypted
  database in encrypted mode, like the rest of your settings. The kiwix-tools programs that
  read and serve packs (`kiwix-serve`, `kiwix-manage`) are a separate, optional download
  (GPL-3.0-or-later, from `download.kiwix.org`) — offered from the **Knowledge packs** panel's
  tools-missing notice or a mirror on the **AI Model** screen the first time you need them, and
  SHA-256-verified like every other download; or you can place the binaries on the drive
  yourself. While unlocked, the app also
  keeps a small generated index file naming your enabled packs' titles and file locations,
  in plain text, under `workspace/zim-transient/`; it is removed when you lock, quit, or
  start the app, though a crash can leave it behind until the next successful
  start/lock/quit cleanup. The pack server that reads it is local — it listens on 127.0.0.1
  only, and no question you ask is ever uploaded anywhere. While the workspace is unlocked
  and a knowledge pack has been used in a chat, other programs running under your own user
  account on this computer can read the enabled packs through the pack server, which has
  no password of its own; locking or quitting stops it.
Two small things live outside the workspace: the app remembers display preferences (such as your
chosen language) in the app-data folder that the built-in browser engine keeps on this computer,
and anything you copy with a **Copy** button is placed on this computer's clipboard, just like
copying text anywhere else.

## Offline mode

The app's **core path — chat, documents, indexing, search — always stays local** and makes no
network calls. A visible indicator (in the chat header; clicking it opens
Settings → **Privacy & data**) tells you the current state honestly: **Local · Offline** when
no network is permitted, or "Downloads allowed — chats and documents stay local" when it is.
The only things the app ever downloads are AI models, the AI engine and the optional
knowledge-pack tools — each one only after you confirm it, each one verified before use. That
setting is now **on by default** so a fresh install can fetch models out of the box — but it
stays bounded: every download is explicit and confirmed, and you can turn it off in Settings:

```
[x] Allow internet access for model downloads and updates
```

Even with that setting on, network access is only used if a drive **policy** permits it. A
`config/policy.json` can disable network entirely — it can only restrict, never expand, what the
toggle allows. The effective state is `policy AND your setting`. Telemetry is **always off** and has
no toggle. A startup self-check logs the offline posture and flags (logs, never sends) any attempt
to reach a remote host while offline; local-only connections (`127.0.0.1`/`localhost`) are exempt.
The built-in browser engine's own background fetches are switched off as well: spell-checking is
disabled, because the engine would otherwise download a spelling dictionary from a Google-operated
server on Windows and Linux the first time you type.

## Model, engine and knowledge-pack-tool downloads — the app's only use of the internet

The **only** thing the app can use the internet for is fetching a model file, the AI engine, or
the optional knowledge-pack tools — from the **AI Model** screen, or, for the knowledge-pack
tools, also from the **Knowledge packs** panel's tools-missing notice. Three things must all be
true before a single byte moves:

1. The drive's policy permits these downloads (drives — including prepared commercial drives —
   ship with this **permitted** so you can add models, the engine or the knowledge-pack tools; a
   drive `policy` can turn it off entirely).
2. You left the Settings checkbox above on (it is **on** by default for a fresh install, unless the
   drive's policy disables it) — or turned it back on if you had switched it off.
3. You confirmed that specific download in a dialog showing its size, license, and source address —
   including explicitly accepting the license when it hasn't been pre-reviewed. The knowledge-pack
   tools are GPL-3.0-or-later and always show that license for you to accept.

The request goes only to the address printed in the model's local manifest — the knowledge-pack
tools instead ride the pinned `runtime-sources.yaml`, not a model manifest, but the same
address-only, no-telemetry rule applies. Nothing about you, your prompts, or your documents is
ever sent. There are **no update checks, no model catalog, and no background downloads** — with
the checkbox off (or no internet at all) the app is fully usable and makes no internet calls.
Every downloaded file is checked against its expected checksum before the app will use it.

## Letting other apps on this computer use your model (local API)

There is one more optional feature that involves a connection — but not an internet one. If you
switch on **Settings → Privacy & data → Local API**, other programs *on the same computer* can send
text to the model you have running and read its answers. It is **off until you turn it on**, and
turning it on asks you to confirm what it means.

- **It never reaches the internet.** The endpoint listens only on this computer's loopback address
  (`127.0.0.1` / `::1`, port 4980 by default). It cannot be reached from your network, and the app
  has no mode, setting, or policy that would let it be. Web pages are structurally locked out
  (browser requests are refused and no CORS headers are ever sent).
- **It is answers only.** Connected apps can ask the model for text. They cannot read your
  documents, your conversations, your search index, or anything else in your workspace — the
  endpoint has no route to any of it.
- **Requests are answered and forgotten.** What a connected app asks and what the model answers are
  held in memory for the length of the request and then dropped. They are **never** written to your
  chat history, your documents, or the logs. The app keeps counts only — how many requests were
  answered or refused — so you can see the feature is being used without a record of what was said.
- **Only the switch itself is recorded.** Turning the feature on or off writes a single entry to
  your local activity log saying which way you set it (`{ enabled: true }` / `{ enabled: false }`)
  and nothing else — no port, no caller, no content. That is the same treatment every other
  privacy-relevant setting gets, and the record never leaves your drive.
- **It answers with the model you already started.** A connected app cannot start, stop, or switch
  a model, and it gets no access to embeddings, image analysis, transcription, or translation —
  only chat completions.
- **It only exists while your workspace is unlocked**, and it stops the moment you lock or quit.
- **An access key is required by default**, so another program has to be given the key before it can
  use your model. You can switch that off; the app tells you what that means when you do.
- **A drive policy can forbid it entirely** — on a managed or commercial drive the card says so
  instead of disappearing.

### Your responsibility

Once a connected app has an answer, that answer is in that app's hands. HilbertRaum cannot control
what it does next: an editor plugin or note app may store the text in its own files, index it, or
sync it to its own cloud service as part of its normal behaviour. That would be **that app**
sending your data somewhere — not HilbertRaum — but the effect on your privacy is the same. Before
you point a program at your model, check its own logging and sync behaviour, exactly as you would
before pasting confidential text into it.

The complete description — how to turn it on, what a connected app can and cannot ask for, and
every control that bounds it — is in [`docs/local-api.md`](docs/local-api.md).

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
password-wrapped data key — it must be readable before you unlock, and holds no password or
plaintext data).
While the workspace is **unlocked**, a decrypted working copy of the
database exists on disk (and a transient decrypted copy of a document or image exists briefly during
re-indexing, when you open an image-analysis entry, or while a document is being translated); these
are shredded on lock/quit, and any
crash leftovers under `workspace/documents/` and `workspace/images/` are shredded at next startup.
Documents imported **before** encryption support existed (or into a plaintext workspace) remain
plaintext until re-indexed. See [`docs/security-model.md`](docs/security-model.md).
