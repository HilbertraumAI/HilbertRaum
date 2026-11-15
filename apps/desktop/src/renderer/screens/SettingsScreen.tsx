import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Banner,
  Button,
  ErrorBanner,
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
import { SkillsTab } from './settings/SkillsTab'
import type { SettingsTab } from '../navigation'
import {
  UI_LANGUAGES,
  isUiLanguageSetting,
  resolveUiLanguage,
  t as tCatalog,
  type MessageKey,
  type UiLanguageSetting
} from '@shared/i18n'
import { MIN_PASSWORD_LENGTH, type AppSettings, type ThemeSetting } from '@shared/types'
import { CPU_HI_MIN_THREADS } from '@shared/rerank-rules'

// Settings (guidelines §2): one utility destination with four tabs.
// "General" = the everyday settings; "Privacy & data" and "Diagnostics (advanced)"
// were once standalone screens and now live here as tabs; "Skills" came back as a tab in
// the 2026-09-05 rail rework (the composer's skill picker is the everyday entry). The tab
// switcher reuses SegmentedControl (roving tabindex + arrow keys, guidelines §6).
// The open tab is owned by App.tsx so navigate('settings:privacy') etc. can land on
// the right tab from anywhere; standalone use (tests) falls back to internal state.
//
// Labels live in the message catalogs as keys, resolved with t() at render
// (i18n record §5 label-map rule).

const TAB_CHOICES: Array<{ value: SettingsTab; labelKey: MessageKey }> = [
  { value: 'general', labelKey: 'settings.tab.general' },
  { value: 'privacy', labelKey: 'settings.tab.privacy' },
  { value: 'skills', labelKey: 'settings.tab.skills' },
  { value: 'diagnostics', labelKey: 'settings.tab.diagnostics' }
]

const THEME_CHOICES: Array<{ value: ThemeSetting; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'settings.appearance.system' },
  { value: 'light', labelKey: 'settings.appearance.light' },
  { value: 'dark', labelKey: 'settings.appearance.dark' }
]

/** The language select saves this long after its last change (#808, open-issues wave owner
 *  call G-6): a closed native select fires `change` for every arrow-key step on Windows. */
