# HilbertRaum — User Guide

HilbertRaum is a private AI workspace that runs **entirely on your laptop**, from
a portable drive. Your prompts, documents, embeddings, and chat history stay local. There is
**no cloud, no account, and no internet required**.

---

## 1. What you need

- **The HilbertRaum** — a USB/SSD drive that already has the app **and** the AI models on it.
  Everything is preloaded; you don't download or install anything.
- **A laptop** running a system your kit is made for. The kit's label names them — Windows,
  macOS (Apple silicon) or Linux; a kit can cover one or several, and it carries the app and the
  launcher for each one it names. No admin rights needed.
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
2. Open the drive and **double-click the launcher** at the top level (you will find the one for
   each system your kit is made for):
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

### From a downloaded release (GitHub)
If you downloaded a prebuilt package from the project's **Releases** page instead of buying a
prepared drive:
1. **Windows:** put `HilbertRaum-<version>-portable.exe` wherever you like (an external drive or a
   folder) and double-click it. **macOS:** unzip `HilbertRaum-<version>-mac-arm64.app.zip` and open
   the app (keep the zip if you copy it onto an exFAT drive — extract on the target computer).
   **Linux:** make the `.AppImage` executable and run it.
2. The same first-time security warning as above may appear (the release builds are unsigned for
   now) — see [`troubleshooting.md`](troubleshooting.md) for the exact clicks, including the newer
   macOS **System Settings → Privacy & Security → "Open Anyway"** flow.
3. A fresh download has **no AI models yet** — the app starts in demo mode. Get the models either
   with the `prepare-drive --with-assets` script (README step 2) or from inside the app on the
   **AI Model** screen (each download asks first and is checksum-verified).

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
   are not encrypted — they are public weights, not your data. The local diagnostics log is
   encrypted along with your workspace.) The password is
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

The sidebar has three groups: **Chat**, **Documents**, **Translate** and **Images** for everyday
work; **AI Model** and **Performance** (§5a) for the machine; and **Settings** at the bottom. The
HilbertRaum mark at the top is the **Home** button. Settings has four tabs: **General**,
**Privacy & data**, **Skills**, and **Diagnostics (advanced)** (see §10).

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

1. Open **AI Model**. Your current model stays at the top. The **Model library** below defaults
   to **On this drive** when models are installed; **Browse models** shows the full catalog of
   alternatives, including downloads. Search by name, family, or exact variant, and filter by
   task or family. Task groups are Chat, Document search (including rerankers), Translation,
   Images, and Voice. Each compact row shows the purpose, storage size, minimum memory,
   status, and available action. Expand **Technical details** for its description, automatic-use
   explanation, paths, and verification controls.
   Quantization variants of the same model share one entry. The installed/recommended choice
   leads — and where several versions are equally good picks, the one you can actually download
   is the one shown; **Show all variants** reveals the other exact versions. A group that contains
   a version the app **can't verify** opens by itself, and whichever way you set a group it stays
   that way. Search also finds collapsed variants. The current model is only shown at the top and
   is not counted again in the library.
2. You'll see the models on your drive with a status:
   - **Installed** — ready to use.
   - **Recommended** — the largest model that runs comfortably in this computer's memory.
   - **Not downloaded** — the model file isn't on the drive (see Troubleshooting).
   - **Needs ≥N GB RAM** — this computer has less memory than the model's minimum, so it
     can't be selected or started here. Pick a smaller model — quality stays great.
   - **Can't verify** — the file is present but its checksum didn't match. The model stays listed
     under **On this drive** with its **Download** action, so you can repair it without hunting
     through the catalog; if it is one of several variants of the same model, that group opens
     automatically so the damaged version is visible straight away. (If the publisher has since
     withdrawn the file, the row explains that instead of offering a download.)
   - **Unsupported** — this model can't run on this computer/build.
3. Click **Use this model** on a downloaded model's row — this makes it your model *and* starts it, so
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
   is on (it is **on by default**, including on prepared commercial drives, unless this drive's
   builder deliberately disabled downloads in the drive's policy — rare; the app is fully usable
   without it either way).
2. On **AI Model**, click **Download** on the model you want. A confirmation shows the size,
   the license (with a link that names the site it points to), and the address the file comes
   from. If the model's license hasn't been pre-reviewed, you'll also tick a box accepting it.
   Like every link in the app, the license link opens in your browser only after you confirm
   the small dialog that shows its site and address (§6).
