import type { MessageKey } from './i18n'
import type { WorkspaceActionResult } from './types'

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
// `null` (and a reason missing at runtime) shows main's `message`. Create's `refused` is then
// the vault's own sentence (plaintext not permitted, a workspace already exists), which has
// no catalog key. Main's other create refusal, a password under MIN_PASSWORD_LENGTH, can't
// answer the gate: its `canSubmit` holds the same floor before sending. That is decided by
// what the gate knows, never by matching the text (i18n record §3.3 Rule 3).

/** Why an unlock or create failed: the `reason` of a failed `WorkspaceActionResult`. */
export type WorkspaceFailureReason = Extract<WorkspaceActionResult, { ok: false }>['reason']

/** The gate's copy for a failed unlock, by reason (`null`: show main's `message`). */
export const UNLOCK_FAILURE_KEYS = {
  wrong_password: 'main.workspace.wrongPassword',
  vault_damaged: 'main.workspace.vaultDamaged',
  vault_recovery_blocked: 'main.workspace.recoveryBlocked',
  workspace_newer: 'main.workspace.newer',
  // `null`: main never sends this reason for this call. If it ever does, give the entry a key:
  // a `null` shows main's `message`, in main's language, and the screen is in two languages again.
  refused: null,
  error: 'main.workspace.openFailed'
} satisfies Record<WorkspaceFailureReason, MessageKey | null>

/** The gate's copy for a failed create, by reason (`null`: show main's `message`). */
export const CREATE_FAILURE_KEYS = {
  // `null`: main never sends these three for create (what a `null` costs: UNLOCK_FAILURE_KEYS).
  wrong_password: null,
  vault_damaged: null,
  vault_recovery_blocked: null,
  workspace_newer: 'main.workspace.newer',
  // The one `null` main does send: the vault's own sentence, which has no catalog key.
  refused: null,
  error: 'main.workspace.createFailed'
} satisfies Record<WorkspaceFailureReason, MessageKey | null>
