import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'
import {
  cldrPlural,
  de,
  en,
  resolveUiLanguage,
  t,
  tCount,
  uiLanguageInfo,
  UI_LANGUAGE_CODES,
  UI_LANGUAGES,
  type MessageKey,
  type PluralCategory,
  type UiLanguage,
  type UiLanguageInfo
} from '../../src/shared/i18n'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { catalogOf, isCatalogPath } from '../helpers/i18n-catalogs'

// Phase 39 — the shared i18n module (i18n record §3.1, D-L1/D-L2/D-L8): synchronous
// lookup, {name} interpolation, .one/.other plurals, English fallback, and the
// 'system' → locale resolution the setting + the pre-unlock gate both use.

describe('t — lookup and interpolation', () => {
  it('looks up plain keys per language', () => {
    // Rail labels are now plain words — no soft hyphens (Task A: the rail never breaks a label
    // mid-word; the grid column is widened to fit instead). See the rail-labels guard below.
    expect(t('en', 'nav.documents')).toBe('Documents')
    expect(t('de', 'nav.documents')).toBe('Dokumente')
    expect(t('en', 'gate.unlock.title')).toBe('Unlock your workspace')
    expect(t('de', 'gate.unlock.title')).toBe('Arbeitsbereich entsperren')
  })

  it('interpolates {name} params in both languages', () => {
    expect(t('en', 'home.docsReady.other', { count: 3 })).toBe(
      '3 documents ready to ask about'
    )
    expect(t('de', 'home.docsReady.other', { count: 3 })).toBe(
      '3 Dokumente bereit für deine Fragen'
    )
  })

  it('falls back to the raw key for an unknown key (runtime guard; typecheck prevents real ones)', () => {
    expect(t('en', 'no.such.key' as MessageKey)).toBe('no.such.key')
    expect(t('de', 'no.such.key' as MessageKey)).toBe('no.such.key')
  })

  it.each(['toString', '__proto__'])(
    'takes the same unknown-key path for a key naming an inherited member (%s), never a crash',
    (key) => {
      // A plain `catalog[key]` read finds Object.prototype's member there and hands it to the
      // interpolation as if it were a template ("template.replace is not a function").
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        for (const lang of UI_LANGUAGE_CODES) {
          expect(t(lang, key as MessageKey)).toBe(key)
          expect(warn).toHaveBeenLastCalledWith(`[i18n] unknown message key '${key}'`)
        }
      } finally {
        warn.mockRestore()
      }
    }
  )

  it('falls back to the English string when a param is missing in a non-English render', () => {
    // The unresolved placeholder stays literal — visible in dev, never a crash.
    expect(t('de', 'home.docsReady.other')).toBe('{count} documents ready to ask about')
  })

  it('U1/ux-10: the extract coverage badge is softened from "Every match found" (overclaim) to "Read"', () => {
    // "Every match found" asserted the EXTRACTION was exhaustive — a small model / unusual layout can miss
    // a match. The honest claim is that every section was READ (or scanned, the label-first
    // "Sections scanned: 3" of #806), not that every match was captured.
    for (const key of ['coverage.extract.whole', 'coverage.extract.sections'] as MessageKey[]) {
      // Supply the {scanned} param so the REAL German renders — without it, a missing param makes `t('de')`
      // fall back to English, and the negative assertion would inspect English (vacuously passing).
      expect(t('en', key, { scanned: 3 })).not.toMatch(/every match/i)
      expect(t('en', key, { scanned: 3 })).toMatch(/\b(read|scanned)\b/i)
      expect(t('de', key, { scanned: 3 })).not.toMatch(/jeder treffer/i)
      expect(t('de', key, { scanned: 3 })).toMatch(/gelesen|durchsucht/i)
    }
  })
})

describe('tCount — .one/.other plural pairs (n === 1 rule)', () => {
  it('selects the singular variant only for exactly 1', () => {
    expect(tCount('en', 'home.docsReady', 1)).toBe('1 document ready to ask about')
    expect(tCount('en', 'home.docsReady', 0)).toBe('0 documents ready to ask about')
    expect(tCount('en', 'home.docsReady', 2)).toBe('2 documents ready to ask about')
    expect(tCount('de', 'home.docsReady', 1)).toBe('1 Dokument bereit für deine Fragen')
    expect(tCount('de', 'home.docsReady', 5)).toBe('5 Dokumente bereit für deine Fragen')
  })

  it('CODE-8: the five previously non-pluralized strings decline correctly at 1 and 2 (EN + DE)', () => {
    // full-audit 2026-07-11 CODE-8 — the DE singular carries the adjective ending
    // („1 fehlgeschlagenES Dokument"), which is why these are catalog pairs, not code.
    expect(tCount('en', 'docs.retryAllConfirm.title', 1)).toBe('Retry 1 failed document?')
    expect(tCount('en', 'docs.retryAllConfirm.title', 2)).toBe('Retry 2 failed documents?')
    expect(tCount('de', 'docs.retryAllConfirm.title', 1)).toBe(
      '1 fehlgeschlagenes Dokument erneut versuchen?'
    )
    expect(tCount('de', 'docs.retryAllConfirm.title', 2)).toBe(
      '2 fehlgeschlagene Dokumente erneut versuchen?'
    )

    expect(tCount('en', 'docs.reindexAllConfirm.title', 1)).toBe('Re-index 1 document?')
    expect(tCount('en', 'docs.reindexAllConfirm.title', 2)).toBe('Re-index 2 documents?')
    expect(tCount('de', 'docs.reindexAllConfirm.title', 1)).toBe('1 Dokument neu indexieren?')
    expect(tCount('de', 'docs.reindexAllConfirm.title', 2)).toBe('2 Dokumente neu indexieren?')

    expect(tCount('en', 'docs.reindexAllDone', 1)).toBe('Re-indexed 1 document.')
    expect(tCount('en', 'docs.reindexAllDone', 2)).toBe('Re-indexed 2 documents.')
    expect(tCount('de', 'docs.reindexAllDone', 1)).toBe('1 Dokument neu indexiert.')
    expect(tCount('de', 'docs.reindexAllDone', 2)).toBe('2 Dokumente neu indexiert.')

    expect(tCount('en', 'chat.sources.wholeDoc', 1)).toBe('Drawn from the document — 1 section')
    expect(tCount('en', 'chat.sources.wholeDoc', 2)).toBe('Drawn from the document — 2 sections')
    expect(tCount('de', 'chat.sources.wholeDoc', 1)).toBe('Aus dem Dokument entnommen — 1 Abschnitt')
    expect(tCount('de', 'chat.sources.wholeDoc', 2)).toBe('Aus dem Dokument entnommen — 2 Abschnitte')

    expect(tCount('en', 'chat.sources.more', 1)).toBe('and 1 more section')
    expect(tCount('en', 'chat.sources.more', 2)).toBe('and 2 more sections')
    // DE: „weiterER Abschnitt" (starke Flexion im Singular) vs „weiterE Abschnitte".
    expect(tCount('de', 'chat.sources.more', 1)).toBe('und 1 weiterer Abschnitt')
    expect(tCount('de', 'chat.sources.more', 2)).toBe('und 2 weitere Abschnitte')
  })

  it('a single-core machine reads "(1 core)" in the benchmark CPU row (EN + DE)', () => {
    // UI-languages owner call D-11 (a): until the UI languages wave `diag.bench.cores` was a plain
    // key on the CODE-8 list, so one core read "(1 cores)" / "(1 Kerne)" on the Diagnostics card,
    // the Performance memory tile and both Copy reports.
    expect(tCount('en', 'diag.bench.cores', 1)).toBe(' (1 core)')
    expect(tCount('en', 'diag.bench.cores', 8)).toBe(' (8 cores)')
    expect(tCount('de', 'diag.bench.cores', 1)).toBe(' (1 Kern)')
    expect(tCount('de', 'diag.bench.cores', 8)).toBe(' (8 Kerne)')
  })
})

