import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Banner, Button, EmptyState, Icon, useToast } from '../components'
import { AssistantMarkdown, StreamAnnouncer } from '../chat'
import {
  acknowledgeError,
  adoptActiveJob,
  clearTranslateSession,
  getLastTranslateChoice,
  getTranslateSession,
  stopActive,
  subscribeTranslateSession,
  translate as runTranslate
} from '../lib/translateSession'
import { useT } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import {
  TRANSLATION_LANGUAGE_CODES,
  TRANSLATION_NATIVE_NAMES,
  type TranslateErrorCode,
  type TranslationSourceLang,
  type TranslationTargetLang
} from '@shared/types'

// Translate screen (TranslateGemma wave, plan §2 D6, TG-4). Type text, pick source + target
// languages, and get a streamed translation from the local TranslateGemma sidecar — the TEXT path
// (drag-and-drop document translation is TG-5). Everything stays local; nothing is persisted.
//
// The running translation lives in the module-level `lib/translateSession` store (the vision /
// doc-task precedent), NOT in this component — so it SURVIVES navigating away and back, still
// streaming. Screen-only concerns (availability, the input draft, the language choice, transient
// errors) stay in local state and are re-read on mount.

// A UI-only "same language" guard joins the backend error codes the banner can show.
type ClientTranslateError = TranslateErrorCode | 'sameLang'

// Codes → friendly banner copy. `noModel` normally shows the availability EmptyState instead (this
// is the rare mid-session-uninstall backstop); `cancelled` is a user action, never a banner.
const ERR_KEY: Partial<Record<ClientTranslateError, MessageKey>> = {
  noModel: 'translate.err.noModel',
  badRequest: 'translate.err.badRequest',
  busy: 'translate.err.busy',
  docTaskBusy: 'translate.err.docTaskBusy',
  runtimeFailed: 'translate.err.runtimeFailed',
  empty: 'translate.err.empty',
  sameLang: 'translate.err.sameLang'
}