3. The download shows its progress in a panel just above the list of models, so a search, a
   filter or a collapsed group of variants can never hide it; you can **Cancel** any time. A
   cancelled or interrupted download **resumes where it stopped** when you start it again.
   If a download **fails**, or finishes without a checksum the app can verify, the result stays
   in that panel — named, with **Retry download** and **Dismiss** — until you act on it. It
   survives searching and filtering, and it is still there when you leave the **AI Model** screen
   and come back. **Retry download** re-opens the same confirmation (size, license, address) for
   exactly that model; it is greyed out with the reason when downloads are switched off or the
   file is no longer offered. **Dismiss** clears the panel and puts the result back on the model's
   own card, where its Resume button is.
4. The file is checksum-verified before the app will use it — a corrupted download is
   discarded automatically, never silently kept.

One model downloads at a time (they are large). If the Download button is greyed out, the
screen tells you why: either the Settings toggle is off, or this drive's builder deliberately
disabled downloads in the drive's policy (rare — most drives, including prepared commercial
ones, allow them). Nothing about you or your documents is ever sent; the app only fetches the file.

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

### Technical details: context size (advanced)

The **Context size** card on the AI Model screen sets how much text (your conversation plus any
document excerpts) the model can hold at once. **Automatic** — the default — uses the model's
recommended window and names the number it resolves to (e.g. *"Automatic — the model's
recommended size (32768 tokens)"*); the fixed presets go from 4k up to 128k tokens, and a new
pick applies the next time the model starts. Large windows cost memory — choices of 64k and
above show a note saying so, because the model's working memory grows with the window. If you
work with long documents and hit "context limit" messages, a larger context size here is the
remedy.

---

## 5a. Performance

**Performance**, next to **AI Model** in the sidebar's machine group (§4), answers one question:
*can this computer run your model, how fast, and is the drive fast enough?* It reuses the same
hardware check the app already runs when you first set up, and turns the numbers into a verdict
you can read at a glance instead of a raw table.

**The verdict and four tiles.** One sentence at the top sums up how your model does here — for
example *"Runs Qwen3.5 9B at about 24 tokens per second. Model starts from this drive are
fast."* — and four tiles below it each carry a rating word, never just a colour:

- **Speed** — tokens per second, with the model and date it was measured. A reading counted from
  streamed chunks rather than the model's own timing is marked **Approximate**, so you can tell a
  precise figure from a rough one.
- **Memory** — your RAM and processor, and the profile it puts you in (Tiny, Lite, Balanced, or
  Pro). Whether your model fits, and with which context size, is the *Your model* row below,
  never this tile.
- **Graphics memory** — your graphics card's memory and whether it is **Usable** or **Small**, or
  whether you have **None**. A built-in chip that shares memory with the rest of the computer (an
  Intel Iris Xe, for example) is marked **Integrated, shared memory** — models still run on the
  processor, and that is not a fault of the chip's size. A computer this drive visited before the
  app could record this figure shows **Not recorded** rather than a guess.
- **Drive** — the honest read speed measured from a real model start or a full file check, with
  its source and date. It says **Pending** until either has happened once.

Two actions sit under the tiles: **Check again** re-runs the check right now; if nothing has
measured your speed yet and your recommended model is already installed, a second button,
**Start … and measure**, appears beside it, so getting your first reading and starting your
model is one click. **Copy report** puts everything above into your clipboard for a support
message, and always says which computer it describes, so a report copied on a different laptop
is never mistaken for this one's.

**Your model.** A row under the tiles about the model you actually have selected. Before its
first start on this computer it is an estimate from the file size alone, and the note says the
context cache is measured once the model starts. After a start, with the context size and
graphics setting you currently have, the row switches to what actually happened: on the graphics
card, partly on it (with why, when the card was busy), or on the processor from RAM. If you
change the context size or turn graphics acceleration off afterwards, the row does not pretend
the old measurement still applies — it reads *"Measured earlier with a 4,096-token context on
3 Sept; the estimate above is for the current settings"* and shows the estimate again until you
start the model once more under the new settings. This record travels with the drive, not with
any one computer, and keeps only one entry per model: starting that model on another computer
replaces what was measured here, and coming back to this computer shows the estimate again until
you start it here once more.

**Models on this computer.** A card listing every model the app can hold — chat, translation,
images, document search (its ranking and index models), and voice — one row each, so you can see
what is actually using the graphics card right now versus what always runs on the processor by
design (document search, voice and images, always). A row reads **loaded** only once
that service is actually running and ready, not while it is still starting. Two totals sit below
the rows: the card total (what is resident on the graphics card, against its memory) and the
processor total (what loading everything at once would take from RAM).

**Observed while you worked.** Three rows fill in from ordinary use, with no separate check: your
last finished chat answer, your last model start, and your last full file check. These are
honest about their scope — the card says the rows last for this session and refresh on their own
as you use the app — an app restart clears them, but the read speeds behind the model-start and
file-check rows are also kept with the Drive tile above, so that part of what you just did is not
lost when the session ends.

**Other computers this drive has been used on.** Every other computer this drive has visited,
newest first, each with its own speed, model, hardware and date, and the same rating pills you
see above (**Slow drive** below 100 MB/s; **Approximate** wherever the speed reading was not the
model's own timing).

**A drive that moves between computers.** Plug this drive into a computer it already has a
record for, and Performance restores that computer's result right away — nothing is
re-measured, so the ★ pick and the profile follow the machine you're on, not whichever computer
last ran the check. Plug it into a genuinely new computer, and the app checks quietly in the
background — behind starting your model, never competing with it for the drive — the first time
you unlock there. If that check cannot finish (no compatible runtime for this computer, for
example), it tries again once per unlock until it succeeds; a manual **Check again** always works
in the meantime. See §13 for what this means when you carry the drive between laptops.

Performance never sends anything anywhere — see §10 for exactly what it keeps on the drive and
in what form.

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

Starting a model includes a short warm-up, so the *"Starting…"* state can take a little
longer — in return, the model is genuinely ready when it says so, and your first question
answers at normal speed. If a first answer is ever still slow (for example on a very busy
machine), a calm one-time *"the model is warming up"* note appears under the pending answer
to say why. Later answers in the same session come fastest.

Starting fresh? The empty chat suggests a few example questions — click one to put it in
the message box — and, if you haven't imported anything yet, offers **Add documents to ask
about them**.

Everything you type and everything the model replies stays on your device. The one exception
is a link you choose to follow: clicking a link in an answer first shows a small dialog with the
site and the address — **Cancel** is the default, and only **Open** hands the address to
your browser, which then connects to that site (so the site sees your IP address, as with any
page you visit). A model can write any address into an answer, so read the site line before
you press Open. If several links try to open at once, only the first asks; the rest are
dropped.

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

1. Open **Documents** and **Import files** (txt, md, pdf, docx, csv, tsv — audio
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
offers a **Make searchable (OCR)** button right on the row (if it says the OCR files are
*not on this drive*, add them with `prepare-drive --with-assets` or `fetch-runtime --family ocr` —
see the Troubleshooting guide): the pages are read **on this drive** (no cloud OCR —
German and English are included), with per-page progress and a Cancel button; the last
step reads *"Finishing — making the text searchable…"* while the recognized text is
indexed. When it finishes, the document is a normal searchable document; answers cite it
**by page**, and **Preview** shows the recognized text per page with a *"Text recognized
on this drive (OCR)"* note — recognition is good on clean scans but can contain errors on
blurry ones. If a first reading came out poorly (or you added better OCR files later),
**Read again (OCR)** in the document's **⋯** menu reads the pages again — unlike
**Re-index**, which reuses the stored reading. Reading a scan is never automatic (it takes
a couple of seconds per page); you choose when. **Photos of pages** (PNG/JPG) are the
small exception: they are read immediately on import.

**Each document is a compact row.** On the **Documents** screen every file is one row:
its name and a muted line of details (type, size, sections), any **location/project tags**,
a **status badge** (and small **Summary** / **Deeply indexed** badges once those exist), one
inline **Preview** button, and a **⋯** menu. The **⋯** menu (also opened by right-clicking the
row) holds the document's actions — **Summarize**, **Translate**, **Re-index**, **Build deep
index**, **Read again (OCR)** (on documents read with OCR), **Move to project…**, **Export**
(on generated documents) or **Export original file** (on imported ones),
and a **Delete** at the bottom (which always confirms first). Tick a document's checkbox and a **selection toolbar**
appears at the top of the list with the actions that work across documents — **Ask these
documents**, **Compare (2)**, **Move to project…**, **Mark temporary**, **Archive**, and **Delete**.

**Export a document (get your file back).** Every imported document keeps its original file
inside the workspace — encrypted when your workspace is. **Export original file** in the
**⋯** menu saves that original — PDF, Word, recording, photo, anything — wherever you
choose, byte-for-byte as it was imported, even if the file you once imported it from is
long gone. Because the saved copy leaves the workspace, the app first reminds you that
*the exported file is stored outside the encrypted workspace and is not protected by your
workspace password* — the same warning every export shows. Generated documents
(translations, comparison reports) offer **Export** instead, which saves their text as a
Markdown file. Exporting one document at a time is deliberate: the save dialog is your
consent for each file.

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
  vice versa. You can cancel most tasks at any point — while a task runs, the row shows its
  progress and a Cancel button in place of Preview and **⋯**. The one exception is OCR's
  final "Finishing…" step: by then the recognized text is already saved, so Cancel there
  can't stop the document from becoming searchable (see "Scanned PDFs" above).
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
language you want — **51 languages** are supported, source and target, the same list as the
Translate screen (§7a); the app does not guess the source language — and the model writes a
translated copy, fully on this drive. The result is a
**new document** in your list, named like *"report (Deutsch)"*: it is searchable, answerable
in *Ask my documents* (with citations), and you can **Export** it as a Markdown file. The
new document starts with an honest *"Machine-translated by &lt;model&gt; — may contain
errors."* line, and its row shows *"Translated from &lt;original&gt;"* so you always know
where it came from.

A few honest notes about translations:

- Long documents are translated part by part — you see the progress on the row and can
  cancel anytime (a cancelled translation leaves nothing behind). The translation model
  is thorough but not fast: a long document can take many minutes on a CPU laptop.
- If a part cannot be translated, the app **marks that part clearly in the result and keeps
  the original text there** — it never silently drops content. (Some failures get one retry;
  others — like a part the model cut off mid-sentence — are marked right away, because a
  second identical attempt would only repeat the same result.)
- If a **page of the original contains no readable text** (for example a scanned page inside
  an otherwise normal PDF), the result **marks that page in place** — *"Page 3 of the original
  could not be translated…"* — and the Translate screen shows a warning naming the affected
  pages, so a shorter output never goes unnoticed.
- The translation is a snapshot: if you re-import or re-index the **original**, the
  translated copy does not update — run Translate again.
- Number and date *values*, names, and codes survive, and their formats are adapted to the
  target language (e.g. *14.03.2026* → *March 14, 2026*) — that is how a professional
  translation reads. On long documents a recurring term may occasionally be worded
  differently in different parts.
- If you install the translation model while the app is running, the **Translate** action
  becomes available as soon as the download finishes — no restart needed. (The speech and
  search models — transcription, reranker, embeddings — still need a restart after a
  mid-session install.)

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

In **Ask my documents**, the **📄 Answering from:** chip under the message box lets you compose
exactly where answers come from: tick **Library**, any **projects**, and/or pick **specific
documents** — they all add together (e.g. *"Library + Tax 2025 + contract.pdf"*). Your choice
is remembered for that chat, even after you restart the app. Files you dropped into the chat
are always included and shown separately as *"files in this chat"*. A chat started inside a
project uses that project to begin with; **"All documents"** is always one tap away. In a chat
with attached files that reset reads **"Just the files in this chat"** instead — clearing the
other sources there means the attached files are exactly what the chat answers from.

### Generated documents stay out of answers until you decide

A translation or comparison the app makes is a **work product**, so it is kept out of your
default answers — it lives in **Generated**, explains its origin, and can be **Export**ed. To
make one part of your knowledge, **Export it and re-import** it into the right place. If a
generated document's source later changes, its row shows a quiet **"Outdated — re-run to
update"** note (the app never silently rewrites it; re-run the task when you want a fresh one).

Everything here is local: organizing and scoping never call a model or the
network, and the activity log records only counts and ids — never your project or folder names.

### Review an answer against its sources (evidence review)

When a document-grounded answer matters — a contract clause, a figure you'll act on — you can
**review it against the evidence** instead of just trusting it. Hover over the answer and choose
**Review evidence** (also at the bottom of the expanded **Sources** list: *Review answer and
sources*). A dedicated review workspace opens with the answer **frozen exactly as it was
generated** on the left and its **saved source excerpts** on the right. Nothing here asks the
AI model anything, and nothing touches the network — it is you, the answer, and the sources.

- The answer is split into **review items** (paragraphs, list entries, headings). For each one,
  record a decision: **Reviewed — supported / partly supported / not supported**, **Needs
  follow-up**, **Not reviewed**, or **Not applicable** (headings start there). Add a note where
  it helps. Everything **saves automatically** as you work.
- **Review one statement separately.** When a paragraph bundles several claims, choose
  **Review a passage separately** under it: the item's *original* text appears (plain, exactly
  as generated — without formatting), you highlight the passage — with the mouse or with
  Shift+arrow keys — and confirm **Review separately**. The passage becomes its own review
  item, tagged **Reviewer text selection**, with its own decision and note; **Remove
  selection** deletes it again (the surrounding item is untouched, and selections never block
  marking a review ready). If a selection can't be taken over exactly, the app says so and
  asks you to select again — it never guesses at the boundaries.
- **Many sources?** With a large source set the evidence pane starts with the first 24 cards —
  **Show more** reveals the next batch, and a **filter box** narrows the cards by document
  title, excerpt text, section, page, or source marker. The full persisted set always stays
  available; nothing is dropped.
- Evidence cards show what the model was actually given. The workspace is honest about the
  difference: for a whole-document analysis the cards are **provenance** (sections the answer
  drew on), *not* sentence-by-sentence citations — and the workspace says so. You can link a
  source to an item yourself; such links are always labeled **Reviewer linked**, never "cited
  by the answer". Remember: *a citation shows where information came from — it does not by
  itself prove the answer is correct.*
- **Review summary** (bottom right) collects the counts, coverage and truncation warnings,
  generation details, your reviewer name, and a general note. **Mark review ready** unlocks
  once every answer block has a decision ("Not applicable" counts). A ready review can be
  reopened any time.
- Reviews are saved **inside your encrypted workspace** and reopen from the same answer
  (**Continue review**, with a small Draft/Ready tag). Deleting a conversation deletes its
  reviews too — the delete confirmation warns you with the count first. **Back to chat**
  returns you to the conversation the review came from, with it open and active.
- **A reviewed answer is protected from being replaced.** Re-answering a turn — **Answer
  without it** on a skill-marked answer, or **Try again** wherever it is offered — writes a new
  answer over the old one, and a review belongs to the answer it was made on, so it would go with
  it. Once an answer has a review, re-answering it is refused: **Answer without it** greys out and
  says why on hover, and any other route to replace that answer reports the review instead of
  overwriting it. Ask your question again as a new message to get a fresh answer — your review and
  the answer it examined both stay.

**Export an evidence pack.** From the **Review summary**, choose **Create evidence pack** to
save the whole review — question, answer, your decisions and notes, the source excerpts,
coverage warnings, and generation details — as **one self-contained HTML file** you can open
in any browser, print, or hand to a colleague, **or as a print-ready PDF** (A4, with every
page footed by the pack ID and page number, and bookmarks for each section — pick the format
in the export panel; the save dialog offers both types too, and the file ends up in the
format its name says). The PDF holds the same content as the HTML pack, printed by the app
itself — its text stays searchable and selectable. If accessibility of the file matters
(screen readers), prefer the HTML pack — the PDF's accessibility tagging is best-effort
(see [known-limitations](known-limitations.md)). Before exporting you pick what to include
(reviewer notes, source excerpts, document hashes, unreviewed items; extra technical details
are off unless you turn them on), and the app reminds you of the one important boundary:
*the exported file is stored outside the encrypted workspace and is not protected by your
workspace password* — treat the file with the same care as the documents it quotes. The pack
is generated **entirely on this drive** (no AI model, no network), contains **no scripts and
no links to the internet**, never contains file paths from your computer, and is written in
the app language you are using at the time (English or German). Works for drafts and ready
reviews alike — the pack states the review's status honestly. Each export is remembered in
the summary's **Export history** with its format and SHA-256 fingerprint, so you can later
verify a pack file hasn't been altered (the file itself stays wherever you saved it — the
app keeps only the record).

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
   **swap** button (↺ between the two) flips them. **51 languages** are supported, source and
   target — German, English, French, Spanish, Italian, Portuguese, Dutch, Polish, Czech, Ukrainian,
   and many more (from Arabic and Chinese to Swahili and Vietnamese).
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
time**; a file type that can't be read shows a short, friendly note. A **scanned PDF** (pictures of
pages, with no readable text) can't be translated as-is — the note points you to make it searchable
first under **Documents** with **Make searchable (OCR)** (§7), then translate the result. (This is
the same job as the **⋯ → Translate** action under Documents, §7 — the translated copy is saved
either way; the original you dropped is kept as a **temporary** document.)

