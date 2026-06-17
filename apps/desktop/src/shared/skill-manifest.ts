// Skill package schema + SKILL.md parser/validator (skills plan DS2 / §6 / §8.1).
//
// A Skill is a self-contained local package whose canonical metadata + instructions live
// in a single human-editable `SKILL.md` file: a YAML frontmatter block (metadata) followed
// by a Markdown body (the instructions injected into the prompt). This module is the SINGLE
// source of the skill *shape* and its parse/validate rules — placed in `shared/` so main (and
// any future renderer pre-check) share one definition, exactly like `shared/manifest.ts` for
// models. The authoritative *validation* still runs main-side (skills plan §8.1); this is the
// frozen type contract every later phase imports (skills plan §18.0-B).
//
// Parsing uses the pure-JS `yaml` package (boring, reliable, offline). The validator is
// hand-written so every field gets a precise, user-facing message, and so permission
// CLAMPING (restrict-only, never elevate — DS6) is explicit. This file is pure: no I/O, no
// Electron, no `node:fs` — the main-side wrapper (`services/skills/manifest.ts`) reads files
// and feeds them here.

import { parse as parseYaml } from 'yaml'

/** `instruction` ships in v1; `tool` is reserved for Tier-2 (skills plan §5/§6.5). */
export type SkillKind = 'instruction' | 'tool'
export const SKILL_KINDS: SkillKind[] = ['instruction', 'tool']

/**
 * Trust is APP-ASSIGNED, never self-declared (skills plan §6.5/§14): `app` = shipped + verified
 * product content, `user` = user-created/imported. It is therefore NOT part of the parsed
 * manifest — the type lives here for the registry (S3) to assign and for later phases to import.
 * A skill declaring its own `trust` in frontmatter is ignored (a note is emitted).
 */
export type SkillTrustedLevel = 'app' | 'user'
export const SKILL_TRUSTED_LEVELS: SkillTrustedLevel[] = ['app', 'user']

export type SkillDocumentsPermission = 'none' | 'selected_only'
export type SkillFilesystemPermission = 'none' | 'skill_resources_only'
/** v1 only ever resolves to `denied`; broader declared values are clamped (DS6). */
export type SkillNetworkPermission = 'denied'

/**
 * Declared *intent*, never self-granting (skills plan §6.7). In v1 these are an honest
 * SUMMARY string — nothing in a skill executes, so there is no live gate (DS6/§22-M4); real
 * enforcement arrives with Tier-2. The stored values are already CLAMPED to the v1 ceiling.
 */
export interface SkillPermissions {
  documents: SkillDocumentsPermission
  network: SkillNetworkPermission
  filesystem: SkillFilesystemPermission
}

/**
 * Drives the deterministic suggestion heuristic (skills plan §10). MUST survive parsing into
 * the manifest and (S3) into the cached `skills.manifest_json` — startup never unpacks a user
 * blob, so the selector can only read triggers from the cache (invariant, audit C2 / §22-C2).
 */
export interface SkillTriggers {
  keywords: string[]
  mimeTypes: string[]
  filenamePatterns: string[]
}

/** Optional compatibility gate; a skill needing a newer app is listed but disabled (§6.5). */
export interface SkillCompatibility {
  /** Minimum app version (semver) this skill requires. */
  minAppVersion?: string
}

/** A fully-validated, canonical skill manifest (parsed from SKILL.md frontmatter). */
export interface SkillManifest {
  id: string
  title: string
  description: string
  version: string
  author: string
  language: string
  kind: SkillKind
  compatibility: SkillCompatibility
  /** Effective (already clamped) permissions — never exceed the v1 ceiling (DS6). */
  permissions: SkillPermissions
  /** Tier-2 reserved; always `[]` for an `instruction` skill in v1. */
  allowedTools: string[]
  /**
   * True when the frontmatter DECLARED a non-empty tool list — i.e. the skill RESERVES Tier-2
   * tools, even though `allowedTools` is emptied for an instruction skill (the tools don't
   * execute in v1, §6.5). Lets the UI honestly show "tools arrive with Tier-2" for a
   * tool-reserved instruction stub (the bank-statement skill — skills plan §13/§22-D1). Optional/
   * additive (older cached manifest_json may lack it → treat as false). */
  reservesTools?: boolean
  triggers: SkillTriggers
}

