// Skill package loader (skills plan §8.1, revised §0 — ONE mode).
//
// Because skills are now plain folders for BOTH sources (app-skills/ + user-skills/), there is a
// single load path: "read the folder". This is a thin, source-agnostic wrapper over S2's
// `parseSkillManifestFromDir` (the single SKILL.md read+validate point) — there is no decrypt,
// no transient, no shred (DS11 revoked). It resolves a registry record's stored folder basename
// against the appropriate source directory and reads its SKILL.md (manifest + injected body).

import { join } from 'node:path'
import { statSync } from 'node:fs'
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

// ---- Per-turn parse cache (perf) ------------------------------------------------------------
//
// `resolveTurnSkill` calls `loadSkillPackage` on the chat hot path for EVERY turn an active skill
// shapes, and the read+YAML-parse+validate is pure work that only changes when SKILL.md changes on
// disk. Measured ~0.65 ms/turn from an OS-cached SSD for a ~1.5 KB bundled skill — and HilbertRaum
// runs from a PORTABLE DRIVE where a per-turn read can cost far more, while a large user skill (cap
// 64 KB) re-parses + re-sizes every turn. We cache the parsed result keyed by the SKILL.md's
// (mtime, size) so an edit on disk (DS1/DS2 — disk is the source of truth) re-parses on the next
// turn, but an unchanged skill is a `statSync` + map hit. Content-class clean: the cache holds only
// the already-parsed manifest+body in memory, nothing is logged/audited (§22-M1). The reconcile /
// installer paths call `parseSkillManifestFromDir` DIRECTLY (not through here), so disk→DB
// reconciliation always reads fresh — only the per-turn load is cached.
interface ParseCacheEntry {
  mtimeMs: number
  size: number
  maxBodyChars: number | undefined
  result: SkillParseResult
}
const parseCache = new Map<string, ParseCacheEntry>()

/** Test/maintenance seam: drop all cached parses (e.g. between isolated unit tests). */
export function clearSkillParseCache(): void {
  parseCache.clear()
}

/**
 * Load a discovered skill from disk: read + validate its SKILL.md and return the manifest plus
 * the trimmed Markdown body (the instructions a later phase injects). The same one path serves
 * app and user skills (revised §0). A vanished/garbled folder surfaces as `ok: false` with a
 * friendly error, never a throw. Cached per-turn by the SKILL.md (mtime,size) — see above.
 */
export function loadSkillPackage(record: SkillRecord, opts: SkillLoadOptions): SkillParseResult {
  const dir = skillRecordDir(record, opts)
  const maxBodyChars = opts.limits?.maxBodyChars
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(join(dir, 'SKILL.md'))
  } catch {
    // Missing / unreadable SKILL.md: can't key the cache — defer to the parser's friendly
    // `ok:false` (and don't poison the cache with a transient mount/permission failure).
    return parseSkillManifestFromDir(dir, { limits: opts.limits })
  }
  const hit = parseCache.get(dir)
  if (
    hit &&
    hit.mtimeMs === st.mtimeMs &&
    hit.size === st.size &&
    hit.maxBodyChars === maxBodyChars
  ) {
    return hit.result
  }
  const result = parseSkillManifestFromDir(dir, { limits: opts.limits })
  parseCache.set(dir, { mtimeMs: st.mtimeMs, size: st.size, maxBodyChars, result })
  return result
}
