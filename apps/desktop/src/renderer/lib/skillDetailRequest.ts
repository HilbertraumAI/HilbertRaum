// #46 — a one-shot renderer-side mailbox that lets the composer's skill info card deep-link the
// Skills screen's detail modal ("Learn more"). ChatScreen stores the target installId and
// navigates; SkillsTab consumes it once its list has loaded and opens the matching detail. Module
// state (the skill-run store precedent) — nothing crosses the IPC, nothing persists: an unconsumed
// request simply evaporates with the window.

let pending: string | null = null

/** Ask the Skills screen to open this skill's detail modal on its next load. */
export function requestSkillDetail(installId: string): void {
  pending = installId
}

/** Take (and clear) the pending detail request, if any. */
export function consumeSkillDetailRequest(): string | null {
  const p = pending
  pending = null
  return p
}

/**
 * Workspace-lock purge (SH-4, #149 — the lockPurge.ts seam): a pending installId from before
 * the lock must not pop a detail modal on the next unlock's first Skills visit.
 */
export function clearSkillDetailRequest(): void {
  pending = null
}

/** Test-only: drop any pending request so cases stay independent. */
export function resetSkillDetailRequestForTests(): void {
  pending = null
}
