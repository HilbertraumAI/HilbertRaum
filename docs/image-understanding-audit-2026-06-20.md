# Image Understanding plan — multi-persona audit

_Date: 2026-06-20. Target: [`image-understanding-plan.md`](image-understanding-plan.md).
Branch: `image-understanding`. Status: **REMEDIATED 2026-06-20** — every finding below
(RUNTIME-1…4, DIST-1, SEC-1/3, IPC-1/2/3, UX-1/2/3, PROD-1/2, TEST-1) is now addressed in the plan
text and traceable to its ID; the "Confirmations to preserve" were left intact. The plan remains an
open `*-plan.md` (the feature is unbuilt; V1 is still the gate). This audit is kept (not deleted) so
the plan's `(SEC-1)`/`(RUNTIME-2)`-style back-references resolve; it can be deleted once the plan
ships and is folded into the topic docs (git history preserves it)._

This is an adversarial, multi-viewpoint audit of the **plan** (not the code — no feature is built
yet). Its job is to find issues, gaps, contradictions, and unverified assumptions that would block
or derail a phase-by-phase implementation. Every claim below was checked against the actual repo
(five parallel code investigations + direct greps); each finding cites the repo file that confirms
or contradicts the plan.

**Headline.** The plan is unusually well-grounded — most cited files, patterns, and seams are real
and work as described (LlamaServer/sidecar, lazy `ensureStarted`, `readChatSSE`, STREAM/job
patterns, audit privacy rule, shred sweep, offline-guard loopback exemption, role-filtered
recommender). But it has **three load-bearing assertions that are false or unproven as written**,
and it **understates the cost of its two structural changes** (two-file model, CSP). Verdict:
**implementable-with-changes**, not as written. The V1 research gate is the right firewall.

---

## Severity-sorted summary

| ID | Persona | Sev | One-line |
|---|---|---|---|
| RUNTIME-2 | Runtime | HIGH | Vision sidecar won't inherit `--jinja`; multimodal chat-template likely needs it — `readChatSSE` reuse unproven |
| RUNTIME-3 | Runtime/IPC | HIGH | Vision is a *separate* sidecar: "one job at a time" not inherited; chat+vision+embedder co-resident |
| DIST-1 | Manifest | HIGH | "Two files, one job" is a real refactor (job/task/weightPath/install-state all singular), not "the smallest change" |
| SEC-1 | Security | HIGH | CSP has no `blob:`; §13's "already permitted" is false; `createObjectURL` preview needs a CSP edit or `data:`-only |
| RUNTIME-1 | Runtime | HIGH | Entire Option A multimodal path is absent from the codebase + unproven on b9585 (correctly V1-gated, but over-confidently framed) |
| RUNTIME-4 | Runtime | MED | Idle-teardown introduces a start/teardown race the `e5.ts` precedent doesn't cover |
| IPC-1 | IPC | MED | ~20 MiB bytes cross the bridge twice; `readBytes` redundant on the drag-drop path |
| IPC-3 | IPC | MED | "busy or queue" left ambiguous; contradicts the §5.6 state table |
| UX-1 | UX | MED | "5 primary" justification misrepresents Skills; Images is a genuine 6th |
| UX-3 | UX | MED | Error taxonomy misses decode-fail/HEIC/EXIF/animated/zero-byte/multi-drop |
| PROD-1 | Product | MED-HI | 12–16 GB bar optimistic vs a 14 GB-tier chat model co-resident |
| TEST-1 | Release | MED | V1 assumes a license-clean GGUF+mmproj loads on b9585 — unverified |
| IPC-2 | IPC | LOW | `chooseImage` rich return is new, not the `pickDocuments` shape |
| SEC-3 | Security | LOW | `imageReadBytes` re-validation is new code, not an inherited guard |
| UX-2 | UX | LOW | Rail "100px / 12px floor" not in design-guidelines |
| PROD-2 | Product | LOW-MED | `VisionStatus` has no `locked` reason; status/lock double-gate is incoherent |
| DIST-2/DIST-3/SEC-2/SEC-4/TEST-2/PROD-3 | various | LOW✓ | Positive confirmations (see §"Confirmations to preserve") |

---

## Persona 1 — llama.cpp / multimodal runtime engineer

