# Private AI Drive Lite — Troubleshooting

_Last updated: 2026-06-09 (Phase 13)_

Quick answers to common situations. Everything here is normal, local, and offline — none of
these steps require the internet.

---

## Starting the app

Open the drive and **double-click the launcher** at the top level:

- **Windows:** `Start Private AI Drive`
- **macOS:** `Start Private AI Drive.command`
- **Linux:** `start-private-ai-drive.sh`

You do **not** need to install anything. The launcher finds the drive automatically, wherever it is
plugged in, so the same drive works on any computer.

---

## "Windows protected your PC" / "macOS cannot open the app"

The first time you run an app from a USB drive, your computer shows a security warning. **This is
normal for any new app** and does not mean anything is wrong — it appears because the app is new to
*this* computer, not because it is unsafe.

**Windows (SmartScreen) — blue window "Windows protected your PC":**
1. Click **More info** (small link in the dialog).
2. Click **Run anyway**.

**macOS (Gatekeeper) — "cannot be opened because it is from an unidentified developer":**
1. **Right-click** (or Control-click) the launcher / app, then choose **Open**.
2. Click **Open** again in the dialog.

You usually only have to do this **once** per computer. On a signed commercial drive these dialogs
should not appear at all.

> For a drive builder: signed (Windows) + signed & notarized (macOS) builds avoid these dialogs
> entirely — see the signing section of [`packaging.md`](packaging.md). The steps above are the
> fallback for an **unsigned** (DIY) build.

---

## "Offline Mode is ON — is something wrong?"

**No. That is the intended state.** Private AI Drive Lite runs the AI model on your laptop and
keeps your data local. It does not need the internet and network access is off by default. You
can confirm this on the **Privacy** screen.

---

## The answers look like placeholders / "echo" replies

The app is running its built-in **mock** runtime — started via **Start mock runtime** on the
Models screen, or selected automatically when the model's weight file or the `llama-server`
binary is missing at start time. The mock lets you explore the interface, but it does not
produce real AI answers.

**Fix:** add a real model file:
1. On the **Models** screen, note the model marked *Recommended*.
2. Put the matching `.gguf` weight file into `models/chat/` on the drive (and the embeddings
   model into `models/embeddings/`). File names come from the model's manifest (`local_path`).
3. Put the `llama-server` program for your system into `runtime/llama.cpp/win` (Windows),
   `runtime/llama.cpp/mac` (macOS), or `runtime/llama.cpp/linux` (Linux).
4. Restart the app and **Start** the model again.

If you have the repo, a drive builder can do steps 2–3 with the prepare-drive + verify-models
scripts (see [`packaging.md`](packaging.md)).

---

## "The selected model is not installed on this drive."

The model's weight file is missing from the `models/` folder. Add the file (above), or choose
a model shown as **Installed**. The app never downloads models for you — that keeps it offline.

---

## A model shows "checksum failed"

The model file on the drive doesn't match the expected fingerprint in its manifest. The file
may be incomplete or corrupted. Re-copy the weight file, then run the verifier:

```powershell
.\scripts\verify-models.ps1 -Target E:\         # Windows
```
```bash
scripts/verify-models.sh --target /Volumes/PRIVATE_AI_DRIVE   # macOS/Linux
```

On a developer drive, unverified models are allowed; a commercial drive requires a matching
checksum.

---

## I forgot my workspace password

Encrypted workspaces are protected by your password, which is **never stored**. If you forget
it, the data **cannot be recovered** — this is by design. Create a new workspace to start over
(your old encrypted data remains on the drive but unreadable).

---

## The app feels slow

- **Slow drive:** running from a slow USB stick makes model loading and indexing sluggish. Use
  a fast USB 3 / SSD drive, or copy the drive's contents to your computer. The **Diagnostics**
  screen reports your drive's read/write speed and warns if it's slow.
- **Heavy model for your laptop:** pick the **Recommended** model on the Models screen. The
  benchmark suggests a model that suits your RAM/CPU. Larger models are more capable but slower.
- **First start of a model** is always slower (it loads into memory); later prompts are faster.
- **Graphics acceleration:** on most computers with a graphics card, responses are
  automatically accelerated — nothing to configure. The **Diagnostics** screen's
  *Acceleration* line shows whether your graphics card is being used.

---

## "Switched to compatibility mode" — what does that mean?

Nothing is broken. The app tried to use your graphics card to speed up responses, hit a
stability issue (often an outdated graphics driver), and automatically switched to
**compatibility mode** — responses now run on your processor, which works on every machine.
Everything keeps working; responses may just be a bit slower.

- You don't have to do anything. The app remembers this choice so it doesn't retry on every
  start.
- If you update your graphics driver later, open **Diagnostics → Try GPU again** to let the
  app use the graphics card again.
- You can also turn acceleration off yourself under **Settings → Use GPU acceleration**
  (it is on by default).

---

## Importing a PDF didn't extract any text

Some PDFs are scanned images with no embedded text. OCR (reading text from images) is **not**
included in this Lite version, so those files can't be indexed. Use a text-based PDF, or paste
the text into a `.txt`/`.md` file and import that.

---

## A document failed to import

Open **Documents** to see the per-file error. Common causes: an unsupported file type, a
corrupted file, or a password-protected document. Supported types: txt, md, pdf, docx, csv.
Other files in the same import still succeed.

---

## The app won't start from the drive

- Use the **launcher** at the drive root (`Start Private AI Drive`) rather than opening the
  `.exe`/`.app` directly — the launcher points the app at the drive's workspace.
- If you saw a security warning, follow **"Windows protected your PC" / "macOS cannot open the app"**
  above.
- On Windows, the portable `.exe` may take a few seconds on first launch — wait for the window.
- Check that the drive has free space and is writable. The app shows a friendly note on the Home
  screen if the drive is read-only, low on space, or slow (none of these block you).
- If the drive was just prepared, confirm `config/drive.json` exists at the drive root.

---

## Where are my data and logs?

Everything is on the drive:
- `workspace/` — your encrypted/plaintext database (chats, documents, embeddings).
- `logs/app.log` — local logs only; never uploaded.
- `models/` — model weights. `config/` — drive settings/policy.

See [`drive-layout.md`](drive-layout.md) for the full layout.
