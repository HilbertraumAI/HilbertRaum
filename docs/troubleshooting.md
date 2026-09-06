# HilbertRaum — Troubleshooting

Quick answers to common situations. Everything here is normal, local, and offline — none of
these steps require the internet.

---

## Starting the app

Open the drive and **double-click the launcher** at the top level:

- **Windows:** `Start HilbertRaum`
- **macOS:** `Start HilbertRaum.command`
- **Linux:** `start-hilbertraum.sh`

You do **not** need to install anything. The launcher finds the drive automatically, wherever it is
plugged in, so the same drive works on any computer.

---

## "Windows protected your PC" / "macOS cannot open the app"

The first time you run an app from a USB drive, your computer might show a security warning. **This is
normal for any new app** and does not mean anything is wrong — it appears because the app is new to
*this* computer, not because it is unsafe.

**Windows (SmartScreen) — blue window "Windows protected your PC":**
1. Click **More info** (small link in the dialog).
2. Click **Run anyway**.

**macOS (Gatekeeper) — "cannot be opened because it is from an unidentified developer":**
1. **Right-click** (or Control-click) the launcher / app, then choose **Open**.
2. Click **Open** again in the dialog.
3. **On newer macOS (Sequoia / macOS 15 and later)** the right-click → Open bypass no longer works:
   open the app once (it will be blocked), then go to **System Settings → Privacy & Security**,
   find the "HilbertRaum was blocked" entry, and click **"Open Anyway"**.

You usually only have to do this **once** per computer. On a signed commercial drive these dialogs
should not appear at all.

> For a drive builder: signed (Windows) + signed & notarized (macOS) builds avoid these dialogs
> entirely — see the signing section of [`packaging.md`](packaging.md). The steps above are the
> fallback for an **unsigned** (DIY or GitHub-release) build.

---

## I downloaded the app from GitHub — where are the models?

A release download is **the app only**. It starts in **demo mode** (simulated placeholder answers)
until **both** the AI engine and a model are on your drive. Two ways to get them:

- **In the app:** open **AI Model**. First install the **AI engine** (the `llama.cpp` runtime)
  from the banner at the top of the screen — until it is installed, started models keep running
  in demo mode. Then download a chat model (each download asks first and is SHA-256-verified).
  The embeddings model for document Q&A downloads the same way.
- **Scripted:** run `prepare-drive --with-assets` from the repo (README step 2) to lay out a drive
  with the default model set + the `llama.cpp` engine in one command.

On **macOS**, keep the `.app` **zipped** when copying it onto an exFAT (USB) drive and extract it
on the computer you run it from — exFAT cannot hold the symlinks inside a `.app` bundle.

---

## "Downloads are disabled by this drive's policy" on a GitHub-release install

On releases **up to 0.1.55**, running the portable app standalone (no prepared drive) blocked the
in-app model downloader with this message no matter what the Settings toggle said — the packaged
build treated its fresh app-data folder like a prepared drive whose `config/policy.json` had gone
missing and failed closed (issue #93). **Fixed since:** a standalone install (no `policy.json`, no
`drive.json`) now permits model downloads out of the box; the Settings toggle and the per-download
confirmation remain the gates, and downloads stay SHA-256-verified.

If you are still on an affected release and cannot update, create the file
`config/policy.json` under the app-data folder — on Windows that folder is
`%APPDATA%\@hilbertraum\desktop` (the `@`-name comes from the app's package name; it is the
expected location, not an installation error) — with:

```json
{ "network": { "allow_model_downloads": true, "allow_update_checks": false, "allow_telemetry": false } }
```

and restart the app. On a **prepared drive** this message is genuine drive policy: the drive's
`config/policy.json` sets `allow_model_downloads: false`, and the app honors it.

---

## "Offline Mode is ON — is something wrong?"

**No. That is the intended state.** HilbertRaum runs the AI model on your laptop and
keeps your data local. The core app — chat, documents, search — never goes online; the only
optional network feature, model/engine downloads, is permitted even on a prepared commercial
drive but never runs by itself — every download asks for your explicit confirmation first.
You can confirm the current state in **Settings → Privacy & data**.

---

## The answers look like placeholders / "echo" replies

The app is running its built-in **demo mode** — started via **Try in demo mode** on the
AI Model screen, or used as a first-run fallback on a **developer** build when no model weight is
installed yet. (On a prepared drive without developer mode, a missing weight shows an error rather
than falling back to demo mode.) Demo mode lets you explore the interface, but it does not produce
real AI answers.