Everything stays on the drive — your text and its translation are **never uploaded**. Typed text is
transient: leave the screen (or lock the workspace) and it is gone. A translated **document**,
though, is saved (that's the point) — you'll find it under **Documents**. If the translation model
isn't installed, the screen shows a short note with a **Go to AI Model** button to download it (see
the download note in §6); machine translations can contain errors. While a document task is running,
translating here is **declined with a short note** ("A document task is running…") — nothing is
queued behind it; wait for the task to finish (or cancel it), then translate.

---

## 7b. Knowledge packs — ask an offline Wikipedia

A *knowledge pack* is a ZIM archive — a compressed offline copy of a reference site.
The Kiwix project publishes thousands (Wikipedia in ~100 languages, Wiktionary,
Wikivoyage, …) at `library.kiwix.org`; download once, use forever offline.

1. **One-time setup:** the kiwix-tools programs must sit under
   `runtime/kiwix-tools/win` (or `mac`/`linux`) on your drive — see
   [`known-limitations.md`](known-limitations.md) “Knowledge packs” while the
   installer step is still manual.
2. **Add packs:** copy `.zim` files into the drive’s `zim/` folder (found when you
   unlock, and on Refresh), or use *Documents → Knowledge packs → Add packs…* for files
   stored elsewhere. Files are used in place — nothing is copied. The list updates
   itself when you unlock; use **Refresh** under Knowledge packs after copying files
   while the app is open.
