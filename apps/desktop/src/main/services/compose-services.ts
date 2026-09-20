import { createSelectedEmbedder } from './embeddings/factory'
import { createSelectedReranker } from './reranker'
import { createSelectedTranscriber } from './transcriber'
import { createSelectedOcrEngine } from './ocr'
import { createSelectedTranslator } from './translation'
import { resolveModelByRole } from './resolve-model'
import { discoverManifests, type DiscoveredManifest } from './models'
import { log } from './logging'
import { perfMark } from './perf'
import type { Embedder } from './embeddings'
import type { Reranker } from './reranker'
import type { Transcriber } from './transcriber'
import type { OcrEngine } from './ocr'
import type { Translator, TranslationGpuDeps } from './translation'

// M-A3 (audit-2026-06-13): the four availability-driven service selectors (embedder,
// reranker, transcriber, OCR) were ~30 lines of near-identical "resolve the role's model,
// pick the real sidecar-backed service when its binary + weights are present, else
// mock/null, and log the choice" inline in initBackend(). They depend on nothing but the
// drive root + the manifests dir, so they extract cleanly into one builder. The
// runtime/GPU wiring (late-bound crash handler) stays in initBackend — it is genuinely
// entangled and not part of this cohesive unit.

export interface AvailabilityServices {
  embedder: Embedder
  reranker: Reranker | null
  transcriber: Transcriber | null
  ocrEngine: OcrEngine | null
  /**
   * The TranslateGemma translation sidecar (TG wave, plan §2 D1), selected only when its binary +
   * GGUF are present (null otherwise — translation refuses with a friendly install path at TG-3;
   * no mock, which would invent a translation). Availability-driven via `resolveModelByRole`.
   */
  translator: Translator | null
}

export interface ComposeServicesDeps {
  /** Drive root used to resolve binaries + weight paths. */
  rootPath: string
  /** Resolved model-manifests dir, or null (→ every role falls back to mock/null). */
  manifestsDir: string | null
  /**
   * Developer build (`!app.isPackaged`). Gates the dev-only `HILBERTRAUM_LLAMA_BIN` /
   * `HILBERTRAUM_WHISPER_BIN` binary overrides (M-5): in a packaged build the sidecar
   * binaries are resolved only from the on-drive location, never an env-supplied path.
   * Defaults to `false` (ignore the override) so a forgetful caller fails SAFE.
   */
  isDev?: boolean
  /**
   * GPU signals for the TRANSLATION sidecar's device ladder (issue #42) — the same Settings
   * read-callbacks the chat ladder gets. Only the translator consumes them for now: the embedder,
   * reranker, and vision sidecars keep their own (CPU) device postures per their design records.
   */
  gpu?: TranslationGpuDeps
  /**
   * Manifests already discovered by THIS composition pass (PF-4, full-audit 2026-07-10).
   * `composeServices` fills it in so its role resolutions share ONE synchronous walk + YAML
   * parse; the issue-#40 `onModelInstalled` → `composeTranslator` call site omits it and
   * re-discovers, because it reacts to a download that just CHANGED the drive layout.
   */
  discovered?: DiscoveredManifest[]
  /**
   * Step 4-4 (Wave 4 ruling (a)), Wave 8 ruling (a)/(b)(Q) (step 4-8): which device the reranker
   * sidecar should use — consulted by `rerank()` before starting/joining/reusing the sidecar,
   * and again after every await inside it (never once per cold start any more). Optional on
   * THIS base type only because `composeTranslator` shares it and never touches the reranker;
   * `composeServices`'s own signature below REQUIRES it (`ComposeServicesRerankerDeps`) — Wave 8
   * NF-1, the analysis's finding that an optional wire here is exactly how a posture input
   * silently goes missing. The ONE production caller (`main/index.ts`) builds it with the
   * exported `createRerankerCallbacks` factory (`rag/device-posture.ts`), never inline. Tests
   * that construct a reranker directly (`createLlamaReranker`, bypassing `composeServices`) are
   * unaffected — that option stays optional there too, which is what keeps the acceptance
   * harness inert by default (ruling (f)).
   */
  rerankerDevicePosture?: () => 'gpu' | 'cpu'
  /**
   * Wave 8 ruling (b)(G): the CPU posture's per-call request ceiling. Optional on this base type
   * for the same `composeTranslator`-sharing reason as `rerankerDevicePosture` above;
   * `composeServices`'s own signature requires it. Absent at the `LlamaReranker` level (a direct
   * construction, e.g. the acceptance harness or a manual smoke) admits every request —
   * additive, never a behaviour change there.
   */
  rerankerRequestCeiling?: () => number
}

