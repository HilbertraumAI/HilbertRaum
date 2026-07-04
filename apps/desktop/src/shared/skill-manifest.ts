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
 * A3 (audit §6.3/§8.2): the whole-document ANALYSIS ENGINE an INSTRUCTION skill declares.
 *   - `'whole-doc'`  — the model answers over the WHOLE single in-scope document (minutes, contract
 *                      brief, deadline finder, share-safe review), not top-k passages.
 *   - `'compare'`    — the model compares EXACTLY TWO whole in-scope documents (what-changed).
 *   - `'none'`       — no analysis engine; the ordinary top-k relevance path (the default).
 *
 * Crucially this is an ENGINE choice, NOT a capability grant (unlike a tool's `allowedTools`, which
 * stays app-only — SEC-1). It reads only the documents the turn already scopes, adds no DB/FS/net
 * handle, and is therefore honored for instruction skills of ANY source (app or user-imported) — the
 * fix for "a user-imported skill silently gets top-k-with-fence" (§6.3). The gate INVERSION lives in
 * the chat path: with an analysis-mode skill active over a matching fully-chunked scope the engine is
 * the DEFAULT; keywords only opt OUT for off-topic chatter and classify needle-vs-deliverable (§8.2).
 */
export type SkillAnalysisMode = 'whole-doc' | 'compare' | 'none'
export const SKILL_ANALYSIS_MODES: SkillAnalysisMode[] = ['whole-doc', 'compare', 'none']

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
  /**
   * D6 (skills-s13-plan.md §2.1/§4): the author OPTS the skill IN as an auto-fire candidate. The app
   * still adjudicates every fire (the ratified `AUTOFIRE_SCORE_THRESHOLD`, app-only, the user opt-in,
   * only-when-no-skill-set) — this flag is merely *eligibility*. Additive + lenient: absent / blank /
   * non-boolean → treated as `false` (never an error), so a skill that doesn't declare it is never a
   * candidate. Optional/additive (older cached manifest_json may lack it → treated as not opted in).
   */
  autoFire?: boolean
}

/** Optional compatibility gate; a skill needing a newer app is listed but disabled (§6.5). */
export interface SkillCompatibility {
  /** Minimum app version (semver) this skill requires. */
  minAppVersion?: string
}

/** Per-locale DISPLAY overrides for `title`/`description` only (additive). Body language is unaffected. */
export interface SkillLocalizedText {
  title?: string
  description?: string
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
  /**
   * Optional per-locale DISPLAY overrides for `title`/`description` only (additive, keyed by a short
   * locale tag e.g. 'de'). The app shows a locale's text when the UI runs in that language, falling
   * back to the canonical `title`/`description`. Display only — it never changes the prompt/body
   * language (D-L6: the body stays a single language; the model is multilingual). Optional/additive
   * (older cached manifest_json may lack it → treated as "no overrides").
   */
  localized?: Record<string, SkillLocalizedText>
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
  /**
   * A3 (audit §6.3/§8.2): the whole-document ANALYSIS ENGINE this INSTRUCTION skill wants (see
   * `SkillAnalysisMode`). Set ONLY for an instruction skill declaring `whole-doc`/`compare`; absent
   * ⇒ `'none'` (the top-k default). It is an ENGINE choice, not a tool capability (SEC-1 unchanged),
   * so it is honored regardless of source. A `tool` skill declaring it is ignored with a note (its
   * exhaustive/routing behaviour comes from the app-registered tool handler, not this field).
   * Optional/additive (older cached manifest_json lacks it → treated as `'none'`). */
  analysis?: SkillAnalysisMode
  triggers: SkillTriggers
}

/**
 * SKA-35 (skills audit 2026-07-03, U7): every advisory note is emitted as a stable CODE + app-fixed
 * params ALONGSIDE its fixed English string — the `SKILL_IMPORT_ERRORS`/`errorCodes` precedent
 * applied to notes, so the renderer can localize the import-preview advisories instead of showing
 * raw English. Params only ever carry APP-CHOSEN values (a fixed frontmatter field name, a numeric
 * cap) — never skill content: in particular the `localized.<key>` family DROPPED the raw locale key
 * (bounded attacker-chosen text that was previously interpolated into the message).
 */
