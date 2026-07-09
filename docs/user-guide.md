# HilbertRaum — User Guide

_Last updated: 2026-06-20 (added §8 "Ask about an image" — the Images screen; subsequent sections
renumbered). Previously: Skills — the composer picker, the per-message skill glyph, skills
that run local tools, and Settings → Skills; deep index + coverage meter and tiers;
drag-and-drop files into a chat; the composite source picker; regrouped + collapsible Documents
sidebar; audio transcription, OCR and voice dictation)_

HilbertRaum is a private AI workspace that runs **entirely on your laptop**, from
a portable drive. Your prompts, documents, embeddings, and chat history stay local. There is
**no cloud, no account, and no internet required**.

---

## 1. What you need

- **The HilbertRaum** — a USB/SSD drive that already has the app **and** the AI models on it.
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
   - **Windows:** `Start HilbertRaum`
   - **macOS:** `Start HilbertRaum.command`
   - **Linux:** `start-hilbertraum.sh`
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
> matter which drive letter it gets. It sets `HILBERTRAUM_DRIVE_ROOT` for you — nothing to configure.

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
   stronger); it never blocks you. The **eye button** reveals what you typed, and pasting
   from a password manager works normally. On developer drives a toggle offers a **plaintext
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

The sidebar has seven everyday destinations — **Home**, **Chat**, **Documents**, **Translate**,
**Images**, **AI Model**, and **Skills** — plus **Settings** at the bottom. Settings has three tabs:
**General**, **Privacy & data**, and **Diagnostics (advanced)** (see §10).

A quiet **🔒 Local · Offline** status sits in the chat header. Hover it for the short version — *"Everything stays on this drive. No internet
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
   below as alternatives, each with a plain-language note on its size and speed. When a list
   mixes both kinds, it is split into **On this drive — ready to use** and **Available to
   download** (not-yet-downloaded cards also look quieter), so you can tell at a glance what
   works right now and what would cost a download first. The file paths, checksums, and other
   internals are tucked behind each card's **Technical details** — you never need them for
   everyday use.
2. You'll see the models on your drive with a status:
   - **Installed** — ready to use.
   - **Recommended** — the largest model that runs comfortably in this computer's memory.
   - **Not downloaded** — the model file isn't on the drive (see Troubleshooting).
   - **Needs ≥N GB RAM** — this computer has less memory than the model's minimum, so it
     can't be selected or started here. Pick a smaller model — quality stays great.
   - **Can't verify** — the file is present but its checksum didn't match; re-download it.
   - **Unsupported** — this model can't run on this computer/build.
3. Click a downloaded model, then **Use this model** — this makes it your model *and* starts it, so
   you can go straight to chatting. The first start of a model can take a little while as it loads
   into memory.

Once a model is **selected**, the app loads it again automatically every time you start the
app (after unlocking, on encrypted drives) — you don't have to come back to this screen. You
can turn this off under **Settings → Load the selected model automatically**.

