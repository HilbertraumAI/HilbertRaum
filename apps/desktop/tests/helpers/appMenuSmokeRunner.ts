import { writeFileSync } from 'node:fs'
import { app, BrowserWindow, Menu, session } from 'electron'
import { appMenuTemplate, mainWindowMenuBar } from '../../src/main/app-menu'
import { devToolsAllowed } from '../../src/main/window-security'

// REAL-Electron smoke runner for #912 — NOT a test file. `tests/integration/app-menu-electron-smoke.test.ts` bundles
// this entry with esbuild and spawns it under the locally installed Electron binary, once per build kind. It sets the
// PRODUCTION application menu (`appMenuTemplate`, bundled from `src/main/app-menu.ts`), the production menu-bar rule and
// the production DevTools switch (`devToolsAllowed`, from `src/main/window-security.ts`) on a shown window placed off
// screen, presses keys with `webContents.sendInputEvent` (unlike a CDP key event, it reaches the menu's accelerators;
// a hidden window gets none, measured), and writes what each key did into a result JSON.
//
// A key that must do NOTHING is followed by a key whose effect is awaited (zoom reset to 100 %): keys are handled in
// order, so once that effect shows, the first key was handled too, with no fixed sleep. DevTools open later than that
// (no state shows the start), so their two checks wait for a control window's own DevTools instead. The page is an
// empty data: URL; nothing touches the network, the clipboard or the keyboard focus (the windows show inactive).
//
// Not pressed here: the editing keys (Ctrl+A, Ctrl+Z, copy, paste). On Windows and Linux the browser engine handles
// them in a text field with or without a menu (measured, research A §4), so a row here could not fail on a menu
// change; on macOS they exist only through the edit menu, which the unit template rows pin and a Mac owes by hand.
//
// argv (last two): <resultPath> <build>   build: packaged | dev

const [resultPath, build] = process.argv.slice(-2)
const packaged = build === 'packaged'
const rows: Record<string, unknown> = {}
let written = false
function writeResult(outcome: string, error?: string): void {
  if (written) return
  written = true
  writeFileSync(resultPath!, JSON.stringify({ build, outcome, error, rows }), 'utf8')
}
app.commandLine.appendSwitch('no-proxy-server')
setTimeout(() => {
  writeResult('timeout')
  app.exit(2)
}, 40_000).unref()

