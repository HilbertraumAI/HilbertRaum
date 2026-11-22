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

## Linux: the AppImage does not start

**On a prepared drive, start the launcher.** `start-hilbertraum.sh` makes the AppImage executable
for you and points the app at the drive's workspace. An AppImage started on its own from the drive
finds the drive's workspace too (before #858 it opened a separate, empty workspace in your home
folder; the data on the drive was untouched). If double-clicking the launcher opens
it in a text editor or does nothing, open a terminal in the drive's top folder and run
`./start-hilbertraum.sh`. The terminal also shows any error message that a double-click hides.

**A downloaded AppImage does nothing on double-click.** A downloaded file is not executable yet,
and a double-click hides any error message. Make it executable once, then start it from a
terminal:

```bash
chmod +x HilbertRaum-<version>.AppImage
./HilbertRaum-<version>.AppImage
```

**"dlopen(): error loading libfuse.so.2" / "AppImages require FUSE to run".** AppImages need the
older FUSE 2 library, which newer distributions no longer install by default. Install it once:

- Ubuntu 24.04 and later: `sudo apt install libfuse2t64`
- Ubuntu 22.04, Debian, Linux Mint: `sudo apt install libfuse2`
- Fedora: `sudo dnf install fuse-libs`

No administrator rights on this computer? Start the app without FUSE instead. It then unpacks
itself into a temporary folder on every start (about 430 MB, listed file by file in the terminal,
and removed again when the app quits), so starting takes longer:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./start-hilbertraum.sh            # prepared drive
APPIMAGE_EXTRACT_AND_RUN=1 ./HilbertRaum-<version>.AppImage   # downloaded AppImage
```

**You do not need `--no-sandbox`.** Advice for other Electron apps often says to add it when an
AppImage aborts with a `chrome-sandbox` or "SUID sandbox helper" error. HilbertRaum's AppImage
checks for that situation itself (it arises on Ubuntu 24.04 and later, for example) and starts
without the sandbox instead of aborting. What that means for security is described in
[`known-limitations.md`](known-limitations.md) under "Security & privacy".

**The app starts, but the AI engine does not.** See the next entry.

---

## "The AI engine can't run on this computer"

The AI engine is on your drive, but your operating system refused to start it. This happens
before the engine can do anything, so it is not a problem with a model or with your graphics card.
Until it is fixed, models answer in **demo mode** with visibly simulated replies. Your documents,
chats and settings are not affected.

The **AI Model** screen shows a banner that says which of the cases below applies. **Settings →
Diagnostics** shows the technical detail: the library's name and the exit code. Once you have
fixed the cause, choose **Check again** in that banner, or restart the app. The app stores nothing
about this, so there is nothing to reset.

**Linux: "A system library it needs is missing: libgomp.so.1".** The engine uses GCC's OpenMP
library. Desktop installations of Ubuntu, Debian, Linux Mint and Fedora normally include it; it
can be missing on minimal or server installations. Install it once:

- Ubuntu, Debian, Linux Mint: `sudo apt install libgomp1`
- Fedora: `sudo dnf install libgomp`

The voice engine (dictation and audio import), where one is installed, needs the same library.
If the banner names another library, install the package that provides it with your software
manager.

**Linux: "It needs a newer Linux".** The engine is built for 2022-era systems and newer. It needs
glibc 2.34, the C++ library of GCC 12 (`GLIBCXX_3.4.30`) and OpenSSL 3. That means **Ubuntu 22.04,
Debian 12 or Fedora 36, or newer**; Linux Mint 21 and newer are based on Ubuntu 22.04. On an older
system, such as Ubuntu 20.04 or Debian 11, no package fixes this: the system itself needs an
upgrade. A missing `libvulkan1` is *not* this problem: without it the engine simply runs on the
processor.

**Windows: "Windows is missing the Microsoft Visual C++ Redistributable".** The engines use
Microsoft's C++ runtime (`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`). Many PCs
already have it because other programs installed it, but it is not part of Windows itself.
Install the **Microsoft Visual C++ Redistributable for Visual Studio 2015–2022, x64 version**,
from Microsoft. The download needs an internet connection; if this computer stays offline, fetch
the installer on another computer and copy it over. Then choose Check again.

**Windows: "Windows security blocked it".** Smart App Control, or an antivirus program, refused to
start the engine. The engine programs are not signed by a publisher Smart App Control knows, and its
block does not happen every time: on the project's own test machine it came and went from one day
to the next. Choose Check again later. An antivirus program may have put the engine in quarantine;
its own window says so and lets you allow it. Whether to change these settings (Windows Security →
App & browser control → Smart App Control, or your antivirus program's settings) is your decision;
the app cannot override them.

**"Some of its files on this drive are missing or damaged".** A library that the engine keeps next
to its program could not be loaded, which usually means an interrupted copy. Choose **Install the
AI engine again** in the banner (for the voice engine: **Install the voice engine again**, under
the speech model). It downloads a fresh copy, checks it against its pinned checksum, unpacks and
checks it beside the engine folder, swaps it in and starts your model again. On a Kit it replaces
the part that could not start: the main engine, its `cpu/` safety net, or both. If the download
fails, you cancel it, or the new copy cannot be unpacked or swapped in, the copy on the drive stays
as it was (#986). Like every download, it needs **Allow internet access…** in Settings; if the
button is greyed out, the line under it says why.

If the drive does not allow downloads (an offline Kit), or this computer has no internet:
- On a drive someone prepared for you, ask them to copy the engine folder again.
- Otherwise do it by hand: quit the app, delete the engine folder on the drive
  (`runtime/llama.cpp/win`, `…/mac` or `…/linux`; for the voice engine `runtime/whisper.cpp/…`),
  start the app again on a computer with internet, and install the engine from the AI Model screen.

**"It was just installed and still can't start".** The banner says this when a freshly installed,
checksum-verified copy is refused as damaged too, so its files are probably not the cause, and it
offers no second reinstall. On Windows this usually means an outdated Visual C++ Redistributable
whose files are present: install the current one (above), then choose Check again. An antivirus
program that removed one of the engine's files is the other common cause; its own window says
so and lets you restore the file. On Linux and macOS, check that the drive's file system kept the
engine's files intact (copy it to an internal disk and try from there).

**macOS: "It needs a newer version of macOS".** Update macOS, then choose Check again.

**What the other screens say meanwhile.** Each says the same thing in one sentence and points to
the AI Model screen:
- documents that failed to import (choose **Try again** once the engine runs);
- **Translate** and **Images**;
- voice dictation;
- the notice in the chat.

---

## "An update for the AI engine is available"

The drive carries an older version of the AI engine (or the voice engine) than this app was built
and tested with. It still works; the update brings it to the version the app expects.
**Settings → Diagnostics** shows both versions under *Engine versions*.

- **To update:** choose **Update** in the notice on the **AI Model** screen. The new version
  downloads, is checked against its pinned checksum and is unpacked beside the old one while your
  model keeps answering. Then the models pause for a few seconds while the new version is swapped
  in, and the selected model starts again. If the download fails, you cancel it before the swap, or
  the new version cannot be unpacked or swapped in, the engine on the drive stays as it was and keeps
  working (#986); a download or unpack that fails or that you cancel never stops your model (#1000).
- **"The AI engine downloaded but could not be unpacked":** a file the new version's archive holds
  was missing once it was unpacked, often because an antivirus program took it as soon as it was
  written. The app checks every file against the archive's own list before it swaps anything, so the
  engine on the drive is unchanged (#998). Try again; if it keeps happening, see whether your
  antivirus program reports the engine's files. The same check runs for an install or a reinstall.
- **"There is not enough free space on this drive: the engine needs … once unpacked":** the app
  checks this before it touches anything, so the engine on the drive is unchanged. Free up at least
  the space it names (the old version is removed only after the new one is in place, so both fit at
  once for a moment), then choose Update again. The same check runs before an install or a reinstall.
- **"The engine could not be replaced because another program is using one of its files":** often
  an antivirus program scanning the new files. The app waited and tried again, then put the old
  engine back. Rarely even that is refused: the AI Model screen then says the engine is missing, and
  both copies wait on the drive. Wait a minute and try again (in that case with **Install the AI
  engine**): the app first puts the new copy in place, so nothing is lost; restarting the app does
  the same. If the other program still holds the folder, the app says so again and changes nothing;
  wait a little longer, or restart the computer. If it keeps happening, see whether your antivirus program reports the engine's files.
- **"The AI engine is in use right now":** an answer, an import, a translation or a document task is
  running. Wait until it has finished, then choose Update again.
- **The button is greyed out:** like every download, the update needs **Allow internet access…** in
  Settings and a drive that permits downloads. On a drive whose policy forbids downloads (an
  offline Kit), whoever prepared the drive updates it with the scripts: `prepare-drive` on the
  drive, then `fetch-runtime` (`packaging.md`).
- **A drive used with a newer app** may carry a newer engine than this app expects. The app never
  replaces it with an older one; Diagnostics says "newer than this app expects".

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

## Downloads fail on a company network or behind antivirus

Since #564 the in-app downloads trust the certificates installed on the computer (the operating
system's store, usable roots only) as well as the app's own. A released build no longer reads
`NODE_EXTRA_CA_CERTS`. A proxy or an antivirus product that inspects encrypted connections works
when it also put its root certificate in the operating system's store, which most do. If it only
set the variable, every download fails.

Install the proxy's or the antivirus product's root certificate in the operating system's store
(your IT department usually does this). A download is still checked against its SHA-256, so
nothing unverified installs. See [`known-limitations.md`](known-limitations.md) for the details.

---

## "Offline Mode is ON — is something wrong?"

**No. That is the intended state.** HilbertRaum runs the AI model on this computer and
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
   model into `models/embeddings/`). File names come from the model's manifest (`local_path`,
   plus any additional files its `files:` list declares — #310).
3. Put the `llama-server` program for your system into `runtime/llama.cpp/win` (Windows),
   `runtime/llama.cpp/mac` (macOS), or `runtime/llama.cpp/linux` (Linux).
4. Restart the app and press **Use this model** again.

If you have the repo, a drive builder can do steps 2–3 with the prepare-drive + verify-models
scripts (see [`packaging.md`](packaging.md)).

If the model and the engine are both on the drive and the AI Model screen says **"The AI engine
can't run on this computer"**, a file is not missing — see the entry of that name above.

---

## "… can't be started: its model file isn't on this drive yet."

The model's weight file is missing from the `models/` folder (the AI Model screen shows it as
**Not downloaded**). Add the file (above), or choose a model already shown as **Installed**. The app
only downloads a model when you explicitly ask it to on the AI Model screen. The message is in your
interface language.

---

## A model shows "Can't verify"

A required file on the drive doesn't match the expected fingerprint in its manifest. Starting it
says it "failed its file check". For a model whose weight is more than one file (#310),
`verify-models` names the specific offending file (with a `(mmproj)` or `(file N/M)` label) rather
than just the model. The file may be incomplete or corrupted. Re-copy the named weight file, then
run the verifier:

```powershell
.\scripts\verify-models.ps1 -Target E:\         # Windows
```
```bash
scripts/verify-models.sh --target /Volumes/HILBERTRAUM   # macOS/Linux
```

On a developer drive, unverified models are allowed; a commercial drive requires a matching
checksum.

**If the card says "No checksum" instead**, nothing is wrong with the file: the model's manifest
has a placeholder in place of a real checksum, as a model you add yourself does until you capture
its hash. There is no Download button, because a new copy cannot give the manifest a checksum. To
use the model, either write its real `sha256` into the manifest with `scripts/verify-models.sh
--generate` (or the `.ps1`), or turn on Developer mode on a drive whose policy allows unverified
models. The Performance screen says "no checksum on record" for the same model. The Images and
Translate screens, and the app's log when it refuses to start such a chat model on its own, still
say it failed its file check (see [`known-limitations.md`](known-limitations.md)).

**If an in-app download stalls near the end (~95%) and then shows "Can't verify" after Resume**, the
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
it, the data **cannot be recovered** — this is by design.

Before you do anything: read the message on the unlock screen carefully. "That password didn't
unlock your workspace" means the password was wrong. If it says anything else, your password may
well be right, and starting over is the wrong move: see the sections below for "the workspace
data on the drive is damaged", "could not finish opening", "the encrypted workspace file is
missing" and "the file that holds your workspace's key".

HilbertRaum has no reset, and it never creates a new workspace over an existing one: while a
workspace is on the drive, the lock screen only asks for its password. To start over, you set the
old workspace aside by hand (issue #931):

1. **Quit HilbertRaum.**
2. **On the drive, move `config/workspace.json` and the whole `workspace/` folder, together, off
   the drive**: for example into a folder `old-workspace/` on your computer, as
   `old-workspace/config/workspace.json` and `old-workspace/workspace/`. If you run HilbertRaum
   without a Kit (a release download started on its own), the two are in the app's data folder
   instead (on Windows `%APPDATA%\@hilbertraum\desktop`; see "How the app finds its data" in
   [`drive-layout.md`](drive-layout.md), the app-data fallback): move them out of that folder.
   - **Move both.** With only one of them moved, the app still shows the unlock screen, and the
     right password then reads as a missing file.
   - **Move, don't delete.** Together, and only together, they still open with the old password
     if you remember it later.
   - **Leave the rest of `config/` where it is.** `drive.json`, `policy.json` and
     `checksums.json` belong to the drive, not to the workspace. A `config/working-copy-lost.json`
     can be there too: leaving it is harmless, since creating the new workspace removes it.
3. **Start HilbertRaum.** The lock screen now offers to create a workspace: create the new one
   with a new password.

What stays on the drive and works as before: your AI models, the AI engine, the knowledge packs in
the drive's `zim/` folder, the OCR files and your skills (skills you added yourself come back
switched off; switch them on in Settings → Skills). A knowledge pack you added from a place
outside the drive's `zim/` folder was recorded in the old workspace only: add it again. The
first start of each model checks its file again, and the speed measurement runs again, as on a
new drive.

What stays behind in the moved folder, readable only with the old password: the old chats,
documents and their stored copies, images, reviews, projects, settings and activity. The old
workspace's diagnostics log is in `logs/`, encrypted under the old key: the new workspace starts
a new log in its place, so move `logs/` along too if you want to keep the old one. Everything you
moved is encrypted, except a `workspace/hilbertraum.sqlite.recovery` if there is one, which holds
the old workspace in readable form (see "The encrypted workspace file was missing from the drive"
below): moving it to a computer copies that readable file there. A `workspace/zim-transient/`
folder is not encrypted either while it holds anything, but it lists only the titles and file
paths of your knowledge packs, none of your content.

To go back to the old workspace (you remember its password): quit HilbertRaum, move the new
workspace's `config/workspace.json` and `workspace/` away the same way, put the old pair back in
their places, start the app and unlock with the old password. (If you put the pair back while
HilbertRaum is still open, it is not overwritten: **Create workspace** is refused, and the lock
screen switches to the unlock screen, #954.) **Never combine one workspace's
`config/workspace.json` with another workspace's `workspace/` folder**: neither password opens
that pair, and with the new password the lock screen says the workspace data is damaged.

---

## "Your password is correct, but the workspace data on the drive is damaged"

This message (issue #208) means the app verified your password, but the encrypted workspace
file failed its integrity check (its bytes changed after it was written, for example a copy
that was cut short), or it decrypted to something that is not a readable database — the
encrypted file itself was damaged at some earlier point. Retyping the password cannot help,
and this is deliberately **not** worded as a password problem.

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
normally. Copies up to 0.1.59 cannot give that message; they open the workspace anyway. The
same message also covers the encrypted workspace's own files (issue #845): its
`config/workspace.json` or its encrypted data in a format a newer copy wrote. The unlock screen
shows it whatever password you type, because the older copy cannot check a password in a format
it does not know; your password is not the problem, and nothing was changed. Copies up to 0.1.65
cannot give it for those files. It also covers a readable copy of the workspace that a newer copy
left on the drive (issue #985): `workspace/hilbertraum.sqlite.recovery`, after a lock that failed,
for example on a full drive. The older copy keeps that file as it is and does not open it, so the
newer copy's last session is not lost: start the newer copy and unlock, and it encrypts the file
again. Here the message comes after the password is checked. If no newer copy ever ran on this
drive, that file may be damaged instead: to open the workspace at its last lock with this copy,
quit HilbertRaum, move `workspace/hilbertraum.sqlite.recovery` off the drive, and unlock again.
Keep that file somewhere safe: it is your workspace's data, not encrypted. Copies up to 0.1.65 can
delete such a file when they cannot read it. Creating a new workspace is refused with the same
message while such a file is on the drive. When that file is older than the encrypted workspace
file (the newer copy already opened and locked the workspace since), the older copy opens the
workspace without the message, leaves the file as it is and notes it in the diagnostics log. It is
still your workspace's data, not encrypted: the newer copy removes it at its next unlock, and this
copy replaces it if a later lock fails.

---

## "Your password is correct, but HilbertRaum could not finish opening the workspace"

This message (issue #844) means the password was right and the workspace decrypted to a
readable database, but opening it could not finish. Each version of the app may update the
workspace's internal layout when it first opens it, and that step needs some free space on
the drive. Typical causes: a nearly full drive, a USB connection that dropped, or a fault in a
new version's update step. Nothing is damaged: the failed open does not change the encrypted
workspace on the drive.

What to do:

- Free some space on the drive, then unlock again.
- If the drive was unplugged or is flaky, reconnect it and try again.
- If this started right after an update, the previous release can still open the workspace,
  because the failed update did not convert it. Put that release back **in place of** the new
  one (never both side by side, see "Two app versions on the drive" below), and report the
  issue.

Before #844 this case showed the "damaged … restore from a backup" message above, although
nothing was damaged.

---

## "Could not lock the workspace"

Locking re-encrypts your workspace on the drive, and that briefly needs **free space about the
size of your workspace database**. On a nearly-full drive the re-encrypt can fail — the app
then keeps the workspace **open and usable**, and nothing is lost.

What to do: free some space on the drive (delete files you no longer need, or move a large
model off the drive via the AI Model screen), then press **Lock now** again. Quitting the app
retries the lock too, but **free space before you quit**: whether a quit on a full drive keeps the
session depends on where the lock stopped. If only the re-encrypt failed, the app closes the
workspace's database cleanly, and your newest data is secured at the next unlock. If the drive is
so full that the session's last changes could not even be written into the database file, the
quit cannot lock the workspace or close it cleanly either: the next start opens it as it was the
last time it was locked, those changes are lost, and the unlock screen says so (see "HilbertRaum
didn't lock your workspace the last time it closed" below).

The lock stops the AI model (and every other engine) before it re-encrypts, so after a failed
lock the model comes back the same way it does after an unlock: automatically in the
background when **Start the selected model automatically** is on (Chat shows "Starting…" for a
moment and then the composer again), or by hand on the AI Model screen when that setting is off.
The local API, if you have it switched on, comes back as well. Everything else — document
search, the reranker, translation, voice input, OCR, knowledge packs — restarts on its next use.

---

## "The workspace's working file on the drive was removed or damaged"

You see this on the unlock screen right after a lock, or the next time you start HilbertRaum when
it happened as the app closed (**Settings → Diagnostics (advanced) → Activity** then records it
when you unlock, as "Recent changes lost"). While the workspace was open, something
outside HilbertRaum deleted or overwrote its working file on the drive: a cleanup tool, a second
copy of the app started from another place, a failing drive. Nothing newer than the last secured
copy was left, so the app locked the workspace as it was the last time it was locked or the app
was closed. The changes made since then are lost; everything before is intact.

What to do: if another copy of HilbertRaum is open on this drive (started from another folder
or another computer), close it first. Then unlock as usual and carry on. If it happens again,
find what else touches the drive's `workspace` folder, and check the drive for errors.

---

## "HilbertRaum didn't lock your workspace the last time it closed"

You see this on the unlock screen when HilbertRaum ended while the workspace was open, without
locking it: the drive was pulled out, the computer lost power, or the app was stopped by force
(Task Manager, a kill). The session's working copy was left on the drive unencrypted, so this
start removed it securely, as it always does in that case, and opened the workspace as it was the
last time it was locked. Any changes made after that are lost; everything before is intact.
**Settings → Diagnostics (advanced) → Activity** records it when you unlock, as "Recent changes
lost".

If the message says HilbertRaum **couldn't lock your workspace because the drive was full**, the
drive had less free space than a lock of that session needs (room for the session's working
files), measured at this start, before the working copy was removed. That is how a quit on a full drive ends (see "Could not lock the workspace" above). Make
sure the drive has free space before you continue (delete files you no longer need, or move a large
model off the drive via the AI Model screen), or the next session ends the same way. The message
stays until you unlock, even if you have already freed space. The app can't see why the last
session ended, only how much room is left: if the drive was also pulled out or the power was lost,
the message still names the full drive.

What to do: unlock as usual and redo what you changed after the last lock. Next time, quit
HilbertRaum, or press **Lock now**, and wait for the window to close before you remove the drive.

---

## "The encrypted workspace file was missing from the drive"

You see this on the unlock screen when HilbertRaum started and found the workspace's encrypted
file, `workspace/hilbertraum.sqlite.enc`, gone from the drive, while the copy your last session
worked on was still there. Something outside HilbertRaum removed the encrypted file: a sync or
backup tool, a cleanup tool, a person tidying the drive, or a disk check that moved it into a
`FOUND.000` folder. HilbertRaum never deletes it on its own.

That working copy is now the only copy of your workspace, so the app kept it, as
`workspace/hilbertraum.sqlite.recovery`, instead of removing it (issue #911). While it waits there
it is **not encrypted**.

What to do:

- Unlock with your usual password. The app encrypts the copy again as the workspace's encrypted
  file and opens the workspace as your last session left it. In rare cases the last changes of that
  session are missing, or a damaged copy is not kept (see `docs/known-limitations.md`).
- Unlock first. Don't put an older copy of the encrypted file back before you unlock: if that copy
  carries a newer file date than the kept one, the app takes it for the newest, and the changes of
  your last session are lost.
- Then find out what removed the file, so it does not happen again: for example a sync tool that
  mirrors the drive, or a cleanup tool that removes large files.
- If you can't unlock it any more (you forgot the password), the kept copy is your workspace in
  readable form, and the app no longer removes it at the next start. Delete
  `workspace/hilbertraum.sqlite.recovery` yourself if you don't want it on the drive.

---

## "Your password is correct, but the encrypted workspace file is missing from the drive"

This message (issue #911) means the app checked your password, and it is right, but the
workspace's encrypted file, `workspace/hilbertraum.sqlite.enc`, is not on the drive, and no copy
was left to restore it from. Something outside HilbertRaum removed it (see the section above).
Retyping the password cannot help.

What to do:

- **Do not create a new workspace**, and do not delete anything: a new workspace cannot read the
  documents you imported, and it replaces what a recovery needs.
- Look for the file first: in the recycle bin or trash, in a sync tool's deleted or conflict
  files, or in a `FOUND.000` folder at the drive's root after a disk check (its files are named
  like `FILE0000.CHK`; the workspace is usually the largest). Put it back as
  `workspace/hilbertraum.sqlite.enc` and unlock again.
- Otherwise restore the `workspace/` folder from a backup and unlock with your current password.
  Leave `config/` as it is: it holds the wrapped key that opens the workspace, and it follows your
  password. Only a backup made before the first password change on a workspace that an older
  version created needs its own `config/` folder too; then unlock with that backup's password.

You can also see this message when an older version of HilbertRaum (0.1.65 or earlier) started on
the drive after the encrypted file went missing: those versions removed the copy the last session
left. Before #911 this case only ever said "Could not open the workspace."

---

## "The file that holds your workspace's key (config/workspace.json) is missing from the drive or can't be read"

You see this on the unlock screen, whatever password you type, when the workspace's encrypted file,
`workspace/hilbertraum.sqlite.enc`, is on the drive, but `config/workspace.json` is not, or it is
there and damaged (for example a copy that was cut short). That small file holds what your password
unlocks: the key the workspace is encrypted with, itself encrypted under your password. Without it
no password can open the workspace, and the app cannot even check whether the password is right.
Something outside HilbertRaum removed or changed it: a sync or cleanup tool, a person tidying the
drive, or a fresh start by hand that moved `workspace/` but not `config/workspace.json` (see "I
forgot my workspace password" above). Before #807 this case only said "Could not open the
workspace."

What to do:

- **Do not create a new workspace**, and do not delete anything: a new workspace gets a new key,
  and the documents and data you have can then never be opened.
- Look for the file: in the recycle bin or trash, in a sync tool's deleted or conflict files, or in
  the folder you moved an old workspace into. Put it back as `config/workspace.json` and unlock
  again.
- Otherwise restore `config/workspace.json` from a backup of this same workspace, and unlock with
  the password the workspace had when that backup was made. A `workspace.json` from another
  workspace opens nothing: the lock screen then reads it as a wrong password or as damaged data.
  One exception: a backup made before the first password change on a workspace that an older
  version created belongs only with the `workspace/` folder of that same backup.

---

## "The file that holds your workspace's key (config/workspace.json) can't be read, and the encrypted workspace file isn't on the drive"

You see this on the unlock screen, whatever password you type, when `config/workspace.json` is on
the drive but can't be read, and the workspace's encrypted file, `workspace/hilbertraum.sqlite.enc`,
is not there. The create step shows it too when such a file appears on the drive while it is open.
No password can open anything then: the key file holds the key, and the encrypted
file holds the data. The lock screen does not offer a new workspace either, because other parts of
the old one may still be on the drive: a `workspace/hilbertraum.sqlite.recovery` (the readable copy
a session left, see "The encrypted workspace file was missing from the drive" above), a
`workspace/hilbertraum.sqlite.enc.new`, or your stored documents in `workspace/documents/`. Before
#955 this case only said "Could not open the workspace."

What to do:

- **Don't delete the key file**, and keep a copy of it. It can be damaged in a way that can be
  repaired: a key file that was edited by hand or by a tool (a bracket removed, text a sync tool
  added) can often be put right. (A UTF-8 byte-order mark that an editor such as Windows PowerShell
  5.1 or an older Notepad adds no longer makes the file unreadable, issue #974. A file saved as
  UTF-16, the default of PowerShell 5.1's `>` and `Out-File`, still does.)
- Look for the encrypted file first, as "Your password is correct, but the encrypted workspace file
  is missing from the drive" above describes: the recycle bin or trash, a sync tool's deleted or
  conflict files, a `FOUND.000` folder. Put it back as `workspace/hilbertraum.sqlite.enc`.
- Otherwise restore both, `config/workspace.json` and the `workspace/` folder, from a backup of this
  workspace, and unlock with the password it had when the backup was made.
- To start over instead, set the old workspace aside as "I forgot my workspace password" above
  describes: quit HilbertRaum and move **both** `config/workspace.json` and the whole `workspace/`
  folder off the drive, together. With only the key file moved, the rest of the old workspace stays
  in `workspace/`, and the new workspace would remove parts of it as leftovers.

---

## "Could not create the workspace."

You see this on the lock screen's "Create your password" step when the new workspace could not be
written to the drive: the drive is full or write-protected, or another program, often an antivirus
program, held one of the new files.

What to do:

- Free some space or close that program, then press **Create workspace** again.
- If the lock screen then says "A workspace already exists on this drive, so no new one was created"
  and shows **Unlock your workspace**, the first try got far enough to save the workspace's key file:
  unlock with the password you chose the first time (a different one typed on the retry does not
  open it). Restarting HilbertRaum shows the same unlock screen.
- If it keeps failing, check that the drive is writable on this computer (not locked, not mounted
  read-only) and has free space.

If the lock screen switched to **Unlock your workspace** because a `config/workspace.json` was put on
the drive by mistake while the create step was open, and you removed that file again, restart
HilbertRaum to get the create step back: until then every unlock says "Could not open the workspace."

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

The same message also appears when the workspace's encrypted file is missing and the app cannot
yet set aside the copy your last session left (see "The encrypted workspace file was missing from
the drive" above), usually because the drive is full or another program is reading the workspace:
free some space or close that program, then unlock again.

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

## An answer says "Reply stopped", or a question says "Not answered"

That answer ended before it was finished: you pressed **Stop**, stopped or switched the AI model,
locked the workspace, or closed the app while it was being written. Point at the label to see which.
The app ends the answer cleanly, so nothing is wrong with the model:

- **"Reply stopped"** under an answer: the text so far is kept, and the label says it is not the
  whole answer. Ask again if you need the rest. For a bank statement or an invoice, the figures the
  app read from the document still follow the stopped text; they are complete and checked.
- **"Not answered — …"** under a question: no word of the answer had been written yet (on a computer
  without a graphics card, reading a long question can take minutes). The note says why: you stopped
  it, the AI model was stopped, or the workspace was locked or the app closed. Send the question again
  (start a model first if none is running).
- If you pressed **Try again** and then stopped or switched the model, locked the workspace or closed
  the app, the previous complete answer stays — the half-written new one is dropped. If you pressed
  **Stop** on the new answer yourself, the half-written one stays instead.

While an answer is being written, the AI Model screen says so on the running model's card before
you stop or switch it.

---

## "The AI model stopped before the answer was finished"

The AI model's program closed while it was answering — it crashed, or something on the computer
ended it (Task Manager, an antivirus tool, too little free memory). The unfinished answer is not
kept.

- Send your message again. The app restarts the model by itself: on the graphics card in
  compatibility mode (see above), on the processor once per session (see the next section).
- If it keeps happening, a smaller model is the next step — see
  [The app feels slow](#the-app-feels-slow) for what fits your computer.

---

## "The AI model stopped unexpectedly and is starting again"

The model's program crashed while it ran on the processor, or something on the computer ended it.
The app starts it again by itself, once per model each time you open the app. Wait until the AI
Model screen says **Running**, then send your message again.

If the same model stops a second time, the app leaves it stopped and says **"The AI model stopped
unexpectedly again, so it was not restarted."** Starting it over and over would not help. Open the
**AI Model** screen and choose **Use this model** when you are ready. If it keeps crashing, close
other programs to free memory, or pick a smaller model.

---

## The AI Model screen says "Not responding"

The model is running but has stopped answering: it failed a quick check, or an answer on it waited
too long for the model. Choose **Restart** on its card. An answer being written at that moment ends,
and its text so far is kept.

The app never restarts it on its own, because a model that is just slow — a long document on a
computer without a graphics card — can look the same from outside. If **Not responding** comes back
often, close other programs, or pick a smaller model.

---

## "The AI model is starting. Try again in a moment."

A model start is under way. Before loading, the app checks the model's files — on a drive just
copied to another computer that can take a few minutes. Questions and document tasks wait for it:
send again once Chat shows the message box. Nothing needs to be started by hand.

---

## Importing a PDF didn't extract any text

Some PDFs are scanned images with no embedded text. The app detects this and marks the file
*"This PDF looks like a scan"* — use the row's **Make searchable (OCR)** action to read the
text locally (German + English; needs the drive's `ocr/` language files; runs a couple of
seconds per page). A PDF that mixes real text pages with scanned pages indexes its text pages
right away, and its row says how many pages are scanned without readable text yet; **Make
searchable (OCR)** in the row's **⋯** menu reads just those pages. A PDF added before the app
could do this shows its scanned pages after one **Re-index**.

A scan attached in a **chat** fails the same way, and the chat offers **Go to Documents**: run
**Make searchable (OCR)** on its row there, and the file joins that chat by itself — no need to
attach it again. **Back to chat** at the top of Documents returns you to the conversation. Such
a row has no **Try again**: it would read the same pictures and fail again.

If the row says *"…needs the OCR files, which are not on this drive"*, the drive has no OCR
language files yet (commercially-built drives already include them). Use the row's **Download
OCR files** button (or *"Text recognition for scans and photos (optional)"* on the **AI Model**
screen): confirm the files (German, English and the page-orientation data, about 8.6 MB), and once they are downloaded and
checked, text recognition starts **without a restart** — the row then offers **Make searchable
(OCR)**. A photo that failed for the same reason reads with **Try again** afterwards. The download
follows the usual gates: if the button is greyed out, the drive policy or **Settings → Allow
internet access for downloads and updates** is blocking downloads, and the row says which.

Without internet (or on a drive you set up yourself), add the files instead by re-running
`prepare-drive --with-assets`, or fetch only the OCR family with `fetch-runtime --family ocr`
(`.ps1 -Family ocr` on Windows) — see [`packaging.md`](packaging.md). **Files added this way
while the app is running are noticed at the next start** — restart the app after adding them.
A drive set up with an older version of the app is fine: when the drive's OCR download list
(`model-manifests/runtime-sources.yaml`) lacks a file this version uses, or names another
version of it, the app takes that file from its own list (it checks every file against checksums
built into it). If the row still names only this setup route and offers no download button,
neither list carries the right files, which points to a damaged app folder. Copy this version of
HilbertRaum onto the drive again, or refresh the drive's list with `prepare-drive` from the
matching release and then use the script route (the script reads the drive's list, so on its own
it fetches only what that older list names).

---

## OCR text is nonsense, or the row says "Text recognition was unsure"

Text recognition reports how sure it was of each page. When it was unsure of some, the
document's row says so and its **Preview** names the usual causes:

- **The page is sideways or upside down.** The app turns such pages upright by itself when the
  drive has the page-orientation data (`ocr/osd.traineddata.gz`). On a drive with only the
  German and English files, the **AI Model** screen offers it as *"Turning sideways scans upright
  needs one more OCR file"*; download it, then use **Read again (OCR)**. For a very faint or nearly
  empty page the check cannot decide; turn the page in a PDF viewer until the text reads normally,
  save, add the saved copy, and run **Make searchable (OCR)** on it.
- **The original is blurry, skewed or handwritten.** Scan it again at a higher resolution (300
  DPI is a good default) and add the new scan; handwriting is read poorly in general.
- **The text is in another language.** Only German and English are included; other languages,
  and especially other scripts, read poorly or not at all.

**Read again (OCR)** reads the pages again with what is on the drive now; it helps after you added
the orientation data, not on an unchanged blurry scan.

---

## A document failed to import

Open **Documents** to see the per-file error. Common causes: an unsupported file type, a
corrupted file, or a password-protected document. Supported types: txt, md, pdf, docx,
csv/tsv, audio recordings (wav, mp3, flac, ogg — needs the speech model), and photos of
pages (png, jpg, jpeg — needs the OCR files). Other files in the same import still succeed.

### "On Windows, the voice engine cannot open the transcription model because a folder or file name in the model’s path contains …"

A folder or the file name in the path of the speech model or its voice-activity model (its
`local_path` below `models/`) has an umlaut, an accent or another non-ASCII character, which the
pinned voice engine cannot read on Windows (#869). The models that come with the app are stored
under plain ASCII paths, so this only happens with a model you added through your own manifest.
Move the model file to a path of plain letters, digits, `-`, `_` and `.` below `models/`, change
its `local_path` in the manifest to match, then re-index the recording (or dictate again). The app's own folders may have any name (for example app data under
`C:\Users\Jürgen\AppData\Roaming\HilbertRaum`), and so may your recordings: a recording whose
name the voice engine cannot read is copied into the workspace for the transcription and shredded
right after.

---

## The app won't start from the drive

- Use the **launcher** at the drive root (`Start HilbertRaum`) rather than opening the
  `.exe`/`.app` directly — the launcher points the app at the drive's workspace.
- If you saw a security warning, follow **"Windows protected your PC" / "macOS cannot open the app"**
  above.
- On Linux, see **"Linux: the AppImage does not start"** above.
- On Windows, the portable `.exe` may take a few seconds on first launch — wait for the window.
- On macOS, the launcher unpacks the app once from the drive's `.app.zip` into
  `~/Library/Caches/HilbertRaum/` on this Mac (a folder named after the zip) and starts it from
  there; your workspace stays on the drive. If it says **"found no .app inside it"** or that the
  app inside it **"lacks its program file"**, the zip on the drive is damaged: copy it to the drive
  again. If it says the app unpacked earlier **"is incomplete"**, delete the folder it names (in
  Finder: **Go → Go to Folder…**, paste the path); the next start unpacks a fresh copy. If it
  says **"An earlier unpack at … could not be removed"**, delete the folder it names the same way
  (macOS asks for an administrator password when a start with `sudo` made it), then start again.
  If it says **"Could not create …"**, free space on this Mac's disk, or check that you can write
  to `~/Library/Caches/HilbertRaum/` (or the folder that holds it), then start again.
  A launcher that stops with **"Could not unpack …"** after a long wait has often run out of
  disk space too: free space first.
  Double-clicked the launcher again while it was unpacking?
  Both windows unpack, and the app opens once. An older launcher could leave an incomplete copy
  when that happened: if the app quits right away every time on this Mac, delete the folder named
  after the zip in `~/Library/Caches/HilbertRaum/` the same way.
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
--check`). It prints the drive root, the folder of model descriptions the app will read
(`model-manifests` on the drive), and the app it resolved, then "Nothing was started".

