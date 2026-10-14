// Vitest setup, applied FIRST to every test file (#687): drop the behaviour overrides the app reads
// from the environment, so a developer shell that exports one (`HILBERTRAUM_PDF_MAX_PAGES=1`,
// `HR_FORCE_REINDEX=1`, …) cannot change what `npm test` proves. Before this, such a shell turned
// hundreds of rows red across the documents, OCR, skills and vision suites, which run on the
// shipped defaults without stubbing them.
//
// Top level, not `beforeEach`: some readers run at import time (`OCR_MAX_PAGE_PNG_BYTES` in
// ocr/page-cap.ts, `VISION_MAX_IMAGE_BYTES` / `_PIXELS` in vision/limits.ts), and setup files load
// before the test file imports anything. A row that wants an override still sets it itself
// (`vi.stubEnv` or a saved-and-restored `process.env` write).
//
// An EXPLICIT list, never a prefix sweep: the variables the test harness itself reads
// (`HILBERTRAUM_TEST_DEFERRED_ROOTS`, set by global-temp-roots.ts), `CI`, the env gates of the
// manual / real-model / e2e-model / eval tiers, and the dev-binary paths those tiers use
// (`HILBERTRAUM_LLAMA_BIN`, `_WHISPER_BIN`, `_KIWIX_BIN`) must reach the tests untouched.
//
// A NEW override read in `src/` belongs in `SCRUBBED_ENV` (or, when a test tier must see the
// developer's value, in `ENV_NOT_SCRUBBED` with the reason); tests/unit/env-scrub.test.ts fails
// until it is in one.

/** Behaviour overrides read in `src/` (each one's reader in the comment), deleted for every test file. */
export const SCRUBBED_ENV: readonly string[] = [
  // ingestion/limits.ts resolveIngestionLimits
  'HILBERTRAUM_MAX_DOC_BYTES',
  'HILBERTRAUM_TEXT_MAX_BYTES',
  'HILBERTRAUM_PARSE_TIMEOUT_MS',
  'HILBERTRAUM_PDF_MAX_PAGES',
  'HILBERTRAUM_DOCX_MAX_INFLATED_BYTES',
  // ingestion/limits.ts resolveWalkBudget
  'HILBERTRAUM_WALK_MAX_ENTRIES',
  'HILBERTRAUM_WALK_MAX_DEPTH',
  'HILBERTRAUM_WALK_BUDGET_MS',
  // skills/limits.ts resolveSkillLimits
  'HILBERTRAUM_SKILL_MAX_FILE_BYTES',
  'HILBERTRAUM_SKILL_MAX_TOTAL_BYTES',
  'HILBERTRAUM_SKILL_MAX_FILES',
  'HILBERTRAUM_SKILL_MAX_PATH_LEN',
  'HILBERTRAUM_SKILL_MAX_DEPTH',
  'HILBERTRAUM_SKILL_MAX_BODY',
  // ipc/registerDictationIpc.ts
  'HILBERTRAUM_DICTATION_TIMEOUT_MS',
  // analysis/summary-cache.ts
  'HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS',
  // ocr/tesseract.ts, ocr/page-cap.ts (import time)
  'HILBERTRAUM_OCR_PAGE_TIMEOUT_MS',
  'HILBERTRAUM_MAX_OCR_PAGE_BYTES',
  // runtime-download.ts
  'HILBERTRAUM_EXTRACT_DEADLINE_MS',
  // vision/limits.ts (import time)
  'HILBERTRAUM_MAX_IMAGE_BYTES',
  'HILBERTRAUM_MAX_IMAGE_PIXELS',
  // sidecar idle timers: transcriber/cli.ts, vision/runtime.ts, translation/runtime.ts
  'HILBERTRAUM_WHISPER_IDLE_TIMEOUT_MS',
  'HILBERTRAUM_VISION_IDLE_MS',
  'HILBERTRAUM_TRANSLATION_IDLE_MS',
  // ingestion/index.ts, embeddings/e5.ts, perf.ts
  'HR_FORCE_REINDEX',
  'HR_EMBED_COVERAGE',
  'HILBERTRAUM_PERF_LOG'
]

/** `HILBERTRAUM_*` / `HR_*` names in `src/` that are deliberately NOT scrubbed. */
export const ENV_NOT_SCRUBBED: readonly string[] = [
  // Dev-binary paths: the real-model / e2e-model / manual tiers point them at real binaries; the
  // normal suites that resolve a binary stub them per suite (engine-recheck).
  'HILBERTRAUM_LLAMA_BIN',
  'HILBERTRAUM_WHISPER_BIN',
  'HILBERTRAUM_KIWIX_BIN',
  // Read only by the app entry (src/main/index.ts), which no test imports.
  'HILBERTRAUM_DRIVE_ROOT',
  'HILBERTRAUM_MANIFESTS_DIR'
]

for (const name of SCRUBBED_ENV) delete process.env[name]