describe('missing-interpolation dev-warning (CODE-45)', () => {
  it('warns on a missing param in ENGLISH too (used to be non-EN-only)', () => {
    // full-audit 2026-07-11 CODE-45: on the EN dev/CI default a forgotten param shipped a
    // literal '{name}' with no diagnostic. The render itself is unchanged (placeholder
    // stays visibly literal, never a crash).
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(t('en', 'home.docsReady.other')).toBe('{count} documents ready to ask about')
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("missing param for 'home.docsReady.other' (en)")
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('a fully-parameterized EN render stays silent', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(t('en', 'home.docsReady.other', { count: 3 })).toBe('3 documents ready to ask about')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveUiLanguage (D-L2)', () => {
  it('an explicit choice always wins over the OS locale', () => {
    expect(resolveUiLanguage('en', 'de-DE')).toBe('en')
    expect(resolveUiLanguage('de', 'en-US')).toBe('de')
  })

  it("'system' resolves a registered language's locale to that language, everything else to English", () => {
    expect(resolveUiLanguage('system', 'de')).toBe('de')
    expect(resolveUiLanguage('system', 'de-DE')).toBe('de')
    expect(resolveUiLanguage('system', 'de-AT')).toBe('de')
    expect(resolveUiLanguage('system', 'de_CH')).toBe('de')
    expect(resolveUiLanguage('system', 'DE-DE')).toBe('de')
    expect(resolveUiLanguage('system', 'en-US')).toBe('en')
    expect(resolveUiLanguage('system', 'es-MX')).toBe('es')
    expect(resolveUiLanguage('system', 'fr-FR')).toBe('fr')
    expect(resolveUiLanguage('system', 'it-IT')).toBe('it')
    expect(resolveUiLanguage('system', 'ru-RU')).toBe('ru')
    expect(resolveUiLanguage('system', 'pt-BR')).toBe('en')
    // Another language whose tag merely shares a first letter with 'de' is not German.
    expect(resolveUiLanguage('system', 'dv')).toBe('en')
  })

  // The second languages wave: Dutch, Polish, Turkish and Ukrainian follow an OS locale with a
  // region, Belgian Dutch included. Ukrainian is `uk`; `ua` is Ukraine's country code, not a
  // language, and the ISO 639-2 codes are no alias (`ukr` and `nld` even begin with a registered
  // code; `i18n-registry.test.ts` owns the prefix trap in general), so each resolves like any
  // language this build does not register.
  it.each([
    ['nl-BE', 'nl'],
    ['pl-PL', 'pl'],
    ['tr-TR', 'tr'],
    ['uk-UA', 'uk'],
    ['ua', 'en'],
    ['ukr', 'en'],
    ['nld', 'en']
  ])("'system' with the OS locale %s resolves to %s", (locale, expected) => {
    expect(resolveUiLanguage('system', locale)).toBe(expected)
  })

  it('tolerates a missing/empty locale (→ English)', () => {
    expect(resolveUiLanguage('system', '')).toBe('en')
    expect(resolveUiLanguage('system', null)).toBe('en')
    expect(resolveUiLanguage('system', undefined)).toBe('en')
  })

  it("the shipped default ('system') resolves to English on this EN dev/CI machine", () => {
    // The whole existing suite asserts English copy (D-L8); this pins the assumption.
    expect(DEFAULT_SETTINGS.uiLanguage).toBe('system')
    expect(resolveUiLanguage(DEFAULT_SETTINGS.uiLanguage, 'en-US')).toBe('en')
  })
})

/** One machine-checkable typography rule of a language (its style guide; design-guidelines §7). */
interface TypographyRule {
  title: string
  /** The catalog entries that break the rule; empty when it holds. */
  offenders: (catalog: Readonly<Record<string, string>>) => string[]
  /** The failure message, naming the fix. */
  message: string
}

const occurrences = (value: string, mark: string): number => value.split(mark).length - 1

/** Every `open` quote is closed by `close`, never by an ASCII quote. Offenders read `key: value`. */
function balancedQuotes(open: string, close: string, title: string, message: string): TypographyRule {
  return {
    title,
    message,
    offenders: (catalog) =>
      Object.entries(catalog)
        .filter(([, value]) => occurrences(value, open) !== occurrences(value, close))
        .map(([key, value]) => `${key}: ${value}`)
  }
}

/** `close` never comes before its `open` (walking each value's pairs). Offenders are keys. */
function opensBeforeCloses(open: string, close: string, title: string, message: string): TypographyRule {
  return {
    title,
    message,
    offenders: (catalog) =>
      Object.entries(catalog)
        .filter(([, value]) => {
          let depth = 0
          for (const ch of value) {
            if (ch === open) depth++
            else if (ch === close && --depth < 0) return true
          }
          return false
        })
        .map(([key]) => key)
  }
}

/**
 * No value matches `pattern`. Offenders read `key: value`. The pattern must not carry the `g`
 * or `y` flag: `RegExp#test` would then resume from the previous match and skip values.
 */
function forbids(pattern: RegExp, title: string, message: string): TypographyRule {
  if (pattern.global || pattern.sticky) throw new Error(`forbids(${pattern}): drop the g/y flag`)
  return {
    title,
    message,
    offenders: (catalog) =>
      Object.entries(catalog)
        .filter(([, value]) => pattern.test(value))
        .map(([key, value]) => `${key}: ${value}`)
  }
}

/**
 * The unit symbols the formatters print (`shared/format.ts`, `unitJoin`), as a catalog writes them
 * after a figure: a symbol, then no letter and no apostrophe ("{n} s" is seconds, "{n} sezioni" is
 * not). French's list, which the seven other catalogs that write U+00A0 there share (#804,
 * open-issues wave owner call G-3).
 */
const UNIT_SYMBOL = '(?:GB|MB|KB|B|MB/s|tok/s|ms|s)(?![\\p{L}’])'

/** A plain space between a figure or a {placeholder} and a unit symbol: the catalog must write
 *  U+00A0 there, as `unitJoin` does for a size built in code, so the two never mix on a screen and
 *  a size cannot wrap between "23" and "GB" (#804). */
function joinsFigureAndUnit(language: string): TypographyRule {
  return forbids(
    new RegExp(`[}\\d] ${UNIT_SYMBOL}`, 'u'),
    'joins a figure and its unit symbol with a no-break space',
    `${language} values with a plain space between a figure and its unit — write \\u00A0`
  )
}

// The rules run over the CATALOG VALUES only: a catalog file's own comments are not shipped
// copy, and technical field names inside notes ("{field}", "language") legitimately keep
// straight ASCII pairs. Typecheck makes every registered language list its rules here.
const TYPOGRAPHY_RULES: { readonly [C in UiLanguage]: readonly TypographyRule[] } = {
  en: [],
  // German quotes are „…“ — an opening „ closed with an ASCII " is a visible typo in shipped
  // copy (it rendered as `Durchsuchbar machen (OCR)"` on the Images empty state).
  de: [
    balancedQuotes(
      '„',
      '“',
      'closes every opening „ with “, never with an ASCII quote',
      'German values with an unbalanced „…“ pair — close them with “ (U+201C), not "'
    ),
    opensBeforeCloses(
      '„',
      '“',
      'never uses “ as an OPENING quote (the pair is „…“, not “…”)',
      '“ used before its „ — German opens low, closes high'
    ),
    // #804, code review 2026-11-14: German writes a percent after a figure with U+00A0, as
    // `common.percent` does, so the sign never wraps to a line of its own and every value agrees.
    forbids(
      /\} ?%/,
      'separates a {placeholder} from % with a no-break space',
      'German values with {x}% or {x} % — write {pct}\\u00A0%'
    )
  ],
  // Spanish: the typography of design-guidelines §7 "Spanish microcopy".
  es: [
    balancedQuotes(
      '«',
      '»',
      'closes every opening « with »',
      'Spanish values with an unbalanced «…» pair — close them with » (U+00BB)'
    ),
    opensBeforeCloses(
      '«',
      '»',
      'never uses » as an OPENING quote (the pair is «…», not »…«)',
      '» used before its « — Spanish opens with « and closes with »'
    ),
    forbids(
      /["“”„‟‘]/,
      'uses no ASCII, English or German quotation mark',
      'Spanish values with a foreign quotation mark — quote with «…» (U+00AB, U+00BB)'
    ),
    balancedQuotes(
      '¿',
      '?',
      'opens every question with ¿',
      'Spanish values where ¿ and ? do not pair — every question opens with ¿ (U+00BF) and sits inside one value'
    ),
    opensBeforeCloses(
      '¿',
      '?',
      'never closes a question before opening it',
      '? used before its ¿ — put ¿ where the question starts'
    ),
    balancedQuotes(
      '¡',
      '!',
      'opens every exclamation with ¡',
      'Spanish values where ¡ and ! do not pair — every exclamation opens with ¡ (U+00A1)'
    ),
    opensBeforeCloses(
      '¡',
      '!',
      'never closes an exclamation before opening it',
      '! used before its ¡ — put ¡ where the exclamation starts'
    ),
    forbids(
      /['’]/,
      'uses no apostrophe',
      'Spanish values with an apostrophe — Spanish has none; quote with «…» and reword contractions'
    ),
    forbids(
      /\.\.\.| …/,
      'writes the ellipsis as one character, attached to the word before it',
      'Spanish values with three full stops or a space before … — use … (U+2026) with no space before it'
    ),
    forbids(
      / [—–-] /,
      'uses no spaced dash',
      'Spanish values with a spaced dash — Spanish breaks a sentence with a colon, a full stop, a comma or parentheses'
    ),
    forbids(
      /[¿¡«] | [?!»;,:]/,
      'puts no space inside «…», ¿…? or ¡…!, and none before : ; ,',
      'Spanish values with a space after ¿ ¡ « or before ? ! » : ; , — remove it'
    ),
    forbids(
      /[^\u00A0]%/,
      'separates a figure from % with a no-break space',
      'Spanish values with % not preceded by U+00A0 — write {pct}\\u00A0%'
    ),
    joinsFigureAndUnit('Spanish')
  ],
  // French: the typography of design-guidelines §7 "French microcopy".
  fr: [
    balancedQuotes(
      '«',
      '»',
      'closes every opening « with »',
      'French values with an unbalanced «…» pair'
    ),
    opensBeforeCloses(
      '«',
      '»',
      'never uses » before its «',
      '» used before its « — French opens with «'
    ),
    forbids(
      /["“”„‟]/,
      'uses no quotation mark other than « »',
      'French values quoting with " “ ” or „ — use «\u00A0…\u00A0»'
    ),
    forbids(
      /«(?!\u00A0)|(?<!\u00A0)»/,
      'puts a no-break space inside « and »',
      'French guillemets without U+00A0 inside — write «\\u00A0…\\u00A0»'
    ),
    // The one colon a French value may write without a space is the host:port one: a figure,
    // the colon, then the {port} placeholder (`diag.app.onPort`, 127.0.0.1:{port}). Any other
    // colon, Erreur:{detail} or Étape 2:{title} alike, needs the no-break space before it.
    forbids(
      /(?<!\u00A0)[;?!]|(?<![\u00A0\d]):|(?<=\d):(?!\{port\})/,
      'puts a no-break space before : ; ? !',
      'French : ; ? ! with a plain space or no space before it — write \\u00A0 (only the host:port colon of 127.0.0.1:{port} is exempt)'
    ),
    forbids(
      /(?<!\u00A0)%/,
      'puts a no-break space before %',
      'French % without U+00A0 before it'
    ),
    forbids(
      / \u00A0|\u00A0 |\u00A0\u00A0/,
      'never doubles a no-break space with another space',
      'French values with a space next to U+00A0'
    ),
    forbids(
      /(?<!\d)\u202F|\u202F(?!\d)/,
      'uses U+202F only between two digits',
      'French values with a narrow no-break space outside a typed figure — the house space is U+00A0'
    ),
    forbids(
      /['‘]/,
      'uses ’ for every apostrophe',
      "French values with an ASCII ' or a ‘ — use ’ (U+2019)"
    ),
    forbids(
      /\.\.\./,
      'uses … for an ellipsis',
      'French values with three dots — use … (U+2026)'
    ),
    forbids(
      /—| - /,
      'uses the spaced en dash as the house dash',
      'French values with an em dash or a bare " - " — use " – " (U+2013), or better a colon'
    ),
    forbids(
      /oe[ui]/i,
      'writes the œ ligature',
      'French values with "oeu"/"oei" — write œ (cœur, œuvre, œil, nœud)'
    ),
    joinsFigureAndUnit('French'),
    forbids(
      /[}\d][\u00A0 ](?:Go|Mo|Ko|octets?)(?!\p{L})/u,
      'keeps the Latin size symbols the formatters print',
      'French values with Go/Mo/Ko — the app prints GB/MB/KB, so the copy must too'
    ),
    // A tu form counts as a whole word, with no letter or digit on either side (Veux-tu,
    // Assieds-toi and ton… all count). «ton» is also the noun "tone": straight after an article
    // or a determiner it cannot be the possessive (le ton, d’un ton, son ton), so it passes there.
    // After «de» or «est-ce», or with a word in between (un bon ton), the two read alike: reword.
    forbids(
      /(?<![\p{L}\p{N}])(?:tu|toi|te|ta|tes|(?<!(?:^|[^\p{L}-])(?:le|un|du|au|ce|quel|mon|son|notre|votre|leur)\s)ton)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])t’/iu,
      'addresses the reader as vous',
      'French values with tu/toi/te/ton/ta/tes or t’ — the form of address is vous (the noun ton passes right after le, un, du, au, ce, quel or a possessive; otherwise reword)'
    ),
    forbids(
      /[\p{Ll},] Vous(?!\p{L})/u,
      'writes vous in lowercase mid-sentence',
      'French values with a capital Vous mid-sentence'
    )
  ],
  // Italian: the typography of design-guidelines §7 "Italian microcopy".
  it: [
    balancedQuotes(
      '«',
      '»',
      'closes every opening « with »',
      'Italian values with an unbalanced «…» pair — close each « with » (U+00BB)'
    ),
    opensBeforeCloses(
      '«',
      '»',
      'never uses » as an OPENING quote (the pair is «…», not »…«)',
      '» used before its « — Italian opens with « and closes with »'
    ),
    forbids(
      /["“”„‟]/u,
      'uses no ASCII, English or German double quote',
      'Italian values with " “ ” or „ — quote with «…» (also around technical field names)'
    ),
    forbids(
      /['‘`´]/u,
      'writes the apostrophe as ’, never as an ASCII quote, a backtick or an accent mark',
      "Italian values with ' ‘ ` or ´ — the apostrophe is ’ (U+2019)"
    ),
    forbids(
      /(?<![\p{L}\p{N}])(?:l|un|gl|dell|all|dall|nell|sull|coll|quell|quest|bell|sant|buon|grand|mezz|nessun|alcun|ciascun|qualcun|tutt|anch|senz|dov|com|cos|quand|quant|tant|nient|c|d|m|t|s|v|n)’(?=\s|$)/iu,
      'leaves no space after an elided form (l’unità, not l’ unità)',
      'Italian values with a space, or nothing, after an elision — join the two words'
    ),
    forbids(
      /\p{L}’\{/u,
      'never elides before a placeholder',
      'Italian values that elide before a {placeholder} — the inserted text may start with a consonant; put a noun in front (del documento «{title}»)'
    ),
    forbids(
      /\.\.\./u,
      'writes the ellipsis as …, never as three full stops',
      'Italian values with ... — use … (U+2026)'
    ),
    forbids(
      /—| - /u,
      'uses no em dash and no bare hyphen as a dash',
      'Italian values with — or " - " — use a colon, a new sentence, or the en dash " – " (U+2013)'
    ),
    forbids(
      /«\s|\s»/u,
      'puts no space inside «…»',
      'Italian values with a space inside the guillemets — «testo», not « testo » (that is French)'
    ),
    forbids(
      /(?<![\p{L}])(?:perchè|poichè|affinchè|finchè|benchè|giacchè|sicchè|nonchè|purchè|nè|sè|ventitrè|trentatrè|é|cioé|caffé|piú|giú|cosí|puó|giá|pò|qual’è)(?![\p{L}])/iu,
      'puts the right accent on perché, né, sé, è, cioè, più (and writes po’, qual è)',
      'Italian values with a wrong accent — acute on perché/poiché/né/sé, grave on è/cioè/più/già/così/può; un po’; qual è'
    ),
    forbids(
      /(?<![\p{L}])e’(?=\s)|\p{L}{2}[aeiou]’(?![\p{L}])/iu,
      'never writes an accent as an apostrophe (È, perché, qualità)',
      'Italian values with an apostrophe standing in for an accent (E’, perche’, qualita’) — use the accented letter'
    ),
    forbids(
      /[^\S\n][;:!?](?=\s|$)/u,
      'puts no space before ; : ! ?',
      'Italian values with a space before ; : ! or ? — that is the French convention'
    ),
    joinsFigureAndUnit('Italian')
  ],
  // Russian: the typography of design-guidelines §7 "Russian microcopy".
  ru: [
    balancedQuotes(
      '«',
      '»',
      'closes every opening « with »',
      'Russian values with an unbalanced «…» pair'
    ),
    opensBeforeCloses(
      '«',
      '»',
      'never uses » before its «',
      '» used before its « — Russian opens with « and closes with »'
    ),
    balancedQuotes(
      '„',
      '“',
      'closes every inner „ with “',
      'Russian values with an unbalanced inner „…“ pair — close them with “ (U+201C)'
    ),
    opensBeforeCloses(
      '„',
      '“',
      'never uses “ as an OPENING quote (the inner pair is „…“)',
      '“ used before its „ — the inner pair opens low, closes high'
    ),
    forbids(
      /(?:^|»)[^«]*„/,
      'uses „…“ only inside «…»',
      'inner quotes „…“ outside a «…» pair — the outer quotes are «…»'
    ),
    forbids(
      /["”‟]/,
      'uses no ASCII or English double quote',
      'Russian values with " or ” — quote with «…» (inner: „…“)'
    ),
    forbids(
      /\.\.\./,
      'writes the ellipsis as one character',
      'three dots where … (U+2026) belongs'
    ),
    forbids(
      / [-–] /,
      'breaks a sentence with the em dash only',
      'a spaced hyphen or en dash where the Russian house dash — belongs'
    ),
    forbids(
      /[ёЁ]/,
      'does not use the letter ё',
      'Russian values with ё — the catalog writes е throughout'
    ),
    forbids(
      /[A-Za-z][А-Яа-яЁё]|[А-Яа-яЁё][A-Za-z]/,
      'never joins a Latin and a Cyrillic letter',
      'a Latin letter next to a Cyrillic one — a look-alike typo, or a missing hyphen or space'
    ),
    forbids(
      /(?<=[а-яa-z0-9,;»)] )В(?:ы|ас|ам|ами|аш[а-я]{0,3})(?![а-я])/,
      'keeps вы / ваш lower case inside a sentence',
      'capital Вы / Ваш mid-sentence — the address form is lower-case вы'
    ),
    forbids(
      /(?<![А-Яа-я])(?:ты|тебя|тебе|тобой|тво(?:й|я|е|и|его|ей|ему|им|ими|их|ю))(?![А-Яа-я])/i,
      'never addresses the reader as ты',
      'an informal ты form — the address form is вы'
    ),
    forbids(
      /(?<![А-Яа-я])(?:[ГМКТ][Бб]|кБ|сек|мс)(?![А-Яа-я])/,
      'keeps the unit symbols the formatters print (GB, MB, KB, s, ms)',
      'a Cyrillic unit symbol next to the Latin ones the app prints'
    ),
    joinsFigureAndUnit('Russian')
  ],
  // Dutch: the typography of design-guidelines §7 "Dutch microcopy".
  nl: [
    balancedQuotes(
      '“',
      '”',
      'closes every opening “ with ”',
      'Dutch values with an unbalanced “…” pair — close each “ (U+201C) with ” (U+201D), never with an ASCII quote'
    ),
    opensBeforeCloses(
      '“',
      '”',
      'never uses ” as an OPENING quote (the pair is “…”)',
      '” used before its “ — Dutch opens with “ (U+201C) and closes with ” (U+201D)'
    ),
    forbids(
      /["„‟«»]/u,
      'uses no ASCII, low or angle quotation mark',
      'Dutch values with " „ ‟ « or » — quote with “…” (also around technical field names)'
    ),
    forbids(
      /['‘‚`´]/u,
      'writes the apostrophe as ’ and uses no single quotation marks',
      "Dutch values with ' ‘ ‚ ` or ´ — the apostrophe is ’ (U+2019: pdf’s, ’s avonds); quotes are “…” and never nested, so reword"
    ),
    forbids(
      /\}(?:[\p{L}\p{N}]|[’-]\p{L})/u,
      'glues no ending, genitive or compound part to a placeholder',
      'Dutch values with a letter, ’s or a hyphenated word glued to a closing } — put a noun in front (de documenten van {name}, context van {context} tokens)'
    ),
    forbids(
      /\.\.\.|[^\S\n]…/u,
      'writes the ellipsis as one character, attached to the word before it',
      'Dutch values with three full stops or a space before … — use … (U+2026) with no space before it'
    ),
    forbids(
      /—| - /u,
      'uses no em dash and no bare hyphen as a dash',
      'Dutch values with — or " - " — use a colon, a new sentence, or the en dash " – " (U+2013)'
    ),
    forbids(
      /[^\S\n][;:!?](?=\s|$)/u,
      'puts no space before ; : ! ?',
      'Dutch values with a space before ; : ! or ? — remove it (that is the French convention)'
    ),
    forbids(
      /\s%/u,
      'puts no space before %',
      'Dutch values with a space before % — write {pct}% as Intl prints it'
    ),
    forbids(
      new RegExp(`[\\u202F\\u2009]|(?<![}\\d])\\u00A0|\\u00A0(?!${UNIT_SYMBOL})`, 'u'),
      'uses no no-break or thin space, but U+00A0 between a figure and its unit symbol',
      'Dutch values with U+202F, U+2009, or U+00A0 anywhere but between a figure and its unit symbol ' +
        '({size}\\u00A0GB) — Dutch typography needs none elsewhere; use a plain space'
    ),
    joinsFigureAndUnit('Dutch'),
    forbids(
      /(?<![\p{L}\p{N}{’-])(?:u|uw|uzelf|jullie|gij)(?![\p{L}\p{N}}’-])/iu,
      'addresses the reader as je',
      'Dutch values with u, uw, uzelf, jullie or gij — the form of address is je (possessive je; jij/jou/jouw only for contrast)'
    ),
    forbids(
      /!/u,
      'uses no exclamation mark',
      'Dutch values with ! — the tone is calm; end the sentence with a full stop'
    )
  ],
  // Turkish: the typography of design-guidelines §7 "Turkish microcopy".
  tr: [
    balancedQuotes(
      '“',
      '”',
      'closes every opening “ with ”',
      'Turkish values with an unbalanced “…” pair — close each “ (U+201C) with ” (U+201D), never with an ASCII quote'
    ),
    opensBeforeCloses(
      '“',
      '”',
      'never uses ” as an OPENING quote (the pair is “…”)',
      '” used before its “ — Turkish opens with “ (U+201C) and closes with ” (U+201D)'
    ),
    forbids(
      /["„‟«»]/u,
      'uses no ASCII, German or angle quotation mark',
      'Turkish values with " „ ‟ « or » — quote with “…” (also around technical field names)'
    ),
    forbids(
      /['‘`´]/u,
      'writes the apostrophe as ’, never as an ASCII quote, a backtick or an accent mark',
      "Turkish values with ' ‘ ` or ´ — the apostrophe is ’ (U+2019); there is no single-quote pair"
    ),
    forbids(
      /\s’|’(?!\p{L})/u,
      'joins the apostrophe to the name before it and the suffix after it',
      'Turkish values with a space next to ’, or with nothing after it — write Windows’ta, HilbertRaum’un'
    ),
    forbids(
      /(?<![\p{L}\p{N}])\p{Ll}+’\p{L}/u,
      'puts an apostrophe only after a proper name, an acronym or a figure',
      'Turkish values with an apostrophe after a common (all lower-case) word — common nouns take their suffix directly (belgeyi, sürücüde)'
    ),
    forbids(
      /\}(?:\*\*)?['’]?\p{L}/u,
      'never glues a suffix to a placeholder',
      'Turkish values with a letter, or an apostrophe and a letter, right after a closing } — vowel harmony depends on the inserted text; put a generic noun after it ({model} modelinde), go label-first (Model: {model}) or use the passive'
    ),
    forbids(
      /”['’]?\p{L}/u,
      'never glues a suffix to a closing quote',
      'Turkish values with a letter right after ” — put a generic noun after the quoted label (“Yeniden dizinle” düğmesine)'
    ),
    forbids(
      /[\d}]\s?%|%\s/u,
      'writes the percent sign before the figure, without a space',
      'Turkish values with a figure before % or a space after % — write %{pct}'
    ),
    joinsFigureAndUnit('Turkish'),
    forbids(
      /\.\.\.|\s…/u,
      'writes the ellipsis as one character, attached to the word before it',
      'Turkish values with three full stops or a space before … — use … (U+2026) with no space before it'
    ),
    forbids(
      /—| - /u,
      'uses no em dash and no bare hyphen as a dash',
      'Turkish values with — or " - " — use a colon, a semicolon, a new sentence, or the en dash " – " (U+2013) between a label and its gloss'
    ),
    forbids(
      /[^\S\n][,;:!?](?=\s|$)/u,
      'puts no space before , ; : ! ?',
      'Turkish values with a space before , ; : ! or ? — remove it'
    ),
    forbids(
      /!/u,
      'uses no exclamation mark',
      'Turkish values with ! — the calm tone has none (the English catalog has none either)'
    ),
    forbids(
      /(?<=[\p{Ll}\d,;:”)] )Siz(?:e|i|in|de|den|le|ler\p{L}*|inle)?(?![\p{L}])/u,
      'keeps siz lower case inside a sentence',
      'capital Siz / Sizin mid-sentence — the address form is lower-case siz (and usually dropped)'
    ),
    forbids(
      /(?<![\p{L}])(?:sen|seni|senin|sana|sende|senden|seninle)(?![\p{L}])/iu,
      'never addresses the reader as sen',
      'an informal sen form — the address form is siz (seçin, belgeleriniz)'
    ),
    forbids(
      /\}\s?(?:saniye|sn\.?|milisaniye|bayt|gigabayt|megabayt)(?![\p{L}])/iu,
      'keeps the unit symbols the formatters print (GB, MB, KB, B, s, ms, tok/s)',
      'Turkish values with a unit word after a formatted figure — write the Latin symbol ({seconds} s, {size} GB)'
    ),
    forbids(
      /\}(?:\*\*)?”?\s(?:d[ea]|t[ea]|m[iıuü]|ki)(?![\p{L}])/u,
      'never puts a harmonising particle (de/da, mi/mı/mu/mü, ki) right after a placeholder',
      'Turkish values with de/da, mi/mı/mu/mü or ki right after a } — the particle follows the vowels of the inserted text; move it behind a fixed word ({name} indirilsin mi?)'
    )
  ],
  // Polish: the typography of design-guidelines §7 "Polish microcopy".
  pl: [
    balancedQuotes(
      '„',
      '”',
      'closes every opening „ with ”',
      'Polish values with an unbalanced „…” pair — close each „ (U+201E) with ” (U+201D)'
    ),
    opensBeforeCloses(
      '„',
      '”',
      'never uses ” before its „ (the pair is „…”, not ”…„)',
      '” used before its „ — Polish opens low with „ and closes high with ”'
    ),
    forbids(
      /["“‟]/u,
      'uses no ASCII quote and no “ (the German closing mark, the English opening mark)',
      'Polish values with " “ or ‟ — quote with „…” (U+201E, U+201D), also around technical field names'
    ),
    balancedQuotes(
      '«',
      '»',
      'closes every inner « with »',
      'Polish values with an unbalanced «…» pair — close each « with » (U+00BB)'
    ),
    opensBeforeCloses(
      '«',
      '»',
      'never uses » before its « (the inner pair is «…», not »…«)',
      '» used before its « — the inner quotation opens with « and closes with »'
    ),
    forbids(
      /(?:^|”)[^„]*«/u,
      'uses «…» only inside „…”',
      'Polish values with « outside an open „…” pair — the first-level quotes are „…”; «…» is only for a quotation inside one'
    ),
    forbids(
      /['’‘‚`´]/u,
      'uses no apostrophe and no single quotation mark',
      'Polish values with an apostrophe, a single quote, a backtick or an accent mark — quote with „…”, and put a noun before a foreign name instead of declining it (w przeglądarce Chrome)'
    ),
    forbids(
      /\.\.\.|[^\S\n]…/u,
      'writes the ellipsis as one character, attached to the word before it',
      'Polish values with three full stops or a space before … — use … (U+2026) with no space before it'
    ),
    forbids(
      /—| - /u,
      'uses the spaced en dash as the house dash',
      'Polish values with an em dash or a bare " - " — use " – " (U+2013), a colon or a new sentence'
    ),
    forbids(
      /\p{L}–|–\p{L}/u,
      'puts a space on each side of an en dash between words',
      'Polish values with an en dash touching a letter — write " – " (only figures and placeholders may touch it, as in a range)'
    ),
    forbids(
      /[^\S\n][,;:!?.](?=\s|$)/u,
      'puts no space before , ; : ! ? .',
      'Polish values with a space before a punctuation mark — remove it'
    ),
    forbids(
      /\s%/u,
      'attaches % to the figure',
      'Polish values with a space before % — write {pct}% (Intl prints 75%)'
    ),
    forbids(
      new RegExp(
        `(?<![}\\d])\\u00A0|(?<=\\})\\u00A0(?!${UNIT_SYMBOL})|(?<=\\d)\\u00A0(?!\\d|${UNIT_SYMBOL})|[\\u202F\\u2009\\u00AD\\u200B]`,
        'u'
      ),
      'uses a no-break space only between the digit groups of a typed figure, or between a figure and its unit symbol',
      'Polish values with U+00A0 outside a typed figure (200\\u00A0000) and not before a unit symbol ({size}\\u00A0GB), ' +
        'or with U+202F, U+2009, U+00AD or U+200B — catalog text uses plain spaces'
    ),
    joinsFigureAndUnit('Polish'),
    forbids(
      /\d[ ,.]\d{3}(?!\d)/u,
      'groups a typed figure with a no-break space',
      'Polish values with a typed figure grouped by a plain space, a comma or a full stop — write 200\\u00A0000'
    ),
    forbids(
      /(?<![\p{L}])(?:Pan|Pani|Pana|Panu|Panem|Panią|Państwo|Państwa|Państwu)(?![\p{L}])/u,
      'never addresses the reader as Pan, Pani or Państwo',
      'Polish values with Pan/Pani/Państwo — use the imperative or an impersonal form'
    ),
    forbids(
      /[\p{Ll},] (?:Ty|Ciebie|Cię|Tobie|Ci|Tobą|Twój|Twoja|Twoje|Twojego|Twojej|Twojemu|Twoją|Twoim|Twoich|Twoimi|Twoi)(?![\p{L}])/u,
      'writes ty and twój in lower case mid-sentence',
      'Polish values with a capital Ty/Twój/Cię mid-sentence — the courtesy capital belongs to letters, not to an interface'
    ),
    forbids(
      /\}[’'-]?\p{L}/u,
      'glues no ending to a placeholder',
      'Polish values with a letter or a hyphenated ending right after a {placeholder} — the inserted text cannot be declined; put a noun in front or go label-first'
    ),
    forbids(
      /(?<![\p{L}])(?:w|we|z|ze|do|od|na|o|u|po|przez|dla|bez|przy|nad|pod|za|przed|między|według|dzięki|oprócz|wśród|podczas|wobec|obok|spośród|zamiast|wewnątrz|poza)[^\S\n]+[„«]?\{(?:name|model|modelId|title|titles|document|query|site|library|vendor|recipient|source|archive|family|tool|engine|cpu|button|label|kind|basis|category|categories|field)\}/iu,
      'puts no preposition right before a name placeholder',
      'Polish values with a preposition right before {name}, {model}, {title} … — the inserted name cannot take the case; put a noun in front (w dokumencie „{title}”, z modelem {model}) or go label-first'
    )
  ],
  // Ukrainian: the typography of design-guidelines §7 "Ukrainian microcopy".
  uk: [
    balancedQuotes(
      '«',
      '»',
      'closes every opening « with »',
      'Ukrainian values with an unbalanced «…» pair — close each « with » (U+00BB)'
    ),
    opensBeforeCloses(
      '«',
      '»',
      'never uses » as an OPENING quote (the pair is «…», not »…«)',
      '» used before its « — Ukrainian opens with « and closes with »'
    ),
    balancedQuotes(
      '„',
      '“',
      'closes every inner „ with “',
      'Ukrainian values with an unbalanced „…“ pair — the inner pair opens with „ (U+201E) and closes with “ (U+201C)'
    ),
    opensBeforeCloses(
      '„',
      '“',
      'never uses “ as an OPENING quote (the inner pair is „…“, not “…”)',
      '“ used before its „ — an English pair was left in; quote with «…»'
    ),
    forbids(
      /["”‟‘‚‹›]/u,
      'uses no ASCII, English or single quotation mark',
      'Ukrainian values with a foreign quotation mark — quote with «…» (also around technical field names); „…“ only inside «…»'
    ),
    forbids(
      /^(?:[^«»]|«[^«»]*»)*„/u,
      'uses „…“ only inside «…»',
      'Ukrainian values with „ outside a «…» pair — the first-level quotes are «…»'
    ),
    forbids(
      /«\s|\s»/u,
      'puts no space inside «…»',
      'Ukrainian values with a space inside the guillemets — «текст», not « текст »'
    ),
    forbids(
      /['\u2019`\u00B4]/u,
      'writes the apostrophe as U+02BC, never as an ASCII quote, U+2019, a backtick or an accent',
      'Ukrainian values with an ASCII quote, U+2019, a backtick or an acute accent — the apostrophe is the letter U+02BC, as ICU prints it in the Ukrainian weekday names'
    ),
    forbids(
      /(?<![\p{L}])\u02BC|\u02BC(?![яюєї])/iu,
      'puts the apostrophe only inside a word, before я ю є ї',
      'Ukrainian values with U+02BC outside a word or not before я/ю/є/ї — it is a letter, never a quotation mark'
    ),
    forbids(
      /[\u044B\u044D\u044A\u0451]/iu,
      'uses no Russian letter (ы э ъ ё)',
      'Ukrainian values with ы, э, ъ or ё — Ukrainian writes и, е, the apostrophe (U+02BC) and йо/ьо; the word was probably not translated into Ukrainian'
    ),
    forbids(
      /\p{Script=Latin}\p{Script=Cyrillic}|\p{Script=Cyrillic}\p{Script=Latin}/u,
      'never lets a Latin and a Cyrillic letter touch',
      'Ukrainian values where a Latin letter touches a Cyrillic one — a look-alike (Latin i, o, a, e, c, p, x, y) inside a Ukrainian word, or an ending glued to a Latin term; join with a hyphen (PDF-файл)'
    ),
    forbids(
      /\S—|—\S/u,
      'puts a space on each side of the em dash',
      'Ukrainian values with an em dash that touches a word — write space, U+2014, space'
    ),
    forbids(
      /\s–|–\s| - /u,
      'uses no spaced en dash and no bare hyphen as a dash',
      'Ukrainian values with a spaced en dash or " - " — the sentence dash is the spaced em dash; the en dash only joins numbers (2–4)'
    ),
    forbids(
      /\.\.\.|[^\S\n]…/u,
      'writes the ellipsis as one character, attached to the word before it',
      'Ukrainian values with three full stops or a space before … — use … (U+2026) with no space before it'
    ),
    forbids(
      /[^\S\n][,.;:!?](?=\s|$)/u,
      'puts no space before , . ; : ! ?',
      'Ukrainian values with a space before a punctuation mark — attach it to the word before it'
    ),
    forbids(
      /!/u,
      'uses no exclamation mark',
      'Ukrainian values with ! — the copy is calm (design-guidelines §7); end the sentence with a full stop'
    ),
    forbids(
      new RegExp(
        `(?<![}\\d])\\u00A0|(?<=\\})\\u00A0(?!${UNIT_SYMBOL})|(?<=\\d)\\u00A0(?!\\d|${UNIT_SYMBOL})|\\u202F|\\d \\d{3}(?!\\d)|\\d,\\d{3}(?!\\d)`,
        'u'
      ),
      'groups a typed figure with U+00A0, joins a figure and its unit symbol with it, and uses no other no-break space',
      'Ukrainian values with a no-break space outside a figure and not before a unit symbol ({size}\\u00A0GB), a narrow no-break space, ' +
        'or a typed figure grouped with a plain space or a comma — write the group separator as \\u00A0, as Intl prints it'
    ),
    joinsFigureAndUnit('Ukrainian'),
    forbids(
      /\}[\p{L}\u02BC]|\}-\p{Script=Cyrillic}/u,
      'glues no ending to a placeholder',
      'Ukrainian values with a letter or a hyphenated ending right after a {placeholder} — the inserted text cannot be declined; put a generic noun in front (модель {model}) or use a label and a colon'
    )
  ]
}

describe('typography per registered language (design-guidelines §7 "Typography")', () => {
  const rows = UI_LANGUAGES.flatMap(({ code }) =>
    TYPOGRAPHY_RULES[code].map((rule) => [code, rule.title, rule] as const)
  )

  it.each(rows)('%s: %s', (code, _title, { offenders, message }) => {
    expect(offenders(catalogOf(code)), message).toEqual([])
  })
})

// The two French rules that carve out exceptions, tried on samples. The rules are read from
// TYPOGRAPHY_RULES by their titles, so these rows see whatever the catalog rows above enforce.
describe('French typography — the colon and address rules on samples', () => {
  const TITLES = { colon: 'puts a no-break space before : ; ? !', address: 'addresses the reader as vous' } as const
  const flags = (rule: keyof typeof TITLES, sample: string): boolean => {
    const found = TYPOGRAPHY_RULES.fr.find((r) => r.title === TITLES[rule])
    if (found === undefined) throw new Error(`no French typography rule titled ${TITLES[rule]}`)
    return found.offenders({ sample }).length > 0
  }

  it.each<[keyof typeof TITLES, string, string]>([
    ['colon', 'the host:port colon', ' sur 127.0.0.1:{port}'],
    ['colon', 'a no-break space before the colon', 'Erreur\u00A0: {detail}'],
    ['address', 'the noun after le', 'Changez le ton du texte'],
    ['address', 'the noun after un', 'un ton neutre'],
    ['address', 'the noun after d’un', 'd’un ton neutre'],
    ['address', 'vous', 'Vous pouvez le modifier'],
    ['address', 'ton inside a word', 'Appuyez sur le bouton']
  ])('the %s rule accepts %s', (rule, _label, sample) => {
    expect(flags(rule, sample)).toBe(false)
  })

  it.each<[keyof typeof TITLES, string, string]>([
    ['colon', 'a bare colon before a placeholder', 'Erreur:{detail}'],
    ['colon', 'a figure, a colon and another placeholder', 'Étape 2:{title}'],
    ['colon', 'a colon between two figures', 'Page 3:4'],
    ['colon', 'a plain space before the colon', 'Erreur : x'],
    ['colon', 'a host name before the colon', 'localhost:{port}'],
    ['address', 'the possessive', 'Ouvre ton document'],
    ['address', 'the possessive after de', 'Le nom de ton fichier'],
    ['address', 'tu after a hyphen', 'Veux-tu continuer'],
    ['address', 'toi after a hyphen', 'Assieds-toi'],
    ['address', 'the elided t’', 'Pour t’aider'],
    ['address', 'the possessive after est-ce', 'Est-ce ton fichier'],
    ['address', 'ton before an ellipsis', 'C’est ton…']
  ])('the %s rule rejects %s', (rule, _label, sample) => {
    expect(flags(rule, sample)).toBe(true)
  })
})

// The rules behind the second languages wave's own risks, tried on samples: a Turkish suffix glued
// to a placeholder or a quoted label (its vowels follow the inserted text), and Ukrainian written
// with a Russian letter or with an apostrophe other than U+02BC. The catalog rows above pass
// whenever no value breaks a rule, so a rule that has stopped matching anything passes them too;
// these rows show each one still catches its offender and lets the correct form through. Read
// from TYPOGRAPHY_RULES by title, like the French rows.
describe('Turkish and Ukrainian typography — the suffix, letter and apostrophe rules on samples', () => {
  const TR_APOSTROPHE = String.fromCharCode(0x2019) // ’, also the mark Ukrainian must not use
  const UK_APOSTROPHE = String.fromCharCode(0x02bc) // ʼ, a letter
  const ACUTE = String.fromCharCode(0x00b4) // ´
  const OPEN = String.fromCharCode(0x201c) // “
  const CLOSE = String.fromCharCode(0x201d) // ”
  const TITLES = {
    'tr placeholder': ['tr', 'never glues a suffix to a placeholder'],
    'tr quote': ['tr', 'never glues a suffix to a closing quote'],
    'tr particle': ['tr', 'never puts a harmonising particle (de/da, mi/mı/mu/mü, ki) right after a placeholder'],
    'uk letter': ['uk', 'uses no Russian letter (ы э ъ ё)'],
    'uk apostrophe mark': [
      'uk',
      'writes the apostrophe as U+02BC, never as an ASCII quote, U+2019, a backtick or an accent'
    ],
    'uk apostrophe place': ['uk', 'puts the apostrophe only inside a word, before я ю є ї']
  } as const
  const flags = (rule: keyof typeof TITLES, sample: string): boolean => {
    const [code, title] = TITLES[rule]
    const found = TYPOGRAPHY_RULES[code].find((r) => r.title === title)
    if (found === undefined) throw new Error(`no ${code} typography rule titled ${title}`)
    return found.offenders({ sample }).length > 0
  }

  it.each<[keyof typeof TITLES, string, string]>([
    ['tr placeholder', 'a generic noun that takes the suffix', '{model} modelinde'],
    ['tr placeholder', 'label first', 'Model: {model}'],
    ['tr placeholder', 'a quoted placeholder followed by a noun', `${OPEN}{title}${CLOSE} belgesi`],
    ['tr quote', 'a noun after the quoted label', `${OPEN}Yeniden dizinle${CLOSE} düğmesine`],
    ['tr particle', 'the particle behind a fixed word', '{name} indirilsin mi?'],
    ['tr particle', 'a word that begins like da', '{count} dakika'],
    ['tr particle', 'a word that begins like mi', '{name} mimarisi'],
    ['tr particle', 'a word that begins like ki', '{name} kitabı'],
    ['uk letter', 'і ї є ґ, йо and the apostrophe', `Об${UK_APOSTROPHE}єкт і їжак, ґанок, йогурт`],
    ['uk apostrophe mark', 'U+02BC', `ім${UK_APOSTROPHE}я`],
    ['uk apostrophe place', 'before я', `ім${UK_APOSTROPHE}я`],
    ['uk apostrophe place', 'before ю', `комп${UK_APOSTROPHE}ютер`],
    ['uk apostrophe place', 'before є', `об${UK_APOSTROPHE}єкт`],
    ['uk apostrophe place', 'before ї', `сім${UK_APOSTROPHE}ї`],
    ['uk apostrophe place', 'in capitals', `ОБ${UK_APOSTROPHE}ЄКТ`]
  ])('the %s rule accepts %s', (rule, _label, sample) => {
    expect(flags(rule, sample)).toBe(false)
  })

  it.each<[keyof typeof TITLES, string, string]>([
    ['tr placeholder', 'a suffix after an apostrophe', `{model}${TR_APOSTROPHE}de çalışıyor`],
    ['tr placeholder', 'a suffix glued on', '{model}de'],
    ['tr placeholder', 'a suffix after bold markup', `**{name}**${TR_APOSTROPHE}in`],
    ['tr placeholder', 'a suffix after an ASCII apostrophe', "{name}'e"],
    ['tr quote', 'a suffix glued on', `${OPEN}Yeniden dizinle${CLOSE}yi seçin`],
    ['tr quote', 'a suffix after an apostrophe', `${OPEN}{title}${CLOSE}${TR_APOSTROPHE}ı açın`],
    ['tr particle', 'mi', '{name} mi?'],
    ['tr particle', 'de', '{model} de çalışır'],
    ['tr particle', 'mı after bold markup', '**{name}** mı'],
    ['tr particle', 'ki after a quoted placeholder', `${OPEN}{title}${CLOSE} ki`],
    ['tr particle', 'da', '{name} da'],
    ['tr particle', 'te', '{name} te'],
    ['tr particle', 'ta', '{name} ta'],
    ['tr particle', 'mu', '{name} mu?'],
    ['tr particle', 'mü', '{name} mü?'],
    ['uk letter', 'ы', 'Мы'],
    ['uk letter', 'э', 'этот'],
    ['uk letter', 'ъ', 'Объект'],
    ['uk letter', 'ё', 'Ещё'],
    ['uk letter', 'a capital Ы', 'ЫХ'],
    ['uk letter', 'a capital Э', 'Экран'],
    ['uk letter', 'a capital Ъ', 'ОБЪЕКТ'],
    ['uk letter', 'a capital Ё', 'Ёлка'],
    ['uk apostrophe mark', 'an ASCII quote', "ім'я"],
    ['uk apostrophe mark', 'U+2019', `ім${TR_APOSTROPHE}я`],
    ['uk apostrophe mark', 'a backtick', 'ім`я'],
    ['uk apostrophe mark', 'an acute accent', `ім${ACUTE}я`],
    ['uk apostrophe place', 'U+02BC used as quotation marks', `${UK_APOSTROPHE}Назва${UK_APOSTROPHE}`],
    ['uk apostrophe place', 'U+02BC at the end of a word', `ім${UK_APOSTROPHE}`],
    ['uk apostrophe place', 'U+02BC before а', `ім${UK_APOSTROPHE}а`],
    ['uk apostrophe place', 'U+02BC after a space', `слово ${UK_APOSTROPHE}я`]
  ])('the %s rule rejects %s', (rule, _label, sample) => {
    expect(flags(rule, sample)).toBe(true)
  })
})

// The figure-unit rule (#804, open-issues wave owner call G-3) and the three no-break-space rules
// it relaxes, tried on samples: every catalog that writes U+00A0 before a unit symbol refuses the
// plain space there, and Dutch, Polish and Ukrainian allow U+00A0 in exactly that one position
// more. Read from TYPOGRAPHY_RULES by title, like the rows above.
describe('figure and unit — the no-break space before a unit symbol, on samples (#804)', () => {
  const NBSP = String.fromCharCode(0xa0)
  const UNIT_RULE = 'joins a figure and its unit symbol with a no-break space'
  const NBSP_RULES = {
    nl: 'uses no no-break or thin space, but U+00A0 between a figure and its unit symbol',
    pl: 'uses a no-break space only between the digit groups of a typed figure, or between a figure and its unit symbol',
    uk: 'groups a typed figure with U+00A0, joins a figure and its unit symbol with it, and uses no other no-break space'
  } as const
  const flags = (code: UiLanguage, title: string, sample: string): boolean => {
    const found = TYPOGRAPHY_RULES[code].find((r) => r.title === title)
    if (found === undefined) throw new Error(`no ${code} typography rule titled ${title}`)
    return found.offenders({ sample }).length > 0
  }

  it.each(['es', 'fr', 'it', 'nl', 'pl', 'tr', 'ru', 'uk'] as const)(
    '%s refuses a plain space between a figure and its unit, and takes U+00A0 there',
    (code) => {
      expect(flags(code, UNIT_RULE, '{size} GB')).toBe(true)
      expect(flags(code, UNIT_RULE, `{size}${NBSP}GB`)).toBe(false)
    }
  )

  it.each([
    ['a no-break space', `{size}${NBSP}GB`],
    ['a word that begins with s', '{count} sezioni'],
    ['a word that begins with B', '{count} Bytes'],
    ['a word that begins with MB', '{count} MBit'],
    ['a unit after a word', 'Speicher GB']
  ])('the unit rule accepts %s', (_label, sample) => {
    expect(flags('es', UNIT_RULE, sample)).toBe(false)
  })

  it.each([
    ['GB after a placeholder', '{gb} GB'],
    ['GB after a typed figure', '4,5 GB'],
    ['MB', '{size} MB'],
    ['KB', '2,0 KB'],
    ['B', '512 B'],
    ['MB/s', '{mbps} MB/s'],
    ['tok/s', '{tps} tok/s'],
    ['ms', '{ms} ms'],
    ['s', '{ttft} s'],
    ['s before a full stop', '{seconds} s.'],
    ['a second unit in one value', `{tps}${NBSP}tok/s · {ttft} s`]
  ])('the unit rule refuses a plain space before %s', (_label, sample) => {
    expect(flags('es', UNIT_RULE, sample)).toBe(true)
  })

  it.each(
    (['nl', 'pl', 'uk'] as const).flatMap((code) => [
      [code, 'GB after a placeholder', `{size}${NBSP}GB`],
      [code, 'MB/s after a typed figure', `5${NBSP}MB/s`],
      [code, 's after a placeholder', `{ttft}${NBSP}s`]
    ])
  )('%s: the no-break-space rule allows U+00A0 before a unit symbol (%s)', (code, _label, sample) => {
    expect(flags(code, NBSP_RULES[code], sample)).toBe(false)
  })

  it.each(
    (['nl', 'pl', 'uk'] as const).flatMap((code) => [
      [code, 'after a placeholder, before a word', `{name}${NBSP}model`],
      [code, 'between two words', `a${NBSP}b`],
      [code, 'before a word that begins with s', `{count}${NBSP}sekund`],
      [code, 'before a unit, after a word', `Speicher${NBSP}GB`]
    ])
  )('%s: the no-break-space rule still refuses U+00A0 %s', (code, _label, sample) => {
    expect(flags(code, NBSP_RULES[code], sample)).toBe(true)
  })

  // The digit groups of a typed figure keep their U+00A0 in Polish and Ukrainian; Dutch has none.
  it.each([
    ['pl', false],
    ['uk', false],
    ['nl', true]
  ] as const)('%s: a typed figure grouped with U+00A0 is refused: %s', (code, refused) => {
    expect(flags(code, NBSP_RULES[code], `200${NBSP}000`)).toBe(refused)
  })
})

// The German percent rule (#804, code review 2026-11-14), tried on samples so a rule that has
// stopped matching anything cannot pass the catalog row alone. Read from TYPOGRAPHY_RULES by title.
describe('German typography — the percent rule on samples (#804)', () => {
  const NBSP = String.fromCharCode(0xa0)
  const TITLE = 'separates a {placeholder} from % with a no-break space'
  const flags = (sample: string): boolean => {
    const found = TYPOGRAPHY_RULES.de.find((r) => r.title === TITLE)
    if (found === undefined) throw new Error(`no de typography rule titled ${TITLE}`)
    return found.offenders({ sample }).length > 0
  }

  it.each([
    ['a no-break space', `{pct}${NBSP}%`],
    ['a no-break space inside parentheses', `- Steuer ({rate}${NBSP}%): **{value}**`],
    ['a no-break space before a full stop', `bisher etwa {pct}${NBSP}%. Es geht weiter`],
    ['a percent sign after a word', 'Angaben in %']
  ])('accepts %s', (_label, sample) => {
    expect(flags(sample)).toBe(false)
  })

  it.each([
    ['a plain space', '{pct} %'],
    ['no space', '{pct}%'],
    ['no space inside parentheses', '- Steuer ({rate}%): **{value}**'],
    ['a plain space in a longer value', 'Modell {n} von {m} wird geprüft: {name} — {pct} %']
  ])('refuses %s', (_label, sample) => {
    expect(flags(sample)).toBe(true)
  })
})

describe('German typography — quotation marks (design-guidelines §7 "Typography")', () => {
  it('the strings the sweep corrected read with German closers', () => {
    expect(de['images.avail.ocrPointer']).toContain('„Durchsuchbar machen (OCR)“')
    expect(de['docs.task.extractBusyTitle']).toContain('„Liste alle…“')
    // (docs.deepIndex.buildTitle was removed as a dead key — RD-5, #151.)
    expect(de['skills.analysis.refusePartial']).toContain('„Neu indexieren“')
    expect(de['models.vision.installed']).toContain('„Bilder“')
    expect(de['models.vision.notInstalled']).toContain('„Bilder“')
    expect(de['images.chip.readForm.prompt']).toContain('„unklar“')
    expect(de['translate.file.err.noPath']).toContain('„ein Dokument auswählen“')
  })

  it('does not touch the English catalog (straight quotes stay straight there)', () => {
    expect(en['images.avail.ocrPointer']).not.toMatch(/„|“/)
  })
})

describe('a quoted label is the real one — the partial re-index toast (#805 W1)', () => {
  // The toast sends the user to the Documents rail entry that lists the failed documents. A quote
  // there must be the entry's own label (`docs.smart.attention`), or the toast names a place the
  // screen does not show (it used to send them to "the Failed imports tab"). English,
  // German and Spanish quote it (the owner-approved W1 scope); a language that describes the entry
  // unquoted is not asserted (Italian, S-W2-3), but whatever a language does quote must be the label.
  const NAMES_THE_LABEL: readonly UiLanguage[] = ['en', 'de', 'es']
  /** The text inside each pair of double quotation marks, any house style ("…", “…”, „…“, «…»). */
  const quoted = (value: string): string[] =>
    [...value.matchAll(/["“„«]([^"“”„«»]+)["”“»]/g)].map((match) => match[1].trim())

  it.each(UI_LANGUAGE_CODES)('%s: docs.reindexAllPartial quotes exactly the docs.smart.attention label', (code) => {
    const catalog = catalogOf(code)
    const label = catalog['docs.smart.attention']
    const spans = quoted(catalog['docs.reindexAllPartial'])
    if (NAMES_THE_LABEL.includes(code)) expect(spans, `${code} names the rail entry (W1)`).not.toEqual([])
    expect(spans.filter((span) => span !== label), `a quote that is not the rail label "${label}"`).toEqual([])
  })
})

describe('house dashes — knowledge-pack copy (#301 P6, plan §9.23 (c)4)', () => {
  // A sentence-level break uses a real dash: English the em dash "—", German the em dash or
  // the en dash "–"; a bare ASCII hyphen standing in for one (space-hyphen-space) is a typo,
  // not a house-style choice. The same holds in every other registered language (its dash is
  // in its style guide, and its own typography rules go further).
  const PREFIXES = ['packs.', 'chat.scope.', 'chat.packs.', 'chat.article.']

  it('no value under packs./chat.scope./chat.packs./chat.article. contains " - " in any registered language', () => {
    const offenders: string[] = []
    for (const { code: lang } of UI_LANGUAGES) {
      for (const [key, value] of Object.entries(catalogOf(lang))) {
        if (!PREFIXES.some((p) => key.startsWith(p))) continue
        if (value.includes(' - ')) offenders.push(`${lang}:${key}: ${value}`)
      }
    }
    expect(offenders, 'bare " - " where a house dash (— EN / – DE) belongs').toEqual([])
  })
})

type Catalog = Readonly<Record<string, string>>
type CatalogShape = Pick<UiLanguageInfo, 'evidencePack' | 'pluralCategories' | 'plural'>

/** The plural bases: `X` with both `X.one` and `X.other` (`packs.addFailed.other` alone is no plural). */
function pluralBases(keys: ReadonlySet<string>): string[] {
  return [...keys]
    .filter((key) => key.endsWith('.one') && keys.has(`${key.slice(0, -'.one'.length)}.other`))
    .map((key) => key.slice(0, -'.one'.length))
}

const PLURAL_CATEGORIES: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'] satisfies PluralCategory[]

/**
 * Whether `key` is a form of one of `bases`: a plural base plus a plural category. A plain key
 * named under a base is not one (`chat.skill.run.done.reconciled` sits beside the
 * `chat.skill.run.done` pair, `review.deleteWithConversation.unknown` beside its own pair).
 * So never name a plain key `<base>.zero|one|two|few|many|other`: it would read as a plural form.
 */
function isPluralFormOf(bases: ReadonlySet<string>, key: string): boolean {
  const dot = key.lastIndexOf('.')
  return PLURAL_CATEGORIES.includes(key.slice(dot + 1)) && bases.has(key.slice(0, dot))
}

/**
 * The runtime twin of `CatalogKeyFor` (shared/i18n/languages.ts): the exact key set a catalog of
 * a language must have. Every English key, plus one key per plural base for each form the
 * language has beyond `.one`/`.other` (Russian `.few` and `.many`); without any `packExport.*`
 * key when the language writes no evidence packs (they render only inside a pack, D-L9).
 */
function requiredCatalogKeys(info: CatalogShape, english: Catalog): Set<string> {
  const englishKeys = new Set(Object.keys(english))
  const extraForms = info.pluralCategories.filter((form) => form !== 'one' && form !== 'other')
  const keys = [
    ...englishKeys,
    ...pluralBases(englishKeys).flatMap((base) => extraForms.map((form) => `${base}.${form}`))
  ]
  return new Set(keys.filter((key) => info.evidencePack || !key.startsWith('packExport.')))
}

const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()

/**
 * Whether a plural rule gives `one` to the number 1 and to nothing else, probed over the counts
 * a screen shows (`tCount` selects on the raw number). True for English and German (`exactOne`)
 * and also for Spanish and Italian; false for Russian (21, 31, …) and French (0, 1.5), whose
 * `.one` form also renders other numbers. Decided by probing the rule, not by comparing it with
 * `exactOne`: a CLDR rule can still give `one` to 1 alone.
 */
function oneMeansExactlyOne(plural: (n: number) => PluralCategory): boolean {
  const probes = [0, 0.5, 1.5, 1_000_001, ...Array.from({ length: 1_000 }, (_, i) => i + 1)]
  return probes.every((n) => (plural(n) === 'one') === (n === 1))
}

/**
 * Everything wrong with `catalog` as the catalog of a language shaped `info`: a missing or an
 * unexpected key, an empty value, or placeholders that differ from English. A form English
 * does not have (`.few`) is compared with its base's `.other`. One licence and one duty (owner
 * calls, 2026-11-12): in a language whose `one` is not exactly 1, a plural form may add `{count}`
 * where English's form lacks it, and must when its base's English `.other` shows it ("Knowledge
 * pack added" is a Russian `.one` that also serves 21 packs, so a copy of the English shape would
 * call 21 packs one). `tCount` always supplies `count`, so the render cannot miss it. A plain key,
 * even one named under a plural base, gets neither: `t` renders it with no `count`. Nothing else
 * may be added or dropped.
 */
function catalogParityProblems(info: CatalogShape, catalog: Catalog, english: Catalog): string[] {
  const required = requiredCatalogKeys(info, english)
  const bases = new Set(pluralBases(new Set(Object.keys(english))))
  const countLicence = !oneMeansExactlyOne(info.plural)
  const problems: string[] = []
  for (const key of [...required].sort()) {
    if (!Object.hasOwn(catalog, key)) problems.push(`missing key ${key}`)
  }
  for (const key of Object.keys(catalog).sort()) {
    if (!required.has(key)) {
      problems.push(`unexpected key ${key}`)
      continue
    }
    const value = catalog[key]
    if (value.trim().length === 0) problems.push(`empty value for ${key}`)
    const reference = english[key] ?? english[`${key.slice(0, key.lastIndexOf('.'))}.other`]
    const [have, want] = [placeholders(value), placeholders(reference)]
    const pluralForm = isPluralFormOf(bases, key)
    const addsCount =
      countLicence && pluralForm && !want.includes('{count}') && have.join() === [...want, '{count}'].sort().join()
    if (have.join() !== want.join() && !addsCount) {
      problems.push(`placeholder mismatch in ${key}: [${have.join(', ')}], English [${want.join(', ')}]`)
    } else if (
      countLicence &&
      pluralForm &&
      !have.includes('{count}') &&
      placeholders(english[`${key.slice(0, key.lastIndexOf('.'))}.other`]).includes('{count}')
    ) {
      problems.push(`no {count} in ${key}: this form also renders counts other than 1, so it must show the number`)
    }
  }
  return problems
}

describe('catalog hygiene (parity is otherwise enforced by typecheck)', () => {
  // D-L10: every registered catalog is complete. Typecheck holds the key set (`UiCatalog`);
  // this row is its runtime belt and adds what a type cannot say (no empty value, the
  // English placeholders).
  it.each(UI_LANGUAGES.map((info) => [info.code, info] as const))(
    '%s: carries exactly its required keys, no empty value, and the English placeholders',
    (code, info) => {
      expect(catalogParityProblems(info, catalogOf(code), en)).toEqual([])
    }
  )

  // Every guard here reads the catalog FILES (`catalogOf`); `t` reads `CATALOGS` (index.ts).
  // Languages with the same plural forms share a catalog type, so a map entry pointing at
  // another language's catalog (`de: en`, `fr: es`) typechecks; this row is what notices it.
  it.each(UI_LANGUAGE_CODES)('%s: t() renders the text of its own catalog file (the CATALOGS entry)', (code) => {
    const catalog = catalogOf(code)
    const plain = Object.keys(catalog).filter((key) => !/\{\w+\}/.test(catalog[key]))
    const elsewhere = plain.filter((key) => t(code, key as MessageKey) !== catalog[key])
    expect(plain.length).toBeGreaterThan(0)
    expect(
      elsewhere.slice(0, 5),
      `${elsewhere.length} of ${plain.length} param-less keys render text that is not in ${code}.ts`
    ).toEqual([])
  })

  describe('the parity rule on fixture catalogs (the failing shapes no real catalog has)', () => {
    const english = {
      'nav.home': 'Home',
      'docs.opened': 'Opened {name}',
      'docs.count.one': '{count} document',
      'docs.count.other': '{count} documents',
      'packs.addFailed.other': 'The archive could not be added.',
      'packExport.title': 'Evidence pack',
      'packExport.items.one': '{count} item',
      'packExport.items.other': '{count} items'
    }
    const russianShape: CatalogShape = {
      evidencePack: false,
      pluralCategories: ['one', 'few', 'many', 'other'],
      plural: cldrPlural('ru')
    }
    const frenchShape: CatalogShape = {
      evidencePack: false,
      pluralCategories: ['one', 'many', 'other'],
      plural: cldrPlural('fr')
    }
    const russian: Catalog = {
      'nav.home': 'Главная',
      'docs.opened': 'Открыт {name}',
      'docs.count.one': '{count} документ',
      'docs.count.few': '{count} документа',
      'docs.count.many': '{count} документов',
      'docs.count.other': '{count} документа',
      'packs.addFailed.other': 'Не удалось добавить архив.'
    }
    // The same catalog with the forms French has (one, many, other).
    const { 'docs.count.few': _few, ...frenchForms } = russian
    void _few
    const without = (catalog: Catalog, key: string): Catalog =>
      Object.fromEntries(Object.entries(catalog).filter(([k]) => k !== key))

    it('a complete catalog passes: its extra forms, no packExport.*, no form of a non-plural', () => {
      // `packs.addFailed` has no `.one`, so it has no `.few`; `packExport.items` is a plural, but a
      // language without evidence packs carries none of its forms.
      expect(catalogParityProblems(russianShape, russian, english)).toEqual([])
      expect(catalogParityProblems(frenchShape, frenchForms, english)).toEqual([])
    })

    it.each<[string, CatalogShape, Catalog, string[]]>([
      ['a plain key removed', russianShape, without(russian, 'nav.home'), ['missing key nav.home']],
      [
        'a plural form the language has removed',
        russianShape,
        without(russian, 'docs.count.few'),
        ['missing key docs.count.few']
      ],
      [
        'a form the language does not have',
        frenchShape,
        { ...frenchForms, 'docs.count.few': '{count} documents' },
        ['unexpected key docs.count.few']
      ],
      [
        'a form of a key that is not a plural',
        russianShape,
        { ...russian, 'nav.home.few': 'x', 'packs.addFailed.few': 'x' },
        ['unexpected key nav.home.few', 'unexpected key packs.addFailed.few']
      ],
      [
        'a packExport key in a language without evidence packs',
        russianShape,
        { ...russian, 'packExport.title': 'Пакет' },
        ['unexpected key packExport.title']
      ],
      [
        'a form of a packExport plural in a language without evidence packs',
        russianShape,
        { ...russian, 'packExport.items.few': '{count} элемента' },
        ['unexpected key packExport.items.few']
      ],
      [
        'no packExport keys in a language that writes evidence packs',
        { ...russianShape, evidencePack: true },
        russian,
        [
          'missing key packExport.items.few',
          'missing key packExport.items.many',
          'missing key packExport.items.one',
          'missing key packExport.items.other',
          'missing key packExport.title'
        ]
      ],
      [
        'an empty value',
        russianShape,
        { ...russian, 'nav.home': ' ' },
        ['empty value for nav.home']
      ],
      [
        'a placeholder dropped from a plain key',
        russianShape,
        { ...russian, 'docs.opened': 'Открыт' },
        ['placeholder mismatch in docs.opened: [], English [{name}]']
      ],
      [
        'a placeholder English does not have',
        russianShape,
        { ...russian, 'nav.home': 'Главная {x}' },
        ['placeholder mismatch in nav.home: [{x}], English []']
      ],
      [
        "a placeholder dropped from a form English lacks (compared with the base's .other)",
        russianShape,
        { ...russian, 'docs.count.many': 'много документов' },
        ['placeholder mismatch in docs.count.many: [], English [{count}]']
      ]
    ])('%s is a problem', (_title, shape, catalog, problems) => {
      expect(catalogParityProblems(shape, catalog, english)).toEqual(problems)
    })
  })

  describe('a plural form may add {count} only where the language’s one is not exactly 1, and there must show it when the plural does (owner calls 2026-11-12)', () => {
    // English `.one` of `packs.added` names no number; English `gap.pages` shows a range, never
    // the count (like `packs.addedToast` and `translate.file.gapPages`).
    const english = {
      'nav.home': 'Home',
      'packs.added.one': 'Pack added',
      'packs.added.other': '{count} packs added',
      'gap.pages.one': 'Page {pages} is missing',
      'gap.pages.other': 'Pages {pages} are missing'
    }
    const ruShape: CatalogShape = {
      evidencePack: false,
      pluralCategories: ['one', 'few', 'many', 'other'],
      plural: cldrPlural('ru')
    }
    const frShape: CatalogShape = {
      evidencePack: false,
      pluralCategories: ['one', 'many', 'other'],
      plural: cldrPlural('fr')
    }
    const esShape: CatalogShape = {
      evidencePack: false,
      pluralCategories: ['one', 'many', 'other'],
      plural: cldrPlural('es')
    }
    // Russian `.one` also serves 21, 31, …, so it shows the number; `.few` may too.
    const russian: Catalog = {
      'nav.home': 'Главная',
      'packs.added.one': 'Добавлен {count} пакет',
      'packs.added.few': 'Добавлено {count} пакета',
      'packs.added.many': 'Добавлено {count} пакетов',
      'packs.added.other': 'Добавлено {count} пакета',
      'gap.pages.one': 'Не переведены страницы: {pages}',
      'gap.pages.few': 'Не переведены страницы ({count}): {pages}',
      'gap.pages.many': 'Не переведены страницы: {pages}',
      'gap.pages.other': 'Не переведены страницы: {pages}'
    }
    // French `.one` also serves 0 and 1.5.
    const french: Catalog = {
      'nav.home': 'Accueil',
      'packs.added.one': '{count} pack ajouté',
      'packs.added.many': '{count} de packs ajoutés',
      'packs.added.other': '{count} packs ajoutés',
      'gap.pages.one': 'Page {pages} manquante',
      'gap.pages.many': 'Pages {pages} manquantes',
      'gap.pages.other': 'Pages {pages} manquantes'
    }
    const spanish: Catalog = {
      'nav.home': 'Inicio',
      'packs.added.one': 'Paquete añadido',
      'packs.added.many': '{count} de paquetes añadidos',
      'packs.added.other': '{count} paquetes añadidos',
      'gap.pages.one': 'Falta la página {pages}',
      'gap.pages.many': 'Faltan las páginas {pages}',
      'gap.pages.other': 'Faltan las páginas {pages}'
    }
    const german: Catalog = {
      'nav.home': 'Start',
      'packs.added.one': 'Paket hinzugefügt',
      'packs.added.other': '{count} Pakete hinzugefügt',
      'gap.pages.one': 'Seite {pages} fehlt',
      'gap.pages.other': 'Seiten {pages} fehlen'
    }

    it.each<[string, CatalogShape, Catalog]>([
      ['Russian (21 is one)', ruShape, russian],
      ['French (0 is one)', frShape, french]
    ])('%s: a form that adds {count} passes, extra forms included', (_title, shape, catalog) => {
      expect(catalogParityProblems(shape, catalog, english)).toEqual([])
    })

    // Where `one` is exactly 1, the singular serves 1 alone, so the English shape is right.
    it.each<[string, CatalogShape, Catalog]>([
      ['German (the real registry entry)', uiLanguageInfo('de'), german],
      ['Spanish (a CLDR rule whose one is exactly 1)', esShape, spanish]
    ])('%s: a singular with no number passes', (_title, shape, catalog) => {
      expect(catalogParityProblems(shape, catalog, english)).toEqual([])
    })

    // A copy of the English shape ("Pack added") would call 21 Russian packs, or 0 French ones,
    // a single pack. `gap.pages` stays free: its English plural shows no count either.
    it.each<[string, CatalogShape, Catalog, string[]]>([
      [
        'Russian, a singular with no number (it also serves 21)',
        ruShape,
        { ...russian, 'packs.added.one': 'Пакет добавлен' },
        ['no {count} in packs.added.one: this form also renders counts other than 1, so it must show the number']
      ],
      [
        'French, a singular with no number (it also serves 0)',
        frShape,
        { ...french, 'packs.added.one': 'Pack ajouté' },
        ['no {count} in packs.added.one: this form also renders counts other than 1, so it must show the number']
      ]
    ])('%s is a problem', (_title, shape, catalog, problems) => {
      expect(catalogParityProblems(shape, catalog, english)).toEqual(problems)
    })

    it.each<[string, CatalogShape, Catalog, string[]]>([
      [
        'German (its one is exactly 1, the real registry entry)',
        uiLanguageInfo('de'),
        { ...german, 'packs.added.one': '{count} Paket hinzugefügt' },
        ['placeholder mismatch in packs.added.one: [{count}], English []']
      ],
      [
        'Spanish (a CLDR rule whose one is exactly 1)',
        esShape,
        { ...spanish, 'packs.added.one': '{count} paquete añadido' },
        ['placeholder mismatch in packs.added.one: [{count}], English []']
      ],
      [
        'Russian, another placeholder in its place',
        ruShape,
        { ...russian, 'packs.added.one': 'Добавлен {name}' },
        ['placeholder mismatch in packs.added.one: [{name}], English []']
      ],
      [
        'Russian, another placeholder beside {count}',
        ruShape,
        { ...russian, 'packs.added.one': 'Добавлен {count} пакет {name}' },
        ['placeholder mismatch in packs.added.one: [{count}, {name}], English []']
      ],
      [
        'Russian, {count} in a key that is not a plural',
        ruShape,
        { ...russian, 'nav.home': 'Главная ({count})' },
        ['placeholder mismatch in nav.home: [{count}], English []']
      ],
      [
        'Russian, {count} dropped where English has it',
        ruShape,
        { ...russian, 'packs.added.other': 'Добавлены пакеты' },
        ['placeholder mismatch in packs.added.other: [], English [{count}]']
      ]
    ])('%s is a problem', (_title, shape, catalog, problems) => {
      expect(catalogParityProblems(shape, catalog, english)).toEqual(problems)
    })

    it('Russian, {count} added to a plain key named under a plural base is a problem', () => {
      // `packs.added.none` is no plural form, so `t` renders it with no `count`: an added {count}
      // would make `t` fall back to the English text. The real catalog has such keys
      // (`chat.skill.run.done.reconciled`).
      const withPlain = { ...english, 'packs.added.none': 'Nothing was added' }
      const catalog = { ...russian, 'packs.added.none': 'Ничего не добавлено ({count})' }
      expect(catalogParityProblems(ruShape, catalog, withPlain)).toEqual([
        'placeholder mismatch in packs.added.none: [{count}], English []'
      ])
    })
  })

  it('every .one plural key has its .other partner and vice versa (tCount contract)', () => {
    // Key parity is asserted above, so checking the English key set covers every catalog.
    // A trailing ".other" alone is not proof of a plural (a key could just as well be a plain
    // label that happens to end in "...other") — a plural variant is one that interpolates
    // {count}.
    const keys = new Set(Object.keys(en) as MessageKey[])
    for (const key of keys) {
      if (key.endsWith('.one')) {
        expect(keys.has(`${key.slice(0, -4)}.other` as MessageKey), `missing .other for ${key}`).toBe(true)
      } else if (key.endsWith('.other') && en[key].includes('{count}')) {
        expect(keys.has(`${key.slice(0, -6)}.one` as MessageKey), `missing .one for ${key}`).toBe(true)
      }
    }
  })
})

// =================================================================================================
// CODE-8 net: a number shown by a plain (unpaired) key (full-audit 2026-07-11 CODE-8; widened in
// the UI languages wave to every key the scan below finds showing a number). Such a key renders
// the same words for every count, so it reads wrong wherever a word agrees with the number
// ("Retry 1 failed documents?"). It must either become a .one/.other pair rendered through
// `tCount`, or sit on NON_GRAMMATICAL below with a reason that holds in every registered language
// and in any language added later: either nothing agrees with the number, or the translations
// must be written so that nothing does (the group's reason says how, e.g. label first:
// "Tokens: {tokens}").
//
// The net finds these keys two ways:
//   - in the source: every call that names a catalog key (`t`, `tMain`, `t(lang, …)`, `tr`, `s`,
//     …) or a `{ key, params }` table, where a params property that fills one of the key's
//     placeholders is a number or text formatted from one (`.length`, arithmetic, `Math.*`,
//     `toLocaleString`, `String(n)`, a number formatter such as `fmt1`), read through the
//     TypeScript AST, up to two variable hops back;
//   - in the catalog: every key with a placeholder whose name means a number wherever it is used
//     here (`{count}`, `{total}`, `{pct}`, …). This sees what the syntax cannot (`{ total: job.total }`).
// Its limit: a number that arrives through a plain property or a function parameter
// (`{ files: job.files }`, `function f(files) { t(key, { files }) }`) under a placeholder name that
// is not on NUMBER_PLACEHOLDERS is seen by neither. SEEN_BY_HAND records the listed keys a review
// found that way; an unlisted one stays unseen.
//
// A plural form is exempt from the net: the same scan proves that src names no plural form
// (`x.one`, `x.other`, …) at all, so each form is picked by `tCount`, which takes the base and
// asks the language's own rule. A form picked by hand (`n === 1 ? t('x.one') : t('x.other')`) is
// wrong in Russian for 2 or 21. A key built on a plural base written out in a template literal or
// by `+` (`` `x.${form}` ``, `'x.' + form`) counts as one too; a key built from a base held in a
// variable is not seen.
// =================================================================================================

/** Placeholder names that carry a number in every key that uses them (reviewed 2026-11-12). */
const NUMBER_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'count', 'n', 'm', 'k', 'total', 'done', 'failed', 'shown', 'covered', 'dropped', 'scanned',
  'unparsed', 'decided', 'required', 'served', 'rejected', 'hidden', 'chunks', 'tokens', 'layers',
  'gpuLayers', 'page', 'min', 'max', 'pct', 'tps', 'ttft', 'seconds', 'mbps', 'gb', 'ram', 'vram',
  'budget', 'need', 'needed', 'spill', 'margin', 'working', 'sum', 'size', 'received', 'amount', 'port'
])

/** Functions in src/ that turn a number into display text (`fmtDate`/`fmtDateTime` excluded). */
const NUMBER_FORMATTERS =
  /^(fmt(?!Date|Time)\w*|gb|gbOf|vramGb|marginGb|secondsOf|formatSize|amountText|shown|Number|parseInt|parseFloat)$/

/** Methods that format a number. A Date's `toLocaleString` would count too: use `fmtDateTime`. */
const NUMBER_METHODS: ReadonlySet<string> = new Set(['toLocaleString', 'toFixed', 'toPrecision'])

const ARITHMETIC: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken
])
const EITHER_SIDE: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken
])

/** A placeholder that a call site fills with a number. */
interface NumberBinding {
  key: string
  placeholder: string
  /** `file:line` of the call or table. */
  site: string
}

/** What the source scan finds in one file. */
interface KeyUse {
  /** Every placeholder of a `catalog` key that the file fills with a number. */
  numbers: NumberBinding[]
  /** Every plural form of a `catalog` base that the file names in a string literal (or builds on a
   *  written-out base, `file:line base.…`), as `file:line key`. */
  pluralForms: string[]
}

/** Every placeholder of a `catalog` key that `sourceText` fills with a number. */
function numberBindings(fileName: string, sourceText: string, catalog: Catalog): NumberBinding[] {
  return keyUse(fileName, sourceText, catalog).numbers
}

/** One parse of `sourceText` against the keys of `catalog` (its plural bases included). */
function keyUse(fileName: string, sourceText: string, catalog: Catalog): KeyUse {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let e = expression
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isSatisfiesExpression(e)
    ) {
      e = e.expression
    }
    return e
  }
  // The initializer of the variable `id` names: the nearest enclosing block that declares it; a
  // parameter of that name ends the search (its value is unknown here).
  const initializerOf = (id: ts.Identifier): ts.Expression | undefined => {
    for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
      if (ts.isFunctionLike(node) && node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text)) {
        return undefined
      }
      const statements =
        ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseOrDefaultClause(node)
          ? node.statements
          : []
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === id.text) return declaration.initializer
        }
      }
    }
    return undefined
  }
  const isNumber = (expression: ts.Expression, hops = 0): boolean => {
    const e = unwrap(expression)
    if (ts.isNumericLiteral(e)) return true
    if (ts.isPrefixUnaryExpression(e)) return e.operator !== ts.SyntaxKind.ExclamationToken
    if (ts.isBinaryExpression(e)) {
      const operator = e.operatorToken.kind
      if (ARITHMETIC.has(operator)) return true
      if (EITHER_SIDE.has(operator)) return isNumber(e.left, hops) || isNumber(e.right, hops)
      return operator === ts.SyntaxKind.AmpersandAmpersandToken && isNumber(e.right, hops)
    }
    if (ts.isConditionalExpression(e)) return isNumber(e.whenTrue, hops) || isNumber(e.whenFalse, hops)
    if (ts.isPropertyAccessExpression(e)) return e.name.text === 'length' || e.name.text === 'size'
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression)
      if (ts.isIdentifier(callee)) {
        // `String(n)` is a number; `String(err)` is an error message.
        if (callee.text === 'String') return e.arguments.length > 0 && isNumber(e.arguments[0], hops)
        return NUMBER_FORMATTERS.test(callee.text)
      }
      if (!ts.isPropertyAccessExpression(callee)) return false
      const math = ts.isIdentifier(callee.expression) && callee.expression.text === 'Math'
      return math || NUMBER_METHODS.has(callee.name.text)
    }
    if (ts.isIdentifier(e) && hops < 2) {
      const initializer = initializerOf(e)
      return initializer !== undefined && isNumber(initializer, hops + 1)
    }
    return false
  }
  const keysOf = (expression: ts.Expression): string[] => {
    const e = unwrap(expression)
    if (ts.isStringLiteralLike(e)) return Object.hasOwn(catalog, e.text) ? [e.text] : []
    if (ts.isConditionalExpression(e)) return [...keysOf(e.whenTrue), ...keysOf(e.whenFalse)]
    return []
  }
  const objectOf = (expression: ts.Expression, hops = 0): ts.ObjectLiteralExpression | undefined => {
    const e = unwrap(expression)
    if (ts.isObjectLiteralExpression(e)) return e
    if (!ts.isIdentifier(e) || hops >= 2) return undefined
    const initializer = initializerOf(e)
    return initializer === undefined ? undefined : objectOf(initializer, hops + 1)
  }
  const entriesOf = (object: ts.ObjectLiteralExpression, hops = 0): Array<[string, ts.Expression]> =>
    object.properties.flatMap((property): Array<[string, ts.Expression]> => {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        return [[property.name.text, property.initializer]]
      }
      if (ts.isShorthandPropertyAssignment(property)) return [[property.name.text, property.name]]
      if (ts.isSpreadAssignment(property) && hops < 2) {
        const spread = objectOf(property.expression)
        return spread === undefined ? [] : entriesOf(spread, hops + 1)
      }
      return []
    })
  const siteOf = (at: ts.Node): string =>
    `${fileName}:${source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1}`
  const bases: ReadonlySet<string> = new Set(pluralBases(new Set(Object.keys(catalog))))
  const pluralForms: string[] = []
  const bindings: NumberBinding[] = []
  const record = (keys: readonly string[], params: ts.ObjectLiteralExpression, at: ts.Node): void => {
    const site = siteOf(at)
    for (const key of keys) {
      const names = new Set(placeholders(catalog[key]).map((p) => p.slice(1, -1)))
      for (const [name, value] of entriesOf(params)) {
        if (names.has(name) && isNumber(value)) bindings.push({ key, placeholder: name, site })
      }
    }
  }
  const isPlus = (n: ts.Node | undefined): n is ts.BinaryExpression =>
    n !== undefined && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken
  // The text a template literal, or the outermost `+` of a chain, starts with before its first
  // value that isn't a string literal (parentheses and casts seen through).
  const staticHead = (n: ts.Node): string | undefined => {
    if (ts.isTemplateExpression(n)) return n.head.text
    if (!isPlus(n)) return undefined
    let parent = n.parent
    while (parent !== undefined && ts.isParenthesizedExpression(parent)) parent = parent.parent
    if (isPlus(parent)) return undefined
    const operands: ts.Expression[] = []
    const flatten = (e: ts.Expression): void => {
      const u = unwrap(e)
      if (isPlus(u)) {
        flatten(u.left)
        flatten(u.right)
      } else operands.push(u)
    }
    flatten(n)
    let head = ''
    for (const operand of operands) {
      if (!ts.isStringLiteralLike(operand)) break
      head += operand.text
    }
    return head
  }
  const propertyOf = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined =>
    object.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name
    )?.initializer
  const visit = (node: ts.Node): void => {
    // Any string literal, wherever it stands (a call, a conditional, a variable, a key table), and
    // any form, the ones English lacks (`.few`) included: a plural form named in src is one that
    // `tCount` did not pick.
    if (ts.isStringLiteralLike(node) && isPluralFormOf(bases, node.text)) {
      pluralForms.push(`${siteOf(node)} ${node.text}`)
    }
    // A key built on a plural base written out (`` `${base}.${n === 1 ? 'one' : 'other'}` ``,
    // `'base.' + form`, `'base' + '.' + form`) is a form picked by hand too: it typechecks
    // without a cast. Only the static head is known, so any key built under a plural base counts
    // (src builds none).
    const head = staticHead(node)
    if (head !== undefined && [...bases].some((base) => head.startsWith(`${base}.`))) {
      pluralForms.push(`${siteOf(node)} ${head}…`)
    }
    if (ts.isCallExpression(node)) {
      // The key is the first argument (`t(key, …)`) or the second (`t(lang, key, …)`), and the
      // params object comes after it.
      node.arguments.slice(0, 2).forEach((argument, index) => {
        const keys = keysOf(argument)
        if (keys.length === 0) return
        for (const later of node.arguments.slice(index + 1)) {
          const params = objectOf(later)
          if (params !== undefined) record(keys, params, node)
        }
      })
    } else if (ts.isObjectLiteralExpression(node)) {
      // `{ key: 'coverage.tree.partial', params: { covered, total } }` tables (CoverageMeter.tsx).
      const key = propertyOf(node, 'key')
      const params = propertyOf(node, 'params')
      const object = params === undefined ? undefined : objectOf(params)
      if (key !== undefined && object !== undefined) record(keysOf(key), object, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { numbers: bindings, pluralForms }
}

// One parse of src/ serves every row below (the result is read, never changed).
let srcScan: KeyUse | undefined

function srcKeyUse(): KeyUse {
  if (srcScan !== undefined) return srcScan
  const srcRoot = join(process.cwd(), 'src')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry.name) && !isCatalogPath(path)) files.push(path)
    }
  }
  walk(srcRoot)
  expect(files.length).toBeGreaterThan(100) // the walk really saw the tree
  const uses = files.map((file) =>
    keyUse(relative(srcRoot, file).split('\\').join('/'), readFileSync(file, 'utf8'), en)
  )
  srcScan = { numbers: uses.flatMap((use) => use.numbers), pluralForms: uses.flatMap((use) => use.pluralForms) }
  return srcScan
}