3. **Use them in a chat:** in a documents chat, open the sources picker
   (“Answering from…”) and tick the packs under *Knowledge packs*. Packs are
   per-chat and off by default. You can tick up to 12 packs in one chat.
4. **Answer from packs only, if you want:** untick **Search my documents** at the top of
   the sources picker to answer only from the ticked knowledge packs — files you attached
   directly to this chat are still used either way.
5. **Read the source:** answers cite pack articles like documents; *Open article* on a
   citation shows the article text offline — also from an evidence review's archive row.
6. **See what each pack did:** under an answer, a “Knowledge packs:” line lists every
   ticked pack — searched (and how much it contributed), or not searched/failed with a
   short reason, such as over the 12-pack limit, no full-text search index, or the pack
   server restarted mid-question. In the sources picker, a greyed-out pack always says why
   it can't be ticked — file missing, a different archive at that location, disabled, or no
   full-text search index; the panel itself shows a "No full-text index" badge on such a pack.

Removing a pack's registration (the **Remove** button) only forgets it — the file itself is
never deleted. An article from a pack that has no full-text search index is still readable:
use *Open article* on it directly, even though that pack is skipped when the app searches.
Whole-document reads and document comparisons never consult knowledge packs — the answer
says so. A pack greyed out in an older chat's saved selection (because it's no longer
available) can still be unticked.

