// Main-side SKILL.md reader (skills plan §8.1) — the single point where the app reads a skill
// package off disk and runs the shared validator. Validation logic lives ONCE in
// `shared/skill-manifest.ts` (the source of validation truth); this wrapper only does I/O:
// read SKILL.md (and the optional, non-authoritative `manifest.json` cache), apply the
// env-resolved body cap, and hand both to the pure parser. Deps (the directory, the limits) are
// injected so it tests against a temp dir without Electron.

import { existsSync, readFileSync, statSync } from 'node:fs'
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
  // S2 (full-audit-2026-06-30): the installer's stageZip/stageFolder enforce maxFileBytes,
  // but the DROP-IN read path (discoverSkillsInDir / loadSkillPackage) reached here with a
  // bare readFileSync + no size guard — an over-cap SKILL.md / manifest.json dropped into the
  // unencrypted user-skills/ would be read wholesale into the main process (and JSON-parsed)
  // on every reconcile / per chat turn (a local memory-exhaustion DoS). Mirror stageFolder:
  // statSync().size > maxFileBytes BEFORE each read — REJECT the authoritative SKILL.md (no
  // skill loads), SKIP the optional manifest.json cache (the same fate as a malformed one).
  const limits = opts.limits ?? resolveSkillLimits()
  const skillMdPath = join(dir, 'SKILL.md')
  // SKA-16 (audit 2026-07-03, U7): stat once with `throwIfNoEntry: false` and require a REAL file.
  // A DIRECTORY named SKILL.md (trivially created by hand-unpacking a zip) used to sail past
  // `existsSync` into an unguarded `readFileSync` — the EISDIR throw propagated through
  // `discoverSkillsInDir` and killed ALL reconciliation for the session. A non-file SKILL.md is
  // simply "no SKILL.md here" (structural, content-free). EACCES on the stat/read itself can still
  // throw — the discovery loop guards per folder (registry.ts).
  const st = statSync(skillMdPath, { throwIfNoEntry: false })
  if (!st || !st.isFile()) {
    return { ok: false, errors: ['SKILL.md was not found in the skill package'], notes: [] }
  }
  if (st.size > limits.maxFileBytes) {
    return { ok: false, errors: ['SKILL.md is larger than the allowed size'], notes: [] }
  }
  const source = readFileSync(skillMdPath, 'utf8')

  let manifestJson: unknown
  const manifestJsonPath = join(dir, 'manifest.json')
  if (existsSync(manifestJsonPath)) {
    try {
      // Skip the cache WITHOUT reading it when it is over-cap (statSync first). A malformed
      // OR oversized manifest.json is ignored (DS2), never fatal — SKILL.md is authoritative.
      if (statSync(manifestJsonPath).size <= limits.maxFileBytes) {
        manifestJson = JSON.parse(readFileSync(manifestJsonPath, 'utf8'))
      }
    } catch {
      manifestJson = undefined
    }
  }

  return parseSkillManifestSource(source, { limits, manifestJson })
}
