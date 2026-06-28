import { t } from '../../../../shared/i18n'
import type { DocumentParser, ExtractedSegment, ParseContext, ParsedDocument } from './index'
import { AUDIO_DECODE_ERROR_PREFIX } from '../../transcriber/cli'
import { log } from '../../logging'
import { approxTokenCount, windowByTokens, CHUNK_DEFAULTS } from '../chunker'

// Audio "parser": a recording becomes a normal corpus document by running
// the injected transcriber (whisper.cpp CLI) and mapping its timestamped segments onto
// `ExtractedSegment`s. Page-less, so the txt/md chunk-dedup rule applies; the time
// range rides `sectionLabel` → `Citation.section`, zero citation-path changes.
//
// Extensions = exactly what the pinned whisper-cli v1.8.6 DECODES (probed with
// real files): wav, mp3, flac, ogg via bundled miniaudio. m4a/aac is NOT
// decodable (and we do not bundle ffmpeg) — descoped with friendly convert-to copy.
//
// SEGMENT PACKING (the chunker interaction): whisper emits one short segment per
// phrase (~2–10 s). Segments with DISTINCT sectionLabels never coalesce in the
// chunker, so raw whisper segments would become thousands of tiny chunks. The parser
// therefore packs consecutive whisper segments into paragraph-sized ExtractedSegments
// (~TARGET approx-tokens) labeled with the packed range ("mm:ss–mm:ss"). Each packed
// segment stays under MAX approx-tokens < the 500-token chunk window ⇒ every audio chunk
// is exactly one packed segment, verbatim, with NO overlap — which is what lets
// re-extraction (preview/translation/compare) read the stored CHUNKS instead of
// re-transcribing.
//
// RAG-N1: size is measured in APPROX-TOKENS (`approxTokenCount`, the same CJK/Thai-aware
// counter the chunker budgets with), NOT whitespace words. A space-less phrase (Japanese,
// Chinese, Thai) is a handful of "words" but hundreds of tokens; a word cap let such a
// packed segment blow past the chunk window, the chunker then WINDOWED it (with overlap),
// and the one-chunk-per-segment invariant broke — DUPLICATING spans in the
// preview/translate/compare output. Because every packed segment is now guaranteed
// `approxTokenCount(...) <= AUDIO_SEGMENT_MAX_TOKENS < chunkSizeTokens`, the chunker emits
// one window per segment and never reaches its char-slice/overlap path for audio — so the
// round-trip never DUPLICATES or DROPS content.
//
// One nuance (benign, no duplication): a single over-budget whisper segment is split into pieces
// that SHARE one time-range label, so `coalesceSegments` re-merges them and a small trailing
// remainder can normalize a `\n\n` piece boundary to a single space in a space-less script.
// Reconstruction stays byte-identical up to whitespace — never a duplicated/lost span. (Pre-existing
// property of coalesce; the old word-based Latin oversize path had it too.)

/** Extensions the pinned whisper-cli actually decodes — keep the promise honest. */
export const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg'] as const

// The three failure messages below are persist-canonical English (i18n record §3.3
// rule 1): they land in `documents.error_message`, so they are written as the explicit
// ENGLISH catalog values — the renderer display map translates them at display (D-L4).

/** Friendly copy when no transcriber is available (binary or weights missing). */
export const AUDIO_NEEDS_TRANSCRIBER_MESSAGE = t('en', 'main.ingest.audioNeedsTranscriber')

/** Friendly copy when the binary cannot decode the file (corrupt / unsupported codec). */
export const AUDIO_UNREADABLE_MESSAGE = t('en', 'main.ingest.audioUnreadable')

/** Friendly copy for any other transcription failure (killed child, bad exit, …). */
export const AUDIO_TRANSCRIPTION_FAILED_MESSAGE = t('en', 'main.ingest.audioTranscriptionFailed')

/** Packing target per ExtractedSegment in APPROX-TOKENS (~a paragraph / ~70 s of speech — the
 * citation granularity). For ordinary space-separated prose a token ≈ a word (every word ≤ 16
 * chars counts as 1), so this matches the prior word target; a rare long word (> 16 chars) counts
 * as more and shifts a boundary slightly — the more-accurate measure. For CJK/Thai it counts per
 * character, so a space-less transcript packs by its real size instead of collapsing to a few
 * "words". */
export const AUDIO_SEGMENT_TARGET_TOKENS = 180
/**
 * Hard cap per packed segment in APPROX-TOKENS. Kept a safe margin (100 tokens, ~20%) BELOW the
 * chunk window (`CHUNK_DEFAULTS.chunkSizeTokens`, 500) so every packed segment fits in ONE chunk
 * window: the chunker therefore never splits an audio segment and never adds overlap, which is
 * exactly what lets `audioSegmentsFromChunks` (ingestion) rebuild the transcript LOSSLESSLY (one
 * chunk = one packed segment, verbatim). Keyed off the chunk-window constant (RAG-N1) rather than
 * a standalone literal, and counted in tokens so the margin holds for space-less scripts too.
 */