**Fix:** add a real model file:
1. On the **AI Model** screen, note the model marked *Recommended*.
2. Put the matching `.gguf` weight file into `models/chat/` on the drive (and the embeddings
   model into `models/embeddings/`). File names come from the model's manifest (`local_path`).
3. Put the `llama-server` program for your system into `runtime/llama.cpp/win` (Windows),
   `runtime/llama.cpp/mac` (macOS), or `runtime/llama.cpp/linux` (Linux).
4. Restart the app and press **Use this model** again.

If you have the repo, a drive builder can do steps 2–3 with the prepare-drive + verify-models
scripts (see [`packaging.md`](packaging.md)).

---

## "… can't be started — its model file isn't installed on this drive yet."

The model's weight file is missing from the `models/` folder (the AI Model screen shows it as
**Not downloaded**). Add the file (above), or choose a model already shown as **Installed**. The app
only downloads a model when you explicitly ask it to on the AI Model screen.

---

## A model shows "checksum failed"

The model file on the drive doesn't match the expected fingerprint in its manifest. The file
may be incomplete or corrupted. Re-copy the weight file, then run the verifier:

```powershell
.\scripts\verify-models.ps1 -Target E:\         # Windows
```
```bash
scripts/verify-models.sh --target /Volumes/HILBERTRAUM   # macOS/Linux
```

On a developer drive, unverified models are allowed; a commercial drive requires a matching
checksum.

**If an in-app download stalls near the end (~95%) and then "checksum failed" after Resume**, the
manifest's fingerprint or `size_bytes` doesn't match the real upstream file — re-copying won't help
(BUG dl-size-cap-2026-07-03). This affected the manually-selectable **Qwen3.5 27B / 35B-A3B** entries,
whose hashes were wrong and whose `size_bytes` were understated by ~5–8%, so the (then-exact) download
cap truncated the transfer near completion. **Fixed 2026-07-03:** the cap is now drift-tolerant and the
27B/35B manifests carry the real `sha256` + exact `size_bytes` captured from HuggingFace (the 9B was
already correct), so these models now download and verify normally. If you ever hit this on another
model, run `scripts/verify-models.sh --generate` (or the `.ps1`) against the actual weight on a machine
with internet to write the true `sha256` + `size_bytes` back into the manifest.

---

## I forgot my workspace password

Encrypted workspaces are protected by your password, which is **never stored**. If you forget
it, the data **cannot be recovered** — this is by design. Create a new workspace to start over
(your old encrypted data remains on the drive but unreadable).

Before you do: read the message on the unlock screen carefully. "That password didn't unlock
your workspace" means the password was wrong. If it instead says the workspace data is
**damaged**, your password is fine and creating a new workspace is the wrong move — see the
next section.

---

## "Your password is correct, but the workspace data on the drive is damaged"

