import { describe, it, expect } from 'vitest'
import {
  formatSkillNote,
  parseSkillMarkdown,
  validateSkillManifest,
  SKILL_V1_PERMISSION_CEILING,
  SKILL_ID_RE,
  type SkillManifest
} from '../../src/shared/skill-manifest'

// A minimal valid frontmatter object (as parsed from YAML), mutable via overrides.
function rawFront(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bank-statement',
    title: 'Bank Statement Analysis',
    description: 'Use when the user wants to extract or summarize transactions from bank statements.',
    version: '1.0.0',
    author: 'HilbertRaum',
    language: 'en',
    kind: 'instruction',
    ...overrides
  }
}

// Build a full SKILL.md document from a frontmatter object + body.
function skillMd(front: Record<string, unknown>, body = 'Do the thing carefully.'): string {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`
}

describe('validateSkillManifest', () => {
  it('accepts a well-formed manifest and fills defaults', () => {
    const res = validateSkillManifest(rawFront())
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.manifest?.id).toBe('bank-statement')
    expect(res.manifest?.kind).toBe('instruction')
    expect(res.manifest?.language).toBe('en')
    // Permissions default to the v1 ceiling when absent.
    expect(res.manifest?.permissions).toEqual(SKILL_V1_PERMISSION_CEILING)
    expect(res.manifest?.allowedTools).toEqual([])
    expect(res.manifest?.triggers).toEqual({ keywords: [], mimeTypes: [], filenamePatterns: [] })
  })

  it('rejects a non-object', () => {
    const res = validateSkillManifest('nope')
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })

  it.each(['id', 'title', 'description', 'version'])('reports a missing required field: %s', (field) => {
    const raw = rawFront()
    delete raw[field]
    const res = validateSkillManifest(raw)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes(`"${field}"`))).toBe(true)
  })

  it.each([
    ['UpperCase', false],
    ['-leading-dash', false],
    ['has space', false],
    ['has/slash', false],
    ['a', false], // too short (min 2)
    ['ok', true],
    ['bank-statement-2', true],
    ['a'.repeat(63), true],
    ['a'.repeat(64), false] // too long (max 63)
  ])('validates id pattern %s', (id, valid) => {
    expect(SKILL_ID_RE.test(id)).toBe(valid)
    const res = validateSkillManifest(rawFront({ id }))
    expect(res.ok).toBe(valid)
  })

  it.each([
    ['1.0.0', true],
    ['0.1.29', true],
    ['1.0', false],
    ['1', false],
    ['1.0.0-beta', false],
    ['v1.0.0', false]
  ])('validates semver %s', (version, valid) => {
    const res = validateSkillManifest(rawFront({ version }))
    expect(res.ok).toBe(valid)
  })

  it('rejects an unknown kind, accepts tool, defaults to instruction', () => {
    expect(validateSkillManifest(rawFront({ kind: 'wizard' })).ok).toBe(false)
    expect(validateSkillManifest(rawFront({ kind: 'tool' })).manifest?.kind).toBe('tool')
    const raw = rawFront()
    delete raw.kind
    expect(validateSkillManifest(raw).manifest?.kind).toBe('instruction')
  })

  it('rejects an over-long title and a multi-line title', () => {
    expect(validateSkillManifest(rawFront({ title: 'x'.repeat(81) })).ok).toBe(false)
    expect(validateSkillManifest(rawFront({ title: 'line1\nline2' })).ok).toBe(false)
  })

  it('ignores unknown frontmatter fields', () => {
    const res = validateSkillManifest(rawFront({ futureField: 'whatever', another: 42 }))
    expect(res.ok).toBe(true)
    expect((res.manifest as unknown as Record<string, unknown>).futureField).toBeUndefined()
  })

  describe('permission clamping (DS6 — restrict-only, never elevate)', () => {
    it('clamps documents above the ceiling down to selected_only with a note', () => {
      const res = validateSkillManifest(rawFront({ permissions: { documents: 'all' } }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.permissions.documents).toBe('selected_only')
      expect(res.notes.some((n) => n.includes('documents') && n.includes('clamped'))).toBe(true)
    })

    it('clamps network to denied even when "allowed" is declared', () => {
      const res = validateSkillManifest(rawFront({ permissions: { network: 'allowed' } }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.permissions.network).toBe('denied')
      expect(res.notes.some((n) => n.includes('network'))).toBe(true)
    })

    it('clamps filesystem above the ceiling down to skill_resources_only', () => {
      const res = validateSkillManifest(rawFront({ permissions: { filesystem: 'workspace' } }))
      expect(res.manifest?.permissions.filesystem).toBe('skill_resources_only')
    })

    it('honors a more-restrictive declared value (never elevates it)', () => {
      const res = validateSkillManifest(rawFront({ permissions: { documents: 'none', filesystem: 'none' } }))
      expect(res.manifest?.permissions.documents).toBe('none')
      expect(res.manifest?.permissions.filesystem).toBe('none')
      expect(res.manifest?.permissions.network).toBe('denied')
    })

    it('treats an unrecognized value as the v1 default with a note (never above ceiling)', () => {
      const res = validateSkillManifest(rawFront({ permissions: { documents: 'banana' } }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.permissions.documents).toBe('selected_only')
      expect(res.notes.some((n) => n.includes('not recognized'))).toBe(true)
    })

    it('never echoes the raw (attacker-supplied) permission value into the note (S1, §22-M1)', () => {
      const secret = 'SECRET_PAYLOAD_xyz'
      const res = validateSkillManifest(rawFront({ permissions: { documents: secret } }))
      expect(res.ok).toBe(true)
      expect(res.notes.join('\n')).not.toContain(secret) // content-free — no IPC-payload leak
    })
  })

  it('bounds an over-long / over-count trigger list (S2 — ReDoS source-length cap)', () => {
    const longPattern = '*'.repeat(5000) // a pathological glob source
    const many = Array.from({ length: 200 }, (_, i) => `kw${i}`)
    const res = validateSkillManifest(rawFront({ triggers: { keywords: many, filenamePatterns: [longPattern] } }))
    expect(res.ok).toBe(true)
    expect(res.manifest!.triggers.keywords.length).toBeLessThanOrEqual(64) // count cap
    expect(res.manifest!.triggers.filenamePatterns).toEqual([]) // the 5000-char pattern is dropped
    expect(res.notes.some((n) => n.includes('too long') || n.includes('more entries'))).toBe(true)
  })

  it('accepts but ignores allowedTools for an instruction skill (with a note), but flags reservesTools', () => {
    const res = validateSkillManifest(rawFront({ allowedTools: ['extract_transactions'] }))
    expect(res.ok).toBe(true)
    // The effective list stays [] (an instruction skill cannot USE tools in v1)...
    expect(res.manifest?.allowedTools).toEqual([])
    expect(res.notes.some((n) => n.includes('allowedTools'))).toBe(true)
    // ...but the DECLARATION is preserved as a display signal (S9 / §13/§22-D1).
    expect(res.manifest?.reservesTools).toBe(true)
  })

  it('reservesTools is false when no tools are declared', () => {
    const res = validateSkillManifest(rawFront({}))
    expect(res.manifest?.reservesTools).toBe(false)
  })

  it('keeps allowedTools for a tool skill (and flags reservesTools)', () => {
    const res = validateSkillManifest(rawFront({ kind: 'tool', allowedTools: ['extract_transactions'] }))
    expect(res.manifest?.allowedTools).toEqual(['extract_transactions'])
    expect(res.manifest?.reservesTools).toBe(true)
  })

  it('ignores a self-declared trust field with a note', () => {
    const res = validateSkillManifest(rawFront({ trust: 'app' }))
    expect(res.ok).toBe(true)
    expect(res.notes.some((n) => n.toLowerCase().includes('trust'))).toBe(true)
    // No trust field leaks into the manifest.
    expect((res.manifest as unknown as Record<string, unknown>).trust).toBeUndefined()
  })

  it('validates compatibility.minAppVersion as semver', () => {
    expect(validateSkillManifest(rawFront({ compatibility: { minAppVersion: '0.1.29' } })).manifest
      ?.compatibility.minAppVersion).toBe('0.1.29')
    expect(validateSkillManifest(rawFront({ compatibility: { minAppVersion: 'soon' } })).ok).toBe(false)
  })

  // Audit C2: triggers + compatibility MUST survive parsing so they reach the cached manifest_json.
  it('preserves triggers and compatibility into the manifest (audit C2)', () => {
    const res = validateSkillManifest(
      rawFront({
        compatibility: { minAppVersion: '0.1.29' },
        triggers: {
          keywords: ['bank statement', 'reconcile'],
          mimeTypes: ['application/pdf'],
          filenamePatterns: ['*statement*']
        }
      })
    )
    expect(res.ok).toBe(true)
    expect(res.manifest?.compatibility.minAppVersion).toBe('0.1.29')
    expect(res.manifest?.triggers).toEqual({
      keywords: ['bank statement', 'reconcile'],
      mimeTypes: ['application/pdf'],
      filenamePatterns: ['*statement*']
    })
  })

  it('parses a per-locale localized title/description override (additive display block, §16)', () => {
    const res = validateSkillManifest(
      rawFront({
        localized: {
          de: {
            title: 'Kontoauszug-Analyse',
            description: 'Verwenden, wenn Transaktionen aus einem Kontoauszug extrahiert werden sollen.'
          }
        }
      })
    )
    expect(res.ok).toBe(true)
    expect(res.manifest?.localized).toEqual({
      de: {
        title: 'Kontoauszug-Analyse',
        description: 'Verwenden, wenn Transaktionen aus einem Kontoauszug extrahiert werden sollen.'
      }
    })
  })

  it('localized: a locale key is lower-cased, and a title-only / description-only entry is kept', () => {
    const res = validateSkillManifest(
      rawFront({ localized: { DE: { title: 'Nur Titel' }, fr: { description: 'Seulement la description' } } })
    )
    expect(res.ok).toBe(true)
    expect(res.manifest?.localized).toEqual({
      de: { title: 'Nur Titel' },
      fr: { description: 'Seulement la description' }
    })
  })

  it('localized: ignores a malformed/blank/over-long override leniently (note, never an error)', () => {
    const res = validateSkillManifest(
      rawFront({
        localized: {
          de: { title: '   ', description: 'x'.repeat(9999) }, // blank title + over-long desc → both dropped
          es: 'not-a-mapping' // wrong shape → dropped
        }
      })
    )
    expect(res.ok).toBe(true) // never fatal
    expect(res.manifest?.localized).toBeUndefined() // nothing valid survived
    expect(res.notes.length).toBeGreaterThan(0)
  })

  it('localized: a multi-line override title is rejected (display strings stay single-line)', () => {
    const res = validateSkillManifest(rawFront({ localized: { de: { title: 'Zeile 1\nZeile 2' } } }))
    expect(res.ok).toBe(true)
    expect(res.manifest?.localized).toBeUndefined()
  })

  it('localized: absent block ⇒ undefined (no overrides)', () => {
    const res = validateSkillManifest(rawFront())
    expect(res.manifest?.localized).toBeUndefined()
  })

  // SKA-35 (audit 2026-07-03, U7): notes are emitted as stable CODES + app-fixed params alongside
  // the fixed English strings, and the `localized.<key>` family DROPS the raw locale key (bounded
  // attacker-chosen text that used to be interpolated into the preview payload).
  describe('structured note codes (SKA-35)', () => {
    it('noteCodes parallels notes, and formatSkillNote reproduces each string exactly', () => {
      const res = validateSkillManifest(
        rawFront({
          permissions: { documents: 'all' },
          allowedTools: ['extract_transactions'],
          localized: { de: 'not-a-mapping' },
          trust: 'app'
        })
      )
      expect(res.ok).toBe(true)
      expect(res.noteCodes).toHaveLength(res.notes.length)
      expect(res.notes.length).toBeGreaterThanOrEqual(4)
      for (let i = 0; i < res.notes.length; i++) {
        expect(formatSkillNote(res.noteCodes![i])).toBe(res.notes[i])
      }
      expect(res.noteCodes!.map((n) => n.code)).toEqual(
        expect.arrayContaining(['permissionClamped', 'allowedToolsIgnored', 'localizedEntryInvalid', 'trustIgnored'])
      )
    })

    it('the localized-family notes NEVER echo the attacker-chosen locale key (canary)', () => {
      const canary = 'EVIL_LOCALE_7bd2'
      const res = validateSkillManifest(
        rawFront({
          localized: {
            [canary]: 'not-a-mapping',
            de: { title: 'x'.repeat(200) } // over-long → ignored-title note
          }
        })
      )
      expect(res.ok).toBe(true)
      // Both entries produce notes — the entry note and the ignored-title note — with NO key echoed.
      expect(res.noteCodes!.map((n) => n.code)).toEqual(
        expect.arrayContaining(['localizedEntryInvalid', 'localizedTitleIgnored'])
      )
      expect(JSON.stringify(res.notes) + JSON.stringify(res.noteCodes)).not.toContain(canary)
    })

    it('locales past the 16-cap are dropped WITH a note now (previously silent)', () => {
      const many = Object.fromEntries(
        Array.from({ length: 18 }, (_, i) => [`l${i}`, { title: `Title ${i}` }])
      )
      const res = validateSkillManifest(rawFront({ localized: many }))
      expect(res.ok).toBe(true)
      expect(Object.keys(res.manifest!.localized ?? {})).toHaveLength(16)
      const tooMany = res.noteCodes!.find((n) => n.code === 'localizedTooMany')
      expect(tooMany).toBeDefined()
      expect(tooMany!.params).toEqual({ max: 16 })
    })

    it('noteCodes ride parseSkillMarkdown too (validation + manifest.json conflicts)', () => {
      const res = parseSkillMarkdown(skillMd(rawFront({ permissions: { network: 'allowed' } })), {
        manifestJson: { id: 'bank-statement', version: '9.9.9', title: 'Stale' }
      })
      expect(res.ok).toBe(true)
      expect(res.noteCodes).toHaveLength(res.notes.length)
      const codes = res.noteCodes!.map((n) => n.code)
      expect(codes).toContain('permissionClamped')
      expect(codes.filter((c) => c === 'manifestJsonConflict')).toHaveLength(2) // version + title
    })
  })

  // SKA-45 (rider, U7): Unicode bidi direction controls in display fields are refused — an
  // RTL-override title renders reordered in the picker (cosmetic spoofing).
  describe('bidi direction controls in display fields (SKA-45)', () => {
    const RLO = String.fromCharCode(0x202e) // U+202E RIGHT-TO-LEFT OVERRIDE (built via code — T1 convention)
    it('rejects a title carrying a bidi control', () => {
      const res = validateSkillManifest(rawFront({ title: `Totally${RLO}fine skill` }))
      expect(res.ok).toBe(false)
      expect(res.errors.some((e) => e.includes('direction-control'))).toBe(true)
    })

    it('ignores a localized title carrying a bidi control (lenient note path)', () => {
      const res = validateSkillManifest(rawFront({ localized: { de: { title: `Titel${RLO}!` } } }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.localized).toBeUndefined()
      expect(res.noteCodes!.map((n) => n.code)).toContain('localizedTitleIgnored')
    })

    it('a plain title without controls stays accepted (no over-reject)', () => {
      expect(validateSkillManifest(rawFront({ title: 'Ganz normale Überschrift — ok' })).ok).toBe(true)
    })

    // Review hardening: `language` is also displayed (the detail pane) — a bidi control or an
    // embedded newline falls to the lenient default instead of rendering.
    it('a language value carrying a bidi control / newline falls back to "en" with a note', () => {
      for (const bad of [`de${RLO}`, 'de\nen']) {
        const res = validateSkillManifest(rawFront({ language: bad }))
        expect(res.ok).toBe(true)
        expect(res.manifest?.language).toBe('en')
        expect(res.noteCodes!.map((n) => n.code)).toContain('languageInvalid')
      }
    })
  })

  it('accepts snake_case trigger subfields', () => {
    const res = validateSkillManifest(
      rawFront({ triggers: { mime_types: ['text/csv'], filename_patterns: ['*kontoauszug*'] } })
    )
    expect(res.manifest?.triggers.mimeTypes).toEqual(['text/csv'])
    expect(res.manifest?.triggers.filenamePatterns).toEqual(['*kontoauszug*'])
  })

  it('ignores malformed triggers leniently (note, not error)', () => {
    const res = validateSkillManifest(rawFront({ triggers: { keywords: 'not-a-list' } }))
    expect(res.ok).toBe(true)
    expect(res.manifest?.triggers.keywords).toEqual([])
    expect(res.notes.length).toBeGreaterThan(0)
  })

  // D6 (skills-s13-plan.md §2.1): triggers.autoFire is additive + lenient. Only an explicit boolean
  // `true` opts the skill in as an auto-fire candidate; everything else is `false` (never an error).
  it('parses triggers.autoFire: true (the auto-fire eligibility opt-in, D6)', () => {
    const res = validateSkillManifest(rawFront({ triggers: { keywords: ['bank'], autoFire: true } }))
    expect(res.ok).toBe(true)
    expect(res.manifest?.triggers.autoFire).toBe(true)
  })

  it('triggers.autoFire absent/false ⇒ not opted in (undefined), additive (no manifest_json change)', () => {
    // Absent: a skill that doesn't declare it is never a candidate, and its manifest is byte-unchanged.
    expect(validateSkillManifest(rawFront({ triggers: { keywords: ['bank'] } })).manifest?.triggers.autoFire)
      .toBeUndefined()
    // Explicit false: same posture (left undefined — the `=== true` gate reads it as not opted in).
    expect(
      validateSkillManifest(rawFront({ triggers: { keywords: ['bank'], autoFire: false } })).manifest?.triggers
        .autoFire
    ).toBeUndefined()
  })

  it('triggers.autoFire: a non-boolean is clamped to false leniently (note, never an error)', () => {
    const res = validateSkillManifest(rawFront({ triggers: { keywords: ['bank'], autoFire: 'yes' } }))
    expect(res.ok).toBe(true)
    expect(res.manifest?.triggers.autoFire).toBeUndefined()
    expect(res.notes.some((n) => n.includes('triggers.autoFire'))).toBe(true)
  })

  it('accepts snake_case auto_fire', () => {
    expect(
      validateSkillManifest(rawFront({ triggers: { keywords: ['bank'], auto_fire: true } })).manifest?.triggers
        .autoFire
    ).toBe(true)
  })

  // A3 (audit §6.3/§8.2): the additive whole-document `analysis` engine field — additive + lenient,
  // honored ONLY for an instruction skill, absent/`none` ⇒ undefined (byte-unchanged cache).
  describe('analysis engine field (A3)', () => {
    it('parses analysis: whole-doc and compare on an instruction skill', () => {
      expect(validateSkillManifest(rawFront({ analysis: 'whole-doc' })).manifest?.analysis).toBe('whole-doc')
      expect(validateSkillManifest(rawFront({ analysis: 'compare' })).manifest?.analysis).toBe('compare')
    })

    it('absent ⇒ undefined (the top-k default; no manifest_json churn)', () => {
      expect(validateSkillManifest(rawFront()).manifest?.analysis).toBeUndefined()
    })

    it('explicit analysis: none ⇒ undefined (byte-identical to an omission)', () => {
      const res = validateSkillManifest(rawFront({ analysis: 'none' }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.analysis).toBeUndefined()
    })

    it('an unrecognized value is dropped leniently with a note (never an error)', () => {
      const res = validateSkillManifest(rawFront({ analysis: 'summarize-everything' }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.analysis).toBeUndefined()
      expect(res.notes.some((n) => n.includes('"analysis"'))).toBe(true)
    })

    it('a non-string value is dropped leniently with a note', () => {
      const res = validateSkillManifest(rawFront({ analysis: 42 }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.analysis).toBeUndefined()
      expect(res.notes.some((n) => n.includes('"analysis"'))).toBe(true)
    })

    it('is IGNORED for a tool skill (whole-doc behaviour is app-owned) — note, not an error (SEC-1)', () => {
      const res = validateSkillManifest(rawFront({ kind: 'tool', analysis: 'whole-doc' }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.analysis).toBeUndefined()
      expect(res.notes.some((n) => n.includes('"analysis" is ignored for a tool skill'))).toBe(true)
    })

    it('case-insensitive value (WHOLE-DOC) normalizes', () => {
      expect(validateSkillManifest(rawFront({ analysis: 'WHOLE-DOC' })).manifest?.analysis).toBe('whole-doc')
    })
  })
})

describe('parseSkillMarkdown', () => {
  it('parses a full SKILL.md (frontmatter + body)', () => {
    const res = parseSkillMarkdown(skillMd(rawFront(), '# Rules\n\nNever invent totals.'))
    expect(res.ok).toBe(true)
    expect(res.manifest?.id).toBe('bank-statement')
    expect(res.body).toBe('# Rules\n\nNever invent totals.')
  })

  it('handles a leading BOM and CRLF line endings', () => {
    const doc = '﻿---\r\nid: ok-skill\r\ntitle: Ok\r\ndescription: A fine skill.\r\nversion: 1.0.0\r\n---\r\nBody here.\r\n'
    const res = parseSkillMarkdown(doc)
    expect(res.ok).toBe(true)
    expect(res.manifest?.id).toBe('ok-skill')
    expect(res.body).toBe('Body here.')
  })

  it('rejects a document with no frontmatter', () => {
    const res = parseSkillMarkdown('# Just a markdown file\n\nNo frontmatter.')
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('frontmatter'))).toBe(true)
  })

  it('rejects an empty source', () => {
    expect(parseSkillMarkdown('').ok).toBe(false)
    expect(parseSkillMarkdown('   \n  ').ok).toBe(false)
  })

  it('rejects an empty body', () => {
    const res = parseSkillMarkdown(skillMd(rawFront(), '   '))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('body'))).toBe(true)
  })

  it('rejects a body over the maxBodyChars cap', () => {
    const big = 'x'.repeat(100)
    const res = parseSkillMarkdown(skillMd(rawFront(), big), { maxBodyChars: 50 })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('body'))).toBe(true)
  })

  it('reports a YAML parse error friendly', () => {
    const doc = '---\nid: ok\n  bad: : indent:\n---\nBody.'
    const res = parseSkillMarkdown(doc)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('YAML'))).toBe(true)
  })

  // SKA-31 (audit 2026-07-03, U7) — the YAML canary sentinel. The yaml package's pretty errors quote
  // the offending source line in a code frame, so `String(err)` would embed raw attacker-supplied
  // frontmatter in the error string — a loaded gun against the §22-M1 content-free rule the moment any
  // consumer logs/surfaces it (SKA-32 does). The existing sentinel (above, permission notes) covers
  // notes only; this one covers the PARSE-error path. TEETH: revert the fixed-message fix (back to
  // `String(err)`) → the canary appears in the error and both assertions fail.
  it('a YAML parse error NEVER echoes the frontmatter source (canary sentinel, SKA-31)', () => {
    const canary = 'CANARY_FRONTMATTER_9f31c'
    // An unterminated double-quoted scalar carrying the canary — parseYaml throws, and the yaml
    // package's default pretty error would include a code frame quoting this exact line.
    const doc = `---\nid: ok\ntitle: "${canary}\n---\nBody.`
    const res = parseSkillMarkdown(doc)
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
    const all = JSON.stringify(res)
    expect(all).not.toContain(canary)
    // The structural message is fixed English + at most numeric line/column coordinates.
    expect(res.errors.some((e) => /^SKILL\.md frontmatter is not valid YAML( \(line \d+(, column \d+)?\))?$/.test(e))).toBe(true)
  })

  it('resolves a manifest.json conflict to SKILL.md with a note (DS2)', () => {
    const res = parseSkillMarkdown(skillMd(rawFront({ version: '2.0.0' })), {
      manifestJson: { id: 'bank-statement', version: '1.0.0', title: 'Stale Title' }
    })
    expect(res.ok).toBe(true)
    expect(res.manifest?.version).toBe('2.0.0') // SKILL.md wins
    expect(res.manifest?.title).toBe('Bank Statement Analysis')
    expect(res.notes.some((n) => n.includes('manifest.json') && n.includes('version'))).toBe(true)
    expect(res.notes.some((n) => n.includes('manifest.json') && n.includes('title'))).toBe(true)
  })

  it('does not note a manifest.json that agrees', () => {
    const res = parseSkillMarkdown(skillMd(rawFront()), {
      manifestJson: { id: 'bank-statement', version: '1.0.0', title: 'Bank Statement Analysis' }
    })
    expect(res.notes.some((n) => n.includes('manifest.json'))).toBe(false)
  })
})

