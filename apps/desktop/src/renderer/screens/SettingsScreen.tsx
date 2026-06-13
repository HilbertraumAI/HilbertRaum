import { useEffect, useState } from 'react'
import {
  Banner,
  Button,
  PasswordField,
  PasswordStrengthMeter,
  SegmentedControl,
  Spinner,
  Switch,
  passwordStrength,
  useToast
} from '../components'
import { setThemeSetting } from '../theme'
import { useT } from '../i18n'
import { PrivacyTab } from './settings/PrivacyTab'
import { DiagnosticsTab } from './settings/DiagnosticsTab'
import type { SettingsTab } from '../navigation'
import type { MessageKey, UiLanguageSetting } from '@shared/i18n'
import type { AppSettings, ThemeSetting } from '@shared/types'

// Settings (guidelines §2): one utility destination with three tabs.
// "General" = the everyday settings; "Privacy & data" and "Diagnostics (advanced)"
// were once standalone screens and now live here as tabs. The tab
// switcher reuses SegmentedControl (roving tabindex + arrow keys, guidelines §6).
// The open tab is owned by App.tsx so navigate('settings:privacy') etc. can land on
// the right tab from anywhere; standalone use (tests) falls back to internal state.
//
// Labels live in the message catalogs as keys, resolved with t() at render
// (i18n record §5 label-map rule).

const TAB_CHOICES: Array<{ value: SettingsTab; labelKey: MessageKey }> = [
  { value: 'general', labelKey: 'settings.tab.general' },
  { value: 'privacy', labelKey: 'settings.tab.privacy' },
  { value: 'diagnostics', labelKey: 'settings.tab.diagnostics' }
]

const THEME_CHOICES: Array<{ value: ThemeSetting; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'settings.appearance.system' },
  { value: 'light', labelKey: 'settings.appearance.light' },
  { value: 'dark', labelKey: 'settings.appearance.dark' }
]

// Language names stay UNTRANSLATED (i18n record §3.3, standard practice): a German
// speaker stuck on an English UI must still recognize „Deutsch“ — and "System" is
// the same word in both languages.
const LANGUAGE_CHOICES: Array<{ value: UiLanguageSetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' }
]

export interface SettingsScreenProps {
  /** Controlled tab (App.tsx). Omitted → uncontrolled, starting on General. */
  tab?: SettingsTab
  onTabChange?: (tab: SettingsTab) => void
}

export function SettingsScreen({ tab, onTabChange }: SettingsScreenProps): JSX.Element {
  const [internalTab, setInternalTab] = useState<SettingsTab>('general')
  const activeTab = tab ?? internalTab
  const { t } = useT()

  function selectTab(next: SettingsTab): void {
    onTabChange?.(next)
    if (tab === undefined) setInternalTab(next)
  }

  return (
    <div className="screen">
      <h1>{t('settings.title')}</h1>
      <div className="settings-tabs">
        <SegmentedControl
          options={TAB_CHOICES.map((c) => ({ value: c.value, label: t(c.labelKey) }))}
          value={activeTab}
          onChange={selectTab}
          ariaLabel={t('settings.tabsAria')}
        />
      </div>
      {activeTab === 'general' && <GeneralTab />}
      {activeTab === 'privacy' && <PrivacyTab />}
      {activeTab === 'diagnostics' && <DiagnosticsTab />}
    </div>
  )
}

