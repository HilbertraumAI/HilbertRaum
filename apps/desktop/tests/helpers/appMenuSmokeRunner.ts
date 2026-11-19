import { app, BrowserWindow, Menu, session } from 'electron'
import { appMenuTemplate, mainWindowMenuBar } from '../../src/main/app-menu'
import { devToolsAllowed } from '../../src/main/window-security'
import { writeSmokeResult } from './electron-smoke-child'

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
// empty data: URL; nothing touches the network or the clipboard. The windows show inactive, but the control window's
// DevTools take the foreground from the user's app when Windows allows it (measured, follow-ups wave 3 W8).
//
// The menu's keys work only in the ACTIVE window, as a user's keys do. In an inactive one the page still gets every
// key, but no accelerator fires: an awaited key never shows its effect, and a key that must do nothing does nothing
// for the wrong reason (measured, W8). Another app taking the foreground takes the activation away mid-run; another
// Electron app starting at the same time (a second smoke run, a dev app) did so every time. So each key step goes
// through `press`: it activates this window and waits for that, presses, and waits for the effect. A key whose own
// effect shows reached an active window. A step that proves a key did NOTHING passes only if the window stayed active
// from before its first key until the Ctrl+0 after it showed. A step that lost the activation runs again (at most
// three times).
//
// Not pressed here: the editing keys (Ctrl+A, Ctrl+Z, copy, paste). On Windows and Linux the browser engine handles
// them in a text field with or without a menu (measured, research A §4), so a row here could not fail on a menu
// change; on macOS they exist only through the edit menu, which the unit template rows pin and a Mac owes by hand.
//
// argv (last three): <resultPath> <selfTimeoutMs> <build>   build: packaged | dev
// (tests/helpers/electron-smoke-child.ts sets the timeout from the row budget)

const [resultPath, selfTimeoutMs, build] = process.argv.slice(-3)
const packaged = build === 'packaged'
const rows: Record<string, unknown> = {}
// Not rows, a diagnosis in the result JSON: the steps that found the window inactive (and activated it first), and the
// steps a lost activation made run again.
const reactivated: string[] = []
const lostActivation: string[] = []
// Where the run is, for the self-timeout's message: the key step and its attempt, and the wait inside it.
let step = 'start-up'
let attemptNo = 0
let waitingFor = 'the app to be ready'
let written = false
function writeResult(outcome: string, error?: string): void {
  if (written) return
  written = true
  writeSmokeResult(resultPath!, { build, outcome, error, rows, reactivated, lostActivation })
}
app.commandLine.appendSwitch('no-proxy-server')
// Under a 12-thread CPU load a released-build run took up to 43 s, and one wait for the control window's DevTools ran
// out at 5 s (alone they open in 0.9-1.5 s; W8). So each wait gets 10 s. The worst case of `press` does NOT fit inside
// this self-timeout (three attempts of up to 10 s for the activation and 10 s for the effect: 60 s for one step), so
// the timeout names where the run was: the step, its attempt and the wait.
setTimeout(() => {
  const where = attemptNo ? `${step}, attempt ${attemptNo}` : step
  writeResult('timeout', `timeout during ${where}, waiting for ${waitingFor}`)
  app.exit(2)
}, Number(selfTimeoutMs)).unref()

