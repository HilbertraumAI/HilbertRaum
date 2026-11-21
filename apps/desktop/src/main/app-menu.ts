// The application menu (#912). Electron's default menu, which the app shipped until #912 because it never set
// one, is a developer's menu: View → Reload (Ctrl+R) and Force Reload (Ctrl+Shift+R) reload the window, which
// closes nothing and so drops a review change the window had not saved yet (#888 saves on every close, not on a
// reload), and Toggle Developer Tools (Ctrl+Shift+I) opens a console that holds the renderer's `window.api`.
// A released build now gets the same menu without those three items; a development build keeps them.
//
// What stays, and why it matters (Electron 43.8.6 role table; Windows measured with `webContents.sendInputEvent`,
// owner call G-2 of follow-ups wave 3):
// - Edit: undo, redo, cut, copy, paste, select all. On Windows and Linux the browser engine handles them in a text
//   field anyway; on macOS ⌘C/⌘V/⌘X/⌘Z/⌘A exist ONLY through these menu items, as ⌘Q, ⌘H and ⌘W do through the app,
//   file and window menus. So macOS gets the full role menu.
// - View: actual size (Ctrl+0), zoom in (Ctrl+Plus), zoom out (Ctrl+-) and full screen (F11). Zoom is the in-app
//   route to the 200 % the accessibility posture names (docs/design-guidelines.md); without a menu it is gone.
// - Window: minimize (Ctrl+M) and close (Ctrl+W, which goes through the close guard like the X).
// - A hidden second zoom in on `CommandOrControl+=`: Electron maps `CommandOrControl+Plus` to Ctrl+Shift+= only,
//   so Ctrl+= on a US keyboard did not zoom in (measured at the virtual-key level; the German keyboard's Ctrl and +
//   is the same virtual key, which a physical key press on a packaged build still owes). On macOS the hidden item
//   keeps its key too (`acceleratorWorksWhenHidden` defaults to true there).
//
// The labels are Electron's English role labels. On Windows and Linux a released build hides the menu bar for good
// (`mainWindowMenuBar`), so no English bar shows in a translated interface and the window gains the bar's height;
// every shortcut above still works with the bar hidden (measured). A development build hides it until Alt is
// pressed, so a developer (and the UI Automation walk kits) can still reach File → Exit and View → Reload.
//
// Electron-free (type-only import), like window-security.ts: tests/unit/app-menu.test.ts drives it, and the
// real-Electron row (tests/integration/app-menu-electron-smoke.test.ts) bundles it.

import type { MenuItemConstructorOptions } from 'electron'

export interface AppMenuOptions {
  /** `process.platform`. */
  platform: NodeJS.Platform
  /** `app.isPackaged`: a released build. */
  packaged: boolean
}

/** The accelerator of the hidden zoom-in item: Ctrl+= on Windows and Linux, ⌘= on macOS. */
export const ZOOM_IN_ALIAS_ACCELERATOR = 'CommandOrControl+='

/** The template `index.ts` builds the application menu from, once, before the first window. */
export function appMenuTemplate({ platform, packaged }: AppMenuOptions): MenuItemConstructorOptions[] {
  const appMenu: MenuItemConstructorOptions[] = platform === 'darwin' ? [{ role: 'appMenu' }] : []
  const developer: MenuItemConstructorOptions[] = packaged
    ? []
    : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
  return [
    ...appMenu,
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...developer,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomIn', accelerator: ZOOM_IN_ALIAS_ACCELERATOR, visible: false },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
}

/**
 * The main window's menu bar on Windows and Linux: hidden for good in a released build (Alt does not bring it
 * back), hidden until Alt in a development build. macOS has no menu bar in the window (`'none'`); the menu is the
 * system's.
 */
export function mainWindowMenuBar({ platform, packaged }: AppMenuOptions): 'hidden' | 'autoHide' | 'none' {
  if (platform === 'darwin') return 'none'
  return packaged ? 'hidden' : 'autoHide'
}