/** Result of validating a pre-parsed frontmatter object. `notes` are non-fatal (clamps, ignores). */
export interface SkillManifestValidation {
  ok: boolean
  manifest?: SkillManifest
  errors: string[]
  notes: string[]
}

/** Result of parsing a whole SKILL.md (frontmatter + body). */
export interface SkillParseResult {
  ok: boolean
  manifest?: SkillManifest
  /** The trimmed Markdown body (the injected instructions). Present only when `ok`. */
  body?: string
  errors: string[]
  notes: string[]
}

export interface SkillParseOptions {
  /** Cap on the SKILL.md body length in chars (default `DEFAULT_SKILL_MAX_BODY_CHARS`). */
  maxBodyChars?: number
  /**
   * Optional, non-authoritative `manifest.json` cache. If present and it disagrees with
   * SKILL.md, SKILL.md wins and a note is logged — never an error (DS2 / §6.7).
   */
  manifestJson?: unknown
}

/** `^[a-z0-9]` then 1–62 of `[a-z0-9-]`: lowercase kebab, also a safe on-disk filename (§6.5). */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/
/** Strict semver core MAJOR.MINOR.PATCH (drives upgrade/downgrade comparison — §6.5/§9). */
export const SKILL_SEMVER_RE = /^\d+\.\d+\.\d+$/

/** Default SKILL.md body cap (64 KiB of chars). The `limits.ts` default references this. */
export const DEFAULT_SKILL_MAX_BODY_CHARS = 64 * 1024

const MAX_TITLE_LEN = 80
const MAX_DESCRIPTION_LEN = 280
const MAX_AUTHOR_LEN = 120
const MAX_LANGUAGE_LEN = 35

/**
 * The v1 permission ceiling for an instruction skill (skills plan §6.7). The effective
 * permission is `min(declared, ceiling)` per dimension — restrict-only, the `services/policy.ts`
 * "policy can only restrict" invariant applied per field. v1 can never elevate above this.
 */
export const SKILL_V1_PERMISSION_CEILING: SkillPermissions = {
  documents: 'selected_only',
  network: 'denied',
  filesystem: 'skill_resources_only'
}

/**
 * Build the human permission summary shown before an import is confirmed (skills plan §9.2/§15)
 * and carried on every `SkillInfo`/`SkillPreview`. STRUCTURAL ONLY — derived purely from the
 * (already-clamped) permission values, never from skill content/file names, so it is safe to log
 * or echo in an error payload (§22-M1). v1 instruction skills can only inject fenced text, so the
 * summary is reassuring by construction. Pure + shared so main computes it and the renderer
 * displays the same string without re-deriving.
 */
export function summarizeSkillPermissions(perms: SkillPermissions): string {
  const parts: string[] = []
  parts.push(
    perms.documents === 'selected_only'
      ? 'can read the documents you pick for a turn'
      : 'has no access to your documents'
  )
  parts.push(perms.network === 'denied' ? 'cannot access the network' : 'may access the network')
  parts.push(
    perms.filesystem === 'skill_resources_only'
      ? 'reads only its own bundled files'
      : 'has no file access'
  )
  // "A; B; C." — a calm, fixed-order sentence (no content interpolated).
  return parts.join('; ') + '.'
}

// Privilege ranks for clamping. A declared value above the ceiling is clamped DOWN (never up);
// an unrecognized value is treated as the v1 default posture (the ceiling) with a note — it can
// never exceed the ceiling either way. Ranks above the ceiling exist only so a too-broad request
// is recognized and clamped rather than silently accepted.
const DOC_RANK: Record<string, number> = { none: 0, selected_only: 1, all: 2, any: 2, all_documents: 2 }
const FS_RANK: Record<string, number> = { none: 0, skill_resources_only: 1, workspace: 2, all: 2, any: 2 }
const NET_RANK: Record<string, number> = { denied: 0, none: 0, local: 1, allowed: 2, any: 2 }