/** Poll `check` until it holds or `ms` pass; false on time-out (a hang detector, not a timing proof). */
async function settles(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<boolean> {
  waitingFor = what
  const end = Date.now() + ms
  for (;;) {
    if (await check()) return true
    if (Date.now() > end) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
/** `settles`, failing by name: "<what> never happened". */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  if (!(await settles(check, what, ms))) throw new Error(`${what} never happened`)
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
    // The key step in flight: its `done`, and whether the window lost the activation while `done` did not hold yet
    // (looked at when the `blur` comes, so a blur after the step's effect showed does not count).
    let pending: (() => boolean) | null = null
    let lostBeforeDone = false
    win.webContents.on('did-start-loading', () => loads++)
    win.webContents.on('devtools-opened', () => {
      devtoolsOpened++
      win.webContents.closeDevTools()
    })
    win.on('close', (e) => {
      closes++
      e.preventDefault() // Ctrl+W reaches the window's close (the app's close guard); keep the window here
    })
    win.on('blur', () => {
      if (pending && !pending()) lostBeforeDone = true
    })
    await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><p>menu smoke</p>'))
    win.showInactive()
    await until(() => win.isVisible(), 'the window showing')
    const key = (keyCode: string, modifiers: Array<'control' | 'shift'> = []): void => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    const zoom = (): number => win.webContents.getZoomLevel()
    /**
     * One key step in the active window: activate it and wait for that, `send`, then wait for `done` ("<what> never
     * happened" when it does not come). `send` sets up its own start state and baselines, so a rerun starts afresh.
     * - 'effect': `done` is the key's own effect (a zoom, a close, a reload, DevTools, the bar). Once it shows, the key
     *   reached an active window, whatever came after, so a `blur` does not end the wait. If the effect does not come
     *   and the window lost the activation first, the key was dropped, and the step runs again.
     * - 'barrier': `done` is the Ctrl+0 after keys that must do nothing; it only orders them. A `blur` before it shows
     *   voids the step at once, and the step runs again.
     * At most three attempts.
     */
    type StepKind = 'effect' | 'barrier'
    const press = async (what: string, kind: StepKind, send: () => void, done: () => boolean): Promise<void> => {
      step = what
      for (let attempt = 1; attempt <= 3; attempt++) {
        attemptNo = attempt
        if (!win.isFocused()) reactivated.push(what)
        win.webContents.focus()
        await until(() => win.isFocused(), `the window active (before ${what})`)
        lostBeforeDone = false
        send()
        pending = done
        const shown = await settles(() => done() || (kind === 'barrier' && lostBeforeDone), what)
        pending = null
        if (shown && !(kind === 'barrier' && lostBeforeDone)) {
          attemptNo = 0
          return
        }
        if (!lostBeforeDone) throw new Error(`${what} never happened`)
        if (attempt < 3) lostActivation.push(what)
      }
      throw new Error(`${what}: the window lost the activation three times`)
    }
    /** The barrier keys: Ctrl+0 from a zoom they set. Once it shows, every key pressed before it was handled. */
    const ctrl0 = (): void => {
      win.webContents.setZoomLevel(1)
      key('0', ['control'])
    }
    const zeroed = (): boolean => zoom() === 0
    rows.menuBarVisible = win.isMenuBarVisible()

    // Zoom: the in-app route to 200 % (design-guidelines), kept in both builds.
    let from = 0
    await press(
      'Ctrl+= zooming in',
      'effect',
      () => {
        win.webContents.setZoomLevel(0)
        key('=', ['control'])
      },
      () => zoom() > 0
    )
    rows['Ctrl+='] = zoom() > 0
    await press(
      'Ctrl+Shift+= zooming in',
      'effect',
      () => {
        from = zoom()
        key('Plus', ['control', 'shift'])
      },
      () => zoom() > from
    )
    rows['Ctrl+Shift+='] = true
    await press(
      'Ctrl+- zooming out',
      'effect',
      () => {
        from = zoom()
        key('-', ['control'])
      },
      () => zoom() < from
    )
    rows['Ctrl+-'] = true
    await press('Ctrl+0 resetting the zoom', 'effect', ctrl0, zeroed)
    rows['Ctrl+0'] = true

    // The window's close (Ctrl+W, through the close guard in the app).
    let closes0 = 0
    await press(
      'Ctrl+W closing the window',
      'effect',
      () => {
        closes0 = closes
        key('W', ['control'])
      },
      () => closes > closes0
    )
    rows['Ctrl+W'] = true

    // The developer keys: gone in a released build, kept in a development build. A released build's baseline is
    // taken once, before the step, so a reload from any attempt counts; a development build's in each attempt, so
    // the reload that passes the step is that attempt's own.
    let loads0 = loads
    if (packaged) {
      await press(
        'Ctrl+0 after Ctrl+R (the barrier)',
        'barrier',
        () => {
          key('R', ['control'])
          ctrl0()
        },
        zeroed
      )
    } else {
      await press(
        'Ctrl+R reloading',
        'effect',
        () => {
          loads0 = loads
          key('R', ['control'])
        },
        () => loads > loads0
      )
    }
    rows['Ctrl+R'] = loads > loads0
    if (!packaged) await until(() => !win.webContents.isLoading(), 'the reload finishing')
    loads0 = loads
    if (packaged) {
      await press(
        'Ctrl+0 after Ctrl+Shift+R (the barrier)',
        'barrier',
        () => {
          key('R', ['control', 'shift'])
          ctrl0()
        },
        zeroed
      )
    } else {
      await press(
        'Ctrl+Shift+R reloading',
        'effect',
        () => {
          loads0 = loads
          key('R', ['control', 'shift'])
        },
        () => loads > loads0
      )
    }
    rows['Ctrl+Shift+R'] = loads > loads0
    if (!packaged) await until(() => !win.webContents.isLoading(), 'the force reload finishing')
    if (packaged) {
      // DevTools open asynchronously and no state shows that they started (measured), so the zoom barrier cannot
      // tell "refused" from "not open yet". A control window that may open them (DevTools on) opens its own at the
      // same moment, twice in a row; once the control's have opened twice, the main window's would have opened too.
      // The barrier after Ctrl+Shift+I still shows that the key reached the active window's menu before the control's
      // DevTools took the activation.
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
      await press(
        'Ctrl+0 after Ctrl+Shift+I (the barrier)',
        'barrier',
        () => {
          key('I', ['control', 'shift'])
          ctrl0()
        },
        zeroed
      )
      step = 'the DevTools checks (the control window)'
      await controlCycles(2)
      rows['Ctrl+Shift+I'] = devtoolsOpened > 0 || win.webContents.isDevToolsOpened()
      // DevTools off closes the API route too, not only the shortcut.
      win.webContents.openDevTools({ mode: 'right' })
      await controlCycles(2)
      rows.openDevTools = devtoolsOpened > 0 || win.webContents.isDevToolsOpened()
      control.destroy()
    } else {
      // The baseline is taken in each attempt, so the DevTools that pass the step are that attempt's own.
      let opened0 = devtoolsOpened
      await press(
        'Ctrl+Shift+I opening DevTools',
        'effect',
        () => {
          opened0 = devtoolsOpened
          key('I', ['control', 'shift'])
        },
        () => devtoolsOpened > opened0
      )
      rows['Ctrl+Shift+I'] = true
    }

    // The hidden bar and Alt (review N-5). A released build hides the bar for good: a single Alt and Alt with the
    // first letter of a menu leave it hidden (a mnemonic such as `&File` would bring it up). A development build
    // hides it until Alt: the same Alt shows it, the control that the key reaches the bar at all. Last: a bar that
    // shows takes the keys after it, so the released step also ends when the bar shows (the row then reads true, and
    // the barrier's Ctrl+0 would never come). Here `press` matters most: the control window had the activation, and
    // destroying it gives it back to this window only if no other app took the foreground meanwhile.
    const alt = (letter?: string): void => {
      const keyCode = letter ?? 'Alt'
      // `rawKeyDown` is the key-down Chromium hands to the menu bar's Alt handling; the typings name only `keyDown`.
      const down = { type: 'rawKeyDown', keyCode, modifiers: ['alt'] } as unknown as Electron.KeyboardInputEvent
      win.webContents.sendInputEvent(down)
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: letter ? ['alt'] : [] })
    }
    if (packaged) {
      await press(
        'Ctrl+0 after Alt, Alt+F/E/V/W (the barrier)',
        'barrier',
        () => {
          alt()
          for (const letter of ['F', 'E', 'V', 'W']) alt(letter)
          ctrl0()
        },
        () => zeroed() || win.isMenuBarVisible()
      )
      rows['Alt, Alt+F/E/V/W'] = win.isMenuBarVisible()
    } else {
      // A single Alt toggles an auto-hidden bar, so each attempt starts from a hidden one.
      await press(
        'Alt showing the development build’s menu bar',
        'effect',
        () => {
          win.setMenuBarVisibility(false)
          alt()
        },
        () => win.isMenuBarVisible()
      )
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
