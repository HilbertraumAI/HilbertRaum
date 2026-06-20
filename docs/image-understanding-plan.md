# Image Understanding — implementation plan

_Status: PLAN (no code written yet). Created 2026-06-20 on branch `image-understanding`._

This is a working plan per the CLAUDE.md doc-lifecycle rule: it stays a standalone `*-plan.md`
while the work is open, and is condensed into a §-numbered design record (folded into
[`architecture.md`](architecture.md), with model/manifest facts into [`model-policy.md`](model-policy.md))
once shipped — then this file is deleted (the full original stays in git history).

It is written so a later session can implement the feature **phase by phase** (V0→V5) without
re-deriving the repo shape. Concrete file paths + the patterns to mirror are cited inline.

---

## 1. Summary and recommendation

Add a **new, separate top-level screen — "Images"** — that lets a user load **one** image
(PNG/JPEG), ask a local question about it, and get an answer from a **local vision-language model**
running on the existing `llama.cpp` sidecar machinery. It is **visual understanding**, distinct from
the existing **OCR** feature (tesseract.js, Documents) and from any image *generation/editing* (not
built, ever — see §3).

**Recommendation.** Build it as a thin, self-contained vertical that **reuses** four existing
substrates and invents as little as possible:

1. **Runtime:** a **dedicated, lazily-started `llama-server` instance** spawned with a **vision**
   GGUF plus a **multimodal projector (`--mmproj`)**, modeled on the `E5Embedder` /
   `LlamaReranker` lazy-sidecar pattern (own `LlamaServer`, loopback-only, lazy `ensureStarted`,
   lock/quit teardown) — **NOT** the active chat `RuntimeManager` (keep Chat undisturbed; the
   chat model and the vision model differ). It would talk to `/v1/chat/completions` with an
   OpenAI-style `content: [{type:'text'}, {type:'image_url'}]` message **IF** the pinned server build
   supports multimodal at all — which is **unproven** and is the V1 gate (§7, §19.1). Two
   consequences follow from "separate sidecar, composed directly" and are easy to miss:
   - It composes `LlamaServer` **directly** (like the embedder), so it does **NOT** inherit the chat
     slot's `CHAT_SERVER_ARGS = ['--jinja', '--reasoning-format', 'deepseek']` (`runtime/llama.ts:28`
     states this explicitly for the embedder). The exact vision arg set — whether `--jinja` is
     **required** for the multimodal chat template, whether `--reasoning-format deepseek` must be
     **dropped** for a non-reasoning VLM, and the `--mmproj` flag spelling — is **V1's job to
     determine** (RUNTIME-2). Do not assume the chat arg path or `readChatSSE` transfer for free.
   - It is an **independent** process, not the chat slot, so the chat slot's "one local model at a
     time" arbiter does **not** govern it. At peak you can have **chat + embedder + vision = three**
     co-resident `llama-server` processes; vision needs its **own** one-job serialization (new work,
     §9.4) and the §14 RAM math must be re-baselined against that co-residency (RUNTIME-3, PROD-1).
2. **Model pipeline:** a new `role: vision` manifest carrying an **`mmproj` projector sub-block**;
   it rides the existing SHA-256 verify + `fetch-models` + in-app downloader + state machine with
   minimal additions.
3. **IPC/preload:** a new `images:*` channel group + typed `window.api` methods, following the
   `downloadModel`/`getDownloadJob`/`cancelDownload` async-with-polling job pattern.
4. **UI:** a new `ImagesScreen` using the existing component kit (`EmptyState`, `Button`, `Banner`,
   `Chip`, `Spinner`, `Progress`) and i18n catalogs, added to `NAV_TOP` after Documents, before AI Model.

**Image bytes never touch the network and ideally never touch the disk:** the main process
**base64-inlines** the bytes into the loopback HTTP request to the sidecar (no temp file). A
file-path fallback (transient `<uuid>.parse-vision.<ext>` under `workspace/documents/`, shredded in
`finally`) is specified in case the pinned server build requires a path (a **V1 research gate**).

**Zero-vision-model posture is first-class:** with no vision manifest/weights/projector/runtime, the
screen shows a calm availability state, the app still launches, and **all tests pass** — the same
"real backend is a drop-in when the files appear" contract as chat/embeddings
([`packaging.md`](packaging.md) "How the app uses them at runtime").

**No new native npm dependency.** Image decode/preview/optional-downscale is done with **built-in
browser APIs in the sandboxed renderer** (`createImageBitmap`, `OffscreenCanvas`/`<canvas>`,
`canvas.toDataURL`/`convertToBlob`+`FileReader`) — no `sharp`/`jimp`/`canvas`. The preview renders
from a **`data:` URL**, not a `blob:` URL: the prod CSP is `img-src 'self' data:` (`main/index.ts:367-369`)
and does **not** list `blob:`, so a `URL.createObjectURL` preview would be CSP-blocked (SEC-1, §13).
The vision model's own `clip`/`libmtmd` preprocessing resizes to the projector's expected resolution
regardless, so client downscaling is a payload/memory optimization, not a correctness requirement —
and the downscale re-encode is also where **EXIF orientation is normalized** (§11, §7, §12).

---

## 2. Product definition

**User-facing feature: "Ask about an image."** Load one screenshot, chart, diagram, form, receipt,
or photographed page; ask a question in plain language; get a locally-generated answer. Everything
stays on the drive.

**Supported image types (MVP):** **PNG, JPG/JPEG**. WEBP is an **open decision (§19)** — defaulted
**out** of MVP (the existing import stack only declares png/jpg/jpeg; adding WEBP must be proven safe
with no new dependency first). PDFs are **out of scope** for this screen (scanned/image PDFs belong
to Documents → "Make searchable (OCR)").

**Answer posture (conservative, see §"Answer behavior" / prompts in §5.5):** answer only from
visible content; admit when text is unclear/blurred or not visible; never invent hidden context; for
extraction, mark unreadable fields `unclear`/null; distinguish "visible text" (OCR-like) from
interpretation. A small ambient note accompanies every answer: **"Generated locally from the
selected image."**

**Follow-ups:** a short **per-image thread** lets the user ask several questions about the same
image. **MVP storage = ephemeral in-memory renderer screen state only** (not persisted; see §12).
Removing/replacing the image clears the preview and the thread.

---

## 3. Explicit non-goals

Do **not** plan or build, now or as a hidden hook:

- Image **generation**, **editing**, background removal, inpainting/outpainting.
- **Object detection boxes / segmentation / YOLO** as a standalone feature or runtime.
- **OCR replacement.** OCR (tesseract.js, Documents) is untouched and stays the path for scanned
  documents. The Images screen must not silently OCR or route to OCR.
- **Auto-analysis on import**, and **auto-indexing** of model image descriptions into the document
  corpus (no `documents`/`chunks`/`embeddings` writes from this feature).
- **Multi-image comparison**, video, camera capture, screen recording.
- **Any** network/cloud/hosted-AI path; **any** telemetry; **any** image/prompt/answer content in
  logs or audit.
- New **native** npm dependency (a proposal to add one is a **major decision gate**, §19).

---

## 4. User flows

1. **Open "Images"** from the nav rail (new item, §6).
2. **No vision model available** → calm availability state (§5.1): title "Understand an image", the
   reassurance + availability lines, a CTA that routes to **AI Model** via the existing
   `navigate('models')` (no invented downloads — the AI Model screen owns the triple-gated downloader),
   and a one-line pointer that OCR for scanned documents lives under Documents.
3. **Vision model available** → large **drop zone** (§5.2): "Drop an image here / or choose an image",
   small "PNG or JPEG" note.
4. **Image selected** → **two-pane workspace** (§5.3): left = preview + filename + dimensions/size +
   remove/replace; right = question composer + suggestion chips + results/thread.
5. **Suggestion chips** (§5.5) fill (or fill-and-send) a sensible prompt; the user may also type a
   custom question.
6. **Submit** → main base64-inlines the image + question to the local vision sidecar; the answer
   streams/returns into the right pane with the ambient "Generated locally…" note, **Copy**, **Try
   again**, and **Clear / New image**.
7. **Follow-up** questions append to the per-image thread (ephemeral).
8. **Remove image** clears preview + thread.

**State coverage (must all be designed — §5.6):** no vision model · runtime/binary missing · model
installed but incompatible with the pinned runtime · model starting · model busy (one-at-a-time) ·
image selected but no question · image too large · unsupported type · analysis running (with cancel) ·
runtime failure · malformed/empty model response · new image selected mid-analysis (cancels the old
job) · workspace locked (sidecar torn down; screen explains + offers unlock via the existing gate).

---

## 5. UI/UX design for the Images screen

Follow [`design-guidelines.md`](design-guidelines.md) throughout: **calm over clever**, privacy
ambient (the existing rail-foot `LocalIndicator` already shows "Offline"/"Downloads on" app-wide —
§11.7 — so the screen adds **no** new privacy chrome), **human labels** (never "mmproj",
"quantization", "Vulkan", checksums, GPU backend, build hash on the everyday screen — those belong to
Diagnostics/"Technical details" only), progressive disclosure, Windows-grade focus rings + keyboard +
drag-drop + file picker, friendly specific errors.

Component kit (import from `renderer/components`): `EmptyState`, `Button`, `Banner`, `Chip`,
`Spinner`, `Progress`, `Icon`, `useToast`. Screen file: `renderer/screens/ImagesScreen.tsx`
(mirror `DocumentsScreen.tsx` structure — `useT()` for i18n, `window.api?.…` for IPC, local `useState`,
`EmptyState` for empty/unavailable).

