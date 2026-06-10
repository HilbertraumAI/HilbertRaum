# Private AI Drive Lite — User Guide

_Last updated: 2026-06-09 (Phase 13)_

Private AI Drive Lite is a private AI workspace that runs **entirely on your laptop**, from
a portable drive. Your prompts, documents, embeddings, and chat history stay local. There is
**no cloud, no account, and no internet required**.

---

## 1. What you need

- **The Private AI Drive** — a USB/SSD drive that already has the app **and** the AI models on it.
  Everything is preloaded; you don't download or install anything.
- **A laptop** running Windows (macOS and Linux also work). No admin rights needed.
- **Enough memory (RAM):** about **8 GB** runs the standard model well; **16 GB or more** lets you
  use the larger, more capable model. The app checks your laptop and picks the best fit for you.
- **A free USB port** — ideally **USB-3** (the blue port) for the best speed.

You do **not** need an internet connection, an account, or a credit card to use the app. Nothing you
type or import ever leaves the drive.

> Setting it up yourself from the source code instead? That's the **DIY** path — see the project
> [README](../README.md), which covers downloading the models and pointing the app at them.

---

## 2. Start the app

### From a prepared drive
1. Plug the drive into your laptop.
2. Open the drive and **double-click the launcher** at the top level:
   - **Windows:** `Start Private AI Drive`
   - **macOS:** `Start Private AI Drive.command`
   - **Linux:** `start-private-ai-drive.sh`
3. **First-time security warning?** The very first time you run an app from a USB drive, your
   computer may show a warning ("Windows protected your PC" / "macOS cannot open the app"). This is
   normal. On Windows click **More info → Run anyway**; on macOS **right-click the app → Open**. You
   usually only do this once. (On a signed commercial drive it won't appear.)
4. The app opens its own window. The first launch may take a few extra seconds. If the drive is
   read-only, low on space, or slow, Home shows a friendly note — it won't stop you.

You do **not** need to install anything, and you don't need admin rights.

### From a normal install
Launch the app from your Start menu / Applications folder as usual.

> The launcher finds the drive **from its own location** every time, so the same drive works no
> matter which drive letter it gets. It sets `PAID_DRIVE_ROOT` for you — nothing to configure.

---

## 3. First run — your workspace

On first launch you'll set up your **workspace**:

- **Encrypted (recommended / commercial default):** choose a password. Your chats, settings,
  and the stored copies of your imported documents are encrypted at rest; the password is
  **never stored** anywhere. (Model files and local logs are not encrypted — they contain no
  document contents.) You'll enter the password each time you unlock the drive. If you forget
  it, the data cannot be recovered — that's the point.
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
   - **Not downloaded** — the model file isn't on the drive (see Troubleshooting).
3. Click a model, then **Select** and **Start runtime**. The first start of a model can take a
   little while as it loads into memory.

Once a model is **selected**, the app loads it again automatically every time you start the
app (after unlocking, on encrypted drives) — you don't have to come back to this screen. You
can turn this off under **Settings → Load the selected model automatically**.

> **First visit can take a few minutes:** the app verifies each model file's checksum the
> first time it sees it. The result is remembered, so later visits are instant. The
> **Verify checksum** button re-checks a file from scratch whenever you want.

> **No model installed?** You can still try the interface: a model without a weight file shows
> a **Start mock runtime** button (in developer mode) that runs a built-in mock model. Mock
> answers are placeholders, not real AI responses — add a real model file for genuine answers
> (see Troubleshooting).

### Speed: graphics-card acceleration (automatic)

If your computer has a graphics card (NVIDIA, AMD, or Intel), the app uses it automatically to
make responses much faster — on a typical gaming laptop that's the difference between "a few
words per second" and "faster than you can read". There is nothing to install or configure:

- **Diagnostics → Acceleration** shows whether your graphics card is being used.
- If the graphics driver ever causes trouble, the app switches itself to **compatibility mode**
  (processor only — works on every machine) and tells you with a one-line note. After a driver
  update, **Diagnostics → Try GPU again** re-enables the graphics card.
- You can turn acceleration off under **Settings → Use GPU acceleration** if you prefer.
- Small built-in graphics chips (e.g. Intel Iris Xe) give only a modest boost — that's normal;
  big speedups come from dedicated graphics cards.

---

## 6. Chat

1. Open **Chat** and click **New chat**.
2. Type a message and press Enter. The answer streams in word by word, with formatting
   (bold, lists, tables, code blocks) rendered as the model writes it.
3. Use **Stop** to cancel, **Regenerate** to retry, or the copy button to copy a reply.
4. To remove a conversation, click the **✕** next to it in the sidebar (works for document
   Q&A conversations too). This permanently deletes the conversation and its messages.

Everything you type and everything the model replies stays on your device.

---

## 7. Ask your documents (RAG)

1. Open **Documents** and **Import** files (txt, md, pdf, docx, csv) or a folder.
2. Each file shows a status as it is indexed locally (extract → chunk → embed → indexed).
   Imported files are **copied into your workspace**, so the drive stays self-contained.
3. Go to **Chat** and switch to **Ask Documents** mode (or click **Ask My Documents** on the
   Home screen), then ask a question, e.g.
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

- **Lock now** (encrypted workspaces) re-locks your data without quitting. It also shuts down
  the AI model so nothing you typed stays in memory; after unlocking, your selected model loads
  again automatically.
- Closing the app stops the local model and, for encrypted workspaces, re-locks and protects
  your data automatically.

---

## 10. Move between laptops

Because everything lives on the drive, you can unplug it and plug it into another laptop —
your models, documents, and chat history come with you. Eject the drive safely before
unplugging.

---

Stuck? See [`troubleshooting.md`](troubleshooting.md).
