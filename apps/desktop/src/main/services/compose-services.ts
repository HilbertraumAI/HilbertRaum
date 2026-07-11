import { createSelectedEmbedder } from './embeddings/factory'
import { createSelectedReranker } from './reranker'
import { createSelectedTranscriber } from './transcriber'
import { createSelectedOcrEngine } from './ocr'
import { createSelectedTranslator } from './translation'
import { resolveModelByRole } from './resolve-model'
import { discoverManifests, type DiscoveredManifest } from './models'
import { log } from './logging'
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
}

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
  gpu
}: ComposeServicesDeps): AvailabilityServices {
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
    onSelect: (kind, reason) => log.info('Embedder backend selected', { kind, reason })
  })
  // The retrieval reranker — selected only when binary + reranker GGUF exist (null
  // otherwise; retrieval then keeps today's ordering byte-identical).
  const reranker = createSelectedReranker({
    rootPath,
    isDev,
    model: resolveModelByRole(manifestsDir, rootPath, 'reranker', { discovered }),
    onSelect: (kind, reason) => log.info('Reranker backend selected', { kind, reason })
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
  const ocrEngine = createSelectedOcrEngine({
    rootPath,
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