// The "General" tab — today's settings, unchanged behavior (network toggle, Appearance,
// Language, Performance, Developer, Workspace facts).
function GeneralTab(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const toast = useToast()
  const { t, lang, applyLanguageSetting } = useT()

  useEffect(() => {
    window.api?.getSettings().then(setSettings).catch(() => setSettings(null))
  }, [])

  async function patch(p: Partial<AppSettings>): Promise<void> {
    const next = await window.api.updateSettings(p)
    setSettings(next)
    // Appearance + language apply immediately — the saved value, not the request.
    if (p.theme !== undefined) setThemeSetting(next.theme)
    if (p.uiLanguage !== undefined) applyLanguageSetting(next.uiLanguage)
    toast(t('settings.saved'))
  }

  if (!settings) {
    return <p className="hint">{t('settings.loading')}</p>
  }

  return (
    <>
      <div className="card">
        <h2>{t('settings.network.title')}</h2>
        <Switch
          checked={settings.allowNetwork}
          onChange={(on) => void patch({ allowNetwork: on })}
          label={t('settings.network.allow')}
        />
        <p className="hint">{t('settings.network.hint')}</p>
      </div>

      <div className="card">
        <h2>{t('settings.appearance.title')}</h2>
        <SegmentedControl
          options={THEME_CHOICES.map((c) => ({ value: c.value, label: t(c.labelKey) }))}
          value={settings.theme}
          onChange={(theme) => void patch({ theme })}
          ariaLabel={t('settings.appearance.aria')}
        />
        <p className="hint">{t('settings.appearance.hint')}</p>
      </div>

      <div className="card">
        <h2>{t('settings.language.title')}</h2>
        <SegmentedControl
          options={LANGUAGE_CHOICES}
          value={settings.uiLanguage}
          onChange={(uiLanguage) => void patch({ uiLanguage })}
          ariaLabel={t('settings.language.aria')}
        />
        <p className="hint">{t('settings.language.hint')}</p>
      </div>

      <div className="card">
        <h2>{t('settings.performance.title')}</h2>
        <Switch
          checked={settings.gpuMode === 'auto'}
          onChange={(on) => void patch({ gpuMode: on ? 'auto' : 'off' })}
          label={t('settings.performance.gpu')}
        />
        <p className="hint">{t('settings.performance.gpuHint')}</p>
        <Switch
          checked={settings.autoStartActiveModel}
          onChange={(on) => void patch({ autoStartActiveModel: on })}
          label={t('settings.performance.autoStart')}
        />
        <p className="hint">{t('settings.performance.autoStartHint')}</p>
      </div>

      <div className="card">
        <h2>{t('settings.developer.title')}</h2>
        <Switch
          checked={settings.developerMode}
          onChange={(on) => void patch({ developerMode: on })}
          label={t('settings.developer.toggle')}
        />
        <p className="hint">{t('settings.developer.hint')}</p>
      </div>

      <div className="card">
        <h2>{t('settings.workspace.title')}</h2>
        <dl className="kv">
          <dt>{t('settings.workspace.mode')}</dt>
          <dd>
            {settings.workspaceMode === 'encrypted'
              ? t('settings.workspace.modeEncrypted')
              : t('settings.workspace.modePlaintext')}
          </dd>
          <dt>{t('settings.workspace.contextTokens')}</dt>
          {/* M-U5: group the token count by locale (German "8.192"). */}
          <dd>{settings.contextTokens.toLocaleString(lang)}</dd>
        </dl>
        <p className="hint">
          {settings.workspaceMode === 'encrypted'
            ? t('settings.workspace.encryptedHint')
            : t('settings.workspace.plaintextHint')}
        </p>
      </div>

      {/* Hidden entirely in plaintext_dev mode — there is no password to change. */}
      {settings.workspaceMode === 'encrypted' && <ChangePasswordCard />}
    </>
  )
}

// Settings → "Change password". Reuses the first-run password components
// (strength hint, show toggle — components/PasswordField). The first change of an older
// workspace re-secures every stored document under the new password, which can take a
// while on a big library — the busy copy says so honestly.
function ChangePasswordCard(): JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  const { t } = useT()

  const strength = passwordStrength(next)
  // The strength meter is advisory; only the 8-character floor + the confirm match
  // (and the main process's own checks) gate submission — the WorkspaceGate rules.
  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm && !busy

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.changeWorkspacePassword(current, next)
      if (result.ok) {
        toast(t('settings.changePassword.toast'))
        setCurrent('')
        setNext('')
        setConfirm('')
      } else {
        setError(result.message)
      }
    } catch {
      setError(t('settings.changePassword.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2>{t('settings.changePassword.title')}</h2>
      <p className="hint">{t('settings.changePassword.hint')}</p>
      <div className="gate-fields">
        <PasswordField
          placeholder={t('settings.changePassword.current')}
          autoComplete="current-password"
          value={current}
          show={showPassword}
          onToggleShow={() => setShowPassword((v) => !v)}
          onChange={setCurrent}
          t={t}
        />
        <PasswordField
          placeholder={t('settings.changePassword.new')}
          autoComplete="new-password"
          value={next}
          show={showPassword}
          onChange={setNext}
          t={t}
        />
        {next.length > 0 && <PasswordStrengthMeter strength={strength} t={t} />}
        {strength.hintKey && <p className="hint">{t(strength.hintKey)}</p>}
        <PasswordField
          placeholder={t('settings.changePassword.confirm')}
          autoComplete="new-password"
          value={confirm}
          show={showPassword}
          onChange={setConfirm}
          t={t}
        />
        {confirm.length > 0 && confirm !== next && (
          <p className="hint warn">{t('password.mismatch')}</p>
        )}
      </div>
      {busy && (
        <p className="hint" role="status">
          <Spinner /> {t('settings.changePassword.busy')}
        </p>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      <Button type="submit" variant="primary" disabled={!canSubmit}>
        {busy ? t('settings.changePassword.submitBusy') : t('settings.changePassword.submit')}
      </Button>
    </form>
  )
}