---

## A skill I dropped into the drive isn't doing anything

A skill you add yourself — by copying a folder into the drive's `user-skills/` — **installs switched
off** on purpose, so nothing a file added can run without your say-so. Open **Skills** in the sidebar,
find it in the list, and turn it **on**. (Built-in skills are on already.) If it isn't listed at all,
check that the folder contains a `SKILL.md` file at its top level, then close HilbertRaum and start it
again. The app looks for new skill folders only once each time it starts (soon after you unlock), so
a folder you copy in after that shows up only after a restart.

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
- **The redaction stopped and saved nothing.** If the AI model stops while it checks the document (it
  crashed, stopped responding, or ran into an error), the run says "The AI model stopped before the
  redaction was finished. Nothing was saved." Run it again; if the model is still restarting, the app
  says "The AI model is starting" until it is back. If it keeps happening, restart the model on **AI
  Model**. "Parts of this document are too long for the current model's context window" is rare: the app
  already reads long paragraphs in smaller pieces, and this means even a piece did not fit. Choose a
  larger **context size** on **AI Model**, restart the model, and run the redaction again.
- **A redaction or an edit of a long document takes a while.** The model reads the document in windows
  sized to its context and answers each one in full; on a computer without a graphics card, a long
  document of dense paragraphs can take several minutes. The run bar counts the windows as it goes.
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
drive"* card, choose **Go to AI Model**: it opens the AI Model screen on the vision model. Download
it there — it's an optional download, like the larger chat models, so internet access must be
enabled in Settings (see the User Guide §5). There is nothing to start afterwards: the vision model
has no **Use** button, and its row says the Images screen picks its vision model automatically.
This is **not** OCR: for a scanned PDF or a document you want to search, use the document's
**Make searchable (OCR)** action instead (above).

