// SKILL.md builder + skill source-dir helpers for the skills suites (pure: no electron import).
// Constraint: temp roots come from `tempRoot` (hilbertraum- prefix); `REPO_APP_SKILLS_DIR` assumes this file sits
// four levels below the repo root (tests/helpers), the same depth as tests/integration.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempRoot } from './db-fixtures'

/** The REAL committed app-skills/ folder (4 levels above tests/helpers, same as the test files' own REPO_ROOT). */
export const REPO_APP_SKILLS_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'app-skills'
)

export interface SkillTriggersSpec {
  keywords?: string[]
  mimeTypes?: string[]
  filenamePatterns?: string[]
  autoFire?: boolean
}

export interface SkillSpec {
  id: string
  /** default `Skill ${id}` */
  title?: string
  /** default `${id} skill` */
  description?: string
  /** default '1.0.0' */
  version?: string
  kind?: string
  analysis?: string
  allowedTools?: string[]
  /** emits `compatibility:` / `  minAppVersion: x` (before `triggers:`) */
  minAppVersion?: string
  /** a `triggers:` block is emitted whenever this is present, even as `{}` */
  triggers?: SkillTriggersSpec
  /** one raw frontmatter chunk appended after triggers (may be multi-line) */
  extraFrontmatter?: string
  /** default `Instructions for ${id}.` */
  body?: string
}

/** The SKILL.md text for `spec` (frontmatter order: id, title, description, version, kind, analysis, allowedTools, compatibility, triggers, extra). */
export function skillMdText(spec: SkillSpec): string {
  const id = spec.id
  const lines = [
    '---',
    `id: ${id}`,
    `title: ${spec.title ?? `Skill ${id}`}`,
    `description: ${spec.description ?? `${id} skill`}`,
    `version: ${spec.version ?? '1.0.0'}`
  ]
  if (spec.kind) lines.push(`kind: ${spec.kind}`)
  if (spec.analysis) lines.push(`analysis: ${spec.analysis}`)
  if (spec.allowedTools) lines.push(`allowedTools: [${spec.allowedTools.join(', ')}]`)
  if (spec.minAppVersion) lines.push('compatibility:', `  minAppVersion: ${spec.minAppVersion}`)
  const tr = spec.triggers
  if (tr) {
    lines.push('triggers:')
    if (tr.keywords) lines.push(`  keywords: [${tr.keywords.join(', ')}]`)
    if (tr.mimeTypes) lines.push(`  mimeTypes: [${tr.mimeTypes.join(', ')}]`)
    if (tr.filenamePatterns)
      lines.push(`  filenamePatterns: [${tr.filenamePatterns.map((p) => `"${p}"`).join(', ')}]`)
    if (tr.autoFire !== undefined) lines.push(`  autoFire: ${tr.autoFire}`)
  }
  if (spec.extraFrontmatter) lines.push(spec.extraFrontmatter)
  lines.push('---', spec.body ?? `Instructions for ${id}.`)
  return lines.join('\n')
}

/** Write `<parentDir>/<folderName>/SKILL.md` (folder defaults to the id); returns the skill folder. */
export function writeSkillPackage(parentDir: string, spec: SkillSpec, folderName: string = spec.id): string {
  const dir = join(parentDir, folderName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMdText(spec), 'utf8')
  return dir
}

export interface SkillDirs {
  appSkillsDir: string
  userSkillsDir: string
}

/** Two sibling (NOT created) source dirs under a fresh `hilbertraum-<label>-` root. */
export function makeSkillDirs(label: string): SkillDirs {
  const root = tempRoot(label)
  return { appSkillsDir: join(root, 'app-skills'), userSkillsDir: join(root, 'user-skills') }
}

/** Reconcile deps over the REAL committed app-skills/ plus a fresh `hilbertraum-<userLabel>-` parent for the (uncreated) user dir. */
export function realAppSkillsDeps(userLabel: string): SkillDirs {
  return { appSkillsDir: REPO_APP_SKILLS_DIR, userSkillsDir: join(tempRoot(userLabel), 'user-skills') }
}