// canonicalByRank[rank] is the value name at that rank, capped at the ceiling. Index 0 is the
// most restrictive; the last index is the ceiling.
const DOC_BY_RANK: SkillDocumentsPermission[] = ['none', 'selected_only']
const FS_BY_RANK: SkillFilesystemPermission[] = ['none', 'skill_resources_only']
const NET_BY_RANK: SkillNetworkPermission[] = ['denied']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Clamp one declared permission to the v1 ceiling (restrict-only, DS6). Absent or unrecognized
 * → the ceiling (the default instruction-skill posture, which is itself the v1 max — never an
 * elevation). A recognized-but-broader value is clamped down with a note.
 */
function clampPermission(
  raw: unknown,
  field: string,
  rankMap: Record<string, number>,
  ceilingRank: number,
  canonicalByRank: string[],
  notes: string[]
): string {
  if (raw === undefined || raw === null) {
    return canonicalByRank[ceilingRank]
  }
  if (typeof raw !== 'string') {
    notes.push(`"permissions.${field}" should be a string; using the v1 default "${canonicalByRank[ceilingRank]}"`)
    return canonicalByRank[ceilingRank]
  }
  const key = raw.trim().toLowerCase()
  const rank = rankMap[key]
  if (rank === undefined) {
    notes.push(`"permissions.${field}" value "${raw}" is not recognized; using the v1 default "${canonicalByRank[ceilingRank]}"`)
    return canonicalByRank[ceilingRank]
  }
  const eff = Math.min(rank, ceilingRank)
  if (rank > ceilingRank) {
    notes.push(`"permissions.${field}" requested more than v1 allows; clamped to "${canonicalByRank[eff]}" (DS6)`)
  }
  return canonicalByRank[eff]
}

/** Coerce a YAML value into a trimmed string[]; non-array / non-string members → note + []. */
function stringArray(v: unknown, field: string, notes: string[]): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    notes.push(`"${field}" must be a list of strings; ignoring it`)
    return []
  }
  return (v as string[]).map((x) => x.trim()).filter((x) => x !== '')
}

/**
 * Validate a pre-parsed frontmatter object into a SkillManifest, collecting all errors. Pure
 * (no I/O) so it is trivial to unit-test. Unknown frontmatter keys are ignored (only known keys
 * are read). Multi-word keys accept both camelCase (the §6.6 canonical form) and snake_case.
 */