If you drop a PDF on the Images screen, it says *"This screen reads one picture, not a PDF"* and
offers **Go to Documents**. Add the PDF there; if it is a scan, use **Make searchable (OCR)** on
its row.

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
| **503 "model_not_loaded"** | No model is running — also the answer when you stop the model in HilbertRaum while the app is waiting. | Open HilbertRaum and start a model on the **AI Model** screen. |
| **503 "model_starting"** | A model is loading right now, or HilbertRaum is still checking its files before loading — also the answer when you switch models in HilbertRaum while the app is waiting. | Wait and retry; the response says roughly how long. |
| **502** | The model did not answer. | Check the app — the model may have crashed; the Diagnostics tab has details. |

### An app's request stopped halfway

If you used HilbertRaum yourself while an outside app was generating, that is expected: your own
turn always wins, and the app's request is cut short with a "retry" answer. The card tells you it
just happened. The app can simply ask again.

The same happens when you stop or switch the AI model in HilbertRaum while an outside app is
generating: its answer ends with "model_not_loaded" (stopped) or "model_starting" (a new model is
loading — retry shortly).

---

## Knowledge packs (ZIM archives)

### The panel says kiwix-tools are missing

Knowledge packs are served by two small programs from the Kiwix project, kiwix-serve and
kiwix-manage. The Knowledge packs panel (and a mirror row on the AI Model screen) offers to
install them for you: a dialog states the download size, the GPL-3.0-or-later license and the
source (`download.kiwix.org`), and asks you to accept the license before it fetches and
SHA-256-verifies the pinned kiwix-tools 3.8.1 release for your platform. That install needs
**Settings → Allow internet access for downloads and updates** to be on (it is on by
default) and a drive policy that permits downloads.

