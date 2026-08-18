import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Button, ConfirmDialog, Switch } from '../../components'
import { useT } from '../../i18n'
import {
  MAX_LOCAL_API_PORT,
  MIN_LOCAL_API_PORT,
  localApiEffectivelyEnabled
} from '@shared/local-api'
import type {
  AppSettings,
  LocalApiConnectionInfo,
  LocalApiStatus,
  PolicyStatus,
  RuntimeStatus
} from '@shared/types'

// Settings → Privacy & data → "Local API" (local-api wave P4): the consent surface for the
// opt-in loopback endpoint. Three rules shape this card:
//   - The ceiling is the POLICY (`policy.network.allowLocalApi`); the effective state is
//     `localApiEffectivelyEnabled(policy, setting)` — the same shared rule the main-process
//     start seam gates on, never a re-spelled `a && b`.
//   - Under a policy that forbids it the card is shown DISABLED WITH A REASON, never hidden:
//     a managed-drive user must still be able to learn the feature exists (transparency).
//   - The renderer never holds the access key. It asks for a masked form, copying happens
//     main-side, and regeneration is a main-side rotation that also kills live streams.

/** How long a pre-emption keeps the concurrent-use warning up. Long enough to explain the
 *  interruption the user just caused, short enough not to become a permanent scold. */
const PREEMPT_WARNING_MS = 60_000
/** Live-state poll while the endpoint is on (the HomeScreen readiness idiom: interval +
 *  window focus, both torn down on unmount). */
const STATUS_POLL_MS = 4000

export interface LocalApiCardProps {
  /** Null until the policy read resolves — the card stays inert (deny-by-default). */
  policy: PolicyStatus | null
  settings: AppSettings | null
  /** Hand the accepted settings object back so the tab's copy stays authoritative. */
  onSettingsChanged: (next: AppSettings) => void
}