export function validateSkillManifest(raw: unknown): SkillManifestValidation {
  const errors: string[] = []
  const notes: string[] = []
  if (!isObject(raw)) {
    return {
      ok: false,
      errors: ['SKILL.md frontmatter must be a YAML mapping (key: value pairs)'],
      notes
    }
  }

  const strReq = (key: string): string => {
    const v = raw[key]
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`"${key}" is required and must be a non-empty string`)
      return ''
    }
    return v.trim()
  }

  const boundSingleLine = (key: string, value: string, maxLen: number): void => {
    if (value && value.length > maxLen) {
      errors.push(`"${key}" must be at most ${maxLen} characters`)
    }
    if (value && /[\r\n]/.test(value)) {
      errors.push(`"${key}" must be a single line`)
    }
  }

  const id = strReq('id')
  if (id && !SKILL_ID_RE.test(id)) {
    errors.push('"id" must be lowercase kebab-case (^[a-z0-9][a-z0-9-]{1,62}$): letters, digits, hyphens only')
  }

  const title = strReq('title')
  boundSingleLine('title', title, MAX_TITLE_LEN)

  const description = strReq('description')
  boundSingleLine('description', description, MAX_DESCRIPTION_LEN)

  const version = strReq('version')
  if (version && !SKILL_SEMVER_RE.test(version)) {
    errors.push('"version" must be semver MAJOR.MINOR.PATCH (e.g. 1.0.0)')
  }

  // Optional free-text author (display only, not a trust signal).
  let author = ''
  const authorRaw = raw['author']
  if (authorRaw !== undefined && authorRaw !== null) {
    if (typeof authorRaw !== 'string') {
      errors.push('"author" must be a string when present')
    } else {
      author = authorRaw.trim()
      boundSingleLine('author', author, MAX_AUTHOR_LEN)
    }
  }

  // Optional display language (BCP-47-ish; display/filtering only — does NOT change prompt
  // language, D-L6). Lenient: malformed → note + default 'en'.
  let language = 'en'
  const langRaw = raw['language']
  if (langRaw !== undefined && langRaw !== null) {
    if (typeof langRaw !== 'string' || langRaw.trim() === '' || langRaw.trim().length > MAX_LANGUAGE_LEN) {
      notes.push('"language" should be a short BCP-47 tag (e.g. en, de); using "en"')
    } else {
      language = langRaw.trim()
    }
  }

  // Optional kind; default instruction. If present it must be known (§9.2).
  let kind: SkillKind = 'instruction'
  const kindRaw = raw['kind']
  if (kindRaw !== undefined && kindRaw !== null) {
    if (typeof kindRaw !== 'string' || !SKILL_KINDS.includes(kindRaw as SkillKind)) {
      errors.push(`"kind" must be one of: ${SKILL_KINDS.join(', ')}`)
    } else {
      kind = kindRaw as SkillKind
    }
  }

  // Optional compatibility gate.
  const compatibility: SkillCompatibility = {}
  const compatRaw = raw['compatibility']
  if (compatRaw !== undefined && compatRaw !== null) {
    if (!isObject(compatRaw)) {
      errors.push('"compatibility" must be a mapping when present')
    } else {
      const minV = compatRaw['minAppVersion'] ?? compatRaw['min_app_version']
      if (minV !== undefined && minV !== null) {
        if (typeof minV !== 'string' || !SKILL_SEMVER_RE.test(minV.trim())) {
          errors.push('"compatibility.minAppVersion" must be semver MAJOR.MINOR.PATCH')
        } else {
          compatibility.minAppVersion = minV.trim()
        }
      }
    }
  }

  // Optional permissions — declared intent, clamped to the v1 ceiling (DS6). Absent ⇒ ceiling.
  let permissions: SkillPermissions = { ...SKILL_V1_PERMISSION_CEILING }
  const permRaw = raw['permissions']
  if (permRaw !== undefined && permRaw !== null) {
    if (!isObject(permRaw)) {
      errors.push('"permissions" must be a mapping when present')
    } else {
      permissions = {
        documents: clampPermission(permRaw['documents'], 'documents', DOC_RANK, 1, DOC_BY_RANK, notes) as SkillDocumentsPermission,
        network: clampPermission(permRaw['network'], 'network', NET_RANK, 0, NET_BY_RANK, notes) as SkillNetworkPermission,
        filesystem: clampPermission(permRaw['filesystem'], 'filesystem', FS_RANK, 1, FS_BY_RANK, notes) as SkillFilesystemPermission
      }
    }
  }

  // Optional allowedTools — Tier-2 reserved. For an instruction skill in v1 it is accepted but
  // the list is ignored with a note (skills plan §6.5).
  let allowedTools: string[] = []
  let reservesTools = false
  const toolsRaw = raw['allowedTools'] ?? raw['allowed_tools']
  if (toolsRaw !== undefined && toolsRaw !== null) {
    if (!Array.isArray(toolsRaw) || !toolsRaw.every((t) => typeof t === 'string')) {
      errors.push('"allowedTools" must be a list of tool-name strings when present')
    } else {
      const declared = (toolsRaw as string[]).map((t) => t.trim()).filter((t) => t !== '')
      // The declared list means the skill RESERVES Tier-2 tools (display signal), regardless of
      // kind. For an instruction skill the effective allowedTools still stays [] (it cannot USE
      // tools in v1) — the list is accepted but ignored with a note (§6.5).
      reservesTools = declared.length > 0
      if (kind === 'instruction') {
        if (declared.length > 0) {
          notes.push('"allowedTools" is ignored for an instruction skill in v1 (Tier-2 only)')
        }
      } else {
        allowedTools = declared
      }
    }
  }

  // Optional triggers — MUST be preserved (audit C2). Lenient: malformed subfields → note + [].
  const triggers: SkillTriggers = { keywords: [], mimeTypes: [], filenamePatterns: [] }
  const trigRaw = raw['triggers']
  if (trigRaw !== undefined && trigRaw !== null) {
    if (!isObject(trigRaw)) {
      notes.push('"triggers" must be a mapping; ignoring it')
    } else {
      triggers.keywords = stringArray(trigRaw['keywords'], 'triggers.keywords', notes)
      triggers.mimeTypes = stringArray(trigRaw['mimeTypes'] ?? trigRaw['mime_types'], 'triggers.mimeTypes', notes)
      triggers.filenamePatterns = stringArray(
        trigRaw['filenamePatterns'] ?? trigRaw['filename_patterns'],
        'triggers.filenamePatterns',
        notes
      )
    }
  }

  // Self-declared trust is ignored — the app assigns trustedLevel (§6.5/§14).
  if (raw['trust'] !== undefined || raw['trustedLevel'] !== undefined || raw['trusted_level'] !== undefined) {
    notes.push('a "trust"/"trustedLevel" field in frontmatter is ignored; the app assigns trust (§14)')
  }

  if (errors.length > 0) {
    return { ok: false, errors, notes }
  }

  return {
    ok: true,
    errors: [],
    notes,
    manifest: {
      id,
      title,
      description,
      version,
      author,
      language,
      kind,
      compatibility,
      permissions,
      allowedTools,
      reservesTools,
      triggers
    }
  }
}

