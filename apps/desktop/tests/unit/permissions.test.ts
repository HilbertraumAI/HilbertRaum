import { describe, it, expect, vi } from 'vitest'
import {
  installDenyAllPermissionHandler,
  type PermissionSessionLike
} from '../../src/main/services/permissions'

// Phase 31 session-hardening rider (wave-3 plan §12): Electron GRANTS permission
// requests when no handler is installed, so the app installs a deny-by-default
// handler with NO exceptions (the scoped `media` exception arrives with Phase 37).

type Handler = (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void

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

describe('installDenyAllPermissionHandler', () => {
  it('denies every permission request, whatever the permission', () => {
    const { session, getHandler } = fakeSession()
    installDenyAllPermissionHandler(session)
    const handler = getHandler()
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'unknown-future-permission']) {
      const callback = vi.fn()
      handler({}, permission, callback)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(false)
    }
  })

  it('reports the denied permission NAME to the log hook (never more)', () => {
    const { session, getHandler } = fakeSession()
    const onDeny = vi.fn()
    installDenyAllPermissionHandler(session, onDeny)
    getHandler()({}, 'geolocation', () => {})
    expect(onDeny).toHaveBeenCalledTimes(1)
    expect(onDeny).toHaveBeenCalledWith('geolocation')
  })
})