const srcNumbers = (): NumberBinding[] => srcKeyUse().numbers

/** Every English key the net finds showing a number, with what says so (call sites or a placeholder name). */
function keysShowingANumber(): Map<string, string[]> {
  const evidence = new Map<string, string[]>()
  const add = (key: string, why: string): void => {
    evidence.set(key, [...(evidence.get(key) ?? []), why])
  }
  for (const { key, placeholder, site } of srcNumbers()) add(key, `${site} {${placeholder}}`)
  for (const [key, value] of Object.entries(en)) {
    for (const name of placeholders(value).map((p) => p.slice(1, -1))) {
      if (NUMBER_PLACEHOLDERS.has(name)) add(key, `{${name}}`)
    }
  }
  return evidence
}

const PLURAL_BASES: ReadonlySet<string> = new Set(pluralBases(new Set(Object.keys(en))))
const isPluralForm = (key: string): boolean => isPluralFormOf(PLURAL_BASES, key)

/**
 * Plain keys that show a number, grouped by what keeps them right in every language. Where a
 * reason says what the translations other than English and German must do, it is a requirement
 * on every such catalog, today's and any added later. An English or German sentence that read
 * wrong at exactly 1 ("1 sections scanned", the kind the "(1 core)" fix corrected) now states its
 * count label-first too (#806, open-issues wave owner call G-5); LABEL_FIRST_AT_ONE below names
 * those keys and the row under it holds them to that shape. They stay listed here: they still show
 * a number with no plural pair.
 */
