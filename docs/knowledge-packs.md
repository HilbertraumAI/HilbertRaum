# Knowledge packs — an offline Wikipedia inside HilbertRaum

HilbertRaum can answer from **ZIM archives**: compressed, self-contained offline copies of
reference sites. The [Kiwix](https://kiwix.org) project publishes thousands of them —
Wikipedia in about a hundred languages, plus Wiktionary, Wikivoyage, Stack Exchange,
Project Gutenberg and more — at [`library.kiwix.org`](https://library.kiwix.org). Download
one once, and the model can search and cite it forever, with no network.

A pack behaves like a source, not like a bigger model: the app searches the archive, hands the
model the passages it found, and the answer cites the articles it used. You can open any cited
article and read it, offline, in the app.

> **One sentence for the impatient:** put a `.zim` file in the drive's `zim/` folder, tick it
> under *Knowledge packs* in a chat's sources picker, and ask.

**Audience.** §1–§5 are for anyone using the app; §6 is the privacy and security posture;
§7 collects the edges worth knowing before you plan a drive; §8 points maintainers at the
design records. The step-by-step walkthrough with screenshots-in-words lives in the
[user guide](user-guide.md#7b-knowledge-packs--ask-an-offline-wikipedia) — this page is the
overview you can link to from outside the repo.

## Table of contents

- [§1 Why an offline encyclopedia](#1-why-an-offline-encyclopedia)
- [§2 Getting packs](#2-getting-packs)
- [§3 One-time setup: the kiwix-tools](#3-one-time-setup-the-kiwix-tools)
- [§4 Adding packs](#4-adding-packs)
- [§5 Asking](#5-asking)
- [§6 Privacy and security](#6-privacy-and-security)
- [§7 Edges worth knowing](#7-edges-worth-knowing)
- [§8 For maintainers](#8-for-maintainers)

## 1. Why an offline encyclopedia

A local model knows a lot and remembers it imperfectly. Documents you import are yours, but
they only cover what you happen to have. A knowledge pack closes the gap in the direction the
rest of HilbertRaum already points: general knowledge that is **on your drive**, searched
**on your machine**, quoted **with a citation you can open**. Nothing about it needs the
internet after the download, which makes it the piece that turns a laptop with no connection —
a field site, a flight, an air-gapped room, a place where the network is not trustworthy —
into a workspace that can still answer a general question and show its source.

It is also the honest answer to a local model's weakest habit. An answer built from a pack's
passages is grounded in text you can read, so a claim it makes is checkable in one click
instead of taken on faith.

## 2. Getting packs

Browse [`library.kiwix.org`](https://library.kiwix.org), pick a file, download it, and put it
on the drive. Nothing else registers it with anyone; the file is the whole product.

Sizes vary enormously, and this is the number to plan a drive around: a "no pictures" Simple
English Wikipedia is a few hundred megabytes, a full-text language Wikipedia without images is
a few to some tens of gigabytes, and full English Wikipedia with images runs to roughly a
hundred. The library lists the exact size of every file, and the Wikipedia titles come in `nopic`
(no images) and `mini` (lead sections only) variants — for a portable drive those are usually
the right trade.

Two things to check while you pick:

- **Take a single-file `.zim`.** Multipart archives (`.zimaa`, `.zimab`, …) are not read by
  this app.
- **Prefer a build with a full-text index.** Most library files have one. A pack without one
  can still be read article by article, but the app cannot search it, and it will show a
  **No full-text index** badge and stay unavailable in the sources picker.

## 3. One-time setup: the kiwix-tools

Packs are served by two small programs from the Kiwix project, `kiwix-serve` and `kiwix-manage`.
They are **not** bundled: they are GPL-3.0-or-later, and shipping them carries obligations the
app takes seriously (see the licensing section of the [README](../README.md#license)).

The first time you need them, the **Knowledge packs** panel offers to install them — a dialog
states the download size, the license and the source (`download.kiwix.org`), and asks you to
accept the license before it fetches and SHA-256-verifies the pinned kiwix-tools 3.8.1 build
for your platform. A mirror of that offer sits on the **AI Model** screen. The install needs
**Settings → Allow internet access for model downloads and updates** to be on (it is on by
default) and a drive policy that permits downloads.

From the repository you can provision them up front instead, without the app:

```powershell
# Windows
.\scripts\fetch-runtime.ps1 -Target E:\ -Family kiwix_tools
```
```bash
# macOS / Linux
scripts/fetch-runtime.sh --target /Volumes/HILBERTRAUM --family kiwix_tools
```

Both paths write an install marker that hashes every file, so the binaries are verified before
every spawn. Unzipping the release under `runtime/kiwix-tools/<os>/` by hand still works as a
last resort, but leaves no marker and no integrity check. If the panel says the tools are
missing, [`troubleshooting.md`](troubleshooting.md#the-panel-says-kiwix-tools-are-missing) has
the full recovery path.

## 4. Adding packs

- **The simple way:** copy `.zim` files into the drive's `zim/` folder. They are found when you
  unlock, and on **Refresh** under *Documents → Knowledge packs*.
- **From anywhere else:** *Documents → Knowledge packs → Add packs…*.

Files are **used in place** — nothing is copied, nothing is re-encoded, and a pack is never
written to. Removing a pack's registration forgets it; the file itself is never deleted.

On Windows, add packs from a path made of ASCII characters only: the pinned `kiwix-manage`
refuses a file whose folder or name contains an umlaut or an accent. The drive's own `zim/`
folder always works. See [§7](#7-edges-worth-knowing).

## 5. Asking

Packs are **per chat and off by default**. In a documents chat, open the sources picker
("Answering from…") and tick the packs you want under *Knowledge packs*; up to 12 in one chat.

- **Answer from packs alone** by unticking **Search my documents** at the top of the picker.
  Files you attached directly to that chat are still used either way.
- **Read the source:** answers cite pack articles the way they cite documents, and *Open
  article* shows the article text offline — including from an evidence review's archive row.
- **See what each pack did:** a "Knowledge packs:" line under the answer names every ticked
  pack — searched (and how much it contributed), or not searched, with a short reason.
- **A pack you cannot tick always says why** — file missing, a different archive at that
  location, disabled, or no full-text index.

Whole-document reads and document comparisons never consult knowledge packs; the answer says
so. Packs are a retrieval source, not a second brain bolted onto every feature.

## 6. Privacy and security

Everything stays on this computer. The pack server binds to `127.0.0.1` only, asking never
leaves the machine, and registering a pack tells nobody anything. The app's whole network
footprint is unchanged by this feature except for the tools download itself: The only things
the app ever downloads are AI models, the AI engine and the optional knowledge-pack tools —
each one only after you confirm it, each one verified before use.

One limit belongs in plain sight rather than in a footnote, because it is the single place
where knowledge packs are weaker than the rest of the workspace: While the workspace is
unlocked and a knowledge pack has been used in a chat, other programs running under your own
user account on this computer can read the enabled packs through the pack server, which has no
password of its own; locking or quitting stops it.

That is accepted residual **R-9**. The reasoning — why `kiwix-serve` is the one sidecar without
the per-spawn key every other one carries, and what contains it — is recorded in
[`security-model.md`](security-model.md) under "kiwix-serve — the one unauthenticated sidecar",
and mirrored in [`PRIVACY.md`](../PRIVACY.md) and
[`known-limitations.md`](known-limitations.md).

## 7. Edges worth knowing

Every one of these is a measured, recorded limit rather than a rough edge we have not looked
at; [`known-limitations.md`](known-limitations.md) carries the full entry for each.

| Edge | What it means for you |
|---|---|
| **Multipart archives (R-2)** | A `.zim` split into `.zimaa`/`.zimab`/… parts is not read. Take the single-file build. |
| **Windows, non-ASCII paths** | The pinned `kiwix-manage` refuses a path containing an umlaut or accent. Keep packs in the drive's `zim/` folder. Serving is unaffected once registered. |
| **Windows, large articles** | The pinned `kiwix-serve` occasionally cuts a read of an article over ~80 KB short. An upstream defect, reported upstream, mitigated in the app. |
| **No full-text index** | Such a pack is skipped when searching but still readable via *Open article*. The badge appears on its own, shortly after you add or enable the pack. |
| **Two files with the same name** | Two archives whose file names differ only by folder cannot both be served; the panel marks the later one "Not served" and names the winner. Rename one. |
| **Redirects** | A redirect entry opens its target within the same pack, one hop. A chain, or a hop to another pack, shows an honest "article unavailable" instead of the wrong text. |
| **12 packs per chat** | A hard cap. Packs over it are listed as not searched, with that as the reason. |

## 8. For maintainers

| Where | What it holds |
|---|---|
| [`rag-design.md`](rag-design.md) §17 | The design record: session and lock model, retrieval arms, identity and discovery, the honesty rules behind the "Knowledge packs:" line, the real-tools acceptance findings |
| [`security-model.md`](security-model.md) | The `kiwix-serve` access boundary and residual R-9 |
| [`architecture.md`](architecture.md) | The `kiwix_tools` runtime family and how it differs from `llama_cpp` / `whisper_cpp` |
| [`drive-layout.md`](drive-layout.md) | Where `zim/` and `runtime/kiwix-tools/` live on the drive |
| [`packaging.md`](packaging.md) | Provisioning the tools onto a drive, and the source-bundle rule a shipping Kit must satisfy |
| [`data-contracts.md`](data-contracts.md) | The IPC surface and persisted shapes |
| [`user-guide.md`](user-guide.md#7b-knowledge-packs--ask-an-offline-wikipedia) | The end-user walkthrough |
