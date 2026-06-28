import { describe, it, expect, vi } from 'vitest'
import {
  installPermissionRequestHandler,
  installPermissionCheckHandler,
  type PermissionCheckDetails,
  type PermissionCheckSessionLike,
  type PermissionRequestDetails,
  type PermissionSessionLike
} from '../../src/main/services/permissions'

// Phase 31 session-hardening rider (wave-3 plan §12): Electron GRANTS permission
// requests when no handler is installed, so the app installs a deny-by-default
// handler. Phase 37 added the single scoped exception: `media` requests that ask for
// AUDIO ONLY, from the app's own WebContents (voice dictation). The matrix below is
// the security boundary — the allow must not loosen anything else.

type Handler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details?: PermissionRequestDetails
) => void

function fakeSession(): { session: PermissionSessionLike; getHandler: () => Handler } {
  let handler: Handler | null = null
  return {
    session: {
      setPermissionRequestHandler(h) {
        handler = h as Handler
      }
    },
    getHandler: () => {
      if (!handler) throw new Error('no handler installed')
      return handler
    }
  }
}

function decision(handler: Handler, webContents: unknown, permission: string, details?: PermissionRequestDetails): boolean {
  const callback = vi.fn()
  handler(webContents, permission, callback, details)
  expect(callback).toHaveBeenCalledTimes(1)
  return callback.mock.calls[0][0] as boolean
}

describe('installPermissionRequestHandler', () => {
  it('denies every permission request when no microphone allow is configured', () => {
    const { session, getHandler } = fakeSession()
    installPermissionRequestHandler(session)
    const handler = getHandler()
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'unknown-future-permission']) {
      expect(decision(handler, {}, permission, { mediaTypes: ['audio'] })).toBe(false)
    }
  })

  it('grants media for an audio-only request from exactly the allowed WebContents', () => {
    const { session, getHandler } = fakeSession()
    const ownWebContents = { id: 'main-window' }
    installPermissionRequestHandler(session, { allowMicrophoneFor: ownWebContents })
    expect(decision(getHandler(), ownWebContents, 'media', { mediaTypes: ['audio'] })).toBe(true)
  })

  it('the microphone allow does not loosen anything else (the Phase-37 scope matrix)', () => {
    const { session, getHandler } = fakeSession()
    const ownWebContents = { id: 'main-window' }
    installPermissionRequestHandler(session, { allowMicrophoneFor: ownWebContents })
    const handler = getHandler()

    // Same permission, wrong requester.
    expect(decision(handler, { id: 'other' }, 'media', { mediaTypes: ['audio'] })).toBe(false)
    // Video — alone or alongside audio — stays denied.
    expect(decision(handler, ownWebContents, 'media', { mediaTypes: ['video'] })).toBe(false)
    expect(decision(handler, ownWebContents, 'media', { mediaTypes: ['audio', 'video'] })).toBe(false)
    // An unverifiable scope (missing/empty mediaTypes) stays denied.
    expect(decision(handler, ownWebContents, 'media', undefined)).toBe(false)
    expect(decision(handler, ownWebContents, 'media', {})).toBe(false)
    expect(decision(handler, ownWebContents, 'media', { mediaTypes: [] })).toBe(false)
    // Every non-media permission from the allowed WebContents stays denied.
    for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'openExternal', 'mediaKeySystem', 'display-capture']) {
      expect(decision(handler, ownWebContents, permission, { mediaTypes: ['audio'] })).toBe(false)
    }
  })

  it('reports the denied permission NAME to the log hook (never more), and stays silent on grants', () => {
    const { session, getHandler } = fakeSession()
    const ownWebContents = {}
    const onDeny = vi.fn()
    installPermissionRequestHandler(session, { allowMicrophoneFor: ownWebContents, onDeny })
    const handler = getHandler()

    decision(handler, {}, 'geolocation')
    expect(onDeny).toHaveBeenCalledTimes(1)
    expect(onDeny).toHaveBeenCalledWith('geolocation')

    decision(handler, ownWebContents, 'media', { mediaTypes: ['audio'] })
    expect(onDeny).toHaveBeenCalledTimes(1) // the grant did not report
  })
})

