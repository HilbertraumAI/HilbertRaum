// Skill package size/shape caps (skills plan §6.4), modelled on `ingestion/limits.ts`.
//
// A skill `.skill.zip` / folder is attacker-supplied, unsigned, untrusted input (skills plan
// §9.2). These caps bound the work BEFORE the importer (S4) inflates or writes anything: an
// individual file, the total uncompressed package, the file count, path length, folder depth,
// and the SKILL.md body. They are deliberately generous for honest packages and every cap is
// env-overridable (the `ingestion/limits.ts` precedent) so a constrained machine or a power
// user can retune without a rebuild. The `maxBodyChars` default is shared with the parser
// (`shared/skill-manifest.ts`) so the body cap has one source of truth.

import { DEFAULT_SKILL_MAX_BODY_CHARS } from '../../../shared/skill-manifest'

/** The six skill-package resource ceilings (skills plan §6.4). */
export interface SkillLimits {
  /** Max size of any individual member file, in bytes. */
  maxFileBytes: number
  /** Max total UNCOMPRESSED package size, in bytes. */
  maxTotalBytes: number
  /** Max number of files in a package. */
  maxFiles: number
  /** Max length of any member path, in chars. */
  maxPathLen: number
  /** Max folder nesting depth. */
  maxDepth: number
  /** Max SKILL.md body length, in chars. */
  maxBodyChars: number
}

/**
 * Defaults (skills plan §6.4): 1 MiB / file, 8 MiB total, 200 files, 255-char paths, depth 4,
 * 64 KiB body. These mirror the malicious-document caps (security-model.md) and are far beyond
 * any honest instruction skill.
 */
export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFiles: 200,
  maxPathLen: 255,
  maxDepth: 4,
  maxBodyChars: DEFAULT_SKILL_MAX_BODY_CHARS
}

/** Parse a positive integer env override, falling back to `fallback` for absent/junk. */
function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Resolve the effective skill limits, applying env overrides over the defaults:
 * `HILBERTRAUM_SKILL_MAX_FILE_BYTES`, `HILBERTRAUM_SKILL_MAX_TOTAL_BYTES`,
 * `HILBERTRAUM_SKILL_MAX_FILES`, `HILBERTRAUM_SKILL_MAX_PATH_LEN`,
 * `HILBERTRAUM_SKILL_MAX_DEPTH`, `HILBERTRAUM_SKILL_MAX_BODY`.
 */
export function resolveSkillLimits(env: NodeJS.ProcessEnv = process.env): SkillLimits {
  return {
    maxFileBytes: envInt(env, 'HILBERTRAUM_SKILL_MAX_FILE_BYTES', DEFAULT_SKILL_LIMITS.maxFileBytes),
    maxTotalBytes: envInt(env, 'HILBERTRAUM_SKILL_MAX_TOTAL_BYTES', DEFAULT_SKILL_LIMITS.maxTotalBytes),
    maxFiles: envInt(env, 'HILBERTRAUM_SKILL_MAX_FILES', DEFAULT_SKILL_LIMITS.maxFiles),
    maxPathLen: envInt(env, 'HILBERTRAUM_SKILL_MAX_PATH_LEN', DEFAULT_SKILL_LIMITS.maxPathLen),
    maxDepth: envInt(env, 'HILBERTRAUM_SKILL_MAX_DEPTH', DEFAULT_SKILL_LIMITS.maxDepth),
    maxBodyChars: envInt(env, 'HILBERTRAUM_SKILL_MAX_BODY', DEFAULT_SKILL_LIMITS.maxBodyChars)
  }
}
