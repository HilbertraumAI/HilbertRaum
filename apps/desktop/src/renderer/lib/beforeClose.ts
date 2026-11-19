import type { SaveBeforeCloseResult } from '@shared/types'
import type { PreloadApi } from '../../preload/index'

// #888: what the window saves before it closes. Main asks once per close attempt
// (`EVENTS.saveBeforeClose`, `main/close-guard.ts`); the bridge runs every registrant and answers
// with one result. A registrant is a store or a screen holding an edit the user already made and
// believes saved: the review store (`reviewSession.ts`, always registered) and the Settings
// language pick while its tab is mounted (`SettingsScreen.tsx`). Explicit-commit drafts (the chat
// composer, a rename field) are not registrants: navigation loses them too, by design.
//
// The bridge is installed from `main.tsx`, not from an App effect, so a render error or the
// workspace gate never leaves main waiting out its bound.

/**
 * How long the bridge waits for its registrants. Above the review store's own bound
 * (`REVIEW_LOCK_FLUSH_BOUND_MS`, 6 s), so the store answers itself first, and well below main's
 * (`CLOSE_SAVE_BOUND_MS`), so main always gets an answer, even from a window whose timers are
 * throttled in the background.
 */
export const BEFORE_CLOSE_SAVE_BOUND_MS = 6_500

/** Saves what the registrant holds; `unsaved: true` when something is still not written. */
export type BeforeCloseSave = () => Promise<SaveBeforeCloseResult> | SaveBeforeCloseResult

const registrants = new Set<BeforeCloseSave>()

/** Run `save` before the window closes, until the returned fn unregisters it. */
export function registerBeforeClose(save: BeforeCloseSave): () => void {
  registrants.add(save)
  return () => {
    registrants.delete(save)
  }
}

/**
 * Run every registrant at once (they write different things) and wait for all of them, each at
 * most `BEFORE_CLOSE_SAVE_BOUND_MS`. Unsaved when any registrant says so, throws, or has not
 * settled by then: main then asks the user, never closes over them. Without the bound, one
 * registrant that never settles would hold back the whole answer past main's bound, and main
 * would close without asking over another registrant's unsaved change (review round 2).
 */
export async function saveAllBeforeClose(): Promise<SaveBeforeCloseResult> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const bound = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), BEFORE_CLOSE_SAVE_BOUND_MS)
  })
  try {
    const unsaved = await Promise.all(
      [...registrants].map((save) => {
        let saving: Promise<SaveBeforeCloseResult>
        try {
          saving = Promise.resolve(save())
        } catch (err) {
          saving = Promise.reject(err)
        }
        return Promise.race([
          saving.then(
            (result) => result?.unsaved !== false,
            () => true
          ),
          bound
        ])
      })
    )
    return { unsaved: unsaved.some(Boolean) }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Answer main's close-time save request with `saveAllBeforeClose` (`main.tsx` installs it once).
 * Returns the unsubscribe fn; a missing bridge installs nothing.
 */
export function installBeforeCloseBridge(api: Pick<PreloadApi, 'onSaveBeforeClose'> | undefined): () => void {
  if (typeof api?.onSaveBeforeClose !== 'function') return () => {}
  return api.onSaveBeforeClose(saveAllBeforeClose)
}
