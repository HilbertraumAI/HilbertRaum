import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'
import { en, t, UI_LANGUAGE_CODES, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import {
  DISPLAY_MAP_KEYS,
  INTERPOLATED_MAP_KEYS,
  classifyServerCopy,
  displayMapKey,
  formatCitationLabel,
  localizeServerCopy,
  unsupportedTypeExt
} from '../../src/renderer/lib/displayMap'
import {
  PERSISTED_ALIASES,
  buildPersistedMessageParser,
  parsePersistedMessage
} from '../../src/shared/persisted-messages'
import { DESKTOP_ROOT, filesUnder } from '../helpers/repo-files'
import {
  GROUNDED_SYSTEM_PROMPT,
  NO_DOCUMENT_CONTEXT_ANSWER,
  REINDEX_NEEDED_ANSWER
} from '../../src/main/services/rag'
import { DOC_TASK_BUSY_MESSAGE } from '../../src/shared/types'

// Phase 41 — the D-L4 display map: persisted main-process strings are canonical
// English in the DB; the renderer translates the KNOWN finite set at display time by
// exact match. Unknown strings (raw library errors, interpolated copy) pass through.

const tDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)
const tEn = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

/** A value for each param of each interpolated persist-canonical message (the set is pinned below). */
const INTERPOLATED_PARAMS: Partial<Record<MessageKey, MessageParams>> = {
  'main.ingest.unsupportedType': { ext: '.xyz' },
  'main.benchmark.warnVeryLowTokens': { model: 'qwen3-30b-a3b-q4' },
  // #110: the slow-read warning carries the measured effective MB/s.
  'main.benchmark.warnSlowRead': { mbps: 70 },
  // §6.5 (issue #95): the recommendation-lowered warning carries TWO values.
  'main.benchmark.warnRecommendationLowered': { tps: 2.2, model: 'qwen3.6-27b-q4' },
  // #530: the engine cannot run — the one value is the library's file NAME (never a path).
  'main.ingest.engineLibraryMissing': { library: 'libgomp.so.1' }
}

