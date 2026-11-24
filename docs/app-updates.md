# App updates — design record

_The planned design of HilbertRaum's in-app update: a signed update file that the user imports
offline, staged on the drive, applied after a clean quit, confirmed at the new version's first start,
with an automatic fallback. **This is an open design record on the integration branch
`feat/app-updates`: each phase of the update wave fills in its sections, and the wave's closing phase
removes this sentence before the record reaches `master`.** The section numbers §1–§12 are stable:
code comments cite them as `app-updates.md §N` (or `§N.M` for a numbered subsection), and §12 says how
to read every plan id the code and the other docs cite._

**Status words.** _Planned (Pn)_ = the decided contract; phase Pn builds it and rewrites the section
as built. _As built on master_ = merged code that release 1 freezes as it is. A section whose phase has
not run states the decided contract only; details the plan leaves to a later phase are not written
here.

**Words used here.**
- _Release 1_: the first release that carries the updater, and so the oldest version ever sold on a
  Kit. Whatever it runs during an update can never be fixed in the field.
- _The new version_: the version an update installs. _The old version_: the one on the drive before.
- _Kit_: the HilbertRaum AI Kit, the sold product. _Drive_: the storage medium, a Kit or a drive
  someone prepared themselves (a DIY drive).
- _Update file_: the signed file a user downloads and imports (extension `.hrupdate`).
- _Start files_: `Start HilbertRaum.cmd`, `Start HilbertRaum.command` and `start-hilbertraum.sh` at
  the drive root (the other docs and the code call them launchers). The user is told to
  "start HilbertRaum on the drive".
- _System_: Windows, macOS (Apple Silicon) or Linux.
- _Frozen_: it runs in release 1 and can never change on a sold Kit. _Replaceable_: every later
  update can replace it.

---

## 1. Scope, decisions, what release 1 freezes

### 1.1 The design in one paragraph

An update reaches a drive as one signed update file. The user picks it with "Install update from a
file…" in Settings → Updates, on the unlock screen, or in a failure message an update can fix. The
app checks the signature (Ed25519 over a DSSE envelope, §2) before it reads anything else, checks
the version and the drive's policy, and copies the listed files into `updates/` on the drive, each
one hashed while it is written (§4). "Restart and update" locks the workspace, quits cleanly and
hands over to an apply script that ships inside the update file and runs after the app has exited
(§5). The script replaces every app already on the drive in one step. The new version confirms its
own start; if it never starts properly, the start files bring the old version back by themselves,
and the old version says what happened. The new version then brings its drive content (model
definitions, skills, docs) with it and gets its AI engine afterwards, by download or from a file
(§6). Nothing is checked online in release 1: every update of a release-1 Kit is installed from a
file (§3).

### 1.2 Release 1 is the oldest sold version

