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

1. **Runtime:** a **dedicated, lazily-started `llama-server` instance** spawned with the chat model's
   GGUF binary plus a **multimodal projector (`--mmproj`)**, modeled on the `E5Embedder` /
   `LlamaReranker` lazy-sidecar pattern (own `LlamaServer`, loopback-only, lazy `ensureStarted`,
   idle/lock/quit teardown) — **NOT** the active chat `RuntimeManager` (keep Chat undisturbed; the
   chat model and the vision model differ). Talks to `/v1/chat/completions` with an OpenAI-style
   `content: [{type:'text'}, {type:'image_url'}]` message.
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
`URL.createObjectURL`) — no `sharp`/`jimp`/`canvas`. The vision model's own `clip`/`libmtmd`
preprocessing resizes to the projector's expected resolution regardless, so client downscaling is a
payload/memory optimization, not a correctness requirement (§7, §12).

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
| Model busy (one-at-a-time) | analyze returns busy / queued | "Working on the previous question…" + the active job's Stop |
| Image selected, no question | local state | submit disabled; chips available |
| Image too large | client guard + main guard | Banner "This image is too large to analyze. Try a smaller image." |
| Unsupported type | client guard + main guard | Banner "That file type isn't supported. Choose a PNG or JPEG." |
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

IA note: this is a 6th everyday destination (Home · Chat · Documents · **Images** · AI Model · Skills).
The design-guidelines §2 "5 primary" count is a guideline, not a hard cap (Skills was already added as
a 5th); Images is a genuine first-class task surface, justified the same way. Confirm the rail still
fits the 100px column with the new label (the §12.1 rail-label discipline: non-breaking, 12px floor —
„Bilder" is short, fine).

**Open decision (§19):** final label **"Images"** vs "Image Understanding". Plan defaults to **"Images"**
(matches the one-word rail labels; the screen title carries the fuller "Understand an image").

---

## 7. Runtime/model architecture options

The app already runs `llama-server` four ways (chat via `RuntimeManager`/`LlamaRuntime`; embedder,
reranker as standalone lazy sidecars) and a per-file CLI (whisper). Vision fits these precedents.

**Option A — dedicated lazy vision sidecar (RECOMMENDED).** A new `services/vision/` service owns its
own `LlamaServer` (from `services/runtime/sidecar.ts`), started with the vision GGUF + `--mmproj
<projector>`, modeled on `E5Embedder`/`LlamaReranker`:
- `ensureStarted()` lazy single-flight (share one start promise across concurrent callers), `startFailed`
  latch, `stopped` guard — copy `embeddings/e5.ts` lines ~118–173.
- `LlamaServerOptions`: `binPath` (resolveLlamaServerPath), `modelPath`, `contextTokens`,
  `extraArgs: ['--mmproj', projectorPath, ...visionServerArgs]`, `host` defaults `127.0.0.1`,
  `findPort` ephemeral loopback, `waitForHealthy` (180 s budget). **Loopback only.**
- Request: `server.fetch('/v1/chat/completions', { method:'POST', body: JSON.stringify({ model,
  messages:[{role:'user', content:[{type:'text',text:question},{type:'image_url',image_url:{url:
  'data:image/png;base64,...'}}]}], stream:true }) , signal })` then reuse `readChatSSE`
  (`runtime/llama.ts`) — the SSE shape is identical to text chat.
- **Teardown:** stop the sidecar on workspace **lock** (beside the embedder `suspend()` in
  `registerWorkspaceIpc`), on **quit** (`will-quit`), on **cancel**, and after an **idle timeout**
  (e.g. 2–5 min, so two large models aren't co-resident longer than needed). RAM: chat + vision can be
  co-resident during use; the idle teardown bounds it. (Vision is on-demand, so this is acceptable for
  MVP; document it.)
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

**Decision gate (V1):** prove **Option A** (`llama-server --mmproj` + base64 `image_url`) works on the
pinned **b9585** binary. If yes → Option A, no disk write. If the server accepts `--mmproj` but needs a
file path not base64 → Option A with the temp-file fallback. If the server has no multimodal at all →
Option C + a runtime-pin bump proposal (flag as a major gate).

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
both placeholder-in-dev). Extend the precedence (`unsupported → missing → checksum_failed → installed`)
to hash the projector too. The lazy-verify path (RT-3) and the two-tier checksum cache extend naturally
(the projector is just a second file keyed by `(path,size,mtime)`). The `vision` role appears on the AI
Model screen list like any model; an **open decision (§19)** is whether to surface a separate "Vision"
group/filter there in v1 — default: it lists under its role with a human "Vision" label, no special UI.

### 8.3 Download (`services/downloads.ts`, `scripts/fetch-models.*`)

The in-app downloader and `fetch-models` must fetch **two** files for a vision manifest (GGUF +
projector), each `.part`-staged + verify-before-rename. Smallest change: when a manifest has an
`mmproj` block, enqueue both files in one job (the LM then the projector), reporting combined bytes.
Reuse the triple gate (policy ∧ setting ∧ per-download confirmation) untouched. `fetch-models`/`prepare
-drive --with-assets` should **NOT** fetch vision by default (it's opt-in like the larger chat models);
`--only <vision-id>` or `--all-models` pulls it. `bundled_on_preconfigured_drive` decides commercial
inclusion (today unimplemented — curate with `--only`).

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

Streaming (optional, RECOMMENDED for a live answer — reuse the SSE the sidecar already emits): per-job
channels keyed like chat, added to `STREAM`:

```ts
imgToken: (jobId) => `images:token:${jobId}`,
imgDone:  (jobId) => `images:done:${jobId}`,
imgError: (jobId) => `images:error:${jobId}`,
```

(If a streaming UI is judged too much for MVP, `images:analyze` can resolve once with the full answer
and `getJob` polls state; the streaming channels are the preferred UX but droppable — open decision.)

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

### 9.3 Types (`shared/types.ts`)

```ts
export type VisionUnavailableReason = 'no-model' | 'no-runtime' | 'incompatible'
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

`VisionErrorCode` is a small enum (`tooLarge | unsupportedType | runtimeFailed | emptyResponse |
cancelled | busy`) the renderer maps to friendly localized copy — the technical reason stays in the
local log only (the chat `friendlyIpcError` precedent).

### 9.4 Job pattern

`images:analyze` validates (extension, byte cap, question non-empty), creates a `jobId` (randomUUID),
returns immediately with `state:'queued'`, runs the sidecar call in the background, and **serializes to
one job at a time** (the documented one-local-model invariant — a second analyze while one runs returns
`busy`, or queues). `images:cancel(jobId)` aborts via `AbortController` (passed as `signal` to
`server.fetch`); `images:getJob` polls. Unknown jobIds return a terminal `failed` (the DownloadManager
`get` precedent). The per-process `jobs` map is ephemeral (the accepted `registerDocsIpc` precedent).

---

## 10. Main-process service design

New module **`services/vision/`**:

- **`status.ts`** — `getVisionStatus(ctx): VisionStatus`. Checks, in order: is a `llama-server` binary
  resolvable (`resolveLlamaServerPath`)? → if not, `no-runtime`. Is there a `role:vision` manifest whose
  GGUF **and** mmproj are present + verified (`buildModelList`/`services/models.ts`)? → if not,
  `no-model`. Is the manifest `unsupported` under the current validator (e.g. needs a newer runtime
  feature)? → `incompatible`. Else `available` + `modelId`/`modelDisplayName`. **Pure-ish + cheap** (no
  hashing on the hot path — reuse the lazy-verify cache). Returns `available:false` cleanly when the
  workspace is locked (status is a read; the screen also gates on `workspaceReady`).
- **`runtime.ts`** — `VisionRuntime` wrapping a `LlamaServer` (Option A, §7): lazy `ensureStarted`,
  `analyze({imageBytes, mimeType, question, signal, onToken?})` building the `image_url` data-URL
  request + `readChatSSE`, `stop()`/`suspend()` for lock/quit/idle. Single-flight start; idle-timeout
  teardown. **Localhost only.** Captures stderr tail for diagnostics (never surfaced to the user).
- **`index.ts`** — barrel + the `ImageJob` orchestration the IPC layer calls.

**IPC registration** (`ipc/registerImagesIpc.ts`, registered in `main/index.ts` beside the others):
`images:getStatus|chooseImage|readBytes|analyze|cancel|getJob`. `chooseImage` opens
`dialog.showOpenDialog` filtered to `png/jpg/jpeg` (the `pickDocuments` precedent) and returns
**path + name + sizeBytes only** (not bytes). `readBytes(path)` re-validates extension + size cap, then
`readFile`s and returns a `Uint8Array` (main owns file I/O). `analyze` is the job entrypoint (§9.4).
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
- **`ImageDropZone.tsx`** — drag-drop (`onDrop` reads `dataTransfer.files[0]`) + "choose an image"
  button (`imageChooseImage` → `imageReadBytes`). Validates type/size client-side first (friendly
  Banner before any IPC).
- **`ImagePreview.tsx`** — renders the selected image via `URL.createObjectURL(blob)`; shows
  filename/dims/size; Remove/Replace.
- **`QuestionComposer.tsx`** — auto-grow textarea, Enter=send, suggestion `Chip`s above it (§5.5).
- **`AnswerThread.tsx`** — the ephemeral turns with Copy / Try again, the ambient "Generated locally…"
  note, streaming/indeterminate state + Stop.
- **`VisionUnavailable.tsx`** — the `EmptyState` availability card (§5.1), reason-adaptive, CTA →
  `onNavigate('models')`.

**Image decode/downscale (no native dep):** in the renderer, `createImageBitmap(blob)` → read
`width`/`height` for the meta line; if the longest side exceeds a cap (e.g. 1536 px) draw to an
`OffscreenCanvas`/`<canvas>` and `convertToBlob`/`toBlob` to re-encode smaller, then pass those bytes
to `imageAnalyze`. If `OffscreenCanvas`/`convertToBlob` is unavailable or fails, **degrade to sending
the original bytes** (the model's `clip` preprocessing resizes anyway) — so downscaling is best-effort.
This keeps all heavy image work in the sandbox with zero dependency and bounds the IPC payload.

**i18n keys (add to `en.ts` + `de.ts`):** `nav.images`; `images.title`, `images.empty.body`,
`images.avail.noModel`, `images.avail.noRuntime`, `images.avail.incompatible`, `images.avail.cta`,
`images.avail.ocrPointer`; `images.drop.title`, `images.drop.choose`, `images.drop.types`;
`images.chip.summarize|extractText|explainChart|readForm|importantDetails|whatNotice` (label + the
prompt value); `images.composer.placeholder`; `images.answer.localNote`, `images.answer.copy`,
`images.answer.tryAgain`, `images.answer.clear`; `images.err.tooLarge|unsupported|runtimeFailed|
emptyResponse|busy`. German informal „du", glossary-consistent (Bild/Bilder, KI-Modell), text-expansion
safe.

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
- **CSP is unchanged and not weakened.** The renderer renders previews from `blob:`/`data:` URLs, both
  already permitted by the prod CSP (`img-src 'self' data:`; `blob:` is same-origin object URLs). **No
  remote origin is added** to `connect-src`/`img-src`. (If a preview ever needs `blob:` explicitly,
  that's a same-origin allowance, not a remote one — verify against the current header in
  `main/index.ts` and prefer `data:` to avoid touching CSP at all.)
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
  re-validate the extension + cap in main; deferred hardening is the same accepted stance.
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
- **One job at a time** (the documented single-local-model invariant) — a second analyze returns `busy`.
- **CPU-only target:** MVP runs CPU-pinned (§7); time-to-first-answer on a 3B-class VLM on a CPU laptop
  is the key risk the V1 benchmark measures. GPU is the optimization lever if CPU TTFA is too slow.
- **RAM:** chat + vision can be co-resident during use; the idle-teardown bounds the window. The
  manifest `recommended_min_ram_gb`/RAM-best-fit + `insufficientRam` gate keeps a vision model off
  machines that can't hold it (the existing AI Model gate). **Acceptance bar (§15):** useful on the
  **12–16 GB tier**; **not** shown as broadly available on 8 GB unless the benchmark proves it.

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

**Acceptance bar:** useful on ≥12–16 GB; not advertised as broadly available on 8 GB without proof;
**beats OCR-only + text model** on chart/screenshot/diagram tasks; **does not hallucinate confidently**
on ambiguous images. **Candidate families to evaluate (none hardcoded final until verified):**
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

### Phase V1 — model/runtime research gate (no user-facing feature)
1. On the **PAID smoke drive** (`F:\paid-gpu-smoke-drive`, real b9585 + a fetched VLM GGUF + mmproj),
   prove `llama-server --mmproj` starts and answers a `/v1/chat/completions` request with a base64
   `image_url` (Option A). Determine: base64 vs file-path requirement; whether the pinned build has
   multimodal at all (else → Option C + pin-bump proposal).
2. Pick the first candidate (likely **Qwen2.5-VL 3B Q4**); record license, exact files (GGUF + mmproj),
   sizes, real SHAs, min-RAM (from measured peak RSS), runtime args, known limitations.
3. Capture a verbatim real SSE sample → `tests/fixtures/` for a CI parser regression (the audit-L19
   fixture policy). **No app feature yet.**

### Phase V2 — backend skeleton
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
1. Nav item + route + Icon glyph + i18n keys.
2. `ImagesScreen` with all states (§5.6): unavailable/empty/selected/running/answer/error.
3. Drop zone + file picker (`chooseImage`/`readBytes`), preview, composer, chips, thread.
4. Client decode/downscale (no dep). Wire to the V2 backend (real when a model is present, friendly
   unavailable otherwise).

### Phase V4 — real local vision runtime
1. `VisionRuntime` real `ensureStarted` (`--mmproj`, loopback) + `analyze` (base64 `image_url` +
   `readChatSSE`), single-flight, idle/lock/quit/cancel teardown.
2. Cancellation (AbortController) + timeouts; one-job-at-a-time.
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
- `known-limitations.md` — CPU latency, RAM co-residency + idle teardown, single image / no compare /
  no persistence, OCR-vs-vision separation, the caller-supplied-path caveat reuse.
- `BUILD_STATE.md` — per-phase status, decisions, data contracts (the `images:*` IPC + `ImageJob`),
  next actions, risks. **(Mandatory per the per-phase ritual.)**
- User guide + troubleshooting — "Ask about an image"; what it is / isn't (not OCR, not generation);
  "needs a vision model"; honest limits.

---

## 19. Open decisions / research gates

1. **Server multimodal on the pinned b9585?** (V1 gate.) `--mmproj` + base64 `image_url` works
   (Option A, no disk) / needs a file path (Option A + temp) / no server multimodal (Option C CLI +
   **runtime-pin bump** — a major gate). *Recommendation: Option A; bump only if forced.*
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
10. **Streaming the answer** (per-job SSE channels, recommended) vs single-resolve + poll (simpler).
11. **GPU for vision** in v1 — default **CPU-pinned** for MVP; enable GPU only if V1 CPU TTFA is too
    slow (then reuse the ladder).
12. **Any audit event at all** — default **none** (dictation/search precedent: content-adjacent).
13. **Idle-teardown timeout** value for the vision sidecar (2–5 min) — tune with the benchmark.

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