const NON_GRAMMATICAL: Readonly<Record<string, { reason: string; keys: readonly MessageKey[] }>> = {
  parenthetical: {
    reason:
      'A bare count in parentheses, after a colon or after "×", or "… and {count} more" with no noun: ' +
      'nothing agrees with it in English or German. The translations must keep a shape in which ' +
      'nothing does ("… and {count} more" without a word for "other" that agrees: "и ещё {count}").',
    keys: [
      'chat.sources.toggle',
      'docs.askSelected',
      'docs.reindexAll',
      'docs.retryAllFailed',
      'docs.ocr.scannedPages', // #575: "…: {count} of {total}."
      'analysis.listing.item',
      'skills.bankAnalysis.transactionsMore',
      'skills.invoiceAnalysis.positionsMore',
      'skills.redactionRouting.scan',
      'models.library.showVariants',
      'models.library.hideVariants',
      'main.dialog.openLink.truncated', // #236: "characters not shown: {hidden}."
      'common.labelValue' // #804: "{label}: {value}", a review decision's count after the colon
    ]
  },
  ratio: {
    reason:
      '"{done} of {total}" with no noun and no participle: nothing agrees with either figure. The ' +
      'translations must keep it that way (a Russian one with a verbal noun: "Переиндексация: {done} ' +
      'из {total}").',
    keys: ['docs.reindexAllProgress', 'docs.previewModal.segmentProgress', 'translate.file.progress']
  },
  ordinal: {
    reason:
      'The number is a label (page, item, part or model n of m): the noun before it stays singular in ' +
      'every language, and the translations must keep the noun before the number ("Page {page}"). A ' +
      'page range has its own key, so its plural is fixed.',
    keys: [
      'chat.sources.page',
      'docs.previewModal.page',
      'analysis.listing.refPage',
      'analysis.listing.refSection',
      'models.checkingProgress',
      'gate.finishing.progress',
      'main.translation.failedWindowNotice',
      'main.translation.missingPageNotice',
      'main.translation.missingPageRangeNotice',
      'review.evidence.linkingItem',
      'review.item.aria',
      'review.selection.surfaceAria'
    ]
  },
  identifier: {
    reason: 'An identifier (a port, a citation index), not a quantity: nothing agrees with it.',
    keys: [
      'chat.sources.marker',
      'settings.localApi.status.port',
      'settings.localApi.error.portInUse',
      'diag.app.onPort'
    ]
  },
  unitSymbol: {
    reason:
      'The figure stands before a unit symbol (GB, MB/s, s, %, tok/s) or is a formatted size that ' +
      'carries one: a symbol never inflects, whatever the decimals. The translations must write a ' +
      'unit expression such as "tokens / s" as a symbol too.',
    keys: [
      'chat.noModel.startingProgress',
      // "tokens" follows a "k" figure of at least 2k (the window): plural in every language.
      'chat.context.usageTooltip',
      'models.library.memory',
      'models.usesSpace',
      'models.download.progress',
      'models.download.progressNoTotal',
      'models.download.titled',
      'models.engine.progress',
      'ocr.install.progress',
      'models.ram.needs',
      'models.ram.machine',
      'models.badge.ramNeeded',
      'common.percent',
      'perf.report.otherComputer',
      'perf.model.need',
      'perf.model.needEstimate',
      'perf.model.gpuEstimate',
      'perf.model.partialEstimate',
      'perf.model.cpu',
      'perf.model.cpuEstimate',
      'perf.model.unified',
      'perf.model.unifiedEstimate',
      'perf.model.tooLarge',
      'perf.models.row',
      'perf.models.card',
      'perf.models.cardReranker',
      'perf.models.ram',
      'perf.models.memory',
      'perf.tile.graphics.small',
      'perf.others.subGpu',
      'perf.observed.answer',
      'perf.observed.load',
      'perf.observed.check',
      'perf.others.row',
      'perf.others.sub',
      'perf.others.load',
      'perf.others.check',
      'main.benchmark.warnSlowRead',
      'packs.summary.size',
      'packs.tools.progress',
      'images.history.total',
      'images.history.clear.body'
    ]
  },
  amount: {
    reason: 'A money amount followed by its currency code, or a list of such amounts: nothing agrees with it.',
    keys: [
      'skills.bankAnalysis.unreconciledItem',
      'skills.bankAnalysis.totals',
      'skills.bankAnalysis.categoryItem',
      'skills.bankAnalysis.transactionItem',
      'skills.bankAnalysis.figureEcho',
      'skills.bankAnalysis.figureEchoIn',
      'skills.bankAnalysis.figureEchoOut',
      'skills.bankAnalysis.figureEchoNet',
      'skills.invoiceAnalysis.net',
      'skills.invoiceAnalysis.tax',
      'skills.invoiceAnalysis.taxWithRate',
      'skills.invoiceAnalysis.gross',
      'skills.invoiceAnalysis.positionItem',
      'skills.invoiceAnalysis.figureEchoNet',
      'skills.invoiceAnalysis.figureEchoTax',
      'skills.invoiceAnalysis.figureEchoGross'
    ]
  },
  constant: {
    reason:
      'The value is a compile-time constant (the password floor 8; the skill-import caps 64 and 16): ' +
      'every translation must write the form that fits that value.',
    keys: [
      'main.workspace.passwordTooShort',
      'main.workspace.newPasswordTooShort',
      'password.strength.minHint', // #805 S4: "{min}" is MIN_PASSWORD_LENGTH (passwordStrength)
      'skills.import.note.listTruncated',
      'skills.import.note.localizedTooMany'
    ]
  },
  evidencePack: {
    reason:
      'Renders only inside an evidence pack, which is written in English or German (UI-languages owner ' +
      'call D-5 (b)); no other language carries packExport.* keys (UI-languages owner call D-14 (a)). ' +
      'Every pack line is a label ("Item {n}") or states its count after one ("Outstanding follow-ups: ' +
      '{count}", "Required items decided: {decided} of {required}", #806), so nothing agrees with it at 1.',
    keys: [
      'packExport.meta.formatValue',
      'packExport.meta.formatValuePdf',
      'packExport.summary.progress',
      'packExport.summary.followUps',
      'packExport.item.number',
      'packExport.evidence.page',
      'packExport.coverage.inputStatement'
    ]
  },
  labelFirstNoun: {
    reason:
      'A noun after the figure ("tokens", "sections", "layers") agrees with it in every language. The ' +
      'translations other than English and German must put the noun first as a label ' +
      '("Tokens: {tokens}"), or write a unit symbol where the figure has decimals ' +
      '("{tps} tok/s"). English and German keep the noun after the figure only where it cannot be 1 ' +
      '(the Performance and benchmark figures, a page count of at least 2); where it can, they put ' +
      'the noun first too ("Sections scanned: {scanned}", #806). One exception is left as it is ' +
      '(#806, open-issues wave owner call G-5): chat.speed.line reads "1 tokens" after a one-token answer.',
    keys: [
      'chat.speed.line',
      // The count is at least 2 here (a single page has its own sentence, ocrNotes.ts), so en/de/fr/es/it
      // read right; Russian "на всех 21 странице" is singular, so the ru translation must be label-first.
      'docs.ocr.unsure.all',
      'coverage.extract.whole',
      'coverage.extract.wholeUnparsed',
      'coverage.extract.sections',
      'coverage.extract.sectionsUnparsed',
      'perf.verdict.speed',
      'perf.tile.speed.chunks',
      'perf.model.gpu',
      'perf.observed.answerSub',
      'diag.bench.tokensOver',
      // Cannot be a pair: stored in English and re-rendered from the captured figure (displayMap.ts).
      'main.benchmark.warnRecommendationLowered'
    ]
  },
  labelFirstOf: {
    reason:
      '"{a} of {b} <noun>": the noun follows {b}. With b of at least 2 it is plural in en/de/fr/es/it, ' +
      'but Russian takes the genitive singular after 21, 31, …, and b = 1 needs the singular everywhere. ' +
      'The translations other than English and German must put the noun first ("Sections: {covered} ' +
      'of {total}"). English and German keep the noun after {b} only where b is at least 2 (a deep ' +
      'index in progress, the OCR page counts, the layer counts); where b can be 1 they put it first ' +
      'too ("Based on sections: {covered} of {total}", #806).',
    keys: [
      // #576/#538: these two render only when the total is at least 2 (ocrNotes.ts).
      'docs.previewModal.ocrInfoPartial',
      'docs.ocr.unsure.some',
      'coverage.relevance.counted',
      'coverage.tree.partial',
      'perf.model.partial',
      'perf.model.partialFree',
      'perf.model.partialMargin',
      'perf.model.partialMarginNoWorking',
      'perf.models.split',
      'translate.device.gpu',
      'translate.device.gpuPartial',
      'translate.device.gpuNone'
    ]
  },
  labelFirstSentence: {
    reason:
      'The count governs a noun, and often a verb, inside a sentence, which agrees with it in every ' +
      'language. The translations other than English and German must state the count label-first ' +
      '("Transactions read: **{count}**"), and English and German do so too wherever the count can ' +
      'be 1 (#806). Three keep the count inside the English and German sentence because it never ' +
      'meets 1 there: skills.analysis.selectOne (two or more documents in scope), packs.addPartial ' +
      '(a partial add has at least one added and one failed archive) and review.evidence.shownCount ' +
      '(shown only while more sources remain).',
    keys: [
      'skills.bankAnalysis.count',
      'skills.bankAnalysis.countPartial',
      'skills.bankAnalysis.countContradicted',
      'skills.bankAnalysis.unverifiedCaveat',
      'skills.invoiceAnalysis.count',
      'skills.invoiceAnalysis.countPartial',
      'skills.analysis.scopeNarrowed',
      'skills.analysis.selectOne',
      'skills.analysis.selectTwo',
      'packs.addPartial',
      'review.evidence.shownCount',
      'analysis.listing.coverageWhole',
      'analysis.listing.coverageSections',
      'analysis.listing.empty'
    ]
  },
  noParticiple: {
    reason:
      'A bare figure before a participle or a verb ("{n} failed", "{gb} GB read", "{free} is free"). ' +
      'English and German do not inflect these ("1 failed", "1 fehlgeschlagen"); other ' +
      'languages can, so the other translations must use a label or an impersonal form ' +
      '("failed: {n}", "lecture de {gb} GB").',
    keys: [
      'docs.reindexAllCancelled',
      'docs.reindexAllPartial',
      'analysis.listing.unparsedSuffix',
      'diag.localApi.running',
      'perf.tile.drive.load',
      'perf.tile.drive.hash',
      'perf.observed.loadSub',
      'perf.observed.checkSub',
      'diag.bench.effectiveReadLoad',
      'diag.bench.effectiveReadHash',
      'chat.packs.outcome.summary',
      'review.progress',
      'review.summary.gateHint',
      'main.download.notEnoughSpace'
    ]
  }
}