### 5.1 Availability state (no vision model / no runtime / incompatible)

`EmptyState`-based. Title **"Understand an image"**; body **"Ask questions about a screenshot, chart,
form, receipt, or photo. Everything stays local."**; an `availability note` line that adapts to the
`reason` (§10): `no-model` → "Image understanding needs a local vision model on this drive.";
`no-runtime` → reuse the existing "Install the AI engine" framing (do not duplicate copy — point to
AI Model); `incompatible` → "This drive's vision model needs a newer engine." Primary `Button` =
**"Go to AI Model"** (`onNavigate('models')`). A quiet secondary line: **"Scanned documents? Use
Make searchable (OCR) under Documents."** No scary technical copy; the technical reason goes to the
local log only.

### 5.2 Drop zone (model available, no image yet)

A large, focusable drop target (`role="button"`, keyboard-activatable, visible `:focus-visible`
ring): headline **"Drop an image here"**, secondary **"or choose an image"** (a `Button` that calls
`images:chooseImage`), supported-type note **"PNG or JPEG"**. Drag-over highlights the zone. A
non-drag path is mandatory (WCAG 2.5.7) — the "choose an image" button is it.

### 5.3 Two-pane workspace (image selected)

Calm, document-workspace-like (not an "AI art" canvas). Two columns within the screen's content width:

- **Left — preview pane:** the image (object-fit contained, capped height), filename (mono, ellipsized),
  a muted meta line "PNG · 1.2 MB · 1280×720" (dimensions from the renderer decode; "Technical details"
  not needed — size/dims are human), and a **Remove / Replace** control.
- **Right — work pane:** suggestion chips (§5.5), the question composer (auto-grow textarea, Enter=send /
  Shift+Enter=newline — the composer convention from design-guidelines §6), and the **answer thread**
  (§5.4) below.

### 5.4 Answer / thread panel

Each turn: the user question (quiet) then the answer block. The answer block carries the ambient note
**"Generated locally from the selected image."**, a **Copy** button (toast "Copied" via `useToast`),
and **Try again** (re-runs the same question — re-asking is cheap and expected). A persistent **Clear /
New image** affordance resets preview + thread. While analyzing: a calm streaming caret / "Reading the
image…" line (determinate progress is not available token-by-token; show an indeterminate calm state,
never a full-screen spinner) and a **Stop** button (cancel, §9/§10).

### 5.5 Suggestion chips (exact MVP strings — refine for tone/i18n)

Render as `Chip`s; clicking fills the composer (and may auto-send — open decision, default **fill,
don't auto-send**, so the user can edit). Each maps to a prompt (these become i18n values, English
canonical):

| Chip label | Prompt sent |
|---|---|
| Summarize this image | "Summarize the visible content of this image. Mention anything important or unusual." |
| Extract visible text | "Extract the visible text you can read. Preserve line breaks where helpful. Say if any text is unclear." |
| Explain this chart | "Explain what this chart appears to show. Mention axes, labels, trends, and any uncertainty." |
| Read this form | "Identify the key fields and values visible in this form. Use 'unclear' where you cannot read something." |
| Find important details | "List the most important visible details. Do not infer anything that is not visible." |
| What should I notice? | "What should I notice in this image? Point out the most salient visible elements only." |

### 5.6 State → UI mapping (the must-design table)

| State | Source | UI |
|---|---|---|
| No vision model | `getStatus().reason='no-model'` | §5.1, CTA → AI Model |
| Runtime/binary missing | `reason='no-runtime'` | §5.1, "Install the AI engine" framing |
| Installed but incompatible | `reason='incompatible'` | §5.1, "needs a newer engine" |
| Model starting | analyze in flight, first job | calm "Starting the vision model…" (sidecar cold-load) |
| Model busy (one-at-a-time) | analyze returns `busy` (busy-**reject**, not queue — §9.4) | "Working on the previous question…" + the active job's Stop; the new question is **not** queued |
| Image selected, no question | local state | submit disabled; chips available |
| Image too large | client guard + main guard | Banner "This image is too large to analyze. Try a smaller image." |
| Unsupported type | client guard + main guard | Banner "That file type isn't supported. Choose a PNG or JPEG." |
| Corrupt/undecodable image (incl. HEIC-as-`.jpg`, animated/multi-frame, zero-byte) | `createImageBitmap` throws → `decodeFailed` (client guard) | Banner "That image couldn't be opened. It may be damaged or in an unsupported format." |
| Multiple images dropped at once | client guard (`files.length > 1`) | Banner "Drop one image at a time." — **reject**, do not silently take `files[0]` |
| Analysis running | job state `analyzing` | streaming/indeterminate + Stop |
| Runtime failure | job `failed` | Banner "The vision model couldn't start. Try again, or pick another model." (technical reason → log only) |
| Empty/malformed response | job `done` + empty text | Banner "No answer came back for that image. Try rephrasing your question." (never raw output) |
| New image mid-analysis | UI cancels old job, starts fresh | old Stop fires `images:cancel`; thread resets |
| Workspace locked | `workspaceReady=false` / lock event | screen shows the existing locked posture; sidecar already torn down (§13) |

---

## 6. Navigation and information architecture changes

Mirror the exact wiring found in the renderer:

- **`renderer/navigation.ts`** — add `'images'` to the `ScreenId` union; add a `case 'images': return
  { screen: 'images' }` to `resolveNavTarget` (and accept `'images'` in the passthrough list).
- **`renderer/App.tsx`** — add to `NAV_TOP` **after `documents`, before `models`**:
  `{ id: 'images', labelKey: 'nav.images', icon: 'image' }`; add the render branch
  `{screen === 'images' && <ImagesScreen onNavigate={navigate} />}`.
- **`renderer/components/Icon.tsx`** — add an `'image'` glyph to `IconName` + `GLYPHS` (a simple
  Feather/Lucide "image" outline: rect + sun/mountain). Inherits `currentColor`.