describe('localizeServerCopy (D-L4)', () => {
  it('translates a known persisted constant to German', () => {
    expect(localizeServerCopy(tDe, NO_DOCUMENT_CONTEXT_ANSWER)).toBe(t('de', 'main.rag.noContext'))
    expect(localizeServerCopy(tDe, REINDEX_NEEDED_ANSWER)).toBe(t('de', 'main.rag.reindexNeeded'))
  })

  it('matches an old pre-i18n row byte-for-byte (the re-typed literal, not the catalog)', () => {
    // The exact string Phase-4-era ingestion persisted — typed out, NOT derived from
    // the catalog. If an en.ts edit ever moves the value, this stops matching and
    // fails loudly (the catalog comment declares the set part of the data contract).
    const preI18nRow = 'This PDF looks like a scan — it has no readable text yet.'
    expect(localizeServerCopy(tDe, preI18nRow)).toBe(t('de', 'main.ingest.pdfScanDetected'))
  })

  it('renders unknown strings as-is', () => {
    const raw = 'SQLITE_IOERR: disk I/O error'
    expect(localizeServerCopy(tDe, raw)).toBe(raw)
  })

  it('localizes the interpolated unsupported-file-type failure, keeping the extension', () => {
    // The current persist-canonical English (interpolated) round-trips to German with {ext}.
    const persisted = tEn('main.ingest.unsupportedType', { ext: '.xyz' })
    const localized = localizeServerCopy(tDe, persisted)
    expect(localized).toBe(tDe('main.ingest.unsupportedType', { ext: '.xyz' }))
    expect(localized).toContain('.xyz')
    expect(localized).not.toBe(persisted) // genuinely translated, not passed through
    // English UI re-renders the same friendly English (identity round-trip).
    expect(localizeServerCopy(tEn, persisted)).toBe(persisted)
  })

  it('localizes an OLD pre-i18n unsupported-type row (legacy literal), keeping the extension', () => {
    const legacy = 'Unsupported file type: .heic'
    expect(localizeServerCopy(tDe, legacy)).toBe(tDe('main.ingest.unsupportedType', { ext: '.heic' }))
    expect(unsupportedTypeExt(legacy)).toBe('.heic')
  })

  it('unsupportedTypeExt returns null for an unrelated failure', () => {
    expect(unsupportedTypeExt('SQLITE_IOERR: disk I/O error')).toBeNull()
    expect(unsupportedTypeExt(tEn('main.ingest.fileTooLarge'))).toBeNull()
  })

  it('is the identity in an English UI', () => {
    expect(localizeServerCopy(tEn, NO_DOCUMENT_CONTEXT_ANSWER)).toBe(NO_DOCUMENT_CONTEXT_ANSWER)
    expect(localizeServerCopy(tEn, 'anything else')).toBe('anything else')
  })

  it('localizes DOC_TASK_BUSY_MESSAGE even when embedded in transport prose (the includes contract)', () => {
    expect(localizeServerCopy(tDe, DOC_TASK_BUSY_MESSAGE)).toBe(t('de', 'main.chat.docTaskBusy'))
    const wrapped = `Error: ${DOC_TASK_BUSY_MESSAGE}`
    expect(localizeServerCopy(tDe, wrapped)).toBe(`Error: ${t('de', 'main.chat.docTaskBusy')}`)
  })

  it('translates the persisted benchmark warnings', () => {
    const warning =
      'This drive is on the slower side. Models will still work, but loading them may take longer.'
    expect(localizeServerCopy(tDe, warning)).toBe(t('de', 'main.benchmark.warnSlowDrive'))
  })

  it('translates the persisted default conversation title; real user titles pass through', () => {
    expect(localizeServerCopy(tDe, 'New chat')).toBe(t('de', 'main.chat.defaultTitle'))
    expect(localizeServerCopy(tDe, 'Summarize this contract please')).toBe(
      'Summarize this contract please'
    )
  })

  it('covers exactly the en.ts persist-canonical section (catalog hygiene, Phase 42)', () => {
    // This list mirrors the PERSIST-CANONICAL section of en.ts (the data-contract
    // comment there). A new persisted constant must land in BOTH places — here and in
    // DISPLAY_MAP_KEYS — or this fails loudly.
    const persistCanonical: MessageKey[] = [
      'main.ingest.pdfScanDetected',
      'main.ingest.audioNeedsTranscriber',
      // #527: the audio failure names the missing piece (engine / both / no engine build here).
      'main.ingest.audioNeedsEngine',
      'main.ingest.audioNeedsModelAndEngine',
      'main.ingest.audioEngineUnsupported',
      'main.ingest.audioUnreadable',
      'main.ingest.audioTranscriptionFailed',
      // #530: the OS refused to start the AI engine / the voice engine — canonical, path-free.
      'main.ingest.engineCannotRun',
      'main.ingest.voiceEngineCannotRun',
      // #869: the speech model's file name cannot be read by the voice engine on Windows — path-free.
      'main.ingest.voiceModelPathUnsupported',
      // #1012: an engine file could not be read just now (an audio import's row) — the notice's own text.
      'main.engine.filesUnreadable',
      // #634: the search model timed out, could not start, or failed — canonical, path-free.
      'main.ingest.searchModelTimeout',
      'main.ingest.searchModelCannotStart',
      'main.ingest.searchModelFailed',
      'main.ingest.imageNeedsOcr',
      'main.ingest.imageNoText',
      'main.ingest.imageOcrFailed',
      // #232: the interim "stored without recognition" note.
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
      // EP-1 Phase 1: the fallback review title (evidence_reviews.title when a
      // conversation title trims empty) — persist-canonical English, like defaultTitle.
      'main.evidenceReviews.defaultTitle',
      'main.benchmark.warnTiny',
      'main.benchmark.warnUnknown',
      'main.benchmark.warnDriveProbe',
      'main.benchmark.warnSlowDrive',
      // #185: the tokens/sec probe was discarded because another lane held the model — a
      // persisted `lastBenchmark.warnings` entry like its siblings, and uninterpolated.
      'main.benchmark.warnSpeedSkipped'
    ]
    expect([...DISPLAY_MAP_KEYS].sort()).toEqual(persistCanonical.sort())
    // Every mapped English value must round-trip to its German catalog value.
    for (const key of persistCanonical) {
      expect(localizeServerCopy(tDe, t('en', key)), key).toBe(t('de', key))
    }
  })

  // ---- Citation markers (#28 / beta-feedback plan Phase 1, D68) ----
  // The inline `[S{n}]` marker is a machine contract (baked into the prompt, persisted in
  // citations_json). It is relabelled at DISPLAY time only: DE shows [Q{n}] ("Quelle"), EN keeps
  // [S{n}] byte-identically. A literal marker inside code stays verbatim (mirrors the math guard).

  it('rewrites inline [S{n}] body markers to [Q{n}] in a German UI', () => {
    expect(localizeServerCopy(tDe, 'See [S1] and [S2] for the clause.')).toBe(
      'See [Q1] and [Q2] for the clause.'
    )
  })

  it('leaves inline citation markers byte-identical in an English UI', () => {
    const raw = 'See [S1] and [S2] for the clause.'
    expect(localizeServerCopy(tEn, raw)).toBe(raw)
  })

  it('keeps a literal [S1] inside an inline code span verbatim in a German UI', () => {
    // The code span is not prose — its `[S1]` is a literal, not a citation, so it must not move.
    const raw = 'Prose cites [S1], but the token `[S1]` in code stays literal.'
    expect(localizeServerCopy(tDe, raw)).toBe(
      'Prose cites [Q1], but the token `[S1]` in code stays literal.'
    )
  })

  it('keeps a literal [S1] inside a fenced code block verbatim in a German UI', () => {
    const raw = 'Real cite [S2].\n```\nlog[S1] = value\n```\nAfter [S3].'
    expect(localizeServerCopy(tDe, raw)).toBe('Real cite [Q2].\n```\nlog[S1] = value\n```\nAfter [Q3].')
  })

  it('does not touch bracketed prose that is not an S-marker (needs digits)', () => {
    expect(localizeServerCopy(tDe, 'The [START] tag and [Section] head.')).toBe(
      'The [START] tag and [Section] head.'
    )
  })

  it('formatCitationLabel maps the stored S{n} label per language; identity in EN', () => {
    expect(formatCitationLabel(tDe, 'S1')).toBe('Q1')
    expect(formatCitationLabel(tDe, 'S12')).toBe('Q12')
    expect(formatCitationLabel(tEn, 'S1')).toBe('S1')
    // A non-standard label passes through unchanged (defensive).
    expect(formatCitationLabel(tDe, 'weird')).toBe('weird')
  })

  it('D68 machine contract: the grounded system prompt still instructs the model to emit [S1]', () => {
    // The display rename must NOT leak into the prompt — the model still emits the S-marker, and
    // the renderer relabels it. This pins that GROUNDING_RULES is untouched by Phase 1.
    expect(GROUNDED_SYSTEM_PROMPT).toContain('[S1]')
    expect(GROUNDED_SYSTEM_PROMPT).not.toContain('[Q1]')
  })

  it('covers the interpolated persist-canonical set (handled by regex, not exact match)', () => {
    // Interpolated messages carry a value in the persisted string, so they live in
    // INTERPOLATED_MAP_KEYS (reverse-matched by a template regex) rather than DISPLAY_MAP_KEYS.
    // A new interpolated constant must land here with its params — or this fails loudly.
    const params = INTERPOLATED_PARAMS
    expect([...INTERPOLATED_MAP_KEYS].sort()).toEqual(Object.keys(params).sort())
    for (const key of INTERPOLATED_MAP_KEYS) {
      const persisted = t('en', key, params[key])
      // German UI: genuinely translated with the param carried over.
      expect(localizeServerCopy(tDe, persisted), key).toBe(t('de', key, params[key]))
      // English UI: identity round-trip.
      expect(localizeServerCopy(tEn, persisted), key).toBe(persisted)
    }
  })

  it('keeps the measured-model id verbatim inside the localized very-low-tokens warning (issue #52)', () => {
    const persisted = tEn('main.benchmark.warnVeryLowTokens', { model: 'qwen3.5-4b-ud-q4kxl' })
    const localized = localizeServerCopy(tDe, persisted)
    expect(localized).toBe(tDe('main.benchmark.warnVeryLowTokens', { model: 'qwen3.5-4b-ud-q4kxl' }))
    expect(localized).toContain('qwen3.5-4b-ud-q4kxl')
    expect(localized).not.toBe(persisted)
  })

  it('carries BOTH values of the recommendation-lowered warning across the round-trip (§6.5)', () => {
    // The two-parameter template: capture groups follow the ENGLISH template order (tps,
    // then model); German re-interpolates by name, so its different order is fine.
    const persisted = tEn('main.benchmark.warnRecommendationLowered', {
      tps: 2.2,
      model: 'qwen3.6-27b-q4'
    })
    const localized = localizeServerCopy(tDe, persisted)
    expect(localized).toBe(
      tDe('main.benchmark.warnRecommendationLowered', { tps: '2.2', model: 'qwen3.6-27b-q4' })
    )
    expect(localized).toContain('2.2') // String(value) interpolation — no locale reformat
    expect(localized).toContain('qwen3.6-27b-q4')
    expect(localized).not.toBe(persisted)
  })
})

