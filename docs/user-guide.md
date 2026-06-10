# Private AI Drive Lite — User Guide

_Last updated: 2026-06-10 (Phase 18)_

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
   - **Recommended** — the largest model that runs comfortably in this computer's memory.
   - **Not downloaded** — the model file isn't on the drive (see Troubleshooting).
   - **Needs ≥N GB RAM** — this computer has less memory than the model's minimum, so it
     can't be selected or started here. Pick a smaller model — quality stays great.
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

### Downloading a model (optional, off by default)

A model marked **Not downloaded** can be fetched from inside the app — for example the larger
8B model after you upgrade to a 16 GB laptop. This is the **only** thing the app ever uses the
internet for, and it never happens by itself:

1. Open **Settings** and turn on **Allow internet access for model downloads and updates**
   (it is off by default; the app is fully usable without it).
2. On **Models**, click **Download** on the model you want. A confirmation shows the size,
   the license (with a link), and the address the file comes from. If the model's license
   hasn't been pre-reviewed, you'll also tick a box accepting it.
3. The download shows its progress on the model's card; you can **Cancel** any time. A
   cancelled or interrupted download **resumes where it stopped** when you start it again.
4. The file is checksum-verified before the app will use it — a corrupted download is
   discarded automatically, never silently kept.

One model downloads at a time (they are large). If the Download button is greyed out, the
screen tells you why: either the Settings toggle is off, or this drive's policy has downloads
disabled (common on preconfigured commercial drives — use the drive's update path instead).
Nothing about you or your documents is ever sent; the app only fetches the file.

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

### Answer depth (Fast / Balanced / Deep)

Above the message box you can choose how much work the model puts into each answer:

- **Fast** — quick, to-the-point answers. Great for simple questions and follow-ups.
- **Balanced** — the everyday default. A direct answer with the model's normal care.
- **Deep** — the model **thinks the problem through first**, then answers. Best for tricky
  questions: comparisons, multi-step reasoning, careful writing. Deep answers take noticeably
  longer — that extra time *is* the feature.

While a Deep answer is being worked out, a collapsed **"Thinking…"** section appears above
the reply — click it if you're curious how the model is reasoning. It is a live view only:
the saved conversation keeps just the answer, and exports never include the thinking text.

The choice sticks per conversation, and **Deep is only offered when the active model supports
it** (all chat models that ship with the drive do). Document answers (**Ask Documents**)
always use Balanced — they are meant to be quick and literal about your files.

---

## 7. Ask your documents (RAG)

1. Open **Documents** and **Import** files (txt, md, pdf, docx, csv) or a folder.
2. Each file shows a status as it is indexed locally (extract → chunk → embed → indexed).
   Imported files are **copied into your workspace**, so the drive stays self-contained.
   **Preview** opens a read-only view of a document's extracted text — exactly what
   document search and answers are based on. (It shows text, not the original layout: on
   an encrypted drive the original file stays encrypted and is never handed to another
   program.)
3. Go to **Chat** and switch to **Ask Documents** mode (or click **Ask My Documents** on the
   Home screen), then ask a question, e.g.
   *"What are the termination rights in this contract?"*
4. The answer includes **citations** — the source file, page/section, and a snippet you can
   expand. If the documents don't contain the answer, the app says so rather than guessing.

**Ask only chosen documents.** On the **Documents** screen, tick the checkboxes next to the
files you care about and click **Ask these documents**. The chat opens with those files shown
as small chips above the message box — answers then come only from them. Remove a chip to
widen the search again (no chips = all your documents).

**Chat vs. Ask Documents.** Plain **Chat** does *not* read your files — it is a general
assistant. When you have documents imported, the Chat tab reminds you of this and offers a
one-click switch, so you never mistake a confident general answer for a document answer.

If the app tells you your documents *"need a quick re-index"*, open **Documents** and use
**Re-index** (or **Re-index all**) — this happens when files were indexed with a different
search model than the one currently active, and takes a moment per file.

> Scanned/image-only PDFs may not extract text (OCR is not included in this Lite version).

---

## 8. Privacy & offline

Open the **Privacy** screen to see where your data lives and confirm the app is offline.
Network access is **off by default** and the app is fully usable with no internet. Logs are
stored **locally** on the drive and never uploaded.

See [`PRIVACY.md`](../PRIVACY.md) for the full statement.

### The Activity panel (what did the app do?)

**Diagnostics → Activity** shows a local record of what the app did and when — models
started and stopped, downloads, document imports, workspace lock/unlock, and changes to
privacy-relevant settings. Use the dropdown to focus on one kind of activity, **Show
earlier activity** to page back, and **Export to file…** to save the record.

The record stays in your workspace (so it is encrypted whenever your workspace is) and is
never uploaded anywhere. It never contains your chat text, your document contents, or your
password — only names, ids, and counts. It keeps the most recent 5,000 entries.

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
