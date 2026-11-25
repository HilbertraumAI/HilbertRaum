import { en, type MessageKey } from './i18n'

// Persisted message values (app-update plan W-69, frozen contract F-26; T2.12). Main stores a fixed set of its own
// messages as canonical ENGLISH (documents.error_message, the fixed RAG answers in messages.content, the default
// titles, the benchmark warnings in settings: i18n record §3.3 rule 1, D-L4). This module says what a stored string is,
// for both processes: the renderer's display map (`renderer/lib/displayMap.ts`) shows it in the UI language, and main
// reads a stored message by its key where it acts on one (`scanDetected`, the default-title check, the slow-read upsert).
//
// Release 1 is the oldest version that will ever read a workspace, so what it does here can never be fixed in the field:
//  - `tests/fixtures/display-map/values.json` is the append-only history of every English value each key below was ever
//    stored as. A value that changes keeps its old text readable for ever through PERSISTED_ALIASES; a key release 1
//    acts on (marked `actedOn` there) is never reworded, since release 1 could not act on the new text.
//  - A string longer than MAX_STORED_LENGTH is no persisted message: shown as it is, never matched (R1 M-1).
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
 * When the English of a key above changes, the new value is appended to the key's history in the value fixture and
 * the old one to this table, in the same change (the fixture's test fails until both are). An exact key's alias is its
 * old text, with no placeholder; an interpolated key's alias is its old template, holding every `{name}` placeholder of
 * the current template (one more is harmless: it is not read), tried after every current template. The module refuses
 * to load with an alias that:
 *  - is another key's value or alias, or belongs to a key not above;
 *  - breaks the placeholder rule just named;
 *  - has the shape of a code (the code branch would answer first);
 *  - is longer than MAX_STORED_LENGTH (no stored row that long is ever read);
 *  - is a template with fewer than three letters of its own besides its placeholders (it would read nearly any string;
 *    a current template is refused the same way);
 *  - is plain text that an interpolated key's pattern, current or old, reads (it would take that key's rows; a current
 *    exact value is refused the same way). Two interpolated patterns that overlap are not detected (a recorded limit).
 *
 * Empty: no released value has ever changed (v0.1.8 to v0.1.66). The one old form not here is the pre-i18n
 * unsupported-type wording, a hand-written pattern in `renderer/lib/displayMap.ts` (its literal would trip the
 * copy-tone guard).
 *
 * The copy-tone guard (`tests/unit/copy-tone.test.ts`) fails on a retired phrase in any string literal of `src/`, and a
 * value is often reworded because its phrase was retired. Decided (T2.12, R2 M-7): when the first alias that holds a
 * phrase on that guard's list lands, the guard skips this table, in the same change, because an alias is never shown.
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
 * The longest stored string that can be a persisted message, in UTF-16 units (R1 M-1; part of F-26). A longer one is
 * shown as it is: the patterns never see it, so a crafted value cannot hold main for seconds (two lazy captures are
 * quadratic) or overflow the stack (a code of millions of characters). Today's longest English is under 400 units, so a
 * later writer's message or code fits with room for its values.
 */
const MAX_STORED_LENGTH = 4096

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

/** Whether `template` has text of its own once its placeholders are removed: at least three letters, so brackets or a
 *  dash around a placeholder (`({ext})`, `- {ext}`) never pass as a template that would read nearly any string. */
function hasOwnText(template: string): boolean {
  const literal = template.split(PLACEHOLDER_SPLIT_RE).filter((_part, i) => i % 2 === 0).join('')
  return (literal.match(/\p{L}/gu) ?? []).length >= 3
}

interface TemplatePattern {
  readonly key: MessageKey
  readonly re: RegExp
  /** The placeholder of each capture group, in template order. */
  readonly names: readonly string[]
  /** The placeholders the key's current template has: the only values a match reads. */
  readonly read: ReadonlySet<string>
}