/**
 * Wave 8 ruling (b)(G)/NF-1: the two reranker callbacks, REQUIRED specifically on
 * `composeServices`'s own parameter type (below) — never on the shared `ComposeServicesDeps`
 * base, which `composeTranslator` also takes and never touches the reranker. An intersection,
 * not a widened base interface, so `composeTranslator`'s existing callers are untouched and a
 * composition test can prove `composeServices` alone refuses a missing wire
 * (`// @ts-expect-error`).
 */
export type ComposeServicesArgs = ComposeServicesDeps &
  Required<Pick<ComposeServicesDeps, 'rerankerDevicePosture' | 'rerankerRequestCeiling'>>

/**
 * Build (or re-build) JUST the translation sidecar selection from the current drive layout.
 * Extracted from `composeServices` for issue #40: a completed in-app model download re-runs THIS
 * selector (via `AppContext.onModelInstalled`) so translation activates without an app restart —
 * both call sites stay byte-identical in their deps. Cheap + synchronous by design (the sidecar is
 * lazy; construction spawns nothing).
 */
export function composeTranslator(deps: ComposeServicesDeps): Translator | null {
  return createSelectedTranslator({
    rootPath: deps.rootPath,
    isDev: deps.isDev ?? false,
    model: resolveModelByRole(deps.manifestsDir, deps.rootPath, 'translation', {
      discovered: deps.discovered
    }),
    gpu: deps.gpu,
    onDeviceFallback: (reason) =>
      log.warn('Translation sidecar fell back to CPU for this session', { reason }),
    // Issue #42 reopen: log every cold start's observed outcome symmetrically with the chat
    // ladder's "started via rung …" line. The layer split is what makes a silent `--fit`
    // PARTIAL offload (a resident chat model took the VRAM → ~CPU-speed decode under a 'gpu'
    // posture) diagnosable from app.log; posture alone would hide it.
    onStarted: ({ device, gpuLayers, totalLayers }) =>
      log.info('Translation sidecar started', {
        device,
        offload: gpuLayers != null && totalLayers != null ? `${gpuLayers}/${totalLayers} layers` : 'not reported'
      }),
    onSelect: (kind, reason) => log.info('Translation backend selected', { kind, reason })
  })
}

/**
 * Should the issue-#40 `onModelInstalled` refresh replace the current translator slot?
 * True for a NULL slot (the role was unavailable at startup — the original #40 case) and for
 * a `startFailed`-latched instance (BE-7, full-audit 2026-07-10): a latched instance is
 * lazy/dead — construction spawns nothing and no live child exists to orphan — and without
 * replacement a corrupt-GGUF delete-and-re-download repair stayed blocked until an app
 * restart. A LIVE (or merely lazy, non-latched) sidecar is never replaced.
 */
export function shouldReplaceTranslator(current: Translator | null | undefined): boolean {
  return current == null || current.isStartFailed?.() === true
}

/**
 * Build the availability-driven services from the drive layout: the embedder (real E5 when
 * its binary + weights are present, else mock so the app launches model-free), and the
 * reranker / transcriber / OCR engine (real when provisioned, else `null` — a mock there
 * would invent an ordering / a transcript / OCR text and silently corrupt answers).
 */