> **First visit can take a few minutes:** the app verifies each model file's checksum the
> first time it sees it. The result is remembered, so later visits are instant. The
> **Verify checksum** button (under a card's **Technical details**) re-checks a file from
> scratch whenever you want.

> **No model installed?** You can still try the interface: a model without a weight file shows
> a **Try in demo mode** button (in developer mode) that runs a built-in demo model. Demo
> answers are simulated placeholders, not real AI responses — add a real model file for genuine
> answers (see Troubleshooting).

### Downloading a model (optional)

A model marked **Not downloaded** can be fetched from inside the app — for example the larger
8B model after you upgrade to a 16 GB laptop. This is the **only** thing the app ever uses the
internet for, and it never happens by itself:

1. Open **Settings** and make sure **Allow internet access for model downloads and updates**
   is on (it is **on by default on a fresh install**, unless this drive's policy disables it —
   common on prepared commercial drives; the app is fully usable without it either way).
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

Some optional models carry a **license you accept before downloading** — the confirmation shows
a link to the license and a tick-box you must check first. The **TranslateGemma** translation
model is one of these: it is downloaded on demand (never bundled), used automatically for
translation once installed, and — like the vision model — needs no starting or selecting.

### Speed: graphics-card acceleration (automatic)

If your computer has a graphics card (NVIDIA, AMD, or Intel), the app uses it automatically to
make responses much faster — on a typical gaming laptop that's the difference between "a few
words per second" and "faster than you can read". There is nothing to install or configure:

- **Settings → Diagnostics (advanced) → Acceleration** shows whether your graphics card is
  being used. The Chat screen's header also carries a small grey note — e.g.
  `qwen3-4b-instruct-q4 · GPU (RTX 3090)` or `… · CPU` — so you can see which model is
  answering, and where it runs, without leaving the conversation.
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
   answer (plain Chat only — not in *Ask my documents*), **Copy** copies it, and **Save** saves the
   conversation to a file of your choice. A small *"Copied"* / *"Saved to …"* note confirms each one.
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

### Dictate a message (voice)

If your drive has the speech model installed (the same one that transcribes audio
recordings — see §7), a small **microphone button** appears next to **Send**:

1. Click the mic to start recording. Your computer's usual microphone indicator turns on,
   and the button pulses while it listens. The first time, Windows/macOS may ask you to
   allow microphone access for the app.
2. Speak, then click the mic again to stop. After a brief moment the recognized text
   appears in the message box, right where your cursor was — it does **not** send
   anything.
3. Read it, fix anything the model misheard, and press **Send** when you're happy. You can
   dictate again to add more.

Dictation happens entirely on this drive: the recording is turned into text by the local
speech model and then securely deleted — it is never saved, never listed anywhere, and
never leaves your device. If no microphone button is visible, the speech model isn't
installed on this drive (you can add it from the **AI Model** screen if downloads are
enabled). German and English both work — speak naturally, in whole sentences, for the
best results.

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
supports it** — the AI Model screen notes which models have a thinking mode; models without
one answer well but skip the thinking step. Document answers
(**Ask my documents**) always use Balanced — they are meant to be quick and literal about
your files.

---

## 7. Ask your documents (RAG)

1. Open **Documents** and **Import files** (txt, md, pdf, docx, csv — audio
   recordings: wav, mp3, flac, ogg — and, when your drive has the OCR files, photos of
   pages: png, jpg) — or **Import folder** to bring in a whole directory at once.
2. Each file shows a friendly status while it is prepared locally (Waiting → Reading →
   Preparing → **Ready**; audio files show **Transcribing… N%**, and a file that can't be
   read shows **Failed**).
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
   A short honesty line under the answer says how much it drew on — e.g. *"Based on 3 of
   12 sections"* — so you can tell an answer rested on a few passages, not the whole
   document. (For full-document coverage, build a deep index — see *Summaries* below.)

**Ask only chosen documents.** Under the message box, a **📄 Answering from:** chip always shows
what answers come from — the document's name when one file is in scope, **your whole library — N
documents** when the whole library is, or **No documents yet · Add documents** when there are none.
Click it to open the source picker: tick your whole **Library**, any **projects**, and/or specific
documents (the scope is the union of everything ticked). You can also start from the **Documents**
screen: tick the checkboxes next to the files you care about and click **Ask these documents**.

**Attach a file to ask about just that file.** Drag a file straight into the chat (or use the
attach button): a chat started this way answers from **that file only** by default, so you don't
have to touch the scope picker. If you drop a file into a chat that was answering from your whole
library, the app asks once whether to narrow to **just this file** or keep using the **whole
library** — your choice sticks for that conversation. Attached files are always included and shown
separately as **Files in this chat**.

**Naming a file in your question works too.** If you haven't chosen documents and your
question names one of your files — *"summarize the key dates in contract.pdf"* — the answer
comes from **that file only**, and a small note says so: *"Answering from contract.pdf
only."* It only ever narrows (never adds files), and any documents you chose explicitly
always win. If the note guesses wrong, just rephrase the question or pick the documents
yourself with the **📄 Answering from:** chip.

**Chat vs. Ask my documents.** Plain **Chat** does *not* read your files — it is a general
assistant. The switch at the top of the chat keeps the two modes one click apart, so you
never mistake a confident general answer for a document answer.

If the app tells you your documents *"need a quick re-index"*, open **Documents** and use
**Re-index** (or **Re-index all**) — this happens when files were indexed with a different
search model than the one currently active, and takes a moment per file.

**Scanned PDFs — "Make searchable (OCR)".** A PDF that is only pictures of pages (a
scanner's output) has no readable text, so the app tells you honestly: *"This PDF looks
like a scan — it has no readable text yet."* If your drive has the OCR files, the row
offers **Make searchable (OCR)** in its **⋯** menu: the pages are read **on this drive** (no cloud OCR —
German and English are included), with per-page progress and a Cancel button. When it
finishes, the document is a normal searchable document; answers cite it **by page**, and
**Preview** shows the recognized text per page with a *"Text recognized on this drive
(OCR)"* note — recognition is good on clean scans but can contain errors on blurry ones.
Reading a scan is never automatic (it takes a couple of seconds per page); you choose
when. **Photos of pages** (PNG/JPG) are the small exception: they are read immediately
on import.

**Each document is a compact row.** On the **Documents** screen every file is one row:
its name and a muted line of details (type, size, sections), any **location/project tags**,
a **status badge** (and small **Summary** / **Deeply indexed** badges once those exist), one
inline **Preview** button, and a **⋯** menu. The **⋯** menu (also opened by right-clicking the
row) holds the document's actions — **Summarize**, **Translate**, **Re-index**, **Build deep
index**, **Make searchable (OCR)**, **Move to project…**, **Export**, and a **Delete** at the
bottom (which always confirms first). Tick a document's checkbox and a **selection toolbar**
appears at the top of the list with the actions that work across documents — **Ask these
documents**, **Compare (2)**, **Move to project…**, **Mark temporary**, **Archive**, and **Delete**.

**Summarize a document.** On the **Documents** screen, every Ready document offers
**Summarize** in its **⋯** menu. The local model writes a summary on this drive — nothing leaves it —
and the result opens in the document's Preview, with a *"Generated by &lt;model&gt; · &lt;date&gt;"*
line so you always know where it came from. The summary is saved with the document and is
still there after a restart; **Regenerate** (in the Preview) writes a fresh one.

**Cover the whole document — Build deep index.** A plain summary covers the most relevant /
opening part of a long document. For full coverage, use **Build deep index** in the document's **⋯** menu:
the app reads the whole document once (a one-time, can-be-minutes background pass on this drive) and
builds a layered summary. Afterwards the Preview shows a **coverage meter** — *"Covers the whole
document"* vs *"the most relevant passages"* — and a depth selector with three tiers: **Overview**,
**Section by section**, and **Detailed**. The deep index can pause for a chat and resume on its own,
so you are never locked out while it runs.

A few honest notes:

- A model must be **running** first (the AI Model screen), and the app runs one job at a
  time: while a summary is being written, chat asks you to wait or **cancel the task**, and
  vice versa. You can always cancel — while a task runs, the row shows its progress and a
  Cancel button in place of Preview and **⋯**.
- For **very long documents** *without* a deep index, the summary covers the beginning of the
  document (the app tells you when that happens). Build a deep index for whole-document coverage. The
  whole document stays searchable and answerable in *Ask my documents* regardless.
- **Re-index** clears a document's summary and deep index (the file's content may have changed) —
  just press Summarize / Build deep index again afterwards.
- Summary quality depends on the model: small models summarize well; very small ones may
  be terse.

**Translate a document.** Every Ready document also offers **Translate** in its **⋯** menu.
Translation uses the dedicated **TranslateGemma** translation model (see the download note
above) — if it is not installed yet, the menu shows **Get the translation model…** instead,
which takes you straight to the AI Model screen. Pick the document's language and the
language you want (**ten** are supported: Deutsch, English, Français, Español, Italiano,
Português, Nederlands, Polski, Čeština, Українська — the app does not guess the source
language) and the model writes a translated copy, fully on this drive. The result is a
**new document** in your list, named like *"report (Deutsch)"*: it is searchable, answerable
in *Ask my documents* (with citations), and you can **Export** it as a Markdown file. The
new document starts with an honest *"Machine-translated by &lt;model&gt; — may contain
errors."* line, and its row shows *"Translated from &lt;original&gt;"* so you always know
where it came from.

A few honest notes about translations:

- Long documents are translated part by part — you see the progress on the row and can
  cancel anytime (a cancelled translation leaves nothing behind). The translation model
  is thorough but not fast: a long document can take many minutes on a CPU laptop.
- If a part cannot be translated even after a retry, the app **marks that part clearly in
  the result and keeps the original text there** — it never silently drops content.
- The translation is a snapshot: if you re-import or re-index the **original**, the
  translated copy does not update — run Translate again.
- Number and date *values*, names, and codes survive, and their formats are adapted to the
  target language (e.g. *14.03.2026* → *March 14, 2026*) — that is how a professional
  translation reads. On long documents a recurring term may occasionally be worded
  differently in different parts.
- If you install the translation model while the app is running, restart the app so the
  Translate action picks it up.

**Compare two documents.** Tick the checkboxes next to **exactly two** Ready documents and
click **Compare (2)** in the selection toolbar (it stays disabled until exactly two are
ticked). The local model writes a structured comparison — what both documents
share, what differs, and what exists only in one — fully on this drive. The result is a
**new document** named like *"Comparison: report vs draft"*: it opens automatically when
done, is searchable and answerable like any import, can be **Export**ed as Markdown, and
its row shows *"Comparison of &lt;A&gt; and &lt;B&gt;"* so you always know where it came from. It
starts with an honest *"Machine-generated comparison by &lt;model&gt; — may contain errors."*
line.

A few honest notes about comparisons:

- Two **short** documents are compared in full. **Long** documents are compared section by
  section: each part of the first document is matched with the most closely related parts
  of the second — great for spotting changes, but findings that exist *only in the second
  document* can be missed. For **very long** first documents the report covers their
  beginning (the report says so when that happens).
- The report's section headings are in English; the findings themselves follow your
  documents' language (German documents get German findings).
- If the app says the documents *"need a quick re-index"*, one of them was prepared with a
  different search model — use **Re-index** on the Documents screen, then try again.
- Like every document task: a model must be running, one job runs at a time, you can
  cancel anytime (a cancelled comparison leaves nothing behind), and the comparison is a
  snapshot — re-run it after the sources change.

**Import an audio recording ("ask your meetings").** Import a **WAV, MP3, FLAC, or OGG**
recording like any document: it is **transcribed on this drive** (nothing is uploaded —
there is no cloud speech service involved) and becomes a normal document — searchable,
answerable in *Ask my documents*, summarizable, translatable. Citations from a recording
show the **time range** the answer came from (e.g. *12:30–16:05*), so you can jump to
that spot in the original audio. **Preview** shows the transcript with those time labels.

A few honest notes about recordings:

- Transcription needs the **transcription model** (the AI Model screen shows it —
  *"Turns audio recordings into searchable text"*). Without it, an audio import fails
  with a friendly note; download the model and **Re-index** the file.
- Listening takes real time on a laptop CPU: roughly **two-thirds of the recording's
  length** (a 30-minute memo ≈ 20 minutes). The row shows **"Transcribing… N%"** and you
  can keep using the app meanwhile.
- Importing **large audio** asks first — the recording is copied into your workspace
  (encrypted on encrypted drives) and transcribed, which costs space and time.
- **Re-index** of a recording transcribes it again from scratch (same duration as the
  import). Preview and the document tasks reuse the stored transcript and are instant.
- **m4a/aac** (some voice-memo apps) is not supported — convert the file to MP3 or WAV
  and import again.
- Transcripts are good but not perfect: unusual names and terms can be misheard. Numbers
  and dates held up well in our German and English checks.

### Organize your documents (Library, Projects, Temporary)

The **Documents** screen has a list of **sections** down the left so a one-off invoice never
pollutes the same pile as your long-term records. It reads as four groups:

- **All documents** (at the top) — everything, regardless of section. This is where you land.
- **Projects** — focused folders you create (e.g. *"Tax 2025"*, *"Client Müller"*). Use the
  **+** next to **Projects** to make one; the **⋯** menu renames, archives, or deletes it. A
  document can be in a project **and** in your Library at the same time — it is the *same* file,
  not a copy, so it is never stored or indexed twice.
- **Locations** — the built-in places a document can live:
  - **Library** — your long-term knowledge base. Everything you import lands here by default and
    it is the default source when you ask your documents.
  - **Temporary** — one-off files you want to read *now* without adding them to your Library
    (for example, a PDF you drop into a chat). They stay here, clearly visible, until you decide
    what to do with them. Nothing is ever deleted automatically.
  - **Generated** — documents the app made for you (translations, comparisons). They show where
    they came from and are kept out of your default answers (see below).
  - **Archived** — documents you've set aside: kept on the drive but left out of answers until
    you un-archive them.
- **Views** — handy filters that just narrow the list (they don't move anything). The common
  ones — *Recently added*, *Unfiled*, *Needs re-index* — are always shown; the rarer diagnostic
  ones — *Large files*, *Failed imports*, *Audio*, *Scanned / OCR* — fold behind a **More**
  toggle and only appear when there's something to show.

Use the **«** handle at the top of the list to **collapse the whole sidebar** when you want the
document list full-width; the **»** handle brings it back. Your choice is remembered.

**Move things around.** Each document row's **⋯** menu files it into a
project (**Move to project…**), **Keep in Library**, marks it **Temporary** or **Archived**, or
(inside a project) removes it from that project. Tick several documents and use the selection
toolbar's **Move to project…** / **Delete** (or mark them Temporary/Archived) to do it in bulk. Deleting a *project* asks
whether to keep its documents (they stay in your Library / other projects) or delete the ones
that live *only* in that project — Library knowledge is never deleted by accident.

### Choose which sources a chat uses

In **Ask my documents**, the **📄 Using…** button under the message box lets you compose
exactly where answers come from: tick **Library**, any **projects**, and/or pick **specific
documents** — they all add together (e.g. *"Library + Tax 2025 + contract.pdf"*). Your choice
is remembered for that chat, even after you restart the app. Files you dropped into the chat
are always included and shown separately as *"files in this chat"*. A chat started inside a
project uses that project to begin with; **"All documents"** is always one tap away.

### Generated documents stay out of answers until you decide

A translation or comparison the app makes is a **work product**, so it is kept out of your
default answers — it lives in **Generated**, explains its origin, and can be **Export**ed. To
make one part of your knowledge, **Export it and re-import** it into the right place. If a
generated document's source later changes, its row shows a quiet **"Outdated — re-run to
update"** note (the app never silently rewrites it; re-run the task when you want a fresh one).

Everything here is local: organizing and scoping never call a model or the
network, and the activity log records only counts and ids — never your project or folder names.

---

## 7a. Translate text

The **Translate** screen turns typed or pasted text into another language, **on this drive**. It
uses the dedicated **TranslateGemma** translation model (the same one the **⋯ → Translate** action
under Documents uses for whole files, §7). The two are separate tasks: use **Translate** for a
quick block of text you have on hand; use the document action when you want a translated *copy* of
a file saved back into your library.

1. Open **Translate** from the sidebar (between **Documents** and **Images**).
2. Pick the languages: **From** (the language your text is in) and **To** (the language you want).
   The model needs to be told the source language — it does not guess — so choose both. The
   **swap** button (↺ between the two) flips them. The ten supported languages are German, English,
   French, Spanish, Italian, Portuguese, Dutch, Polish, Czech, and Ukrainian.
3. Type or paste your text on the left and press **Translate**.
4. The translation streams into the panel on the right. Press **Stop** to cancel it; press **Copy**
   to put the finished text on your clipboard. Long text is translated in order, a section at a
   time, into one continuous result.

**Translate a whole document, right here.** Below the text box you can **drop a document** — a PDF,
Word file, Markdown, or plain text — or click **choose a document**. Pick the **From** and **To**
languages first, just like text. The document is read, translated a section at a time (you'll see
**Translating… (3/12)** counting the sections), and the translated **Markdown** appears in the
panel. From there, **Export…** saves it as a file, **Show in Documents** opens it in your library,
or **Copy** puts it on the clipboard. For a long document the panel shows the **start** of the
translation — export it or open it in Documents to read the whole thing. Drop **one document at a
time**; a file type that can't be read shows a short, friendly note. (This is the same job as the
**⋯ → Translate** action under Documents, §7 — the translated copy is saved either way; the
original you dropped is kept as a **temporary** document.)

Everything stays on the drive — your text and its translation are **never uploaded**. Typed text is
transient: leave the screen (or lock the workspace) and it is gone. A translated **document**,
though, is saved (that's the point) — you'll find it under **Documents**. If the translation model
isn't installed, the screen shows a short note with a **Go to AI Model** button to download it (see
the download note in §6); machine translations can contain errors. While a document task is running,
translating here waits until it finishes.

---

## 8. Ask about an image

The **Images** screen lets you ask a question about **one picture** — a screenshot, a chart, a
form, a receipt, or a photo of a page — and get an answer written **on this drive**. It is a
different tool from reading scanned documents (that's **Make searchable (OCR)** under Documents,
§7) and it never creates or edits pictures — it only *looks at* the one you give it.

1. Open **Images** from the sidebar (between **Translate** and **AI Model**).
2. **Drop an image** onto the screen, or click **choose an image** — **PNG or JPEG**. A preview
   appears with its name, size, and dimensions; **Remove / Replace** swaps it.
3. Type a question, or tap one of the **suggestion chips** (*Summarize this image*, *Extract
   visible text*, *Explain this chart*, *Read this form*, …) to fill the box — you can still edit
   it before sending. Press **Enter** to send.
4. The answer streams in, with a quiet *"Generated locally from the selected image."* note,
   **Copy**, and **Try again**. Ask **follow-up** questions about the same image and they stack up
   as a short thread; **Remove** the image (or pick a new one) returns you to the start of the
   screen — your saved analysis isn't lost, it stays in your image history.

Everything stays on the drive — the picture, your question, and the answer are **never uploaded**.
They **are saved** to your image history (under `workspace/images/`, encrypted at rest on an
encrypted workspace) so you can revisit them: the Images screen lists your past analyses, and you
can reopen or **delete** any of them at any time.

A few honest notes:

- **It needs a vision model on the drive.** If there isn't one, the screen explains what's missing
  and offers **Go to AI Model** (vision models are an optional download, like the larger chat
  models). Without one, the rest of the app is unaffected.
- **The first question about a big image can take a while** — reading a full-resolution picture is
  real work for a laptop processor. Follow-up questions about the *same* image are quicker. A
  graphics card speeds it up where available.
- **One image at a time**, **PNG or JPEG**, and **one question runs at a time** — wait for the
  current answer (or press **Stop**) before asking the next; a question asked while one is still
  running is declined, not queued. It answers from what's **visible** and says so when text is
  unclear — it won't invent hidden details.
- **It's not OCR.** For a scanned PDF or a long document you want to search, use **Make searchable
  (OCR)** under Documents (§7) instead.

---

## 9. Skills

A **skill** is a small, local task pack — a set of instructions (and sometimes app tools) that points
one answer at a particular job: reconciling a bank statement, writing up a meeting protocol, checking
an invoice's totals, or redacting personal data from a document. Skills are **task knowledge, not
secrets** — they're plain files on the drive, they never call a model or the internet on their own,
and like everything else they stay on the drive. The app ships with a few built-in skills, and you
can add your own.

### Professional Documents

A set of built-in skills for everyday document work. They're calm, structured workflows — they read
only the documents you pick, ground their answers in what the text actually says, cite where they
found things, and stay honest when something isn't there. None of them give legal advice or promise
compliance.

- **Meeting Minutes** (*Besprechungsprotokoll*) — turns a transcript, rough notes, or an agenda into
  clean minutes: summary, decisions, action items with owners and deadlines, open questions, and a
  polished formal version.
- **Contract Brief** (*Vertragsübersicht*) — a plain-language brief of a contract: parties, key
  dates, obligations, payment and termination terms, risk clauses, and questions to ask before
  signing. Not legal advice.
- **Deadline & Obligation Finder** (*Fristen & Pflichten*) — pulls out deadlines, notice periods,
  renewal and payment dates, and obligations: what to do, by when, and what happens if you miss it.
- **What Changed?** (*Was hat sich geändert?*) — compares two versions of a document and highlights
  the changes that matter, in business language. Pick exactly two documents or versions.
- **Share-Safe Review** (*Sicher teilen prüfen*) — reviews a document before you share it, flagging
  visible sensitive information and practical risks. Advisory only: it warns that files can hold
  hidden metadata and that scans/images may need a separate look, and it can point you to the
  Document Redaction skill — it never claims a document is anonymized or safe to publish.

### Pick a skill for an answer

Under the message box there's a quiet **Skill:** picker. Choose a skill and it shapes your **next
answer**; the app remembers it as that conversation's default until you change it (pick **None** to
clear it). When a skill shaped an answer, that message carries a small **skill glyph** — an icon and
the skill's name — so you can see at a glance which one was used.

