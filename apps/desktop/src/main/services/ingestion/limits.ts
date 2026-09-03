// Pre-parse resource caps for ingestion (security audit 2026-06-13, M-1/M-2/M-3).
//
// A document parser runs on an attacker-supplied file (a user imports a crafted PDF /
// DOCX / CSV / image). Without a ceiling, `readFile` slurps a multi-GB file into the
// main process (OOM), an unbounded PDF page loop spins forever, and a DOCX "zip bomb"
// (a few KB that inflate to gigabytes) exhausts memory. These caps bound the work
// BEFORE the parser touches the bytes. They are deliberately generous — a legitimate
// large recording or scan should still import — and every cap is overridable via an
// env var so a power user / a constrained machine can retune without a rebuild.

/** The ingestion resource ceilings. */
export interface IngestionLimits {
  /** Max bytes of the file handed to a parser (pre-parse, before read). */
  maxBytes: number
  /**
   * Max bytes for a format whose parser reads the WHOLE file into a single JS string
   * (text / Markdown / CSV — see `readsWholeFileToString`). PERF-4: those parsers
   * materialize the file as one UTF-16 string and derive more full copies (CSV alone holds
   * the raw string + papaparse's row array + the rebuilt `lines.join` ≈ 3× at once), so the
   * generous `maxBytes` (1 GiB) would blow past V8's ~512 MB string/heap ceiling and OOM-CRASH
   * the main process instead of hitting the friendly `fileTooLarge` reject. This conservative
   * cap (well under that ceiling, with headroom for the derived copies) keeps an oversize text
   * file a clean reject. The streaming/page-bounded formats (PDF/DOCX/audio/image) are unaffected
   * — they keep the full `maxBytes`.
   */
  textMaxBytes: number
  /** Wall-clock budget for a single `parser.parse()` call (non-audio — see processDocument). */
  parseTimeoutMs: number
  /** Max PDF pages the text-extraction loop will walk (M-2). */
  pdfMaxPages: number
  /** Max DECLARED uncompressed size of a DOCX zip before mammoth inflates it (M-3). */
  docxMaxInflatedBytes: number
}

/**
 * Defaults. 1 GiB on disk / inflated covers a long stereo recording or a big scan; the
 * 30-minute parse budget is a backstop for a pathological hang, not a tight SLA (a long
 * audio transcription is excluded from it in processDocument). 5 000 pages is far beyond
 * any real office document. `textMaxBytes` is 64 MiB (PERF-4): a string-safe ceiling for the
 * read-whole-file-to-string formats — comfortably under V8's ~512 MB string limit even after
 * CSV's 2–3× derived copies, while still admitting any realistic text/Markdown/CSV document.
 */
export const DEFAULT_INGESTION_LIMITS: IngestionLimits = {
  maxBytes: 1024 * 1024 * 1024,
  textMaxBytes: 64 * 1024 * 1024,
  parseTimeoutMs: 30 * 60_000,
  pdfMaxPages: 5_000,
  docxMaxInflatedBytes: 1024 * 1024 * 1024
}

/** Parse a positive integer env override, falling back to `fallback` for absent/junk. */
function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Resolve the effective limits, applying env overrides over the defaults:
 * `HILBERTRAUM_MAX_DOC_BYTES`, `HILBERTRAUM_TEXT_MAX_BYTES`, `HILBERTRAUM_PARSE_TIMEOUT_MS`,
 * `HILBERTRAUM_PDF_MAX_PAGES`, `HILBERTRAUM_DOCX_MAX_INFLATED_BYTES`.
 */
export function resolveIngestionLimits(env: NodeJS.ProcessEnv = process.env): IngestionLimits {
  return {
    maxBytes: envInt(env, 'HILBERTRAUM_MAX_DOC_BYTES', DEFAULT_INGESTION_LIMITS.maxBytes),
    textMaxBytes: envInt(env, 'HILBERTRAUM_TEXT_MAX_BYTES', DEFAULT_INGESTION_LIMITS.textMaxBytes),
    parseTimeoutMs: envInt(env, 'HILBERTRAUM_PARSE_TIMEOUT_MS', DEFAULT_INGESTION_LIMITS.parseTimeoutMs),
    pdfMaxPages: envInt(env, 'HILBERTRAUM_PDF_MAX_PAGES', DEFAULT_INGESTION_LIMITS.pdfMaxPages),
    docxMaxInflatedBytes: envInt(
      env,
      'HILBERTRAUM_DOCX_MAX_INFLATED_BYTES',
      DEFAULT_INGESTION_LIMITS.docxMaxInflatedBytes
    )
  }
}