**RUNTIME-1 · HIGH · §1, §7 Option A, §9, §12 — the entire multimodal path is unproven and absent
from the codebase.** A grep for `image_url|mmproj|--mmproj|mtmd|clip` across
`apps/desktop/src/main` returns **zero** multimodal hits; current image handling is OCR-to-text
only (`ingestion/parsers/image.ts`). The plan *does* correctly gate this at V1 (§19.1), but §1 and
§7 repeatedly present Option A as "RECOMMENDED" and assert "the SSE shape is identical to text
chat" as if proven. `model-manifests/runtime-sources.yaml` pins `b9585` as standard release zips
with no record of whether `llama-mtmd-cli` or server vision is compiled in.
→ *Resolution:* Keep V1 as a hard gate, but downgrade §1/§7 confidence language to "candidate,
pending V1." Treat V2–V5 as blocked until V1 returns. Add an explicit decision branch for "server
accepts `--mmproj` but the chat-template path differs."

**RUNTIME-2 · HIGH · §7 line 252 — `readChatSSE` reuse assumes `--jinja`, which the vision sidecar
will NOT inherit.** `CHAT_SERVER_ARGS = ['--jinja', '--reasoning-format', 'deepseek']` is applied
**only** in `LlamaRuntime` (chat); `runtime/llama.ts:28` explicitly notes the E5 embedder
composing `LlamaServer` directly "does not get these." Option A composes `LlamaServer` directly
(like the embedder), so a vision sidecar gets **no `--jinja`**. Multimodal chat-template handling
in llama-server generally **requires `--jinja`**, and `--reasoning-format deepseek` may be actively
harmful for a non-reasoning VLM. The plan never lists `--jinja` in its `visionServerArgs`.
→ *Resolution:* V1 must determine the exact arg set for vision (`--jinja` yes/no, mmproj flag
spelling, whether `--reasoning-format` must be omitted); stop implying the chat arg path transfers
for free.

**RUNTIME-3 · HIGH · §7, §9.4, §14 — vision is a *separate* sidecar, so "one job at a time" and RAM
bounding are NOT inherited; they are new invariants.** The "hard one-job-at-a-time rule" lives in
`analysis/model-slot-arbiter.ts` and governs the **chat** `RuntimeManager` slot only. A vision
sidecar (Option A) is an independent `llama-server` process — like the embedder, it can run
**concurrently** with chat. So §9.4/§14's claim that vision inherits "the documented
single-local-model invariant" is **false**: at peak you can have chat + embedder + vision =
**three** resident `llama-server` processes.
→ *Resolution:* Specify vision-internal serialization explicitly (it is not free), and re-baseline
§14's RAM math against co-resident chat+embedder, not vision alone.

**RUNTIME-4 · MEDIUM · §7 idle teardown — introduces a race the cited `e5.ts` precedent does not
cover.** The plan says "copy `embeddings/e5.ts` lines ~118–173," but E5's `suspend()` is
event-driven (lock/quit), **not** on an idle timer. Adding a 2–5 min idle-teardown timer creates a
new race: teardown firing while `ensureStarted()` single-flights, or an `analyze` arriving
mid-teardown (`suspend()` resets `startFailed=null` at `e5.ts:270`).
→ *Resolution:* Specify the teardown/start interlock (cancel idle timer on `ensureStarted`, guard
`stopped`/`starting`) as net-new V4 work, not a copy.

---

## Persona 2 — Model / manifest & distribution engineer

**DIST-1 · HIGH · §8.2–§8.3 — "two files, one job" is described as "extends naturally / the
smallest change," but every layer is hardcoded single-file.** Verified singular assumptions:
`models.ts:weightPath()` returns **one** path; `computeInstallState()` checks `existsSync` on
**one** path and hashes **one** file; `DownloadJob`/`ModelDownloadTask` carry singular
`url`/`dest`/`expectedSha256`/`totalBytes`/`receivedBytes`; `downloads.ts` verify-before-rename
renames **one** `.part`; `assets.ts:planModelDownloads()` and `scripts/fetch-models.sh` emit
**one** dest per manifest. Downloading a gguf **and** an mmproj atomically requires progress
aggregation across two files, two-phase verify (verify both before any rename), and partial-failure
recovery semantics — none of which exist.
→ *Resolution:* Reframe §8 effort honestly. Strongly prefer **two `DownloadJob`s/tasks sharing one
`modelId`** (sequential, each already atomic; install = both done) over one job downloading two
files. Decide before V2.

**DIST-2 · LOW (positive) · §8.2 — the "vision mis-picked as chat" risk is already mitigated.**
Confirmed safe: `recommendModelIdByRam()` hard-filters `manifests.filter(m => m.role === role)`,
and `selectModel()` throws for any role other than `chat`/`embeddings` (`models.ts:660`). A
`role:vision` model cannot be auto-recommended or *started* as chat.