// #807: the classifier says whether the display map KNEW the raw text — every branch (the exact map,
// each interpolated family incl. the legacy unsupported-type wording, the doc-task-busy substring)
// is known; only the pass-through is not. A failed document row and the chat attach banner show
// the not-known text under a translated lead, so a branch that loses its verdict shows the lead
// over the app's own (translated) message, and one that gains it hides the lead from a parser error.
describe('classifyServerCopy: which raw text the map knew (#807)', () => {
  /** [branch, raw, the German display text]. */
  const known: Array<[string, string, string]> = [
    ...DISPLAY_MAP_KEYS.map((key): [string, string, string] => [`exact map: ${key}`, t('en', key), t('de', key)]),
    ...INTERPOLATED_MAP_KEYS.map((key): [string, string, string] => [
      `interpolated: ${key}`,
      t('en', key, INTERPOLATED_PARAMS[key]),
      t('de', key, INTERPOLATED_PARAMS[key])
    ]),
    ['legacy unsupported type', 'Unsupported file type: .heic', tDe('main.ingest.unsupportedType', { ext: '.heic' })],
    ['doc-task busy, embedded', `Error: ${DOC_TASK_BUSY_MESSAGE}`, `Error: ${t('de', 'main.chat.docTaskBusy')}`]
  ]
  it.each(known)('%s is known', (_branch, raw, text) => {
    expect(classifyServerCopy(tDe, raw)).toEqual({ text, recognized: true })
  })

  it.each([
    ['a library error', 'Invalid PDF structure.', 'Invalid PDF structure.'],
    // The pass-through still localizes a model answer's citation marker; it stays not known.
    ['a model answer', 'See [S1].', 'See [Q1].']
  ])('%s is not known, and passes through', (_what, raw, text) => {
    expect(classifyServerCopy(tDe, raw)).toEqual({ text, recognized: false })
  })
})