/**
 * Most paths one renderer call may hand to the drop / preflight seams (#240). A cap on the
 * array, checked before the first filesystem call — an unbounded list of unreachable paths
 * used to cost one `lstat`/`stat` each on the main thread. Far above any real selection
 * (a folder pick is ONE path; the walk inside it is bounded separately by the walk budget).
 */
export const MAX_DROP_PATHS = 512

/** Bounds on the directory walk behind a folder drop / pick (#240; asynchronous since #274). */
export interface WalkBudget {
  /** Max directory entries the walk will look at across the whole selection. */
  maxEntries: number
  /** Max directory depth below a picked folder (the picked folder is depth 0). */
  maxDepth: number
  /** Wall-clock budget for the whole walk, checked once per directory. */
  maxMillis: number
}

/**
 * Defaults: 50 000 entries covers any realistic document archive on a portable drive; 64
 * levels is beyond any hand-made tree; 10 s is the longest a slow USB walk may run before the
 * selection is cut — since #274 the walk is asynchronous, so the budget bounds how long the
 * user waits, not a main-thread freeze. A cut walk imports what it reached, stops, and reports
 * the cut (`exhausted` on the preflight result and the import job). Each is env-overridable
 * like the parser caps above.
 */
export const DEFAULT_WALK_BUDGET: WalkBudget = {
  maxEntries: 50_000,
  maxDepth: 64,
  maxMillis: 10_000
}

/**
 * Resolve the walk budget with env overrides: `HILBERTRAUM_WALK_MAX_ENTRIES`,
 * `HILBERTRAUM_WALK_MAX_DEPTH`, `HILBERTRAUM_WALK_BUDGET_MS`.
 */
export function resolveWalkBudget(env: NodeJS.ProcessEnv = process.env): WalkBudget {
  return {
    maxEntries: envInt(env, 'HILBERTRAUM_WALK_MAX_ENTRIES', DEFAULT_WALK_BUDGET.maxEntries),
    maxDepth: envInt(env, 'HILBERTRAUM_WALK_MAX_DEPTH', DEFAULT_WALK_BUDGET.maxDepth),
    maxMillis: envInt(env, 'HILBERTRAUM_WALK_BUDGET_MS', DEFAULT_WALK_BUDGET.maxMillis)
  }
}

/**
 * Race a parse against a wall-clock timeout, rejecting with `message` (a persist-canonical
 * English string the caller supplies) if the budget elapses first. This bounds how long the
 * pipeline WAITS, so a wedged parser fails the one document instead of hanging the import loop;
 * `onTimeout` runs when the budget elapses so the caller can also cancel the work (#237 —
 * `parseWithLimits` aborts the parse signal there). A parser that ignores its signal keeps
 * running regardless; the lock/quit sweep bounds its transient.
 */
export function withParseTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // The timeout rejection first, so the race reports `message` — the cancel hook may make
      // the work reject synchronously with its own error.
      reject(new Error(message))
      try {
        onTimeout?.()
      } catch {
        /* the rejection above is the contract; a cancel hook must not mask it */
      }
    }, timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Sum the DECLARED uncompressed sizes of every entry in a ZIP central directory, or
 * `null` when the buffer is not a parseable local ZIP (a malformed/unknown container —
 * let the parser surface its own error rather than guessing). A ZIP64 size marker
 * (0xFFFFFFFF) is treated as +Infinity so an oversized member is rejected. Used to refuse
 * a DOCX zip bomb (M-3) before mammoth/JSZip inflates it. NOTE: the declared sizes can be
 * spoofed — this catches the common honest-metadata bomb; the pre-parse byte cap + parse
 * timeout remain the backstop for a lying archive.
 */
export function declaredZipInflatedSize(buf: Buffer): number | null {
  const EOCD_SIG = 0x06054b50
  const CDH_SIG = 0x02014b50
  // Find the End Of Central Directory record by scanning backwards (the comment is
  // almost always empty, so it sits at length-22; cap the scan at the max comment size).
  const minEocd = 22
  if (buf.length < minEocd) return null
  let eocd = -1
  const scanFrom = Math.max(0, buf.length - (minEocd + 0xffff))
  for (let i = buf.length - minEocd; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null

  const totalEntries = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset >= buf.length) return null

  let total = 0
  let p = cdOffset
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) return null
    const uncompressed = buf.readUInt32LE(p + 24)
    if (uncompressed === 0xffffffff) return Number.POSITIVE_INFINITY // ZIP64 — treat as huge
    total += uncompressed
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    p += 46 + nameLen + extraLen + commentLen
  }
  return total
}