const LANGUAGE_SAVE_DELAY_MS = 500

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
      {activeTab === 'skills' && <SkillsTab />}
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
  // Component-level mounted flag (audit FE-4, the DiagnosticsTab discipline): `patch` runs
  // from every toggle/segment click and its reply — or rejection — can land after the tab
  // was left; each setState/toast below checks it first.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The `active` guard avoids a setState after unmount if the read resolves late (audit FE-4).
  useEffect(() => {
    let active = true
    window.api
      ?.getSettings()
      .then((s) => active && setSettings(s))
      .catch(() => active && setSettings(null))
    return () => {
      active = false
    }
  }, [])

  // The language select (#808, open-issues wave owner call G-6). `languageDraft` is the choice
  // shown at once; `settings` stays the server's last-confirmed values. The save, and with it the
  // language switch, waits LANGUAGE_SAVE_DELAY_MS after the last change, or runs at once on blur
  // or unmount (the last choice is kept), so stepping through the closed select saves once. The
  // refs let a flush from the timer, the blur or the unmount cleanup see the latest choice.
  const [languageDraft, setLanguageDraft] = useState<UiLanguageSetting | null>(null)
  const pendingLanguageRef = useRef<UiLanguageSetting | null>(null)
  const languageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The value the store will hold once every sent save lands (null: no save unanswered, so the
  // stored value), and a count of the sends, so a reply knows whether a newer send came after it.
  const sentLanguageRef = useRef<UiLanguageSetting | null>(null)
  const languageSendsRef = useRef(0)
  const settingsRef = useRef(settings)
  const tRef = useRef(t)

  function flushLanguage(): void {
    if (languageTimerRef.current !== null) clearTimeout(languageTimerRef.current)
    languageTimerRef.current = null
    const uiLanguage = pendingLanguageRef.current
    pendingLanguageRef.current = null
    if (uiLanguage === null) return
    // A pick and back within the pause saves nothing and toasts nothing: back to the value the
    // store holds, or will hold once the unanswered saves land. In that second case the draft
    // stays (it is that value) until the last reply drops it, so the select doesn't flash back.
    if (uiLanguage === (sentLanguageRef.current ?? settingsRef.current?.uiLanguage)) {
      if (mountedRef.current && sentLanguageRef.current === null) setLanguageDraft(null)
      return
    }
    void saveLanguage(uiLanguage)
  }
  // The timer, the unmount cleanup and a late reply read the latest committed render's values (a
  // refusal's toast its `t`), not those of the render they began in. Written after each commit, not
  // during render; the unmount cleanup runs after the last of these.
  const flushLanguageRef = useRef(flushLanguage)
  useLayoutEffect(() => {
    settingsRef.current = settings
    tRef.current = t
    flushLanguageRef.current = flushLanguage
  })
  useEffect(() => () => flushLanguageRef.current(), [])

  async function saveLanguage(uiLanguage: UiLanguageSetting): Promise<void> {
    sentLanguageRef.current = uiLanguage
    const send = ++languageSendsRef.current
    // The draft goes with the reply of the last send when no newer choice waits: an older reply
    // must not flash the select back while a newer choice waits for, or is in, its own save.
    const last = (): boolean => languageSendsRef.current === send
    const dropDraft = (): void => {
      if (last() && pendingLanguageRef.current === null) setLanguageDraft(null)
    }
    try {
      const next = await window.api.updateSettings({ uiLanguage })
      settingsRef.current = next
      if (last()) sentLanguageRef.current = null
      // Applied mounted or not (audit PA-4): the provider outlives this tab, so a save flushed by
      // the unmount still switches the app, `<html lang>` and the mirror. The saved value, not
      // the request.
      applyLanguageSetting(next.uiLanguage)
      if (!mountedRef.current) return
      setSettings(next)
      dropDraft()
      // In the new language: this render's `t` is the language being left.
      toast(tCatalog(resolveUiLanguage(next.uiLanguage, navigator.language), 'settings.saved'))
    } catch {
      // A refused save (the write gate on a locked workspace): the store keeps its value, the
      // select shows it again, and the failure toast is in the language shown now (CODE-7, as in
      // `patch`), which an older reply may have switched since this save was sent.
      if (last()) sentLanguageRef.current = null
      if (!mountedRef.current) return
      dropDraft()
      toast(tRef.current('settings.saveFailed'))
    }
  }

  function chooseLanguage(value: string): void {
    // A <select>'s value is a plain string: only a registered setting becomes a draft.
    if (!isUiLanguageSetting(value)) return
    setLanguageDraft(value)
    pendingLanguageRef.current = value
    if (languageTimerRef.current !== null) clearTimeout(languageTimerRef.current)
    languageTimerRef.current = setTimeout(() => flushLanguageRef.current(), LANGUAGE_SAVE_DELAY_MS)
  }

  async function patch(p: Partial<AppSettings>): Promise<void> {
    try {
      const next = await window.api.updateSettings(p)
      if (!mountedRef.current) return
      setSettings(next)
      // Appearance applies immediately — the saved value, not the request. The language has its
      // own delayed save (`flushLanguage`).
      if (p.theme !== undefined) setThemeSetting(next.theme)
      toast(t('settings.saved'))
    } catch {
      // full-audit 2026-07-11 CODE-7: a refused save (e.g. the BE-1 write gate on a locked
      // workspace) used to be an unhandled rejection with ZERO feedback — the controlled
      // Switch just snapped back, a silent revert. Surface it (the SkillsTab catch+toast
      // precedent). `settings` is deliberately NOT touched: it still holds the server's
      // last-confirmed values, so every control keeps showing the true persisted state.
      if (mountedRef.current) toast(t('settings.saveFailed'))
    }
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
        {/* A native <select> (guidelines §6, the shared `.select` class): the choices are
            *System*, then every registered language in registry order, so registering a
            language is all it takes to offer it. Language names stay in their own language
            (i18n record §3.3, standard practice): someone stuck on a UI they can't read must
            still find their way back, the way a German speaker on an English UI recognizes
            „Deutsch“. Only the *System* label is translated, because it names no language.
            #808 (open-issues wave owner call G-6): a choice is a draft, saved after a pause, on
            blur or on unmount, with one "Saved" toast in the new language (`chooseLanguage`,
            `flushLanguage`). A stored language this build doesn't register (a newer build's)
            shows a hidden, disabled placeholder with the *System* text, so choosing the real
            *System* is a change; nothing is written until the user chooses. */}
        <select
          className="select"
          aria-label={t('settings.language.aria')}
          value={
            languageDraft ?? (isUiLanguageSetting(settings.uiLanguage) ? settings.uiLanguage : '')
          }
          onChange={(e) => chooseLanguage(e.target.value)}
          onBlur={flushLanguage}
        >
          {!isUiLanguageSetting(settings.uiLanguage) && (
            <option value="" disabled hidden>
              {t('settings.language.system')}
            </option>
          )}
          <option value="system">{t('settings.language.system')}</option>
          {UI_LANGUAGES.map((info) => (
            <option key={info.code} value={info.code} lang={info.code}>
              {info.nativeName}
            </option>
          ))}
        </select>
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
        {/* Step 4-4 (Wave 4 ruling (a)): the cpu-hi rerank profile's opt-in. No effect on the
            gpu/default profiles (the hint says so) — the label/hint stay generic rather than
            naming a thread count the user cannot see or change here.
            Step 4-5 (ruling (c), B1): render this control only while the cpu-hi profile is
            actually REACHABLE (`Number.isFinite(CPU_HI_MIN_THREADS)`) — run L froze the
            constant at `Infinity` (a miss at both measured thread counts), so today the switch
            would tell the user something false about their machine: that a setting exists here
            which does something. The setting key, its write gate, the
            `resolveAskCandidateScope` plumbing and the `top48` scope are untouched — a future
            re-measurement that lowers the constant back to a finite value re-enables the
            control by that one change alone. */}
        {Number.isFinite(CPU_HI_MIN_THREADS) && (
          <>
            <Switch
              checked={settings.ragRerankWideScope}
              onChange={(on) => void patch({ ragRerankWideScope: on })}
              label={t('settings.performance.rerankWideScope')}
            />
            <p className="hint">{t('settings.performance.rerankWideScopeHint')}</p>
          </>
        )}
        <Switch
          checked={settings.autoStartActiveModel}
          onChange={(on) => void patch({ autoStartActiveModel: on })}
          label={t('settings.performance.autoStart')}
        />
        <p className="hint">{t('settings.performance.autoStartHint')}</p>
      </div>

      <div className="card">
        <h2>{t('settings.chat.title')}</h2>
        <Switch
          checked={settings.chatCompactionEnabled !== false}
          onChange={(on) => void patch({ chatCompactionEnabled: on })}
          label={t('settings.chatCompaction.label')}
        />
        <p className="hint">{t('settings.chatCompaction.help')}</p>
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
          {/* M-U5: group the token count by locale (German "8.192"). With no override the
              launched window follows the model's recommendation, so a bare number here would
              be a value nothing uses — say "Automatic" and point at the real control. */}
          <dd>
            {settings.contextTokensOverride != null
              ? settings.contextTokensOverride.toLocaleString(lang)
              : t('settings.workspace.contextAuto')}
          </dd>
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
  // The strength meter is advisory; only the MIN_PASSWORD_LENGTH floor (the one main refuses
  // under) + the confirm match (and the main process's own checks) gate submission — the
  // WorkspaceGate rules.
  const canSubmit =
    current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirm && !busy

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
        {strength.hintKey && <p className="hint">{t(strength.hintKey, strength.hintParams)}</p>}
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
      {/* SH-2 (#145): always-mounted so the FIRST failure (e.g. wrong current password) is
          announced — a freshly inserted alert element is missed by many screen readers. */}
      <ErrorBanner message={error} t={t} />
      <Button type="submit" variant="primary" disabled={!canSubmit}>
        {busy ? t('settings.changePassword.submitBusy') : t('settings.changePassword.submit')}
      </Button>
    </form>
  )
}