// SEC-2 (backend-audit-2026-06-27): Electron's SYNCHRONOUS permission-check path
// (`navigator.permissions.query`, the internal pre-getUserMedia check) is independent of the
// request path and ALSO defaults to grant when no handler is installed. The check handler must
// mirror the request handler exactly — deny-by-default, audio-only `media` from the app's own
// WebContents — using the SAME grant predicate so the two can never drift. Note the check path
// carries a SCALAR `mediaType` (not the request path's `mediaTypes` array).

type CheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: PermissionCheckDetails
) => boolean

function fakeCheckSession(): {
  session: PermissionCheckSessionLike
  getHandler: () => CheckHandler
} {
  let handler: CheckHandler | null = null
  return {
    session: {
      setPermissionCheckHandler(h) {
        handler = h as CheckHandler
      }
    },
    getHandler: () => {
      if (!handler) throw new Error('no check handler installed')
      return handler
    }
  }
}

describe('installPermissionCheckHandler', () => {
  const ORIGIN = 'file://'

  it('denies every permission check when no microphone allow is configured', () => {
    const { session, getHandler } = fakeCheckSession()
    installPermissionCheckHandler(session)
    const handler = getHandler()
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'unknown-future']) {
      expect(handler({}, permission, ORIGIN, { mediaType: 'audio' })).toBe(false)
    }
  })

  it('grants an audio media check from exactly the allowed WebContents', () => {
    const { session, getHandler } = fakeCheckSession()
    const ownWebContents = { id: 'main-window' }
    installPermissionCheckHandler(session, { allowMicrophoneFor: ownWebContents })
    expect(getHandler()(ownWebContents, 'media', ORIGIN, { mediaType: 'audio' })).toBe(true)
  })

  it('denies a NON-audio permission check (the SEC-2 boundary)', () => {
    const { session, getHandler } = fakeCheckSession()
    const ownWebContents = { id: 'main-window' }
    installPermissionCheckHandler(session, { allowMicrophoneFor: ownWebContents })
    const handler = getHandler()

    // Same allowed WebContents, but not an audio media check → denied.
    expect(handler(ownWebContents, 'media', ORIGIN, { mediaType: 'video' })).toBe(false)
    expect(handler(ownWebContents, 'media', ORIGIN, { mediaType: 'unknown' })).toBe(false)
    expect(handler(ownWebContents, 'media', ORIGIN, {})).toBe(false) // unverifiable scope
    expect(handler(ownWebContents, 'geolocation', ORIGIN, { mediaType: 'audio' })).toBe(false)
    expect(handler(ownWebContents, 'notifications', ORIGIN, {})).toBe(false)
    // Audio, but the wrong requester (e.g. a null/foreign WebContents) → denied.
    expect(handler({ id: 'other' }, 'media', ORIGIN, { mediaType: 'audio' })).toBe(false)
    expect(handler(null, 'media', ORIGIN, { mediaType: 'audio' })).toBe(false)
  })

  it('check and request agree: both grant audio, both deny video, from the app WebContents', () => {
    const ownWebContents = { id: 'main-window' }

    const req = fakeSession()
    installPermissionRequestHandler(req.session, { allowMicrophoneFor: ownWebContents })
    const chk = fakeCheckSession()
    installPermissionCheckHandler(chk.session, { allowMicrophoneFor: ownWebContents })

    // Audio: both allow.
    expect(decision(req.getHandler(), ownWebContents, 'media', { mediaTypes: ['audio'] })).toBe(true)
    expect(chk.getHandler()(ownWebContents, 'media', ORIGIN, { mediaType: 'audio' })).toBe(true)
    // Video: both deny.
    expect(decision(req.getHandler(), ownWebContents, 'media', { mediaTypes: ['video'] })).toBe(false)
    expect(chk.getHandler()(ownWebContents, 'media', ORIGIN, { mediaType: 'video' })).toBe(false)
  })
})