/** Poll `check` until it holds, or fail by name after `ms` (a hang detector, not a timing proof). */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > end) throw new Error(`${what} never happened`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

app.whenReady().then(async () => {
  try {
    session.defaultSession.setSpellCheckerLanguages([])
    session.defaultSession.setSpellCheckerEnabled(false)
    const platform = process.platform
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({ platform, packaged })))
    const menuBar = mainWindowMenuBar({ platform, packaged })
    const win = new BrowserWindow({
      show: false,
      x: -4000,
      y: -4000,
      width: 520,
      height: 360,
      skipTaskbar: true,
      autoHideMenuBar: menuBar === 'autoHide',
      webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false, devTools: devToolsAllowed(packaged) }
    })
    if (menuBar === 'hidden') win.setMenuBarVisibility(false)
    let loads = 0
    let devtoolsOpened = 0
    let closes = 0
    win.webContents.on('did-start-loading', () => loads++)
    win.webContents.on('devtools-opened', () => {
      devtoolsOpened++
      win.webContents.closeDevTools()
    })
    win.on('close', (e) => {
      closes++
      e.preventDefault() // Ctrl+W reaches the window's close (the app's close guard); keep the window here
    })
    await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><p>menu smoke</p>'))
    win.showInactive()
    win.webContents.focus()
    await until(() => win.isVisible(), 'the window showing')
    const key = (keyCode: string, modifiers: Array<'control' | 'shift'> = []): void => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    const zoom = (): number => win.webContents.getZoomLevel()
    /** Ctrl+0 from a zoom it set: once it shows, every key pressed before it was handled. */
    const barrier = async (): Promise<void> => {
      win.webContents.setZoomLevel(1)
      key('0', ['control'])
      await until(() => zoom() === 0, 'Ctrl+0 (the barrier)')
    }
    rows.menuBarVisible = win.isMenuBarVisible()

    // Zoom: the in-app route to 200 % (design-guidelines), kept in both builds.
    win.webContents.setZoomLevel(0)
    key('=', ['control'])
    await until(() => zoom() > 0, 'Ctrl+= zooming in')
    rows['Ctrl+='] = zoom() > 0
    let from = zoom()
    key('Plus', ['control', 'shift'])
    await until(() => zoom() > from, 'Ctrl+Shift+= zooming in')
    rows['Ctrl+Shift+='] = true
    from = zoom()
    key('-', ['control'])
    await until(() => zoom() < from, 'Ctrl+- zooming out')
    rows['Ctrl+-'] = true
    await barrier()
    rows['Ctrl+0'] = true

    // The window's close (Ctrl+W, through the close guard in the app).
    key('W', ['control'])
    await until(() => closes > 0, 'Ctrl+W closing the window')
    rows['Ctrl+W'] = true

    // The developer keys: gone in a released build, kept in a development build.
    const loads0 = loads
    key('R', ['control'])
    if (packaged) await barrier()
    else await until(() => loads > loads0, 'Ctrl+R reloading')
    rows['Ctrl+R'] = loads > loads0
    if (!packaged) await until(() => !win.webContents.isLoading(), 'the reload finishing')
    const loads1 = loads
    key('R', ['control', 'shift'])
    if (packaged) await barrier()
    else await until(() => loads > loads1, 'Ctrl+Shift+R reloading')
    rows['Ctrl+Shift+R'] = loads > loads1
    if (!packaged) await until(() => !win.webContents.isLoading(), 'the force reload finishing')
    if (packaged) {
      // DevTools open asynchronously and no state shows that they started (measured), so the zoom barrier cannot
      // tell "refused" from "not open yet". A control window that may open them (DevTools on) opens its own at the
      // same moment, twice in a row; once the control's have opened twice, the main window's would have opened too.
      const control = new BrowserWindow({
        show: false,
        x: -4000,
        y: -3600,
        width: 200,
        height: 150,
        skipTaskbar: true,
        webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false, devTools: true }
      })
      await control.loadURL('data:text/html,<p>control</p>')
      control.showInactive()
      win.webContents.focus()
      let controlOpened = 0
      let controlClosed = 0
      control.webContents.on('devtools-opened', () => controlOpened++)
      control.webContents.on('devtools-closed', () => controlClosed++)
      const controlCycles = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i++) {
          const opened = controlOpened
          const closed = controlClosed
          control.webContents.openDevTools({ mode: 'right' })
          await until(() => controlOpened > opened, 'the control window’s DevTools opening')
          control.webContents.closeDevTools()
          await until(() => controlClosed > closed, 'the control window’s DevTools closing')
        }
      }
      key('I', ['control', 'shift'])
      await controlCycles(2)
      rows['Ctrl+Shift+I'] = devtoolsOpened > 0 || win.webContents.isDevToolsOpened()
      // DevTools off closes the API route too, not only the shortcut.
      win.webContents.openDevTools({ mode: 'right' })
      await controlCycles(2)
      rows.openDevTools = devtoolsOpened > 0 || win.webContents.isDevToolsOpened()
      control.destroy()
    } else {
      key('I', ['control', 'shift'])
      await until(() => devtoolsOpened > 0, 'Ctrl+Shift+I opening DevTools')
      rows['Ctrl+Shift+I'] = true
    }

    // The hidden bar and Alt (review N-5). A released build hides the bar for good: a single Alt and Alt with the
    // first letter of a menu leave it hidden (a mnemonic such as `&File` would bring it up). A development build
    // hides it until Alt: the same Alt shows it, the control that the key reaches the bar at all. Last: a bar that
    // shows takes the keys after it.
    const alt = (letter?: string): void => {
      const keyCode = letter ?? 'Alt'
      // `rawKeyDown` is the key-down Chromium hands to the menu bar's Alt handling; the typings name only `keyDown`.
      const down = { type: 'rawKeyDown', keyCode, modifiers: ['alt'] } as unknown as Electron.KeyboardInputEvent
      win.webContents.sendInputEvent(down)
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: letter ? ['alt'] : [] })
    }
    if (packaged) {
      alt()
      for (const letter of ['F', 'E', 'V', 'W']) alt(letter)
      await barrier()
      rows['Alt, Alt+F/E/V/W'] = win.isMenuBarVisible()
    } else {
      alt()
      await until(() => win.isMenuBarVisible(), 'Alt showing the development build’s menu bar')
      rows.Alt = true
    }
    win.removeAllListeners('close')
    win.destroy()
    writeResult('done')
    app.exit(0)
  } catch (err) {
    writeResult('error', err instanceof Error ? err.message : String(err))
    app.exit(1)
  }
})