/**
 * #806 (open-issues wave owner call G-5): the NON_GRAMMATICAL keys whose count can be exactly 1 and
 * whose English and German sentence used to put a word after it ("I read 1 transactions", "Read
 * across 1 sections scanned", "the other 1 document(s)"). Both catalogs now state these counts
 * label-first, as the other eight already did. Only these keys, not their whole groups:
 * `chat.speed.line` ("{tokens} tokens") stays as it is (open-issues wave G-5), and the rest never
 * meet 1 (each group's reason says why).
 */
const LABEL_FIRST_AT_ONE: readonly MessageKey[] = [
  'skills.bankAnalysis.count',
  'skills.bankAnalysis.countPartial',
  'skills.bankAnalysis.countContradicted',
  'skills.bankAnalysis.unverifiedCaveat',
  'skills.invoiceAnalysis.count',
  'skills.invoiceAnalysis.countPartial',
  'skills.analysis.scopeNarrowed',
  'skills.analysis.selectTwo',
  'analysis.listing.coverageWhole',
  'analysis.listing.coverageSections',
  'analysis.listing.empty',
  'coverage.extract.whole',
  'coverage.extract.wholeUnparsed',
  'coverage.extract.sections',
  'coverage.extract.sectionsUnparsed',
  'coverage.relevance.counted',
  'packExport.summary.progress',
  'packExport.coverage.inputStatement'
]