// Frontmatter: optional BOM, an opening `---` line, the YAML body, a closing `---` line, then
// the Markdown body (optional). CRLF and LF both handled; the leading ﻿? skips a BOM.
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/

/**
 * Parse a whole SKILL.md document (frontmatter + body): split, YAML-parse the frontmatter,
 * validate it, and check the body. Pure. The body is required (non-empty) and capped at
 * `opts.maxBodyChars`. If `opts.manifestJson` is supplied and disagrees, SKILL.md wins (DS2)
 * and a note is logged.
 */
export function parseSkillMarkdown(source: string, opts: SkillParseOptions = {}): SkillParseResult {
  const notes: string[] = []
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, errors: ['SKILL.md is empty'], notes }
  }

  const m = source.match(FRONTMATTER_RE)
  if (!m) {
    return {
      ok: false,
      errors: ['SKILL.md must begin with a YAML frontmatter block delimited by --- lines'],
      notes
    }
  }

  let raw: unknown
  try {
    raw = parseYaml(m[1])
  } catch (err) {
    return { ok: false, errors: [`SKILL.md frontmatter YAML parse error — ${String(err)}`], notes }
  }

  const v = validateSkillManifest(raw)
  const errors = [...v.errors]
  notes.push(...v.notes)

  const body = (m[2] ?? '').trim()
  if (body === '') {
    errors.push('SKILL.md body (the instructions after the frontmatter) must not be empty')
  }
  const maxBody = opts.maxBodyChars ?? DEFAULT_SKILL_MAX_BODY_CHARS
  if (body.length > maxBody) {
    errors.push(`SKILL.md body must be at most ${maxBody} characters`)
  }

  if (opts.manifestJson !== undefined && opts.manifestJson !== null && v.manifest) {
    noteManifestJsonConflicts(v.manifest, opts.manifestJson, notes)
  }

  if (errors.length > 0 || !v.manifest) {
    return { ok: false, errors, notes }
  }
  return { ok: true, manifest: v.manifest, body, errors: [], notes }
}

/**
 * Compare the optional `manifest.json` cache against the canonical SKILL.md manifest and note
 * any disagreement. SKILL.md is always authoritative (DS2) — this never changes the manifest and
 * never produces an error; it only records that the cache was stale.
 */
function noteManifestJsonConflicts(canonical: SkillManifest, manifestJson: unknown, notes: string[]): void {
  if (!isObject(manifestJson)) return
  const fields: (keyof SkillManifest)[] = ['id', 'version', 'title']
  for (const f of fields) {
    const mv = manifestJson[f]
    if (typeof mv === 'string' && mv.trim() !== '' && mv.trim() !== canonical[f]) {
      notes.push(`manifest.json "${f}" ("${mv.trim()}") disagrees with SKILL.md ("${String(canonical[f])}"); using SKILL.md (DS2)`)
    }
  }
}