**DIST-3 · LOW · §8.4 — `models/vision/` must be added to `DRIVE_LAYOUT_DIRS` or `prepare-drive`
won't create it.** Manifest discovery (`drive.ts:collectManifestFiles`) **is** recursive, so
`model-manifests/vision/` needs no discovery change (plan correct). But `DRIVE_LAYOUT_DIRS`
(`drive.ts:35–63`) is an explicit allow-list with no `models/vision`. Plan acknowledges this — just
don't forget the test (`drive.test.ts`).

---

## Persona 3 — IPC / preload & main-process architect

**IPC-1 · MEDIUM · §9.2, §11, §13 — the image bytes cross the structured-clone bridge twice,
redundantly.** Flow as written: `chooseImage`→`readBytes(path)` (main reads file, ships
`Uint8Array` **to** renderer), renderer decodes/downscales/previews, then `analyze(imageBytes)`
ships bytes **back to** main. For a ~20 MiB cap that's two ~20 MiB structured-clone copies per
analysis (the `transcribeDictation(audio: Uint8Array)` precedent confirms binary-over-invoke works,
at smaller sizes). For drag-drop the renderer already holds the `File` bytes, so `readBytes` is
pure overhead.
→ *Resolution:* Drop `readBytes` for the drag-drop path; keep it only for the picker path. Document
the per-analyze memory cost. (Preview needs bytes in-renderer regardless for `blob:`/`data:`.)

**IPC-2 · LOW · §9.2/§10 — `imageChooseImage` returns `{path,name,sizeBytes}`, but the cited
`pickDocuments` precedent returns `string[]` only.** `registerDocsIpc.ts` `pickDocuments` returns
bare `filePaths: string[]`. The plan's richer return is a **new** handler shape (name from
`basename`, size from a `stat`), not a verbatim reuse.

**IPC-3 · MEDIUM · §9.4 vs §5.6 — "returns `busy`, or queues" is left ambiguous, and contradicts
the state table.** §9.4 says a second analyze "returns `busy`, or queues"; §5.6 maps "Model busy"
to "returns busy / queued." These imply different UIs and different `ImageJobState` semantics
(`queued` already exists in the enum, implying queueing).
→ *Resolution:* Decide busy-reject vs single-depth-queue before V2 (recommend busy-reject); shapes
the IPC contract and §5.6 copy.

---

## Persona 4 — Security & privacy auditor

**SEC-1 · HIGH · §13 — the CSP claim is FALSE as written; `blob:` is not permitted, so
`URL.createObjectURL` previews silently need a CSP edit (a §0 red line).** Exact prod CSP
(`main/index.ts:367–369`): `img-src 'self' data:` — **no `blob:`**. The plan §13 asserts "`blob:`…
both already permitted by the prod CSP" and "`blob:` is same-origin object URLs"; that is
incorrect — `blob:` must be explicitly listed in `img-src` or the `<img>` load is CSP-blocked. Yet
§11 `ImagePreview.tsx` is specified to render via `URL.createObjectURL(blob)` (a `blob:` URL). The
plan contradicts itself.
→ *Resolution (blocker):* Choose `data:`-only preview (no CSP change; note the ~33% base64 memory
inflation, downscale-first mitigates) **or** an explicit, reviewed `blob:` CSP addition. Delete the
"already allowed" claim and make §11 + §13 consistent. Recommend `data:`-only.

**SEC-2 · LOW (positive) · §12 — the `.parse-vision` shred sweep claim is CORRECT.** Confirmed:
`shredStalePlaintext` matches `name.includes('.parse')` (`workspace-vault.ts:363`), so
`<uuid>.parse-vision.<ext>` **is** swept (substring match). `shredFile` and the dictation
shred-in-`finally` precedent are real.

**SEC-3 · LOW · §13 — `imageReadBytes(path)` re-validation is a *new* guard, not an inherited
one.** `known-limitations.md` confirms `importDocuments` **trusts** renderer-supplied paths with no
main-side re-validation (deferred hardening). The plan reuses that stance but also promises
`imageReadBytes`/`analyze` "re-validate extension + cap in main" — that re-validation does not
exist today and must actually be written. Call it out as new, not "the same accepted stance."