export function LocalApiCard({
  policy,
  settings,
  onSettingsChanged
}: LocalApiCardProps): JSX.Element | null {
  const { t, tCount, lang } = useT()
  const [status, setStatus] = useState<LocalApiStatus | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [conn, setConn] = useState<LocalApiConnectionInfo | null>(null)
  const [confirmEnable, setConfirmEnable] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmKeyOff, setConfirmKeyOff] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [portDraft, setPortDraft] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Late IPC replies must not setState after unmount (audit FE-4, the DiagnosticsTab flag).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const allowedByPolicy = policy?.policy.network.allowLocalApi ?? false
  const settingOn = settings?.localApiEnabled ?? false
  const effective = policy != null && localApiEffectivelyEnabled(policy.policy, settingOn)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [app, rt] = await Promise.all([
        window.api.getAppStatus(),
        window.api.getRuntimeStatus()
      ])
      if (!mountedRef.current) return
      setStatus(app.localApi ?? null)
      setRuntime(rt)
    } catch {
      // A locked/teardown-time refusal is not something to shout about — the card keeps
      // showing its last known state.
    }
  }, [])

  const refreshConnection = useCallback(async (): Promise<void> => {
    try {
      const info = await window.api.getLocalApiConnectionInfo()
      if (mountedRef.current) setConn(info)
    } catch {
      if (mountedRef.current) setConn(null)
    }
  }, [])

  // Poll only while the endpoint is actually on: the counters and the D5 concurrent-use
  // warning are live state, and a card sitting on an off endpoint has nothing to poll for.
  useEffect(() => {
    if (!effective) {
      setStatus(null)
      setConn(null)
      return
    }
    void refresh()
    void refreshConnection()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(timer)
    }
  }, [effective, refresh, refreshConnection])

  async function patch(p: Partial<AppSettings>): Promise<void> {
    setNotice(null)
    try {
      const next = await window.api.updateSettings(p)
      if (!mountedRef.current) return
      setSaveError(null)
      onSettingsChanged(next)
      // The main process applies the lifecycle change asynchronously; read the settled
      // state back rather than predicting it (a bind failure must show as a bind failure).
      void refresh()
      void refreshConnection()
    } catch {
      // A refused save (e.g. the workspace locked mid-click) must never look like success:
      // the Switch snaps back to the persisted value and the reason is stated (CODE-7).
      if (mountedRef.current) setSaveError(t('settings.saveFailed'))
    }
  }

  if (!settings) return null

  const port = settings.localApiPort
  const tokenRequired = settings.localApiTokenRequired
  const preemptedRecently =
    status?.lastPreemptedAt != null && Date.now() - status.lastPreemptedAt < PREEMPT_WARNING_MS
  const modelRunning = runtime?.running === true && runtime.modelId != null

  return (
    <div className="card">
      <h2>{t('settings.localApi.title')}</h2>
      <p className="hint hint-lede">{t('settings.localApi.lead')}</p>

      <Switch
        checked={settingOn && allowedByPolicy}
        disabled={!allowedByPolicy}
        onChange={(on) => {
          if (on) {
            // Enabling is a consent decision — nothing is written until the dialog is
            // confirmed with the acknowledgement ticked.
            setAcknowledged(false)
            setConfirmEnable(true)
            return
          }
          void patch({ localApiEnabled: false })
        }}
        label={t('settings.localApi.toggle')}
      />
      {/* While the policy read is still in flight the switch is inert (deny-by-default)
          but says NOTHING about why: claiming "your drive's policy" before knowing the
          policy would be a false sentence on every machine that has none (review
          2026-08-18). Disabled WITH the reason — never hidden — once it IS known:
          an administratively disabled feature nobody can see reads as no feature. */}
      {policy != null &&
        (allowedByPolicy ? (
          <p className="hint">{t('settings.localApi.hint')}</p>
        ) : (
          <p className="hint">{t('settings.localApi.policyOff')}</p>
        ))}
      {saveError && <Banner tone="error">{saveError}</Banner>}

      {effective && (
        <>
          {status?.lastError === 'port_in_use' && (
            <Banner tone="warning">
              {t('settings.localApi.error.portInUse', { suggestion: String(suggestPort(port)) })}
            </Banner>
          )}
          {status?.lastError === 'start_failed' && (
            <Banner tone="error">{t('settings.localApi.error.startFailed')}</Banner>
          )}

          {/* Live model state: turns the client-side 503 from a mystery into a
              confirmation of what the user already sees in the app. */}
          <p className="hint">
            {modelRunning
              ? t('settings.localApi.model.running')
              : t('settings.localApi.model.stopped')}
          </p>

          {/* D5 concurrent-use warning at WARNING tone only while it is true — a permanent
              amber notice is warning fatigue, and D8 already resolves collisions itself. */}
          {status?.externalActive === true && (
            <Banner tone="warning">{t('settings.localApi.busyWarning')}</Banner>
          )}
          {status?.externalActive !== true && preemptedRecently && (
            <Banner tone="warning">{t('settings.localApi.preemptedWarning')}</Banner>
          )}

          {status?.lastError == null && (
            <div className="local-api-connect">
              <h3>{t('settings.localApi.connect.title')}</h3>
              <p className="hint">{t('settings.localApi.connect.hint')}</p>
              <dl className="kv">
                <dt>{t('settings.localApi.connect.address')}</dt>
                <dd className="local-api-value">
                  <code>{conn?.serverAddress ?? '…'}</code>
                  <Button
                    size="sm"
                    aria-label={t('settings.localApi.connect.copyAddressAria')}
                    onClick={() => {
                      const address = conn?.serverAddress
                      if (!address) return
                      void window.api
                        .copyToClipboard(address)
                        .then((ok) =>
                          mountedRef.current
                            ? setNotice(
                                t(
                                  ok
                                    ? 'settings.localApi.connect.copiedAddress'
                                    : 'settings.localApi.connect.copyFailed'
                                )
                              )
                            : undefined
                        )
                        .catch(() =>
                          mountedRef.current
                            ? setNotice(t('settings.localApi.connect.copyFailed'))
                            : undefined
                        )
                    }}
                  >
                    {t('settings.localApi.connect.copy')}
                  </Button>
                </dd>
                {tokenRequired && (
                  <>
                    <dt>{t('settings.localApi.connect.key')}</dt>
                    <dd className="local-api-value">
                      {/* Masked value ONLY — the full key never enters renderer state. */}
                      <code>{conn?.maskedKey ?? '…'}</code>
                      <Button
                        size="sm"
                        aria-label={t('settings.localApi.connect.copyKeyAria')}
                        onClick={() => {
                          void window.api
                            .copyLocalApiKey()
                            .then((ok) =>
                              mountedRef.current
                                ? setNotice(
                                    t(
                                      ok
                                        ? 'settings.localApi.connect.copiedKey'
                                        : 'settings.localApi.connect.copyFailed'
                                    )
                                  )
                                : undefined
                            )
                            .catch(() =>
                              mountedRef.current
                                ? setNotice(t('settings.localApi.connect.copyFailed'))
                                : undefined
                            )
                        }}
                      >
                        {t('settings.localApi.connect.copy')}
                      </Button>
                    </dd>
                  </>
                )}
              </dl>
              {notice && (
                <p className="hint" role="status">
                  {notice}
                </p>
              )}
            </div>
          )}

          <p className="hint">
            {status?.running
              ? `${t('settings.localApi.status.port', { port: String(status.port ?? port) })} ${tCount(
                  'settings.localApi.status.served',
                  status.requestsServed,
                  { count: status.requestsServed.toLocaleString(lang) }
                )}`
              : t('settings.localApi.status.off')}
          </p>

          <Switch
            checked={tokenRequired}
            onChange={(on) => {
              // Turning the key requirement OFF is its own consent decision (a passive
              // hint under an already-flipped switch informs nothing); turning it back on
              // needs no confirmation.
              if (!on) {
                setConfirmKeyOff(true)
                return
              }
              void patch({ localApiTokenRequired: true })
            }}
            label={t('settings.localApi.token.toggle')}
          />
          <p className="hint">
            {tokenRequired
              ? t('settings.localApi.token.hint')
              : t('settings.localApi.connect.noKey')}
          </p>
          {tokenRequired && (
            <Button size="sm" onClick={() => setConfirmRegenerate(true)}>
              {t('settings.localApi.token.regenerate')}
            </Button>
          )}

          <div className="local-api-port">
            <label className="hint" htmlFor="local-api-port">
              {t('settings.localApi.port.label')}
            </label>
            <input
              id="local-api-port"
              className="text-input local-api-port-input"
              type="number"
              inputMode="numeric"
              min={MIN_LOCAL_API_PORT}
              max={MAX_LOCAL_API_PORT}
              value={portDraft ?? String(port)}
              onChange={(e) => setPortDraft(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!isApplicablePort(portDraft, port)}
              onClick={() => {
                const next = Number(portDraft)
                setPortDraft(null)
                void patch({ localApiPort: next })
              }}
            >
              {t('common.apply')}
            </Button>
          </div>
          <p className="hint">{t('settings.localApi.port.hint')}</p>
        </>
      )}

      <ConfirmDialog
        open={confirmEnable}
        t={t}
        title={t('settings.localApi.confirm.title')}
        confirmLabel={t('settings.localApi.confirm.cta')}
        confirmDisabled={!acknowledged}
        onConfirm={() => {
          setConfirmEnable(false)
          void patch({ localApiEnabled: true })
        }}
        onCancel={() => setConfirmEnable(false)}
      >
        <p>{t('settings.localApi.confirm.what')}</p>
        <p>{t('settings.localApi.confirm.boundary')}</p>
        <p>{t('settings.localApi.confirm.neverStored')}</p>
        <p>{t('settings.localApi.confirm.persists')}</p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>{t('settings.localApi.confirm.ack')}</span>
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmKeyOff}
        t={t}
        title={t('settings.localApi.token.confirm.title')}
        confirmLabel={t('settings.localApi.token.confirm.cta')}
        onConfirm={() => {
          setConfirmKeyOff(false)
          void patch({ localApiTokenRequired: false })
        }}
        onCancel={() => setConfirmKeyOff(false)}
      >
        <p>{t('settings.localApi.token.confirm.body')}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmRegenerate}
        t={t}
        title={t('settings.localApi.token.regenerate.title')}
        confirmLabel={t('settings.localApi.token.regenerate.cta')}
        onConfirm={() => {
          setConfirmRegenerate(false)
          void window.api
            .regenerateLocalApiToken()
            .then((info) => {
              if (!mountedRef.current) return
              setConn(info)
              setNotice(t('settings.localApi.token.regenerated'))
            })
            .catch(() =>
              mountedRef.current
                ? setNotice(t('settings.localApi.token.regenerateFailed'))
                : undefined
            )
        }}
        onCancel={() => setConfirmRegenerate(false)}
      >
        <p>{t('settings.localApi.token.regenerate.body')}</p>
      </ConfirmDialog>
    </div>
  )
}

/** A concrete alternative to offer when the configured port is taken: the next number up,
 *  or the previous one at the top of the range — suggesting the very port that just failed
 *  would be useless advice (review 2026-08-18). */
function suggestPort(port: number): number {
  return port < MAX_LOCAL_API_PORT ? port + 1 : port - 1
}

/** A draft port is applicable when it is a whole number inside the shared clamp range and
 *  actually differs from the saved one — so "Apply" can never write the value already in
 *  effect, and a value the write gate would silently clamp is refused here instead. */
function isApplicablePort(draft: string | null, current: number): boolean {
  if (draft == null || draft.trim() === '') return false
  const value = Number(draft)
  if (!Number.isInteger(value)) return false
  if (value < MIN_LOCAL_API_PORT || value > MAX_LOCAL_API_PORT) return false
  return value !== current
}