- **i18n** — add `nav.images` ("Images" EN / „Bilder" DE) and the `images.*` keys (§11) to both
  `shared/i18n/en.ts` and `de.ts` (German informal „du", D-L7; glossary-consistent).

IA note — **be honest about the count.** `design-guidelines.md §2` says "Collapse 7 nav destinations
into **5 primary + 1 utility**," and the current `NAV_TOP` *is* exactly those five
(Home · Chat · Documents · Models · Skills). **Skills is one of the five, not a precedent sixth** —
so adding Images makes a genuine **6th primary destination**. That is a real IA change, not a
free extension: it must be argued on its own merits (image understanding is a distinct first-class
task surface, parallel to Documents/Chat, not a sub-mode of either) and, **if 6 becomes the target,
`design-guidelines.md §2` must be updated** to say "6 primary + 1 utility" so the doc and the code
don't contradict.

Rail fit is an **assumption to verify, not a documented constraint**: design-guidelines does not
specify a rail column width or a nav-label font floor (a `--text-xs: 12px` token exists but is not
tied to nav labels). „Bilder" (DE) and "Images" (EN) are both short, so the new label is *expected*
to fit the existing rail without reflow — confirm visually during V3, and if it doesn't fit, that's
a rail-layout decision, not a silent truncation.

**Open decision (§19):** final label **"Images"** vs "Image Understanding". Plan defaults to **"Images"**
(matches the one-word rail labels; the screen title carries the fuller "Understand an image").

---

## 7. Runtime/model architecture options

The app already runs `llama-server` four ways (chat via `RuntimeManager`/`LlamaRuntime`; embedder,
reranker as standalone lazy sidecars) and a per-file CLI (whisper). Vision fits these precedents.

**Option A — dedicated lazy vision sidecar (CANDIDATE, pending V1 — not yet proven).** Currently
**zero** multimodal code exists in `apps/desktop/src/main` (a grep for `image_url|mmproj|mtmd|clip`
returns nothing; today's only image handling is OCR-to-text in `ingestion/parsers/image.ts`), and the
pinned **b9585** runtime is **not confirmed** to compile in server multimodal at all. So Option A is
the *recommended candidate* but its core mechanics are **unverified until V1 returns** (RUNTIME-1);
**V2–V5 are blocked on V1.** A new `services/vision/` service would own its own `LlamaServer` (from
`services/runtime/sidecar.ts`), started with the vision GGUF + `--mmproj <projector>`, modeled on
`E5Embedder`/`LlamaReranker`:
- `ensureStarted()` lazy single-flight (share one start promise across concurrent callers), `startFailed`
  latch, `stopped` guard — pattern from `embeddings/e5.ts` lines ~118–173. **But the idle-teardown
  timer below is net-new, not in that precedent** (see RUNTIME-4 note under Teardown).
- `LlamaServerOptions`: `binPath` (resolveLlamaServerPath), `modelPath`, `contextTokens`,
  `extraArgs: ['--mmproj', projectorPath, ...visionServerArgs]`, `host` defaults `127.0.0.1`,
  `findPort` ephemeral loopback, `waitForHealthy` (180 s budget). **Loopback only.**
  **`visionServerArgs` is unknown and is V1's deliverable** (RUNTIME-2): because this sidecar composes
  `LlamaServer` directly like the embedder, it does **NOT** inherit chat's
  `CHAT_SERVER_ARGS = ['--jinja', '--reasoning-format', 'deepseek']` (`runtime/llama.ts:28` says the
  embedder "does not get these"). Multimodal chat-template handling in llama-server generally
  **requires `--jinja`** — yet the plan must not assume it; and `--reasoning-format deepseek` is likely
  **harmful** for a non-reasoning VLM and may need to be omitted. V1 resolves: `--jinja` yes/no, the
  exact `--mmproj` flag spelling, and whether `--reasoning-format` must be dropped.
- Request (candidate shape, **contingent on V1**): `server.fetch('/v1/chat/completions', { method:'POST',
  body: JSON.stringify({ model, messages:[{role:'user', content:[{type:'text',text:question},
  {type:'image_url',image_url:{url:'data:image/png;base64,...'}}]}], stream:true }), signal })` then
  reuse `readChatSSE` (`runtime/llama.ts`). The SSE shape is *believed* identical to text chat, but
  **`readChatSSE` reuse is unproven** because it presumes the `--jinja` template path — V1 must confirm
  the streamed frames parse with the actual vision arg set before V4 commits to it.
- **Separate sidecar ⇒ vision needs its OWN serialization (new invariant, not inherited).** The chat
  slot's "one local model at a time" rule lives in `analysis/model-slot-arbiter.ts` and governs the
  **chat** `RuntimeManager` only. This vision sidecar is an independent process (like the embedder) and
  can run **concurrently** with chat **and** the E5 embedder — chat + embedder + vision = **three**
  co-resident `llama-server` processes at peak. "One analyze at a time" must therefore be **built into
  `services/vision/` itself** (§9.4), and the §14/PROD-1 RAM ceiling must account for the co-residency.
- **Teardown:** stop the sidecar on workspace **lock** (beside the embedder `suspend()` in
  `registerWorkspaceIpc`), on **quit** (`will-quit`), on **cancel**, and after an **idle timeout**
  (e.g. 2–5 min). **The idle timer is net-new V4 work with its own race (RUNTIME-4):** `e5.ts`'s
  `suspend()`/`stop()` are **event-driven** (lock/quit), not on a timer, so the precedent does not cover
  an idle teardown firing **concurrently** with an `ensureStarted()` single-flight or an `analyze`
  arriving mid-teardown (recall `suspend()` clears `startFailed=null` at `e5.ts:270`). Specify the
  **interlock explicitly:** cancel the idle timer on every `ensureStarted()`/`analyze` entry; guard the
  teardown against a `starting`/in-flight job (do not tear down while a job runs); after teardown, a
  fresh `analyze` re-pays a cold start cleanly. RAM: chat + vision (+ embedder) can be co-resident during
  use; the idle teardown bounds the *window*, **not the peak during active use** (PROD-1). Document it.
- GPU: vision benefits from GPU. **MVP recommendation: run the vision sidecar CPU-pinned** (`--device
  none`, the embedder/reranker precedent) to avoid VRAM contention + GPU-crash complexity, UNLESS the
  V1 benchmark shows CPU TTFA is unacceptable — then reuse the §"GPU ladder" rung approach. Flag in §19.

**Option B — swap the chat `RuntimeManager` to a multimodal chat model.** Rejected for MVP: it would
disrupt Chat (stop/restart the active model), force the *chat* model to be multimodal, and couple two
features. Revisit only if a single bundled multimodal model serves both Chat and Images well.

**Option C — one-shot multimodal CLI (`llama-mtmd-cli`), transcriber-style per-spawn.** Fallback if the
**pinned `llama-server` build lacks multimodal** (a real possibility — **V1 research gate**). The
prebuilt b9585 archives may or may not bundle `llama-mtmd-cli`; if neither server `--mmproj` nor a
bundled mtmd CLI works on the pin, the runtime pin must be **bumped** (a deliberate, reviewed change
per [`model-policy.md`](model-policy.md) "To bump the release"). Per-spawn pattern: copy
`transcriber/cli.ts` (`-m model --mmproj proj --image <path> -p <prompt>`, capture stdout, abort on
signal, shred any transient). This path **requires a temp file** for the image (CLI takes a path),
so it inherits the `.parse-vision` shred posture (§12).

**Decision gate (V1) — four branches, resolved against the pinned b9585 binary:**
1. **Server multimodal works, base64 `image_url` accepted, args resolved** → Option A, no disk write.
2. **Server accepts `--mmproj` but needs a file path, not base64** → Option A + the temp-file fallback
   (`.parse-vision` + shred-in-`finally`, §12).
3. **Server accepts `--mmproj` but the chat-template path differs** (e.g. `readChatSSE`/`image_url`
   framing doesn't parse without a specific `--jinja`/template flag, or the multimodal content array
   must be shaped differently) → Option A, but V1 **pins the exact arg set and request shape** and V4
   adopts a vision-specific SSE read if `readChatSSE` doesn't transfer. **Do not start V2 until this is
   nailed down.**
4. **Server has no multimodal at all** → Option C (mtmd CLI) **+ a runtime-pin bump** proposal — a
   major, reviewed change per [`model-policy.md`](model-policy.md) "To bump the release". Flag as a gate.

**Binary resolution / backend:** reuse `resolveLlamaServerPath(rootPath, platform, env, {isDev})` and
`resolveCpuFallbackServerPath` (`runtime/sidecar.ts`). The vision sidecar uses the **same** on-drive
`runtime/llama.cpp/<os>/` binary — no new runtime asset (only the model + projector are new).

---

## 8. Model manifest and asset/distribution changes

Vision models ride the **existing** manifest + verify + download pipeline with additive fields.

### 8.1 Manifest schema (`apps/desktop/src/shared/manifest.ts`)

- Add **`vision`** to the allowed `role` set (currently chat/embeddings/reranker/transcriber). `runtime:
  llama_cpp` + `format: gguf` unchanged.
- Add an optional **`mmproj` projector sub-block**, validated (and **required**) when `role: vision`:

```yaml
id: qwen2.5-vl-3b-instruct-q4
display_name: Qwen2.5-VL 3B Instruct Q4
family: qwen2.5-vl
role: vision
format: gguf
runtime: llama_cpp
license: apache-2.0
input_modalities: [text, image]        # NEW (informational; default [text] elsewhere)
size_on_disk_gb: 3.2                    # gguf + mmproj combined
recommended_min_ram_gb: 12             # tier gate (RAM-best-fit + insufficientRam, §"RAM gate")
recommended_ram_gb: 16
recommended_context_tokens: 4096
local_path: models/vision/qwen2.5-vl-3b-instruct-q4.gguf
sha256: <real-or-REPLACE_WITH_REAL_HASH>
mmproj:                                 # NEW — the multimodal projector
  local_path: models/vision/qwen2.5-vl-3b-mmproj-f16.gguf
  sha256: <real-or-REPLACE_WITH_REAL_HASH>
  download:
    url: https://huggingface.co/…/mmproj-…f16.gguf?download=true
    sha256: <…>
    size_bytes: 700000000
download:                               # the LM weight (existing block shape)
  url: https://huggingface.co/…/…Q4_K_M.gguf?download=true
  sha256: <…>
  size_bytes: 2500000000
  license_url: https://huggingface.co/…/LICENSE
license_review:
  status: pending | approved            # approved required for a SOLD drive (§"License review")
  reviewed_by: null
  reviewed_at: null
  notes: ""
```

Validator rules to add (pure, all-errors-collected, mirroring the existing `download` checks): `mmproj`
required iff `role: vision`; `mmproj.local_path` non-empty; `mmproj.sha256` a real lower-case hash or
`REPLACE_WITH_REAL_HASH`; a real `mmproj.download.sha256` must equal a real `mmproj.sha256` (same file).
Unknown keys stay ignored (the existing `supports_tools`/`dimensions` precedent), so older builds that
don't know `vision`/`mmproj` simply treat the manifest as `unsupported` (forward-compatible).

### 8.2 State computation (`services/models.ts`)

A vision model is `installed` only when **both** the GGUF **and** the `mmproj` exist and verify (or
both placeholder-in-dev). **Be honest that this is a real refactor, not a free extension:** every layer
below is hardcoded **single-file** today and must be taught about a second file —
- `models.ts:weightPath()` returns **one** path;
- `computeInstallState()` `existsSync`-checks **one** path and hashes **one** file;
- `DownloadJob`/`ModelDownloadTask` carry **singular** `url`/`dest`/`expectedSha256`/`totalBytes`/`receivedBytes`;
- `downloads.ts` verify-before-rename renames **one** `.part`;
- `assets.ts:planModelDownloads()` and `scripts/fetch-models.sh` emit **one** dest per manifest.

So "hash the projector too" means: extend the precedence (`unsupported → missing → checksum_failed →
installed`) to require **both** files present+verified, and extend the lazy-verify path (RT-3) and the
two-tier checksum cache to a **second** file keyed by `(path,size,mtime)`. That part extends cleanly.
The download side does **not** (see §8.3). The `vision` role appears on the AI Model screen list like
any model; an **open decision (§19)** is whether to surface a separate "Vision" group/filter there in
v1 — default: it lists under its role with a human "Vision" label, no special UI.

### 8.3 Download (`services/downloads.ts`, `scripts/fetch-models.*`)

The in-app downloader and `fetch-models` must fetch **two** files for a vision manifest (GGUF +
projector), each `.part`-staged + verify-before-rename. **Choose the topology explicitly — this is a
real decision, not "the smallest change" (DIST-1):**

- **RECOMMENDED — two `DownloadJob`s/tasks sharing one `modelId` (sequential).** The LM and the
  projector are each downloaded by the **existing, already-atomic** single-file job (singular
  `url`/`dest`/`expectedSha256`/`.part`-verify-before-rename — unchanged). The *modelId* owns both;
  "installed" = **both** jobs done + both files verified (`computeInstallState`, §8.2). This avoids
  inventing cross-file progress aggregation, two-phase verify, and partial-failure recovery. The cost
  is UI: the AI Model screen must show two sub-downloads (or one combined progress derived from two job
  states) under one model row.
- **REJECTED for MVP — one job downloading two files.** "Enqueue both in one job, report combined
  bytes" sounds smaller but is **larger**: it requires progress aggregation across two files, a
  **two-phase verify** (verify *both* `.part`s before renaming *either*, so a half-install never
  presents as installed), and new partial-failure/resume semantics — **none of which exist** in
  `DownloadJob`/`downloads.ts` today.

Decide this **before V2 touches `manifest.ts`/`models.ts`/`downloads.ts`**. Reuse the triple gate
(policy ∧ setting ∧ per-download confirmation) untouched. `fetch-models`/`prepare-drive --with-assets`
should **NOT** fetch vision by default (it's opt-in like the larger chat models); `--only <vision-id>`
or `--all-models` pulls it. `bundled_on_preconfigured_drive` decides commercial inclusion (today
unimplemented — curate with `--only`).

### 8.4 Drive layout / packaging

- New weights dir **`models/vision/`** (add to `DRIVE_LAYOUT_DIRS` in `services/drive.ts` + the
  `prepare-drive` scripts + the drive-layout doc). Git-ignored like all weights.
- New manifest dir **`model-manifests/vision/`** (committed YAML; discovered recursively by
  `resolveManifestsDir` — no code change to discovery).
- **No new runtime asset** (reuses `runtime/llama.cpp/<os>/`). If V1 forces Option C (mtmd CLI) and the
  CLI is a *separate* binary not in the archive, that becomes a `runtime-sources.yaml` change + a pin
  bump (flag as a gate).
- `electron-builder`: nothing new (weights/projectors live on the drive, never in `app.asar`).

---

## 9. IPC / preload / API design

Mirror `shared/ipc.ts` (the `IPC` const map + `STREAM`/`EVENTS` helpers), `preload/index.ts` (typed
`api`, `PreloadApi`), and the `registerDownloadIpc` async-job pattern.

### 9.1 Channels (`shared/ipc.ts`)

Add to the `IPC` const map (string-valued, the existing convention):

```ts
imageGetStatus: 'images:getStatus',
imageChooseImage: 'images:chooseImage',
imageReadBytes:  'images:readBytes',
imageAnalyze:    'images:analyze',
imageCancel:     'images:cancel',
imageGetJob:     'images:getJob',
```

Streaming (the **decided default** — §19.10; reuse the SSE the sidecar already emits): per-job
channels keyed like chat, added to `STREAM`:

```ts
imgToken: (jobId) => `images:token:${jobId}`,
imgDone:  (jobId) => `images:done:${jobId}`,
imgError: (jobId) => `images:error:${jobId}`,
```

(Contingency only, per §19.10: if V1 shows `readChatSSE` does **not** parse the vision sidecar's frames
cleanly, MVP falls back to `images:analyze` resolving once with the full answer + `getJob` polling, and
streaming is added later. Plan to stream; finalize after the V1 SSE check, before V2 fixes the contract.)

### 9.2 Preload (`preload/index.ts`)

```ts
imageGetStatus: (): Promise<VisionStatus> => ipcRenderer.invoke(IPC.imageGetStatus),
imageChooseImage: (): Promise<{ path: string; name: string; sizeBytes: number } | null> =>
  ipcRenderer.invoke(IPC.imageChooseImage),
imageReadBytes: (path: string): Promise<Uint8Array> =>
  ipcRenderer.invoke(IPC.imageReadBytes, path),
imageAnalyze: (req: ImageAnalyzeRequest): Promise<ImageJob> =>
  ipcRenderer.invoke(IPC.imageAnalyze, req),
imageGetJob: (jobId: string): Promise<ImageJob> =>
  ipcRenderer.invoke(IPC.imageGetJob, jobId),
imageCancel: (jobId: string): Promise<ImageJob> =>
  ipcRenderer.invoke(IPC.imageCancel, jobId),
onImageToken: (jobId, cb) => { /* STREAM.imgToken subscribe; returns unsubscribe */ },
onImageDone:  (jobId, cb) => { /* … */ },
onImageError: (jobId, cb) => { /* … */ },
```

`PreloadApi = typeof api` automatically extends; renderer calls `window.api.imageAnalyze(...)`.

**`imageReadBytes` is for the PICKER path only — not drag-drop (IPC-1).** Each `Uint8Array` crossing
the structured-clone bridge is a full copy (the `transcribeDictation(audio: Uint8Array)` precedent
confirms binary-over-`invoke` works, at smaller sizes). On the **drag-drop** path the renderer already
holds the dropped `File`'s bytes, so calling `imageReadBytes` would ship ~20 MiB **into** the renderer
only to ship the (downscaled) bytes **back** in `imageAnalyze` — two large copies for nothing. So:
drag-drop reads bytes from the `File` directly; **`imageReadBytes(path)` is invoked *only* after
`imageChooseImage` returns a path** (the picker has no `File`). Either way `imageAnalyze` ships the
bytes to main once — budget that ~20 MiB-per-analyze cost (§14 cap).

**`imageChooseImage`'s `{path,name,sizeBytes}` return is a NEW handler shape (IPC-2).** The cited
`pickDocuments` precedent (`registerDocsIpc.ts`) returns a bare `string[]` of file paths; the richer
return here is new code — `name` via `basename`, `sizeBytes` via a `stat` in main — not a verbatim
reuse of `pickDocuments`.

### 9.3 Types (`shared/types.ts`)

```ts
export type VisionUnavailableReason = 'no-model' | 'no-runtime' | 'incompatible'
// NOTE (PROD-2): there is deliberately NO 'locked' reason. `getVisionStatus` is
// WORKSPACE-AGNOSTIC — vision weights/projector are NOT encrypted, so status does not
// need to fail on lock. The screen owns the lock gate (it reads `workspaceReady` and shows
// the locked posture, §10/§5.6); the sidecar is torn down on lock independently (§13). So
// status can read `available:true` while the screen is showing its locked state — that is
// intentional, not a double-gate, and avoids an unrepresentable `reason` value.
export interface VisionStatus {
  available: boolean
  reason?: VisionUnavailableReason   // present iff !available
  modelId?: string                   // the installed+verified vision model, if any
  modelDisplayName?: string          // human label for the screen (no jargon)
}
export interface ImageAnalyzeRequest {
  imageBytes: Uint8Array             // the (possibly downscaled) PNG/JPEG bytes
  mimeType: 'image/png' | 'image/jpeg'
  question: string
  // mode?: reserved; MVP runs a single conservative profile (§"Answer behavior")
}
export type ImageJobState = 'queued' | 'starting' | 'analyzing' | 'done' | 'failed' | 'cancelled'
export interface ImageJob {
  jobId: string
  state: ImageJobState
  answer?: string                    // populated on 'done' (or streamed via STREAM channels)
  error?: VisionErrorCode | null     // a CODE, never raw model/runtime text (mapped to friendly copy)
}
```

`VisionErrorCode` is a small enum (`tooLarge | unsupportedType | decodeFailed | runtimeFailed |
emptyResponse | cancelled | busy`) the renderer maps to friendly localized copy — the technical reason
stays in the local log only (the chat `friendlyIpcError` precedent). **`decodeFailed`** (UX-3) is a
**client-side** code raised when `createImageBitmap` throws — covering corrupt/truncated images, HEIC
or other formats masquerading as `.jpg`, animated/multi-frame PNG the decoder rejects, and zero-byte
files. (`busy` is a busy-**reject**, never a queue — §9.4.)

### 9.4 Job pattern

`images:analyze` validates (extension, byte cap, question non-empty), creates a `jobId` (randomUUID),
returns immediately with `state:'queued'`, runs the sidecar call in the background, and **serializes to
one job at a time**. **Two things to get right here:**

- **This serialization is NET-NEW, not inherited (RUNTIME-3).** The vision sidecar is a *separate*
  process; the chat slot's one-model arbiter (`analysis/model-slot-arbiter.ts`) does not cover it. So
  `services/vision/` must enforce its own "one analyze at a time" — a single in-flight job latch in the
  vision orchestrator, not a borrowed invariant.
- **Busy-REJECT, not queue (IPC-3 — decided).** A second `analyze` while one runs returns the `busy`
  code immediately; it is **not** queued. (`ImageJobState` keeps `queued` only as the brief
  pre-`starting` state of the *single* accepted job, not a backlog.) This matches the §5.6 "Model busy"
  row ("Working on the previous question…", the new question is not enqueued) and keeps the IPC contract
  and UI simple. Single-depth queueing is explicitly rejected for MVP.

`images:cancel(jobId)` aborts via `AbortController` (passed as `signal` to `server.fetch`);
`images:getJob` polls. Unknown jobIds return a terminal `failed` (the DownloadManager `get` precedent).
The per-process `jobs` map is ephemeral (the accepted `registerDocsIpc` precedent).

---

## 10. Main-process service design

New module **`services/vision/`**:

- **`status.ts`** — `getVisionStatus(ctx): VisionStatus`. Checks, in order: is a `llama-server` binary
  resolvable (`resolveLlamaServerPath`)? → if not, `no-runtime`. Is there a `role:vision` manifest whose
  GGUF **and** mmproj are present + verified (`buildModelList`/`services/models.ts`)? → if not,
  `no-model`. Is the manifest `unsupported` under the current validator (e.g. needs a newer runtime
  feature)? → `incompatible`. Else `available` + `modelId`/`modelDisplayName`. **Pure-ish + cheap** (no
  hashing on the hot path — reuse the lazy-verify cache). **Workspace-agnostic (PROD-2):** status does
  **not** fail on lock and there is **no `'locked'` reason** — vision weights aren't encrypted, so
  status can stay `available:true` while locked. The **screen** owns the lock gate (it reads
  `workspaceReady`/lock events and shows the locked posture, §5.6), and the sidecar is torn down on lock
  independently (§13). This avoids an unrepresentable status state.
- **`runtime.ts`** — `VisionRuntime` wrapping a `LlamaServer` (Option A, §7): lazy `ensureStarted`,
  `analyze({imageBytes, mimeType, question, signal, onToken?})` building the `image_url` data-URL
  request + `readChatSSE`, `stop()`/`suspend()` for lock/quit/idle. Single-flight start; idle-timeout
  teardown. **Localhost only.** Captures stderr tail for diagnostics (never surfaced to the user).
- **`index.ts`** — barrel + the `ImageJob` orchestration the IPC layer calls.

**IPC registration** (`ipc/registerImagesIpc.ts`, registered in `main/index.ts` beside the others):
`images:getStatus|chooseImage|readBytes|analyze|cancel|getJob`. `chooseImage` opens
`dialog.showOpenDialog` filtered to `png/jpg/jpeg` (the `pickDocuments` precedent, but a **new** richer
return shape — IPC-2) and returns **path + name + sizeBytes only** (not bytes). `readBytes(path)`
re-validates extension + size cap, then `readFile`s and returns a `Uint8Array` (main owns file I/O) —
**this main-side re-validation in `imageReadBytes`/`analyze` is NEW code that must actually be written
(SEC-3)**, not an inherited guard: `importDocuments` today *trusts* renderer-supplied paths with no
main-side re-validation (`known-limitations.md`, a deferred-hardening stance). We adopt the same
accepted trust stance for path provenance, but the extension+cap re-check is net-new. `analyze` is the
job entrypoint (§9.4).
All handlers `requireUnlocked` where they touch the runtime/files; **none log content** (§13).

**Workspace coordination:** teardown the vision sidecar on lock (add to `registerWorkspaceIpc` beside
the embedder `suspend()`), and on `will-quit`. No `beginDocumentWork` lease is needed (no
`documents`/`.enc` writes — vision never persists), unless the temp-file fallback (§12) is used, in
which case mirror the dictation transient posture (no lease, shred in `finally`).

---

## 11. Renderer component design

Under `renderer/screens/ImagesScreen.tsx` + a small `renderer/images/` folder (mirror `renderer/chat/`):

- **`ImagesScreen.tsx`** — top-level: `useT()`, fetches `imageGetStatus()` on mount (and re-checks on
  focus / after navigation back from AI Model), owns the screen state machine (`unavailable | empty |
  selected | analyzing | answered | error`) and the ephemeral per-image **thread** array.
- **`ImageDropZone.tsx`** — drag-drop + "choose an image" button. **Drag-drop rejects a multi-drop**
  (`dataTransfer.files.length > 1` → the `decodeFailed`-adjacent "Drop one image at a time." Banner,
  §5.6) rather than silently taking `files[0]`; for a single drop it reads bytes from that `File`
  **directly** (no `imageReadBytes` round-trip — IPC-1). The "choose an image" button goes through the
  picker: `imageChooseImage` → `imageReadBytes(path)`. **Both paths converge on the same byte-level
  pipeline** (the decode/downscale/EXIF algorithm below): drag-drop feeds it the `File`'s bytes, the
  picker feeds it the `imageReadBytes` result — neither path skips the decode, so `decodeFailed` and the
  EXIF/downscale normalization apply identically regardless of source. Validates type/size client-side
  first (friendly Banner before any IPC): the picker can reject early using the `sizeBytes` from
  `imageChooseImage` (cheap, before `readBytes`), and `imageReadBytes`/`analyze` re-validate the cap in
  **main** as the authoritative guard (SEC-3) — the two checks are deliberate (fast client reject +
  trusted main-side enforcement), not redundant. A `createImageBitmap` decode failure → `decodeFailed`
  Banner (§5.6).
- **`ImagePreview.tsx`** — renders the selected image via a **`data:` URL** (`canvas.toDataURL` from the
  decoded/downscaled bitmap, or a `FileReader.readAsDataURL` of the bytes). **Not `URL.createObjectURL`
  / `blob:`** — the prod CSP `img-src 'self' data:` (`main/index.ts:367-369`) does not list `blob:`, so
  a `blob:` preview would be CSP-blocked (SEC-1, §13). `data:` carries a ~33% base64 inflation, which
  the downscale-first step (below) keeps small. Shows filename/dims/size; Remove/Replace.
- **`QuestionComposer.tsx`** — auto-grow textarea, Enter=send, suggestion `Chip`s above it (§5.5).
- **`AnswerThread.tsx`** — the ephemeral turns with Copy / Try again, the ambient "Generated locally…"
  note, streaming/indeterminate state + Stop.
- **`VisionUnavailable.tsx`** — the `EmptyState` availability card (§5.1), reason-adaptive, CTA →
  `onNavigate('models')`.

**Image decode/downscale/EXIF (no native dep) — the explicit algorithm (UX-3).** Input is a `Blob`:
drag-drop passes the `File` (already a `Blob`); the picker wraps its `Uint8Array` as
`new Blob([bytes], { type: mimeType })`. From there the steps are identical:
1. Decode: `const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })`.
   **If this throws → `decodeFailed`** (corrupt / HEIC-as-jpg / animated-PNG the decoder rejects /
   zero-byte). `{ imageOrientation: 'from-image' }` requests EXIF-corrected orientation at decode.
2. Read `bitmap.width`/`height` for the meta line and the dimension cap (§14, hard-reject above ~4096 px).
3. Downscale + **EXIF normalization via re-encode:** compute `scale = min(1, 1536 / max(w,h))`; draw the
   (orientation-corrected) bitmap to an `OffscreenCanvas`/`<canvas>` at `w*scale × h*scale` and
   re-encode with **`convertToBlob`/`toBlob`** — **output format = the input MIME** (`image/png` stays
   PNG lossless; `image/jpeg` re-encodes at **quality 0.9**). Because the canvas draw bakes in the
   corrected orientation and strips metadata, the re-encoded bytes are **upright with no EXIF** — the
   model never sees a sideways image. This runs **whenever the longest side > 1536 px OR the source had
   EXIF orientation**; for a small, already-upright image it can pass the original bytes through.
4. **Best-effort fallback:** if `OffscreenCanvas`/`convertToBlob` is unavailable or fails (but decode
   succeeded), send the **original** bytes — the model's `clip` preprocessing resizes anyway; only the
   payload/EXIF optimization is lost, not correctness.

This keeps all heavy image work in the sandbox with zero dependency and bounds the IPC payload.

**i18n keys (add to `en.ts` + `de.ts`):** `nav.images`; `images.title`, `images.empty.body`,
`images.avail.noModel`, `images.avail.noRuntime`, `images.avail.incompatible`, `images.avail.cta`,
`images.avail.ocrPointer`; `images.drop.title`, `images.drop.choose`, `images.drop.types`;
`images.chip.summarize|extractText|explainChart|readForm|importantDetails|whatNotice` (label + the
prompt value); `images.composer.placeholder`; `images.answer.localNote`, `images.answer.copy`,
`images.answer.tryAgain`, `images.answer.clear`; `images.err.tooLarge|unsupported|decodeFailed|
multiDrop|runtimeFailed|emptyResponse|busy`. German informal „du", glossary-consistent (Bild/Bilder,
KI-Modell), text-expansion safe.

---

## 12. Data / storage / privacy posture

**MVP = nothing persisted.** No `documents`/`chunks`/`embeddings`/`conversations`/`messages` writes; no
new DB tables. The image, the question, the thread, and the answer live **only in renderer screen
state** and are gone on navigation away / image removal / app close.

**Image bytes path (preferred): never on disk.** Main base64-inlines the bytes into the loopback HTTP
request to the vision sidecar (Option A). The bytes exist transiently in main-process RAM for the
request and are dropped after. No temp file ⇒ no shred concern for the image.

**Temp-file fallback (only if V1 proves the server needs a path, or Option C/CLI is used):** write
`<uuid>.parse-vision.<ext>` under `workspace/documents/` (the `.parse` infix puts it under the existing
`shredStalePlaintext` startup crash-sweep), and **`shredFile` it in `finally`** — exactly the
**voice-dictation** posture (`security-model.md` "Voice dictation data path"). Cleaned on cancel,
failure, completion, app exit, and workspace lock.

**No auto-import.** Selecting an image on this screen does **not** add it to Documents and does not run
OCR. The two features are independent (§3).

**Logs/audit carry no content.** At most: a count, a jobId, the file **extension**, a **size class**,
and success/failure — **never** image bytes, the prompt, the answer, OCR text, or extracted fields.
Follow the hard audit rule (`services/audit.ts`: ids/model-ids/filenames/counts only) — but note even
the **prompt and answer are content**, so they never reach audit/log (the dictation precedent: "no
audit event; content-adjacent"). If any audit event is added at all (open decision — likely **none**,
matching dictation/search), it is `{ modelId, sizeClass, ext, ok }` only, proven by a sentinel-grep
test (`tests/integration/audit-ipc.test.ts` pattern).

**Saving/exporting answers is explicitly deferred** (not MVP). Whether answers ever become document
artifacts is an open decision (§19) — default: **never auto**, only a future explicit user export.

---

## 13. Security model impact

No weakening of any existing control; the feature is **additive within the established boundaries**:

- **Renderer stays sandboxed** (`contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`); it
  has **no Node, no network**. Image decode uses only browser APIs.
- **Images cross the typed preload bridge** as `Uint8Array` (`imageReadBytes`/`imageAnalyze`); the
  **main process owns all file I/O and the sidecar call.**
- **CSP is unchanged and not weakened — because the preview uses `data:`, not `blob:` (SEC-1).** The
  exact prod CSP is `img-src 'self' data:` (`main/index.ts:367-369`) and does **NOT** list `blob:`. A
  `URL.createObjectURL`/`blob:` preview would therefore be **CSP-blocked** — the earlier draft's claim
  that `blob:` was "already permitted" was **false** and is deleted. The decided path is **`data:`-only**
  (§11 `ImagePreview` renders a `data:` URL), which needs **no CSP change** at all; the cost is the ~33%
  base64 inflation, mitigated by downscaling first (§11). If a future revision ever wants `blob:`
  previews, that is a **deliberate, reviewed `img-src` CSP edit in BOTH dev and prod headers** (a §0
  red-line change), not a silent allowance — MVP does not take it. **No remote origin is added** to
  `connect-src`/`img-src`.
- **Sidecar binds `127.0.0.1` only** (`LlamaServer` default host + `findFreePort` loopback); the
  offline guard exempts loopback. No routable listener. No hosted-AI API, no telemetry.
- **No image/prompt/answer content in logs or audit** (§12); errors to the renderer are friendly codes,
  technical reasons to the local log only.
- **Graceful failure** when runtime/model/projector is missing or incompatible (§5.1/§10) — the app
  never crashes; status returns `available:false`.
- **Temp files** (fallback only) cleaned on cancel, failure, exit, and lock (§12).
- **Untrusted-input note:** the image is attacker-controllable (any file the user drops). It is handed
  to `clip`/`libmtmd` inside the sidecar; the existing malicious-document **byte cap** philosophy
  (`ingestion/limits.ts`) is mirrored as a vision byte/dimension cap (§14) so a crafted huge image
  can't OOM the main process or the sidecar. The `importDocuments`-accepts-caller-paths caveat
  (`known-limitations.md`) applies equally to `imageReadBytes(path)`: the renderer is sandboxed, and we
  re-validate the extension + cap in main. **The path-trust stance is the same accepted one; the
  extension+cap re-validation itself is NEW code, not an inherited guard (SEC-3)** — `importDocuments`
  does no such main-side re-check today, so `imageReadBytes`/`analyze` must actually implement it.
- **Engine-binary trust** is unchanged (the on-drive sidecar is trusted by provisioning, the accepted
  §22-M2 residual); vision adds no new binary on the recommended path.

---

## 14. Performance expectations and limits

- **Caps (env-overridable, `services/vision/limits.ts`, mirroring `ingestion/limits.ts`):** max image
  **bytes** (e.g. `HILBERTRAUM_MAX_IMAGE_BYTES`, default ~20 MiB) and max **dimension** (longest side,
  e.g. 4096 px hard reject; client downscales above ~1536 px). Rejections surface the friendly
  `images.err.tooLarge` copy.
- **Cold start:** first analyze pays the vision-model load (seconds — large GGUF off USB; show "Starting
  the vision model…"). Subsequent analyses on the warm sidecar skip it (idle teardown re-pays it later).
- **One job at a time** — a second analyze returns `busy`. Note this is vision's **own** serialization
  (a new latch in `services/vision/`), **not** the chat slot's arbiter, which doesn't govern a separate
  sidecar (RUNTIME-3).
- **CPU-only target:** MVP runs CPU-pinned (§7); time-to-first-answer on a 3B-class VLM on a CPU laptop
  is the key risk the V1 benchmark measures. GPU is the optimization lever if CPU TTFA is too slow.
- **RAM — peak is co-resident, and the idle-teardown bounds the window, NOT the peak (PROD-1/RUNTIME-3).**
  During active use you can have **chat + E5 embedder + vision** all resident — three `llama-server`
  processes. With the bundled chat winner Gemma 4 12B (~7 GB weights, a **14 GB** RAM tier,
  `model-policy.md:27`) loaded, plus a ~3B vision sidecar (~3.2 GB) plus the embedder, a **12 GB machine
  will likely OOM and even 16 GB is tight**. The manifest `recommended_min_ram_gb`/RAM-best-fit +
  `insufficientRam` gate keeps a vision model off machines that can't hold it (the existing AI Model
  gate). **Acceptance bar (§15), honestly qualified:** vision is realistically co-resident **only with a
  small chat model, or only after the chat sidecar idles out**; usefulness on the **12–16 GB tier**
  assumes one of those, not "12B chat + vision simultaneously." **Not** shown as broadly available on
  8 GB unless the benchmark proves it. State this limit in `known-limitations.md` (§18).

---

## 15. Evaluation / benchmark plan (V1 gate + V5 hardening)

A local, deterministic-ish eval before shipping. Fixtures: a small committed set of **synthetic,
content-free** images (no PII) under `apps/desktop/tests/fixtures/vision/` — a screenshot with a visible
error dialog, a simple bar/line chart with labeled axes, a mock receipt/form, a photographed-page
mock, a node-and-arrow diagram, and an intentionally ambiguous/blurry image.

**Capability checks (manual harness `HILBERTRAUM_VISION_SMOKE`, the §"manual harness matrix"
precedent):**
- **Screenshots:** identifies the visible error message / UI state.
- **Charts:** explains trend direction + reads labels **without inventing numeric values**.
- **Receipts/forms:** extracts vendor/date/total/key fields, **admitting uncertainty** for unreadable
  ones (no confident fabrication).
- **Document photos:** summarizes layout + visible content beyond raw OCR.
- **Diagrams:** explains relationships.
- **Ambiguous/unanswerable:** **declines to invent** details.

**Measurements (record in `model-benchmarks.md`):** peak RAM (RSS), cold model start, time-to-first
-answer, total analysis time, CPU-only behavior on the reference laptop, GPU/Vulkan/Metal where
available, failure modes.

**Acceptance bar:** useful on ≥12–16 GB **with a small chat model loaded, or after the chat sidecar
idles out** (not 12B-chat + vision co-resident — that needs more, PROD-1/§14); not advertised as
broadly available on 8 GB without proof; **beats OCR-only + text model** on chart/screenshot/diagram
tasks; **does not hallucinate confidently** on ambiguous images. **Candidate families to evaluate (none hardcoded final until verified):**
Qwen2.5-VL 3B/7B (likely first), Gemma 3 4B/12B vision variants (if license + GGUF + mmproj fit),
InternVL small (if llama.cpp/GGUF mature), a future Qwen3-VL (only if pinned-runtime GGUF support is
mature). Selection is gated on: GGUF + mmproj availability on the **pinned/bumped** runtime, license
(Apache/MIT preferred — the all-permissive posture; record `license_review`), RAM fit, and the
capability bar above.

---

## 16. Implementation phases with ordered tasks

### Phase V0 — repository discovery & final design record (DONE by this plan; re-confirm before V2)
- Inspect nav/routing/components, model/runtime/manifest logic, IPC/preload conventions, OCR/transcriber
  patterns (all captured above with file paths). Confirm docs live here (`docs/image-understanding-plan.md`).
  Output: this plan.

### Phase V1 — model/runtime research gate (no user-facing feature). **Everything downstream (V2–V5) is BLOCKED until V1 returns.**

> **✅ V1 RESOLVED 2026-06-20 (full findings + SHAs in `BUILD_STATE.md`).** Ran on the real pinned **b9585** (PAID smoke
> drive). **§7 gate #1, branch #1 — Option A, base64 `image_url`, NO disk write, NO pin bump.** `llama-server --mmproj`
> loads multimodal + answers `/v1/chat/completions` cleanly. **Args (RUNTIME-2):** `--mmproj <file>`; `--jinja` is
> default-ENABLED on b9585; **do NOT pass `--reasoning-format deepseek`** (non-reasoning VLM); CPU-pin `--device none`;
> set `cache_prompt:true` (image prefill cached across follow-ups). **SSE reuse CONFIRMED** — frames byte-identical to
> text chat, `readChatSSE` parses unchanged ⇒ streaming-by-default stands (poll-fallback NOT needed); verbatim sample at
> `apps/desktop/tests/fixtures/vision/vision-sse-sample.txt`. **Chosen model:** Qwen2.5-VL-3B-Instruct (ggml-org,
> Apache-2.0) Q4_K_M + mmproj-f16 (~3.27 GB on disk, **peak RSS ~4.6 GB** CPU/ctx4096; correctly read a real German
> invoice). **Latency caveat:** a full-res image = ~2800 image tokens ⇒ **~52 s CPU prefill** off USB — the §11 downscale
> is a real latency lever and GPU is the §19.11 lever. V2 may now proceed.
1. **FIRST TASK (TEST-1): locate a license-clean GGUF + mmproj that actually LOADS on the pinned b9585.**
   The whole plan assumes such an artifact exists and loads on the *pinned* runtime — that is
   **unverified**, and `model-policy.md:29` already records newer-arch vision models that "may not load
   until the runtime pin is bumped" (the Qwen3.5 entry runs "text-only"). So on the **PAID smoke drive**
   (`F:\paid-gpu-smoke-drive`, real b9585), the literal first step is: find a permissively-licensed VLM
   GGUF + matching mmproj and confirm `llama-server` (or the mtmd CLI) **loads it without erroring on the
   pin**. **If none loads → V1 fails immediately into the Option-C + runtime-pin-bump branch (§7 gate
   #4)** — do not proceed as if Option A is available.
2. With a loading artifact in hand, prove `llama-server --mmproj` starts and answers a
   `/v1/chat/completions` request, and **resolve the exact arg set** (RUNTIME-2): `--jinja` yes/no,
   `--mmproj` flag spelling, whether `--reasoning-format` must be dropped; **and** base64 `image_url` vs
   file-path requirement; **and** whether `readChatSSE` parses the streamed frames as-is or needs a
   vision-specific reader (§7 gate #3). If the server has no multimodal at all → Option C + pin-bump.
3. Pick the first candidate (likely **Qwen2.5-VL 3B Q4** *if it loads on the pin*); record license, exact
   files (GGUF + mmproj), sizes, real SHAs, min-RAM (from measured peak RSS **co-resident with chat +
   embedder**, PROD-1), the resolved runtime args, known limitations.
4. Capture a verbatim real SSE sample → `tests/fixtures/` for a CI parser regression (the audit-L19
   fixture policy). **No app feature yet.**

### Phase V2 — backend skeleton

> **✅ V2 SHIPPED 2026-06-20 (branch `image-understanding`).** The wired, tested backend skeleton is in:
> `shared/manifest.ts` (`vision` role + `mmproj`/`input_modalities` validation, shared `validateDownloadSubBlock`),
> `shared/types.ts` (`VisionStatus`/`ImageAnalyzeRequest`/`ImageJob`/`ImageJobState`/`VisionErrorCode`),
> `shared/ipc.ts` (`images:*` channels + `STREAM.imgToken/imgDone/imgError`), `preload/index.ts` (typed
> methods + the three `onImage*` subscribers), `services/models.ts` (two-file install state: `mmprojPath` +
> `manifestFiles`, both-present-and-verified, lazy/cache extended to the projector), `services/drive.ts` +
> both `prepare-drive` scripts (`models/vision`, `model-manifests/vision`), `services/vision/`
> (`status.ts` real workspace-agnostic detection, `limits.ts` byte/extension cap, `runtime.ts` `VisionRuntime`
> on the real `LlamaServer` seam with the V1-resolved args, `index.ts` `VisionService` orchestration —
> own one-job serialization + busy-reject + cancel + ephemeral job map), and `ipc/registerImagesIpc.ts`
> (registered in `main/index.ts`). **Green-gate holds:** zero vision models ⇒ `available:false` and the full
> suite passes. Tests: `tests/unit/manifest.test.ts` (+vision/mmproj), `tests/integration/models.test.ts`
> (+two-file install state), `tests/integration/vision-status.test.ts`, `tests/integration/images-ipc.test.ts`,
> `tests/unit/preload-vision.test.ts`, `tests/integration/drive.test.ts` (+vision dirs). **V3 (renderer UI)
> not started.** The numbered list below is the as-built checklist.
1. Manifest: add `vision` role + `mmproj` validation to `shared/manifest.ts` (+ unit tests).
2. `models.ts`: vision state (both files verified); `models/vision/` + `model-manifests/vision/` in
   `drive.ts`/`prepare-drive`.
3. `shared/types.ts`: `VisionStatus`, `ImageAnalyzeRequest`, `ImageJob`, `VisionErrorCode`.
4. `shared/ipc.ts` + `preload/index.ts`: the `images:*` channels + typed api (+ STREAM if streaming).
5. `services/vision/status.ts` + a `VisionRuntime` **stub** behind the real `LlamaServer` seam (tests
   inject `spawn`/`fetchImpl`/`findPort` — the existing sidecar test seams; do **not** invent fake
   production answers — a missing model returns `available:false`).
6. `ipc/registerImagesIpc.ts` + register in `main/index.ts`. Missing assets ⇒ friendly unavailable.

### Phase V3 — Images screen UI (wired to status + a guarded/dev backend)

> **✅ V3 SHIPPED 2026-06-20 (branch `image-understanding`; full record in `BUILD_STATE.md`).** The wired, tested
> Images screen is in: nav/routing/glyph (`renderer/navigation.ts`, `renderer/App.tsx`, `renderer/components/Icon.tsx`),
> i18n (`nav.images` + the `images.*` block in `shared/i18n/en.ts`+`de.ts`), `renderer/screens/ImagesScreen.tsx`
> (the §5.6 state machine + ephemeral thread + Chat-style stream subscribe/unsubscribe + busy-reject + cancel +
> focus re-check), and `renderer/images/` (`ImageDropZone`, `ImagePreview`, `QuestionComposer`, `AnswerThread`,
> `VisionUnavailable`, `decode.ts` = the §11 decode/downscale/EXIF algorithm with no native dep + a `decodeImpl`
> test seam). **IA made honest:** Images is the 6th primary — `design-guidelines.md` §2 now reads "6 primary +
> 1 utility". **Green-gate holds** (zero vision models ⇒ the calm `VisionUnavailable` card; app launches; suite
> green). `npm test` 1950/29 (173 files), typecheck + build clean. New test `tests/renderer/ImagesScreen.test.tsx`
> (+ IA/rail-labels updates). **V4 (real runtime hardening) not started.** The numbered list below is the as-built checklist.
1. Nav item + route + Icon glyph + i18n keys.
2. `ImagesScreen` with all states (§5.6): unavailable/empty/selected/running/answer/error.
3. Drop zone + file picker (`chooseImage`/`readBytes`), preview, composer, chips, thread.
4. Client decode/downscale (no dep). Wire to the V2 backend (real when a model is present, friendly
   unavailable otherwise).

### Phase V4 — real local vision runtime (uses the V1-resolved arg set + request shape, not assumptions)

> **✅ V4 SHIPPED 2026-06-20 (branch `image-understanding`; full record in `BUILD_STATE.md`).** The hardened,
> tested local vision runtime is in `services/vision/runtime.ts` (real `ensureStarted` single-flight + the
> V1-resolved `--mmproj`/`--device none` args, `analyze` base64 `image_url` + `cache_prompt:true` + `readChatSSE`,
> `startFailed` latch, no-orphan `stop()`, **plus the NET-NEW idle-teardown interlock RUNTIME-4**), `services/vision/
> index.ts` (`VisionService.stop()` now aborts the in-flight job + tears the runtime down — the lock/quit mechanism),
> and the lifecycle wiring (`context.ts` `ctx.vision`, `main/index.ts` builds it + tears it down on `will-quit`,
> `registerWorkspaceIpc` stops it on workspace LOCK beside the embedder `suspend()`). **RUNTIME-4 as built:** a SOFT
> idle teardown (kills the child but does NOT latch `stopped`, so the next analyze cold-starts) on a `~3 min` default
> (`HILBERTRAUM_VISION_IDLE_MS`, §19.13); the idle timer is cancelled on every `ensureStarted()`/`analyze()` entry and
> rearmed only when the LAST in-flight analyze settles (`inFlight===0`); teardown is guarded against a `starting`/
> in-flight job; an analyze arriving mid-teardown sees `server===null` and cold-starts a fresh, independent child. The
> §12 temp-file fallback was NOT built (V1 = base64 no-disk). **Green-gate holds** (zero vision models ⇒ `available:false`,
> app launches, suite green). `npm test` 1965 passed / 29 skipped (176 files); typecheck + build clean. New tests:
> `tests/integration/vision-runtime.test.ts` (single-flight, startFailed latch, cancel-aborts-fetch, no-orphan, the
> RUNTIME-4 idle races), `tests/unit/vision-sse.test.ts` (SSE regression on the V1 fixture incl. partial-UTF-8),
> `tests/integration/vision-security.test.ts` (loopback-only + no content in log/audit sentinel), + lock-teardown and
> `service.stop()` cases in `workspace-ipc`/`images-ipc`. **V5 (eval/benchmark/docs/plan-fold) not started.** The numbered
> list below is the as-built checklist.
1. `VisionRuntime` real `ensureStarted` (`--mmproj` + the **V1-resolved** `visionServerArgs`, loopback)
   + `analyze` (the V1-resolved request shape; `readChatSSE` **only if** V1 confirmed it parses),
   single-flight, lock/quit/cancel teardown, **plus the net-new idle-timer interlock (RUNTIME-4):**
   cancel the idle timer on `ensureStarted`/`analyze`; guard teardown against a `starting`/in-flight
   job. This is new code, not a copy of `e5.ts` (which has no idle timer).
2. Cancellation (AbortController) + timeouts; **vision's OWN one-job-at-a-time latch** (a separate
   sidecar is not covered by the chat slot arbiter — RUNTIME-3); **busy-reject** (not queue, IPC-3).
3. Byte/dimension caps (`vision/limits.ts`). Temp-file fallback **only if** V1 required a path
   (`.parse-vision` + shred-in-finally).
4. Workspace-lock teardown wiring (`registerWorkspaceIpc`).

### Phase V5 — evaluation, hardening, docs
1. Benchmark fixtures + the `HILBERTRAUM_VISION_SMOKE` manual harness (§15); record numbers in
   `model-benchmarks.md`.
2. Full test suite (§17). Sentinel test: no content in logs/audit; no remote network introduced.
3. Docs: fold this plan into `architecture.md` (a new §) + `model-policy.md` (vision role + mmproj +
   the chosen model's license review), update `drive-layout.md` (`models/vision/`, `model-manifests/
   vision/`), `packaging.md` (the two-file download), `known-limitations.md` (CPU latency, RAM
   co-residency, single-image only, no persistence, OCR-vs-vision separation), the user guide +
   troubleshooting. Add commercial-drive verification gates **only if** a vision model is shipped on a
   sold drive (then `assertCommercialDrive` verifies GGUF + mmproj). Delete this plan file.

---

## 17. Test plan

Run vitest from `apps/desktop` (the repo memory rule). All must pass **with zero vision models
installed** (the green-gate posture). Cover:

- **Unit — status detection** (`services/vision/status.ts`): no-runtime / no-model / incompatible /
  available, including "GGUF present but mmproj missing ⇒ not available".
- **Unit — supported/unsupported file handling**: png/jpg/jpeg accepted; others rejected with the
  `unsupportedType` code (both client guard + the `imageReadBytes`/`analyze` main guard).
- **Unit — size limits**: over-byte / over-dimension ⇒ `tooLarge`.
- **Unit — manifest validation** (`shared/manifest.ts`): `vision` role requires `mmproj`; real
  `mmproj.download.sha256` must equal `mmproj.sha256`; unknown keys ignored; non-vision unaffected.
- **IPC contract tests**: `images:*` handlers return the right DTOs; unknown jobId ⇒ terminal failed;
  one-job-at-a-time returns `busy`.
- **Preload exposure test**: `window.api.imageAnalyze` etc. exist and are typed (the `PreloadApi`
  surface test pattern).
- **Renderer state tests**: unavailable / empty / selected / running / error / answer; chip fills the
  composer; Remove resets the thread; new-image-mid-analysis cancels.
- **Security sentinel**: push a secret prompt + a recognizable byte pattern through a (mocked) analyze
  and assert absence from audit rows + `app.log` (the `audit-ipc.test.ts` pattern); a no-remote-network
  sentinel asserting the offline-guard records no remote connect from the vision path.
- **SSE parser regression**: the V1 verbatim fixture parsed by a pure CI unit test.
- **Runtime smoke (env-gated)**: `HILBERTRAUM_VISION_SMOKE` against the real binary + model (skipped in
  CI; part of the manual pre-ship gate).
- **Packaged-app smoke checklist** (if assets ship): analyze a PNG + a JPEG from the produced `.exe`.
- **Regression — OCR unchanged**: existing `ocr-smoke` + ImageParser tests stay green; assert the
  Images path does not call the OCR engine and does not write `documents`/`ocr_json`.

---

## 18. Documentation updates

- `architecture.md` — new "Image understanding — design record" §; update the Overview screen list
  (add Images) and the module map (add `services/vision/`).
- `model-policy.md` — the `vision` role, the `mmproj` field, the chosen model's `license_review`, RAM
  tiering, and the runtime-pin note if bumped.
- `drive-layout.md` — `models/vision/` + `model-manifests/vision/` (+ `DRIVE_LAYOUT_DIRS`).
- `packaging.md` — vision is opt-in download (two files: GGUF + mmproj); commercial gate only if shipped.
- `known-limitations.md` — CPU latency; **RAM co-residency peak (chat + embedder + vision = three
  sidecars; idle teardown bounds the window, not the active-use peak; a 12B chat model + vision needs
  >16 GB — PROD-1)**; single image / no compare / no persistence; OCR-vs-vision separation; the
  caller-supplied-path caveat reuse.
- `BUILD_STATE.md` — per-phase status, decisions, data contracts (the `images:*` IPC + `ImageJob`),
  next actions, risks. **(Mandatory per the per-phase ritual.)**
- User guide + troubleshooting — "Ask about an image"; what it is / isn't (not OCR, not generation);
  "needs a vision model"; honest limits.

---

## 19. Open decisions / research gates

1. **Server multimodal on the pinned b9585? (V1 gate — BLOCKS V2–V5.)** Four branches (§7): works with
   base64 `image_url` (Option A, no disk) / needs a file path (Option A + temp) / works but the
   chat-template/arg path differs (Option A, V1 pins the exact arg set + request shape + SSE reader) /
   no server multimodal at all (Option C CLI + **runtime-pin bump** — a major gate). V1 must also
   resolve the **arg set** (`--jinja` yes/no, `--reasoning-format` drop?) since the vision sidecar does
   **not** inherit `CHAT_SERVER_ARGS`. *Recommendation: Option A; bump only if forced.*
2. **Screen label** "Images" (default) vs "Image Understanding".
3. **Answer persistence** — ephemeral only (default MVP) vs saved; whether answers ever become document
   artifacts later (default: never auto).
4. **First model family** — Qwen2.5-VL 3B (default first) pending the V1 benchmark.
5. **Vision = separate `role:vision`** (default) vs a multimodal *chat* role reusing `RuntimeManager`.
   *Recommendation: separate role + dedicated lazy sidecar.*
6. **WEBP in MVP** — default **out** (no dep, not yet proven safe in the import stack).
7. **Max image dimensions/bytes** — propose ~20 MiB / 4096 px hard, ~1536 px client downscale; finalize
   after V1.
8. **Reuse the chat runtime instance vs a separate vision sidecar** — separate (Option A).
9. **Vision install UI in AI Model in v1** — default: lists under its role with a human "Vision" label,
   no special group; revisit if confusing.
10. **Streaming the answer** — *load-bearing for the IPC surface, not a cosmetic default.*
    **DECISION: stream by default, confirmed in V1.** Build the per-job SSE channels
    (`STREAM.imgToken/imgDone/imgError`) so V2's `images:*` contract includes them. Rationale: the
    feature is a CPU-bound VLM whose headline risk is *slowness* (§14/PROD-1), and token-by-token
    feedback matters most exactly when answers are slow; the stream already exists (the sidecar emits
    SSE, reuse `readChatSSE`), so this forwards tokens rather than generating them, and it mirrors Chat.
    **Cost:** three STREAM channels + subscribe/unsubscribe plumbing in preload and renderer (already
    drafted in §9.1). **Contingency (RUNTIME-2):** streaming presumes `readChatSSE` parses the vision
    sidecar's frames with the V1-resolved arg set. If V1 shows the frame shape differs enough that a
    vision-specific reader is non-trivial, **fall back to single-resolve + `getJob` poll for MVP** (a
    worse UX — an indeterminate state for the whole analysis — but a smaller surface) and add streaming
    later. So: plan to stream; finalize once V1 proves the SSE parses, before V2 fixes the contract.
11. **GPU vs CPU for vision** — *load-bearing for the acceptance bar, not a free default.* **Recommended:
    CPU-pinned (`--device none`)** for MVP (the embedder/reranker precedent) to avoid VRAM contention +
    GPU-crash complexity. **Cost:** TTFA on a 3B VLM on a CPU laptop may be too slow — that is exactly
    what the V1 benchmark measures; if it fails the bar, GPU (reuse the §"GPU ladder" rung) becomes the
    lever, at the cost of VRAM contention with chat and driver-flakiness exposure.
12. **Any audit event at all** — default **none** (dictation/search precedent: content-adjacent).
13. **Idle-teardown timeout** value for the vision sidecar (2–5 min) — tune with the benchmark.
14. **Preview encoding — `data:` vs `blob:` (a SECURITY *and* memory decision, SEC-1/IPC-1; DECIDED:
    `data:`).** The prod CSP `img-src 'self' data:` does not list `blob:`, so `data:` is the path that
    needs **no CSP change**; its cost is ~33% base64 inflation, mitigated by downscaling first.
    `blob:` would need a **deliberate, reviewed CSP edit in dev+prod** (a §0 red line) — rejected for
    MVP. (§11, §13.)
15. **Busy vs queue for a second analyze (IPC-3; DECIDED: busy-reject).** A second `analyze` returns
    `busy` immediately and is **not** queued. **Cost:** the user must re-submit after the current
    analysis finishes. **Alternative** (single-depth queue) was rejected: it complicates `ImageJobState`
    semantics and the §5.6 copy for marginal benefit. (§9.4, §5.6.)
16. **Download topology — two jobs sharing one modelId vs one job, two files (DIST-1; DECIDED: two
    jobs).** Two already-atomic single-file `DownloadJob`s share one `modelId` (install = both done).
    **Cost:** the AI Model UI must present two sub-downloads (or a combined progress) under one row.
    **Alternative** (one job, two files) was rejected: it needs net-new cross-file progress aggregation,
    two-phase verify, and partial-failure recovery that `downloads.ts` lacks. (§8.3.)

---

## 20. Acceptance criteria

- A new **"Images"** nav item appears (after Documents, before AI Model) and routes to the screen.
- With **no vision model installed**, the screen explains what's missing in calm, non-technical copy,
  routes to AI Model, points to OCR-under-Documents, and **the app still launches and all tests pass**.
- With a **compatible local vision model + projector + runtime**, the user can drop/choose a **PNG or
  JPEG**, ask a question, and receive a **locally-generated** answer (no cloud/network).
- **No** cloud/network dependency, hosted-AI API, or telemetry is introduced.
- **No** image/prompt/answer/OCR/field content appears in logs or audit.
- Missing/incompatible runtime/model/projector **does not crash** the app (graceful `available:false`).
- The **renderer stays sandboxed** and uses only typed preload APIs; the sidecar binds **127.0.0.1**.
- The feature is **clearly separate** from OCR and Documents (no auto-OCR, no auto-import, no corpus
  writes).
- The CSP is **not weakened**; no new native npm dependency is added (or, if proposed, it passed the
  §19 decision gate explicitly).
- Docs (architecture, model-policy, drive-layout, packaging, known-limitations, BUILD_STATE, user guide)
  explain the feature and its limits honestly.
- **Tests pass with zero vision models installed.**
```