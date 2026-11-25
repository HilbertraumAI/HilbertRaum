import type { MessageKey, MessageParams } from './i18n'
import { MIN_PASSWORD_LENGTH, type BackendStartFailure, type StartFailureCause, type WorkspaceActionResult } from './types'
import { UPDATE_ADDRESS } from './update-address'

// The copy for a failed unlock or create, by `reason` (UI languages wave, UI-languages owner
// call D-17 (a), 2026-11-11). Before unlock the gate (`renderer/screens/WorkspaceGate.tsx`)
// follows the localStorage mirror while main emits in its own cached language (the OS locale
// until settings are readable), so showing main's `message` put one screen in two languages
// whenever the chosen language wasn't the OS's. The gate renders the failure from its `reason`
// instead, through its own `t()`, with the `main.workspace.*` value main would have emitted
// (same text when the languages agree).
//
// These tables are the gate's; main (`main/ipc/registerWorkspaceIpc.ts`) picks its own
// `tMain(...)` per branch and doesn't read them. They live in `shared/` so that
// `tests/integration/workspace-ipc.test.ts` can drive main's real handlers into every reason
// they send and check main's `message` against the key the gate picks here: change a key on
// either side alone and that test goes red.
//
// One table per call: `error` means "couldn't open" to unlock and "couldn't create" to create.
// Every reason a call sends has a key. `null` means main never sends that reason for that call;
// it (and a reason missing at runtime) shows main's `message`. Since #807 no call sends free text:
// create's two vault refusals have their own reasons (`workspace_exists`, `plaintext_not_allowed`),
// and create's `refused` is only main's too-short refusal, a password under MIN_PASSWORD_LENGTH,
// whose key the gate renders with that floor (`{ min }`). The gate's `canSubmit` holds the same
// floor before sending, so it shouldn't get that refusal back. That is decided by what the gate
// knows, never by matching the text (i18n record §3.3 Rule 3).
//
// App-update T2.6: `main.workspace.newer` (X01) and `main.workspace.schemaUnreadable` (C01) also
// name this version's number and the update address. Main and the gate fill every key from
// `workspaceFailureParams`, so the two texts can only differ by language.

/** Why an unlock or create failed: the `reason` of a failed `WorkspaceActionResult`. */
export type WorkspaceFailureReason = Extract<WorkspaceActionResult, { ok: false }>['reason']

/**
 * The parameters every unlock and create failure key is rendered with, by main (`registerWorkspaceIpc.ts`, with the
 * version `main/index.ts` passes it) and by the gate (with the `appVersion` of main's state): the password floor
 * (`{min}`), this version's number (`{version}`) and the update address (`{address}`). A key ignores what it doesn't
 * name. No version (a caller that has none) leaves `{version}` out, so `t()` shows the English text, never a blank.
 */
export function workspaceFailureParams(appVersion: string | undefined): MessageParams {
  return {
    min: MIN_PASSWORD_LENGTH,
    address: UPDATE_ADDRESS,
    ...(appVersion === undefined ? {} : { version: appVersion })
  }
}

/** The gate's copy for a failed unlock, by reason (`null`: main never sends it; shows main's `message`). */
export const UNLOCK_FAILURE_KEYS = {
  wrong_password: 'main.workspace.wrongPassword',
  vault_damaged: 'main.workspace.vaultDamaged',
  vault_missing: 'main.workspace.vaultMissing',
  vault_descriptor_missing: 'main.workspace.descriptorMissing',
  // #955 item 1: the descriptor file is there but unreadable, and no `.enc` beside it.
  vault_descriptor_unreadable: 'main.workspace.descriptorUnreadable',
  vault_open_failed: 'main.workspace.vaultOpenFailed',
  vault_recovery_blocked: 'main.workspace.recoveryBlocked',
  workspace_newer: 'main.workspace.newer',
  // W-68 (app-update wave, T2.14): a schema this version can't parse (copy deck C01). Its `{version}` and `{address}`
  // come from `workspaceFailureParams` (T2.6), as X01's do.
  workspace_schema_unreadable: 'main.workspace.schemaUnreadable',
  // `null`: main never sends these for this call. If it ever does, give the entry a key: a
  // `null` shows main's `message`, in main's language, and the screen is in two languages again.
  workspace_exists: null,
  plaintext_not_allowed: null,
  refused: null,
  error: 'main.workspace.openFailed'
} satisfies Record<WorkspaceFailureReason, MessageKey | null>

/** The gate's copy for a failed create, by reason (`null`: main never sends it; shows main's `message`). */
export const CREATE_FAILURE_KEYS = {
  // `null`: main never sends these six for create (what a `null` costs: UNLOCK_FAILURE_KEYS).
  wrong_password: null,
  vault_damaged: null,
  vault_missing: null,
  vault_descriptor_missing: null,
  // Review V F-3: an unreadable key file that appeared under the create form with no `.enc`: the unlock's own copy.
  vault_descriptor_unreadable: 'main.workspace.descriptorUnreadable',
  vault_open_failed: null,
  vault_recovery_blocked: null,
  workspace_newer: 'main.workspace.newer',
  // W-68: unlock only (copy deck C01: "never on the create form").
  workspace_schema_unreadable: null,
  workspace_exists: 'main.workspace.exists',
  plaintext_not_allowed: 'main.workspace.plaintextNotAllowed',
  // A password under MIN_PASSWORD_LENGTH, or not a string (A2, #807): rendered with `{ min }`.
  refused: 'main.workspace.passwordTooShort',
  error: 'main.workspace.createFailed'
} satisfies Record<WorkspaceFailureReason, MessageKey | null>

/**
 * #1024: the gate's copy for a back-end start that failed, by the cause main sent (`WorkspaceStateInfo.startFailure`).
 * Main sends no text for it at all: the gate words the cause in its own language, and each text says what helps. The
 * fatal screen (the state itself could not be read) shows `other`'s text too.
 */
export const START_FAILURE_KEYS = {
  drive_not_writable: 'gate.startFailed.notWritable',
  drive_full: 'gate.startFailed.full',
  other: 'gate.startFailed.other'
} satisfies Record<StartFailureCause, MessageKey>

/** The copy key for `failure`'s cause; an own-property read (the cause comes over IPC), and `other` for one the gate does
 *  not know, such as a cause a newer main sends. */
export function startFailureKey(failure: BackendStartFailure | null | undefined): MessageKey {
  const cause = failure?.cause
  return typeof cause === 'string' && Object.hasOwn(START_FAILURE_KEYS, cause)
    ? START_FAILURE_KEYS[cause as StartFailureCause]
    : START_FAILURE_KEYS.other
}