export type SkillNoteCode =
  | 'permissionNotString'
  | 'permissionUnrecognized'
  | 'permissionClamped'
  | 'listInvalid'
  | 'listItemsTooLong'
  | 'listTruncated'
  | 'languageInvalid'
  | 'allowedToolsIgnored'
  | 'analysisInvalid'
  | 'analysisIgnoredForTool'
  | 'triggersInvalid'
  | 'autoFireInvalid'
  | 'localizedInvalid'
  | 'localizedLocaleInvalid'
  | 'localizedEntryInvalid'
  | 'localizedTitleIgnored'
  | 'localizedDescriptionIgnored'
  | 'localizedTooMany'
  | 'trustIgnored'
  | 'manifestJsonConflict'

/** One structured advisory note: a stable code + app-fixed params (SKA-35). */
export interface SkillNoteRef {
  code: SkillNoteCode
  params?: Record<string, string | number>
}

/**
 * The fixed English template per note code — the single source of the `notes` strings. `{field}` /
 * `{max}` / `{value}` are replaced from app-fixed params; unknown placeholders stay literal.
 */
const SKILL_NOTE_TEXT: Record<SkillNoteCode, string> = {
  permissionNotString: '"permissions.{field}" should be a string; using the v1 default "{value}"',
  permissionUnrecognized:
    '"permissions.{field}" has a value that is not recognized; using the v1 default "{value}"',
  permissionClamped: '"permissions.{field}" requested more than v1 allows; clamped to "{value}" (DS6)',
  listInvalid: '"{field}" must be a list of strings; ignoring it',
  listItemsTooLong: '"{field}" has entries that are too long; ignoring them',
  listTruncated: '"{field}" has more entries than allowed; keeping the first {max}',
  languageInvalid: '"language" should be a short BCP-47 tag (e.g. en, de); using "en"',
  allowedToolsIgnored: '"allowedTools" is ignored for an instruction skill in v1 (Tier-2 only)',
  analysisInvalid: '"analysis" must be one of: whole-doc, compare, none; ignoring it',
  analysisIgnoredForTool: '"analysis" is ignored for a tool skill (its whole-document behaviour is app-owned)',
  triggersInvalid: '"triggers" must be a mapping; ignoring it',
  autoFireInvalid: '"triggers.autoFire" must be true or false; treating it as false',
  localizedInvalid: '"localized" must be a mapping of locale entries; ignoring it',
  localizedLocaleInvalid: '"localized" has an invalid locale key; ignoring that entry',
  localizedEntryInvalid: 'a "localized" entry must be a mapping; ignoring it',
  localizedTitleIgnored: 'a "localized" title override was ignored (must be a short single line)',
  localizedDescriptionIgnored:
    'a "localized" description override was ignored (must be a short single line)',
  localizedTooMany: '"localized" has more locales than allowed; keeping the first {max}',
  trustIgnored: 'a "trust"/"trustedLevel" field in frontmatter is ignored; the app assigns trust (§14)',
  manifestJsonConflict: 'manifest.json "{field}" disagrees with SKILL.md; using SKILL.md (DS2)'
} as const

/** Render one note code + params to its fixed English string (params are app-fixed, never content). */
export function formatSkillNote(ref: SkillNoteRef): string {
  return SKILL_NOTE_TEXT[ref.code].replace(/\{(\w+)\}/g, (raw, name: string) => {
    const v = ref.params?.[name]
    return v === undefined ? raw : String(v)
  })
}

/** Collects the paired string + structured forms of every note (they stay index-parallel). */
interface NoteCollector {
  notes: string[]
  refs: SkillNoteRef[]
  add(code: SkillNoteCode, params?: Record<string, string | number>): void
}

function makeNoteCollector(): NoteCollector {
  const notes: string[] = []
  const refs: SkillNoteRef[] = []
  return {
    notes,
    refs,
    add(code, params) {
      const ref: SkillNoteRef = params ? { code, params } : { code }
      refs.push(ref)
      notes.push(formatSkillNote(ref))
    }
  }
}

