import type { BrowserWindow, Dialog, MessageBoxOptions, Shell } from 'electron'
import type { MessageKey, MessageParams } from '../shared/i18n'

// #236 (owner decision #221 — "confirmation"): the consenting opener behind the window-open
// policy. The renderer is the untrusted boundary, and an http(s) `window.open` used to go
// straight from it to `shell.openExternal` — unconfirmed, unthrottled, invisible to the CSP and
// to the Node-socket tripwire — so after a renderer compromise everything it can read while
// unlocked could leave through visible browser windows, and a hostile manifest's licence link
// needed only a click. Now every such open shows ONE native dialog that names the site and the
// full URL, with Cancel as the default (Enter) and the Esc button; the OS browser is reached
// only from the Open button, and further requests are DROPPED while a dialog is open (a flood
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

/**
 * The URL as the dialog shows it: unchanged when it fits the budget, else the whole authority
 * (scheme + credentials + host + port — everything before the path) plus the head of the
 * path/query/fragment and an ellipsis, with the count of characters NOT shown. The cut never
 * touches the authority and always keeps the path's leading `/`, so the shown string parses to
 * the SAME origin as the URL that opens — a display cut that lost the host would let a
 * look-alike path masquerade as the site. When the URL is nothing but authority (no path to
 * cut) it is shown whole regardless of the budget.
 */
export function describeUrlForDisplay(
  href: string,
  budget: number = EXTERNAL_URL_DISPLAY_BUDGET
): { shown: string; hidden: number } {
  if (href.length <= budget) return { shown: href, hidden: 0 }
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { shown: href, hidden: 0 }
  }
  // WHATWG serialisation is exactly authority + pathname + search + hash, so the authority is
  // the prefix left after removing those three (credentials included — never hidden).
  const tail = url.pathname + url.search + url.hash
  const head = href.slice(0, href.length - tail.length)
  if (tail.length === 0) return { shown: href, hidden: 0 }
  const keep = Math.max(1, budget - head.length)
  if (keep >= tail.length) return { shown: href, hidden: 0 }
  return { shown: `${head}${tail.slice(0, keep)}…`, hidden: tail.length - keep }
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
    dialogOpen = true
    const href = url.href // normalised: lower-case host, punycode, percent-encoded path
    const { shown, hidden } = describeUrlForDisplay(href)
    const detail = [
      deps.t('main.dialog.openLink.site', { site: url.origin }),
      shown,
      ...(hidden > 0 ? [deps.t('main.dialog.openLink.truncated', { hidden })] : []),
      '',
      deps.t('main.dialog.openLink.hint')
    ].join('\n')
    const options: MessageBoxOptions = {
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
    const parent = win && !win.isDestroyed() ? win : null
    void Promise.resolve()
      .then(() => (parent ? deps.dialog.showMessageBox(parent, options) : deps.dialog.showMessageBox(options)))
      .then(({ response }) => (response === 0 ? deps.shell.openExternal(href) : undefined))
      .catch(() => undefined) // a failed dialog or browser launch opens nothing; nothing to surface
      .finally(() => {
        dialogOpen = false
      })
  }
}