**Without the in-app path (a scripted or Linux/macOS drive): run the fetch script.** From the
repository, against the drive:

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

### "kiwix-manage cannot read this archive because its file name or folder contains …"

On Windows the pinned kiwix-manage cannot open an archive whose file name contains an umlaut, an
accent or any other non-ASCII character (for example `Wiki für Kinder.zim`), nor one in such a
folder outside the app's own (for example `C:\Users\Jörg\Downloads` when the app runs from a Kit
on `D:\`). Copy the file into the drive's own `zim/` folder under a name without such characters,
and add it again (or press **Refresh**). The drive's own folders are fine whatever their name (for
example app data under `C:\Users\Jürgen\AppData\Roaming\HilbertRaum`), and so are other folders of
that same account. Once registered, the pack works normally; only the add step is affected.

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
  rest, same as your data) — local logs only; never uploaded. When you copy or save the log for
  support (**Settings → Diagnostics (advanced) → Recent logs**, **Copy** or **Save to file…**),
  the drive and your home folder show as `<drive>` and `<home>`, this computer's account name as
  `<user>` wherever it appears, and account names in the usual folder paths from another computer
  as `<user>` too. The rest of each path stays, so support can still see which file failed
  (`<drive>\runtime\llama.cpp\win\llama-server.exe`). A name in an unusual place can remain, for
  example in a folder you named yourself, so read a log before you share it. The log on the drive
  keeps the full paths.
- `models/` — model weights. `config/` — drive settings/policy, and `workspace.json`, which holds
  your encrypted workspace's key (encrypted under your password): it belongs with `workspace/`.

See [`drive-layout.md`](drive-layout.md) for the full layout.