This message (issue #208) means the app verified your password and decrypted the workspace,
but what came out is not a readable database — the encrypted file itself was damaged at some
earlier point. Retyping the password cannot help, and this is deliberately **not** worded as
a password problem.

What to do:

- **Do not create a new workspace** and do not delete anything — that overwrites the evidence
  and any recovery option.
- Quit the app and copy the whole `workspace/` and `config/` folders somewhere safe.
- Restore `workspace/hilbertraum.sqlite.enc` (and the rest of the `workspace/` folder) from a
  backup, then unlock normally with your usual password.
- If you have no backup, keep the copied files and report the issue — the damaged file still
  proves what happened, and your imported documents' encrypted copies under
  `workspace/documents/` may be individually recoverable.

Never run two copies of the app at the same time against the same drive. Versions 0.1.59 and
newer refuse a second instance on their own — but an older copy takes no such lock, so that
protection only holds when **both** copies are 0.1.59 or newer. When upgrading, quit the old
version, delete its app file from the drive, and only then start the new one (see "Two app
versions on the drive" below). If the app says **"This workspace was written by a newer
HilbertRaum — update the app to open it."**, you started an older copy on a workspace a newer copy has
already opened: nothing was changed — update (or start the newer copy) and the workspace opens
normally. Copies up to 0.1.59 cannot give that message; they open the workspace anyway.

---

## "Could not lock the workspace"

Locking re-encrypts your workspace on the drive, and that briefly needs **free space about the
size of your workspace database**. On a nearly-full drive the re-encrypt can fail — the app
then keeps the workspace **open and usable**, and nothing is lost.

What to do: free some space on the drive (delete files you no longer need, or move a large
model off the drive via the AI Model screen), then press **Lock now** again. Quitting the app
retries the lock too. Even if the app closes before a lock ever succeeds, your newest data is
kept safely on the drive and secured at the next unlock — you don't lose the session's work.

The lock stops the AI model (and every other engine) before it re-encrypts, so after a failed
lock the model comes back the same way it does after an unlock: automatically in the
background when **Start the selected model automatically** is on (Chat shows "Starting…" for a
moment and then the composer again), or by hand on the AI Model screen when that setting is off.
The local API, if you have it switched on, comes back as well. Everything else — document
search, the reranker, translation, voice input, OCR, knowledge packs — restarts on its next use.

---

## "Could not open the workspace yet: another program is holding a recovery file"

You see this on the unlock screen when a previous session's lock did not finish (see "Could
not lock the workspace" above) and the app kept your newest data as a recovery file to secure
at the next unlock — but another program on your computer is holding that file open, so the app
cannot move it into place. Opening the workspace anyway would fall back to the older,
already-secured copy and lose the newest changes, so the app **refuses to open until the hold
clears**. Your data is safe; nothing is deleted.

This is almost always antivirus or a search indexer scanning the drive, or a file-manager
window left open on the `workspace` folder — most common on Windows.

What to do:

- Close anything that might be scanning or reading the drive: antivirus, the search indexer,
  and any Explorer / Finder window showing the `workspace` folder.
- Wait a few seconds and press **Unlock** again with your usual password. Each unlock retries
  the recovery, so once the hold is gone it succeeds and your newest data is restored.
- If it keeps happening, quit the app, safely eject and re-attach the drive (which releases any
  lingering handle), then start the app and unlock.

---

## "The model is busy" — one job at a time

HilbertRaum runs **one** local model, and it does **one job at a time**. When you start something
that would need the model while it is already working, the app says so and does nothing, rather
than running both at half speed. You will see one of these:

- **"An answer is being written right now."** — a chat answer is streaming. Wait for it, or press
  **Stop** in the chat.
- **"A document task is using the model."** — a summary, comparison, translation or deep-index
  build is running or queued. Wait for it, or cancel it from the document.
- **"A skill is working on a document."** — a skill run (for example *Redact document* or an edit)
  is in flight. Wait for it, or press **Cancel** in the run bar at the bottom of the chat.
- **"A hardware benchmark is measuring this computer right now."** — a benchmark is running. It is
  short; try again in a moment.

Nothing is lost when you see one of these: the thing you started simply did not start. Try it
again once the other job finishes.

Two deliberate exceptions:

- **Chatting is never blocked by the benchmark.** The benchmark gives way instead — if you send a
  message while it is running, it finishes without its speed reading and says so on the Diagnostics
  card ("Text-generation speed was not measured this time…"). Run it again when nothing else is
  using the model if you want the full reading; the RAM, CPU and drive figures are unaffected.
- **Chatting while a deep index is building** is allowed. That build pauses itself for your
  question and resumes afterwards.

---

## The app feels slow

- **Slow drive:** running from a slow USB stick makes model loading and indexing sluggish. Use
  a fast USB 3 / SSD drive, or copy the drive's contents to your computer. **Settings →
  Diagnostics (advanced)** shows the drive's **measured read speed** (taken from real model
  loads — the number that decides how long model starts take) and its write speed, and warns
  when the measured read speed means model starts will be slow.
- **Heavy model for your laptop:** pick the **Recommended** model on the AI Model screen. The
  benchmark suggests a model that suits your RAM/CPU. Larger models are more capable but slower.
- **First start of a model** is always slower (it loads into memory); later prompts are faster.
- **Graphics acceleration:** on most computers with a graphics card, responses are
  automatically accelerated — nothing to configure. The **Settings → Diagnostics (advanced)**
  *Acceleration* line shows whether your graphics card is being used. Quicker check: the small
  grey note in the Chat screen's header says the same — `model · GPU (…)` or `model · CPU`.
  If it reads **CPU (compatibility mode)**, see the next section.

---

## "Switched to compatibility mode" — what does that mean?

Nothing is broken. The app tried to use your graphics card to speed up responses, hit a
stability issue (often an outdated graphics driver), and automatically switched to
**compatibility mode** — responses now run on your processor, which works on every machine.
Everything keeps working; responses may just be a bit slower.

- You don't have to do anything. The app remembers this choice so it doesn't retry on every
  start. The Chat screen's header note reads **CPU (compatibility mode)** while the choice is
  in effect, so you can always tell — even days later, when the one-line note is long gone.
- If you update your graphics driver later, open **Settings → Diagnostics (advanced) → Try GPU
  again** to let the app use the graphics card again.
- You can also turn acceleration off yourself under **Settings → Use GPU acceleration**
  (it is on by default).

---

## Importing a PDF didn't extract any text

Some PDFs are scanned images with no embedded text. The app detects this and marks the file
*"This PDF looks like a scan"* — use the row's **Make searchable (OCR)** action to read the
text locally (German + English; needs the drive's `ocr/` language files; runs a couple of
seconds per page). PDFs that mix real text pages with scanned pages index their text pages
only — they are not detected as scans.

If the action reports *"…the OCR files, which are not on this drive"*, the drive was built
without them. Add them by re-running `prepare-drive --with-assets`, or fetch only the OCR
family with `fetch-runtime --family ocr` (`.ps1 -Family ocr` on Windows) — see
[`packaging.md`](packaging.md). Commercially-built drives already include them. **Restart the
app after adding the files** — OCR availability is resolved once at startup, so a fetch done
while the app is running won't be offered until the next launch.

**If the app closes itself the moment OCR starts, that is a known packaging defect, not your
drive.** In a packaged build the OCR worker cannot load part of itself out of the app archive
and the whole app exits — see [`known-limitations.md`](known-limitations.md) ("OCR does not work
in a PACKAGED build"). Nothing you can add to the drive fixes it; the workaround until the fix
ships is to leave scanned PDFs unconverted (their text pages, if any, still index).

---

## A document failed to import

Open **Documents** to see the per-file error. Common causes: an unsupported file type, a
corrupted file, or a password-protected document. Supported types: txt, md, pdf, docx,
csv/tsv, audio recordings (wav, mp3, flac, ogg — needs the speech model), and photos of
pages (png, jpg, jpeg — needs the OCR files). Other files in the same import still succeed.

---

## The app won't start from the drive

- Use the **launcher** at the drive root (`Start HilbertRaum`) rather than opening the
  `.exe`/`.app` directly — the launcher points the app at the drive's workspace.
- If you saw a security warning, follow **"Windows protected your PC" / "macOS cannot open the app"**
  above.
- On Windows, the portable `.exe` may take a few seconds on first launch — wait for the window.
- Check that the drive has free space and is writable. The app shows a friendly note on the Home
  screen if the drive is read-only, low on space, or slow (none of these block you).
- If the drive was just prepared, confirm `config/drive.json` exists at the drive root.

---

## Two app versions on the drive

The launcher stopped with **"More than one HilbertRaum app was found on this drive"** and a
list of files. An update left the previous app beside the new one — two
`HilbertRaum-<version>-portable.exe` files, two `.AppImage` files, or an extracted
`HilbertRaum.app` next to a `.app.zip`. The launcher refuses to start **either**: an older
build running beside a newer one can destroy the workspace (see "Your password is correct, but
the workspace data on the drive is damaged" above). It never deletes anything for you.

What to do: keep only the newest version and delete every other HilbertRaum app file at the
drive root — on macOS also the extracted `HilbertRaum.app` when a `.app.zip` is present (the
launcher runs the zip's copy from its local cache, unpacking it first if needed) — then
double-click the launcher again.

To see which app the launcher would start **without** starting it, run it with `/check` on
Windows (`"Start HilbertRaum.cmd" /check` in a Command Prompt opened at the drive root) or
`--check` on macOS/Linux (`./"Start HilbertRaum.command" --check`, `./start-hilbertraum.sh
--check`). It prints the drive root and the app it resolved, then "Nothing was started".

---

## A skill I dropped into the drive isn't doing anything

A skill you add yourself — by copying a folder into the drive's `user-skills/` — **installs switched
off** on purpose, so nothing a file added can run without your say-so. Open **Skills** in the sidebar,
find it in the list, and turn it **on**. (Built-in skills are on already.) If it isn't listed at all,
check that the folder contains a `SKILL.md` file at its top level, then reopen the Skills tab — the
app re-scans the folder when you open it after unlocking.

---

## "Import" rejected my skill package

The app validates a skill package **before** it installs anything, and tells you the reason rather
than installing something unsafe — nothing is written when an import is refused. Common reasons:

- **"A skill must be a .skill.zip file or a folder containing SKILL.md."** — you picked something that
  isn't a skill. Choose a `.skill.zip` file, or a **folder** that has a `SKILL.md` at its top level.
- **"The package does not contain a SKILL.md file."** — the zip/folder is missing the one required
  file. Every skill needs a `SKILL.md`. (A zip made with macOS Finder's "Compress" used to trip this
  wrongly — its hidden `__MACOSX`/`.DS_Store` entries confused the folder detection; fixed in #131,
  Finder zips now import normally.)
- **"The skill manifest is invalid."** / **"The skill id is not a valid name."** — the `SKILL.md`
  header is malformed or the skill's id has unexpected characters. Fix the header and re-import.
- **The package "could not be read as a valid zip…"**, "uses an unsupported … zip format", "contains
  a file whose path escapes the package folder", "a symbolic link", "an embedded archive", or is
  larger / deeper / has more files than allowed — these are the app's **safety checks** on an
  untrusted package. A trustworthy skill won't trip them; re-export it from a reliable source.
- **"A newer version of this skill is already installed…"** — you're importing an **older** version
  over a newer one. The app refuses a downgrade unless **developer mode** is on (Settings).
- **"App-provided skills cannot be changed or deleted."** — the built-in skills are read-only; you can
  turn them off, but not import over or delete them.

---

## A skill shows "Needs newer app"

That skill was built for a **newer version of HilbertRaum** than the one you're running, so its toggle
is greyed out — it stays listed but can't be switched on, suggested, or run. **Update the app** to the
version the skill needs and it becomes available. This is a courtesy check, not an error: nothing is
broken, and your other skills are unaffected.

---

## The skill tool found nothing in my document

A tool like *Bank statement* or *Invoice* reads only what it can **confidently** recognise, and it
**won't invent figures** — if a document doesn't look like the kind it expects, it honestly reports
nothing rather than guessing. A few things to check:

- **Run the reading step first.** Validate / categorise / export work on what was **read** from the
  statement or invoice — if you haven't run the read step yet, the tool will ask you to. Read it
  first, then run the others.
- **The document needs real text.** A scanned PDF (an image) has no text to read — use the document's
  **Make searchable (OCR)** action first (see *Importing a PDF didn't extract any text* above).
- **Unusual layouts read conservatively.** Bank/invoice formats vary a lot; the tools quote only the
  rows and totals they can parse cleanly and skip the rest. That's deliberate honesty, not a failure —
  a partial result is better than a wrong one.
- **A garbled-text invoice is refused, not guessed.** If an invoice's text comes through as jumbled
  glyphs — usually a scanned or oddly-encoded PDF — the *Invoice* tool automatically tries a second,
  layout-aware reading pass; if that still can't be read cleanly it tells you the layout couldn't be
  read rather than quoting figures it may have misread. Use the document's **Make searchable (OCR)**
  action, or re-import the original (a text-based PDF or the source file). Running OCR re-reads the
  document from scratch, so the next question you ask re-extracts from the corrected text — you don't
  need to delete and start over.

---

## Redaction left a name in, or an edit changed nothing

**Redaction** and **Document edit** are **AI-assisted best-effort**, never a guarantee — always review
the saved copy before you share it. If something you expected wasn't handled:

- **A name or address is still there.** Redaction always hides the clearly-shaped data (e-mails, phone
  numbers, IBANs, card numbers, dates, links) with the built-in rules; it only hides **names, addresses,
  and organisation names** when a **chat model is running**. If no model is running, the run tells you so
  ("offline rule-based detection only") and those are left in — start a model on **AI Model** and run it
  again. Even with a model it can miss an unusual spelling; check the copy and, if needed, use **Document
  edit** to remove what's left.
- **"Keep the city" (or similar) wasn't respected.** Say the scope in your own words when you ask
  ("remove names and street addresses, keep the city"). The app never guesses intent — it only hides what
  the model proposes within that scope, then hides each confirmed value **everywhere** it appears.
- **An edit reports text was skipped, or nothing changed.** The edit only changes text it finds
  **exactly** as written — if your wording doesn't match the document verbatim, that change is left alone
  and reported as skipped (nothing else is ever touched). Re-read the passage, copy the exact wording
  (including endings and punctuation), and ask again. A **running model is required** for edits — with no
  model the run asks you to start one rather than doing nothing silently.
- **The saved copy lost its formatting.** A **Word `.docx`** saves as a `.docx` with styles/tables/layout
  intact. **PDFs and other formats save as a `.txt`** (writing back into a PDF isn't supported), and a
  **scanned PDF** only exposes the text the app recognised from the image — redact/edit that from the
  `.txt` output.

---

## The Images screen says it needs a vision model

The **Images** screen ("ask about an image") uses a separate **vision model** that may not be on
your drive. If the screen shows a calm *"Image understanding needs a local vision model on this
drive"* card, open **AI Model** (the screen's button takes you there) and add a vision model — it's
an optional download, like the larger chat models, so internet access must be enabled in Settings
(see the User Guide §5). This is **not** OCR: for a scanned PDF or a document you want to search,
use the document's **Make searchable (OCR)** action instead (above).

---

## Asking about an image is slow / "Starting the vision model…"

That's expected the first time, and on the first question about a large picture:

- **The first question** loads the vision model into memory (a few seconds) and then reads the whole
  picture — reading a full-resolution image is real work for a laptop processor. **Follow-up**
  questions about the *same* image are quicker.
- **A graphics card speeds it up** where available; otherwise it runs on the processor.
- **Memory matters.** The vision model needs about **4–5 GB** on its own, on top of your chat model.
  On a machine with limited RAM, close other heavy apps, or use a smaller chat model while you work
  with images. If your laptop is tight on memory, the AI Model screen won't offer a vision model it
  can't run.
- **One image, one question at a time.** You can only ask one question at a time — wait for the
  current answer (or press **Stop**) before asking the next; a question asked while one is still
  running is declined, not queued. The picture and answers are **never uploaded**; they are saved
  to your image history (under `workspace/images/`, encrypted at rest on an encrypted workspace) so
  you can revisit them, and you can delete any saved analysis at any time from the Images screen.

---

## Windows asks to "scan and fix" the drive

Plugging the drive into a Windows machine sometimes shows *"There's a problem with this drive.
Scan the drive now and fix it?"* This almost always means the drive was **unplugged without a
safe eject** last time — not that the drive is broken.

Why it happens: the drive uses the exFAT filesystem (the one Windows, macOS, and Linux can all
write). exFAT keeps a "cleanly ejected" marker; pulling the drive while anything on it is still
open — including HilbertRaum, which keeps its database on the drive while it runs — leaves the
marker set, and Windows offers a check on the next plug-in.

What to do:

- Letting Windows **scan the drive is safe**. Your workspace database and models are ordinary
  files; the check either finds nothing or repairs filesystem bookkeeping.
- To avoid the prompt — and the small risk a hard unplug always carries on exFAT — make it a
  habit: **quit the app, wait for its window to close, then eject the drive safely** ("Safely
  Remove Hardware" on Windows, Eject in the Finder / your file manager). The app finishes its
  writes and closes its database cleanly when it quits; the safe eject flushes everything else.
- If the scan reports repaired files, or a `FOUND.000` folder appears on the drive, an earlier
  hard unplug interrupted a write. Start the app and check your documents are present. Model
  weight files can always be re-downloaded or re-provisioned if one was damaged; your workspace
  data cannot — which is exactly why the quit-then-eject habit is worth it.
- exFAT has a narrow durability limit that makes the habit matter: a hard power cut immediately
  after the app saves can, on rare occasions, roll that one save back to the previous one. The
  app is built so the **last cleanly locked version of your workspace always survives** such a
  rollback (you never get a corrupt mix), so at worst you lose the changes since that lock —
  the same window a mid-session crash carries. See [`drive-layout.md`](drive-layout.md) under
  **Filesystem** for the detail.

---

## Connecting another app to HilbertRaum (local API)

These cover the optional **Settings → Privacy & data → Local API** feature. If you have not turned
it on, none of them apply. Setup instructions, client examples, and the full HTTP contract are in
[`local-api.md`](local-api.md).

### The app I connected says "connection refused"

Work through these in order:

1. **Is the switch actually on, and did the endpoint start?** The card says *Listening on port …*
   when it is running. If it names a port conflict instead, see below.
2. **Is your workspace unlocked?** The endpoint exists only while it is. Lock or quit stops it.
3. **Are you using `localhost` instead of the address the card shows?** This is the most common
   cause on Windows 11: `localhost` resolves to the IPv6 address `::1` first, and some clients try
   only one of the two. HilbertRaum listens on **both** loopback addresses, but if a machine has
   IPv6 disabled the IPv6 listener cannot be created — a client that only tries `::1` then fails
   while `curl` works. **Paste the exact `http://127.0.0.1:<port>/v1` string from the card** rather
   than typing `localhost`.
4. **Did you change the port and forget to update the app?** The server address changes with it.

### "Another program on this computer is already using this number"

Something else holds the port. The switch stays on — only the bind failed — so just type a
different number in the card (4981, for example) and press **Apply**; the endpoint starts on the
new port straight away. Then paste the new server address into any app you had already connected.

If you were not expecting a conflict, take it seriously before you continue: a program squatting on
the port could be posing as HilbertRaum to collect the access key you are about to paste somewhere.
Find out what is listening first — `netstat -ano | findstr :4980` on Windows, `lsof -i :4980` on
macOS/Linux — and do not distribute your access key until you know.

### Will Windows Firewall / my antivirus complain?

**Windows Firewall does not prompt for this.** It filters traffic crossing the network stack, and a
loopback listener never does — nothing leaves the machine. If you *are* seeing a firewall prompt
naming HilbertRaum, something else is going on and it is worth investigating.

Endpoint-protection (EDR) products are a different matter: some flag any process that opens a
listening socket, whatever the address. That would show up as a "process listening on port 4980"
alert, not a network-traffic one, and it is an accurate description of what the app is doing. If
your organization's tooling objects, the honest answer is to leave the feature off — it is off by
default and nothing else in the app depends on it. A managed drive can also forbid it outright via
the drive policy.

### What the error numbers from my client mean

A connected app usually surfaces an HTTP status. Translated:

| Number | What happened | What to do |
|---|---|---|
| **400** | The request asked for something this endpoint cannot do — tool/function calling, images, more than one answer at a time — or the text did not fit the model's context window. | The message names the field. Turn off tools/function calling in the client; send less text if it is a length problem. |
| **401** | The access key is missing or wrong. | Copy the key again from the card. If you regenerated it, paste the new one into the app. |
| **403** | The request looked like it came from a web page, or was addressed to a hostname the app does not serve. | Use the exact server address from the card. Browser JavaScript cannot use this endpoint by design. |
| **404** | The app asked for a feature this endpoint does not provide. | Only chat completions and a model listing exist. Documents, embeddings, and image features are not exposed. |
| **413** | The request was too large. | Send less text at once. |
| **415** | The app did not send JSON. | Almost always a misconfigured client — check that you selected an OpenAI-compatible mode. |
| **429** | HilbertRaum was busy with another answer, or your own chat interrupted this one. | Wait a moment and try again; the response says how long. |
| **503 "model_not_loaded"** | No model is running. | Open HilbertRaum and start a model on the **AI Model** screen. |
| **503 "model_starting"** | A model is loading right now. | Wait and retry; the response says roughly how long. |
| **502** | The model did not answer. | Check the app — the model may have crashed; the Diagnostics tab has details. |

### An app's request stopped halfway

If you used HilbertRaum yourself while an outside app was generating, that is expected: your own
turn always wins, and the app's request is cut short with a "retry" answer. The card tells you it
just happened. The app can simply ask again.

---

## Knowledge packs (ZIM archives)

### The panel says kiwix-tools are missing

Knowledge packs are served by three small programs from the Kiwix project, kiwix-serve,
kiwix-manage and kiwix-search. Until the provisioning wave adds an in-app installer (an
in-app install step is being added, #339), place them on the drive yourself.

**Preferred: run the fetch script.** From the repository, against the drive:

- Windows: `scripts\fetch-runtime.ps1 -Target <drive-root> -Family kiwix_tools`
- macOS/Linux: `scripts/fetch-runtime.sh --target <drive-root> --family kiwix_tools`

The script downloads the pinned release, verifies it against the pinned SHA-256, extracts
the whole bundle into `runtime/kiwix-tools/<os>/` and sets executable permissions on
mac/linux. It writes a `.hilbertraum-runtime.json` install marker, so a later drive check
recognizes the install (a hand-placed bundle has no marker — see
[`known-limitations.md`](known-limitations.md) "Knowledge packs — ZIM archives").

**Fallback: download and extract by hand.** Get the pinned kiwix-tools 3.8.1 release for
your platform:

- Windows: `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_win-x86_64-3.8.1.zip`
- macOS (Apple Silicon): `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_macos-arm64-3.8.1.tar.gz`
- macOS (Intel): `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_macos-x86_64-3.8.1.tar.gz`
- Linux: `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_linux-x86_64-3.8.1.tar.gz`

The server publishes MD5 sidecars only (`<file>.md5`, no `.sha256`/`.sig`); the pinned
SHA-256 for each build is recorded in [`model-policy.md`](model-policy.md) "Sidecar
binaries — kiwix-tools" — check the download against it. The distro package (e.g. `apt
install kiwix-tools` on Ubuntu, which installs 3.2.0) is **not** the pinned version and is
not supported.

On Windows, unzip the **whole** bundle under `runtime/kiwix-tools/win`. The five ICU DLLs
(`icudt74.dll`, `icuin74.dll`, `icuio74.dll`, `icutu74.dll`, `icuuc74.dll`) must sit right
beside `kiwix-serve.exe` and `kiwix-manage.exe` — kiwix-serve won't start without them.

On macOS/Linux the `.tar.gz` extracts into a single top-level folder (for example
`kiwix-tools_linux-x86_64-3.8.1/`) holding the three binaries and nothing else. Strip that
folder on extraction so the binaries land directly under `runtime/kiwix-tools/<os>/` — for
example: `tar -xzf kiwix-tools_linux-x86_64-3.8.1.tar.gz --strip-components=1 -C
runtime/kiwix-tools/linux` (or extract normally and move the contents up a level) — then
`chmod +x` the three binaries. `runtime/kiwix-tools/linux/kiwix-serve` must resolve
directly; a bundle left one directory too deep is not picked up.

The version is pinned; a different kiwix-tools release is not supported. Either way, the app
picks the files up on **Refresh** under *Documents → Knowledge packs* — no restart needed.

### "The archive could not be read by kiwix-manage" — but the file is fine

On Windows the pinned kiwix-manage cannot open an archive whose folder or file name contains an
umlaut, an accent or any other non-ASCII character (for example a file under
`C:\Users\Jörg\Downloads`). Move or copy the file to a path without such characters — the
drive's own `zim/` folder is the simplest — and add it again. Once registered, the pack works
normally; only the add step is affected.

### A pack shows "File missing" or "Different archive"

Press **Refresh** under *Documents → Knowledge packs* first — the app only checks the drive
at unlock and on Refresh, not continuously. "File missing" means neither the drive's `zim/`
folder nor the file's last known location has a matching file right now — common after
moving a file registered from outside the drive, or after the drive's letter changed on
Windows. "Different archive" means a file exists at that location, but its own header names
a different archive than the one you registered — the app checks the file's built-in
identity, never just its name or path, so it will not silently serve the wrong content under
an old title.

### An answer says a pack was "not searched: name collision with another pack"

Two packs whose **file names** are the same (in different folders) would ask the pack server for
the same address, so only one of them can be served — the app keeps one and leaves the other out
rather than answering from the wrong archive. Rename one of the two `.zim` files so their names
differ, then press **Refresh** under *Documents → Knowledge packs*.

### "No full-text index" vs. zero hits vs. "search failed" / "server restarted"

These look similar but mean different things:

- **"No full-text index"** — this archive was not built with a search index. Its articles
  are still readable one at a time (use *Open article* on a citation), but the app can't
  search inside it, so it's skipped when answering.
- **Zero hits** — the pack was searched successfully and nothing matched your question. This
  is a normal, successful search, not a problem with the pack.
- **"Search failed" / "the pack server restarted"** — something interrupted the request (the
  pack server had to restart mid-question, or ran out of time). The answer still uses
  whatever the other sources found; ask again if you want that pack included.

### "Could not lock the workspace" while a knowledge pack was in use

If a knowledge-pack server was running when you locked or quit, the app stops it and removes
its generated index as part of locking. If that cleanup itself hits trouble, the app reports
it honestly rather than claiming success — nothing of yours is lost, and the next session
starts clean and works normally.

### "Open article" says the article is not available, but the pack is enabled

Try again — it usually opens on the second attempt. The bundled Windows pack server occasionally
cuts a read of a large article short — the last part never arrives (a known defect of
kiwix-tools 3.8.1, see
[`known-limitations.md`](known-limitations.md) "Knowledge packs"); the app already retries such a
read a few times on its own, so this should be rare. If it keeps happening for one article, the
pack's file may be damaged: run *Refresh* under *Documents → Knowledge packs* and, if the pack
shows "Different archive" or "File missing", copy the archive again.

### Can another program on my computer read my packs?

While the workspace is unlocked and a knowledge pack has been used in a chat, other programs
running under your own user account on this computer can read the enabled packs through the
pack server, which has no password of its own; locking or quitting stops it.

---

## Where are my data and logs?

Everything is on the drive:
- `workspace/` — your encrypted/plaintext database (chats, documents, embeddings).
- `logs/app.log` (`app.log.enc` on an encrypted workspace — the diagnostics log is encrypted at
  rest, same as your data) — local logs only; never uploaded.
- `models/` — model weights. `config/` — drive settings/policy.

See [`drive-layout.md`](drive-layout.md) for the full layout.
