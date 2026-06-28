import { useEffect, useState } from 'react'
import { Banner } from '../../components'
import { useT } from '../../i18n'
import type { AppSettings, DriveStatus, PolicyStatus } from '@shared/types'

// "Privacy & data" tab of the Settings screen (spec §7.10 + §18.1).
// Renders the offline statement verbatim, shows where data lives,
// the live network state (off by default / disabled by policy), the plaintext-dev-mode
// caveat, and the logs-are-local guarantee. Privacy is a posture expressed everywhere;
// this tab is the place that spells it out (guidelines §2).

export function PrivacyTab(): JSX.Element {
  const { t } = useT()
  const [policy, setPolicy] = useState<PolicyStatus | null>(null)
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)

  // The `active` guard avoids a setState after unmount if a read resolves late (audit FE-4),
  // mirroring the HomeScreen mount-effect pattern.
  useEffect(() => {
    let active = true
    window.api?.getPolicy().then((p) => active && setPolicy(p)).catch(() => active && setPolicy(null))
    window.api?.getDriveStatus().then((d) => active && setDrive(d)).catch(() => active && setDrive(null))
    window.api?.getSettings().then((s) => active && setSettings(s)).catch(() => active && setSettings(null))
    return () => {
      active = false
    }
  }, [])

  const offline = policy?.offlineMode ?? true
  // Three states: disabled by policy (hard), off by choice (setting), or allowed.
  const networkState = !policy
    ? t('privacy.networkState.noPolicy')
    : !policy.networkAllowedByPolicy
      ? t('privacy.networkState.disabledByPolicy')
      : !policy.allowNetworkSetting
        ? t('privacy.networkState.offDefault')
        : t('privacy.networkState.enabled')

  return (
    <>
      <div className="card">
        <div className={`offline-statement ${offline ? 'on' : 'off'}`}>
          <strong>{offline ? t('privacy.offlineOn') : t('privacy.offlineOff')}</strong>
        </div>
        {/* spec §18.1 — verbatim offline statement (in English; the German adapts it) */}
        <p className="lead" style={{ marginBottom: 8 }}>
          {offline ? t('privacy.statement.offline') : t('privacy.statement.online')}
        </p>
        <p className="hint">{t('privacy.statement.noUploads')}</p>
      </div>

      <div className="card">
        <h2>{t('privacy.network.title')}</h2>
        <p>{networkState}</p>
        <p className="hint">{t('privacy.network.noFiles')}</p>
        <dl className="kv">
          <dt>{t('privacy.network.effective')}</dt>
          <dd>
            {offline ? t('privacy.network.effectiveOffline') : t('privacy.network.effectiveAllowed')}
          </dd>
          <dt>{t('privacy.network.byPolicy')}</dt>
          <dd>
            {policy
              ? policy.networkAllowedByPolicy
                ? t('privacy.network.policyYes')
                : t('privacy.network.policyNo')
              : '…'}
          </dd>
          <dt>{t('privacy.network.yourSetting')}</dt>
          <dd>
            {policy
              ? policy.allowNetworkSetting
                ? t('privacy.network.settingAllowed')
                : t('privacy.network.settingOff')
              : '…'}
          </dd>
          <dt>{t('privacy.network.telemetry')}</dt>
          <dd>{t('privacy.network.telemetryValue')}</dd>
        </dl>
        <p className="hint">{t('privacy.network.hint')}</p>
      </div>

      <div className="card">
        <h2>{t('privacy.data.title')}</h2>
        {drive ? (
          <dl className="kv">
            <dt>{t('privacy.data.driveRoot')}</dt>
            <dd>{drive.rootPath}</dd>
            <dt>{t('privacy.data.workspace')}</dt>
            <dd>{drive.workspacePath}</dd>
            <dt>{t('privacy.data.models')}</dt>
            <dd>{drive.modelsPath}</dd>
            <dt>{t('privacy.data.logs')}</dt>
            <dd>{drive.logsPath}</dd>
          </dl>
        ) : (
          <p className="hint">{t('privacy.data.loading')}</p>
        )}
        <p className="hint">{t('privacy.data.hint')}</p>
      </div>

      <div className="card">
        <h2>{t('privacy.logs.title')}</h2>
        <p className="hint">
          {t('privacy.logs.hintBefore')}
          <strong>{t('privacy.logs.never')}</strong>
          {t('privacy.logs.hintAfter')}
        </p>
      </div>

      <div className="card">
        <h2>{t('privacy.protection.title')}</h2>
        {settings?.workspaceMode === 'encrypted' ? (
          <p>
            {t('privacy.protection.encryptedBefore')}
            <strong>{t('privacy.protection.encryptedWord')}</strong>
            {t('privacy.protection.encryptedAfter')}
          </p>
        ) : (
          <>
            <p>
              {t('privacy.protection.plainBefore')}
              <strong>{t('privacy.protection.plainWord')}</strong>
              {t('privacy.protection.plainAfter')}
            </p>
            <Banner tone="warning">{t('privacy.protection.plainWarning')}</Banner>
          </>
        )}
      </div>
    </>
  )
}