/** A `^…$` pattern for `template`: the text escaped, each `{name}` a lazy capture. */
function templatePattern(key: MessageKey, template: string, read: ReadonlySet<string>): TemplatePattern {
  const names: string[] = []
  const source = template
    .split(PLACEHOLDER_SPLIT_RE)
    .map((part, i) => {
      if (i % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(part)
      return '(.+?)'
    })
    .join('')
  return { key, re: new RegExp(`^${source}$`), names, read }
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
 * the app uses from `en`, DISPLAY_MAP_KEYS, INTERPOLATED_MAP_KEYS and PERSISTED_ALIASES. Throws on every alias the
 * PERSISTED_ALIASES comment refuses, on a value two keys share, and on a current template with no text of its own:
 * each would make a stored value read as the wrong message, or as none.
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

  const refuse = (alias: string, key: MessageKey, why: string): never => {
    throw new Error(`persisted-messages: the alias ${JSON.stringify(alias)} of ${key} ${why}`)
  }
  const exact = new Map<string, MessageKey>()
  for (const key of exactKeys) {
    claim(entries[key]!, key)
    exact.set(entries[key]!, key)
  }
  const current = interpolatedKeys.map((key) => {
    const template = entries[key]!
    claim(template, key)
    if (!hasOwnText(template)) {
      throw new Error(
        `persisted-messages: the template ${JSON.stringify(template)} of ${key} has fewer than three letters of text of its own besides its placeholders`
      )
    }
    return templatePattern(key, template, new Set(placeholdersOf(template)))
  })
  const tooLong = `is longer than the ${MAX_STORED_LENGTH}-unit cap, so no stored row can match it`
  // Every exact text with its owner, so none can be one another key's pattern reads (R1 N-2: values and aliases).
  const exactTexts: Array<{ text: string; key: MessageKey; what: 'value' | 'alias' }> = exactKeys.map((key) => ({
    text: entries[key]!,
    key,
    what: 'value'
  }))
  for (const key of exactKeys) {
    for (const alias of aliases[key] ?? []) {
      claim(alias, key)
      if (alias.length > MAX_STORED_LENGTH) refuse(alias, key, tooLong)
      if (CODE_RE.test(alias)) refuse(alias, key, 'has the shape of a code')
      if (placeholdersOf(alias).length > 0) refuse(alias, key, 'holds a placeholder, and its key is an exact one')
      exact.set(alias, key)
      exactTexts.push({ text: alias, key, what: 'alias' })
    }
  }
  const old = interpolatedKeys.flatMap((key) =>
    (aliases[key] ?? []).map((alias) => {
      claim(alias, key)
      if (alias.length > MAX_STORED_LENGTH) refuse(alias, key, tooLong)
      if (CODE_RE.test(alias)) refuse(alias, key, 'has the shape of a code')
      if (!hasOwnText(alias)) refuse(alias, key, 'has fewer than three letters of text of its own besides its placeholders')
      const names = new Set(placeholdersOf(alias))
      const missing = placeholdersOf(entries[key]!).filter((name) => !names.has(name))
      if (missing.length > 0) refuse(alias, key, `lacks {${missing.join('}, {')}}, which its current template has`)
      return templatePattern(key, alias, new Set(placeholdersOf(entries[key]!)))
    })
  )
  const patterns = [...current, ...old]
  for (const { text, key, what } of exactTexts) {
    const taker = patterns.find(({ re }) => re.test(text))
    if (taker) {
      throw new Error(`persisted-messages: the ${what} ${JSON.stringify(text)} of ${key} is text the pattern of ${taker.key} reads`)
    }
  }

  return (raw: string): PersistedMessage | null => {
    if (raw.length > MAX_STORED_LENGTH) return null
    const code = CODE_RE.exec(raw)
    if (code) return codeMessage(entries, code[1]!, code[2])
    const key = exact.get(raw)
    if (key !== undefined) return { kind: 'message', key, params: {} }
    for (const { key: patternKey, re, names, read } of patterns) {
      const m = re.exec(raw)
      if (!m) continue
      const params: Record<string, string> = {}
      names.forEach((name, i) => {
        if (read.has(name) && !Object.hasOwn(params, name)) params[name] = m[i + 1]!
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
