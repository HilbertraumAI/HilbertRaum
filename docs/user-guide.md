# Private AI Drive Lite — User Guide

_Last updated: 2026-06-09 (Phase 11)_

Private AI Drive Lite is a private AI workspace that runs **entirely on your laptop**, from
a portable drive. Your prompts, documents, embeddings, and chat history stay local. There is
**no cloud, no account, and no internet required**.

---

## 1. What you need

- The Private AI Drive (a USB/SSD drive prepared with the app + a model), **or** the app
  installed on your computer with a model added.
- A laptop running Windows (macOS/Linux also supported).

You do **not** need an internet connection to use the app.

---

## 2. Start the app

### From a prepared drive
1. Plug the drive into your laptop.
2. Open the drive and double-click **Private AI Drive Lite** (`PrivateAIDriveLite-…-portable.exe`
   on Windows).
3. The app opens its own window. The first launch may take a few extra seconds while the
   workspace is prepared.

### From a normal install
Launch the app from your Start menu / Applications folder as usual.

> The app reads its data from the drive it was started from. Technically it follows the
> `PAID_DRIVE_ROOT` location set by the drive's launcher; you don't need to configure this.

---

## 3. First run — your workspace

On first launch you'll set up your **workspace**:

- **Encrypted (recommended / commercial default):** choose a password. Your data is encrypted
  at rest; the password is **never stored** anywhere. You'll enter it each time you unlock the
  drive. If you forget it, the data cannot be recovered — that's the point.
- **Plaintext (developer mode):** no password, data stored unencrypted. Only available on
  developer drives.

After unlocking, you land on the **Home** screen.

---

## 4. The Home screen

Home shows your status at a glance:

- **Offline Mode: ON** — the app is not using the internet.
- **Active model** — the AI model currently selected (e.g. *Qwen3 4B*).
- **Workspace** — Encrypted or Plaintext.

If no model is started yet, Home will point you to the **Models** screen.

---

## 5. Pick and start a model

1. Open **Models**.
2. You'll see the models on your drive with a status:
   - **Installed** — ready to use.
   - **Recommended** — best match for your laptop (based on the hardware benchmark).
   - **Missing** — the model file isn't on the drive (see Troubleshooting).
3. Click a model, then **Start**. The first start of a model can take a little while as it
   loads into memory.

> **No model installed?** The app still works using a built-in **mock** model so you can try
> the interface. Mock answers are placeholders, not real AI responses — add a real model file
> for genuine answers (see Troubleshooting).

---

## 6. Chat

1. Open **Chat** and click **New chat**.
2. Type a message and press Enter. The answer streams in word by word.
3. Use **Stop** to cancel, **Regenerate** to retry, or the copy button to copy a reply.

Everything you type and everything the model replies stays on your device.

---

## 7. Ask your documents (RAG)

1. Open **Documents** and **Import** files (txt, md, pdf, docx, csv) or a folder.
2. Each file shows a status as it is indexed locally (extract → chunk → embed → indexed).
   Imported files are **copied into your workspace**, so the drive stays self-contained.
3. Go to **Chat**, switch to **Ask Documents** mode, and ask a question, e.g.
   *"What are the termination rights in this contract?"*
4. The answer includes **citations** — the source file, page/section, and a snippet you can
   expand. If the documents don't contain the answer, the app says so rather than guessing.

> Scanned/image-only PDFs may not extract text (OCR is not included in this Lite version).

---

## 8. Privacy & offline

Open the **Privacy** screen to see where your data lives and confirm the app is offline.
Network access is **off by default** and the app is fully usable with no internet. Logs are
stored **locally** on the drive and never uploaded.

See [`PRIVACY.md`](../PRIVACY.md) for the full statement.

---

## 9. Lock / quit

- **Lock now** (encrypted workspaces) re-locks your data without quitting.
- Closing the app stops the local model and, for encrypted workspaces, re-locks and protects
  your data automatically.

---

## 10. Move between laptops

Because everything lives on the drive, you can unplug it and plug it into another laptop —
your models, documents, and chat history come with you. Eject the drive safely before
unplugging.

---

Stuck? See [`troubleshooting.md`](troubleshooting.md).