// The map goes English → key → the UI language, so it serves every registered language with no
// per-language table. A persisted row reads as the UI language's catalog says, and a model
// answer's citation marker takes the language's display letter (the stored [S{n}] never changes).
describe('localizeServerCopy in every registered language (D-L4)', () => {
  it.each(UI_LANGUAGE_CODES.filter((code) => code !== 'en'))(
    '%s: every persisted English message reads in the UI language, and [S1] takes its marker',
    (code) => {
      const tLang = (key: MessageKey, params?: MessageParams): string => t(code, key, params)
      const persisted = [
        ...DISPLAY_MAP_KEYS.map((key) => ({ key, params: undefined })),
        ...INTERPOLATED_MAP_KEYS.map((key) => ({ key, params: INTERPOLATED_PARAMS[key] }))
      ]
      const wrong = persisted.filter(
        ({ key, params }) => localizeServerCopy(tLang, t('en', key, params)) !== t(code, key, params)
      )
      expect(wrong.map(({ key }) => key)).toEqual([])
      expect(localizeServerCopy(tLang, 'See [S1].')).toBe(`See [${t(code, 'chat.sources.marker', { n: '1' })}].`)
    }
  )
})

// ---- T2.12 (W-69, F-26): persisted message values and the coded form ----------------------------
// Release 1 is the oldest version that will ever read a workspace, so what it makes of a stored message can never be
// fixed in the field. tests/fixtures/display-map/values.json holds the English each display-mapped message is stored
// as (v0.1.66's released catalog; `main.engine.filesUnreadable` from #1012, after it), locked by the golden manifest.
// A later version may store the coded form instead: `hr:<key>`, plus `?<name>=<value>&…` (each value
// percent-encoded) for the placeholders of the key's English template.