/** Result of validating a pre-parsed frontmatter object. `notes` are non-fatal (clamps, ignores). */
export interface SkillManifestValidation {
  ok: boolean
  manifest?: SkillManifest
  errors: string[]
  notes: string[]
  /** Structured note codes parallel to `notes` (SKA-35). */
  noteCodes?: SkillNoteRef[]
}

/** Result of parsing a whole SKILL.md (frontmatter + body). */
export interface SkillParseResult {
  ok: boolean
  manifest?: SkillManifest
  /** The trimmed Markdown body (the injected instructions). Present only when `ok`. */
  body?: string
  errors: string[]
  notes: string[]
  /** Structured note codes parallel to `notes` (SKA-35). */
  noteCodes?: SkillNoteRef[]
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
/** SKA-45: Unicode bidi controls (LRE/RLE/PDF/LRO/RLO + LRI/RLI/FSI/PDI) — display-spoofing only.
 *  `\u` escapes on purpose (the T1 convention): a git/editor normalization must not defeat this. */
const BIDI_CONTROL_RE = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]')
/** Strict semver core MAJOR.MINOR.PATCH (drives upgrade/downgrade comparison — §6.5/§9). */
export const SKILL_SEMVER_RE = /^\d+\.\d+\.\d+$/

/** Parse the leading MAJOR.MINOR.PATCH of a version, ignoring any `-prerelease`/`+build` suffix. */
function parseSemverCore(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * The §6.5 compatibility gate, finally enforced: true when a skill's declared
 * `compatibility.minAppVersion` is NEWER than the running app, so the skill must be listed but kept
 * DISABLED (it cannot be enabled, suggested, or run until the app is new enough). Pure + shared so
 * main computes it and the renderer can label it the same way. Tolerant by design — a missing
 * requirement, or an unparseable version on either side, is treated as compatible (this is a DS6
 * courtesy gate, never a security control; versions are unsigned). The app version's
 * `-prerelease`/`+build` suffix is ignored (only the MAJOR.MINOR.PATCH core is compared).
 */
export function skillNeedsNewerApp(minAppVersion: string | undefined, appVersion: string): boolean {
  if (!minAppVersion) return false
  const need = parseSemverCore(minAppVersion)
  const have = parseSemverCore(appVersion)
  if (!need || !have) return false
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] < need[i]
  }
  return false
}

/** Default SKILL.md body cap (64 KiB of chars). The `limits.ts` default references this. */
export const DEFAULT_SKILL_MAX_BODY_CHARS = 64 * 1024

const MAX_TITLE_LEN = 80
const MAX_DESCRIPTION_LEN = 280
const MAX_AUTHOR_LEN = 120
const MAX_LANGUAGE_LEN = 35
/** A bounded number of per-locale display overrides (additive `localized` block) — abuse guard. */
const MAX_LOCALIZED_LOCALES = 16

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
  notes: NoteCollector
): string {
  if (raw === undefined || raw === null) {
    return canonicalByRank[ceilingRank]
  }
  if (typeof raw !== 'string') {
    notes.add('permissionNotString', { field, value: canonicalByRank[ceilingRank] })
    return canonicalByRank[ceilingRank]
  }
  const key = raw.trim().toLowerCase()
  const rank = rankMap[key]
  if (rank === undefined) {
    // Content-free: never echo the raw (attacker-supplied) value — only the fixed field name and
    // the app-derived default (§22-M1; the note rides the same IPC payload as a structural error).
    notes.add('permissionUnrecognized', { field, value: canonicalByRank[ceilingRank] })
    return canonicalByRank[ceilingRank]
  }
  const eff = Math.min(rank, ceilingRank)
  if (rank > ceilingRank) {
    notes.add('permissionClamped', { field, value: canonicalByRank[eff] })
  }
  return canonicalByRank[eff]
}

/**
 * Caps on a `triggers` string list (keywords / mimeTypes / filenamePatterns). They bound the
 * deterministic selector's work AND, for `filenamePatterns`, the SOURCE LENGTH of the glob the
 * selector compiles to a RegExp — the parse-time half of the ReDoS guard (the selector caps the
 * wildcard count too). A user skill's triggers are skill-controlled input, so they are bounded here.
 */
const MAX_TRIGGER_ITEMS = 64
const MAX_TRIGGER_ITEM_LEN = 200