export function TranslateScreen({
  onNavigate
}: {
  onNavigate: (target: string) => void
}): JSX.Element {
  const { t, lang } = useT()
  const showToast = useToast()
  // null while the first availability read is in flight (a calm placeholder, never a spinner).
  const [available, setAvailable] = useState<boolean | null>(null)
  const [locked, setLocked] = useState(false)
  const [input, setInput] = useState('')
  // Source+target start from the session's last choice (else a UI-language-aware default), the
  // DocumentsScreen translate-modal precedent. TranslateGemma needs an explicit source — no auto-detect.
  const [choice, setChoice] = useState<{
    sourceLang: TranslationSourceLang
    targetLang: TranslationTargetLang
  }>(
    () =>
      getLastTranslateChoice() ??
      (lang === 'de'
        ? { sourceLang: 'en', targetLang: 'de' }
        : { sourceLang: 'de', targetLang: 'en' })
  )
  const [screenError, setScreenError] = useState<ClientTranslateError | null>(null)

  // The active translation (streamed output) lives in the module-level store so it survives
  // navigating away and back (it keeps streaming there).
  const { output, state, error, translating } = useSyncExternalStore(
    subscribeTranslateSession,
    getTranslateSession
  )

  const checkStatus = useCallback(async (): Promise<void> => {
    try {
      const st = await window.api?.getAppStatus?.()
      if (st) {
        setAvailable(st.translationAvailable)
        setLocked(st.workspaceReady === false)
      }
    } catch {
      // No status (partial bridge) → calm unavailable, never a crash.
      setAvailable(false)
    }
  }, [])

  // Availability on mount; re-check on focus (the model may have been installed on the AI Model
  // screen and the user navigated back). A mid-session install still needs a restart to be picked
  // up (the composed `translator` resolves once at startup — known-limitations), but re-reading
  // keeps the flag honest across a lock/unlock.
  useEffect(() => {
    void checkStatus()
    const onFocus = (): void => void checkStatus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkStatus])

  // Remount recovery after a full renderer reload: re-adopt a still-running job from main. A no-op
  // when the store already holds one (navigate-away kept it alive) or nothing is running.
  useEffect(() => {
    void adoptActiveJob()
  }, [])

  // Workspace LOCK: main has aborted the job + purged its map + re-encrypted the vault, so drop the
  // resident source/translation content here in lockstep (privacy parity with main).
  useEffect(() => {
    if (locked) clearTranslateSession()
  }, [locked])

  const sameLang = choice.sourceLang === choice.targetLang

  function onTranslate(): void {
    setScreenError(null)
    if (sameLang) {
      setScreenError('sameLang')
      return
    }
    void runTranslate({
      sourceLang: choice.sourceLang,
      targetLang: choice.targetLang,
      text: input
    }).then((outcome) => {
      // A second translate while one is in flight is busy-rejected. The trigger is already disabled
      // while `translating`, but surface the friendly banner if a click still reaches here so the
      // action is never silently swallowed.
      if (outcome === 'busy') setScreenError('busy')
    })
  }

  function onSwap(): void {
    // Swap the two language selects (the common translate affordance). The output stays until the
    // next Translate — swapping is a setup step, not a re-run.
    setChoice((c) => ({ sourceLang: c.targetLang, targetLang: c.sourceLang }))
    setScreenError(null)
  }

  function onCopy(): void {
    // Copy via MAIN (preload → clipboard:write), not navigator.clipboard — the latter is denied in
    // the file://-loaded renderer. Mirrors ImagesScreen.onCopy / ChatScreen.onCopyMessage.
    void window.api?.copyToClipboard?.(output)?.then?.((ok) => {
      if (ok) showToast(t('translate.copied'))
    })
  }

  function renderBody(): JSX.Element | null {
    if (locked) {
      return <EmptyState title={t('translate.locked')} />
    }
    if (available === null) {
      return <p className="hint">{t('translate.starting')}</p>
    }
    if (!available) {
      // The O2 install path: a friendly, actionable refusal with a deep link to the AI Model
      // screen (the ChatScreen / VisionUnavailable no-model precedent).
      return (
        <EmptyState
          title={t('translate.avail.noModel')}
          line={t('translate.avail.hint')}
          action={
            <Button variant="primary" onClick={() => onNavigate('models')}>
              {t('translate.avail.cta')}
            </Button>
          }
        />
      )
    }
    return (
      <div className="translate-workspace">
        {/* Language bar: source select · swap · target select (native-name labels, untranslated
            by design — the Settings language-picker precedent). */}
        <div className="translate-langbar">
          <label>
            {t('translate.from')}{' '}
            <select
              aria-label={t('translate.from')}
              value={choice.sourceLang}
              onChange={(e) =>
                setChoice((c) => ({ ...c, sourceLang: e.target.value as TranslationSourceLang }))
              }
            >
              {TRANSLATION_LANGUAGE_CODES.map((code) => (
                <option key={code} value={code}>
                  {TRANSLATION_NATIVE_NAMES[code]}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="translate-swap"
            aria-label={t('translate.swap')}
            title={t('translate.swap')}
            onClick={onSwap}
          >
            <Icon name="refresh" />
          </Button>
          <label>
            {t('translate.to')}{' '}
            <select
              aria-label={t('translate.to')}
              value={choice.targetLang}
              onChange={(e) =>
                setChoice((c) => ({ ...c, targetLang: e.target.value as TranslationTargetLang }))
              }
            >
              {TRANSLATION_LANGUAGE_CODES.map((code) => (
                <option key={code} value={code}>
                  {TRANSLATION_NATIVE_NAMES[code]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {sameLang && <p className="hint">{t('translate.err.sameLang')}</p>}

        <div className="translate-panes">
          <div className="translate-pane">
            <textarea
              className="translate-input"
              aria-label={t('translate.input.label')}
              placeholder={t('translate.input.placeholder')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="actions">
              <Button
                variant="primary"
                disabled={translating || input.trim() === '' || sameLang}
                onClick={onTranslate}
              >
                {t('translate.action')}
              </Button>
              {translating && <Button onClick={stopActive}>{t('translate.stop')}</Button>}
            </div>
          </div>

          <div className="translate-pane">
            <div className="translate-output" aria-label={t('translate.output.label')}>
              {output === '' && !translating ? (
                <p className="hint">{t('translate.output.empty')}</p>
              ) : state === 'done' ? (
                <AssistantMarkdown text={output} />
              ) : (
                // Plain-text live buffer while streaming (Markdown is only parsed once complete, so
                // half-written syntax never flickers) — the ChatScreen live-render precedent.
                <div className="translate-output-live">{output}</div>
              )}
            </div>
            {/* a11y: a separate visually-hidden, sentence-throttled live region for AT (§ChatScreen). */}
            <StreamAnnouncer text={output} />
            <div className="actions">
              {output !== '' && !translating && (
                <Button size="sm" variant="ghost" onClick={onCopy}>
                  {t('translate.copy')}
                </Button>
              )}
              {translating && <p className="hint">{t('translate.working')}</p>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // The store carries a terminal error CODE on a failed run; the client `sameLang`/`busy` guards
  // set `screenError`. Show whichever is present (the store error only when the run actually failed).
  const shownError: ClientTranslateError | null =
    screenError ?? (state === 'failed' ? error : null)

  return (
    <div className="screen translate-screen">
      <h1>{t('translate.title')}</h1>
      <p className="lead">{t('translate.lead')}</p>
      {shownError && (
        <Banner
          tone="error"
          onDismiss={() => {
            setScreenError(null)
            // Clear the store's terminal failed state too, so the banner doesn't reappear on remount
            // (the failed state is persistent; a component-local dismiss flag would reset).
            acknowledgeError()
          }}
          t={t}
        >
          {t(ERR_KEY[shownError] ?? 'translate.err.runtimeFailed')}
        </Banner>
      )}
      {renderBody()}
    </div>
  )
}
