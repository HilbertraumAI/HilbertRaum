import { en, type MessageKey } from './i18n'

// Persisted message values (app-update plan W-69, frozen contract F-26; T2.12). Main stores a fixed set of its own
// messages as canonical ENGLISH (documents.error_message, the fixed RAG answers in messages.content, the default
// titles, the benchmark warnings in settings: i18n record §3.3 rule 1, D-L4). This module says what a stored string is,
// for both processes: the renderer's display map (`renderer/lib/displayMap.ts`) shows it in the UI language, and main
// reads a stored message by its key where it acts on one (`scanDetected`, the default-title check, the slow-read upsert).
//
// Release 1 is the oldest version that will ever read a workspace, so what it does here can never be fixed in the field:
//  - The English values are locked by `tests/fixtures/display-map/values.json`. A value that changes keeps its old text
//    readable for ever through PERSISTED_ALIASES.
//  - A later version may store the coded form instead: `hr:<key>`, plus `?<name>=<value>&…` for the placeholders of
//    the key's English template, each value percent-encoded (encodeURIComponent). Matched against the WHOLE string, with
//    no trimming. A code whose key is in this version's catalog and supplies every placeholder of its English template
//    reads as that message (extra parameters are ignored). Any other well-formed code (an unknown key, a missing
//    placeholder, a parameter given twice, a value that does not percent-decode) is one this version cannot show:
//    the display map shows `common.newerVersionText` (C02). A string that is not of the code's shape is no code.
//  - This version never stores a code (D-9): v0.1.66 and older would show it raw.

/** Every persist-canonical key the map recognizes (keep in step with the en.ts set —
 * exported so the catalog hygiene test can pin the two sets to each other). */
export const DISPLAY_MAP_KEYS: readonly MessageKey[] = [
  'main.ingest.pdfScanDetected',
  'main.ingest.audioNeedsTranscriber',
  // #527: the audio failure names the missing piece — engine, both, or no engine for this system.
  'main.ingest.audioNeedsEngine',
  'main.ingest.audioNeedsModelAndEngine',
  'main.ingest.audioEngineUnsupported',
  'main.ingest.audioUnreadable',
  'main.ingest.audioTranscriptionFailed',
  // #530: the OS refused to start the AI engine / the voice engine (no library named).
  'main.ingest.engineCannotRun',
  'main.ingest.voiceEngineCannotRun',
  // #869: the voice engine cannot read the speech model's file name on Windows (no path in it).
  'main.ingest.voiceModelPathUnsupported',
  // #1012: a file of the voice engine could not be read just now (an audio import's row; the engines'
  // own notice text, so its English value is persist-canonical too).
  'main.engine.filesUnreadable',
  // #634: the search model timed out, could not start, or failed (chosen by kind, never its text).
  'main.ingest.searchModelTimeout',
  'main.ingest.searchModelCannotStart',
  'main.ingest.searchModelFailed',
  'main.ingest.imageNeedsOcr',
  'main.ingest.imageNoText',
  'main.ingest.imageOcrFailed',
  // Photo stored without recognition because the recognizer cannot run in this build (#232).
  'main.ingest.imageOcrUnavailable',
  'main.ingest.sourceMissing',
  'main.ingest.interrupted',
  'main.ingest.fileTooLarge',
  'main.ingest.tooManyChunks',
  'main.ingest.parseTimeout',
  'main.rag.noContext',
  'main.rag.reindexNeeded',
  'main.chat.docTaskBusy',
  'main.chat.defaultTitle',
  'main.evidenceReviews.defaultTitle',
  'main.benchmark.warnTiny',
  'main.benchmark.warnUnknown',
  'main.benchmark.warnDriveProbe',
  'main.benchmark.warnSlowDrive',
  // #185: the contended-probe warning is persisted into settings.lastBenchmark.warnings like
  // its siblings, and carries no interpolated value — so it is exact-match, not INTERPOLATED.
  'main.benchmark.warnSpeedSkipped'
]

/** Persist-canonical keys handled via the interpolated matcher (not exact-match). Exported
 *  so the catalog-hygiene test can pin this set too. Each is reverse-matched by a pattern built
 *  from its English template, every `{name}` placeholder a capture. */