export function composeServices({
  rootPath,
  manifestsDir,
  isDev = false,
  gpu,
  rerankerDevicePosture,
  rerankerRequestCeiling
}: ComposeServicesArgs): AvailabilityServices {
  // PF-4 (full-audit 2026-07-10): ONE manifest walk + YAML parse serves every role resolution
  // of this composition pass — initBackend runs it synchronously before the window exists, and
  // each `resolveModelByRole` call used to re-walk the dir. Scoped to THIS call, NOT a module
  // cache: the per-action callers (model IPC, `onModelInstalled` → `composeTranslator`)
  // deliberately re-discover so a just-downloaded manifest is never served stale. An unreadable
  // dir reads as "no models" for every role — exactly what each resolver's own catch produced
  // before (the same throw, once per role), minus the redundant re-walks.
  let discovered: DiscoveredManifest[] | undefined
  try {
    discovered = manifestsDir ? discoverManifests(manifestsDir).manifests : undefined
  } catch {
    discovered = []
  }
  const embedder = createSelectedEmbedder({
    rootPath,
    isDev,
    model: resolveModelByRole(manifestsDir, rootPath, 'embeddings', { discovered }),
    onSelect: (kind, reason) => {
      log.info('Embedder backend selected', { kind, reason })
      // Measurement-run validity check: an ingestion timed against the mock embedder is
      // meaningless, and the fallback is otherwise silent (perf.ts content rules).
      perfMark('embedder_selected', { kind })
    }
  })
  // The retrieval reranker — selected only when binary + reranker GGUF exist (null
  // otherwise; retrieval then keeps today's ordering byte-identical). `rerankerDevicePosture`
  // is consulted by `rerank()` on every call (Wave 8 ruling (b)(Q)); `rerankerRequestCeiling`
  // gates the CPU posture's request size (Wave 8 ruling (b)(G)).
  const reranker = createSelectedReranker({
    rootPath,
    isDev,
    model: resolveModelByRole(manifestsDir, rootPath, 'reranker', { discovered }),
    onSelect: (kind, reason) => log.info('Reranker backend selected', { kind, reason }),
    devicePosture: rerankerDevicePosture,
    requestCeiling: rerankerRequestCeiling,
    // #474: surfaced the same way translation's GPU fallback is disclosed — a log line here, and
    // the Performance screen's reranker row already reads `devicePosture()`, which reports 'cpu'
    // once this latch is armed.
    onDeviceFallback: (reason) => log.warn('Reranker sidecar fell back to CPU for this session', { reason })
  })
  // The audio transcriber — the whisper.cpp CLI; selected only when binary + GGML weights
  // exist (null otherwise; audio imports fail per-file with the download-the-model copy).
  // No context window.
  const transcriber = createSelectedTranscriber({
    rootPath,
    isDev,
    model: resolveModelByRole(manifestsDir, rootPath, 'transcriber', {
      includeContextTokens: false,
      discovered
    }),
    onSelect: (kind, reason) => log.info('Transcriber backend selected', { kind, reason })
  })
  // Local OCR — tesseract.js over the drive's vendored `ocr/` language files; selected
  // only when those exist (null otherwise; photo imports fail per-file and detected scans
  // show the notice without the "Make searchable" offer).
  // A packaged build must prove the worker runs before `ocrAvailable` may say so: the engine
  // starts 'probing' and the main wiring runs `engine.probe()` once at startup (#232).
  const ocrEngine = createSelectedOcrEngine({
    rootPath,
    probeRequired: !isDev,
    onSelect: (kind, reason) => log.info('OCR backend selected', { kind, reason })
  })
  // The TranslateGemma sidecar (TG wave). Selected only when the llama-server binary + the
  // translation GGUF are present (null otherwise — no mock; translation refuses with the friendly
  // install path at TG-3). Its own lazy `LlamaServer`, --ctx-size from the manifest, no --jinja.
  // Shares `composeTranslator` with the issue-#40 post-download re-selection so the two call
  // sites can never drift.
  const translator = composeTranslator({ rootPath, manifestsDir, isDev, gpu, discovered })

  return { embedder, reranker, transcriber, ocrEngine, translator }
}
