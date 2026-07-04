import { t as tCatalog, type MessageKey, type MessageParams } from '@shared/i18n'
import type { SkillNoteRef } from '@shared/types'

// Localization plumbing for the skill import/preview surfaces (SkillsTab). Pure + tiny so the
// mapping is unit-testable without rendering.
//
// SKA-33 (skills audit 2026-07-03, U7): a failed IMPORT (post-preview) reaches the renderer as a
// WRAPPED Electron IPC error ("Error invoking remote method 'skills:import': Error: <structural
// message>") — the structural code table below already localizes every reason at PREVIEW time, but
// the import toast dropped it and showed only the generic "couldn't be added". The matcher here
// finds the known structural English string INSIDE the wrapped message and returns its copy key,
// so the import toast shows the precise reason (downgrade race, vanished zip, locked folder…)
// exactly like the preview banner does.
//
// SKA-35: preview NOTES are localized the same way — via the stable note CODE + app-fixed params
// the main process sends alongside each fixed English string (never via the string itself).

/**
 * Import-error reason CODE (content-free, computed main-side — I2) → localized copy key, so a
 * German user never sees the English structural string. An unmapped code falls back to the raw
 * (English, structural) message.
 */
export const IMPORT_ERROR_KEY: Record<string, MessageKey> = {
  notFound: 'skills.import.error.notFound',
  notZipOrFolder: 'skills.import.error.notZipOrFolder',
  unreadableZip: 'skills.import.error.unreadableZip',
  encryptedZip: 'skills.import.error.encryptedZip',
  unsupportedCompression: 'skills.import.error.unsupportedCompression',
  pathTraversal: 'skills.import.error.pathTraversal',
  absolutePath: 'skills.import.error.absolutePath',
  invalidPath: 'skills.import.error.invalidPath',
  symlink: 'skills.import.error.symlink',
  tooDeep: 'skills.import.error.tooDeep',
  pathTooLong: 'skills.import.error.pathTooLong',
  tooManyFiles: 'skills.import.error.tooManyFiles',
  tooLarge: 'skills.import.error.tooLarge',
  fileTooLarge: 'skills.import.error.fileTooLarge',
  duplicatePath: 'skills.import.error.duplicatePath',
  badExtension: 'skills.import.error.badExtension',
  nestedArchive: 'skills.import.error.nestedArchive',
  noSkillMd: 'skills.import.error.noSkillMd',
  invalidManifest: 'skills.import.error.invalidManifest',
  idMismatch: 'skills.import.error.idMismatch',
  downgradeBlocked: 'skills.import.error.downgradeBlocked',
  appReadOnly: 'skills.import.error.appReadOnly',
  locked: 'skills.import.error.locked'
}

// The English catalog strings are byte-identical to the installer's SKILL_IMPORT_ERRORS constants
// (pinned by a test), so matching against the catalog needs no main-process import. Longest-first
// so a message containing one string that is a substring of another resolves to the longer match.
const ERROR_MATCHERS: Array<{ key: MessageKey; en: string }> = Object.values(IMPORT_ERROR_KEY)
  .map((key) => ({ key, en: tCatalog('en', key) }))
  .sort((a, b) => b.en.length - a.en.length)

/**
 * SKA-33: resolve a (possibly IPC-wrapped) import error message to its localized copy key, or null
 * when no known structural string is inside it (→ caller falls back to the generic failed toast).
 */
export function importErrorKeyForMessage(message: string): MessageKey | null {
  if (!message) return null
  return ERROR_MATCHERS.find((m) => message.includes(m.en))?.key ?? null
}

/** SKA-35: note CODE → localized copy key (params are app-fixed: a field name, a numeric cap). */
export const IMPORT_NOTE_KEY: Record<string, MessageKey> = {
  permissionNotString: 'skills.import.note.permissionNotString',
  permissionUnrecognized: 'skills.import.note.permissionUnrecognized',
  permissionClamped: 'skills.import.note.permissionClamped',
  listInvalid: 'skills.import.note.listInvalid',
  listItemsTooLong: 'skills.import.note.listItemsTooLong',
  listTruncated: 'skills.import.note.listTruncated',
  languageInvalid: 'skills.import.note.languageInvalid',
  allowedToolsIgnored: 'skills.import.note.allowedToolsIgnored',
  analysisInvalid: 'skills.import.note.analysisInvalid',
  analysisIgnoredForTool: 'skills.import.note.analysisIgnoredForTool',
  triggersInvalid: 'skills.import.note.triggersInvalid',
  autoFireInvalid: 'skills.import.note.autoFireInvalid',
  localizedInvalid: 'skills.import.note.localizedInvalid',
  localizedLocaleInvalid: 'skills.import.note.localizedLocaleInvalid',
  localizedEntryInvalid: 'skills.import.note.localizedEntryInvalid',
  localizedTitleIgnored: 'skills.import.note.localizedTitleIgnored',
  localizedDescriptionIgnored: 'skills.import.note.localizedDescriptionIgnored',
  localizedTooMany: 'skills.import.note.localizedTooMany',
  trustIgnored: 'skills.import.note.trustIgnored',
  manifestJsonConflict: 'skills.import.note.manifestJsonConflict'
}

/**
 * Localize one preview note: the structured ref's code resolves through the copy table; an unknown
 * or missing ref falls back to the fixed structural English string the preview carried.
 */
export function localizeSkillNote(
  t: (key: MessageKey, params?: MessageParams) => string,
  note: string,
  ref?: SkillNoteRef
): string {
  const key = ref ? IMPORT_NOTE_KEY[ref.code] : undefined
  return key ? t(key, ref?.params) : note
}