const VALUES_FIXTURE = join(__dirname, '..', 'fixtures', 'display-map', 'values.json')
const valuesFixture = JSON.parse(readFileSync(VALUES_FIXTURE, 'utf8')) as {
  frozenAt: string | null
  values: Record<string, string>
}

/** A stored row written from `template`: each `{name}` filled with a sample, and the params that fill it. */
function rowFrom(template: string): { text: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  const text = template.replace(/\{(\w+)\}/g, (_m, name: string) => (params[name] = `x-${name}`))
  return { text, params }
}

/** The coded form of `key` with `params`, as a later version would store it. */
function coded(key: string, params: MessageParams = {}): string {
  const query = Object.entries(params)
    .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
    .join('&')
  return query ? `hr:${key}?${query}` : `hr:${key}`
}

describe('the English a message is stored as never stops reading as its key (F-26)', () => {
  it('the value fixture holds exactly the display-mapped keys', () => {
    expect(Object.keys(valuesFixture.values).sort()).toEqual([...DISPLAY_MAP_KEYS, ...INTERPOLATED_MAP_KEYS].sort())
  })

  it('every stored value is the current English or an alias, and still reads as its key with its values', () => {
    const problems = Object.entries(valuesFixture.values).flatMap(([key, stored]): string[] => {
      const current = (en as Record<string, string>)[key]
      const aliases: readonly string[] = PERSISTED_ALIASES[key as MessageKey] ?? []
      if (current !== stored && !aliases.includes(stored)) {
        const editFixture =
          valuesFixture.frozenAt === null
            ? ' or, only before the release-1 tag, put the new value into tests/fixtures/display-map/values.json and its sha256 into tests/fixtures/golden-fixtures.sha256'
            : ` (the fixture is frozen at ${valuesFixture.frozenAt}, so the alias is the only fix)`
        return [
          `${key}: stored rows hold ${JSON.stringify(stored)}, en.ts now says ${JSON.stringify(current)}. ` +
            `Fix: add ${JSON.stringify(stored)} to PERSISTED_ALIASES['${key}'] in src/shared/persisted-messages.ts,${editFixture}.`
        ]
      }
      const row = rowFrom(stored)
      const read = parsePersistedMessage(row.text)
      return read?.kind === 'message' && read.key === key && JSON.stringify(read.params) === JSON.stringify(row.params)
        ? []
        : [`${key}: a row stored as ${JSON.stringify(row.text)} reads as ${JSON.stringify(read)}`]
    })
    expect(problems).toEqual([])
  })
})

