import type { MessageKey } from './i18n'

// #46 — the per-skill "what / needs / limits" info catalog behind the composer's first-selection
// info card. Selecting a skill used to change behavior in ways the user only discovered afterwards
// (#44 the run button, #45 the .txt output); this catalog states the essentials AT the decisive
// moment instead. PURE DATA importable from both processes (the `skill-tools.ts` precedent): i18n
// KEYS only, never resolved strings.
//
// Keyed by the skill's declared manifest `id` (stable across installs/sources), NOT the installId.
// Only the nine APP skills have entries — a user-imported skill has no app-authored honesty copy,
// so the card falls back to its own localized description (never invents claims about it). The
// copy is distilled from the same statements the app already makes elsewhere (user-guide §9,
// known-limitations.md, the run/result honesty strings) — said up front instead of afterwards.

/** The three catalog lines the info card renders for one app skill. */
export interface SkillInfoKeys {
  /** What picking this skill changes about the next answers / what actions it unlocks. */
  what: MessageKey
  /** What it needs to apply (document in scope, a running model, …) — when absent it silently
   *  routes to a plain answer, which #46 calls out as the confusing case. */
  needs: MessageKey
  /** The key honesty limitation (output formats, advisory-only, one-doc-at-a-time, …). */
  limits: MessageKey
}

const INFO: Readonly<Record<string, SkillInfoKeys>> = {
  'meeting-protocol': {
    what: 'skills.info.meeting-protocol.what',
    needs: 'skills.info.meeting-protocol.needs',
    limits: 'skills.info.meeting-protocol.limits'
  },
  'contract-brief': {
    what: 'skills.info.contract-brief.what',
    needs: 'skills.info.contract-brief.needs',
    limits: 'skills.info.contract-brief.limits'
  },
  'deadline-obligation-finder': {
    what: 'skills.info.deadline-obligation-finder.what',
    needs: 'skills.info.deadline-obligation-finder.needs',
    limits: 'skills.info.deadline-obligation-finder.limits'
  },
  'what-changed': {
    what: 'skills.info.what-changed.what',
    needs: 'skills.info.what-changed.needs',
    limits: 'skills.info.what-changed.limits'
  },
  'share-safe-review': {
    what: 'skills.info.share-safe-review.what',
    needs: 'skills.info.share-safe-review.needs',
    limits: 'skills.info.share-safe-review.limits'
  },
  invoice: {
    what: 'skills.info.invoice.what',
    needs: 'skills.info.invoice.needs',
    limits: 'skills.info.invoice.limits'
  },
  'bank-statement': {
    what: 'skills.info.bank-statement.what',
    needs: 'skills.info.bank-statement.needs',
    limits: 'skills.info.bank-statement.limits'
  },
  'document-redaction': {
    what: 'skills.info.document-redaction.what',
    needs: 'skills.info.document-redaction.needs',
    limits: 'skills.info.document-redaction.limits'
  },
  'document-edit': {
    what: 'skills.info.document-edit.what',
    needs: 'skills.info.document-edit.needs',
    limits: 'skills.info.document-edit.limits'
  }
}

/** The info-card catalog keys for a skill id, or null (user/unknown skill → description fallback). */
export function getSkillInfoKeys(skillId: string): SkillInfoKeys | null {
  return INFO[skillId] ?? null
}