/** Listed keys the net cannot see, and how their number reaches them (reviewed by hand, 2026-11-12). */
const SEEN_BY_HAND: Readonly<Partial<Record<MessageKey, string>>> = {
  'skills.bankAnalysis.figureEcho': '{figures} joins the figureEcho* fragments, whose amounts the net sees',
  'skills.redactionRouting.scan': 'six counts read from a `counts` record (redaction.ts)',
  'settings.localApi.error.portInUse': '{suggestion} is String(suggestPort(port)), a port number',
  'main.translation.missingPageRangeNotice': '{from} and {to} are page numbers (gap.from, gap.to)',
  'packExport.meta.formatValue': '{version} is the pack schema version number',
  'packExport.meta.formatValuePdf': '{version} is the pack schema version number'
}

describe('CODE-8 net: a key that shows a number is a plural pair or on the reviewed list', () => {
  const catalog: Catalog = {
    'a.count': 'Files: {n}',
    'a.value': 'Value {value}',
    'a.size': 'Uses {size}',
    'a.when': 'Saved {when}',
    'a.reason': 'Failed ({reason})'
  }

  it.each<[string, string, string[]]>([
    ['a .length', "t('a.count', { n: files.length })", ['a.count {n}']],
    ['the main-process translator', "tMain('a.value', { value: (bytes / 1e9).toFixed(1) })", ['a.value {value}']],
    ['the key in second place', "t(lang, 'a.value', { value: n.toLocaleString(lang) })", ['a.value {value}']],
    ['a number formatter', "s('a.size', { size: fmtDiskSize(bytes, lang) })", ['a.size {size}']],
    ['String of a number', "deps.t('a.value', { value: String(rows.length) })", ['a.value {value}']],
    ['Math', "t('a.value', { value: Math.round(x) })", ['a.value {value}']],
    ['a variable, one hop back', "const total = rows.length\nt('a.count', { n: total })", ['a.count {n}']],
    ['a shorthand property', "const n = rows.length\nt('a.count', { n })", ['a.count {n}']],
    ['a spread object', "const p = { n: rows.length }\nt('a.count', { ...p })", ['a.count {n}']],
    ['a params variable', "const params = { n: rows.length }\nctx.tr('a.count', params)", ['a.count {n}']],
    ['a key/params table', "const row = { key: 'a.count', params: { n: rows.length } }", ['a.count {n}']],
    [
      'either key of a conditional',
      "t(ok ? 'a.count' : 'a.value', { n: 1, value: 2 })",
      ['a.count {n}', 'a.value {value}']
    ],
    ['a call in JSX', "export const A = () => <p>{t('a.count', { n: list.length })}</p>", ['a.count {n}']],
    ['no number in a date formatter', "t('a.when', { when: fmtDate(at, lang) })", []],
    ['no number in String of an error', "t('a.reason', { reason: String(err) })", []],
    [
      'no number in a same-named variable of another function',
      "function f() { const raw = rows.length }\nfunction g(err) { const raw = String(err); t('a.reason', { reason: raw }) }",
      []
    ],
    ['no number in a parameter', "function g(n) { t('a.count', { n }) }", []],
    ['no number in a property the text does not show', "t('a.when', { when: at, n: 3 })", []],
    ['no key that is not in the catalog', "t('no.such.key', { n: 3 })", []],
    ['nothing in a comment', "// t('a.count', { n: files.length })\nconst x = 1", []]
  ])('the source scan sees %s', (_title, code, found) => {
    const fileName = code.includes('<p>') ? 'fixture.tsx' : 'fixture.ts'
    expect(numberBindings(fileName, code, catalog).map((b) => `${b.key} {${b.placeholder}}`)).toEqual(found)
  })

  // A plural pair, a plain key named under its base, and a plain key that only ends in ".other"
  // (`packs.addFailed.other` is real and has no `.one`).
  const pluralCatalog: Catalog = {
    'b.files.one': '{count} file',
    'b.files.other': '{count} files',
    'b.files.none': 'No files',
    'packs.addFailed.other': 'The archive could not be added.'
  }

  it.each<[string, string, string[]]>([
    [
      'a form picked by a conditional',
      "t(n === 1 ? 'b.files.one' : 'b.files.other', { count: n })",
      ['fixture.ts:1 b.files.one', 'fixture.ts:1 b.files.other']
    ],
    [
      'a form picked around two calls',
      "n === 1 ? t('b.files.one', { count: n }) : t('b.files.other', { count: n })",
      ['fixture.ts:1 b.files.one', 'fixture.ts:1 b.files.other']
    ],
    ['a form in the main-process translator', "tMain('b.files.other', { count: n })", ['fixture.ts:1 b.files.other']],
    ['a form with the language first', "t(lang, 'b.files.one', { count: 1 })", ['fixture.ts:1 b.files.one']],
    ['a form English lacks', "t('ru', 'b.files.few' as MessageKey, { count: 2 })", ['fixture.ts:1 b.files.few']],
    ['a form in a variable', "const key = 'b.files.other'\nctx.tr(key, { count: n })", ['fixture.ts:1 b.files.other']],
    ['a form in a key table', "const KEYS = { many: 'b.files.other', none: 'b.files.none' }", ['fixture.ts:1 b.files.other']],
    ['a form in a key/params row', "const row = {\n  key: 'b.files.one',\n  params: { count: 1 }\n}", ['fixture.ts:2 b.files.one']],
    [
      'a form picked in a template literal',
      "t(`b.files.${n === 1 ? 'one' : 'other'}`, { count: n })",
      ['fixture.ts:1 b.files.…']
    ],
    ['a form built by concatenation', "t('b.files.' + form, { count: n })", ['fixture.ts:1 b.files.…']],
    ['a form built from the base and a dot', "t('b.files' + '.' + (n === 1 ? 'one' : 'other'), { count: n })", ['fixture.ts:1 b.files.…']],
    ['a form spelled out in two literals', "t(('b.files' + '.one') as MessageKey, { count: 1 })", ['fixture.ts:1 b.files.one…']],
    ['no form in a template that only shares a base’s prefix', 't(`b.filesize.${unit}`)', []],
    ['no form in tCount, which takes the base', "tCount(lang, 'b.files', n)", []],
    ["no form in the renderer's bound tCount", "const { tCount } = useT()\ntCount('b.files', n)", []],
    ['no form in a plain key named under a base', "t('b.files.none')", []],
    ['no form in a plain key that only ends in .other', "t('packs.addFailed.other')", []],
    ['nothing in a comment', "// t('b.files.one', { count: 1 })\nconst x = 1", []]
  ])('plural forms named in the source: %s', (_title, code, found) => {
    expect(keyUse('fixture.ts', code, pluralCatalog).pluralForms).toEqual(found)
  })

  it('src names no plural form: tCount picks every form by the language’s own rule', () => {
    expect(
      srcKeyUse().pluralForms,
      'a plural form is named outside tCount, so it is picked by hand (n === 1 ? …one : …other), which ' +
        'is wrong in a language with more forms (Russian: 2, 21). Render the pair with tCount(lang, base, ' +
        'n) (in the renderer, tCount from useT()); the main process has only tMain today: add a ' +
        'tCountMain to src/main/services/i18n.ts.'
    ).toEqual([])
  })

  it('every key that shows a number is a .one/.other pair or on NON_GRAMMATICAL', () => {
    const listed = new Set<string>(Object.values(NON_GRAMMATICAL).flatMap((group) => group.keys))
    // A plural form is exempt: the row above proves src names none, so `tCount` picks each one.
    const offenders = [...keysShowingANumber()]
      .filter(([key]) => !isPluralForm(key) && !listed.has(key))
      .map(([key, why]) => `${key} (${why.join(', ')})`)
      .sort()
    expect(
      offenders,
      'a plain key shows a number, so its words cannot follow the count. Make it a .one/.other pair ' +
        'rendered through tCount (the main process has only tMain today: add a tCountMain to ' +
        'src/main/services/i18n.ts), or, if no word agrees with the number in any registered language, ' +
        'add it to NON_GRAMMATICAL (tests/unit/i18n.test.ts) in the group whose reason holds for it. ' +
        'Never pair a figure shown with fraction digits: plural rules select by the digits shown ' +
        '(docs/architecture.md, i18n record §5).'
    ).toEqual([])
  })

  it('NON_GRAMMATICAL lists each key once, and only plain keys that exist and have a placeholder', () => {
    const all = Object.values(NON_GRAMMATICAL).flatMap((group) => group.keys)
    expect(
      all.filter((key, index) => all.indexOf(key) !== index),
      'listed in two groups'
    ).toEqual([])
    const values = en as Record<string, string>
    for (const key of all) {
      expect(values[key], `stale NON_GRAMMATICAL entry ${key}`).toBeDefined()
      expect(isPluralForm(key), `${key} is a plural form: take it off NON_GRAMMATICAL`).toBe(false)
      expect(placeholders(values[key]).length, `${key} shows no figure any more`).toBeGreaterThan(0)
    }
  })

  // #806: a count that can be 1 is followed by no word in English or German ("**1** transactions",
  // "1 sections scanned"), except "of"/"von" between two figures ("{decided} of {required}"), and no
  // word carries a plural crutch ("line(s)", "Dokument(e)", "Zeile(n)"). The lookahead keeps the
  // figure after "of" unconsumed, so "{a} of {b} sections" is still caught at {b}.
  it.each([
    ['en', en, 'of'],
    ['de', de, 'von']
  ] as const)('%s: the keys that can show 1 state the count label-first (#806)', (code, catalog, of) => {
    const values = catalog as Record<string, string>
    const offenders: string[] = []
    for (const key of LABEL_FIRST_AT_ONE) {
      const value = values[key]
      expect(value, `${code}: LABEL_FIRST_AT_ONE names ${key}, which is not in the catalog`).toBeDefined()
      const counts = placeholders(value).filter((p) => NUMBER_PLACEHOLDERS.has(p.slice(1, -1)))
      expect(counts.length, `${code}: ${key} shows no count: take it off LABEL_FIRST_AT_ONE`).toBeGreaterThan(0)
      for (const m of value.matchAll(/\{(\w+)\}\**\s+(\p{L}+)(?=(\s+\**\{\w+\})?)/gu)) {
        if (!NUMBER_PLACEHOLDERS.has(m[1]) || (m[2] === of && m[3] !== undefined)) continue
        offenders.push(`${key}: “${m[0]}”`)
      }
      for (const m of value.matchAll(/\p{L}\((?:e?s|e?n|e)\)/gu)) offenders.push(`${key}: “${m[0]}”`)
    }
    expect(
      offenders,
      `${code}: a word after a count that can be 1 agrees with it ("1 sections"), and a plural crutch ` +
        'reads wrong at every count. State the count label-first ("Line items: **{count}**", ' +
        `"Sections scanned: {scanned}"); "${of}" may stand only between two figures.`
    ).toEqual([])
  })

  it('the net finds every listed key except the reviewed hand-found ones', () => {
    // A listed key whose number went away (or one the net has learnt to see) fails here, so
    // the list cannot keep entries nobody needs.
    const seen = keysShowingANumber()
    const unseen = Object.values(NON_GRAMMATICAL)
      .flatMap((group) => group.keys)
      .filter((key) => !seen.has(key))
      .sort()
    expect(
      unseen,
      'listed keys the net does not see: drop the entry, or record in SEEN_BY_HAND how its number arrives'
    ).toEqual(Object.keys(SEEN_BY_HAND).sort())
  })
})
