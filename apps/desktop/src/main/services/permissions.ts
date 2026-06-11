// Session permission hardening (Phase 31 rider; wave-3 plan §12 audit item).
//
// Electron's DEFAULT with no permission-request handler installed is to GRANT —
// geolocation, notifications, media, everything (verified in the 2026-06-11 plan
// audit). This app's renderer needs exactly ONE of those: microphone audio for voice
// dictation (Phase 37, D30). The posture is therefore deny-by-default with a single
// scoped exception — `media` requests that ask for AUDIO ONLY, coming from the app's
// own window. Video capture, screen capture, geolocation, notifications and every
// other permission stay refused. Denials are logged by permission NAME only — never
// content.

type PermissionCallback = (granted: boolean) => void

/** The slice of Electron's permission-request `details` the audio scope check reads. */
export interface PermissionRequestDetails {
  /** For `media` requests: the requested capture types, e.g. ['audio'], ['video']. */
  mediaTypes?: readonly string[]
}

/**
 * The slice of Electron's `Session` this module needs. Structural, so tests can pass
 * a fake session and the module never imports `electron` (keeps it unit-testable
 * under plain vitest — the benchmark/gpu injected-deps precedent).
 */
export interface PermissionSessionLike {
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: PermissionCallback,
          // `unknown`, not a structural details type: Electron's `details` is a union
          // whose non-media members share no properties with the media shape, which
          // would fail weak-type assignability against the real `Session`.
          details?: unknown
        ) => void)
      | null
  ): void
}

export interface PermissionHandlerOptions {
  /**
   * The app's own WebContents (reference-compared). When set, a `media` request from
   * exactly this WebContents whose `mediaTypes` are audio-only is GRANTED — the Phase-37
   * dictation microphone. Everything else, including audio requests from any other
   * WebContents and media requests that name video, is still denied.
   */
  allowMicrophoneFor?: unknown
  /** Receives the permission name of each denied request, for the local log. */
  onDeny?: (permission: string) => void
}

/** True only when a `media` request asks for audio and nothing else. An absent or
 *  empty `mediaTypes` is NOT treated as audio — an unverifiable scope stays denied. */
function isAudioOnlyMediaRequest(details: unknown): boolean {
  const types = (details as PermissionRequestDetails | undefined)?.mediaTypes
  if (!Array.isArray(types) || types.length === 0) return false
  return types.every((t) => t === 'audio')
}

/**
 * Install the deny-by-default permission-request handler on a session. Every
 * permission request from renderer content is refused, except the single scoped
 * microphone allow described on `PermissionHandlerOptions.allowMicrophoneFor`.
 */
export function installPermissionRequestHandler(
  session: PermissionSessionLike,
  options: PermissionHandlerOptions = {}
): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const granted =
      permission === 'media' &&
      options.allowMicrophoneFor !== undefined &&
      webContents === options.allowMicrophoneFor &&
      isAudioOnlyMediaRequest(details)
    if (!granted) options.onDeny?.(permission)
    callback(granted)
  })
}
