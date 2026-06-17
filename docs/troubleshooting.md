# HilbertRaum — Troubleshooting

_Last updated: 2026-06-17 (added Skills entries: drop-ins install disabled, import rejections, the "Needs newer app" badge, and "the skill tool found nothing"; previously: scanned-PDF answer updated for the OCR feature; supported types extended for audio + photos)_

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

**No. That is the intended state.** HilbertRaum runs the AI model on your laptop and
keeps your data local. It does not need the internet and network access is off by default. You
can confirm this on the **Privacy** screen.

---

## The answers look like placeholders / "echo" replies

The app is running its built-in **mock** runtime — started via **Start mock runtime** on the
AI Model screen, or used as a first-run fallback on a **developer** build when no model weight is
installed yet. (On a prepared drive without developer mode, a missing weight shows an error rather
than falling back to the mock.) The mock lets you explore the interface, but it does not produce real
AI answers.

**Fix:** add a real model file:
1. On the **AI Model** screen, note the model marked *Recommended*.
2. Put the matching `.gguf` weight file into `models/chat/` on the drive (and the embeddings
   model into `models/embeddings/`). File names come from the model's manifest (`local_path`).
3. Put the `llama-server` program for your system into `runtime/llama.cpp/win` (Windows),
   `runtime/llama.cpp/mac` (macOS), or `runtime/llama.cpp/linux` (Linux).
4. Restart the app and **Start** the model again.

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
- **Heavy model for your laptop:** pick the **Recommended** model on the AI Model screen. The
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

Some PDFs are scanned images with no embedded text. The app detects this and marks the file
*"This PDF looks like a scan"* — use the row's **Make searchable (OCR)** action to read the
text locally (German + English; needs the drive's `ocr/` language files; runs a couple of
seconds per page). PDFs that mix real text pages with scanned pages index their text pages
only — they are not detected as scans.

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

## A skill I dropped into the drive isn't doing anything

A skill you add yourself — by copying a folder into the drive's `user-skills/` — **installs switched
off** on purpose, so nothing a file added can run without your say-so. Open **Settings → Skills**,
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
  file. Every skill needs a `SKILL.md`.
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

---

## Where are my data and logs?

Everything is on the drive:
- `workspace/` — your encrypted/plaintext database (chats, documents, embeddings).
- `logs/app.log` — local logs only; never uploaded.
- `models/` — model weights. `config/` — drive settings/policy.

See [`drive-layout.md`](drive-layout.md) for the full layout.