Everything stays on this computer: the pack server listens on 127.0.0.1 only and asking
never leaves this machine. One limit to know: While the workspace is unlocked and a
knowledge pack has been used in a chat, other programs running under your own user
account on this computer can read the enabled packs through the pack server, which has
no password of its own; locking or quitting stops it.

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

Under the message box there's a quiet **Skill:** picker. Choose a skill and it shapes your answers
in that chat until you change or clear it (pick **No skill** or tap the chip's ✕); tick **Keep for this
conversation** in the picker to save it across restarts. When a skill shaped an answer, that message
carries a small **skill glyph** — an icon and the skill's name — so you can see at a glance which
one was used.

The **first time you pick a skill**, a small **info card** appears above the message box saying what
it does, what it needs to apply (for example a matching document in scope), and its key limitation —
so nothing about the next answer is a surprise. It shows once per skill; afterwards the quiet **ⓘ**
next to the picker re-opens it any time, and **Learn more** jumps to the skill's full details on the
Skills screen.

Now and then the picker shows a **one-tap suggestion** ("Use *Bank statement*?") when your question
or the documents in scope look like a fit. It is only ever an offer — nothing is applied until you
tap it.

### A suggestion on an answer

Sometimes an answer itself carries a quiet suggestion line: *"This looks like a job for a skill."*
followed by a **Run "…" for this question** action. The app adds it when the answer it just gave
probably wasn't the shape you asked for — for example, you asked for categorized sums and got a plain
list — and a skill exists that can do it properly. Clicking the action **re-answers the same
question with that skill** (your question is not sent anywhere; the previous answer is replaced).
Nothing ever runs from a suggestion until you click it.

Some of these suggestions say **"Suggested by the local model"**. That means the app asked the model
running **on your computer** one short, tightly constrained question — "which installed skill, if
any, fits this request?" — to pick the suggestion. This happens only in two narrow cases (an
aggregation-style question the plain answer can't serve, and answers the app already knows are on
shaky ground), it can only name one of your enabled skills or "none", and its output never changes
the answer text itself. Nothing leaves the space — no network is involved, ever. Suggestions without
that label come from a fixed built-in rule, with no model call at all.