export const AUDIO_SEGMENT_MAX_TOKENS = CHUNK_DEFAULTS.chunkSizeTokens - 100

/** `mm:ss` under an hour, `h:mm:ss` above (a 90-minute recording must stay readable). */
export function formatAudioTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** The time-range label that rides `sectionLabel` → `Citation.section`. */
export function audioRangeLabel(startMs: number, endMs: number): string {
  return `${formatAudioTimestamp(startMs)}–${formatAudioTimestamp(endMs)}`
}

interface TimedText {
  startMs: number
  endMs: number
  text: string
}

/**
 * Pack consecutive whisper segments into paragraph-sized, time-labeled
 * ExtractedSegments (see module note). Pure — unit-tested with a fake transcriber.
 */
export function packTranscriptSegments(segments: TimedText[]): ExtractedSegment[] {
  const out: ExtractedSegment[] = []
  let texts: string[] = []
  let tokens = 0
  let startMs = 0
  let endMs = 0

  const flush = (): void => {
    if (texts.length === 0) return
    // `approxTokenCount` is additive across a single-space join of trimmed parts, so the running
    // `tokens` total equals `approxTokenCount(texts.join(' '))` — the value the chunker will see.
    out.push({
      text: texts.join(' '),
      pageNumber: null,
      sectionLabel: audioRangeLabel(startMs, endMs)
    })
    texts = []
    tokens = 0
  }

  for (const seg of segments) {
    const text = seg.text.trim()
    if (text.length === 0) continue
    const segTokens = approxTokenCount(text)

    // An oversized single whisper segment (rare) is split so the ≤ MAX-tokens invariant holds for
    // every packed segment; the pieces share the time range. `windowByTokens` splits on CHARACTER
    // boundaries for space-less scripts (and word boundaries otherwise) — RAG-N1: a whitespace
    // split (the old code) does NOT bound a CJK/Thai segment. overlap = 0 keeps the pieces a
    // lossless partition, so reconstruction never duplicates a span.
    if (segTokens > AUDIO_SEGMENT_MAX_TOKENS) {
      flush()
      for (const piece of windowByTokens(text, AUDIO_SEGMENT_MAX_TOKENS, 0)) {
        out.push({
          text: piece,
          pageNumber: null,
          sectionLabel: audioRangeLabel(seg.startMs, seg.endMs)
        })
      }
      continue
    }

    if (texts.length === 0) {
      startMs = seg.startMs
    } else if (tokens + segTokens > AUDIO_SEGMENT_MAX_TOKENS) {
      flush()
      startMs = seg.startMs
    }
    texts.push(text)
    tokens += segTokens
    endMs = seg.endMs
    if (tokens >= AUDIO_SEGMENT_TARGET_TOKENS) flush()
  }
  flush()
  return out
}

export const AudioParser: DocumentParser = {
  name: 'audio',
  extensions: AUDIO_EXTENSIONS,
  // Fallback only — `processDocument` records the per-extension MIME (audio/wav, …).
  mimeType: 'audio/*',

  async parse(filePath: string, ctx?: ParseContext): Promise<ParsedDocument> {
    const transcriber = ctx?.transcriber
    if (!transcriber) {
      // Friendly per-file failure (never a throw that crashes the run — processDocument
      // catches this onto the document row as `failed` + error_message).
      throw new Error(AUDIO_NEEDS_TRANSCRIBER_MESSAGE)
    }
    let segments
    try {
      segments = await transcriber.transcribe(filePath, {
        onProgress: ctx?.onProgress,
        // workDir is REQUIRED by the transcriber (REL-6); the ingestion call site always
        // supplies the storeDir. Fall back to it explicitly so the type stays honest even
        // if a future caller builds a bare ParseContext.
        workDir: ctx?.workDir ?? '',
        // REL-1: forward cancellation so an aborted import kills the whisper child.
        signal: ctx?.signal
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // §11.4: the documents table gets friendly copy, never the raw decoder/process
      // error. The technical reason goes to the LOCAL log for diagnostics — it is
      // content-safe by construction (the transcriber's error tail is stderr-only;
      // the transcript itself rides stdout/JSON and never enters an error message).
      log.warn('Audio transcription failed', { error: message.slice(0, 600) })
      if (message.startsWith(AUDIO_DECODE_ERROR_PREFIX)) {
        throw new Error(AUDIO_UNREADABLE_MESSAGE)
      }
      throw new Error(AUDIO_TRANSCRIPTION_FAILED_MESSAGE)
    }
    return {
      segments: packTranscriptSegments(segments),
      mimeType: AudioParser.mimeType
    }
  }
}