export const INTERPOLATED_MAP_KEYS: readonly MessageKey[] = [
  'main.ingest.unsupportedType',
  'main.benchmark.warnVeryLowTokens',
  'main.benchmark.warnSlowRead',
  'main.benchmark.warnRecommendationLowered',
  // #530: the engine cannot run because this system library is missing — the library's file
  // NAME is the one interpolated value (never a path: the raw loader line is never stored).
  'main.ingest.engineLibraryMissing'
]

/**
 * Old values of the keys above, readable for ever (F-26). APPEND ONLY; NEVER REMOVE A LINE.
 *
 * When the English of a key above changes, its old value joins this table in the same change (the value fixture's
 * test fails until it does). An exact key's alias is its old text; an interpolated key's alias is its old template,
 * whose `{name}` placeholders the current template must also have, tried after every current template. The module
 * refuses to load with an alias that is another key's value or alias, or that belongs to a key not above.
 *
 * Empty: no released value has ever changed (v0.1.8 to v0.1.66). The one old form not here is the pre-i18n
 * unsupported-type wording, a hand-written pattern in `renderer/lib/displayMap.ts` (its literal would trip the
 * copy-tone guard).
 */
export const PERSISTED_ALIASES: Readonly<Partial<Record<MessageKey, readonly string[]>>> = {}

/** What a stored string is to this version. */
export type PersistedMessage =
  /** One of this version's messages: its key, and the values of its English template's placeholders. */
  | { readonly kind: 'message'; readonly key: MessageKey; readonly params: Readonly<Record<string, string>> }
  /** A well-formed code this version cannot show (the display map shows C02 for it). */
  | { readonly kind: 'unknownCode' }

const UNKNOWN_CODE: PersistedMessage = { kind: 'unknownCode' }

/**
 * The coded form, `^hr:<key>(\?<name>=<value>(&<name>=<value>)*)?$` over the whole string (D-6): <key> has the shape of
 * every catalog key, <name> the shape of every placeholder, and <value> is exactly encodeURIComponent's output alphabet
 * (\x27 is the apostrophe). Group 1 is the key, group 2 the parameter list.
 */
