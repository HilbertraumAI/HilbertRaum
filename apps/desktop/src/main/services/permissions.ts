// Session permission hardening (Phase 31 rider; wave-3 plan §12 audit item).
//
// Electron's DEFAULT with no permission-request handler installed is to GRANT —
// geolocation, notifications, media, everything (verified in the 2026-06-11 plan
// audit). This app's renderer needs none of those today, so the posture is
// deny-by-default with NO exceptions. Phase 37 (voice dictation) will add the single
// scoped `media` (audio) exception here; until then every request is refused.
// Denials are logged by permission NAME only — never content.

type PermissionCallback = (granted: boolean) => void

/**
 * The slice of Electron's `Session` this module needs. Structural, so tests can pass
 * a fake session and the module never imports `electron` (keeps it unit-testable
 * under plain vitest — the benchmark/gpu injected-deps precedent).
 */
export interface PermissionSessionLike {
  setPermissionRequestHandler(
    handler: ((webContents: unknown, permission: string, callback: PermissionCallback) => void) | null
  ): void
}

/**
 * Install the deny-by-default permission-request handler on a session. Every
 * permission request from renderer content is refused; `onDeny` (optional) receives
 * the permission name for the local log.
 */
export function installDenyAllPermissionHandler(
  session: PermissionSessionLike,
  onDeny?: (permission: string) => void
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    onDeny?.(permission)
    callback(false)
  })
}