describe('a stored code this version knows reads as its key (F-26)', () => {
  it.each([
    ...DISPLAY_MAP_KEYS.map((key) => ({ key, params: undefined })),
    ...INTERPOLATED_MAP_KEYS.map((key) => ({ key, params: INTERPOLATED_PARAMS[key] }))
  ])('$key', ({ key, params }) => {
    const raw = coded(key, params)
    expect(classifyServerCopy(tDe, raw)).toEqual({ text: t('de', key, params), recognized: true })
    expect(displayMapKey(raw)).toBe(key)
  })

  it('names any key of this version’s catalog, reads in an English UI, and percent-decodes its values', () => {
    expect(classifyServerCopy(tDe, 'hr:common.cancel')).toEqual({ text: t('de', 'common.cancel'), recognized: true })
    expect(localizeServerCopy(tEn, 'hr:main.rag.noContext')).toBe(en['main.rag.noContext'])
    // %2E is ".", %C3%A4 is "ä", %20 is a space.
    expect(localizeServerCopy(tDe, 'hr:main.ingest.unsupportedType?ext=%2Ehe%C3%A4c%20x')).toBe(
      tDe('main.ingest.unsupportedType', { ext: '.heäc x' })
    )
  })
})

describe('a stored code this version does not know reads as the newer-version line (F-26, C02)', () => {
  it.each(['en', 'de'] as const)('%s: the line in the UI language, not the code; not recognized, so a failed row keeps its lead', (lang) => {
    const tLang = (key: MessageKey, params?: MessageParams): string => t(lang, key, params)
    const raw = 'hr:main.future.unknownThing'
    expect(classifyServerCopy(tLang, raw)).toEqual({ text: t(lang, 'common.newerVersionText'), recognized: false })
    expect(displayMapKey(raw)).toBeNull()
  })
})

describe('an old value kept in the alias table reads as its key (F-26)', () => {
  const OLD_ANSWER = 'An older wording of the not-found answer.'
  const OLD_TYPE = 'An older wording of the file type failure ({ext}).'

  it('the parser built with one more alias reads the old value, an old template with its value, and the current ones', () => {
    const parse = buildPersistedMessageParser(en, DISPLAY_MAP_KEYS, INTERPOLATED_MAP_KEYS, {
      'main.rag.noContext': [OLD_ANSWER],
      'main.ingest.unsupportedType': [OLD_TYPE]
    })
    expect(parse(OLD_ANSWER)).toEqual({ kind: 'message', key: 'main.rag.noContext', params: {} })
    expect(parse('An older wording of the file type failure (.heic).')).toEqual({
      kind: 'message',
      key: 'main.ingest.unsupportedType',
      params: { ext: '.heic' }
    })
    expect(parse(en['main.rag.noContext'])).toEqual({ kind: 'message', key: 'main.rag.noContext', params: {} })
    expect(parse(t('en', 'main.ingest.unsupportedType', { ext: '.xyz' }))).toEqual({
      kind: 'message',
      key: 'main.ingest.unsupportedType',
      params: { ext: '.xyz' }
    })
    // The app's own table is empty (no released value has ever changed), so its parser does not know the made-up one.
    expect(parsePersistedMessage(OLD_ANSWER)).toBeNull()
  })

  it.each<[string, Partial<Record<MessageKey, readonly string[]>>]>([
    ['equals another key’s current value', { 'main.rag.noContext': [en['main.rag.reindexNeeded']] }],
    ['equals another key’s alias', { 'main.rag.noContext': ['An old line.'], 'main.rag.reindexNeeded': ['An old line.'] }],
    ['names a value the current template does not have', { 'main.ingest.unsupportedType': ['Old ({extension}).'] }],
    ['belongs to a key the map does not hold', { 'common.cancel': ['Abort'] }]
  ])('refuses, when the module loads, an alias that %s', (_why, aliases) => {
    expect(() => buildPersistedMessageParser(en, DISPLAY_MAP_KEYS, INTERPOLATED_MAP_KEYS, aliases)).toThrow(/alias/)
  })
})

