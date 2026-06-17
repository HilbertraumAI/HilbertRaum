import { describe, it, expect } from 'vitest'
import {
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
})