// Round-trip guard: a parsed manifest JSON-serializes and deserializes unchanged, so the S3
// cache (skills.manifest_json) can store/restore it without losing triggers/compatibility (C2).
describe('manifest cache round-trip (audit C2)', () => {
  it('survives JSON.stringify/parse with triggers + compatibility intact', () => {
    const res = parseSkillMarkdown(
      skillMd(
        rawFront({
          compatibility: { minAppVersion: '0.1.29' },
          triggers: { keywords: ['iban'], mimeTypes: ['text/csv'], filenamePatterns: ['*x*'] }
        })
      )
    )
    expect(res.ok).toBe(true)
    const restored = JSON.parse(JSON.stringify(res.manifest)) as SkillManifest
    expect(restored).toEqual(res.manifest)
    expect(restored.triggers.keywords).toEqual(['iban'])
    expect(restored.compatibility.minAppVersion).toBe('0.1.29')
  })

  it('survives JSON.stringify/parse with triggers.autoFire intact (D6 cache round-trip)', () => {
    const res = parseSkillMarkdown(
      skillMd(rawFront({ triggers: { keywords: ['bank statement'], mimeTypes: ['application/pdf'], autoFire: true } }))
    )
    expect(res.ok).toBe(true)
    const restored = JSON.parse(JSON.stringify(res.manifest)) as SkillManifest
    expect(restored).toEqual(res.manifest)
    expect(restored.triggers.autoFire).toBe(true)
  })

  it('survives JSON.stringify/parse with analysis intact (A3 cache round-trip)', () => {
    const res = parseSkillMarkdown(skillMd(rawFront({ analysis: 'compare' })))
    expect(res.ok).toBe(true)
    const restored = JSON.parse(JSON.stringify(res.manifest)) as SkillManifest
    expect(restored).toEqual(res.manifest)
    expect(restored.analysis).toBe('compare')
  })
})
