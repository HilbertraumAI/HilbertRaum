import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  de,
  en,
  resolveUiLanguage,
  t,
  tCount,
  type MessageKey
} from '../../src/shared/i18n'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

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

  it('falls back to the English string when a param is missing in a non-English render', () => {
    // The unresolved placeholder stays literal — visible in dev, never a crash.
    expect(t('de', 'home.docsReady.other')).toBe('{count} documents ready to ask about')
  })

  it('U1/ux-10: the extract coverage badge is softened from "Every match found" (overclaim) to "Read"', () => {
    // "Every match found" asserted the EXTRACTION was exhaustive — a small model / unusual layout can miss
    // a match. The honest claim is that every section was READ, not that every match was captured.
    for (const key of ['coverage.extract.whole', 'coverage.extract.sections'] as MessageKey[]) {
      // Supply the {scanned} param so the REAL German renders — without it, a missing param makes `t('de')`
      // fall back to English, and the negative assertion would inspect English (vacuously passing).
      expect(t('en', key, { scanned: 3 })).not.toMatch(/every match/i)
      expect(t('en', key, { scanned: 3 })).toMatch(/read/i)
      expect(t('de', key, { scanned: 3 })).not.toMatch(/jeder treffer/i)
      expect(t('de', key, { scanned: 3 })).toMatch(/gelesen/i)
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

  it("'system' resolves de-prefixed locales to German, everything else to English", () => {
    expect(resolveUiLanguage('system', 'de')).toBe('de')
    expect(resolveUiLanguage('system', 'de-DE')).toBe('de')
    expect(resolveUiLanguage('system', 'de-AT')).toBe('de')
    expect(resolveUiLanguage('system', 'de_CH')).toBe('de')
    expect(resolveUiLanguage('system', 'DE-DE')).toBe('de')
    expect(resolveUiLanguage('system', 'en-US')).toBe('en')
    expect(resolveUiLanguage('system', 'fr-FR')).toBe('en')
    // A locale merely STARTING with the letters 'de' is not German.
    expect(resolveUiLanguage('system', 'dv')).toBe('en')
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

describe('German typography — quotation marks (design-guidelines §7 "Typography")', () => {
  // German quotes are „…“ — an opening „ closed with an ASCII " is a visible typo in shipped
  // copy (it rendered as `Durchsuchbar machen (OCR)"` on the Images empty state). The guard is
  // over the CATALOG VALUES only: the file's own comments are not shipped copy, and technical
  // field names inside notes ("{field}", "language") legitimately keep straight ASCII pairs.
  const opens = (s: string): number => (s.match(/„/g) ?? []).length
  const closes = (s: string): number => (s.match(/“/g) ?? []).length

  it('closes every opening „ with “, never with an ASCII quote', () => {
    const offenders = (Object.entries(de) as [MessageKey, string][])
      .filter(([, value]) => opens(value) !== closes(value))
      .map(([key, value]) => `${key}: ${value}`)
    expect(
      offenders,
      'German values with an unbalanced „…“ pair — close them with “ (U+201C), not "'
    ).toEqual([])
  })

  it('never uses “ as an OPENING quote (the pair is „…“, not “…”)', () => {
    // Walk the pairs per value: a closer may never appear before its opener.
    const offenders = (Object.entries(de) as [MessageKey, string][])
      .filter(([, value]) => {
        let depth = 0
        for (const ch of value) {
          if (ch === '„') depth++
          else if (ch === '“' && --depth < 0) return true
        }
        return false
      })
      .map(([key]) => key)
    expect(offenders, '“ used before its „ — German opens low, closes high').toEqual([])
  })

  it('the strings the sweep corrected read with German closers', () => {
    expect(de['images.avail.ocrPointer']).toContain('„Durchsuchbar machen (OCR)“')
    expect(de['docs.task.extractBusyTitle']).toContain('„Liste alle…“')
    expect(de['docs.deepIndex.buildTitle']).toContain('„Liste alle …“')
    expect(de['docs.deepIndex.buildTitle']).toContain('„Summe pro Kategorie“')
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

describe('catalog hygiene (parity is otherwise enforced by typecheck)', () => {
  it('both catalogs carry the same keys with no empty values', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries({ ...en, ...de })) {
      expect(value.trim().length, `empty value for ${key}`).toBeGreaterThan(0)
    }
  })

  it('placeholder sets match per key (a {name} in English exists in German too)', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(placeholders(de[key]), `placeholder mismatch in ${key}`).toEqual(
        placeholders(en[key])
      )
    }
  })

  it('CODE-8 net: every {count}/{done} key consumed via plain t() is on the reviewed non-grammatical list', () => {
    // full-audit 2026-07-11 CODE-8 (task 2): the plural class must not regress. A key whose
    // value interpolates {count} (or the {done} progress twin) and is consumed via plain
    // t() can render broken grammar the moment a call site passes 1 ("Retry 1 failed
    // documents?"). Every such key must either be a .one/.other pair consumed via tCount,
    // or sit on this reviewed list of counts that never inflect (parenthetical counts,
    // "{done} of {total}" progress forms, pre-formatted figures). Adding a NEW plain-t()
    // consumer of a counting key fails here — pluralize it or justify it below.
    const NON_GRAMMATICAL: ReadonlySet<string> = new Set([
      'chat.sources.toggle', // "Sources ({count})" — parenthetical
      'docs.askSelected', // "Ask these documents ({count})" — parenthetical
      'docs.reindexAll', // "Re-index all ({count})" — parenthetical
      'docs.retryAllFailed', // "Retry all ({count})" — parenthetical
      'docs.reindexAllProgress', // "Re-indexing {done} of {total}…" — no noun inflects
      'docs.reindexAllCancelled', // "… {done} of {total} done."
      'docs.reindexAllPartial', // "{done} of {total} — {failed} failed."
      'translate.file.progress', // "Translating… ({done}/{total})"
      'models.tech.contextValue', // "{count} tokens" — pre-formatted figure, window ≥ 512
      'models.context.autoResolved', // the same pre-formatted figure in the Auto label
      // " ({count} cores)" — a single-core machine would read "(1 cores)"; registered as a
      // residual in the remediation plan's discoveries, deliberately not fixed in Phase G.
      'diag.bench.cores'
    ])
    // Scan the shipped source for plain `t('key'` consumptions (bound renderer t and the
    // shared t(lang, …) form differ in shape — the latter never matches `t('`). The read is
    // NUL-tolerant by construction (utf8 readFileSync): analysis/extract.ts carries a
    // literal NUL byte until CODE-24 lands in Phase H.
    const srcRoot = join(process.cwd(), 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(p)
      }
    }
    walk(srcRoot)
    expect(files.length).toBeGreaterThan(100) // sanity: the walk really saw the tree

    const catalog = en as Record<string, string>
    const offenders = new Set<string>()
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) {
        const key = m[1]
        const value = catalog[key]
        if (value === undefined) continue // dynamic/derived keys are out of static reach
        if (!/\{count\}|\{done\}/.test(value)) continue
        if (!NON_GRAMMATICAL.has(key)) offenders.add(key)
      }
    }
    expect(
      [...offenders].sort(),
      'plain-t()-consumed {count}/{done} keys — switch them to tCount with .one/.other variants (CODE-8) or justify them on the list above'
    ).toEqual([])

    // Teeth for the allowlist itself: every entry still exists and still counts — a renamed
    // or de-counted key must be pruned here, not silently ignored.
    for (const key of NON_GRAMMATICAL) {
      expect(catalog[key], `stale allowlist entry ${key}`).toBeDefined()
      expect(/\{count\}|\{done\}/.test(catalog[key]), `allowlisted key no longer counts: ${key}`).toBe(true)
    }
  })

  it('every .one plural key has its .other partner and vice versa (tCount contract)', () => {
    // Key parity is asserted above, so checking the English key set covers both catalogs.
    // A trailing ".other" alone is not proof of a plural ('models.section.other' is a
    // section name) — a plural variant is one that interpolates {count}.
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
