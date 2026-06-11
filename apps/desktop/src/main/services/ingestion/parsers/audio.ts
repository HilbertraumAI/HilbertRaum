import type { DocumentParser, ExtractedSegment, ParseContext, ParsedDocument } from './index'
import { AUDIO_DECODE_ERROR_PREFIX } from '../../transcriber/cli'
import { log } from '../../logging'

// Audio "parser" (Phase 36): a recording becomes a normal corpus document by running
// the injected transcriber (whisper.cpp CLI) and mapping its timestamped segments onto
// `ExtractedSegment`s. Page-less, so the txt/md chunk-dedup rule applies; the time
// range rides `sectionLabel` → `Citation.section`, zero citation-path changes (D29).
//
// Extensions = exactly what the pinned whisper-cli v1.8.6 DECODES (R-W2, probed with
// real files 2026-06-11): wav, mp3, flac, ogg via bundled miniaudio. m4a/aac is NOT
// decodable (and we do not bundle ffmpeg) — descoped with friendly convert-to copy.
//
// SEGMENT PACKING (the chunker interaction): whisper emits one short segment per
// phrase (~2–10 s). Segments with DISTINCT sectionLabels never coalesce in the
// chunker, so raw whisper segments would become thousands of tiny chunks. The parser
// therefore packs consecutive whisper segments into paragraph-sized ExtractedSegments
// (~TARGET words) labeled with the packed range ("mm:ss–mm:ss"). Each packed segment
// stays under MAX words < the 500-token chunk window ⇒ every audio chunk is exactly
// one packed segment, verbatim, with NO overlap — which is what lets re-extraction
// (preview/translation/compare) read the stored CHUNKS instead of re-transcribing.

/** Extensions the pinned whisper-cli actually decodes (R-W2 — keep the promise honest). */
export const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg'] as const

/** Friendly copy when no transcriber is available (binary or weights missing). */
export const AUDIO_NEEDS_TRANSCRIBER_MESSAGE =
  'Audio import needs the transcription model — download it on the AI Model screen.'

/** Friendly copy when the binary cannot decode the file (corrupt / unsupported codec). */
export const AUDIO_UNREADABLE_MESSAGE =
  'This audio file could not be read. Convert it to WAV or MP3 and import it again.'

/** Friendly copy for any other transcription failure (killed child, bad exit, …). */
export const AUDIO_TRANSCRIPTION_FAILED_MESSAGE =
  'The recording could not be transcribed. Re-index this document to try again.'

/** Packing target per ExtractedSegment (~70 s of speech — the citation granularity). */
export const AUDIO_SEGMENT_TARGET_WORDS = 180
/**
 * Hard cap per packed segment. MUST stay below the 500-token chunk window so every
 * audio chunk is one packed segment verbatim (no windowing, no overlap) — the
 * invariant `audioSegmentsFromChunks` (ingestion) relies on.
 */
export const AUDIO_SEGMENT_MAX_WORDS = 400

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

/** The D29 time-range label that rides `sectionLabel` → `Citation.section`. */
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
  let words = 0
  let startMs = 0
  let endMs = 0

  const flush = (): void => {
    if (texts.length === 0) return
    out.push({
      text: texts.join(' '),
      pageNumber: null,
      sectionLabel: audioRangeLabel(startMs, endMs)
    })
    texts = []
    words = 0
  }

  for (const seg of segments) {
    const text = seg.text.trim()
    if (text.length === 0) continue
    const segWords = text.split(/\s+/).length

    // An oversized single whisper segment (rare) is split on word boundaries so the
    // ≤ MAX invariant holds for every packed segment; the pieces share the time range.
    if (segWords > AUDIO_SEGMENT_MAX_WORDS) {
      flush()
      const tokens = text.split(/\s+/)
      for (let i = 0; i < tokens.length; i += AUDIO_SEGMENT_MAX_WORDS) {
        out.push({
          text: tokens.slice(i, i + AUDIO_SEGMENT_MAX_WORDS).join(' '),
          pageNumber: null,
          sectionLabel: audioRangeLabel(seg.startMs, seg.endMs)
        })
      }
      continue
    }

    if (texts.length === 0) {
      startMs = seg.startMs
    } else if (words + segWords > AUDIO_SEGMENT_MAX_WORDS) {
      flush()
      startMs = seg.startMs
    }
    texts.push(text)
    words += segWords
    endMs = seg.endMs
    if (words >= AUDIO_SEGMENT_TARGET_WORDS) flush()
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
        workDir: ctx?.workDir
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
