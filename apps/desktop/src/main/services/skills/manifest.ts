// Main-side SKILL.md reader (skills plan §8.1) — the single point where the app reads a skill
// package off disk and runs the shared validator. Validation logic lives ONCE in
// `shared/skill-manifest.ts` (the source of validation truth); this wrapper only does I/O:
// read SKILL.md (and the optional, non-authoritative `manifest.json` cache), apply the
// env-resolved body cap, and hand both to the pure parser. Deps (the directory, the limits) are
// injected so it tests against a temp dir without Electron.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillMarkdown, type SkillParseResult } from '../../../shared/skill-manifest'
import { resolveSkillLimits, type SkillLimits } from './limits'

/** Parse a SKILL.md source string (the limit-aware entry point for callers that already hold it). */
export function parseSkillManifestSource(
  source: string,
  opts: { limits?: SkillLimits; manifestJson?: unknown } = {}
): SkillParseResult {
  const limits = opts.limits ?? resolveSkillLimits()
  return parseSkillMarkdown(source, { maxBodyChars: limits.maxBodyChars, manifestJson: opts.manifestJson })
}

/**
 * Read + validate the SKILL.md of a skill package directory. Reads the sibling `manifest.json`
 * when present (optional/non-authoritative — SKILL.md wins on conflict, DS2; a malformed cache
 * is silently ignored, never an error). Returns the same `SkillParseResult` the shared parser
 * produces, with a friendly error when SKILL.md is missing.
 */
export function parseSkillManifestFromDir(dir: string, opts: { limits?: SkillLimits } = {}): SkillParseResult {
  const skillMdPath = join(dir, 'SKILL.md')
  if (!existsSync(skillMdPath)) {
    return { ok: false, errors: ['SKILL.md was not found in the skill package'], notes: [] }
  }
  const source = readFileSync(skillMdPath, 'utf8')

  let manifestJson: unknown
  const manifestJsonPath = join(dir, 'manifest.json')
  if (existsSync(manifestJsonPath)) {
    try {
      manifestJson = JSON.parse(readFileSync(manifestJsonPath, 'utf8'))
    } catch {
      // Optional, non-authoritative cache — a malformed manifest.json is ignored (DS2), never fatal.
      manifestJson = undefined
    }
  }

  return parseSkillManifestSource(source, { limits: opts.limits, manifestJson })
}
