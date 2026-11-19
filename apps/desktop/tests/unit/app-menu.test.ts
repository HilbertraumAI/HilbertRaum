import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { ZOOM_IN_ALIAS_ACCELERATOR, appMenuTemplate, mainWindowMenuBar } from '../../src/main/app-menu'

// #912: the app sets its own application menu. Electron's default one shipped View → Reload and Force Reload, which
// reload the window without closing it and so drop a review change not yet saved (#888 saves on a close, not on a
// reload), and Toggle Developer Tools, a console holding the renderer's `window.api`. A released build has none of
// the three; a development build keeps them. Every shortcut a user has stays (zoom is the in-app route to 200 %, and on
// macOS copy, paste and quit exist only through the menu). What the template does on real Electron — the keys
// pressed, the bar hidden — is tests/integration/app-menu-electron-smoke.test.ts's (local only, no binary on CI).

const PLATFORMS: NodeJS.Platform[] = ['win32', 'linux', 'darwin']

/** Every item at every depth, the top-level menus included. */
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu as MenuItemConstructorOptions[]) : [])
  ])
}
const roles = (items: MenuItemConstructorOptions[]): string[] =>
  flatten(items).flatMap((item) => (item.role ? [item.role] : []))

describe('the application menu template (#912)', () => {
  it.each(PLATFORMS)('a released build on %s has no reload, force reload or developer tools; a development build keeps all three', (platform) => {
    const developer = ['reload', 'forceReload', 'toggleDevTools']
    const packaged = roles(appMenuTemplate({ platform, packaged: true }))
    for (const role of developer) expect(packaged, role).not.toContain(role)
    const dev = roles(appMenuTemplate({ platform, packaged: false }))
    for (const role of developer) expect(dev, role).toContain(role)
  })

  it.each(PLATFORMS.flatMap((platform) => [true, false].map((packaged) => [platform, packaged] as const)))(
    'on %s (released build: %s) every user shortcut stays: file, edit, zoom, full screen, window',
    (platform, packaged) => {
      const template = appMenuTemplate({ platform, packaged })
      const all = roles(template)
      for (const role of ['fileMenu', 'editMenu', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'windowMenu']) {
        expect(all, role).toContain(role)
      }
      // macOS: the app menu comes first (Quit ⌘Q, Hide ⌘H), and ⌘C/⌘V/⌘X/⌘Z/⌘A exist only through the edit menu's
      // roles (native selectors there). Windows and Linux have no app menu.
      if (platform === 'darwin') expect(template[0]).toEqual({ role: 'appMenu' })
      else expect(all).not.toContain('appMenu')
    }
  )

  it.each(PLATFORMS)('on %s a hidden second zoom in answers Ctrl+= (US) and the German Ctrl++ (#912 S7)', (platform) => {
    // Electron maps the zoom-in role's own `CommandOrControl+Plus` to Ctrl+Shift+= only (measured).
    expect(ZOOM_IN_ALIAS_ACCELERATOR).toBe('CommandOrControl+=')
    for (const packaged of [true, false]) {
      const aliases = flatten(appMenuTemplate({ platform, packaged })).filter(
        (item) => item.accelerator === ZOOM_IN_ALIAS_ACCELERATOR
      )
      expect(aliases).toEqual([{ role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false }])
    }
  })

  it('the menu bar: hidden for good in a released build on Windows and Linux, until Alt in a development build; none in a macOS window', () => {
    expect(mainWindowMenuBar({ platform: 'win32', packaged: true })).toBe('hidden')
    expect(mainWindowMenuBar({ platform: 'linux', packaged: true })).toBe('hidden')
    expect(mainWindowMenuBar({ platform: 'win32', packaged: false })).toBe('autoHide')
    expect(mainWindowMenuBar({ platform: 'linux', packaged: false })).toBe('autoHide')
    expect(mainWindowMenuBar({ platform: 'darwin', packaged: true })).toBe('none')
    expect(mainWindowMenuBar({ platform: 'darwin', packaged: false })).toBe('none')
  })

  it('index.ts sets the menu from the template inside whenReady, before the first window, and applies the bar to the main window', () => {
    // Source-text pin (the window-security.test.ts idiom): index.ts cannot be imported under vitest. Electron installs
    // its default menu unless the app sets one, and each window on Windows and Linux takes the menu set at its creation.
    const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const set = src.indexOf(
      'Menu.setApplicationMenu(\n    Menu.buildFromTemplate(appMenuTemplate({ platform: process.platform, packaged: app.isPackaged }))\n  )'
    )
    const whenReady = src.indexOf('app.whenReady().then(')
    expect(whenReady).toBeGreaterThan(0)
    expect(set).toBeGreaterThan(whenReady)
    expect(set).toBeLessThan(src.indexOf('createWindow()', set))
    expect(src.split('Menu.setApplicationMenu(').length - 1).toBe(1)
    expect(src).toContain('const menuBar = mainWindowMenuBar({ platform: process.platform, packaged: app.isPackaged })')
    expect(src).toContain("autoHideMenuBar: menuBar === 'autoHide',")
    expect(src).toContain("if (menuBar === 'hidden') mainWindow.setMenuBarVisibility(false)")
  })
})