Now and then the picker shows a **one-tap suggestion** ("Use *Bank statement*?") when your question
or the documents in scope look like a fit. It is only ever an offer — nothing is applied until you
tap it.

### Skills that run tools

Some skills — like **Bank statement**, **Invoice**, **Document redaction**, and **Document edit** — can
run small, approved **local tools** on a document you choose: reading it, checking its figures, producing a
redacted copy, or applying targeted text edits. When one runs you'll see a calm run bar — **Running: `<tool>` on `<N>` documents…
Cancel**. A tool that **writes or exports a file** (for example "save as CSV", or "save the redacted
copy") always asks you to **confirm first** and lets you choose where the file goes, and you can
**Cancel** at any point. Everything a tool sees is just the one document you picked — it can't reach
anything else on the drive.

> Redaction is **AI-assisted best-effort**, not a guarantee. It always hides the clearly-shaped data
> (e-mails, phone numbers, IBANs, card numbers, dates, links); when a model is running it also hides the
> **names, addresses, and organisation names** it finds — the model only points at what to hide, it never
> rewrites your document. It can still miss things, and if no model is running only the rule-based part
> applies (the run tells you so). Always review the redacted copy before you share it.

> **Document edit** makes **targeted find-and-replace changes** — for example "replace *Vollmachtgeber*
> with *Vollmachtgeberin* everywhere it refers to the principal". Ask for the change in the chat, then
> click **Apply text edits** and choose where to save the copy. A running model is needed: it only *finds*
> the exact text to change, and the app splices in the replacement — it **never rewrites your document**,
> so nothing else is touched (everything you didn't ask to change stays identical). Any requested text that
> isn't found verbatim is left alone and reported as skipped. Review the copy before you share it.

> **Same format in, same format out.** When your document is a **Word `.docx`**, both redaction and
> document-edit save the copy as a **`.docx` that keeps its formatting** — styles, headings, tables and
> page layout stay intact, because the app only changes the text that had to change and leaves everything
> else in the file exactly as it was. **PDFs and other formats save as a `.txt`** copy that keeps the line
> layout (writing back into a PDF isn't supported). A **scanned PDF** (an image of a page) can only be
> worked on through the text the app recognised from it, so redact those from the `.txt` output.

### Manage skills (open **Skills** in the sidebar)

Open **Skills** in the sidebar to see every installed skill, turn each one **on or off**, and **Import**
or **Delete** your own.

- **Import** takes a `.skill.zip` file *or* a folder that contains a `SKILL.md`. The app checks the
  package safely before it installs anything; if something is wrong it tells you why and installs
  nothing.
- A skill you **drop into the drive's `user-skills/` folder yourself installs switched off** — open
  this tab and toggle it on when you're ready. (A quick safety step, so nothing a file added can run
  without your say-so.)
- Built-in skills can be turned on or off but **not deleted**.
- A skill may show a **"Needs newer app"** badge with its toggle greyed out — it was built for a newer
  version of HilbertRaum than the one you're running. Update the app to use it; until then it stays
  listed but inactive (it can't be switched on, suggested, or run).

You choose when a skill is active; while it is, its **read-only** tools may run automatically to answer
a question you ask, and anything that **writes or exports a file** always asks you to confirm first. As
everywhere else, the activity log records only ids and counts, never your documents' contents or a
skill's figures.

---

## 10. Privacy & offline

Open **Settings → Privacy & data** (or click the **🔒 Local · Offline** status in the chat header)
to see where your data lives and confirm the app's network state. Internet access is used **only**
for optional model/engine downloads — it is on by default on a fresh install so you can fetch a model
out of the box (a prepared commercial drive ships with it off), every download is explicit and
confirmed, and the core app — chat, documents, search — never goes online. Logs are stored
**locally** on the drive (encrypted on an encrypted workspace) and never uploaded.

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

## 11. Appearance (light and dark)

The app follows your operating system's light/dark preference by default. To pick one
explicitly, open **Settings → Appearance** and choose **System**, **Light**, or **Dark** —
the change applies immediately and is remembered on the drive.

One small exception: the lock screen always follows the system theme. Your settings live
inside the encrypted workspace, so before you unlock it the app can't know your choice yet.

---

## 12. Lock / quit

- **Lock now** (encrypted workspaces) re-locks your data without quitting. It also shuts down
  the AI model so nothing you typed stays in memory; after unlocking, your selected model loads
  again automatically.
- Closing the app stops the local model and, for encrypted workspaces, re-locks and protects
  your data automatically.

### Change your password

On an encrypted workspace, open **Settings → General → Change password** while the workspace
is unlocked. Enter your current password, then the new one twice — the same strength hint and
**eye button** as on first run. You'll use the new password from the next unlock on.

- The first change on a workspace created before this feature re-secures every stored
  document under the new password — on a large library that one-time step can take a few
  minutes. Later changes are instant. If the app is interrupted partway through, nothing is
  lost: either the old password or the new one still opens the workspace, never a broken mix.
- The change waits politely: if documents are still importing or re-indexing, finish (or
  cancel) that first.
- Like the password itself, the new one can't be recovered or reset — pick something you'll
  remember.

---

## 13. Move between laptops

Because everything lives on the drive, you can unplug it and plug it into another laptop —
your models, documents, and chat history come with you. Eject the drive safely before
unplugging.

---

Stuck? See [`troubleshooting.md`](troubleshooting.md).