**SEC-4 · LOW (positive) · §12/§13 — privacy, audit, offline, permissions posture all check out.**
Confirmed: audit rows are `{id,event_type,message,metadata_json,created_at}` with a hard
"ids/model-ids/filenames/counts, no content" rule and a sentinel test (`audit-ipc.test.ts`); chat
content never reaches `app.log`; dictation's "content-adjacent, no audit event" precedent is real
(the right model for vision prompt/answer); the offline guard exempts loopback and is
detection-only (a loopback sidecar won't trip it); `installPermissionRequestHandler` is
microphone-only and rendering `data:`/`blob:` images needs **no** new permission.

---

## Persona 5 — UX / design-guidelines & i18n reviewer

**UX-1 · MEDIUM · §6 — the "5 primary" justification misrepresents the baseline.**
`design-guidelines.md §2`: "Collapse 7 nav destinations into **5 primary + 1 utility**" — and the
current `NAV_TOP` is exactly those 5 (Home/Chat/Documents/Models/Skills). The plan claims "Skills
was already added as a 5th" implying a precedent for going beyond 5 — but **Skills is one of the
five**, not a sixth. Adding Images genuinely makes **6 primary**.
→ *Resolution:* Drop the "Skills was a precedent 6th" framing; argue the 6th honestly and update
design-guidelines §2 if 6 is the new target.

**UX-2 · LOW · §6 — "100px rail / 12px font floor" is not in design-guidelines.** No rail
column-width or nav-label font floor is documented (`--text-xs: 12px` exists but isn't tied to nav
labels). Soften to an unverified fit assumption or cite the real token.

**UX-3 · MEDIUM · §5.6, §9.3 — the error taxonomy is incomplete; several real inputs have no
state.** `VisionErrorCode = tooLarge|unsupportedType|runtimeFailed|emptyResponse|cancelled|busy`
and the §5.6 table omit: **corrupt/undecodable image** (`createImageBitmap` throws),
**HEIC/other masquerading as `.jpg`**, **EXIF orientation** (image sent sideways → wrong answer),
**animated/multi-frame PNG**, **zero-byte file**, and **multi-image drop** (§11 silently takes
`files[0]` — a non-goal that should reject, not silently drop). The downscale algorithm
"when/how" (cap, re-encode format, quality) is also under-specified.
→ *Resolution:* Add `decodeFailed` to the enum + a §5.6 row; specify EXIF normalization via the
canvas re-encode; specify multi-drop rejection copy and the downscale algorithm. (Note: i18n
plumbing, components, the composer Enter/Shift+Enter convention, the WCAG checklist, and the
missing `'image'` glyph flag all check out.)

---

## Persona 6 — Test & release engineer

**TEST-1 · MEDIUM · §15/§16 V1 — the V1 gate depends on an external GGUF+mmproj that is assumed,
not verified.** V1 requires "a fetched VLM GGUF + mmproj" with a real URL, license, and SHA. The
plan never confirms such an artifact exists/loads on the **pinned** runtime. Corroborating pin
risk: `model-policy.md:29` already records newer-arch models "may not load until the runtime pin is
bumped," and the new Qwen3.5 entry is "Vision model run text-only."
→ *Resolution:* Make "locate a license-clean GGUF+mmproj that loads on b9585" the literal first V1
task; if none loads, V1 fails into the Option-C + pin-bump branch immediately.

**TEST-2 · LOW (positive) · §16/§17 — the green-gate phase ordering is sound and the test seams are
real.** Confirmed: `LlamaServerOptions` exposes `spawn`/`fetchImpl`/`findPort` seams, so
`VisionRuntime` is testable without a binary; status returns `available:false` with zero models, so
V2 leaves the suite green before V4 exists; the `audit-ipc.test.ts` sentinel pattern and
offline-guard tripwire are real and reusable.

---

## Persona 7 — Product / scope & roadmap skeptic

**PROD-1 · MEDIUM–HIGH · §14/§15 — the "useful on 12–16 GB" acceptance bar is optimistic given chat
co-residency.** The bundled chat winner is Gemma 4 12B (~7 GB weights, **14 GB** RAM tier;
`model-policy.md:27`). With a user's chat model loaded and the vision sidecar (3B ~3.2 GB) **plus**
the E5 embedder co-resident (RUNTIME-3), a 12 GB machine will likely OOM and even 16 GB is tight.
Idle-teardown bounds the *window*, not the *peak* during active use.
→ *Resolution:* Qualify the bar: vision realistically co-resident only with a **small** chat model,
or only after the chat sidecar idles out. State honestly in §14 and `known-limitations.md`.

**PROD-2 · LOW–MEDIUM · §10 vs §9.3 vs §5.6 — the "locked" status is type-incoherent.**
`VisionUnavailableReason = 'no-model'|'no-runtime'|'incompatible'`, and `reason` is "present iff
`!available`." But §10 says status "returns `available:false` cleanly when the workspace is locked"
— there's **no reason value for locked**. Double-gating with an unrepresentable state.
→ *Resolution:* Either add a `'locked'` reason or document that status is workspace-agnostic and
the screen owns the lock gate (model weights aren't encrypted, so status need not fail on lock).

**PROD-3 · LOW (positive) · §3 — non-goals are honored with no hidden hook.** Confirmed coherent:
no `documents`/`chunks`/`embeddings` writes, ephemeral renderer-only state, "Try again" only exists
while the image is present. The WEBP-out default is grounded — `ingestion/parsers/image.ts:18`
declares exactly `['.png','.jpg','.jpeg']`.

---

## Confirmations to preserve (do NOT re-open — already correct/safe)

- **Role-filter prevents vision-as-chat** (`models.ts` filter + `selectModel:660`). (DIST-2)
- **Shred sweep covers `.parse-vision`** via `includes('.parse')`. (SEC-2)
- **Audit / offline-guard / permissions posture sound**; loopback exempt; no content in logs;
  no new permission surface for `data:`/`blob:` images. (SEC-4)
- **Green-gate phase ordering + `spawn`/`fetchImpl`/`findPort` test seams real**; V2 leaves the
  suite green before V4. (TEST-2)
- **WEBP-out grounded** (`ingestion/parsers/image.ts`). (PROD-3)
- **Manifest discovery recursive** (`model-manifests/vision/` needs no discovery change; but
  `models/vision/` DOES need adding to `DRIVE_LAYOUT_DIRS`). (DIST-3)

---

## BLOCKERS before any code

1. **RUNTIME-1/2 (V1 gate):** Do not write V2 until V1 proves, on pinned b9585: (a) server
   multimodal exists at all, (b) base64 `image_url` vs file-path, (c) the exact arg set —
   specifically whether `--jinja` is required and `--reasoning-format` must be dropped. If
   multimodal is absent → Option C + a **runtime-pin bump** (major, reviewed change per
   `model-policy.md` "To bump the release"). Everything downstream is contingent.
2. **SEC-1 (CSP red line):** Decide `data:`-only preview (no CSP change) vs an explicit reviewed
   `blob:` addition **before** building `ImagePreview`. Delete the false "already permitted" claim.
3. **DIST-1 (two-file model):** Decide the download topology — *two jobs sharing a modelId* vs *one
   job, two files* — before V2 touches `manifest.ts`/`models.ts`/`downloads.ts`.

## Decisions the plan leaves dangerously implicit

- **Vision-internal serialization** is presented as inherited; it must be *built* (RUNTIME-3). The
  real peak-RAM ceiling (chat 12B + embedder + vision) is not stated (PROD-1).
- **Busy vs queue** for a second analyze (IPC-3).
- **Preview encoding** (`data:` vs `blob:`) — a security *and* memory decision (SEC-1, IPC-1).
- **EXIF / decode-failure / multi-frame / multi-drop handling** (UX-3).
- **Idle-teardown interlock** semantics (RUNTIME-4).
- **`locked` status representation** (PROD-2).
- **Streaming vs poll** (§19.10) and **GPU vs CPU** (§19.11) are filed as "defaults" but are
  load-bearing for IPC surface and the acceptance bar respectively.

## Verdict — top 5 to fix first

**Implementable-with-changes.** The substrate is real and the reuse strategy is sound, but the plan
ships one false security claim (CSP `blob:`), two over-confident runtime assertions (`--jinja`
inheritance, "one job at a time" inheritance), and one materially understated refactor (two-file
download).

1. Rewrite §13's CSP paragraph — it is factually wrong; pick `data:`-only or a reviewed CSP edit.
2. Make V1 also resolve the vision arg set (`--jinja`/`--reasoning-format`), not just
   base64-vs-path — and lower §1/§7 confidence until V1 returns.
3. Reframe §8 two-file work honestly and choose the two-jobs-one-modelId topology.
4. Add vision's own serialization + a realistic co-resident RAM ceiling.
5. Complete the error taxonomy and fix the `locked`/`busy` contract ambiguities.

Nothing here is fatal; the V1 gate is the right firewall. Fix the four mischaracterizations and
tighten the implicit decisions, and this becomes a clean phase-by-phase build.