const CODE_RE =
  /^hr:([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)(?:\?([a-z][A-Za-z0-9]*=[A-Za-z0-9\-_.!~*\x27()%]*(?:&[a-z][A-Za-z0-9]*=[A-Za-z0-9\-_.!~*\x27()%]*)*))?$/

/** A `{name}` placeholder, as `t()` interpolates it (`shared/i18n/index.ts`). */
const PLACEHOLDER_SPLIT_RE = /\{(\w+)\}/

/** The placeholder names of `template`, each once, in order. */
function placeholdersOf(template: string): string[] {
  const names = template.split(PLACEHOLDER_SPLIT_RE).filter((_part, i) => i % 2 === 1)
  return [...new Set(names)]
}

interface TemplatePattern {
  readonly key: MessageKey
  readonly re: RegExp
  /** The placeholder of each capture group, in template order. */
  readonly names: readonly string[]
}

/** A `^…$` pattern for `template`: the text escaped, each `{name}` a lazy capture. */
function templatePattern(key: MessageKey, template: string): TemplatePattern {
  const names: string[] = []
  const source = template
    .split(PLACEHOLDER_SPLIT_RE)
    .map((part, i) => {
      if (i % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(part)
      return '(.+?)'
    })
    .join('')
  return { key, re: new RegExp(`^${source}$`), names }
}

/** A code's message: the catalog's own key with every placeholder of its English supplied, else an unknown code. */
function codeMessage(catalog: Readonly<Record<string, string>>, key: string, query: string | undefined): PersistedMessage {
  if (!Object.hasOwn(catalog, key)) return UNKNOWN_CODE
  const given = new Map<string, string>()
  for (const pair of query === undefined ? [] : query.split('&')) {
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq)
    if (given.has(name)) return UNKNOWN_CODE
    let value: string
    try {
      value = decodeURIComponent(pair.slice(eq + 1))
    } catch {
      return UNKNOWN_CODE // a malformed escape (URIError)
    }
    given.set(name, value)
  }
  const params: Record<string, string> = {}
  for (const name of placeholdersOf(catalog[key]!)) {
    const value = given.get(name)
    if (value === undefined) return UNKNOWN_CODE
    params[name] = value
  }
  return { kind: 'message', key: key as MessageKey, params }
}

/**
 * Build the reader of stored strings from a catalog, the two key sets and an alias table. The module builds the one
 * the app uses from `en`, DISPLAY_MAP_KEYS, INTERPOLATED_MAP_KEYS and PERSISTED_ALIASES. Throws when an alias or a
 * value has two owners, an alias belongs to no key of the two sets, or an interpolated alias names a placeholder its
 * current template lacks: each would make a stored value read as the wrong message, or as none.
 */
export function buildPersistedMessageParser(
  catalog: Readonly<Record<MessageKey, string>>,
  exactKeys: readonly MessageKey[],
  interpolatedKeys: readonly MessageKey[],
  aliases: Readonly<Partial<Record<MessageKey, readonly string[]>>>
): (raw: string) => PersistedMessage | null {
  const entries: Readonly<Record<string, string>> = catalog
  const mapped = new Set<string>([...exactKeys, ...interpolatedKeys])
  for (const key of Object.keys(aliases)) {
    if (!mapped.has(key)) throw new Error(`persisted-messages: an alias of ${key} is never read (not a display-mapped key)`)
  }
  const owner = new Map<string, MessageKey>()
  const claim = (text: string, key: MessageKey): void => {
    const other = owner.get(text)
    if (other !== undefined && other !== key) {
      throw new Error(`persisted-messages: ${JSON.stringify(text)} of ${key} is already a value or alias of ${other}`)
    }
    owner.set(text, key)
  }

  const exact = new Map<string, MessageKey>()
  for (const key of exactKeys) {
    claim(entries[key]!, key)
    exact.set(entries[key]!, key)
  }
  const current = interpolatedKeys.map((key) => {
    claim(entries[key]!, key)
    return templatePattern(key, entries[key]!)
  })
  for (const key of exactKeys) {
    for (const alias of aliases[key] ?? []) {
      claim(alias, key)
      exact.set(alias, key)
    }
  }
  const old = interpolatedKeys.flatMap((key) =>
    (aliases[key] ?? []).map((alias) => {
      claim(alias, key)
      const names = new Set(placeholdersOf(entries[key]!))
      const unknown = placeholdersOf(alias).filter((name) => !names.has(name))
      if (unknown.length > 0) {
        throw new Error(`persisted-messages: the alias ${JSON.stringify(alias)} of ${key} names {${unknown.join('}, {')}}, which its template does not have`)
      }
      return templatePattern(key, alias)
    })
  )
  const patterns = [...current, ...old]

  return (raw: string): PersistedMessage | null => {
    const code = CODE_RE.exec(raw)
    if (code) return codeMessage(entries, code[1]!, code[2])
    const key = exact.get(raw)
    if (key !== undefined) return { kind: 'message', key, params: {} }
    for (const { key: patternKey, re, names } of patterns) {
      const m = re.exec(raw)
      if (!m) continue
      const params: Record<string, string> = {}
      names.forEach((name, i) => {
        if (!Object.hasOwn(params, name)) params[name] = m[i + 1]!
      })
      return { kind: 'message', key: patternKey, params }
    }
    return null
  }
}

/**
 * What a stored string is: one of this version's messages (its English, an alias, or a code it knows) with its
 * values, a code this version cannot show, or null (no persisted message: shown as it is, like a library's own words).
 */
export const parsePersistedMessage: (raw: string) => PersistedMessage | null = buildPersistedMessageParser(
  en,
  DISPLAY_MAP_KEYS,
  INTERPOLATED_MAP_KEYS,
  PERSISTED_ALIASES
)

/** The key of a stored message (its English, an alias, or a code this version knows), else null. */
export function persistedMessageKey(raw: string | null | undefined): MessageKey | null {
  if (!raw) return null
  const message = parsePersistedMessage(raw)
  return message?.kind === 'message' ? message.key : null
}
