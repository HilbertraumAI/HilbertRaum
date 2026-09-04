import type { BrowserWindow, Dialog, MessageBoxOptions, Shell } from 'electron'
import type { MessageKey, MessageParams } from '../shared/i18n'

// #236 (owner decision #221 — "confirmation"): the consenting opener behind the window-open
// policy. The renderer is the untrusted boundary, and an http(s) `window.open` used to go
// straight from it to `shell.openExternal` — unconfirmed, unthrottled, invisible to the CSP and
// to the Node-socket tripwire — so after a renderer compromise everything it can read while
// unlocked could leave through visible browser windows, and a hostile manifest's licence link
// needed only a click. Now every such open shows ONE native dialog that names the site and the
// URL, with Cancel as the default (Enter) and the Esc button; the OS browser is reached only
// from the Open button, and further requests are DROPPED while a dialog is open (a flood
// cannot stack dialogs or race a click). `dialog`/`shell`/window/i18n are injected so the opener
// is unit-testable without Electron (tests/unit/external-open.test.ts); `index.ts` wires the
// real ones.

/** Characters of the URL the dialog shows before it cuts the path (the origin is never cut). */
export const EXTERNAL_URL_DISPLAY_BUDGET = 200

export interface ExternalOpenerDeps {
  dialog: Pick<Dialog, 'showMessageBox'>
  shell: Pick<Shell, 'openExternal'>
  /** The window the dialog is modal to; null (or destroyed) ⇒ an app-modal dialog. */
  getWindow: () => BrowserWindow | null
  /** Main-side copy (`tMain`): the strings ride in the user's UI language, never persisted. */
  t: (key: MessageKey, params?: MessageParams) => string
}

export interface UrlDisplay {
  /** What the dialog shows on the URL line: origin + path/query/fragment, cut past the budget. */
  shown: string
  /** Characters of the path/query/fragment NOT shown (0 when nothing was cut). */
  hidden: number
  /** The URL carried a username and/or password — dropped from `shown`, flagged in the dialog. */
  credentials: boolean
}

/**
 * The URL as the dialog shows it, built from the PARSED URL — never from the input string:
 * the origin (scheme + host + port) followed by the path, query and fragment, cut with `…`
 * past the budget with the count of characters not shown. The cut never touches the origin
 * and always keeps the path's leading `/`, so the shown string parses to the SAME origin as
 * the URL that opens — a display cut that lost the host would let a look-alike path
 * masquerade as the site. Userinfo (`https://www.bank.example@evil.test/`) is the classic
 * display deception, so it is dropped from the shown string and reported as `credentials`
 * for the dialog to flag; the Site line always names the real origin. A URL that is nothing
 * but origin is shown whole regardless of the budget.
 */
export function describeUrlForDisplay(href: string, budget: number = EXTERNAL_URL_DISPLAY_BUDGET): UrlDisplay {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { shown: href, hidden: 0, credentials: false }
  }
  const credentials = url.username !== '' || url.password !== ''
  const head = url.origin
  const tail = url.pathname + url.search + url.hash
  const full = head + tail
  if (tail.length === 0 || full.length <= budget) return { shown: full, hidden: 0, credentials }
  const keep = Math.max(1, budget - head.length)
  if (keep >= tail.length) return { shown: full, hidden: 0, credentials }
  return { shown: `${head}${tail.slice(0, keep)}…`, hidden: tail.length - keep, credentials }
}

/**
 * Build the opener the window-open policy calls with every http(s) URL. Returns synchronously
 * (the policy must deny the in-app open at once); the dialog and the browser open run
 * afterwards. Non-web schemes are dropped here too — defence in depth behind the policy, which
 * already filters them.
 */
export function createExternalOpener(deps: ExternalOpenerDeps): (url: string) => void {
  let dialogOpen = false
  return (raw: string): void => {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    if (dialogOpen) return // one dialog at a time: a burst of opens shows one and drops the rest
    const href = url.href // normalised: lower-case host, punycode, percent-encoded path
    // Everything synchronous is prepared BEFORE the guard is armed, so a throw here (a copy
    // lookup, a half-torn-down window handle) can never latch the guard and silence every
    // later link; such a request simply opens nothing.
    let options: MessageBoxOptions
    let parent: BrowserWindow | null
    try {
      const { shown, hidden, credentials } = describeUrlForDisplay(href)
      const detail = [
        deps.t('main.dialog.openLink.site', { site: url.origin }),
        shown,
        ...(hidden > 0 ? [deps.t('main.dialog.openLink.truncated', { hidden })] : []),
        ...(credentials ? [deps.t('main.dialog.openLink.credentials')] : []),
        '',
        deps.t('main.dialog.openLink.hint')
      ].join('\n')
      options = {
        type: 'question',
        title: deps.t('main.dialog.openLink.title'),
        message: deps.t('main.dialog.openLink.message'),
        detail,
        buttons: [deps.t('main.dialog.openLink.open'), deps.t('main.dialog.openLink.cancel')],
        defaultId: 1, // Enter = Cancel
        cancelId: 1, // Esc = Cancel
        noLink: true // plain buttons on Windows, not command links
      }
      const win = deps.getWindow()
      parent = win && !win.isDestroyed() ? win : null
    } catch {
      return
    }
    dialogOpen = true
    void Promise.resolve()
      .then(() => (parent ? deps.dialog.showMessageBox(parent, options) : deps.dialog.showMessageBox(options)))
      .then(({ response }) => (response === 0 ? deps.shell.openExternal(href) : undefined))
      .catch(() => undefined) // a failed dialog or browser launch opens nothing; nothing to surface
      .finally(() => {
        dialogOpen = false
      })
  }
}
