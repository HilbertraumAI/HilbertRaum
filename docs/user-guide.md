# Private AI Drive Lite — User Guide

_Last updated: 2026-06-10 (Phase 27)_

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

## 3. First run — guided setup

The first launch walks you through a short, full-window setup:

1. **Welcome.** A quick orientation: everything stays on this drive — no internet, no
   account, no tracking. Click **Get started**.
2. **Create your password.** This password locks everything in your workspace — chats,
   settings, and the stored copies of your imported documents — on the drive. (Model files
   and local logs are not encrypted — they contain no document contents.) The password is
   **never stored** anywhere, and if you forget it the data cannot be recovered — that's
   the point. While you type, a small strength meter offers honest advice (longer is
   stronger); it never blocks you. **Show** reveals what you typed, and pasting from a
   password manager works normally. On developer drives a toggle offers a **plaintext
   workspace** (no password, unencrypted) instead.
3. **One last thing (only if no AI model is on the drive yet).** Commercial drives come
   with a model preinstalled, so most people never see this step. If your drive has none,
   you can jump straight to choosing a model or adding documents — or **Skip for now** and
   do it later. Downloading a model stays optional and always asks for your confirmation
   first (see §5).

Setup ends in **Chat**, ready for your first question. On every later launch you just
enter your password on a single unlock screen.

---

## 4. Finding your way around

The sidebar has four everyday destinations — **Home**, **Chat**, **Documents**, and
**AI Model** — plus **Settings** at the bottom. Privacy and Diagnostics live inside
Settings as tabs (see §8).

A quiet **🔒 Local · Offline** status sits at the bottom of the sidebar and in the chat
header. Hover it for the short version — *"Everything stays on this drive. No internet
connection is used."* — or click it to open the full privacy details. If you have enabled
internet access for model downloads, it says so honestly: **Local · Downloads allowed**
(your chats and documents stay local either way).

### The Home screen

Home answers "is everything ready?" at a glance:

- **Workspace** — Encrypted (protected by your password) or Plaintext (developer mode).
- **AI model** — whether a model is running, still loading, or not chosen yet. If none is
  selected, a **Choose a model** button takes you to the AI Model screen; once your model
  is up, the row flips to **Running** by itself.
- **Documents** — how many files are ready to ask about, with an **Add documents** shortcut
  when there are none.

**Start chatting** is the one big button — everything else is a quiet shortcut. If the
drive is read-only, low on space, or slow, a friendly note appears here too; it never
blocks you.

---

## 5. Pick and start a model