If you disable or remove a skill after it was suggested, the suggestion button greys out and says
so — clicking an old suggestion never silently answers without the skill.

### Skills that run tools

Some skills — like **Bank statement**, **Invoice**, **Document redaction**, and **Document edit** — can
run small, approved **local tools** on a document you choose: reading it, checking its figures, producing a
redacted copy, or applying targeted text edits. When one runs you'll see a calm run bar — **Running: `<tool>` on `<N>` documents…
Cancel**. A tool that **writes or exports a file** (for example "save as CSV", or "save the redacted
copy") always asks you to **confirm first** and lets you choose where the file goes, and you can
**Cancel** at any point. Everything a tool sees is just the one document you picked — it can't reach
anything else on the drive. When a run finishes, its result line stays until you **Dismiss** it —
and the tool buttons come **straight back underneath it**, so you can run the next edit or export
without dismissing anything first.

> Redaction is **AI-assisted best-effort**, not a guarantee. It always hides the clearly-shaped data
> (e-mails, phone numbers, IBANs, card numbers, dates, links); when a model is running it also hides the
> **names, addresses, and organisation names** it finds — the model only points at what to hide, it never
> rewrites your document. For a Word document it covers the **whole file's text** — headers and footers,
> footnotes, comments, and tracked-changes deleted text — and also clears the **author metadata** and
> **link targets** a file quietly carries. What it can't check: **pictures, scanned pages, and embedded
> objects** (the confirmation dialog says so before the run). It can still miss things, and if no model
> is running only the rule-based part applies (the run tells you so). Always review the redacted copy
> before you share it.

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
> layout (writing back into a PDF isn't supported). The **confirmation dialog tells you the output
> format before the run starts**, so the `.txt` copy of a PDF is never a surprise in the save dialog.
> A **scanned PDF** (an image of a page) can only be worked on through the text the app recognised
> from it, so redact those from the `.txt` output.

### Manage skills (Settings › **Skills**)

Open **Settings › Skills** to see every installed skill, turn each one **on or off**, and **Import**
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
for optional model/engine downloads — it is on by default so you can fetch a model out of the
box, including on a prepared commercial drive; every download is explicit and
confirmed, and the core app — chat, documents, search — never goes online. (A link you confirm
in the dialog described in §6 is opened by your *browser*, not by the app.) Logs are stored
**locally** on the drive (encrypted on an encrypted workspace) and never uploaded.

The drive also keeps up to eight records of the computers it has been checked on — processor,
memory, graphics card, the model that was recommended, and when — plus the graphics-card probe
and where each model last landed (§5a). No computer names, user names or serial numbers are
kept, and nothing here is sent anywhere either.

Two related switches in Settings: **Developer mode** (Settings → General → Developer card, off by default)
allows developer conveniences — a plaintext workspace and unverified models — though the drive
policy stays authoritative: on a commercial drive, unverified models are rejected regardless of
this setting. And **Summarize older messages to free up context** (Settings → General → Chat card, on by
default) keeps a long conversation going by condensing its oldest messages once into a compact
note — created locally and kept on this drive — instead of silently dropping them; turn it off
to keep only the most recent messages that fit.

See [`PRIVACY.md`](../PRIVACY.md) for the full statement.

### Use HilbertRaum from other apps (local API)

**Settings → Privacy & data → Local API** lets other programs on the same computer send text to your
running model and read the answers — an editor plugin, a note-taking app, a script you wrote. It is
**off until you turn it on**, and turning it on asks you to confirm what that means.

> Setting up a specific client — curl, the Python/Node `openai` SDKs, any "OpenAI-compatible"
> tool — plus the complete request/response contract for people writing one: see
> [`local-api.md`](local-api.md).

**Turn it on**

1. Open **Settings → Privacy & data** and find the **Local API** card.
2. Switch on **Allow other apps on this computer to use my AI model**.
3. Read the dialog, tick the acknowledgement, and choose **Turn on**. Nothing is saved until you do.

The card then shows a **Connect another app** block with the two values every client asks for:

| The card says | Your app probably calls it |
|---|---|
| **Server address** — `http://127.0.0.1:4980/v1` | "Base URL", "API base", "endpoint", "OpenAI-compatible URL" |
| **Access key** — starts with `hr-` | "API key", "token", "secret key" |

Use the **Copy** buttons rather than retyping. The access key is only ever shown shortened
(`hr-…7f3q`); copying puts the real key on your clipboard, and the app clears it again about a
minute later if you have not copied something else since. If your app asks for a *model name*, any
value works — HilbertRaum always answers with the model you have running.

**What connected apps can and cannot do**

- They can send text and get answers, streaming or all at once. Requests that ask for JSON in a
  given shape work too.
- They **cannot** see your documents, your conversations, your search index, or anything else in
  your workspace. The endpoint has no route to any of it.
- Their requests are answered and then forgotten — never written to your chat history or the logs.
  The card shows counts only ("12 requests answered so far").
- Nothing goes to the internet. The endpoint listens only on this computer.

**Honest limits**

- **A model has to be running.** The card tells you whether one is: if not, connected apps get an
  error until you start a model on the **AI Model** screen. The app never starts a model because an
  outside program asked.
- **One outside request at a time.** A second one waits up to about 30 seconds for the first to
  finish, then is told to try again; anything beyond that is turned away immediately rather than
  left hanging.
- **Your own use always wins.** If you start a chat here while an app is generating, the app's
  request is interrupted — it gets a clear "interrupted, retry" answer, and the card tells you it
  happened. That is deliberate: the model is one resource and you are the one sitting in front of it.
- **It stops when you lock or quit**, and starts again next time you unlock — as long as the switch
  is still on.

**Your responsibility**

Once a connected app has an answer, that answer is in that app's hands. HilbertRaum cannot control
what it does next: it may store the text in its own files, index it, or sync it to its own cloud
service as part of normal behaviour. That would be **that app** sending your data somewhere, not
HilbertRaum — but the effect on your privacy is the same. Check a program's own logging and sync
behaviour before you point it at confidential material, exactly as you would before pasting
confidential text into it.

**The access key**

Keep **Require an access key** switched on unless an app genuinely cannot enter one — without it,
any program on this computer can use your model without asking. If a key leaks, or you simply want
to cut an app off, use **Create a new key**: the old key stops working immediately, including for a
request that is still streaming. Any app still holding the old key needs the new one pasted in.

**If the port is taken**

If another program already uses port 4980, the card says so and the endpoint does not start. The
switch stays on — only the bind failed — so type a different number (4981, for example) and press
**Apply**; it starts on the new port straight away. Paste the new server address into any app you
had already connected. If you did not expect a conflict, treat it seriously: another
program sitting on the port could be impersonating HilbertRaum, so do not paste your access key
anywhere until you know what is using it.

**Turned off by your drive's policy?**

Some managed or commercial drives forbid the feature. The card then appears greyed out with that
reason instead of disappearing, so you can see the feature exists and that a policy — not a bug —
is what disabled it.

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

The interface language works the same way: **Settings → Language** offers **System**,
**English**, and **Deutsch** — *System* follows your operating system's language (German
systems get Deutsch, everything else English), and a change applies right away, no restart.

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
your models, documents, and chat history come with you.

**Before unplugging:** quit the app, wait for its window to close, then **eject the drive
safely** ("Safely Remove Hardware" on Windows, Eject in the Finder / your file manager). The
app keeps its database on the drive while it runs — quitting lets it finish writing and close
cleanly, and the safe eject flushes everything else. Skipping the eject is what makes Windows
show the *"scan and fix this drive?"* prompt on the next plug-in (harmless, but see
[`troubleshooting.md`](troubleshooting.md) if it appears).

**If the app is not quit cleanly:** pulling the drive while the app is running, a power cut or a
forced kill of the app loses any changes made since the workspace last locked (the last
**Lock now** or a normal quit). The workspace itself is not damaged — it reopens from that last
locked point — but everything after it is gone, so quit the app first.

**Shutting down, restarting or logging off with the app still open:** on Windows the app locks
the workspace on its own as the session ends. That is a best-effort safety net — a very large
workspace may not finish locking in the time Windows allows — so quitting the app first is
still the sure way. On a Mac this is not yet verified: quit the app before you shut down.

**Performance remembers each computer separately** (§5a): plug the drive into a computer it has
seen before and its hardware result comes back immediately, with nothing re-measured. On a
genuinely new computer, the app checks quietly in the background and tries again at every unlock
until it succeeds, so you don't need to visit Performance yourself to keep it current.

---

Stuck? See [`troubleshooting.md`](troubleshooting.md).