There is a deploy stop: no release of any kind, and no sale, until the updater is ready. So the next
release is release 1, tagged on `master` after the integration branch merged (§9), and it carries
everything this wave builds: what the oldest Kit needs to take an update (the plan's tier M1), the
drive content and engine handling (M2) and the migration framework (M3). The online check is not part
of it (§3.1). Every Kit carries all three systems.

### 1.3 Owner decisions

Answered by the owner on 2026-11-17 (K2) and 2026-11-23 (the rest). §12 defines the ids.

| Call | Decision, in plain words | § |
|---|---|---|
| U1 | A later version may offer an update check the user clicks (the internet switch on, a click, a consent), never one at start. Release 1 has no check. The Kit builders write `updates.allow_online_check: true` | §3.1, §8.1 |
| U2 | No background or startup check | §11.4 |
| U3 | One update replaces every app already on the drive in one step; the AI engines are not part of that step | §5, §6.5 |
| U4 | Windows stays one portable `.exe` | §11.4 |
| U5 | The address a future online check uses is decided with that check, after release 1 | §11.2 |
| U6 | One release covers the app and the drive content under one signature and names the AI engine version; the engine follows separately on each system, unless a release deliberately carries it | §6.5 |
| U7 | An update that never starts properly falls back by itself. "Go back to version {n}" is offered within stated limits (§6.10) and never moves an engine | §5, §6.10 |
| U8 | Kits receive only releases published as stable ("Latest"), plus security fixes on their own line | §2.6, §9.6 |
| U9, U10, U11 | How buyers learn of updates, the support period, the risk assessment under the EU Cyber Resilience Act (CRA): answered after counsel | §11.1 |
| K1 | Each key is held by the owner, offline. The succession key's sealed file is held by a second custodian, its password elsewhere. Any one of the three keys signs alone, and no key can be withdrawn from a sold Kit | §2.1, §2.2 |
| K2 | Three keys: active, standby and succession | §2.1 |
| K3 | The rotation and compromise runbook is written before the key ceremony | §2.2 |
| K4 | Free builds carry the project's keys; a fork replaces them | §2.9 |
| K5 | A DSSE envelope with an Ed25519 signature, verified with the app's built-in crypto | §2.3 |
| M-D1 | v0.1.50, the first public release, is the oldest workspace a new version must upgrade | §7.5 |
| M-D2 | The workspace database's version number means "the oldest app that may open this" | §7.5 |
| M-D3, M-D4 | Snapshot retention and long migrations: asked in P10 | §7.8 |

### 1.4 Plan gates, decided

| Gate | Decision, in plain words | § |
|---|---|---|
| G-1, G-8 | This document is the design record, with legends for every plan id (§12) | §12 |
| G-2 | The whole wave lives on one integration branch, `feat/app-updates`, merged into `master` once | §9.1 |
| G-3 | App-owned model definitions and skills come from the app itself; the drive's copy is a mirror plus the user's own entries | §6.2 |
| G-4 | Tests trust a test-signed update only through throw-away builds with a one-time key; the product has no test entrance | §2.7, §10.4 |
| G-5 | The update file is a strict tar (ustar) subset that the app reads and writes itself, never the OS `tar` | §4 |
| G-6 | Linux is a full system: in-app update with the same protocol, the static AppImage runtime (no libfuse2) | §3.6, §10.6 |
| G-7 | Superseded by G-2: `master` never holds a half-merged updater | §9.1 |
| G-9 | Release 1 writes a last-writer stamp into the workspace database | §7.4 |
| G-12 | How the wave assigns its agents and models (process only) | — |
| G-13 | The support end date is written per Kit, once, into `config/kit-support.txt` | §8.4 |
| G-14 | The update policy keys, built the simple way: the Kit builders write the online-check key; a damaged `policy.json` never blocks the signed import | §8.1 |
| G-15 | Every Kit is sold for Windows, Apple Silicon macOS and Linux; the first sale waits for all three systems' hardware tests | §9.2 |
| G-16 | Security fixes for sold Kits come from a fix line per Kit release, `kit/<version>` | §9.6 |
| G-17 | The update address in frozen copy: a short project page first, the GitHub releases page second; the exact path is open | §3.3 |
| G-18 | Every frozen string is checked by machine back-translation in the eight languages the owner does not read; native readers are an open call | §11.1 |
| G-19 | The version rule: newer than the running version, and not below the drive's version | §2.5 |
| G-20 | Never asked (moot without an online check in release 1) | — |
| G-21 | No online check in release 1 and not in this wave; it is built for the first update after release 1 | §3.1 |
| G-22 | Release 1 accepts the channel `stable` only; only Kit releases are signed for now | §2.6 |
| G-23 | Release 1 carries everything the plan lists; nothing is cut | §1.2 |
| G-24 | An update can carry a minimum OS version per system, Linux included as a glibc floor; release 1 refuses below it before staging, and a release that raises a floor is not offered to the Kit channel while a supported Kit stated a lower one at sale | §2.4, §9.3 |
| G-26 | The system requirements printed with a Kit: Windows 11, or a Mac with Apple Silicon on a macOS version Apple still supports, at least 8 GB of memory, and Linux with the distribution floors of `READ ME FIRST.txt`; no Windows 10 | §11.5 |
| G-27 | Update files stay under GitHub's 2 GiB asset limit; a larger one is hosted on the mirror | §9.4 |
| G-28 | Code signing of the AI engines for Windows Kits: deferred by the owner | §6.8, §11.1 |
| G-29 | The age reminder shows 6 months after the build date; a dismissal hides it for 6 months; on Home and in Settings → Updates | §8.4 |
| G-30 | New models reach a Kit with each content-changing app release; release 1 gives any other signed HilbertRaum file a typed "for a newer HilbertRaum" answer | §2.4, §6.4 |
| G-31 | AI engines are not in the update file: the new version downloads its engine, or installs it from a file, after the update; one release may still carry engines (the escape hatch) | §6.5 |
| G-32 | The new engine goes into a folder of its own beside release 1's, which is never moved while "Go back" is offered | §6.6 |
| G-33 | The Kit carries both small chat models, so an offline first screen recommends a model on the drive (a manifest change outside this wave) | §11.5 |
| G-34 | Release 1 never redoes a newer extractor's rows; it serves them as they are with a one-line note | §7.6 |
| G-35 | A release offered to release-1 Kits never requires an engine newer than the oldest pin such a Kit may run | §6.6 |
| G-36 | Kit buyers are offered one update file, for all systems; the apply installs only the systems already on the drive | §9.4 |
| G-37 | Each update notice is one in-context banner at a time, with its help text in the app and a muted reference code | §5 |
| G-38 | Five buyers try the update path in moderated sessions before the copy freezes | §10.5 |
| G-39 | The restart dialog states a duration measured on the Kit's media before the copy freezes; without the measurement it says "This can take a few minutes" | §5 |
| G-40 | Release 1 is tagged on `master` after the final merge of the integration branch | §9.2 |
| G-41 | Green CI is required on the integration branch and, later, on `kit/*`, by the existing ruleset | §9.1 |
| G-42 | `master`'s `BUILD_STATE.md` points at the integration branch until the final merge | §9.1 |
| G-43 | Two vault start-path fixes before release 1 (a start whose swap fails still serves the update path; the rekey journal acts only inside the workspace) and one documented residual | §7.3 |
| G-44 | The pre-spawn engine check covers every recorded file before release 1; starting an engine in place on a write-protected drive is a documented residual | §6.7 |
| G-45 | The upgrade acceptance runs in two stages on the project's used exFAT test drive | §10.5 |

G-10, G-11 and G-25 are decided in their phases (§11.2).

### 1.5 The frozen-forever rule

Whatever release 1 executes during an update, or when it later meets files a newer version wrote,
can never be fixed on a Kit that is not updated. So every frozen contract below gets:
- a golden contract test whose expected values live in data fixtures with an origin other than the
  code under test, locked by a committed sha256 manifest that `repo-hygiene.test.ts` checks (§10.2);
- two independent reviews, each with its own lens;
- after release 1 ships, an owner call for any change to its test's assertions or vectors.

The table lists the contract ids (F-n) that the code and the docs cite.

### 1.6 Frozen contracts

| F | Contract, in one line | § | Owning phase | Status |
|---|---|---|---|---|
| F-1 | Envelope verification: DSSE PAE, Ed25519, standard and URL-safe base64; size and signature caps whose excess is "too new", never "not genuine"; the typed unknown-signer answer | §2.3 | P4 | planned |
| F-2 | Payload forward compatibility: unknown fields ignored, a new `format` major refused, `files[]` lists every member, the optional `group`, `install_as`, `requires`, `summary` and `min_upgrade_from`, `channel: "stable"` only, other HilbertRaum payload types answered "for a newer HilbertRaum" | §2.4, §2.6 | P4 | planned |
| F-3 | The embedded public keys (`keys.json`) | §2.7 | P4; the owner's key ceremony | planned |
| F-4 | The version rule | §2.5 | P4 | planned |
| F-5 | The `updates/` layout and staging: one commit marker, at most one staged update, no import while an update is in progress | §4 | P6 | planned |
| F-6 | The hand-off from the app to the apply script after a clean lock | §5 | P7 | planned |
| F-7 | The rules of release 1's start files: resume an interrupted apply, restore from `updates/previous/`, refuse two apps, the launch counter | §5 | P7 | planned |
| F-8 | Policy key names, and what an absent key, a junk value and a missing or damaged `policy.json` mean (the install half) | §8.1 | P3 | planned |
| F-9 | The vault-format guard: a descriptor, journal, frame or working copy from a newer version reads as "newer", never as damage, and nothing is written | §7.2 | P2 | as built on master |
| F-10 | The `schema_meta` table's shape, the `last_writer` stamp, and the keys the migration framework writes | §7.4 | P2, P10 | planned |
| F-11 | The `update.log` line grammar, content-free | §8.2 | P3 | planned |
| F-12 | The support-end and age-reminder computation and its inputs | §8.4 | P6 | planned |
| F-13 | The `drive-release.json` read contract and the write-once `config/kit-support.txt` | §8.5, §8.4 | P3 | planned |
| F-14 | The update channels callable while the workspace is locked, also after a failed start | §3.5 (the hand-off channel: §5) | P6, P7 | planned |
| F-15 | Released migration step ids and their source hashes | §7.8 | P10 | planned |
| F-16 | The update file container: the ustar subset read in process, the reserved `HRUPDATE` prefix | §4 | P1 (table), P6 (reader), P5 (writer) | planned |
| F-17 | The online check's request contract | §3.1 | P9, after release 1 | not in release 1 |
| F-18 | The member-name rule, and the root-artifact globs release 1 reads | §4 | P6 | planned |
| F-19 | What release 1 offers at a start when an update is staged or in progress, and the older-than-drive notice | §5 | P7 | planned |
| F-20 | `updates/last-result.txt`, the outcome codes and the old version's notices | §5 | P7 | planned |
| F-21 | The refusal on a root that is not a prepared drive, and the two drive-awareness fixes | §3.6 | P6 | planned (the Linux `APPIMAGE` lookup is on master) |
| F-22 | `updates/unconfirmed.txt` and the start confirmation | §5 | P7 | planned |
| F-23 | The model-manifest old-reader contract | §6.11 | P2 (goldens, reviews) | as built on master |
| F-24 | The AI engine contract: pins, install marker, version relation, release 1's own staged swap | §6.7, §6.11 | P2 (goldens, reviews) | as built on master |
| F-25 | The skills contract | §6.11 | P2 (goldens, reviews) | as built on master |
| F-26 | Persisted message values | §7.6 | P2 | planned |
| F-27 | Duties of every later writer of workspace data | §7.7 | P2 | planned |

---

## 2. Trust

_Status: planned (P4). The production keys come from the owner's key ceremony (§2.2)._

### 2.1 Three keys, any one signs alone

Release 1 embeds three Ed25519 public keys (K2):
- **active**: signs every routine release, alone;
- **standby**: takes over when the active key is lost or compromised;
- **succession**: a cold key generated at the same ceremony, kept by a different custodian, never used
  for a routine release.

A release-1 Kit accepts a signature from **any one** of its three keys and has **no way to withdraw a
key** (K1). Each key alone is therefore trusted for the Kit's whole support period. Dropping a stolen
key in a later release protects only the Kits that install that release; offline custody is the whole
defense.

### 2.2 Custody and the runbook

- Each private key is a password-protected key file on separate offline media with sealed backups,
  held by the owner; never on GitHub, never in CI (K1).
- The succession key's sealed file is held by a second custodian (a notary, a bank box or counsel); its
  password is kept elsewhere and named in the succession file, so nobody but the owner signs alone.
- The rotation and compromise runbook is written before the ceremony (K3). It says when the
  succession key may sign and who may ask its custodian for it. No private key is destroyed while a
  supported release embeds its public half. A key an attacker already used can sign a release that
  embeds any keys, so speed and offline custody are the defense, not a second signature for key
  changes.
- Agents never generate, hold or use a signing key (§9.8).

### 2.3 The envelope: DSSE with Ed25519

The update file carries one signed envelope (K5), verified with `node:crypto` (Electron 43.8.10 has
Ed25519 and no BLAKE2b, so minisign's default format is out):
- the DSSE pre-authentication encoding (PAE), with standard **and** URL-safe base64, as the DSSE
  specification requires;
- caps checked before the envelope is parsed: the envelope at most 4 MiB (4,194,304 bytes), at most 64
  signatures. A file over a cap gets the typed answer "too new for this version" (`UpdateTooNew`) with
  the update address, never "not genuine". The caps are generous on purpose: a ten-year-old reader meets
  envelopes with more languages and keys. The envelope is the update file's member 0,
  `hilbertraum-release.dsse.json`; the file's other caps (at most 4,096 members, each under 8 GiB, the
  member names) are table A's (§4.3, §4.4);
- the signature is verified before the payload is parsed; a signature's `keyid` is only a hint, the
  embedded key bytes decide;
- signed only by keys release 1 does not know → the typed answer `UnknownSigner`: "signed with a newer
  key: install the in-between update first", with the update address and the manual replacement, for
  the case where none of release 1's keys signs any more. It is never "not genuine";
- no trust on first use and no key a user adds.

The release `payloadType` string and the envelope's place in the update file are part of the
container (§4).

### 2.4 The payload

The signed payload is forward compatible (F-2):
- unknown fields are ignored; a new `format` major version is refused with `UpdateTooNew` and the hint
  to install the in-between update first;
- `files[]` (name, size, sha256, role) lists **every** member of the update file except the envelope,
  the apply scripts and the start files included. Every listed file is staged as it is, whatever its
  role; nothing is refused for a system the drive carries but the payload lacks (the apply script
  decides, §5);
- `group` (optional): a label for members staged all or nothing; a member without one is required.
  Release 1 never interprets the label, so one payload serves the full update file and per-system
  files;
- `install_as` (optional): the name a member gets at the drive root. Member names must be fetchable as
  GitHub asset names (§4), so `Start HilbertRaum.cmd`, whose name has a space, travels under a plain
  member name and carries its root name here. Release 1 ignores the field; the apply script and the sell
  gate use it;
- `product` and `channel` are checked (§2.6); `min_upgrade_from` above the running version is a typed
  refusal, never "not genuine";
- `issued`: advisory clock checks only. A date in the future gives a warning; a file whose `issued` is
  more than 12 months before this computer's date needs one explicit confirmation that a newer one may
  exist;
- `requires` (optional): a minimum OS version per system (G-24). `win32` and `darwin` hold a dotted
  version compared component by component with `process.getSystemVersion()`. `linux` holds a minimum
  glibc version compared with this computer's runtime glibc; **the field is settled by spike 4a:
  `<pending T1.6>`**. Unknown keys and systems are ignored. Release 1 refuses **before staging** when
  this computer is below its own system's floor, and shows the drive's other systems' floors as a
  one-line warning it cannot test;
- `summary` (optional): a map from a UI language code to one or two plain sentences of at most 400
  characters, shown at the import in the UI language, else in `en`, else not at all. A wrong type, an
  unknown language or a longer value is ignored, never an error;
- a well-formed envelope from a known key whose `payloadType` is any other
  `application/vnd.hilbertraum.*` type, or whose payload `kind` is not the release kind, gets the typed
  answer "This file is for a newer HilbertRaum. Install the update first" (G-30), never "not a
  HilbertRaum update". A later definitions-only or model-pack file then needs no in-between update.

Every answer that refuses a well-formed update file (`UpdateTooNew`, `min_upgrade_from`,
`UnknownSigner`, the OS floor) shows the running version and the address
`<G17-ADDRESS>/from/<running version>`, also as plain text (§3.3).

### 2.5 The version rule

An update installs when (G-19 (b), F-4):
- its version is **newer than the running version**, and
- its version is **not below the drive's `app_version`** (`config/drive-release.json`, §8.5).

`app_version` counts only when some root entry carries that version in its name
(`HilbertRaum-<app_version>-…` or `HilbertRaum-<app_version>.…`) or a root `*.app` exists (whose
version is unknown). Otherwise it is stale, logged and treated as absent. The "not below" lets a
lagging system install the version the drive already has and makes a re-install after "Go back"
work; a downgrade below the drive is still refused. Release 1 does not act on `highest_version_seen`
(a reserved field, §8.5): a hard floor there would refuse every security fix of the fix line to a
user who went back. A looser rule can be tightened by any later version; a tighter one could never
be loosened. The accepted risk: an old but genuine update file can move a Kit up to an outdated
version, never down.

### 2.6 The channel

- **Frozen:** release 1 accepts `channel: "stable"` only. Any other value gets the typed refusal "not
  a release for this drive" (G-22).
- **Reversible:** which releases the owner signs. Only Kit releases get an envelope now; signing more
  later stays possible. DIY users get in-app updates from stable releases like Kits; DIY pre-releases
  stay manual.
- Kits receive only releases published as stable ("Latest"), plus security fixes on their own line
  (U8, §9.6).

### 2.7 The keys inside a build

- The public keys live in a JSON file in the source, `keys.json`, which the app embeds and the release
  tools read (F-3).
- The production keys enter the repository only from the owner's ceremony, through a pull request on
  `master` after the integration branch merged (one of release 1's release pull requests, §9.2). Until
  then the production key set is empty. A build with an empty set says that updates are not available
  in this build; only walk and dispatch builds before the ceremony can have one, and no Kit is ever
  built with it (the sell gate and the pre-publish check refuse an empty set).
- **The release guard**, on every build leg of `release.yml` (Windows, macOS, Linux) and on its
  dispatch pre-flight: the public keys embedded in the packed `app.asar` (their SPKI bytes, not only
  their ids) equal the committed key set.
- **No test entrance in the product** (G-4 (d)): tests that need a test-signed update build throw-away
  copies with a one-time test key written into their `keys.json` (§10.4). Test key pairs are generated
  at test time; committed test vectors hold public keys, envelopes and verdicts only, never a private
  key.

### 2.8 The key proof before release 1 is published

After release 1's build and before it is published, the owner signs one throw-away update file per
embedded key, each for a version below every build that embeds the production keys
(`0.0.0-keyproof.<n>`). The exact release-1 candidate binary must refuse each with the "same or older"
answer, which it reaches only after the signature verified. The proof runs on each sold system's draft
asset whose sha256 equals the signed payload's entry (the signed `.exe` for a Windows Kit). The
throw-away files are never uploaded, and immutable releases are on before the publish click, so the
published asset is the one tested.

### 2.9 The fork rule

- Builds from this repository, free DIY builds included, carry the project's public keys (K4). They
  accept the project's signed update files and offer the same "Install update from a file…" as a Kit.
  There is one program and one support story.
- **A fork that publishes its own builds** replaces `keys.json` with its own public keys (its builds
  then accept only the fork's signed releases), or ships an empty key set, which turns the in-app
  update off. A fork must already use its own name and logo ([`TRADEMARKS.md`](../TRADEMARKS.md)).
- **A fork that keeps the project's keys** accepts every update file the project signs. Installing one
  replaces the fork's app on the drive with the project's own HilbertRaum build.
- A fork that replaced the keys and imports one of the project's update files sees the
  "signed with a newer key" answer, which is misleading for it; the fork's own documentation should
  say so.

---

## 3. Finding and importing an update

_Status: planned (P6; the hand-off channel P7). The entry points and the locked channels are frozen._

### 3.1 No online check in release 1

Release 1 makes no network request for updates (G-21 (b')). Every update of a release-1 Kit is
installed from a file. A check the user clicks (U1 (b)) is built after release 1, for the first update,
on its own branch; its request contract (F-17) is not frozen in release 1. Release 1 keeps the policy
key that a later version's check will obey (`updates.allow_online_check`, §8.1). `PRIVACY.md`'s
statement that the app makes no update checks stays true for release 1.

### 3.2 How people learn of an update

- **A Kit buyer**: the owner's buyer notice by email, for each release that matters to Kits; a GitHub
  Security Advisory for a security release; a registration route for buyers who did not buy direct;
  in the app, the offline age reminder and, at the end, the end-of-support notice (§8.4).
- **A DIY user**: the GitHub releases page and the age reminder (no support date: a DIY drive has no
  `config/kit-support.txt`).
- **An administrator**: the advisory and the admin section of the user guide (how to block updates,
  how to update a blocked fleet, `updates.max_version`, allow-listing the update helper).
- **The download**: one update file for all systems, from the release page or the project page
  (§9.4). The buyer notice links the per-version page `<G17-ADDRESS>/update/<version>`, never a raw
  asset, so an old email can never serve a withdrawn file.

### 3.3 The update addresses

Release 1's frozen copy prints two addresses, so that one survives the other (G-17 (d)):
1. a short page on `hilbertraum.ai` without a language prefix (the site's own pages use `/en/` and
   `/de/`). **Its exact path is open**; this record and the copy write it `<G17-ADDRESS>` until the
   owner sets it, at the latest by the release-1 tag;
2. the project's GitHub releases page, `github.com/HilbertraumAI/HilbertRaum/releases`.

The project page answers two sub-paths for ten years: `/from/<version>` (every refusal of a
well-formed update file, §2.4) and `/update/<version>` (the buyer notice, §3.2). It says "you have the
newest version" where a Kit's line has nothing newer. The copy reads correctly with and without a
later online check. The owner keeps the domain for ten years.

### 3.4 Where the import starts

"Install update from a file…" is offered in these places (W-4):
- **Settings → Updates**, a new tab, with an unlocked workspace;
- **on the unlock screen, without unlocking**: (i) a button inside the failure banner, for the
  failures an update can fix: a workspace from a newer version (`workspace_newer`), a workspace that
  could not be opened (`vault_open_failed`), the copy for a database schema this version cannot read,
  and the vault-format refusal; the create form shows it too; (ii) one secondary link in the card's
  footer that opens a small sheet with the import, the "Last update attempt" line and "Copy details for
  support" (§8.3). The calm unlock card gains one line, not three;
- **on the start-failure card** (a start that could not finish, `start_failed`): in the card's banner
  slot, for the cause `other` only (W-82, §3.5).

An import from the unlock screen is finished from there: after it, the screen offers "Restart and
update", without unlocking (§5).

### 3.5 The channels callable while locked

The update channels answer while the workspace is locked (F-14):
- `updates:importFile`, `updates:status` and `updates:cancel`;
- the decline channel `updates:discardStaged`, behind "Don't install this update", for a merely staged
  update (refused while an update is in progress, §4);
- the read-only "Copy details for support" channel (§8.3);
- the hand-off channel behind "Restart and update" (§5).

They are registered even in a run whose start failed (W-82): inside `registerStartFailureIpc`, on the
narrow start-failure context (the senders, the drive root, `isDev`, the app version), never on the full
app context, which does not exist in that state ([`data-contracts.md`](data-contracts.md), the
start-failure section). "Every other channel refuses while locked" holds for the `updates:*` channels;
other modules answer before unlock by design.

### 3.6 What the import refuses before it reads the file

1. **A root that is not a prepared drive** (F-21, W-58). When the app runs on the user-data fallback
   root (`isPreparedDrive` is false: a standalone download in a downloads folder, a Dock-pinned Mac app
   started from its cache, an AppImage started off a drive), release 1 offers neither the import nor
   staging. The Updates tab and the unlock screen say that this copy of HilbertRaum isn't running from
   a prepared drive and name the address where the new version can be downloaded. Otherwise the apply
   script, which finds its root from its own location, would plant apps in the app-data folder. The
   test is `isPreparedDrive`, never `HILBERTRAUM_DRIVE_ROOT` (that variable wins without a marker
   check).
2. **The policy**, read again from disk (§8.1): `updates.allow_user_install: false` refuses before
   anything is read ("Updates are managed by your organization"); `updates.max_version` is applied once
   the file's version is known.
3. **An update already in progress** (`updates/applying/` exists): the import is refused and the screen
   offers "Continue the update" instead (§4, §5).
4. **A drive that is read-only or full**: a writability probe and a fixed small free-space margin at the
   start of every import (§4).

The two drive-awareness fixes of F-21:
- **macOS**: an app started from the start file's cache (`~/Library/Caches/HilbertRaum/`) without a
  drive root shows "Start HilbertRaum on the drive" with Quit as the main action; a workspace on the
  Mac stays reachable as the secondary one, instead of being offered silently.
- **Linux**: the drive is also found through `APPIMAGE`, so an AppImage started directly from the drive
  lands on the drive. **As built on master** (PR #866: only when `APPDIR` contains the running
  program). The AppImage switches to electron-builder's static runtime (`toolsets.appimage` in
  `electron-builder.yml`, no libfuse2) before F-21 freezes (P7, G-6); the libfuse2 workaround in
  [`troubleshooting.md`](troubleshooting.md) then becomes a fallback note.

Then the file itself is checked: the envelope and the payload as §2 says, the container and its
members as §4 says.

### 3.7 What the import shows

Before "Restart and update" the import shows what the update is: its version, its date (`issued`) and,
if present, its signed `summary` in the UI language (§2.4). The confirmation for an update file older
than 12 months and the warning about the other systems' OS floors come at the import, before staging.

---

## 4. Staging and the update file container

_Scope: what release 1 does between the file pick and "Restart and update": the update file's
container (the ustar subset, F-16), the member-name rule (F-18), the `updates/` layout and staging
(F-5). The frozen values come from the protocol table A._

_Status: planned (P6 builds the reader and staging, P5 the writer, P6 commits the golden update file).
Table A below is the decided contract. Its evidence is spike 9 (`impl/p1/spike-9.md`: the prototype
reader in Electron 43.8.10's main process, a 450.6 MB file on NTFS, exFAT USB 3 and exFAT USB 2, Norton
on, 80 runs and 51 hand-built refusal files), its method review (T1.11, finding ids `S9-n`, `C-n`) and
G-5 (c)._

### 4.1 How to read table A

Table A uses §5.1's columns ("frozen since": _R1_ or _Scripts_), its spellings of systems, versions and
tokens, and its common text rules G0 for `staged.txt`. A cap is frozen for ever: an update file over
one of release 1's caps is "too new" for release 1 (`UPD-TOO-NEW`), so every update that release 1
must install directly has to fit inside them. The caps are therefore set for what a 2035 file may need,
not for today's file (each one's reason is in its row).

### 4.2 Names (table A.1)

| Name | What it is | Written by | Read by | Frozen since |
|---|---|---|---|---|
| `updates/staging/` | the staging folder | R1 app (the import) | R1 app, the apply | R1 |
| `updates/staging/.incoming-<v>/` | the members of version `<v>` while they are written and hashed, each under its member name; a dot name, so no version folder and no member can collide with it | R1 app | R1 app (the start-up sweep) | R1 |
| `updates/staging/<v>/` | the staged update of version `<v>`: the folder `files/`, then `hilbertraum-release.dsse.json`, `staged.txt` and `staged.json`. Only these four names are ever in it | R1 app | R1 app (the offer, the re-hash, the copy of the scripts), the apply | R1 |
| `updates/staging/<v>/files/` | the staged members, each under its member name, one level below the markers, so no member name can ever meet a marker (T1.11 S9-2) | R1 app | R1 app, the apply (the members) | R1 |
| `updates/staging/<v>/hilbertraum-release.dsse.json` | the verified envelope, byte for byte as member 0 carried it; the apply keeps it as `updates/applied/<v>.dsse.json` (§6.9) | R1 app | the apply | R1 |
| `updates/staging/<v>/staged.txt` | the member list for the scripts (§4.6) | R1 app | the apply (sizes and names) | R1 |
| `updates/staging/<v>/staged.json` | the one commit marker, written last (§4.6) | R1 app | R1 app; a later app | R1 |
| `updates/.write-probe` | the writability probe (§5.4): created and deleted at once | R1 app | — | R1 |
| the update file's own name | not frozen: the user may rename it. The release tooling names it outside the `HilbertRaum-*` prefix that the start files and the sell gate glob (§9.3); its extension is `.hrupdate` | P5's writer | nobody reads the name | — |

### 4.3 The update file container (table A.2; F-16, G-5 (c))

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Format | a strict subset of POSIX ustar, read and written in process over `node:fs` and `node:crypto` (no OS `tar`, no dependency): a sequence of members, each a 512-byte header then the member's bytes zero-padded to a multiple of 512, then the end | G-5 (c), C9 | R1 |
| The reserved prefix | a file whose first 8 bytes are the ASCII `HRUPDATE` is a future container: `UPD-TOO-NEW` with the in-between hint (§2.4), tested on those 8 bytes before any header | F-16 | R1 |
| Header check order | magic, checksum, type, name, size (spike 9 DD2) | spike 9 DD2 | R1 |
| Magic and version | bytes 257–262 `ustar` + NUL, bytes 263–264 `00`; anything else (GNU's `ustar  ` included) fails | spike 9 DD2 | R1 |
| Checksum | bytes 148–155: octal digits, then NUL or space; equal to the unsigned sum of the header's 512 bytes with these 8 bytes counted as spaces | spike 9 DD2 | R1 |
| Type | byte 156 must be `0`; `x`, `g`, `L`, `K` (pax and GNU extension headers) and every other value, NUL included, fail | spike 9 DD2, G-5 (c) | R1 |
| Name | bytes 0–99: the member name (§4.4), then at least one NUL, only NULs after it | spike 9 DD2 | R1 |
| Link name, prefix | bytes 157–256 and 345–499 all zero | spike 9 DD2 | R1 |
| Size | bytes 124–135: octal digits, then NUL or space; no leading space, no base-256 form; so every member is smaller than 8 GiB (8,589,934,592 bytes) | spike 9 DD2, G-5 (c) | R1 |
| Ignored fields | mode, uid, gid, mtime, uname, gname, devmajor, devminor and bytes 500–511; the writer writes `0000644`, `0000000`, `0000000`, `00000000000`, empty, empty, `0000000`, `0000000` and zeros | spike 9 DD2 | R1 (the reader ignores them) |
| Member 0 | the signed envelope, member name **`hilbertraum-release.dsse.json`** (the release asset's name, §9.3), at most **4 MiB** (4,194,304 bytes; a larger header size is `UPD-TOO-NEW` before a byte of it is read); read whole into memory and verified as §2.3 says before anything else is read. Any other first member is `UPD-NOT-AN-UPDATE`. The cap is F-1's and §2.3's (T1.11 S9-1), the one thing it protects being the bytes parsed before the signature is checked: it holds a 4,096-entry payload as base64 (1.1 MB, light run below) plus 64 signatures of up to ~45 KB each (room for a later hash-based signature scheme) | F-1, F-16, §2.3; T1.11 S9-1 | R1 |
| Where the payload lives | **inside the envelope**, as DSSE's base64 `payload` field; the update file has no separate payload member (spike 9's prototype used one only as a stand-in for P4). `files[]` lists every member after member 0 (§2.4) | F-2, F-16; T1.11 S9-1 | R1 |
| DSSE `payloadType` | `application/vnd.hilbertraum.release+json`; any other `application/vnd.hilbertraum.*` type from a known key → `UPD-FOR-NEWER-HILBERTRAUM` (G-30); any other type → `UPD-NOT-AN-UPDATE` | F-2, G-30 | R1 |
| The payload's `kind` | `"release"`; any other value from a known key → `UPD-FOR-NEWER-HILBERTRAUM` (§2.4) | F-2 | R1 |
| Signatures | at most 64 per envelope, counted before the envelope is parsed (§2.3) | F-1 | R1 |
| Members after member 0 | every one listed in the payload's `files[]`, in any order, each at most once (case-folded, §4.4), its header size equal to the listed `size`; every listed member without a `group` present; each `group` present whole or absent whole (§2.4) | F-2, W-5 | R1 |
| Member count | `files[]` holds at most **4,096** entries, checked before staging; more → `UPD-TOO-NEW`. The reason is what a later file may carry (T1.11 S9-1, C-12): the apps of more systems and architectures, the scripts and start files, the engine archives of §6.5's escape hatch (families × systems), and, if M2's content ever travels one file at a time, the drive content: 37 model manifests today, the skills, the drive docs and notices in ten languages; a few hundred members in all, so 4,096 leaves more than ten times that. The cost is time only: a light run of spike 9's prototype (plain Node 24.13, NTFS, 4,096 members of 1 KiB and an 830 KB payload with ten 400-character `summary` texts; 3 runs, `impl/p1/T1.8/lightrun/count-run.log`) staged them in 8.3–9.3 s, 1.6 ms per member (median; max 32 ms), memory +11.3 MB; on a stick spike 9 measured 9–10 ms per member (median, ≤ 81 ms), so ~41 s at the median. P8's sheet confirms the M2 file stays under the cap (C-12). Spike 9 proposed 256 (judgement value) | spike 9 DD3; T1.11 S9-1, C-12 | R1 |
| Total size | no cap of its own beyond the member bound (< 8 GiB each) and the free-space check (§4.5). Spike 9: 450 MB stage in 15–16 s on USB 2, linear (not measured beyond) | spike 9 DD3 | R1 |
| The end | exactly two 512-byte zero blocks, then the end of the file; any byte after them, a tar record's zero padding included, fails (so P5 never writes an update file with the OS `tar`, whose 10,240-byte records this rule refuses) | spike 9 DD2 | R1 |
| The header walk | right after member 0 verified and the payload passed §2.4–§2.6 and the version rule, the reader reads every following header by seeking (512 bytes per member, no member data) up to the two zero blocks: each header is checked as above, the set of members against `files[]`, and the end against the file's length. An end of file before a header, inside a member or before the zero blocks → `UPD-DOWNLOAD-INCOMPLETE`, before any member is written; bytes after the end → `UPD-FILE-DAMAGED`. With every member present this equals spike 9's early length check (payload end + Σ (512 + size + pad₅₁₂(size)) + 1024; measured 31–75 ms instead of 6.3–10.7 s), and it also holds when whole groups are absent (one payload serves the full and the per-system files, §2.4) | spike 9 DD2 (judgement: the walk generalises the measured check to absent groups) | R1 |
| Then the data pass | one sequential pass over the members (§4.5); each header is read again and must equal the walk's | spike 9 DD1 | R1 |

### 4.4 The member-name rule (table A.3; F-18)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Characters | ASCII `[A-Za-z0-9._-]` only (no space, no `+`: GitHub renames asset names with other characters, and every member must be fetchable under its own name; the root name of a member whose root name differs travels in `install_as`, §2.4) | F-18 | R1 |
| Length | 1 to 99 bytes (the ustar name field with its NUL) | F-18 | R1 |
| First and last character | the first is `[A-Za-z0-9]` (a leading `-` reads as an option to the scripts' commands, a leading `.` is a hidden file on macOS and Linux and the staging folder's own dot names start so; spike 9 DD8, decided here); the last is not `.` | F-18; spike 9 DD8 | R1 |
| Reserved names | refused, compared case-folded: the Windows device names `con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, alone or before a `.` (`nul.txt`); `hilbertraum-release.dsse.json` anywhere but member 0. The staging folder's own files can never meet a member, because members live one level down in `files/` (§4.2; T1.11 S9-2, decided here instead of reserving `staged.*`): a member named `staged.json` is legal and is staged as `files/staged.json`. A later version that adds a marker puts it beside `files/`, never inside it | F-18; T1.11 S9-2 | R1 |
| Uniqueness | no two names equal after folding `A`–`Z` to `a`–`z` (ASCII only, never a locale), so NTFS, exFAT and APFS hold them all | F-18 | R1 |
| Names release 1 looks for | `apply.cmd` and `apply.sh`, byte-exact (§5.2): a payload without the one for this computer's system is `UPD-NO-HELPER` (W-5) | W-5 | R1 |
| A name that breaks the rule | in the signed payload → `UPD-TOO-NEW` (a later writer's file release 1 cannot take); in a header but not in the payload → `UPD-FILE-DAMAGED` | F-18 | R1 |
| One rule, no list | no enumeration of systems or artifact patterns: a later file that adds a system or renames an artifact stages whole (W-2) | F-18 | R1 |
| The root globs release 1 reads | its own system's start-file globs (`HilbertRaum-*-portable.exe`; `*.app` and `HilbertRaum-*-mac-arm64.app.zip`; `HilbertRaum-*.AppImage`), for the older-than-drive notice and the confirmation (§5.7) | F-18 | R1 |

### 4.5 Staging (table A.4; F-5, W-5)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Order of an import | the refusals before the file is read (§3.6: not a prepared drive, the policy, `updates/applying/` present → `UPD-IN-PROGRESS`, the writability probe and the 64 MiB margin of §5.4) → the `HRUPDATE` prefix → member 0 and its verification (§2.3) → the payload (§2.4–§2.6, the version rule, the policy's `max_version`, the OS floor, the `issued` checks) → the header walk (§4.3) → the free-space formula (below) → the data pass → the commit | W-5, §3.6 | R1 |
| Free space | before the data pass, with `c` = the drive's cluster size from `fs.statfs` `bsize` (1 MiB when `statfs` fails or reports 0) and `w` = the write size: free bytes ≥ Σ over the members present of ⌈size ÷ `c`⌉ × `c` + `c` (the staging folders' own entries) + max(64 MiB, 64 × `w`); else `UPD-DRIVE-FULL`. The last term covers exFAT's allocation ahead of the data in an open file, about 32 × the write size (≤ 33.7 MB measured at 1 MiB writes), with 2× room; at P6's 1 MiB writes it is 64 MiB (67,108,864 bytes). Spike 9's flat 1 MiB per file is replaced by the real cluster size (T1.11 S9-3); P11a's legs add a peak-free-bytes row on macOS and Linux exFAT and on the Kit SSD. The update file itself is already on its volume when the check runs | spike 9 DD5; T1.11 S9-3 | R1 |
| Reads (P6's constant) | an implementation constant, not a format value: any read size reads any update file (T1.11 S9-4). Release 1 reads 1 MiB (1,048,576 bytes) at a time into one reused buffer (`FileHandle.read` into a single `Buffer.allocUnsafe(1048576)`), hashing (SHA-256) and writing each slice before the next read; the re-hash before the hand-off (W-6) reads the same way. Spike 9, in the packaged app's main process: a read stream stalls the event loop by 66–155 ms and adds 73–89 MB; one reused buffer stays ≤ 43 ms and +6.4–9.8 MB at the same speed; 64 KiB reads are 1.5–2.4× slower on sticks; 4 MiB gain nothing and quadruple exFAT's run-ahead. Plain Node shows no stall, so P6's performance row runs in the packaged app | spike 9 DD1; T1.11 S9-4 | P6 (constant) |
| Where a member is written | `updates/staging/.incoming-<v>/<member name>` (opened `wx`), every byte hashed as it is written, fsynced and closed; on a hash match it is moved (same name) into `updates/staging/<v>/files/`; on a mismatch it is deleted and the import refused (`UPD-FILE-DAMAGED`). Nothing is ever renamed to an `.exe` name (S-P1-14: such a rename costs 240–391 ms on a stick with Norton on; the move costs 4.4–39.4 ms), and no temporary name can collide with a member name (a `.part` suffix did: `apply.cmd.part` is a legal name) | spike 9 DD4 (decided here) | R1 |
| Staged names | every member keeps its member name in staging; the release tooling gives each root artifact a member name equal to its root name (`HilbertRaum-<v>-portable.exe`), so the apply's move from staging to the root renames no `.exe` (spike 1 DD6); a member whose root name differs (a start file) carries it in `install_as`, which the apply applies (§5.5) | spike 1 DD6, spike 9 DD4 | R1 (the staged name); Scripts (the move) |
| Moves | every move in staging uses the rename retry of `services/fs-retry.ts` (`renameWithRetry`: `EBUSY`, `EPERM`, `EACCES`, its 12 s budget); spike 9: 0 retries in 802 renames, Norton's inspection runs inside `close()` | W-5, spike 9 DD7 | R1 |
| A write that runs out of room | `ENOSPC` during the data pass → `UPD-DRIVE-FULL`; `EFBIG` (a FAT32 drive and a member of 4 GiB or more) → `UPD-FILE-TOO-BIG-FOR-DRIVE`; never a raw error | spike 9 DD3 | R1 |
| The commit | after every present member is in `updates/staging/<v>/files/`: write `hilbertraum-release.dsse.json`, then `staged.txt`, then `staged.json` into `updates/staging/<v>/` (each to a `.tmp` name, fsynced, renamed; on macOS and Linux the folder fsynced after), then remove `updates/staging/.incoming-<v>/` | F-5 | R1 |
| At most one staged update | the commit then removes every other `updates/staging/<w>/` and `.incoming-<w>/` (they are re-importable) | F-5 (GAP-8) | R1 |
| A re-import of a staged or failed version | removes `updates/staging/<v>/` and `.incoming-<v>/` first; after the commit, the `cleared` line of §5.7 when `last-result.txt` marks `<v>` | W-5 | R1 |
| Any refusal | removes `updates/staging/.incoming-<v>/` and `updates/staging/<v>/`, renamed members included (spike 9: 4–49 ms, 0 files left in 414 refusals) | W-5 | R1 |
| The start-up sweep | at every drive-aware start, before the offers: remove every `updates/staging/.incoming-*` folder and every `updates/staging/<w>/` without `staged.json` (an import cut by a kill or an unplug) | F-5 | R1 |
| "Don't install this update" | removes that version's `updates/staging/<v>/`; never offered, and the channel `updates:discardStaged` refused, while `updates/applying/` exists | F-5, F-14 | R1 |
| The re-hash refusal | the hand-off's re-hash (W-6) removes that version's `updates/staging/<v>/` on a mismatch (`UPD-FILE-DAMAGED-ON-DRIVE`) | F-5, F-6 | R1 |
| Progress | bytes staged / Σ sizes of the members present, shown at most every 250 ms; the re-hash has its own label (UX-10). Spike 9: the longest flat stretch is 0.11–0.66 s (the exe's close, a content scan of ~245 ms on a stick) | spike 9 DD6 | R1 |
| A staged member's use | only the members of `staged.txt` are moved by the apply; the members of systems the drive does not carry stay in staging until the new version's clean-up (W-26, G-36) | W-21 | Scripts |

### 4.6 `staged.txt` and `staged.json` (table A.5; F-5)

**`staged.txt`** (R1 writes, the apply reads). G0 (§5.1). One line per staged member, in `files[]` order:
`<size> <name>`. `<size>` is the member's byte count in decimal (1 to 10 digits, no sign); `<name>` is the
rest of the line after one space (a member name, §4.4, so it holds no space; the file is
`updates/staging/<v>/files/<name>`). The app writes LF; cmd
reads it with `for /f "usebackq tokens=1,*"` and bash with `read -r size name`, both accepting CR LF. A
line whose first field is not decimal is ignored. The apply checks each member's size against it
before it moves the member; it never hashes (C12).

**`staged.json`** (R1 writes and reads; a later app may read it). UTF-8 JSON without a byte-order mark,
one object: `{"format":1,"version":"<v>","files":[{"name":"<member name>","size":<bytes>,"sha256":"<64
lower-case hex>"},…]}`, the `files` entries in `files[]` order and only for the members present; a
`group` key per entry that had one in the payload. Readers ignore unknown keys. A `staged.json` that does
not parse, or whose `version` differs from its folder's name, means "not staged": the folder is swept.

### 4.7 Verdicts of the container and of staging (table A.6)

| Case | Code (§5.8) |
|---|---|
| no `HRUPDATE`, no ustar header at offset 0, or member 0 is not `hilbertraum-release.dsse.json` | `UPD-NOT-AN-UPDATE` |
| the first 8 bytes are `HRUPDATE`; member 0 over 4 MiB; over 64 signatures; `files[]` over 4,096 entries; a listed name that breaks §4.4; a listed size of 8 GiB or more | `UPD-TOO-NEW` |
| a header that fails §4.3's checks after member 0; an unlisted, repeated or case-colliding member; a header size ≠ the listed size; a missing member without a group, or a partial group, after a complete end; bytes after the end (`TrailingData`); non-zero padding; a member's hash ≠ its listed `sha256` | `UPD-FILE-DAMAGED` (its copy says the file is damaged or not completely downloaded, and to download it again: the action is the same) |
| the end of the file before a header, inside a member or before the two zero blocks | `UPD-DOWNLOAD-INCOMPLETE` |
| a zero block where a header should be while a listed member without a group, or part of a group, is still missing: a preallocated, zero-filled partial download (a browser's) of the full length (T1.11 S9-6) | `UPD-DOWNLOAD-INCOMPLETE`, found by the header walk (a tail that starts inside any member but the last puts zeros where the next header belongs); a zero-filled tail inside the last member's data passes the walk and ends as a hash mismatch, `UPD-FILE-DAMAGED` |
| no `apply.cmd` (Windows) or `apply.sh` (macOS, Linux) listed | `UPD-NO-HELPER` |
| free space under the formula; `ENOSPC` while staging | `UPD-DRIVE-FULL` |
| `EFBIG` while staging | `UPD-FILE-TOO-BIG-FOR-DRIVE` |
| the probe fails | `UPD-DRIVE-READ-ONLY` |

### 4.8 Cases table A was checked against

- **The staged name** (S-P1-14): every member is written under its own name in `.incoming-<v>/` and moved
  under the same name, and artifact members carry their root names, so no step of the import or of the
  apply renames anything to an `.exe` name.
- **A version from 2035** writing an update file for release 1: it fits as long as it keeps ustar's
  subset, one envelope of at most 4 MiB with at most 64 signatures as member 0, at most 4,096 members,
  §4.4's names and members under 8 GiB; any other container starts with `HRUPDATE` and is told "too new",
  never "not an update". Unknown payload fields are ignored (§2.4), unknown `staged.json` keys too.
- **Absent groups**: the header walk accepts a file that carries whole groups only, which spike 9's
  length equation alone would not.
- **Spike 9's limits** (its Not covered): cold reads of a file already on a stick and a cold re-hash
  (spike 6, P11b; the restart time, O22), Defender active (P11a; Δ-30 adds a Defender PC to O22), FAT32 and
  files near 2 GiB (not measured; `EFBIG` is typed), macOS and Linux (P11a).

---

## 5. Hand-off, apply script, start files, outcome

_Scope: what happens from "Restart and update" to the new version's confirmed start or the old
version's notice: the hand-off (F-6), the apply script and its journal, the start-file rules (F-7),
"Continue the update" (F-19), the outcome codes and notices (F-20, G-37, G-39) and
`updates/unconfirmed.txt` (F-22). The frozen values come from the protocol table B._

_Status: planned (P7; the confirmation also ships in release 1, T7.5a). Table B below is the decided
contract. Its evidence: spike 1 (`budget 30`), spike 8 (the profile and lock facts), spike 10 (the
spawn, rule 1, the lock, the cmd rules) and the method review of those spikes (T1.11, its finding ids
`S1-n`, `S8-n`, `S10-n`, `C-n`). A row marked **OPEN (T1.11 …)** states its value, but the value is not
frozen until that finding is closed._

### 5.1 How to read table B

- **Frozen since.** _R1_: release 1 writes or reads the value, so it holds for ever (§1.5). _Scripts_:
  a convention of the two apply scripts of one version (`apply.cmd`, `apply.sh`) and of the start
  files a version ships. Release 1's scripts follow it; a later version may change it for its own
  scripts, but must still converge on every state an R1 writer can leave (§5.5).
- **Systems** are written as `win32`, `darwin` and `linux` (Node's `process.platform`, the same spelling
  as the payload's `requires`, §2.4) wherever a file holds one.
- **A version** is the SemVer 2.0.0 string of the app's `package.json` `version`, as the artifact names
  carry it (`HilbertRaum-<version>-portable.exe`): ASCII, no space, at most 64 bytes. Two versions are
  the same when their bytes are equal; order is F-4's (§2.5). A version field that is not SemVer names
  an unknown version, never an error.
- **A token** is 1 to 32 characters of `[0-9A-Za-z]`. Release 1's app writes 16 lower-case hex
  characters from `crypto.randomBytes(8)`; the scripts build theirs from `%RANDOM%` (cmd) or
  `$RANDOM` (bash). A writer never appends a `last-result.txt` line whose token equals the token of the
  file's last valid line or of `last-result.seen`; it draws again. Readers accept 1 to 64 non-space
  ASCII bytes.
- **Common text rules (G0)**, for every text file of this section:
  - bytes 0x20–0x7E and TAB only; a line holding any other byte is damaged and is ignored;
  - lines end in LF or CR LF; a reader removes one CR before the LF, trims spaces and TABs at both ends,
    skips empty lines and splits fields at runs of spaces and TABs; a last line without a line end
    counts;
  - **writers:** cmd writes CR LF (its `echo`); bash and the app write LF;
  - keys and codes are lower-case ASCII compared byte for byte, never case-folded (so a `tr-TR` locale
    cannot change them);
  - a writer's line is at most 256 bytes; a reader ignores a line over 1,024 bytes and reads at most
    65,536 bytes of a file (append-only files: the last 65,536 bytes, the first partial line
    dropped);
  - an unknown key, an unknown extra field or an unknown extra line is ignored, never an error; a
    missing, unreadable or damaged file means "absent" unless its row says otherwise.

### 5.2 Names (table B.1)

All paths are relative to the drive root; names are exact, case included. `<os>` is a system token,
`<v>` a version, `<n>` the digit 1, 2 or 3.

| Name | What it is | Written by | Read by | Frozen since |
|---|---|---|---|---|
| `updates/` | the update folder (table A, §4, owns staging) | R1 app | everyone below | R1 |
| `updates/applying/` | the pending-apply folder: while it exists an update is in progress (F-6, F-7) | R1 hand-off; "Go back" and every later fallback write it before moving an app (F-7's later-writer duty) | R1 start files (rule 1, the counter), R1 app (F-19), every apply | R1 |
| `updates/applying/handoff.txt` | the hand-off record (§5.3) | R1 hand-off and "Continue the update"; later writers | the apply | R1 |
| `updates/applying/apply.cmd`, `updates/applying/apply.sh` | byte copies of the staged members `apply.cmd` and `apply.sh` (member names exact, lower case; R1 finds them by name, whatever their `role`); R1 copies each one the staging holds, for every system, so the other system's twin can resume | R1 hand-off; R1 "Continue the update" re-copies a missing one from `updates/staging/<v>/files/` (`<v>` = `handoff.txt`'s `version`) | R1 start files (rule 1), the apply | R1 |
| `updates/applying/started` | empty file: the apply's first action creates it (the start acknowledgement) | the apply | R1 app (≤ 10 s after the spawn, §5.4) | R1 |
| `updates/applying/launch-1`, `launch-2`, `launch-3` | empty files: one per resume a start file began (N = 3) | R1 start files (rule 1); later start files keep rule 1 | R1 start files; the apply deletes them | R1 |
| `updates/applying/finish-1`, `finish-2`, `finish-3` | empty files: one per hand-off of one version by an app (N = 3) | R1 app (every hand-off, "Restart and update" and "Continue the update") | R1 app; the apply deletes them | R1 |
| `updates/applying/apply.lock` | the cmd twin's lock: a file held open by redirection handle 9 for the whole run; its presence means nothing | `apply.cmd` | `apply.cmd` | Scripts |
| `updates/applying/apply.lock.d/` and its `owner` | the bash twin's lock: a directory made with `mkdir`; `owner` holds `pid`, `os`, `boot` and `lstart` lines (§5.3's `key value` form) | `apply.sh` | `apply.sh` | Scripts |
| `updates/applying/journal.txt` (and `journal.tmp` while it is written) | the apply journal's header (§5.3, §5.5) | the apply | both twins of the version whose scripts lie there | Scripts |
| `updates/applying/step-launchers`, `step-result` | empty files: journal steps done (§5.5) | the apply | both twins | Scripts |
| `updates/previous/` | the previous set: at most one artifact per system, the replaced start files, and the previous content set (P8 names its folder, §6.10) | every apply | R1 start files (rule 2, the counter), "Go back" | R1 (rule 2 reads it) |
| `updates/applied/<v>.json`, `updates/applied/<v>.dsse.json` | the apply's record and the kept signed envelope (§6.9) | the apply | the new version | Scripts |
| `updates/unconfirmed.txt` | F-22's trigger (§5.3, §5.7) | a forward apply, before its first move | R1 app, R1 start files' counter, later start files | R1 |
| `updates/confirmed/<v>-<os>` | empty file: version `<v>` had a confirmed start on system `<os>` | every confirming app, R1 included | every app; R1's counter tests `updates/confirmed/<v>-*` | R1 |
| `updates/launch-count.txt` | R1's launch counter, one per drive (§5.3) | R1 start files (the counter); removed by a confirming app (F-22) and by a counter fallback | R1 start files | R1 |
| `updates/launch-count-<anything>.txt` | reserved for later start files' per-computer counts (W-21); R1 never reads them and its confirmation removes them | later start files | later start files | R1 (the name is reserved) |
| `updates/starting-<os>` | later start files' in-flight record (W-7 (d)) | later start files | later start files | Scripts |
| `updates/last-result.txt` | the outcome lines (F-20, §5.3, §5.8) | the apply, start files, R1 app | R1 app, every later app | R1 |
| `updates/last-result.seen` | the line R1 showed last (§5.3) | R1 app on dismissal; later apps in the same form | R1 app | R1 |
| `updates/update.log` | the support log (§8.2); table B's writers' lines in §5.3 | R1 app, R1 start files, later start files, the apply | support, `/check`, "Copy details for support" | R1 |

### 5.3 Grammars (table B.2)

Every file below follows G0 (§5.1).

**`handoff.txt`** (R1; F-6). `key value` lines: the key is the first field, the value the rest of the
line after one run of spaces or TABs. The first line with a key wins; a key R1 does not know is kept
and ignored.

| Key | Value | Written by |
|---|---|---|
| `pid` | decimal, 1 to 10 digits: `process.pid` of the app that hands off (on Windows the main process inside `%TEMP%`, whose parent is the stub) | R1, every later writer |
| `version` | the version whose scripts were copied into `applying/` (the staged version) | R1, every later writer |
| `budget` | decimal seconds, 1 to 86400: the wait floor; R1 writes `30` (spike 1). The apply waits at least this long, and may wait longer, never shorter | R1, every later writer |
| `os` | the system token of the computer that handed off | R1, every later writer |
| `boot` | decimal: that computer's boot time in epoch seconds, `Math.round(Date.now() / 1000 - os.uptime())` | R1, every later writer |
| `mode` | `forward`, `back` or `fallback`; absent means `forward` | later writers only ("Go back", a fallback) |
| `to` | the version the apply moves to the root (for `back` and `fallback`) | later writers only |

- R1 writes the five lines in the order above, LF line ends, to `handoff.txt.tmp`, fsyncs it, renames it
  to `handoff.txt`. No host name, user name or path is written.
- **"Continue the update"** (R1, §5.4) rewrites the file: new `pid`, `os`, `boot` and `budget 30`,
  and **every other line kept in its order** (`version`, `mode`, `to`, unknown keys), so a fallback or
  a "Go back" that release 1 continues keeps its direction. A missing or damaged `handoff.txt` is
  rewritten with R1's four keys only.
- The apply reads `pid`, `os`, `boot` and `budget` only to wait (§5.5); it never takes its direction
  or its versions from `handoff.txt` once `journal.txt` exists.

**`journal.txt`** (Scripts; W-21). `key value` lines as `handoff.txt`, written once per apply run by
the first instance that holds the lock, to `journal.tmp`, then renamed (bash: `sync` after), and never
rewritten; a resume reads it.

| Key | Value |
|---|---|
| `journal` | `1` (the journal format) |
| `mode` | `forward`, `back` or `fallback` (from `handoff.txt`; absent there means `forward`) |
| `to` | the target version: the staged version for `forward`, `handoff.txt`'s `to` otherwise |
| `from-win32`, `from-darwin`, `from-linux` | one line per system: the version of that system's root artifact when the journal opened, `none` when the root had none, `unknown` for a root `*.app` |

**`unconfirmed.txt`** (R1; F-22). The first valid line: `<version> <token> [<field>…]`, the rest of the
line ignored. Written by a forward apply before its first move (temp + rename, CR LF from cmd, LF from
bash). A file without a valid first line is damaged: R1's app removes it as stale (§5.7).

**`launch-count.txt`** (R1; F-7). The first valid line: `<count> <version> [<field>…]`. `<count>` is
decimal; a count above 3 reads as 3, a count that is not decimal reads as 0, and a `<version>` other than
`unconfirmed.txt`'s reads as 0. R1's start files rewrite the whole file (`>"…" echo <count> <version>`;
bash `printf '%s %s\n'`). A confirming app removes it (F-22).

**`last-result.txt`** (R1; F-20, W-51). Append-only; nothing ever deletes or shortens it.
- A valid line: `<code> <version> <token> [<field>…]` with `<code>` matching `[a-z][a-z0-9-]{0,31}`.
  A line with fewer than three fields, a malformed code or a non-SemVer version is ignored (a torn or
  hand-edited line never counts).
- **The last valid line wins.** Its code decides (§5.8): every code outside the success set `applied`,
  `cleared` means "don't offer this version again"; an unknown code gets the generic copy.
- Writers append one line per event (`>>"…" echo …` with the redirection first in cmd).

**`last-result.seen`** (R1). One line: the last valid `last-result.txt` line that R1 showed, as R1
read it after G0's trimming, then LF. A `last-result.txt` line is new when its trimmed text differs
from this line. R1 writes it when the notice is dismissed (W-51), never on render; an absent or
unreadable file means nothing was shown. On a drive that cannot be written the notice therefore shows
at every start (accepted, W-51).

**`update.log` lines of table B's writers** (R1; F-11, §8.2). One line per event:
`<writer> <os> <event> [<field>…] <time>`.
- `<writer>`: `r1-launcher` (release 1's start files), `r1-app` (release 1's app), `lb` (a later
  version's start files), `apply-<version>` (an apply script).
- `<field>`: `key=value`, value ASCII without spaces (versions, codes, counts, the class names below).
  No path, no host or user name, no free text.
- `<time>` is the last field: `t=<YYYY-MM-DDTHH:MM:SSZ>` (the app and bash, UTC), or
  `d="<%date% %time%>"` from cmd, whose content between the quotes is opaque bytes in the console's code
  page and is never parsed.
- A write failure is ignored (`2>nul`; bash `2>/dev/null || true`); it never stops a start file or an
  apply.

### 5.4 The hand-off (table B.3; F-6, F-14's hand-off channel)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Who hands off | the app, on the `will-quit` leg only, after `performShutdown` returns `clean` (`working_copy_lost` and `failed` end with nothing written, the update still staged); an app that survived a session-end lock hands off from its own branch (W-6 (i)–(v)) | W-6 | R1 |
| Order | "Restart and update" → pre-check (below) → policy re-read (§8.1) → re-hash every staged file against `staged.json` (table A; a mismatch removes that version's staging folder, code `UPD-FILE-DAMAGED-ON-DRIVE`) → the #935 question and the #888 save, each only when it applies → the restart dialog last → lock → teardown → write `applying/` (below) → spawn → wait for `started` → `app.exit(0)`. Every abort choice before the lock writes nothing | W-6, F-6 | R1 |
| Precondition: the running app is the drive's app | the apply finds the root from its own place and swaps the root's artifacts (`%~dp0..\..\`), so the hand-off assumes the running app is a root artifact of the root R1 resolved (`locateDriveRoot`, `services/workspace.ts:42-53`): Windows, `dirname(PORTABLE_EXECUTABLE_FILE)` is that root; macOS, `HILBERTRAUM_DRIVE_ROOT` names that root (a start through the root's start file) or the running bundle is a root `*.app`; Linux, `dirname(APPIMAGE)` is that root or `HILBERTRAUM_DRIVE_ROOT` names it. When it fails (a bare exe one folder below the root, an override root), "Restart and update" and "Continue the update" are refused before the lock with `UPD-NOT-DRIVE-APP` (copy key prefix `updates.restart.notDriveApp`), nothing is written and the update stays staged; the import and the staging stay allowed (owner 2026-11-24, Δ-31, §5.12) | T1.11 S10-1; owner | R1 |
| Pre-check | before the lock, and at the start of every import (table A, §4.5): create and delete `updates/.write-probe` (a dot name, so no glob of table A or B matches it), and free space ≥ 64 MiB (67,108,864 bytes, the third term of table A's formula); failing either → no shutdown, code `UPD-DRIVE-READ-ONLY` or `UPD-DRIVE-FULL` | W-6 (GAP-23, A-6); spike 9 DD5 | R1 |
| `applying/` write order | `mkdir updates/applying` → `handoff.txt` (temp, fsync, rename; §5.3) → copy `apply.cmd` then `apply.sh` from `updates/staging/<v>/files/`, each fsynced → `finish-<n>` (the lowest free `<n>`) → on macOS and Linux fsync `updates/applying/` and `updates/` (W-6, lens A-9). Any write failure after the teardown is handled as a failed spawn (below) | W-6 | R1 |
| `finish-<n>` cap | if the marker just created is `finish-3`, R1 does not spawn: it treats this hand-off as a failed spawn of class `finish-cap` (W-6, GAP-24) | W-6 | R1 |
| Windows spawn | `spawn(<SystemRoot>\System32\cmd.exe, ['/d', '/c', '.\\apply.cmd', String(process.pid)], { cwd, detached: true, stdio: 'ignore', windowsHide: true, env })`; no `shell`, no `windowsVerbatimArguments`. `<SystemRoot>` = `process.env.SystemRoot`. Node builds the command line `C:\WINDOWS\System32\cmd.exe /d /c .\apply.cmd <pid>` (spike 10: `spawnargs`). No path on the command line: the script finds the root from its own place (`%~dp0..\..\`). Measured on 12 roots × NTFS and exFAT, 72 of 72 runs (spike 10, Norton on, Windows 11 x64 build 26300). Its open legs, placed by the owner 2026-11-24 (Δ-30): a Defender-only PC in O22's pre-release timing leg (T1.11 S1-1) and GitHub's `windows-11-arm` runner in the walk (T1.11 C-3) | spike 10 DD1; W-6 | R1 |
| `cwd` (both systems) | `path.join(<the drive root R1 resolved with locateDriveRoot and wrote applying/ under>, 'updates', 'applying')`; **never** `dirname(PORTABLE_EXECUTABLE_FILE)` (spike 10's probe shortcut; T1.11 S10-1). Two T7.1 rows: the exe one folder below the root; an override root | T1.11 S10-1 | R1 |
| Environment | `env` = `process.env` minus every name below, then `NoDefaultCurrentDirectoryInExePath=1` and `ComSpec=<SystemRoot>\System32\cmd.exe` added (Windows only). Iterate `Object.entries(process.env)` (it keeps the stored spelling). **Dropped** on Windows matched case-insensitively, on macOS and Linux case-sensitively: names starting `HILBERTRAUM_`, `PORTABLE_EXECUTABLE_`, `ELECTRON_`, `NODE_`, `BASH_FUNC_`, `LD_`, `DYLD_`; the names `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `IFS`, `CDPATH`, `GLOBIGNORE`, `TAR_OPTIONS`, `POSIXLY_CORRECT`, `PS4`, `COPYCMD`, `DIRCMD`; on Windows also every spelling of `NoDefaultCurrentDirectoryInExePath` and `ComSpec` before they are set. Measured: the stub adds `PORTABLE_EXECUTABLE_APP_FILENAME`, `_DIR`, `_FILE`, Electron adds `ELECTRON_NO_ATTACH_CONSOLE`; all four are dropped (spike 10: 116 names → 92). A later apply may drop more; it can never restore a name | spike 10 DD1; W-6 | R1 |
| macOS and Linux spawn | `spawn(<sh>, ['./apply.sh', String(process.pid)], { cwd, detached: true, stdio: 'ignore', env })`; `<sh>` = the first of `/bin/bash`, `/usr/bin/bash`, `/bin/sh` that is a regular file with execute permission; none → a failed spawn of class `no-shell`. `detached` makes the child a session leader (`setsid`). `apply.sh` re-execs itself under bash when bash exists (W-21). **Pending spike 4a** (T1.6, the detached hand-off from the packaged AppImage on WSL2) and P11a's spike 3 (macOS); the row rests on W-6 until then | W-6, B-13 | R1 |
| Failed spawn, classes | R1 classifies before and at the spawn (spike 10 DD4): `cwd.length > 258` → `cwd-too-long` (no spawn tried); `child.pid === undefined` right after `spawn()`, or an `error` event, with code `ENOENT` while the shell exists → `cwd-missing-or-too-long`; `EPERM` or `EACCES` → `blocked`; the shell missing → `no-shell`; any other code → `spawn-failed`; plus `finish-cap` and `write-failed` (a write after the teardown failed). Measured: a cwd of 259 characters or more gives `ENOENT` naming `cmd.exe` 2 ms after `spawn()` (`LongPathsEnabled` doesn't help); with the real exe name a too-deep root never reaches the hand-off (the stub fails first at a 256-character exe path) | spike 10 DD4, item 5 | R1 |
| After a failed spawn | append `helper-blocked <v> <token>` to `last-result.txt`; log `r1-app <os> handoff-failed version=<v> class=<class> code=UPD-HELPER-BLOCKED`; remove `updates/applying/` **only** when this hand-off created it and `started` is absent (a "Continue the update" never removes it); show the `helper-blocked` notice; quit (the teardown already ran). The update stays staged. R1 removes `applying/` in no other case: every other removal is the apply's own (§5.5). **OPEN (T1.11 S10-2, spike 10b)** as far as that reliance needs cmd to delete the folder of a running script (`LockBatchFilesWhenInUse` = 1, measured by spike 10b) | W-6 (CC-21, CE-D7); T1.11 S10-2 | R1 |
| Start acknowledgement | after a successful spawn R1 polls `updates/applying/started` every 100 ms for at most **10 s**. Present → log `handoff-started`, `app.exit(0)`. Absent after 10 s → append `helper-blocked <v> <token>`, log `handoff-no-ack … code=UPD-HELPER-BLOCKED`, show the notice, remove nothing (a slow first scan may still let the apply run; its later lines win), `app.exit(0)`. Measured spawn → `started`: **16–41 ms over 82 runs** (spike 1 item 4: 16 runs, 25–41 ms; spike 10: 66 runs, 16–39 ms; Norton on, the script's hash known; T1.11 C-6), so 10 s is more than 200× the worst case seen. A Defender-only PC joins O22's pre-release timing leg (owner 2026-11-24, Δ-30; T1.11 S1-1) | W-6; T1.11 C-6, S1-1 | R1 |
| `budget` | `30` seconds, a floor, in `handoff.txt`. Its clock starts at the spawn, after the lock, so the lock's own time is outside it. After the old app's process is gone the stub releases the exe in 0.22–0.27 s and exits in 0.42–0.62 s (spike 1: 45 runs, both stub builds, NTFS, exFAT USB 3, exFAT USB 2); the 10 s acknowledgement wait ends as soon as `started` appears. Times are spike 1's; spike 8 gives the mechanism only (the stub exits last; T1.11 S8-6) | spike 1 DD1 | R1 |
| End of the app | `app.exit(0)`, never a graceful quit (a hung quit would keep the single-instance lock and swallow the apply's start, CE-D6) | W-6 | R1 |
| "Continue the update" | offered while `updates/applying/` exists at a drive-aware start (F-19, §5.7), also when the last valid `last-result.txt` line is `helper-blocked` for that version (then labelled "Try again on this computer"); it runs the whole path above with these differences: no re-hash of a staged update and no policy gate (W-13: once `applying/` exists the policy no longer stops it), the pre-check still runs, `handoff.txt` is rewritten (§5.3), a missing `apply.cmd` or `apply.sh` is re-copied from `updates/staging/<version>/files/` when that folder holds it, a `finish-<n>` is added, and it never removes `applying/`. A missing script it cannot re-copy is still spawned: the missing acknowledgement then shows the notice | W-6, F-19 | R1 |
| Kill-on-close job (accepted residual) | a detached spawn from Node never requests breakaway: inside a `KILL_ON_JOB_CLOSE` job the apply dies within ~25 ms of the job's close, even with `BREAKAWAY_OK` (spike 10 item 6, 4/4). Kit starts are in no such job (the start-file path is in no job; a double-click on the exe runs in a job with `BREAKAWAY_OK` only, without kill-on-close). It is the class "apply killed after `started`": `applying/` stays and rule 1 or "Continue the update" resumes (owner 2026-11-24, S-P1-11) | spike 10 DD5 | R1 |
| `update.log` events of the hand-off | `r1-app <os> <event> version=<v> [<field>…] t=<…>` with `<event>` one of `handoff-refused` (`reason=` `read-only`, `full`, `policy-managed`, `policy-invalid`, `damaged`, `lock-failed`, `working-copy-lost`), `handoff-spawned`, `handoff-started` (`ms=<n>`), `handoff-no-ack`, `handoff-failed` (`class=`), each with `code=` when a message is shown | F-11, W-6 | R1 |

### 5.5 The apply script and its journal (table B.4; W-21)

The apply scripts ship in every update file and are replaceable, but frozen code starts them (F-6,
F-7) and they must converge on every state an R1 writer leaves. One on-disk state machine serves both
twins: an apply interrupted on Windows may be resumed by `apply.sh` on a Mac after the drive moved,
and the reverse (T7.10's shared fixtures).

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Arguments | `apply.cmd <pid>` / `apply.sh <pid>` from the app; `apply.cmd resume` / `apply.sh resume` from a start file. The script never takes a path argument: root = its own folder's grandparent (`%~dp0..\..\`; bash `$(cd "$(dirname "$0")/../.." && pwd)`) | F-6, F-7 | R1 (R1 starts it so) |
| First action | create `updates/applying/started` (before the lock) | W-6 | R1 (R1 waits for it) |
| Lock, cmd | the whole run inside `9>"%~dp0apply.lock" (call :main %*)` (or a multi-line block with `)` on its own line; on one line `( … do rem )` swallows the `)` and cmd exits 255 without the lock, spike 10 item 4). A second instance tests `2>nul (9>>"%~dp0apply.lock" (call ))`: failure = a live holder. The handle dies with the process (kill, `taskkill /T /F`, unplug: no stale state). A console child of the holder would inherit handle 9 and keep the lock, so the apply starts no console program and starts the new app with `start` (a `start`ed child does not inherit it) | W-21; spike 10 DD6 (a) | Scripts |
| Lock, bash | `mkdir updates/applying/apply.lock.d` succeeds = taken; then `owner` is written (`pid <$$>`, `os <os>`, `boot <boot>`, `lstart <ps -p $$ -o lstart=>`). A failing `mkdir` with a readable `owner`: live only when `os` and `boot` (±300 s) match this computer, the PID is alive and `ps -p <pid> -o lstart=` equals `lstart`; otherwise stale: remove the directory and take it. `LC_ALL=C` and `TZ=UTC` are exported before any `ps` (one live PID reads 01:11, 09:11 or 00:11 under three `TZ` values). cmd ignores `apply.lock.d`; bash ignores the `apply.lock` file | W-21 (GAP-5) | Scripts |
| Markers on the lock | a resume that finds a live holder deletes the highest-numbered `launch-<n>` (the one its start caused) and exits; the instance that takes the lock deletes every `launch-<n>` and `finish-<n>` (progress, W-7) | W-7, W-6 | Scripts (R1 counts on it) |
| Wait, Windows | the rename retry alone: the first move out of the root (the system's root artifact whose version ≠ `to`) is retried until it succeeds, `budget × 250` attempts of a `for /l` delay (release 1's twins; T7.2 records the measured rate of the loop it ships). A successful rename implies the old app's process is gone and the stub's unpack folder deleted, for both stub builds (spike 1: 56 of 57 runs in the same 25 ms poll, the order resting on electron-builder's `portable.nsi`). Exhausted → `timeout` | spike 1 DD3; W-21 | Scripts |
| Wait, macOS and Linux | only when `handoff.txt`'s `os` is this system, its `boot` is within ±300 s of this computer's (`sysctl -n kern.boottime` / `/proc/stat` `btime`), and the last `/`-separated part of `ps -p <pid> -o comm=` is `HilbertRaum` (`executableName`, pinned by W-15 (v)); then while all three hold, at most `budget` seconds (or longer, never shorter). Exhausted → `timeout`. Pending spike 4a (T1.6) and spike 3 (P11a) for `comm` | W-21 | Scripts |
| Systems an apply moves | forward: each system whose `from-<os>` is not `none` (the apply installs only systems already on the drive, G-36); `back` and `fallback`: each system whose `from-<os>` is not `none` | W-21 | Scripts |
| Move order, per system | systems in the order `win32`, `darwin`, `linux`; for each: (a) forward only: delete from `previous/` every artifact of that system whose version is neither `from-<os>` nor `to` (only the immediately previous set stays); (b) **out**: move every root artifact of the system whose version is not `to` into `previous/` (a root `*.app` has no version and always moves); (c) **in**: if the root lacks `to` for the system, move it from its source: forward `updates/staging/<to>/files/` (the member `staged.txt` lists for that system, to its `install_as` name where the payload gives one), `back` and `fallback` `updates/previous/`. Out first: a stop between (b) and (c) leaves an empty root, which rule 2 repairs, never two artifacts (CE-D9). `previous/` never receives an artifact of version `to`. Every move is `move /y` (cmd) / `mv -f` (bash), judged by the existence of source and target, never by an exit code | W-21 duty 3 | Scripts |
| Start files | a drive with no start file at the root (every `prepare-drive` drive) gets the new ones before any artifact moves; otherwise after the swap: each replaced start file moves to `previous/`, each new one is copied to `<name>.new` and renamed over the root name (never written in place, never through a `.cmd` that is running). Then `step-launchers` | W-21 | Scripts |
| Artifact versions from names | Windows `HilbertRaum-<v>-portable.exe`; macOS `HilbertRaum-<v>-mac-arm64.app.zip` (a root `*.app` is `unknown`); Linux `HilbertRaum-<v>.AppImage`. Root globs as R1's start files use them (F-18) | F-18 | R1 (the globs) |
| The new app's start | cmd starts the **artifact** (never a start file, never a `.cmd`) with `HILBERTRAUM_DRIVE_ROOT=<root>` (with its trailing `\`) and `HILBERTRAUM_MANIFESTS_DIR=<root>model-manifests` set, in the same parenthesised block as the self-delete `(goto) 2>nul & rmdir /s /q "<root>updates\applying"`; bash first removes `updates/applying/` (a running bash survives its file and cwd going), then macOS `open "<root>/Start HilbertRaum.command"`, Linux `exec` of the AppImage with the same two variables and with `APPIMAGE`, `APPDIR`, `OWD`, `ARGV0` and the old image's `$APPDIR` entries in `PATH`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR` removed. **OPEN (T1.11 S10-2, spike 10b)**: the cmd self-delete form is measured only with `LockBatchFilesWhenInUse` = 0; spike 10b (`impl/p1/T1.4b/`) measures it at 1 | W-21 (CE-1, GAP-1); T1.11 S10-2 | Scripts; the rule below is R1's |
| **CE-1 rule** | no journal state starts a start file, an app or a resume while `updates/applying/` exists; every terminal state removes `applying/` first (bash) or in the same parsed block (cmd) and starts an app; `timeout` is not terminal and starts nothing | W-21 (CE-1, duty 1) | R1 (R1's rule 1 and R1's removal rule depend on it) |
| cmd rules | ASCII only, CR LF (`.gitattributes` lists `launchers/apply/*.cmd`); `set "COPYCMD="` first; only built-ins (`ren`, `move /y`, `if exist`, `set`, `>`/`>>`, `rmdir`, `for`, `call`, `start` of the GUI artifact): no console program at all (no `ping`, `timeout`, `tasklist`, `find`, `chcp`, `wmic`, PowerShell), since each opens a visible window from the detached cmd (spike 10 item 7: 4 windows for 3 `ping`s and a `chcp`); the delay is a `for /l` loop; every output line puts its redirection first (`>>"file" echo …`); no pipeline; never `start` a `.cmd` (it runs `%ComSpec% /K`: a window that never closes, and with a missing `ComSpec` the script ends there); a resume started by a start file inherits that start file's environment unfiltered, so the `COPYCMD` rule is required; files cmd writes are in the ANSI code page (start files: OEM), so no line another script or the app parses carries a path; `for /f` only over a file of this section, never over a program's output; never `pause`, never parse JSON, never hash (C12) | W-21; spike 10 DD6 | Scripts |
| bash rules | a POSIX-sh preamble re-execs the script under bash when bash exists (the lookup may start it with `/bin/sh`); bash 3.2 syntax; closes every descriptor above 2 first; `LC_ALL=C` and `TZ=UTC` before any `ps`; `sync` after each journal step | W-21 | Scripts |
| `update.log` events | `apply-<version> <os> <event> [<field>…] <time>` with `<event>` one of `started`, `lock-busy`, `waited` (`attempts=` or `s=`), `journal`, `moved` (`os=`, `dir=out` or `in`), `launchers`, `result` (`code=`), `timeout`, `io-error`, `aborted`, `start` (`os=`) | F-11 | Scripts |

**The journal states (table B.5).** `<v>` is `handoff.txt`'s `version` (the apply's own), `to` and
`from-<os>` come from `journal.txt`.

| State | What is on disk | Who may resume it | Next |
|---|---|---|---|
| **J0 handed off** | `applying/` with `handoff.txt` and the copied scripts; no `started` | R1 rule 1; "Continue the update" (R1 or later); the version's own start (W-21 duty 6) | J1 |
| **J1 acknowledged** | J0 + `started`; no `journal.txt` | any instance that takes the lock | the wait, then: `fallback` with any `confirmed/<v>-*` present → **T-aborted**; forward with a carried system that staging lacks → **T-refused**; else write `journal.txt` → J2. Wait exhausted → `timeout` (stays J1) |
| **J2 journal open** | J1 + `journal.txt` | the lock holder | forward: write `unconfirmed.txt` (`<to> <token>`) unless any `confirmed/<to>-*` exists (CE-D5), read it back; failure → **T-io-error** with nothing moved. A drive without start files: install them, `step-launchers`. Then J3 |
| **J3 swapping** | J2 + some systems moved (root and `previous/` mixed, per the move order) | the lock holder, after a resume, on either system | each move done or skipped by version; a move that fails for good → **T-io-error**; all systems at `to` → J4 |
| **J4 swapped** | every moved system's root holds exactly `to`; no `step-launchers` | the lock holder | start files replaced, `step-launchers` → J5 |
| **J5 start files done** | J4 + `step-launchers` | the lock holder | forward: `applied/<to>.json`, `applied/<to>.dsse.json` (a copy of `updates/staging/<to>/hilbertraum-release.dsse.json`); append the result line (`applied` forward, `went-back` back, `fallback` fallback; version `<v>`); `back` and `fallback`: remove `confirmed/<v>-*`, `unconfirmed.txt` when it names `<v>`, and `launch-count.txt`; then `step-result` → J6 |
| **J6 recorded** | J5 + `step-result` | the lock holder | forward: remove `updates/staging/<to>/`; the start → **T-done** |
| **timeout** (not terminal) | J1 + a `timeout <v> <token>` line | the next start (rule 1, "Continue the update") | J1 |
| **T-done** | `applying/` gone; root at `to`; the line written | — | the new version starts (forward) or the target starts (`back`, `fallback`) |
| **T-refused** | `applying/` gone; nothing moved; `incomplete <v> <token>` | — | the root's version starts and shows the notice |
| **T-io-error** | `applying/` gone; moves made so far reversed by version (`to` out, each `from-<os>` back in), `unconfirmed.txt` removed when it names `to`; `io-error <v> <token>` | — | the root's version starts and shows the notice |
| **T-aborted** | `applying/` gone; nothing moved, no line | — | the root's version starts (W-21 duty 5, CE-D1) |

A version that starts with its own `applying/` present (killed after the swap, then a bare start)
continues it through its own resume (the F-6 path), and removes `applying/` itself only in J6, when
every system the journal names is at `to` (W-21 duty 6, CE-D10). A reverse apply that finds its swap
already done (J4 or later) never moves anything back in (CE-D4).

### 5.6 The start files (table B.6; F-7)

**The order** in release 1's three start files, after the root and the two variables are set:
(0) `/check` (`--check` in bash) → report and exit 0, before any rule: it starts, moves and writes
nothing; (1) rule 1; (2) the counter; (3) rule 2; (4) rule 3, the #235 refusal; (5) start the root's
app as today. The `.cmd`'s head is `setlocal enableextensions disabledelayedexpansion`, then
`set "COPYCMD="` (W-7 (c)).

**Rule 1, `Start HilbertRaum.cmd`** (frozen text, spike 10 DD2: 11 roots × NTFS and exFAT, ShellExecute
and `explorer.exe`; the read-on probe showed no line read after the `start`). The Japanese-locale VM
leg (P11a, owner 2026-11-24, Δ-30; T1.11 S10-3) re-runs it:

```
set "N="
if exist "%~dp0updates\applying\apply.cmd" (
  if not exist "%~dp0updates\applying\launch-1" (set "N=1") else if not exist "%~dp0updates\applying\launch-2" (set "N=2") else if not exist "%~dp0updates\applying\launch-3" set "N=3"
)
if defined N (
  >"%~dp0updates\applying\launch-%N%" type nul
  if exist "%~dp0updates\applying\launch-%N%" (
    start "" /min /d "%~dp0updates\applying" "%SystemRoot%\System32\cmd.exe" /d /c .\apply.cmd resume
    exit /b 0
  )
)
```

**The fall-through**, right after that block, when `"%~dp0updates\applying\"` exists: one `update.log`
line `r1-launcher win32 launcher-fallthrough reason=<r> code=UPD-LAUNCH-FALLTHROUGH d="%date% %time%"`
with `<r>` = `no-script` (no `apply.cmd`), `marker-not-created` (`N` defined: a read-only or full
drive) or `markers-used` (three markers), then the message `UPD-LAUNCH-FALLTHROUGH` (below), no pause,
and on to the counter. Known limit (W-7 (e), spike 10): under a drive path holding `%<a defined
variable>%`, or `!` with `^` on a host with `DelayedExpansion=1`, no line of any `.cmd` start file runs;
the app, started as the bare exe, finishes the update through "Continue the update".

**Rule 1, `Start HilbertRaum.command` and `start-hilbertraum.sh`** (from W-7; pending spike 4a, T1.6,
and P11a's spike 3; `$DIR` is the root as both files set it today):

```
N=""
if [ -f "$DIR/updates/applying/apply.sh" ]; then
  for n in 1 2 3; do
    if [ ! -e "$DIR/updates/applying/launch-$n" ]; then N="$n"; break; fi
  done
fi
if [ -n "$N" ] && : > "$DIR/updates/applying/launch-$N" 2>/dev/null && [ -e "$DIR/updates/applying/launch-$N" ]; then
  SH=/bin/sh
  for c in /bin/bash /usr/bin/bash; do if [ -f "$c" ] && [ -x "$c" ]; then SH="$c"; break; fi; done
  (cd "$DIR/updates/applying" && nohup "$SH" ./apply.sh resume </dev/null >/dev/null 2>&1 &)
  exit 0
fi
```

followed by the same fall-through (`r1-launcher <os> launcher-fallthrough reason=<r> code=… t=<UTC>`, the
message, on to the counter). bash reads the whole `if … fi` compound before it runs it, so, as in the
`.cmd`, no line after the block is read once the resume is started.

**The counter** (frozen in release 1; F-7, W-7 (d), (d0), T7.11):

| Value | Exact value |
|---|---|
| When it acts | all of: `updates/applying/` absent; `updates/unconfirmed.txt` has a valid first line whose version (`UV`) consists only of `[0-9A-Za-z.+-]` (any other version: the counter does nothing; the app removes the file, §5.7); the root holds exactly one artifact of this system |
| In flight, Windows | the root artifact is held by a stub: the write-open `2>nul (>>"<root exe>" (call ))` fails → an instance of this drive's app is running or starting: no count (`counter-skip reason=in-flight`), go on. **OPEN (T1.11 S1-2, spike 1b)**: spike 1b (`impl/p1/T1.1b/`) measures whether the exe stays held for the whole start, the extraction and the AV sandboxing of a never-seen build included, and whether this probe or another one is the one to freeze |
| In flight, macOS and Linux | no probe in release 1 (CC-20); later start files keep `updates/starting-<os>` |
| The apply's own start | never counted: the apply starts the artifact, never a start file (§5.5) |
| Count | `n` = `launch-count.txt`'s count for `UV` (§5.3) + 1, at most 3, rewritten as `<n> <UV>`; a failed write means no count; log `counter n=<n> version=<UV>` |
| At `n` = 3 (i) | any `updates/confirmed/<UV>-*` exists → message `UPD-LAUNCH-CANT-START`, log `counter-stop reason=confirmed version=<UV> code=UPD-LAUNCH-CANT-START`, on to rule 2 (T7.11, CE-F5) |
| At `n` = 3 (ii) | else, when the root artifact's name carries `UV` and `updates/previous/` holds exactly one artifact of this system whose name does not carry `UV` → **the counter fallback**: (1) append `fallback <UV> <token>` to `last-result.txt` (a failure ends here, nothing moved); (2) move the root artifact into `previous/`; (3) move the other one from `previous/` to the root (rule 2 finishes a torn (3) at the next start); (4) delete `unconfirmed.txt` and `launch-count.txt`; log `counter-fallback version=<UV>`; prints nothing; on to rule 2. This is how "never a version newer than the root's" is kept without comparing versions in cmd: the counter restores only away from the version `unconfirmed.txt` names, and only a forward apply writes that file, naming a version it installed over the one it moved into `previous/` |
| At `n` = 3 (iii) | else → message `UPD-LAUNCH-NOTHING-TO-RESTORE`, log `counter-stop reason=nothing-to-restore version=<UV> code=UPD-LAUNCH-NOTHING-TO-RESTORE`, on to rule 2 |
| Pause | cmd: `pause` after `UPD-LAUNCH-NOTHING-TO-RESTORE` and after `UPD-LAUNCH-CANT-START`, then on to rule 2 and the start; none after the fall-through (the app that starts next offers "Continue the update"); the bash files never wait (Terminal keeps its window) (owner 2026-11-24, Δ-31) |

**Rule 2** (frozen): the root has no artifact of this system and `updates/previous/` holds one or more:
the one to restore is the only one, or, with two or more, the only one whose name does not carry
`unconfirmed.txt`'s version; none chosen → no restore. It is moved to the root (`move /y`, judged by
`if exist` on source and target); if the move fails (a read-only drive mid-swap), the start file starts
it where it lies in `updates/previous/`, with `HILBERTRAUM_DRIVE_ROOT` and `HILBERTRAUM_MANIFESTS_DIR`
set as for a root start (W-7 (d0)). Log `launcher-restore` or `launcher-restore-in-place`. It prints
nothing and writes no `last-result.txt` line (later start files write `restored`, W-7).

**Rule 3** (frozen): two or more root artifacts of this system → today's #235 refusal, unchanged, then
two added lines (UX-20, below), `pause` (as today), exit 1; log `launcher-two-apps`.

**The lines release 1's start files print** (table B.7). ASCII English, two spaces of indent, at most
76 characters per line, no `(`, `)`, `&`, `|`, `<`, `>`, `^`, `%`, `!` or `"` (so a line is safe inside a
cmd block), an empty line before and after each message, each message ending with
`See READ ME FIRST.txt on the drive.`; the same text in all three files; English only, with the
German steps in `READ ME FIRST.txt`'s UPDATES block (T7.D) (owner 2026-11-24, Δ-31; C10).

| Code (logged) | When | Exact lines |
|---|---|---|
| `UPD-LAUNCH-FALLTHROUGH` | rule 1 fell through | `  The update in progress could not continue from here.`<br>`  Your workspace is unchanged. See READ ME FIRST.txt on the drive.` |
| `UPD-LAUNCH-NOTHING-TO-RESTORE` | counter (iii) | `  HilbertRaum did not open properly after three tries, and no earlier`<br>`  version on this drive can be started instead.`<br>`  Your workspace is unchanged. See READ ME FIRST.txt on the drive.` |
| `UPD-LAUNCH-CANT-START` | counter (i) | `  This version of HilbertRaum did not open properly after three tries,`<br>`  but it has opened before. Use the computer where it opened.`<br>`  Your workspace is unchanged. See READ ME FIRST.txt on the drive.` |
| (no code) | rule 3, after today's refusal text | `  If this appeared after an update, do not delete anything yet.`<br>`  See READ ME FIRST.txt on the drive.` |
| (no code) | `/check`, after today's `  App        : …` line | `  Update log :` followed by `updates/update.log` verbatim (cmd `type`, bash `cat`), or `  Update log : none on this drive` |

Every other line the three files print is today's text at `95e05214`, unchanged (`Start HilbertRaum.cmd`
`:35-39`, `:47-54`, `:62-68`; the `.command` `:53-57`, `:66-76`, `:81-91`, `:100-103`, `:129`,
`:140-150`, `:156-160`, `:179-188`, `:207-211`, `:222-226`, `:240-244`; `start-hilbertraum.sh` `:36-39`,
`:46-55`, `:60-66`).

### 5.7 Confirmation and the offers at a start (table B.8; F-22, F-19)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| When an app confirms | when its first window shows ("window up", not the process start), per system, before anything else changes (W-26) | F-22 | R1 (T7.5a) |
| `applying/` exists | nothing recorded: no `confirmed/` file, no count reset, no `drive-release.json` write; "Continue the update" is offered | F-22 (PA-241) | R1 |
| `unconfirmed.txt` names this app's version `V` | create `updates/confirmed/V-<os>` (empty); delete `updates/launch-count.txt` and every `updates/launch-count-*.txt`; when every system with a root artifact has its `confirmed/V-<that os>`, delete `unconfirmed.txt`; when this start created `confirmed/V-<os>` newly, show `UPD-UPDATED` once | F-22, W-26 (C-6) | R1 |
| `unconfirmed.txt` names a version at no root | delete it and `launch-count.txt` (stale; a root `*.app` carries no version here). A damaged `unconfirmed.txt` (no valid first line) is deleted the same way | F-22 | R1 |
| Which systems "have a root artifact" | by R1's root globs: `win32` `HilbertRaum-*-portable.exe`; `darwin` a `*.app` folder or `HilbertRaum-*-mac-arm64.app.zip`; `linux` `HilbertRaum-*.AppImage` | F-18 | R1 |
| A write that fails | nothing changes; the next start tries again | F-22 | R1 |
| R1 and `drive-release.json` | R1 never writes it, so R1's confirmation writes no `app_version` (F-13); a later version writes it after its own confirmation (§6.9) | F-13 | R1 |
| "Restart and update" offered | a staged update (table A: `staged.json` and every listed file present) whose version passes F-4 for the running version, is not named by the last valid `last-result.txt` line with a code outside `applied`, `cleared`, while `updates/applying/` is absent | F-19, W-51 | R1 |
| A re-import clears the mark | when a commit stages version `v` (table A) and the last valid `last-result.txt` line names `v` with a code outside `applied`, `cleared`, R1 appends `cleared <v> <token>` (the plan's "clears that version's mark" in a file nothing deletes; the model writes the same line) | W-5, F-20 | R1 |
| An import while `applying/` exists | refused before the file is read: `UPD-IN-PROGRESS`, with "Continue the update" offered | F-5, F-19 | R1 |
| Older than the drive | a root artifact of this system whose name carries a version newer than the running one (F-4 order; a root `*.app` never counts) → `UPD-OLDER-THAN-DRIVE` with Quit as the action, writing nothing; checked at a drive-aware start before `ensureWorkspaceDirs` and `workspace.init()`, on `second-instance`, on `activate` and before unlock | F-19, W-51 | R1 |
| One notice at a time | priority: a hand-off or apply failure (`helper-blocked`, `io-error`, `timeout`) > an outcome (`fallback`, `blocked`, `restored`, `incomplete`, `went-back`, an unknown code) > an offer ("Continue the update", "Restart and update", older than the drive) > a reminder (G-37 (a)) | W-51 (a) | R1 |

### 5.8 Outcome codes and reference codes (table B.9; F-20, G-37)

**`last-result.txt` codes.** The version field is always the apply's own version (`handoff.txt`'s
`version`), also for `fallback` and `went-back`, so "don't offer again" names the version that failed or
was left.

| Code | Writer | Release 1 shows | Offer again? |
|---|---|---|---|
| `applied` | a forward apply, in J5 | nothing (the new version shows `UPD-UPDATED` at its confirmation) | yes (success) |
| `cleared` | R1's app, at a re-import of a marked version (§5.7) | nothing | yes (success) |
| `fallback` | a later version's fallback apply (J5); R1's counter fallback (§5.6) | `UPD-FALLBACK`; `UPD-FALLBACK-AGAIN` when the `fallback` and `blocked` lines naming that version number two or more in the 65,536 bytes R1 reads (F-20) | no |
| `went-back` | a reverse ("Go back") apply, in J5 | `UPD-WENT-BACK` | no |
| `incomplete` | a forward apply (T-refused) | `UPD-INCOMPLETE` | no |
| `timeout` | an apply whose wait ran out (not terminal) | `UPD-TIMEOUT` | no |
| `io-error` | an apply after its rollback (T-io-error) | `UPD-IO-ERROR` | no |
| `helper-blocked` | R1's app (a failed spawn, no acknowledgement, the `finish-3` cap) | `UPD-HELPER-BLOCKED`, with "Continue the update" labelled "Try again on this computer" while `applying/` exists | no |
| `blocked` | a later start file, when starting the app returns access-denied or a code-integrity error | `UPD-BLOCKED` | no |
| `restored` | a later start file's rule 2 after a confirmed update | `UPD-RESTORED` | no |
| any other code | a later writer | `UPD-UNKNOWN-RESULT` (the generic copy with `{code}`) | no |

**Reference codes** (G-37 (a), W-51 (b)). Each frozen update message has one code, never reused for
another message: `UPD-` followed by upper-case words of `[A-Z0-9]` joined by `-`, at most 32 characters.
The app shows it as the muted last line "Reference: UPD-…" inside "Details for support"; `update.log`
records it as `code=UPD-…`; the project page has one anchor per code. Each message has two copy keys,
`<prefix>.text` (the message) and `<prefix>.help` (its in-app "What you can do" paragraph, G-37 (c));
their texts are copy deck part 2's (T1.10; the English sources of the outcome codes are in the plan's
working papers). The start files' three codes have no copy key: their text is §5.6's.

| Code | Message | Copy key prefix |
|---|---|---|
| `UPD-UPDATED` | "Updated to version {n}", once, at the confirmation | `updates.outcome.updated` |
| `UPD-FALLBACK` | the new version didn't start; the previous one is back; "Try again" | `updates.outcome.fallback` |
| `UPD-FALLBACK-AGAIN` | the second `fallback` of one version: security settings may be the cause | `updates.outcome.fallbackAgain` |
| `UPD-WENT-BACK` | back on the version the user chose | `updates.outcome.wentBack` |
| `UPD-INCOMPLETE` | the update file lacks a system this drive carries | `updates.outcome.incomplete` |
| `UPD-TIMEOUT` | the previous version didn't close in time | `updates.outcome.timeout` |
| `UPD-IO-ERROR` | the drive couldn't be written during the update | `updates.outcome.ioError` |
| `UPD-HELPER-BLOCKED` | the update couldn't start on this computer | `updates.outcome.helperBlocked` |
| `UPD-BLOCKED` | this computer's security settings stopped the new version | `updates.outcome.blocked` |
| `UPD-RESTORED` | the newer version's files were missing; the previous version started | `updates.outcome.restored` |
| `UPD-UNKNOWN-RESULT` | the last update attempt didn't finish (code `{code}`) | `updates.outcome.unknownResult` |
| `UPD-RESTART` | the restart dialog (what happens, how long, don't unplug) | `updates.restart.dialog` |
| `UPD-RESTART-TASK-RUNNING` | text recognition or a translation is running or waiting | `updates.restart.taskRunning` |
| `UPD-RESTART-UNSAVED` | changes that couldn't be saved | `updates.restart.unsaved` |
| `UPD-FILE-DAMAGED-ON-DRIVE` | the re-hash before the restart refused the staged update | `updates.restart.damagedOnDrive` |
| `UPD-NOT-DRIVE-APP` | this copy isn't the drive's app: start HilbertRaum on the drive to install this update (§5.4) | `updates.restart.notDriveApp` |
| `UPD-DRIVE-READ-ONLY` | the drive can't be written (pre-check at the import and the restart) | `updates.drive.readOnly` |
| `UPD-DRIVE-FULL` | the drive is full (pre-check at the import and the restart) | `updates.drive.full` |
| `UPD-READY` | a staged update: "Restart and update" and "Don't install this update" | `updates.offer.ready` |
| `UPD-CONTINUE` | an update in progress: "Continue the update" | `updates.offer.continue` |
| `UPD-IN-PROGRESS` | an import while an update is in progress | `updates.import.inProgress` |
| `UPD-OLDER-THAN-DRIVE` | this drive was updated to version {n}; start it on the drive | `updates.offer.olderThanDrive` |
| `UPD-POLICY-MANAGED` | updates are managed by your organization | `updates.policy.managed` |
| `UPD-POLICY-INVALID` | the update policy on this drive has an invalid value | `updates.policy.invalid` |
| `UPD-POLICY-UNREADABLE` | the policy file is unreadable (the import stays allowed) | `updates.policy.unreadable` |
| `UPD-NOT-AN-UPDATE` | not an update file | `updates.import.notAnUpdate` |
| `UPD-NOT-GENUINE` | the signature doesn't verify | `updates.import.notGenuine` |
| `UPD-TOO-NEW` | `UpdateTooNew`: a newer format or container, over a cap, the `HRUPDATE` prefix (§2.3, §4) | `updates.import.tooNew` |
| `UPD-UNKNOWN-SIGNER` | signed with a newer key: install the in-between update first | `updates.import.unknownSigner` |
| `UPD-NEEDS-IN-BETWEEN` | `min_upgrade_from` above the running version | `updates.import.needsInBetween` |
| `UPD-SAME-OR-OLDER` | the same or an older version than this one, or below the drive's version (F-4) | `updates.import.sameOrOlder` |
| `UPD-ABOVE-MAX-VERSION` | above `updates.max_version` | `updates.import.aboveMaxVersion` |
| `UPD-OS-TOO-OLD` | this computer is below the update's OS floor (G-24) | `updates.import.osTooOld` |
| `UPD-WRONG-CHANNEL` | not a release for this drive (G-22) | `updates.import.wrongChannel` |
| `UPD-FOR-NEWER-HILBERTRAUM` | a signed HilbertRaum file of another kind (G-30) | `updates.import.forNewerHilbertRaum` |
| `UPD-DOWNLOAD-INCOMPLETE` | the file ends before a listed member (F-16) | `updates.import.downloadIncomplete` |
| `UPD-FILE-DAMAGED` | the file's container or a member's hash doesn't match its signed list (§4.7) | `updates.import.damaged` |
| `UPD-FILE-TOO-BIG-FOR-DRIVE` | the drive can't hold a file this large (`EFBIG`: FAT32 and a member of 4 GiB or more) | `updates.import.fileTooBigForDrive` |
| `UPD-NO-HELPER` | no apply script for this system in the file | `updates.import.noHelper` |
| `UPD-NOT-AVAILABLE` | updates are not available in this build (an empty key set) | `updates.import.notAvailable` |
| `UPD-NOT-A-DRIVE` | this copy isn't running from a prepared drive (F-21) | `updates.import.notADrive` |
| `UPD-MAC-CACHE-COPY` | the macOS copy started from its cache: start HilbertRaum on the drive (F-21) | `updates.import.macCacheCopy` |
| `UPD-OLD-FILE` | the 12-month confirmation (`issued`) | `updates.import.oldFile` |
| `UPD-ISSUED-IN-FUTURE` | the warning for an `issued` date in the future | `updates.import.issuedInFuture` |
| `UPD-OTHER-SYSTEM-FLOOR` | the warning about the drive's other systems' OS floors | `updates.import.otherSystemFloor` |
| `UPD-AGE-REMINDER` | the age reminder (G-29) | `updates.reminder.age` |
| `UPD-SUPPORT-ENDED` | the end-of-support notice | `updates.reminder.supportEnded` |
| `UPD-SUPPORT-ENDED-LONG-AGO` | the reworded notice past `max(build date, support end)` + 3 years | `updates.reminder.supportEndedLongAgo` |
| `UPD-LAUNCH-FALLTHROUGH` | start file: rule 1 fell through (§5.6) | — |
| `UPD-LAUNCH-NOTHING-TO-RESTORE` | start file: the counter may not restore (§5.6) | — |
| `UPD-LAUNCH-CANT-START` | start file: the counter found a confirmation (§5.6) | — |

The import verdicts come from table A (§4.7). A later revision of the record may add codes, never
rename or reuse one.

### 5.9 "Copy details for support" (table B.10; F-14, W-16)

The copied text, frozen in release 1: ASCII English, LF, the first line `HilbertRaum support details`,
then one `<label>: <value>` line per field in this order; no path, no host or user name. It is run
through the log redaction, and a row asserts it comes back unchanged (W-16).

| Label | Value |
|---|---|
| `Reference` | the `UPD-*` code of the notice the button sits on, else `none` |
| `App version` | the running version |
| `System` | `<os> <process.getSystemVersion()> <process.arch>` |
| `Apps on the drive` | `<os>=<version>` for each root artifact (R1's globs, §5.7), joined by `, `; a root `*.app` is `darwin=unknown`; none: `none` |
| `Start files` | `Start HilbertRaum.cmd=<s>, Start HilbertRaum.command=<s>, start-hilbertraum.sh=<s>, READ ME FIRST.txt=<s>`, `<s>` = `same`, `different` or `missing` against the payload of `updates/applied/<running version>.dsse.json`, or `not checked` when that file is absent |
| `Drive release record` | `drive-release.json`'s `app_version`, `absent` or `unreadable` |
| `Support end` | `config/kit-support.txt`'s `YYYY-MM`, `absent` or `unreadable` |
| `Update policy` | `allowed`, `managed`, `max <version>`, `invalid value` or `unreadable` |
| `Staged update` | the staged version or `none` |
| `Update in progress` | `no`, or `yes version=<v> launches=<0-3> hand-offs=<0-3> started=<yes or no>` (from `handoff.txt`, `launch-<n>`, `finish-<n>`, `started`) |
| `Unconfirmed` | `unconfirmed.txt`'s version, `damaged` or `none` |
| `Last update results` | `none`, or the last 3 valid `last-result.txt` lines, each on its own line indented by two spaces |
| `Update log (last 40 lines)` | `none`, or the last 40 lines of `update.log`, each indented by two spaces |
| `Free space` | decimal bytes, then ` bytes` |
| `Drive writable` | `yes` or `no` (§5.4's probe) |

### 5.10 Other values the protocol tables name (table B.11)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| The build-date file | `apps/desktop/src/main/services/updates/build-date.json`, beside `keys.json`; generated by the build, never committed (git-ignored); one JSON object `{"commit_date":"<YYYY-MM-DDTHH:MM:SSZ>"}`, the release commit's committer date in UTC; embedded into the main bundle at build time, and the release guard checks the packed value against the tag (§2.7). Read only by the build that carries it; a later version may change its own. Missing or malformed: the age reminder and the support notices stay silent | W-17, W-3 | R1 (its own reading) |
| `drive-release.json`, the reader's types | UTF-8 JSON, one leading byte-order mark removed, one object, at most 65,536 bytes (larger = malformed = absent); `app_version` a SemVer string, else absent; `format` an integer ≥ 1, logged only, else ignored; `highest_version_seen` a SemVer string, reserved (§8.5); every other field, `systems` and `files[]` included, never read by R1 | F-13 | R1 |
| `drive-release.json`, every writer | UTF-8 without a byte-order mark, LF; unknown fields kept; `app_version` as §8.5 says | F-13 | R1 (later writers keep it) |

### 5.11 Cases the tables were checked against

- **A first start that shows nothing for ~46 s** (S-P1-13; 39 to 70 s measured, T1.11 C-7) during which
  the buyer double-clicks one to three times. During vB's first start R1's start files are in
  `previous/` (the apply replaced them before it started vB, CE-1), and the apply's own start is not a
  start-file start, so R1's counter never sees it. Later start files skip a start while one is in
  flight (W-7 (d)); a fallback armed anyway re-reads the confirmation after its wait and aborts
  (T-aborted, W-21 duty 5, CE-D1); the confirmation comes at window up. R1's own counter meets such a
  start only when R1's start files sit at the root while `unconfirmed.txt` names the version at the root,
  that is after a forward apply that could not replace them; there its Windows in-flight probe decides
  (**OPEN (T1.11 S1-2, spike 1b)**), and on macOS and Linux release 1 has no probe (CC-20), a recorded
  residual of that rare state.
- **Both stub builds** (today's per-build `%TEMP%` folder and #1043's per-start one): no table value
  depends on which one ships. The Windows wait is the rename (spike 1: both builds); `budget 30` covers
  both; spike 1b measures the in-flight probe on both.
- **The other twin and the other system:** `journal.txt` holds no system-specific value; every move is
  by version; `os` and `boot` (±300 s) only gate the wait; `LC_ALL=C` and `TZ=UTC` before `ps`; cmd
  ignores the bash lock and bash the cmd one; both read CR LF and LF.
- **A version from 2035** meeting release 1's files: every file R1 writes (`handoff.txt`, `finish-<n>`,
  `launch-<n>`, `launch-count.txt`, its `last-result.txt` lines, `last-result.seen`,
  `confirmed/<v>-<os>`) has a grammar here; every R1 reader ignores unknown keys, fields and lines and
  maps an unknown code to the generic notice (G0, §5.8); R1's rewrite of `handoff.txt` keeps the keys it
  does not know.
- **The staged name** (S-P1-14): table A (§4).

### 5.12 Owner decisions and open values of table B

Decided by the owner on 2026-11-24 (ledger Δ-31), each as recommended:
1. **The running app is not a root artifact** (T1.11 S10-1): "Restart and update" and "Continue the
   update" are refused before the lock with `UPD-NOT-DRIVE-APP`; the import and the staging stay allowed
   (§5.4). The alternative, handing off anyway, would end in a state nobody tested, on a frozen path.
2. **The counter messages wait for a key** on Windows (`pause`); the fall-through does not; bash never
   waits (§5.6). On Windows these lines are the whole UI of that state (UX-18).
3. **English only** in the start files; `READ ME FIRST.txt`'s UPDATES block (T7.D) carries the steps in
   English and German (§5.6, C10).

Open (T1.11): F-7 (d)'s Windows probe, `OPEN (T1.11 S1-2, spike 1b)`; the cmd self-delete form and R1's
reliance on it, `OPEN (T1.11 S10-2, spike 10b)`. The bash hand-off and the bash rule 1 are pending spike
4a (T1.6) and P11a's spike 3.

---

## 6. Drive content, engines, first start

_Status: planned (P8), except the parts marked as built on master. Release 1 carries P8, so the
precedence of §6.2, the ownership rule of §6.3, the engine-folder rules of §6.6 and the notice of §6.4
ship in the oldest sold version and freeze there._

### 6.1 What freezes here

- G-3's precedence: app-owned model definitions and skills from the app's own bundle (§6.2);
- the reconcile's ownership rule and the format of its owned-hash table (§6.3);
- the engine pin-folder lookup, and how release 1 treats a `runtime/<family>/<os>@<pin>/` folder a
  later version left behind after "Go back" (§6.6);
- the "new models are available" notice (§6.4);
- the AI engine installer's call of the OS `tar`: its child inherits the full environment today, and
  GNU tar honors `TAR_OPTIONS`; P8 scrubs the environment or records the residual.

### 6.2 Model definitions and skills come from the app (G-3)

- The app reads its **app-owned** model manifests from its own bundle (`extraResources`). The drive's
  `model-manifests/` becomes a mirror plus a user overlay: the start files set
  `HILBERTRAUM_MANIFESTS_DIR` to `<root>/model-manifests`, and the new version reads that folder as the
  overlay, never as the authority for an app-owned id. The model list is then never stale after an
  update, a failed refresh or a copied app.
- **The cost for DIY users:** a user who edited a built-in model entry on the drive loses that edit; to
  keep one, copy it under a new id. The model docs say so.
- **App skills** are bundled too. The new version **leaves the drive's `app-skills/` as the Kit shipped
  it**: release 1 reads it after any "Go back", and nothing but the sell gate reads it otherwise. A
  skill of a new `kind` therefore never reaches release 1 (F-25).
- The start files, the drive docs, `READ ME FIRST.txt` and the notices are bundled as well, as the
  reconcile's source: after a hand-copied app there is no other source.

### 6.3 The reconcile and the ownership rule (W-25)

The new version refreshes the drive's mirror, start files, docs and notices under one rule:
- **Ownership evidence** is a table, built when the update file is built, of the sha256 of every
  released version of each owned file, from every release tag back to v0.1.0. A file whose hash is in
  the table for its path is "ours, unmodified" and may be replaced or removed. Anything else is left
  alone and logged. A file a user put back to an older shipped version on purpose reads as ours and is
  replaced (documented). A drive whose `docs/` mixes versions is reconciled file by file.
- It works for every drive in the field, including drives with no `drive-release.json` and copied apps.
- **A retired app-owned manifest is never removed while its model files are on the drive.** A model is
  retired with `download.withdrawn`, never by deleting its manifest.
- Everything the reconcile writes into the mirror is read by release 1 after any "Go back" and on a
  system still running release 1, so it obeys F-23 (§6.11): a manifest release 1 cannot validate only
  behind `min_app_version`.
- **App-owned chat manifests are refreshed all or nothing**: one file with a graphics-card rank flips
  the whole role to card ranking.
- The drive's `model-manifests/runtime-sources.yaml`, `DRIVE-NOTICES.md` and the kiwix source bundle are
  refreshed **together with the engine install** (§6.5): the sell gate, `fetch-runtime` and the notices
  read the drive's copy, and the license record must match the binaries on the drive.
- `app-skills/` is not mirrored (§6.2). The previous content set is kept for "Go back" (§6.10).
- Packaged builds only.

### 6.4 New models (G-30, W-74)

New models and changed model definitions reach a Kit with every content-changing app release: the new
version reads them from its bundle and refreshes the mirror. After the update it says once which
models the release added (name, size, and "needs internet to download" while offline); downloads go
through the existing per-model consent. A signed definitions-only or model-pack file is a later
follow-on; release 1 answers such a file with "for a newer HilbertRaum" (§2.4).

### 6.5 The AI engine after an update (G-31 (b), W-30, W-77)

- **The update file carries no AI engine by default.** Nothing engine-related is staged or moved, and
  the apply script has no engine step (U3).
- After the update, on the trigger below, the new version offers its engine:
  - **a download**: the existing consent (each archive's size, license and address), the internet
    switch, the audit events of the engine install;
  - **"Install AI engine from a file…"**, on the AI Model screen and in the "After the update" card:
    the user picks the archives they downloaded on another computer from the addresses the consent
    shows. The app copies each picked file onto the drive next to the pin folder, checks its size and
    sha256 against its **bundled** pins, refuses any other file, and installs it exactly as the
    download does. The user's original is never moved or deleted. No network is needed.
- Until its engine is installed, the new version keeps running on release 1's engine (G-35 (a)), so an
  offline Kit loses nothing it had. The card and the buyer notice say that the update also brings a new
  AI engine, which HilbertRaum downloads once when online or installs from a file, and that until then
  it keeps working with the current engine.
- **The trigger**, per system: a start on a computer of that system when this system has confirmed the
  new version (`updates/confirmed/<version>-<system>` exists) **or** no `updates/unconfirmed.txt` names
  the new version, and **never while `updates/applying/` exists**.
- **The escape hatch**: one release may still carry its engine archives in the update file, when an
  engine fix must reach offline Kits. Release 1 stages whatever the payload lists, so this needs no
  frozen change; that release builds the offline install from the staged archives.
- A copy placed by hand into the engine folder stays possible for DIY drives and IT departments
  (documented in [`troubleshooting.md`](troubleshooting.md)); the app cannot verify or version it.

### 6.6 Side by side, and the oldest pin (G-32 (a), G-35 (a))

- The new version installs its engine into a folder of its own, `runtime/<family>/<os>@<pin>/`, with
  its `cpu/` safety net inside (P8 fixes the spelling). It extracts into `<os>@<pin>.new/`, checks it,
  writes the install marker **inside** it, flushes every file, then renames it in one move. The next
  start deletes a `.new` it finds and offers the install again.
- **Release 1's `runtime/<family>/<os>/` is never moved or written while "Go back" is offered.**
  Release 1 reads only that folder (its path is fixed in code; nothing walks `runtime/<family>/`), so
  the sibling folder is invisible to it, and "Go back" and every restore by the start files find
  release 1 on its own engine.
- The new version runs its own folder when it is complete with a marker at its pin, else release 1's.
  "Complete" means the marker parses and every file its own `binaries` map records is a file inside the
  folder (a marker without the map: every required file of that build). Every delete removes the
  marker first.
- **`engine_min` is the oldest pin a supported Kit may run** (G-35 (a)). A release that updates
  release-1 Kits starts every sidecar on the engine it finds until its own is installed, choosing the
  arguments by the marker's version. The release ritual's per-pin-bump gate runs the new version's
  arguments on release 1's pin (§9.3). The lasting cost: the day upstream removes a flag release 1's
  pin needs, the release that drops it is a breaking release behind this gate, and the owner decides
  then.
- **The prune**: first `updates/previous/`, then release 1's `runtime/<family>/<os>/` per system, and
  only when `updates/unconfirmed.txt` is gone, every app at the root is the new version, and that
  system's new engine folder is complete with a marker at its pin. A later update's prune, under the
  same conditions, removes every pin folder but its own.
- **Space**: a second engine set per system until the prune, an estimated 150–200 MB per system; the
  hand-off's free-space check counts it.

### 6.7 Release 1's own engine install, as built (F-24, G-44)

Release 1's own online install, update and reinstall of its engine (into `runtime/<family>/<os>/`) are
**as built on master** (#986, PRs #991 and #1009; [`architecture.md`](architecture.md) "In-app engine
updates — design record" §6):
- every copy is staged before the pause: unpacked, checked against the verified archive's own member
  list, every file hashed into the marker's `binaries` map, flushed, marked last, then swapped per
  family by rename; the old copy is deleted only after the swap;
- the leftover names are `<os>.new` and `<os>.old` and, for the `cpu/` net, `<os>/cpu.new` and
  `<os>/cpu.old` inside the live folder; the start recovery touches only those exact names, so the
  pin folders of §6.6 are a different name it never touches;
- **the pre-spawn check covers every recorded file** (G-44 (a), #1012, PRs #1029 and #1035): before the
  first spawn of a session it hashes every file the copy's own marker records, the program first; a
  changed or missing file refuses the start with the reinstall offer; a damaged marker is its own
  verdict, never a fallback to the folder above;
- **not built, a documented residual** (G-44 (b)): starting a complete copy in place on a drive that
  cannot be written after an interrupted swap. Such a drive starts no engine until it is writable
  again; an encrypted workspace cannot be opened on it either.

The frozen marker rules for every later writer are in [`data-contracts.md`](data-contracts.md) (the
engine install marker): `binaries` stays a map of relative path to lower-case SHA-256 hex of every
file, anything new goes into a new top-level field, the marker stays one line under 64 KiB.

### 6.8 Engine signing and the voice engine

- **Code signing of the AI engines for Windows Kits** (G-28) is deferred by the owner, with one
  deadline: before the release side writes release 1's engine list (P5). Whatever is chosen, a
  signature is added inside the archive the pin names, before any marker is written, never in place on
  a drive; the signing record is a new top-level marker field; the marker's `version` keeps the
  upstream tag (release 1 orders only `bNNNNN` and dotted tags).
- **Mac and Linux voice-engine builds hosted by the project** (W-78): whisper.cpp publishes ready-made
  programs for Windows only, so the project builds `whisper-cli` from the pinned tag in CI (macOS arm64,
  Linux x64, CPU only), publishes the archives on a dedicated release whose tag does not start with
  `v` (§9.7), and adds them to the bundled `runtime-sources.yaml` **before the release-1 cut**, so
  release 1's own install and reinstall reach Mac and Linux Kits. The marker keeps the upstream tag
  `v1.8.6`; the builds are named "built by HilbertRaum from whisper.cpp v1.8.6".

### 6.9 The first start after an update

The new version's post-update steps, in this order (W-26):
1. **the confirmation**, per system, at the first window, before anything else changes (F-22, §5). No
   automatic fallback once any system has confirmed;
2. the reconcile (§6.3);
3. the engine offer for this system (§6.5);
4. "Updated to version {n}", shown once by the confirmation itself, so a fix-line release shows it too;
5. the prune (§6.6), the macOS cache prune and the staging leftovers;
6. `highest_version_seen` written (§8.5).

Also:
- **Re-verification**: a resume by the start files swaps by size only, so the new version re-hashes
  every root app and start file against the signed payload, which the apply keeps as
  `updates/applied/<version>.dsse.json`. It names the damaged app ("the macOS app on this drive is
  damaged") and offers a re-import. The running system's own exe is readable while its portable stub
  holds it.
- **Notices** (W-32): a withdrawn or repointed installed model; a missing active model; a user manifest
  whose id the bundle now ships (the bundle shadows it); a model the new engine cannot load or that
  needs a new file, which "must be downloaded again after the update", with its size.
- **The macOS cache prune** (W-31), after a confirmed Mac start, keeping the cache's contract: the cache
  is shared by every start and version, a folder `*.partial.<pid>` is never touched while its process
  runs, and the start file removes only dead partials of its own zip
  ([`drive-layout.md`](drive-layout.md)).
- **`drive-release.json`**: the new version rewrites `app_version` after its confirmation, keeps every
  unknown field and never touches `config/kit-support.txt` (§8.5).

### 6.10 "Go back to version {n}" (W-22)

Offered on the migration-error screen and in Settings by a version that an update installed; it returns
to the version kept in `updates/previous/`.
- It runs the apply in reverse: the apps and the previous content set. It **moves no engine**: release
  1's engine folder was never moved (§6.6), and the reverse apply only deletes half-extracted `.new`
  folders.
- Before the reverse hand-off the new version rewrites `drive-release.json` `app_version` to the target
  version (no script can: `cmd` parses and writes no JSON), so release 1's version rule accepts the fix
  line again. The restored content set never brings back an old `drive-release.json`.
- The restored content set keeps the manifests of models installed under the new version, so release 1
  can still list and delete their weights.
- **Not offered** while `updates/applying/` exists, when `updates/previous/` holds apps of mixed versions
  (its target is the version every system in `updates/previous/` carries), or once the workspace's
  version number has moved past what the target reads (§7.8). It **is** offered after the new version
  confirmed a good start on this system (this system's confirmation is enough, F-22); what a confirmed
  start stops is the **automatic** fallback (U7, owner 2026-11-24). It uses the same writability check and the same
  questions about unsaved changes and running text recognition as "Restart and update".
- After a "Go back" that stays, the new version's engine folders remain until a later update's prune;
  release 1 ignores them.

### 6.11 What release 1 reads that later versions change (F-23, F-24, F-25)

Three old-reader contracts are **as built on master** and freeze as they are; P2 adds their golden
"release 1 accepts / lists / ignores" fixture sets and their two reviews.
- **Model manifests (F-23)**, #847/#848: unknown keys ignored; a bad value of a known key or a missing
  required key drops the file with a log line; an unknown `role` or a `min_app_version` above the app
  (exactly `MAJOR.MINOR.PATCH`; anything else counts as newer) lists the file under "Needs a newer
  HilbertRaum", never selectable; a usable manifest always keeps its id over a same-id newer one
  ([`data-contracts.md`](data-contracts.md), "A manifest for a newer HilbertRaum").
- **The AI engine (F-24)**, #516/#842/#843/#873: pins only from the app's bundled
  `runtime-sources.yaml`; the version relation orders `bNNNNN` and dotted tags (`older` → the update is
  offered; `newer` → never replaced, started anyway; any other shape → `unknown`, reported, never
  updated); a reinstall replaces with the pin whatever the relation; the yaml validator is whole-file;
  and §6.7.
- **Skills (F-25)**, #846: app skills read from the drive's `app-skills/` only; `kind` is the closed set
  `instruction` / `tool`, checked before `compatibility.minAppVersion`; `skills.disabled_reason`
  records why a row is off, and the reconcile re-enables only `min_app_version` on a known app version;
  a vanished or invalid folder marks its row unavailable, never deletes it.

**Release rules for changing definitions** (W-62), written into [`model-policy.md`](model-policy.md) by
P2: a per-pull-request check that release 1's reader snapshot (§10.1) accepts every committed manifest,
skill and yaml block; a change that makes release 1 drop a file fails unless the file carries
`min_app_version` (manifests) or is a new kind bundled only (skills); an app-owned manifest or skill is
never renamed or given a new id in place; the flat reads of `fetch-models` and `verify-models` run over
every committed manifest; never a new `os` or `arch` value inside an existing family block of the yaml;
never repoint a hash in place.

---

## 7. Workspace guards, the last-writer stamp, migrations

_Status: P2 (planned; the vault guard and the start-path fixes are as built on master and P2 reviews
them as frozen) and P10 (planned). The goal: release 1 refuses what it cannot read, never damages what a
newer version wrote, says honestly when an upgrade failed, and records what a newer version needs to
know._

### 7.1 Done on master and frozen as built

- **The vault-format guard** (F-9, W-8, #845, PR #880) and **a newer working copy is kept** (W-66, #985,
  PRs #989 and #1007, with #973, #974 and #1001): §7.2.
- **An honest open failure** (#844, PR #871): a workspace that could not be opened answers
  `vault_open_failed` ("Nothing was lost"); "damaged" only for SQLite codes 11 and 26; a failed open
  never rewrites the `.enc`.
- **Why a skill is off** (#846) and **a model for a newer version** (#847): §6.11.

### 7.2 The vault-format guard, as built (F-9)

Recorded in full in [`security-model.md`](security-model.md) (the vault descriptor, the password
change, the working files) and [`data-contracts.md`](data-contracts.md) (the schema stamp). In short:
- a descriptor `version` above 2 (a number or a numeric string) is "newer" before any shape check; a
  known version with an unknown `kdf.algo` is "newer"; a rekey journal `version` above 1 is "newer";
- the frame of `.enc` and of every staged rekey file: `HRAUMEN` followed by ASCII `2`–`9` is "newer",
  any other eighth byte is damage;
- a plaintext working copy or `.recovery` whose header `user_version` exceeds the app's schema version
  is "newer", after two header checks that answer "damaged" first;
- with anything newer, nothing is written, shredded or renamed; the answer is the existing
  `workspace_newer` with its copy.

### 7.3 The vault start path (G-43)

- **(a) A start whose journaled swap fails still serves the update path** (W-82, #1015 and #1024, as
  built on master: PRs #1030 and #1034). The start runs through a guarded runner; on any throw it logs
  the error code and system call only, removes the channels the partial start registered, and answers
  `start_failed` with a cause (`drive_not_writable`, `drive_full`, `other`). The update channels join
  that state (§3.5), and `update.log` records the failure's class (§8.2).
- **(b) The rekey journal is acted on only inside the workspace** (W-83, #1014, as built on master: PR
  #1030). A staged entry is acted on at the start only if it ends `.enc.new` and lies inside the
  workspace folder with no link on the way; every other entry is left and counted. The journal `version`
  stays 1.
- **(c) A documented residual**: a spent newer `.recovery` that is older than `.enc` stays on the drive
  unencrypted after a release-1 unlock. It needs a newer version that crashed while locking and then a
  "Go back"; it holds the user's own data on the user's own drive, and the next start of the newer
  version encrypts it again. [`known-limitations.md`](known-limitations.md) records it (P2's docs).

### 7.4 The last-writer stamp (G-9 (a), F-10)

- Release 1 creates a key–value table `schema_meta` (`key TEXT PRIMARY KEY, value TEXT NOT NULL`) if it
  is absent and never deletes a key it does not know.
- It writes **one** key of its own, `last_writer`, and overwrites the whole value:
  `<app version>;<applied_through>`, where `applied_through` is a frozen baseline constant. A newer
  version therefore never sees a stale field a newer build left behind.
- The stamp is written after the refusal checks, as its own statement after the migrations,
  best-effort: a failure is logged and never fails the open.
- **Frozen for every later version:** `schema_meta`'s columns, primary key and constraints never change,
  and no later version puts a trigger on it; later versions add tables of their own.
- Release 1 also carries the migration framework (§7.8), which writes its own `schema_meta` keys. The
  full list of keys release 1 writes is restated before P2 starts, and F-10 freezes each name and value
  grammar.
- The unlock line of `update.log` carries the stamp (§8.2).

### 7.5 The database version number and the oldest workspace (M-D1, M-D2)

- The workspace database's `user_version` means **"the oldest app that may open this"** (M-D2): today's
  rule, under which 0.1.60 and later refuse a workspace whose number is above their own
  ([`drive-layout.md`](drive-layout.md), "Updating a drive"). It is bumped only for a change an older
  build must not open.
- **v0.1.50**, the first public release, is the oldest workspace a new version must upgrade (M-D1); the
  history fixtures run from it to the latest release, v0.1.66 included.

### 7.6 Old-reader behaviors that only release 1 can provide

Each one ships in the oldest sold version because only that version meets the case (planned, P2 unless
marked):
- **A user skill for a newer version says so** (W-65): a skill that fails validation while its raw
  manifest carries a well-formed `compatibility.minAppVersion` above the running version is filed as
  needing a newer version, with its own copy, instead of the validator's messages.
- **Release 1's SQLite is a recorded floor** (W-68): its SQLite version goes into the startup line
  (§8.2, P3) and into the frozen register at the Kit tag. An open that fails with "malformed database
  schema" gets copy that names the newer version instead of a backup, beside the import button (§3.4).
  From the first update on, a per-pull-request check runs every `CREATE` and `ALTER` text of the
  database code on exactly that SQLite (P11b).
- **Persisted message values** (W-69, F-26): a committed fixture holds the English value of every
  display-mapped message key at the Kit tag; a value change fails unless the old value joins an alias
  table the lookup reads; aliases are kept for ever. Release 1's lookup also accepts the coded form
  `hr:<MessageKey>`, maps a key it knows, and shows a neutral generic line for one it does not.
- **"Go back" leaves release 1 a state it can read** (W-70, P3): release 1 stores with
  `gpuAutoDisabled` the engine build it was set under and tries the graphics card again when its own
  engine differs; its unlock names an active model it cannot list instead of failing silently.
- **A knowledge pack for newer tools says so** (W-71): release 1 reads the ZIM major version (a `uint16`
  at offset 4); above 6 the pack is listed as made for newer knowledge-pack tools and is never handed
  to `kiwix-manage`.
- **Extractor versions** (G-34 (a), W-72): release 1 re-extracts a bank statement or invoice only when
  its `extractor_version` is `NULL` or **lower** than its own. A newer version's rows are served as they
  are, with a one-line note (a frozen sentence in ten languages), never replaced or deleted, and nothing
  that hangs off them is deleted. A deliberate rollback of a bad extractor ships a higher-numbered one.

### 7.7 Duties of every later writer of workspace data (F-27, W-64)

Newer data must survive what release 1 does with it. Every later version keeps these rules (P2 completes
the list; [`data-contracts.md`](data-contracts.md) carries it too):
- a new table that references one of release 1's tables does so with a cascading foreign key, so release
  1's deletes still succeed;
- no trigger, generated column, `CHECK` or index expression that uses a function release 1's SQLite
  lacks; schema text release 1's SQLite cannot parse ships only with a `user_version` bump;
- release 1's full-text-search trigger names, markers, columns and tokenizer stay as they are;
- the `.parse` / `.tmp` shred pattern under `documents/` and `images/` stays; stored copies are swept by
  the newer version;
- `ocr_meta_json` keeps `textPageCount`;
- the key-derivation parameters stay inside release 1's bounds under descriptor v2; a new derivation is
  a new `kdf.algo` value; a new frame format uses `HRAUMEN2` to `HRAUMEN9`, then a descriptor bump;
  never a schema format above 4;
- a changed embedding or summary recipe changes the stored model id;
- settings enum values stay safe when release 1 reads them raw; a new field in one of the three
  normalized settings records survives only until release 1 writes that record;
- never leave a `*.enc.new` release 1 can meet unless it authenticates under the data key or a
  version-1 journal lists it by full path; never stage before the descriptor exists; never leave a
  `.recovery` release 1 can meet unencrypted except after a crash;
- a crashed session (a live write-ahead log) is lost on any release-1 start, so a later build cannot
  promise crash recovery on a drive release 1 may still open;
- G-34's extractor rule (§7.6).

### 7.8 The migration framework (planned, P10)

- **A three-phase open**: repairs per connection, an ordered ladder of migration steps, repairs on every
  open; a registry with a frozen baseline step; `schema_meta` as the ledger of applied steps;
  `user_version` as the compatible version (W-36).
- **A migration worker** with progress on the unlock screen; on quit or lock it is stopped and its work
  discarded (W-37; M-D4 is asked in P10).
- **A snapshot by moving the old `.enc`** at the post-migration checkpoint, with a recovery rule
  designed with `.recovery` and the rekey journal; a plaintext workspace uses `VACUUM INTO` (W-38; M-D3,
  the retention, is asked in P10). Never a copy of `config/workspace.json`, which would keep an old
  password valid.
- **Tests and fixtures** (W-39): history and chained fixtures from v0.1.50 to the latest release; an
  all-paths schema-equality test; a compatibility test against the previous release's reader snapshot;
  a frozen-step hash guard.
- **Frozen** (F-15): released migration step ids and their source hashes.
- "Go back" is hidden once the workspace's version number is above what the target version reads
  (§6.10); this also covers a vault-format change.

---

## 8. Policy keys, `update.log`, the drive-release record

_Status: planned (P3; the support-end notices and the update rows of the support details P6). The
names, grammars and read contracts below freeze in release 1. Absent keys and an absent record mean
today's behavior._

### 8.1 Policy keys (F-8, G-14 (c) built the simple way, U1 (b))

| Key | Meaning in release 1 |
|---|---|
| `updates.allow_user_install` | absent = allowed; `false` blocks every install ("Updates are managed by your organization") |
| `updates.max_version` | optional; see the table below |
| `updates.allow_online_check` | a **reserved name**: the Kit builders write `true` explicitly (U1 (b)); its meaning belongs to the online-check version after release 1, which may refine it; release 1 does not act on it |
| `network.allow_update_checks` | unchanged: `false` everywhere, and the sell gate's refusal of `true` stays as it is |

The `updates.max_version` table:

| `allow_user_install` | `max_version` | Result |
|---|---|---|
| `false` | anything | every install blocked |
| absent or `true` | absent | allowed |
| absent or `true` | a version X | versions up to X allowed (semver order, pre-releases included) |
| absent or `true` | a junk value | blocked: the update policy on this drive has an invalid value |

- **A missing or damaged `policy.json` in a packaged build** keeps the signed import **allowed** and shows
  "policy file unreadable" in Settings → Updates and in Diagnostics, so an administrator's typo that
  lifted a block is visible. This is a deliberate exception to "a damaged policy never fails open"
  (a blocked import is a management control, not a security boundary: updates are signed, and a damaged
  policy must not block the signed repair); [`security-model.md`](security-model.md) records it (P3's
  docs).
- What a junk value of `updates.allow_user_install` itself means is fixed by P3's parse matrix (absent,
  `true`, `false`, junk, per posture) before F-8 freezes.
- **When it is read**: from disk at the import, at "Restart and update" (also from a later start), so an
  administrator's edit needs no restart. **Once `updates/applying/` exists the policy no longer stops
  it**: the start files parse nothing and resume, and "Continue the update" is not gated, because a
  half-done swap must finish. The admin section says so: block before the hand-off, or remove the staged
  update.
- The Kit builders write `updates.allow_online_check: true` and keep
  `network.allow_update_checks: false`; the install keys stay absent unless a managed Kit asks for them. On a Kit the old key no
  longer governs a later online check, so the admin section names `updates.allow_online_check`.

### 8.2 `updates/update.log` (F-11, W-14)

A plaintext, content-free log on the drive, readable before unlock, for support:
- append-only ASCII lines; every line starts with a writer token (`r1-app`, `r1-launcher`, `lb`,
  `apply-<version>`) and an OS token; a line written by `cmd` carries the raw `%date% %time%` as an opaque
  field and may carry no ISO time (both are formatted by the locale, and `wmic` is gone from current
  Windows 11). The OS tokens, the line frame and the time field: §5.3 (table B.2); the events of the
  hand-off, the apply and the start files: §5.4–§5.6;
- **content-free by grammar**: tokens, versions, codes and counts; no free text, no placeholders, no
  paths. The app's writer reports an error as its errno code and bare system call, never a message. The
  redaction of `app.log` (#975) covers `app.log` only on its way out of the app, never this file, which
  `cmd` and bash write too;
- every message the user is shown is logged with its `UPD-*` reference code (§5);
- **the startup line**: the app version, the engine pins, `drive-release.json`, `drive_format_version`
  and the app's SQLite version;
- **the unlock line**: the workspace's `user_version` and the `last_writer` stamp (both unreadable
  before unlock);
- **a failed start**: the failure's class, written in the guarded start runner's catch (`failure.cause`
  and `failure.code` only, §7.3);
- a write failure is swallowed and counted, so a read-only or full drive never breaks the start; the
  file has a size cap that P3 sets;
- `PRIVACY.md` says the file is content-free and lives on the drive (P3's docs).

### 8.3 "Copy details for support" and the Copy report (W-16)

- **The Copy report** in Settings → Diagnostics gains the app version, the drive content version, the last
  update and the staged update (P3 the versions, P6 the update rows).
- **"Copy details for support"** is a frozen, content-free button on the unlock screen's sheet (§3.4), in
  Settings → Updates and on every update refusal and outcome notice, callable while locked (§3.5). It
  copies: the app version and OS; the root apps per system with their versions; the start files matched
  against the payload; `drive-release.json` `app_version`; `kit-support.txt`; the policy state
  ("unreadable" included); the staged version; `updates/applying/` with its launch and hand-off counts
  and its start acknowledgment; `unconfirmed.txt`; the last 3 lines of `last-result.txt`; the last 40
  lines of `update.log`; the free space; whether the drive is writable. No paths. A row still runs the
  copied text through the log redaction and asserts it comes back unchanged. The exact labels, values
  and order: §5.9 (table B.10).
- A persistent "Last update attempt" line (the outcome and the version) in Settings → Updates and on the
  unlock screen.
- It sits beside a named support contact (the Kit's support address on the project page and the
  packaging).

### 8.4 Support end and age (G-13 (b), G-29 (a), F-12, W-17)

- **The support end date is per Kit**: `config/kit-support.txt`, one line `YYYY-MM`, written only by the
  Kit builder, once; the builder refuses to overwrite an existing one, and nothing else rewrites it
  (`config/` is outside the reconcile). A later extension is an owner action, never an app write. The
  CRA sets the support period per unit placed on the market, so a Kit sold later gets a later date; the
  value comes after counsel (U10), and no Kit can be built until it is set.
- The app shows the date only when the file is present; a DIY drive shows only the age reminder.
- **The build date** has one source: the release commit's committer date, written at build time into a
  generated JSON beside `keys.json` and pinned by the release guard (§2.7); never a file's modification
  time, which a copy to exFAT resets. Its name and shape: §5.10 (table B.11).
- **The age reminder**: offline, 6 months after the build date; a dismissal hides it for 6 months, then
  it shows again; on Home and in Settings → Updates (G-29 (a)). It says that newer versions, if there
  are any, are listed at the update address. The page answers "you're up to date" where the Kit's line
  has nothing newer.
- **The end-of-support notice** is worded so it stays true if the period is later extended: the support
  period stated at purchase ended on the date, HilbertRaum keeps working as it is, and newer versions,
  if there are any, are listed at the address.
- **The clock rules**: both notices say "according to this computer's date"; both stay silent while the
  clock is before the build date. **Past `max(build date, support end)` + 3 years the notice is
  reworded, never suppressed**: a correct clock four years after the support end is exactly when a Kit
  left in a drawer needs it.
- Golden dates (§10.2): the build date − 1 day, both sides of the bound, the build date + 10 and + 30
  years. Counsel is asked how the support period is counted before F-12 freezes.

### 8.5 `config/drive-release.json` (F-13, W-20)

**What release 1 reads, frozen:**
- `app_version` (for the version rule, §2.5); `format` is logged, never acted on, so a later `format`
  bump never stops release 1; a breaking layout takes a new file name;
- `highest_version_seen` is a reserved name release 1 does not act on;
- an absent file or field means no constraint; a malformed file, 0 bytes or a wrong-typed field counts
  as absent and is logged (the field types, the byte-order mark and the size limit: §5.10, table B.11);
- release 1 never writes the file.

**What every writer keeps:**
- unknown fields are kept;
- `app_version` = the version of the apps at the root after the writer's operation: the confirmed new
  version after an update, the target after "Go back", unchanged after an automatic fallback. A writer
  that did not place the apps itself (`prepare-drive` on a DIY drive, which copies none) writes it only
  if exactly one app per system is at the root and all carry one version, and otherwise omits it;
- the support end is **not** in this file (§8.4).

**Who writes it**: one node helper, `scripts/lib/write-drive-release.mjs`, as the **last** step of
`build-commercial-drive` (after the start files, apps and engines are copied) and of `prepare-drive`
when node is on `PATH`; it also records the systems and a `files[]` list (path, sha256) as evidence. The
new version rewrites it after its confirmation and before "Go back" (§6.9, §6.10).
`config/drive.json`'s `drive_format_version` and `config/checksums.json` are written and read by nothing;
no rule leans on them.

### 8.6 Audit events (W-18)

Content-free events in the workspace's audit log: `update_staged`, `update_applied`,
`update_rolled_back`; `update_check` and `update_download_*` are reserved for the online-check version.
An event that happens before unlock goes to `update.log` only. The engine download after an update
records the existing `engine_install_*` events with its own `trigger`.

### 8.7 Pins on the user's computer (W-15)

The user-data folder is shared by every version and every Kit on one computer, so:
- `appId`, the app scheme and the name the user-data folder derives from are pinned by a hygiene test,
  as spike 8 finds them (§10.6), and never changed;
- an allow-list pins the renderer's `localStorage` keys: Chromium recreates a store it cannot open, so
  nothing whose loss changes behavior may live there.

---

## 9. Release side and ritual

_Status: planned (P5; release 1 itself is P11c). The release tools are replaceable; the published
assets and the keys are permanent._

### 9.1 The deploy stop and the integration branch

- The whole wave lives on one integration branch, `feat/app-updates` (G-2 (b)). Every phase pull request
  targets it with green CI (`ci-success` is required there through the existing ruleset, G-41);
  `master` reaches it only through sync pull requests. `master` receives the wave once, through one
  final pull request merged with a merge commit.
- Until then `master`'s `BUILD_STATE.md` points at the branch and lists the files release 1 freezes
  (G-42), so other work on `master` asks before it changes them.
- **No version tag before release 1**, on any branch. One exception: a files-only GitHub release whose
  tag does not start with `v` (§9.7).

### 9.2 Release 1 on `master` after the final pull request

After the final merge, release 1's release pull requests land on `master` through CI: the version bump
and its CHANGELOG section; the production `keys.json` (§2.7); the Windows code-signing (Authenticode)
wiring once the certificate exists; the approved `SECURITY.md` "Supported versions" text; then, right
after the tag, the release-1 import-reader snapshot and the release record (also into `kit/<version>`).

Release 1 is tagged on `master`:
- once every system's real-hardware tests passed (G-15 (a): every Kit carries all three systems; a
  failing system holds release 1, never a reduced Kit);
- with the production keys and the Kit's support end date (§8.4) in place;
- with the update walk re-run on `master`'s head and, for a Windows Kit, on the signed artifact;
- and it is published only after the key proof (§2.8) passed on its draft artifacts.

**Versions**: `master` stays at 0.1.66 through the deploy stop. Release 1 is the next minor version;
its patch numbers belong to its fix line (§9.6); the next release from `master` is the minor after it.

### 9.3 The release ritual (W-23)

1. A `v*` tag runs `release.yml` (it runs on any branch): it builds the three apps, the payload (its
   `files[]` lists every member, the apply scripts and the start files included) and the SBOM (from
   `npm sbom` with the lockfile, plus hand-written entries for Electron as shipped and the engine pins;
   kept out of the signed payload). The release is a **draft**, flagged pre-release.
2. The owner smoke-tests the draft's artifacts, then runs the signing tool **offline** ("sign what you
   tested"): it rebuilds the payload from the smoke-tested files plus the tag checkout and signs only if
   it is byte-identical to CI's; it checks the engine entries against `runtime-sources.yaml` at the tag;
   it prints the version, the channel and `min_upgrade_from` and waits for a typed confirmation. It can
   add a signature to an existing envelope in a second offline session (rotation). Routine releases are
   signed by the active key alone.
3. The update file builder (in process, the container of §4) writes the full update file and one per
   system set; they are uploaded to the draft with the envelope `hilbertraum-release.dsse.json`. The
   update file's name is outside the `HilbertRaum-*` prefix that the sell gate and the start files scan.
4. **The pre-publish check** verifies the envelope against the key set of **every supported released
   tag**, checks that every asset is there with its hash, and checks the pre-release flag for the
   channel.
5. **Publish.** Only stable (Kit) releases carry an envelope (§2.6). A Kit release: pre-release unticked,
   "Set as latest" ticked; an older line's fix release: "Set as latest" unticked; from release 1 on,
   every other release stays flagged pre-release (G-11 (a), confirmed in P5).
6. **The post-publish check**, after every publish: fetch
   `releases/latest/download/hilbertraum-release.dsse.json` anonymously, verify it, assert the tag and
   the channel, re-hash the published assets.
7. The buyer notice and, for a security release, the advisory (§3.2).

**Per engine-pin bump** (T5.13): every committed manifest's weights load on the new engine; a model it
cannot load moves behind `min_app_version` with a replacement; the new version's arguments run on
release 1's pin (§6.6).

**Per release offered to Kits, the reach of each system** (G-24 (a)): the ritual refuses to offer a
release that raises a system's OS floor (an Electron major that drops an OS version) to the Kit channel
while any supported Kit release stated a lower floor at sale; those Kits stay on a floor line, and on a
multi-system Kit the whole drive stays there.

### 9.4 Which file Kit buyers get (G-36, G-27)

- Kit buyers are offered **one** update file, for all systems, in the buyer notice, on the project page
  and on the release page's Kit line. The per-system files are listed only in the admin section.
- The apply installs only the systems whose app is already at the root: a Windows-only drive never gains
  a Mac or Linux app it did not carry (§5). The import's free-space check counts the whole file.
- Update files stay under GitHub's 2 GiB per-asset limit, with a warning at 1.9 GiB; a larger one is
  hosted on the project's mirror. Today's full update file is about 0.5 GB, without engines.

### 9.5 The sell gate (W-33)

A Kit is built only with the builders of its own release tag, from that release's signed assets. The
gate, which both builders call, also:
- takes the release's `.dsse.json`, verifies it with the production keys, and requires every root app's
  sha256 to match it, so a local or walk build can never become a Kit;
- refuses an empty key set;
- requires `drive-release.json` with `app_version` equal to the apps, and `config/kit-support.txt`;
- requires every root start file and `READ ME FIRST.txt` to match the sha256 the signed payload lists;
- requires the drive's `runtime-sources.yaml` to equal the Kit app's bundled copy, and
  `DRIVE-NOTICES.md` to be generated from it;
- refuses any file in `updates/` (a Kit ships with no `updates/` folder; a smoke start is made on a copy);
- refuses to release a Kit for dispatch when `kit-support.txt` is earlier than the dispatch month plus
  the declared period, and repeats the timestamp-countersignature check on the Kit's exe;
- from P8 on: the manifests and pins match the app version, and a pin folder (§6.6) is checked like the
  live one.

### 9.6 The fix line (G-16, W-54)

- `kit/<version>` is cut at release 1's tag and joins the branch ruleset, with a separate rule for `v*`
  tags.
- Security-only releases are tagged from it with the Kit release's own drive content. A fix is a pull
  request into `kit/<version>` and, where it applies, one into `master`.
- Before a fix release is offered to Kits, the walk "Kit tag → fix tag" passes on every sold system, and
  the first real signed fix file is imported into the real release-1 artifact.
- An AI engine fix can ship on the line (a download after the update, or the escape hatch, §6.5).
- An older line's fix release is published with "Set as latest" unticked.
- How the line follows Electron majors is open (G-25, §11.2).

### 9.7 A files-only release before release 1

Before release 1, a GitHub release whose tag does not start with `v` (no app, nothing for sale; the
owner publishes it) may host engine files: the Mac and Linux voice-engine builds (§6.8) and, under
G-28's option (a), the signed Windows engines. `release.yml` does not run for it.

### 9.8 What only the owner does

Agents never generate, hold or use signing keys, sign, tag, publish or edit releases, merge pull
requests, procure certificates, email buyers, post advisories or make legal statements. Agents draft;
the owner acts.

### 9.9 Duties for the support period

- Immutable releases are on before release 1, and releases are never deleted.
- Every published release has a second home outside GitHub (an offline copy and an EU mirror), and the
  domain of §3.3 is kept for ten years.
- A toolchain archive per Kit tag (the npm cache for the tag's lockfile, the Electron zips, the
  electron-builder cache, the Node installers, the engine archives, the runner image versions), so a Kit
  tag stays rebuildable; Kit branches pin explicit runner labels; a yearly rebuild drill.
- A withdrawal playbook for a bad release (a valid signature never expires): untick Latest, retitle the
  release "WITHDRAWN: use vX", publish a fix with a higher version, send the advisory and the buyer
  email; dry-run once before release 1.

---

## 10. Test record

_Status: planned. Each phase records here what it proved, as built._

### 10.1 Tiers

| Tier | Where | Runs | Proves |
|---|---|---|---|
| Unit | `apps/desktop/tests/unit` | every pull request, every CI leg | pure rules: the PAE, the parser, the version rule, the grammars, the validators, the policy matrix |
| Integration | `apps/desktop/tests/integration` | every pull request, every CI leg | the real file system, the in-process update file reader, SQLite, the vault and the scripts on temporary roots; IPC against real services; an injected fetch for the network; the reader snapshots |
| Renderer | `apps/desktop/tests/renderer` | every pull request | states, copy keys, accessibility roles; all ten catalogs complete |
| Dev-app end to end | the app driven over the Chrome DevTools protocol | per phase, locally | UI → IPC → main on a scratch drive root |
| Packaged walk | `tests/manual/update-walk.test.ts` (`HILBERTRAUM_UPDATE_WALK=1`) | locally from P7; as a workflow on Windows, macOS and Ubuntu from P11a; before each Kit release | the real apps, start files and apply scripts, parked kill points, the fallback, the old version's notices |
| Hardware | the owner, with written step lists | P11a, P11b, P11c | Smart App Control, Gatekeeper, an exFAT unplug, antivirus, timing on the Kit's SSD and on USB 2 |
| Real network | manual, once | the first signed release | GitHub's redirects, the download servers |

**Reader snapshots** (W-53): single-file builds of release 1's readers (envelope, payload, version
rule, update file reader, policy, `drive-release.json`, the descriptor guard, the database open), made
by a committed script from the tag. A per-pull-request suite feeds files the current code writes
through them. P2 creates the recipe with a v0.1.60 snapshot; release 1's import-reader snapshot is made
right after its tag, because the pre-publish check runs it over every Kit update file from the first fix
release on.

**Upgrade coverage**: the tiers above prove what an upgrade must carry over: the app itself (apps, start
files, the swap, the fallback, "Go back"); the workspace database (migrations, the old-reader guards,
data the new version wrote read by release 1 after "Go back"); model manifests; skills; engines;
`policy.json`, `drive.json`, `workspace.json`, `kit-support.txt` and `drive-release.json` byte-identical
after an update, a fallback and "Go back"; the drive docs; the user's computer (the user-data folder,
the Chromium profile, the macOS cache).

### 10.2 Golden contracts and reviews

- Every frozen contract (§1.6) has a golden test. Its expected values live in data fixtures with an
  origin other than the code under test: the DSSE specification's PAE example, the RFC 8032 vectors,
  negative vectors written from the specification without reading the verifier, envelopes signed by an
  independent tool. A committed sha256 manifest locks the fixtures, and `repo-hygiene.test.ts` checks
  it.
- Goldens are split into "the old reader accepts X" and "the current writer emits X".
- Two independent reviews per frozen item, with different lenses; the second lists the item's consumers
  itself before it reads the change's impact notes.
- A deliberate mutation in the production owner of every new row proves the row can fail.
- Committed sha256-locked fixtures are test inputs, not generated files.

### 10.3 The protocol model (W-59)

An executable model of the drive's state machine checks the update protocol: the import, staging, the
hand-off, the apply journal, the start-file rules with their markers and counter, the fallback, the
confirmation, "Go back", the outcome notices and the version rule, under kills, unplugs, moves between
computers and systems, antivirus, blocked helpers, read-only drives, clock jumps, damaged staging,
re-imports and a second update. It is kept with the wave's working papers, outside the repository.
- **Rule**: the protocol tables of §4 and §5 are entered into the model before the owner sees them, and
  every rule family runs to an empty frontier. The model is re-run on every change to F-5–F-7, F-19,
  F-20, F-22, the apply script, "Go back" (W-21, W-22) or the engine-folder rules (W-30, W-67); a new
  counterexample blocks the change until it is fixed or the owner accepts it as a residual. It is an
  extra check, never one of the two reviews.
- **Its known gaps**, so an empty frontier is never read as covering them: the migration and vault schema
  are outside the model; an import cut by an unplug and a new version that shows no window on any
  computer are not produced by it; a second Kit on the same computer is not an event; the file-level
  rules of the engine folders (§6.6, §6.7) are below its abstraction (one atomic "folder + marker").
- The model's counterexamples are named CE-n (§12.2); each becomes a walk row in P7.

### 10.4 The update walk (W-35)

- The old and the new version are built from **throw-away copies** of the source (a worktree at the tag
  or the head in the walk's own temporary folder; a tag's copy runs its own `npm ci` from the tag's
  lockfile), with a per-run test public key written into `keys.json` and the version set by
  `-c.extraMetadata.version=<version>-e2e`. One process generates the key pair, builds, signs the new
  version's payload and discards the private key; nothing is uploaded. A new version that never
  confirms is a stub app that exits at once.
- Kill points are **parked**: on Windows an exclusive handle on step k's file, so the script's own retry
  parks there; in bash a harness-side `BASH_ENV` DEBUG trap or a `PATH` stub for `mv`. Every row asserts
  the state in the middle before recovery.
- Runs started by the start files or the scripts are judged by observables that need no test hook
  (`update.log`, `updates/applied/`, the process list, the root tree); data checks run on a second start
  of the bare exe with `--remote-debugging-port`.
- The workflow `update-walk.yml` runs on a push to a `walk/**` branch before the final pull request and
  by `workflow_dispatch` after it. From the first update after release 1 on, the old version is built
  from the Kit tag.

### 10.5 Real media and real people

- **The test-drive acceptance** (G-45 (a), W-79), in a drive root folder of its own on the project's
  used exFAT test drive (a USB stick prepared and used by older versions), after a full backup the owner
  confirms: **stage A** (P11a) takes a v0.1.56 DIY drive that was really used, runs one session on
  v0.1.66, then moves it to the release-1 candidate by the documented manual path, and proves every user
  file byte-identical; **stage B** (P11b) takes release 1
  to a test-signed new version through the real update path, with "Go back", an engine change, an unplug
  during the swap and a new version that exits at once.
- **The owner's hardware legs**: spike 2 (Smart App Control and the "unsigned from USB" attack-surface
  rule on the signed Windows artifact) in P11c; spike 3 (macOS), spike 4b (Linux on a real stick), a
  reduced spike 5 (a hard unplug), the browser leg (a large file downloaded from an email link in four
  browsers), the read-only leg and the restart timing on the Kit's SSD and USB 2 (G-39 (a)) in P11a;
  the full spike 5 and spike 6 (timing) in P11b.
- **Buyer sessions** (G-38 (a)): five moderated sessions (three on Windows and two on a Mac, one of them
  with a two-system Kit and one on a managed PC) with the notice, the page and a test-signed file on a P7
  build, before the second part of the release-1 copy is approved.

### 10.6 Spike verdicts

The spikes of P1 measure what the design must not guess. Each has a verdict file with its method,
numbers and verdict; this table is filled at P1's end.

| Spike | Question | Result |
|---|---|---|
| 1 | How long the Windows portable stub holds the exe after a quit, on NTFS and on exFAT separately and on a USB 2 stick, with the antivirus as found; whether a detached apply script that waits, renames and starts gets flagged | pending (T1.1) |
| 4a | The static-runtime AppImage on a stock Ubuntu 24.04 (WSL2) without libfuse2, with and without `APPIMAGE_EXTRACT_AND_RUN=1`; replacing it while it runs on exFAT; this computer's glibc read as the `linux` floor will read it; the detached bash hand-off from the packaged AppImage | pending (T1.6) |
| 7 | One history fixture from tag v0.1.50 built with that tag's own toolchain: do the full-text-search shadow rows restore under `defensive: true`? | pending (T1.5) |
| 8 | `app.getPath('userData')` and the single-instance lock name in a packaged build | pending (T1.2) |
| 9 | The in-process ustar reader reading a 450 MB update file in one pass, hashing while it writes, on NTFS, exFAT and USB 2 (time, memory) | pending (T1.3) |
| 10 | A detached `cmd.exe` spawned by packaged Electron 43.8.10 survives the app's exit: the exact working argument list, the start file's resume line, awkward drive roots, exFAT, the apply lock's held handle, a working folder at the path-length limit | pending (T1.4) |

---

## 11. Open items and non-goals

### 11.1 Open owner calls

- **G-17's exact path**: the owner types it; `<G17-ADDRESS>` until then, final by the release-1 tag
  (§3.3).
- **G-18's native readers**: whether native speakers also read the frozen strings in the eight languages
  the owner does not read; decided before the release-1 copy freezes. Where a reader is chosen but not
  found in time, those strings may show in English for that language.
- **G-28**: code signing of the AI engines for Windows Kits; deferred, deadline before P5 writes release
  1's engine list (§6.8).
- **U9, U10 and U11**: answered after counsel. U10's value (the support period) is needed before the
  first Kit is built (§8.4).

### 11.2 Decided in their phases

- G-10 (where the walk runs, P7), G-11 (the channel mechanics, P5: `prerelease: true` kept, the
  pre-publish check refuses a Kit release still flagged pre-release), G-25 (how a fix line follows
  Electron's support window, P5, with counsel), M-D3 and M-D4 (P10), U5 (with the online check after
  release 1).

### 11.3 Accepted residuals

- A spent newer `.recovery` older than `.enc` stays unencrypted after a release-1 unlock (G-43 (c), §7.3).
- A drive that cannot be written after an interrupted engine swap starts no engine until it is writable
  (G-44 (b), §6.7).
- Spike 4a covers Ubuntu 24.04 in WSL2 only; the static AppImage runtime stays unproven on Ubuntu 25.10
  and Fedora until spike 4b runs on a real stick in P11a.
- Offline Kits get AI engine updates only from a file (G-31 (b)); every release offered to release-1
  Kits keeps working on release 1's engine where a system has not installed the new one (G-35 (a)).
- An old but genuine update file can move a Kit up to an outdated version, never down (G-19 (b)).
- A stolen key stays trusted on every Kit that never installs the release that drops it (K1, §2.1).

### 11.4 Non-goals

- A background or startup update check (U2); any update identifier, telemetry or analytics.
- TUF, electron-updater, Squirrel, the NSIS installer target, an unpacked app folder (U4).
- Delta updates or patching `app.asar`: the fuses forbid it; updates replace whole apps.
- The derived-data rebuild queue and new derived stamps; the embedder swap.
- Changing `userData`, `productName` or `appId`: they are only pinned (§8.7).
- Turning on `REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES`.
- Paid licensing or an entitlement check of any kind: updates are free and unmetered, every release is a
  public GPL build.
- Wiring Authenticode or notarization before the owner has the certificates.
- An `updates/incoming/` folder or a startup scan of any folder for update files: "Install update from a
  file…" covers it.
- A macOS pre-extract by the old version (the update's own scripts may do it).
- Model weights inside the update file: weights stay user downloads; the update file carries manifests
  only.
- A project-owned update host.

### 11.5 Before the first Kit is sold (outside the updater)

The buyer notification channel and the advisories page; `SECURITY.md` "Supported versions" for the Kit
and the reporting runbook; the support end date on the shop page and the packaging; counsel's answers;
for a Windows Kit, a signed release 1; the key proof (§2.8); the second home, the domain, the
succession file and a deputy, a dry run of the withdrawal playbook; the system requirements printed with
the Kit (G-26); release 1 on an Electron major with at least 4 months of upstream support left; and
G-33's manifest change, so that a fresh Kit started offline on a computer without a usable graphics card
recommends a model it carries.

---

## 12. Legends

### 12.1 The §-anchor legend

Cite this record as **`app-updates.md §N`**, or `app-updates.md §N.M` for a numbered subsection; always
with the document's name, since "§6" alone means something else in every other record. The numbers are
stable from the first pull request of the wave: a later section's new material is added as a new
subsection at the end of its section, never by renumbering.

| § | Holds |
|---|---|
| §1 | scope, the owner's decisions and the plan's gates, the frozen-forever rule, the frozen contracts F-1–F-27 |
| §2 | trust: the keys and their custody, the envelope, the payload, the version rule, the channel, the release guard, the key proof, the fork rule |
| §3 | finding and importing an update: no online check, the addresses, the entry points, the locked channels, the refusals before reading |
| §4 | staging and the update file container (protocol table A) |
| §4.1 | how to read table A, and why its caps are set for a 2035 file |
| §4.2 | table A.1: the staging names |
| §4.3 | table A.2: the container (the ustar subset, the `HRUPDATE` prefix, member 0, the `payloadType`, the caps, the end, the header walk) |
| §4.4 | table A.3: the member-name rule (F-18) and the root globs release 1 reads |
| §4.5 | table A.4: staging (the order, the free-space formula, the reads, the `.incoming-<v>` folder, the commit, the sweep, the removals) |
| §4.6 | table A.5: the grammars of `staged.txt` and `staged.json` |
| §4.7 | table A.6: the verdicts of the container and of staging, with their codes |
| §4.8 | the cases table A was checked against |
| §5 | the hand-off, the apply script, the start files, "Continue the update", the outcome codes and notices (protocol table B) |
| §5.1 | how to read table B: "frozen since", the system, version and token spellings, the common text rules G0 |
| §5.2 | table B.1: every file and folder name of the hand-off, the apply and the start files |
| §5.3 | table B.2: the grammars of `handoff.txt`, `journal.txt`, `unconfirmed.txt`, `launch-count.txt`, `last-result.txt`, `last-result.seen`, and the `update.log` line frame |
| §5.4 | table B.3: the hand-off (order, pre-check, the spawn per system, the environment, failed-spawn classes, the start acknowledgement, `budget`, "Continue the update") |
| §5.5 | table B.4 and B.5: the apply script (lock, wait, move order, the new app's start, the CE-1 rule, cmd and bash rules) and the journal states |
| §5.6 | table B.6 and B.7: the start files (rule 1's exact text, the fall-through, the counter, rules 2 and 3) and every line they print |
| §5.7 | table B.8: the confirmation (F-22) and the offers at a start (F-19) |
| §5.8 | table B.9: the `last-result.txt` codes and the `UPD-*` reference codes with their copy keys |
| §5.9 | table B.10: the "Copy details for support" fields |
| §5.10 | table B.11: the build-date file and the `drive-release.json` reader's types |
| §5.11 | the cases table B was checked against |
| §5.12 | table B's owner calls and open values |
| §6 | drive content, AI engines, the first start after an update, "Go back" |
| §7 | the workspace guards, the last-writer stamp, the later-writer duties, the migration framework |
| §8 | the policy keys, `update.log`, the support details, the support end and age, `drive-release.json`, the audit events, the pins |
| §9 | the release side and its ritual, the fix line, the sell gate |
| §10 | the test record, the protocol model, the walk, the spike verdicts |
| §11 | open items, residuals and non-goals |
| §12 | these legends |

### 12.2 The owner-call and code legend

The ids below come from the wave's analysis and implementation plan, working papers kept outside the
repository. A new code comment names this document with the id ("app-updates.md §6", "app-updates
U1"), because the same spellings mean other things elsewhere (§12.4); the citations already on the
branch are resolved by §12.3.

| Family | Meaning | Defined in |
|---|---|---|
| U1–U11 | the owner's calls on the update channel and policy | §1.3 |
| K1–K5 | the owner's calls on the signing keys | §1.3, §2 |
| M-D1–M-D4 | the owner's calls on workspace migrations | §1.3, §7 |
| G-1–G-45 | the plan's gates: decisions the owner took or the plan recommended | §1.4, §11.2 |
| W-1–W-84 | the plan's work items; each one's decided contract is in the section of its subject | the section that names it; the cited ones in §12.3 |
| F-1–F-27 | the frozen contracts | §1.6 |
| `T<phase>.<n>` | a task of the plan (T6.3 is task 3 of phase P6) | the section of its subject; the cited ones in §12.3 |
| `CE-<n>`, `CE-D<n>`, `CE-F<n>` | a counterexample the protocol model found (CE-D: found by the model's review, CE-F: in the engine model); each is closed by a rule in the cited section | §10.3; the cited ones in §12.3 |
| `PA-<n>` | historical: a plan-review finding id of the wave's implementation plan, a working paper outside the repository; it is provenance, never a contract | — |
| P0–P14 | the wave's phases: P0 decisions and baseline; P1 spikes and this record; P2 workspace and old-reader guards; P3 supportability, policy keys and the drive-release record; P4 trust core; P5 release side; P6 import, staging and the Updates tab; P7 hand-off, apply and start files; P8 drive content and engines; P9 the online check (after release 1); P10 the migration framework; P11a, P11b, P11c the walks and release 1; P12 the wave review; P13 follow-ups; P14 the close | §9 |
| M0–M3 | the plan's content tiers: M1 what release 1 freezes for the oldest Kit, M2 drive content and engines, M3 the migration framework, M0 the launch conditions outside the updater; release 1 meets M1, M2 and M3 | §1.2 |

### 12.3 App-update ids already cited on the branch

Found at the record's first version (the brief's search over `apps`, `docs`, `scripts` and
`launchers`, plus one search for gate ids). Each is listed with the section of this record that carries
it and the files that cite it.

| Id | Meaning | § | Cited in |
|---|---|---|---|
| CE-F1 | a marker written last let a quit after the move reinstall over the kept copy; the rule: the marker is written inside the new copy before any move | §6.6, §6.7 | `runtime-download.ts`, `engine-swap.test.ts`, `architecture.md` |
| CE-F10 | an interrupted engine swap on a drive that cannot be written; "start the complete copy where it lies" is not built in release 1 (a residual) | §6.7, §11.3 | `runtime-download.ts`, `architecture.md` |
| F-14 | the update channels callable while locked and after a failed start | §3.5 | `registerStartFailureIpc.ts`, `data-contracts.md` |
| F-24 | the AI engine contract | §6.7, §6.11 | `data-contracts.md` |
| G-28 | code signing of the AI engines for Windows Kits, deferred | §6.8, §11.1 | `assets.ts`, `assets.test.ts`, `script-execution.test.ts`, `binary-verifier.test.ts`, `data-contracts.md`, `security-model.md` |
| PA-225 | historical (the review that made #986 a work item) | — | `architecture.md` |
| T6.3 | P6 registers F-14's channels on the start-failure context | §3.5 | `registerStartFailureIpc.ts`, `data-contracts.md` |
| T8.5a | P8's engine download or file install into a folder of its own, reusing `stageEngineInstall` | §6.5, §6.6 | `runtime-download.ts` |
| T8.5c | the two reviews of release 1's own engine swap as built, and its rows owed on real media | §6.7, §10.5 | `architecture.md` |
| W-4 | the import entry points | §3.4 | `WorkspaceGate.tsx` |
| W-5 | staging, which reuses the rename retry of `fs-retry.ts` | §4 | `fs-retry.ts` |
| W-14 | `updates/update.log` | §8.2 | `backend-start.ts`, `data-contracts.md` |
| W-30 | the new version's AI engine in a folder of its own | §6.5, §6.6 | `runtime-download.ts`, `architecture.md`, `data-contracts.md` |
| W-66 | a newer working copy is kept (#985) | §7.1, §7.2 | `db.ts`, `workspace-vault.ts`, `workspace-vault-format-guard.test.ts`, `db-probe.test.ts`, `security-model.md`, `build-log.md` |
| W-67 | release 1's own engine install swaps, never deletes first (#986) | §6.7 | `runtime-download.ts`, `engine-swap.test.ts`, `architecture.md`, `build-log.md` |
| W-82 | a start that fails still serves the update path (#1015, #1024) | §3.5, §7.3 | `registerStartFailureIpc.ts`, `backend-start-failure.test.ts`, `data-contracts.md` |

No U-, K- or M-D- id of this family is cited on the branch yet.

### 12.4 Same spellings, other families

These are **not** app-update ids:
- `F-01`–`F-41`: the full audit of 2026-07-16 (its table in [`architecture.md`](architecture.md));
- `F-1`–`F-8` beside `FA-1`–`FA-4`: the translation audit; "review V F-n" and "review R F-n": security
  review findings in the vault and shutdown code;
- `U1`–`U7`: the skills audit of 2026-07-03 and its phases;
- `W-6`: a sub-point of follow-ups wave 5 (small talk in a documents chat);
- `M-D1` in [`build-log.md`](build-log.md): a finding of the 2026-06-13 audit;
- `PA-4`: a finding of the #808 audit;
- `G-5`, `G-13`, `G-15`, `G-17` near follow-ups waves (for example `skills/registry.ts`,
  `reviewSession.ts`, the engine-swap record): gates of those waves.