/** Coerce a YAML value into a trimmed string[]; non-array / non-string members → note + []. */
function stringArray(v: unknown, field: string, notes: NoteCollector): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    notes.add('listInvalid', { field })
    return []
  }
  const items = (v as string[]).map((x) => x.trim()).filter((x) => x !== '')
  const bounded = items.filter((x) => x.length <= MAX_TRIGGER_ITEM_LEN)
  if (bounded.length < items.length) notes.add('listItemsTooLong', { field })
  if (bounded.length > MAX_TRIGGER_ITEMS) {
    notes.add('listTruncated', { field, max: MAX_TRIGGER_ITEMS })
    return bounded.slice(0, MAX_TRIGGER_ITEMS)
  }
  return bounded
}

/**
 * Validate a pre-parsed frontmatter object into a SkillManifest, collecting all errors. Pure
 * (no I/O) so it is trivial to unit-test. Unknown frontmatter keys are ignored (only known keys
 * are read). Multi-word keys accept both camelCase (the §6.6 canonical form) and snake_case.
 */
export function validateSkillManifest(raw: unknown): SkillManifestValidation {
  const errors: string[] = []
  const collector = makeNoteCollector()
  const notes = collector.notes
  if (!isObject(raw)) {
    return {
      ok: false,
      errors: ['SKILL.md frontmatter must be a YAML mapping (key: value pairs)'],
      notes,
      noteCodes: collector.refs
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
    // SKA-45 (rider, U7): Unicode bidirectional-control characters in a display field can reorder
    // the rendered text (RTL-override picker/title spoofing — e.g. a title that shows a different
    // "file type" than it is). Purely cosmetic here, but there is no legitimate use in a short
    // display string — reject structurally.
    if (value && BIDI_CONTROL_RE.test(value)) {
      errors.push(`"${key}" must not contain Unicode direction-control characters`)
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
  // language, D-L6). Lenient: malformed → note + default 'en'. SKA-45 (review hardening): it is a
  // DISPLAYED string (the detail pane), so an embedded newline or bidi direction control falls to
  // the same lenient default instead of rendering.
  let language = 'en'
  const langRaw = raw['language']
  if (langRaw !== undefined && langRaw !== null) {
    if (
      typeof langRaw !== 'string' ||
      langRaw.trim() === '' ||
      langRaw.trim().length > MAX_LANGUAGE_LEN ||
      /[\r\n]/.test(langRaw) ||
      BIDI_CONTROL_RE.test(langRaw)
    ) {
      collector.add('languageInvalid')
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
        documents: clampPermission(permRaw['documents'], 'documents', DOC_RANK, 1, DOC_BY_RANK, collector) as SkillDocumentsPermission,
        network: clampPermission(permRaw['network'], 'network', NET_RANK, 0, NET_BY_RANK, collector) as SkillNetworkPermission,
        filesystem: clampPermission(permRaw['filesystem'], 'filesystem', FS_RANK, 1, FS_BY_RANK, collector) as SkillFilesystemPermission
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
          collector.add('allowedToolsIgnored')
        }
      } else {
        allowedTools = declared
      }
    }
  }

  // Optional analysis engine (A3, audit §6.3/§8.2) — additive + lenient. Honored ONLY for an
  // instruction skill (a tool skill's exhaustive/routing behaviour comes from the app-registered tool
  // handler, so a declared `analysis` there is ignored with a note). Absent / `'none'` ⇒ undefined
  // (byte-unchanged cache — the top-k default); an unrecognized value is NOTED and dropped, never an
  // error (a v1 app must never choke on a newer skill's field). Trust-agnostic: it grants nothing.
  let analysis: SkillAnalysisMode | undefined
  const analysisRaw = raw['analysis']
  if (analysisRaw !== undefined && analysisRaw !== null) {
    if (typeof analysisRaw !== 'string' || !SKILL_ANALYSIS_MODES.includes(analysisRaw.trim().toLowerCase() as SkillAnalysisMode)) {
      collector.add('analysisInvalid')
    } else {
      const mode = analysisRaw.trim().toLowerCase() as SkillAnalysisMode
      if (mode === 'none') {
        // Explicit default — leave undefined so the manifest_json stays byte-identical to an omission.
      } else if (kind !== 'instruction') {
        collector.add('analysisIgnoredForTool')
      } else {
        analysis = mode
      }
    }
  }

  // Optional triggers — MUST be preserved (audit C2). Lenient: malformed subfields → note + [].
  const triggers: SkillTriggers = { keywords: [], mimeTypes: [], filenamePatterns: [] }
  const trigRaw = raw['triggers']
  if (trigRaw !== undefined && trigRaw !== null) {
    if (!isObject(trigRaw)) {
      collector.add('triggersInvalid')
    } else {
      triggers.keywords = stringArray(trigRaw['keywords'], 'triggers.keywords', collector)
      triggers.mimeTypes = stringArray(trigRaw['mimeTypes'] ?? trigRaw['mime_types'], 'triggers.mimeTypes', collector)
      triggers.filenamePatterns = stringArray(
        trigRaw['filenamePatterns'] ?? trigRaw['filename_patterns'],
        'triggers.filenamePatterns',
        collector
      )
      // D6 auto-fire eligibility (additive, lenient). Only an explicit boolean `true` opts in; a
      // non-boolean value is NOTED and clamped to `false`; absent/false leaves it undefined (treated
      // as not opted in everywhere) so an existing skill's cached manifest_json is byte-unchanged.
      const afRaw = trigRaw['autoFire'] ?? trigRaw['auto_fire']
      if (afRaw === true) {
        triggers.autoFire = true
      } else if (afRaw !== undefined && afRaw !== null && typeof afRaw !== 'boolean') {
        collector.add('autoFireInvalid')
      }
    }
  }

  // Optional per-locale DISPLAY overrides (title/description only — additive, lenient). A malformed
  // entry is NOTED and skipped (never an error); only non-empty, single-line, length-bounded strings
  // are kept. Display only — it never changes the prompt/body language (D-L6). SKA-35: the notes for
  // this family DROP the raw locale key — it is bounded attacker-chosen text, and interpolating it
  // put package content into the preview payload; the fixed message + code describe the entry alone.
  // Locales past the MAX_LOCALIZED_LOCALES cap were previously dropped SILENTLY — now noted.
  let localized: Record<string, SkillLocalizedText> | undefined
  const locRaw = raw['localized']
  if (locRaw !== undefined && locRaw !== null) {
    if (!isObject(locRaw)) {
      collector.add('localizedInvalid')
    } else {
      const out: Record<string, SkillLocalizedText> = {}
      const locKeys = Object.keys(locRaw)
      if (locKeys.length > MAX_LOCALIZED_LOCALES) {
        collector.add('localizedTooMany', { max: MAX_LOCALIZED_LOCALES })
      }
      for (const loc of locKeys.slice(0, MAX_LOCALIZED_LOCALES)) {
        const key = loc.trim().toLowerCase()
        if (!key || key.length > MAX_LANGUAGE_LEN) {
          collector.add('localizedLocaleInvalid')
          continue
        }
        const entryRaw = locRaw[loc]
        if (!isObject(entryRaw)) {
          collector.add('localizedEntryInvalid')
          continue
        }
        const entry: SkillLocalizedText = {}
        const lt = entryRaw['title']
        // SKA-45 rider: bidi direction controls are refused in localized titles too (picker copy).
        if (
          typeof lt === 'string' &&
          lt.trim() !== '' &&
          !/[\r\n]/.test(lt) &&
          !BIDI_CONTROL_RE.test(lt) &&
          lt.trim().length <= MAX_TITLE_LEN
        ) {
          entry.title = lt.trim()
        } else if (lt !== undefined) {
          collector.add('localizedTitleIgnored')
        }
        const ld = entryRaw['description']
        if (
          typeof ld === 'string' &&
          ld.trim() !== '' &&
          !/[\r\n]/.test(ld) &&
          !BIDI_CONTROL_RE.test(ld) &&
          ld.trim().length <= MAX_DESCRIPTION_LEN
        ) {
          entry.description = ld.trim()
        } else if (ld !== undefined) {
          collector.add('localizedDescriptionIgnored')
        }
        if (entry.title || entry.description) out[key] = entry
      }
      if (Object.keys(out).length > 0) localized = out
    }
  }

  // Self-declared trust is ignored — the app assigns trustedLevel (§6.5/§14).
  if (raw['trust'] !== undefined || raw['trustedLevel'] !== undefined || raw['trusted_level'] !== undefined) {
    collector.add('trustIgnored')
  }

  if (errors.length > 0) {
    return { ok: false, errors, notes, noteCodes: collector.refs }
  }

  return {
    ok: true,
    errors: [],
    notes,
    noteCodes: collector.refs,
    manifest: {
      id,
      title,
      description,
      version,
      author,
      language,
      kind,
      compatibility,
      ...(localized ? { localized } : {}),
      permissions,
      allowedTools,
      reservesTools,
      ...(analysis ? { analysis } : {}),
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
    return { ok: false, errors: ['SKILL.md is empty'], notes, noteCodes: [] }
  }

  const m = source.match(FRONTMATTER_RE)
  if (!m) {
    return {
      ok: false,
      errors: ['SKILL.md must begin with a YAML frontmatter block delimited by --- lines'],
      notes,
      noteCodes: []
    }
  }

  let raw: unknown
  try {
    raw = parseYaml(m[1])
  } catch (err) {
    // SKA-31 (audit 2026-07-03, U7): NEVER embed `String(err)` — the yaml package's pretty errors
    // include a code frame quoting the raw (attacker-supplied) frontmatter line, which would ride
    // this error string into IPC payloads / app.log the moment any consumer surfaces it (§22-M1
    // content-free rule; SKA-32 surfaces discovery errors). A FIXED structural message + at most
    // the numeric line/column from `err.linePos` — numbers carry no package content.
    const pos = (err as { linePos?: Array<{ line?: unknown; col?: unknown }> })?.linePos?.[0]
    const line = typeof pos?.line === 'number' && Number.isFinite(pos.line) ? pos.line : null
    const col = typeof pos?.col === 'number' && Number.isFinite(pos.col) ? pos.col : null
    const where = line !== null ? (col !== null ? ` (line ${line}, column ${col})` : ` (line ${line})`) : ''
    return { ok: false, errors: [`SKILL.md frontmatter is not valid YAML${where}`], notes, noteCodes: [] }
  }

  const v = validateSkillManifest(raw)
  const errors = [...v.errors]
  notes.push(...v.notes)
  const noteCodes: SkillNoteRef[] = [...(v.noteCodes ?? [])]

  const body = (m[2] ?? '').trim()
  if (body === '') {
    errors.push('SKILL.md body (the instructions after the frontmatter) must not be empty')
  }
  const maxBody = opts.maxBodyChars ?? DEFAULT_SKILL_MAX_BODY_CHARS
  if (body.length > maxBody) {
    errors.push(`SKILL.md body must be at most ${maxBody} characters`)
  }

  if (opts.manifestJson !== undefined && opts.manifestJson !== null && v.manifest) {
    for (const ref of manifestJsonConflictNotes(v.manifest, opts.manifestJson)) {
      noteCodes.push(ref)
      notes.push(formatSkillNote(ref))
    }
  }

  if (errors.length > 0 || !v.manifest) {
    return { ok: false, errors, notes, noteCodes }
  }
  return { ok: true, manifest: v.manifest, body, errors: [], notes, noteCodes }
}

/**
 * Compare the optional `manifest.json` cache against the canonical SKILL.md manifest and note
 * any disagreement. SKILL.md is always authoritative (DS2) — this never changes the manifest and
 * never produces an error; it only records that the cache was stale.
 */
function manifestJsonConflictNotes(canonical: SkillManifest, manifestJson: unknown): SkillNoteRef[] {
  if (!isObject(manifestJson)) return []
  const refs: SkillNoteRef[] = []
  const fields: (keyof SkillManifest)[] = ['id', 'version', 'title']
  for (const f of fields) {
    const mv = manifestJson[f]
    if (typeof mv === 'string' && mv.trim() !== '' && mv.trim() !== canonical[f]) {
      // Content-free: name only the (fixed) field — never the raw cache or manifest values, which
      // are attacker-supplied and would otherwise ride the preview IPC payload into the UI (§22-M1).
      refs.push({ code: 'manifestJsonConflict', params: { field: f } })
    }
  }
  return refs
}
