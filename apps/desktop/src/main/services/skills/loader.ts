// Skill package loader (skills plan §8.1, revised §0 — ONE mode).
//
// Because skills are now plain folders for BOTH sources (app-skills/ + user-skills/), there is a
// single load path: "read the folder". This is a thin, source-agnostic wrapper over S2's
// `parseSkillManifestFromDir` (the single SKILL.md read+validate point) — there is no decrypt,
// no transient, no shred (DS11 revoked). It resolves a registry record's stored folder basename
// against the appropriate source directory and reads its SKILL.md (manifest + injected body).

import { join } from 'node:path'
import type { SkillParseResult } from '../../../shared/skill-manifest'
import { parseSkillManifestFromDir } from './manifest'
import type { SkillLimits } from './limits'
import type { SkillRecord } from './registry'

export interface SkillLoadOptions {
  /** The app-skills directory (resolveAppSkillsDir) — needed for `source === 'app'` records. */
  appSkillsDir: string
  /** The user-skills directory (resolveUserSkillsDir) — needed for `source === 'user'` records. */
  userSkillsDir: string
  /** Optional resource caps; defaults to `resolveSkillLimits()` inside the parser. */
  limits?: SkillLimits
}

/** Absolute folder of a registry record (its source dir + the stored basename). */
export function skillRecordDir(record: SkillRecord, opts: SkillLoadOptions): string {
  const baseDir = record.source === 'app' ? opts.appSkillsDir : opts.userSkillsDir
  return join(baseDir, record.path)
}

/**
 * Load a discovered skill from disk: read + validate its SKILL.md and return the manifest plus
 * the trimmed Markdown body (the instructions a later phase injects). The same one path serves
 * app and user skills (revised §0). A vanished/garbled folder surfaces as `ok: false` with a
 * friendly error, never a throw.
 */
export function loadSkillPackage(record: SkillRecord, opts: SkillLoadOptions): SkillParseResult {
  return parseSkillManifestFromDir(skillRecordDir(record, opts), { limits: opts.limits })
}

/** Load a skill directly from a folder (the same one mode), for callers that already hold a dir. */
export function loadSkillFromDir(dir: string, opts: { limits?: SkillLimits } = {}): SkillParseResult {
  return parseSkillManifestFromDir(dir, opts)
}
