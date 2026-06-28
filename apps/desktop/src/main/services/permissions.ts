// Session permission hardening.
//
// Electron's DEFAULT with no permission handlers installed is to GRANT —
// geolocation, notifications, media, everything. This app's renderer needs exactly
// ONE of those: microphone audio for voice dictation. The posture is therefore
// deny-by-default with a single scoped exception — `media` for AUDIO ONLY, coming
// from the app's own window. Video capture, screen capture, geolocation, notifications
// and every other permission stay refused. Denials are logged by permission NAME only
// — never content.
//
// Electron exposes TWO independent permission paths and the default-grant pitfall
// applies to BOTH: the asynchronous *request* path (`setPermissionRequestHandler`,
// e.g. `getUserMedia`'s prompt) and the synchronous *check* path
// (`setPermissionCheckHandler`, e.g. `navigator.permissions.query` and the internal
// pre-`getUserMedia` capability check). SEC-2 (backend-audit-2026-06-27): only the
// request handler was installed, so the check path fell back to Electron's default.
// Both handlers below share ONE grant predicate (`grantsMicrophone`) so request and
// check can never drift out of sync — both deny-by-default except app-origin audio.

type PermissionCallback = (granted: boolean) => void

/** The slice of Electron's permission-request `details` the audio scope check reads. */
export interface PermissionRequestDetails {
  /** For `media` requests: the requested capture types, e.g. ['audio'], ['video']. */
  mediaTypes?: readonly string[]
}

/** The slice of Electron's permission-CHECK `details` the audio scope check reads. */
export interface PermissionCheckDetails {
  /**
   * For a `media` check: the SINGLE capture type being probed ('audio' | 'video' |
   * 'unknown') — note the check path uses a scalar `mediaType`, not the request path's
   * `mediaTypes` array.
   */
  mediaType?: string
}

/**
 * The slice of Electron's `Session` this module needs for the REQUEST path. Structural,
 * so tests can pass a fake session and the module never imports `electron` (keeps it
 * unit-testable under plain vitest).
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

/** The slice of Electron's `Session` this module needs for the CHECK path (SEC-2). */
export interface PermissionCheckSessionLike {
  setPermissionCheckHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          requestingOrigin: string,
          // `unknown` for the same union-assignability reason as the request handler.
          details: unknown
        ) => boolean)
      | null
  ): void
}

export interface PermissionHandlerOptions {
  /**
   * The app's own WebContents (reference-compared). When set, a `media` request from
   * exactly this WebContents whose `mediaTypes` are audio-only is GRANTED — the
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

/** True only when a `media` CHECK probes the audio capture type. A missing/`video`/
 *  `unknown` `mediaType` is NOT audio — an unverifiable scope stays denied. */
function isAudioMediaCheck(details: unknown): boolean {
  return (details as PermissionCheckDetails | undefined)?.mediaType === 'audio'
}

/**
 * THE single grant predicate, shared by the request and check handlers so they cannot
 * diverge (SEC-2). Grants only `media`, audio-scoped, from EXACTLY the app's own
 * WebContents (`allowMicrophoneFor`) — which is the app-origin binding. `audioScoped`
 * is the path-specific audio test (array for request, scalar for check). Everything
 * else — any other permission, any other WebContents, any video involvement, an absent
 * `allowMicrophoneFor` — is denied.
 */
function grantsMicrophone(
  permission: string,
  webContents: unknown,
  options: PermissionHandlerOptions,
  audioScoped: boolean
): boolean {
  return (
    permission === 'media' &&
    options.allowMicrophoneFor !== undefined &&
    webContents === options.allowMicrophoneFor &&
    audioScoped
  )
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
    const granted = grantsMicrophone(permission, webContents, options, isAudioOnlyMediaRequest(details))
    if (!granted) options.onDeny?.(permission)
    callback(granted)
  })
}

/**
 * Install the deny-by-default permission-CHECK handler on a session (SEC-2) — the
 * synchronous counterpart to the request handler. Returns `false` (deny) for every
 * permission except the same scoped microphone allow: `media`/audio from the app's own
 * WebContents. Uses the shared `grantsMicrophone` predicate, so check and request always
 * agree. `onDeny` is intentionally NOT wired here: the check path is high-frequency
 * (e.g. `navigator.permissions.query` polling) and logging every denied check would
 * spam the diagnostics log to no benefit — the request handler already records denials.
 */
export function installPermissionCheckHandler(
  session: PermissionCheckSessionLike,
  options: PermissionHandlerOptions = {}
): void {
  session.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) =>
    grantsMicrophone(permission, webContents, options, isAudioMediaCheck(details))
  )
}