1. Open **AI Model**. Your current model (if one is selected) is shown first; the rest are
   below as alternatives, each with a plain-language note on its size and speed. The file
   paths, checksums, and other internals are tucked behind each card's **Technical
   details** — you never need them for everyday use.
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
> **Verify checksum** button (under a card's **Technical details**) re-checks a file from
> scratch whenever you want.

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
2. On **AI Model**, click **Download** on the model you want. A confirmation shows the size,
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

- **Settings → Diagnostics (advanced) → Acceleration** shows whether your graphics card is
  being used.
- If the graphics driver ever causes trouble, the app switches itself to **compatibility mode**
  (processor only — works on every machine) and tells you with a one-line note. After a driver
  update, **Try GPU again** on the same Diagnostics tab re-enables the graphics card.
- You can turn acceleration off under **Settings → Use GPU acceleration** if you prefer.
- Small built-in graphics chips (e.g. Intel Iris Xe) give only a modest boost — that's normal;
  big speedups come from dedicated graphics cards.

---

## 6. Chat

The Chat screen is built around the conversation itself: your conversations on the left
(grouped by day), the transcript in the middle, and the message box at the bottom. At the
top, one switch — **Chat | Ask my documents** — picks what your next conversation does:
plain Chat is a general assistant; *Ask my documents* answers from your imported files,
with sources (see §7).

1. Open **Chat**, type a message, and press **Enter** to send (**Shift+Enter** makes a new
   line). The box grows as you type. The answer streams in word by word, with formatting
   (bold, lists, tables, code blocks) rendered as the model writes it.
2. While an answer is streaming, the send button becomes **Stop** — click it (or tab to it)
   to cancel.
3. Hover over (or tab to) any answer for its actions: **Try again** regenerates the latest
   answer, **Copy** copies it, and **Save** saves the conversation to a file of your choice.
   A small "Copied" / "Saved" note confirms each one.
4. **Save this conversation** is also in the **⋯** menu at the top right of the chat. The
   file is written wherever you choose — nothing leaves the device otherwise.
5. To remove a conversation, hover over it in the list and open its **⋯** menu (or
   right-click the row), then choose **Delete conversation** and confirm. This permanently
   deletes the conversation and its messages — document Q&A conversations too.
6. Need more room? The **«** button hides the conversation list; **»** brings it back. The
   app remembers your choice.

Starting fresh? The empty chat suggests a few example questions — click one to put it in
the message box — and, if you haven't imported anything yet, offers **Add documents to ask
about them**.

Everything you type and everything the model replies stays on your device.

### Find something you talked about (search)

The search box at the top of the conversation list looks through **everything you and the
model have ever written** — your questions and the answers alike. Type a word or two
("liability cap", an invoice number, a name) and matching conversations appear as you type,
each with a short extract around the match, the matched words highlighted. Click a result
to open that conversation; press **Esc** or clear the box to get your normal list back.

Search runs entirely on this drive: nothing is sent anywhere, and your searches are not
recorded — not even in the local Activity panel. On an encrypted workspace the search index
lives inside the same encrypted file as your conversations, so it is protected at rest like
everything else (and search, like chat, is only available after you unlock).

### Answer detail (Quick / Balanced / Thorough)

**Answer detail**, just under the message box, chooses how much work the model puts into
each answer:

- **Quick** — short, to-the-point answers. Great for simple questions and follow-ups.
- **Balanced** — the everyday default. A direct answer with the model's normal care.
- **Thorough** — the model **thinks the problem through first**, then answers. Best for
  tricky questions: comparisons, multi-step reasoning, careful writing. Thorough answers
  take noticeably longer — that extra time *is* the feature.

While a Thorough answer is being worked out, a collapsed **"Thinking…"** line appears above
the reply — click it if you're curious how the model is reasoning; it tucks itself away
when the answer starts. It is a live view only: the saved conversation keeps just the
answer, and saved files never include the thinking text.

The choice sticks per conversation, and **Thorough is only offered when the active model
supports it** (all chat models that ship with the drive do). Document answers
(**Ask my documents**) always use Balanced — they are meant to be quick and literal about
your files.

---

## 7. Ask your documents (RAG)

1. Open **Documents** and **Import** files (txt, md, pdf, docx, csv) or a folder.
2. Each file shows a friendly status while it is prepared locally (Waiting → Reading →
   Preparing → **Ready**).
   Imported files are **copied into your workspace**, so the drive stays self-contained.
   **Preview** opens a read-only view of a document's extracted text — exactly what
   document search and answers are based on. (It shows text, not the original layout: on
   an encrypted drive the original file stays encrypted and is never handed to another
   program.)
3. Go to **Chat** and switch to **Ask my documents** (or click **Ask my documents** on the
   Home screen), then ask a question, e.g.
   *"What are the termination rights in this contract?"*
4. Each answer carries **▸ Sources (N)** — click it to see the cited files, with
   page/section and the exact passage each citation came from. If the documents don't
   contain the answer, the app says so rather than guessing.

**Ask only chosen documents.** Under the message box, **📄 Using N documents** shows which
files answers come from — click it to narrow the question to specific documents, add more,
or go back to **Use all documents**. You can also start from the **Documents** screen: tick
the checkboxes next to the files you care about and click **Ask these documents**.

**Chat vs. Ask my documents.** Plain **Chat** does *not* read your files — it is a general
assistant. The switch at the top of the chat keeps the two modes one click apart, so you
never mistake a confident general answer for a document answer.

If the app tells you your documents *"need a quick re-index"*, open **Documents** and use
**Re-index** (or **Re-index all**) — this happens when files were indexed with a different
search model than the one currently active, and takes a moment per file.

> Scanned/image-only PDFs may not extract text (OCR is not included in this Lite version).

---

## 8. Privacy & offline

Open **Settings → Privacy & data** (or click the **🔒 Local · Offline** status at the bottom
of the sidebar) to see where your data lives and confirm the app is offline. Network access is
**off by default** and the app is fully usable with no internet. Logs are stored
**locally** on the drive and never uploaded.

See [`PRIVACY.md`](../PRIVACY.md) for the full statement.

### The Activity panel (what did the app do?)

**Settings → Diagnostics (advanced) → Activity** shows a local record of what the app did and when — models
started and stopped, downloads, document imports, workspace lock/unlock, and changes to
privacy-relevant settings. Use the dropdown to focus on one kind of activity, **Show
earlier activity** to page back, and **Export to file…** to save the record.

The record stays in your workspace (so it is encrypted whenever your workspace is) and is
never uploaded anywhere. It never contains your chat text, your document contents, or your
password — only names, ids, and counts. It keeps the most recent 5,000 entries.

---

## 9. Appearance (light and dark)

The app follows your operating system's light/dark preference by default. To pick one
explicitly, open **Settings → Appearance** and choose **System**, **Light**, or **Dark** —
the change applies immediately and is remembered on the drive.

One small exception: the lock screen always follows the system theme. Your settings live
inside the encrypted workspace, so before you unlock it the app can't know your choice yet.

---

## 10. Lock / quit

- **Lock now** (encrypted workspaces) re-locks your data without quitting. It also shuts down
  the AI model so nothing you typed stays in memory; after unlocking, your selected model loads
  again automatically.
- Closing the app stops the local model and, for encrypted workspaces, re-locks and protects
  your data automatically.

---

## 11. Move between laptops

Because everything lives on the drive, you can unplug it and plug it into another laptop —
your models, documents, and chat history come with you. Eject the drive safely before
unplugging.

---

Stuck? See [`troubleshooting.md`](troubleshooting.md).