describe('what is a code is decided on the whole string (F-26)', () => {
  it.each([
    ['the bare prefix', 'hr:'],
    ['a space after the prefix', 'hr: main.rag.noContext'],
    ['an upper-case prefix', 'HR:main.rag.noContext'],
    ['a trailing space', 'hr:main.rag.noContext '],
    ['a leading space', ' hr:main.rag.noContext'],
    ['a trailing newline', 'hr:main.rag.noContext\n'],
    ['a key without a dot', 'hr:main'],
    ['an inherited member’s name (no dot)', 'hr:constructor'],
    ['a key that starts with an underscore', 'hr:__proto__'],
    ['a code followed by more text', 'hr:main.rag.noContext and more'],
    ['a code inside a sentence', 'The stored text was hr:main.rag.noContext here.'],
    ['an empty parameter list', 'hr:main.rag.noContext?'],
    ['a parameter without a value', 'hr:main.ingest.unsupportedType?ext'],
    ['a space in a value', 'hr:main.ingest.unsupportedType?ext=.a b'],
    ['an upper-case parameter name', 'hr:main.ingest.unsupportedType?Ext=.xyz']
  ])('not a code (%s): shown as it is, like any text the map does not know', (_what, raw) => {
    expect(classifyServerCopy(tDe, raw)).toEqual({ text: raw, recognized: false })
    expect(displayMapKey(raw)).toBeNull()
  })

  it.each([
    ['a key this catalog does not have', 'hr:main.future.unknownThing'],
    ['an inherited member’s name with a dot', 'hr:constructor.prototype'],
    ['another inherited member’s name with a dot', 'hr:toString.call'],
    ['a missing placeholder', 'hr:main.ingest.unsupportedType'],
    ['one of two placeholders missing', 'hr:main.benchmark.warnRecommendationLowered?tps=2.2'],
    ['a parameter given twice', 'hr:main.ingest.unsupportedType?ext=.a&ext=.b'],
    ['a lone percent sign', 'hr:main.ingest.unsupportedType?ext=%'],
    ['a percent escape that is not hex', 'hr:main.ingest.unsupportedType?ext=%zz'],
    ['a cut-off UTF-8 sequence', 'hr:main.ingest.unsupportedType?ext=%E0%A4%A']
  ])('a well-formed code this version cannot show (%s) reads as the newer-version line', (_what, raw) => {
    expect(classifyServerCopy(tDe, raw)).toEqual({ text: t('de', 'common.newerVersionText'), recognized: false })
    expect(displayMapKey(raw)).toBeNull()
  })

  it.each([
    ['an extra parameter', 'hr:main.ingest.unsupportedType?ext=.xyz&from=v2'],
    ['an extra parameter named like an inherited member', 'hr:main.ingest.unsupportedType?constructor=x&ext=.xyz']
  ])('%s is ignored', (_what, raw) => {
    expect(classifyServerCopy(tDe, raw)).toEqual({ text: tDe('main.ingest.unsupportedType', { ext: '.xyz' }), recognized: true })
  })
})

// D-9: F-26 is a reader duty. A row this version stored as a code would show raw in v0.1.66 and older, so nothing in
// main or shared writes one: no string literal there starts with the prefix (the TypeScript AST, so a comment is no use).
describe('this version never writes a code (F-26, D-9)', () => {
  it('no string literal in src/main or src/shared starts with the code prefix', () => {
    const prefix = ['hr', ':'].join('') // not written whole, so a scan that ever reads tests/ cannot match this file
    const files = [
      ...filesUnder(join(DESKTOP_ROOT, 'src', 'main'), /\.tsx?$/),
      ...filesUnder(join(DESKTOP_ROOT, 'src', 'shared'), /\.tsx?$/)
    ]
    expect(files.length).toBeGreaterThan(100)
    const offenders: string[] = []
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) &&
          node.text.startsWith(prefix)
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          offenders.push(`${relative(DESKTOP_ROOT, file)}:${line + 1}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(offenders).toEqual([])
  })
})
