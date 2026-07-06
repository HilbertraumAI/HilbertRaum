import { useEffect, useState } from 'react'
import { HomeScreen } from './screens/HomeScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ModelsScreen } from './screens/ModelsScreen'
import { ChatScreen } from './screens/ChatScreen'
import { DocumentsScreen } from './screens/DocumentsScreen'
import { TranslateScreen } from './screens/TranslateScreen'
import { ImagesScreen } from './screens/ImagesScreen'
import { SkillsScreen } from './screens/SkillsScreen'
import { WorkspaceGate } from './screens/WorkspaceGate'
import {
  Banner,
  BrandMark,
  Button,
  ErrorBoundary,
  Icon,
  LocalIndicator,
  ToastProvider,
  type IconName
} from './components'
import { setThemeSetting } from './theme'
import { purgeSessionStores } from './lib/lockPurge'
import { I18nProvider, useT, type I18n } from './i18n'
import { resolveNavTarget, type ScreenId, type SettingsTab } from './navigation'
import type { MessageKey } from '@shared/i18n'
import type { WorkspaceStateInfo } from '@shared/types'

interface NavItem {
  id: ScreenId
  labelKey: MessageKey
  icon: IconName
}

// Information architecture (design-guidelines §2): 7 everyday destinations on top,
// Settings as the single bottom utility. Privacy and Diagnostics live INSIDE Settings
// as tabs — they are no longer nav destinations. Skills is a top-level destination of its
// own (no longer a Settings tab) — it is a first-class capability surface, not a setting.
// Images (image-understanding §6) and Translate (TranslateGemma plan §2 D6) are distinct
// task surfaces parallel to Documents/Chat.
const NAV_TOP: NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'home' },
  { id: 'chat', labelKey: 'nav.chat', icon: 'chat' },
  { id: 'documents', labelKey: 'nav.documents', icon: 'file' },
  // Translate is a genuine primary destination — a first-class text-translation surface on the
  // dedicated TranslateGemma sidecar (TranslateGemma plan §2 D6; design-guidelines §2 updated to
  // "7 primary + 1 utility"). Sits after Documents, before Images.
  { id: 'translate', labelKey: 'nav.translate', icon: 'translate' },
  // Images is a genuine primary destination — a first-class task surface parallel to
  // Documents/Chat, not a sub-mode (image-understanding §6). After Translate, before AI Model.
  { id: 'images', labelKey: 'nav.images', icon: 'image' },
  { id: 'models', labelKey: 'nav.models', icon: 'brain' },
  { id: 'skills', labelKey: 'nav.skills', icon: 'puzzle' }
]

const NAV_BOTTOM: NavItem[] = [{ id: 'settings', labelKey: 'nav.settings', icon: 'settings' }]

export function App(): JSX.Element {
  // The language provider wraps EVERYTHING, including the pre-unlock gate (which
  // resolves from the localStorage mirror / OS locale — i18n record §3.2).
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  )
}

function AppShell(): JSX.Element {
  const [screen, setScreen] = useState<ScreenId>('home')
  // Which Settings tab is open: driven by navigate() so virtual targets
  // like 'settings:privacy' (and the legacy 'privacy' alias) land on the right tab.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  // Which composer mode the Chat screen opens with. Home's "Ask my documents" jumps
  // straight into a document-Q&A chat; plain "Chat" navigation resets to chat mode.
  const [chatMode, setChatMode] = useState<'chat' | 'documents'>('chat')
  // "Ask selected documents" handoff: the Documents screen's selection,
  // applied to the next documents conversation the Chat screen creates.
  const [chatScope, setChatScope] = useState<string[] | null>(null)
  // The workspace lifecycle gate. Null = still loading; not 'unlocked' = show
  // the create-password / unlock gate before the normal app shell.
  const [workspace, setWorkspace] = useState<WorkspaceStateInfo | null>(null)
  // Live EFFECTIVE offline state for the single rail-foot privacy indicator (§1.2/§12.1
  // #2). `getPolicy().offlineMode` already folds the drive policy AND the network toggle,
  // so a policy that forces downloads off reads "Offline" even with the toggle on.
  // Re-checked when the Settings screen is visited (the toggle may have changed). Policy
  // detail ("disabled by policy" vs. off by choice) lives on the Privacy & data tab the
  // indicator opens.
  const [offline, setOffline] = useState(true)
  // Set when the backend never came up (getWorkspaceState rejected). Faking 'unlocked'
  // here would render the full shell with every screen surfacing raw IPC errors.
  const [fatalError, setFatalError] = useState<string | null>(null)
  // One-line, dismissible runtime notice: currently the GPU crash auto-fallback's
  // friendly "switched to compatibility mode" message (spec §11.4 tone).
  const [notice, setNotice] = useState<string | null>(null)
  const { t, applyLanguageSetting } = useT()

  useEffect(() => {
    const unsubscribe = window.api?.onRuntimeNotice?.((message) => setNotice(message))
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    let active = true
    window.api
      ?.getWorkspaceState()
      .then((s) => active && setWorkspace(s))
      .catch((e) => active && setFatalError(String(e instanceof Error ? e.message : e)))
    return () => {
      active = false
    }
  }, [])

  const unlocked = workspace?.state === 'unlocked'

  useEffect(() => {
    if (!unlocked) return
    let active = true
    window.api
      ?.getPolicy()
      .then((p) => active && setOffline(p.offlineMode))
      .catch(() => active && setOffline(true))
    // Apply the persisted Appearance + Language settings. Settings are only readable
    // post-unlock; re-checked alongside the policy so a Settings-screen change made
    // this session is also picked up after navigation. applyLanguageSetting also
    // refreshes <html lang> and the pre-unlock localStorage mirror.
    window.api
      ?.getSettings()
      .then((s) => {
        if (!active) return
        setThemeSetting(s.theme)
        applyLanguageSetting(s.uiLanguage)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [screen, unlocked, applyLanguageSetting])

  // Central navigation: screens hand any target (real, virtual, or legacy alias) to
  // resolveNavTarget — see navigation.ts for the table.
  function navigate(target: string): void {
    const next = resolveNavTarget(target)
    if (next.chatMode) {
      setChatMode(next.chatMode)
      setChatScope(null)
    }
    if (next.settingsTab) setSettingsTab(next.settingsTab)
    setScreen(next.screen)
  }

  // Documents screen → "Ask these documents" (spec §10.4): open Chat in
  // documents mode with the selection as the next conversation's retrieval scope.
  function askSelectedDocuments(documentIds: string[]): void {
    setChatMode('documents')
    setChatScope(documentIds.length > 0 ? documentIds : null)
    setScreen('chat')
  }

  async function lockNow(): Promise<void> {
    const next = await window.api.lockWorkspace()
    // The real lock seam (TA-2 / H3): main has now aborted the jobs + re-encrypted the vault, so
    // drop the resident source/translation/image content from the module-level session stores in
    // lockstep. Screens can't do this themselves — lock unmounts every screen (the shell swaps to
    // WorkspaceGate below), so a screen-effect purge would never observe the lock.
    purgeSessionStores()
    setWorkspace(next)
    setScreen('home')
    // The locked gate cannot read settings — back to following the OS theme.
    // (The LANGUAGE deliberately stays: the gate follows the localStorage mirror.)
    setThemeSetting('system')
  }

  if (fatalError) {
    return (
      <div className="gate-shell">
        <div className="card">
          <h2>{t('app.fatal.title')}</h2>
          <p className="hint">
            {t('app.fatal.hintBefore')}
            <code>logs/app.log</code>
            {t('app.fatal.hintAfter')}
          </p>
          <p className="hint">
            <code>{fatalError}</code>
          </p>
        </div>
      </div>
    )
  }
  if (workspace && !unlocked) {
    return (
      <WorkspaceGate
        state={workspace}
        onUnlocked={(next, landOn) => {
          setWorkspace(next)
          // First-run create ends on the teaching Chat empty state (or the screen the
          // optional starter step picked); a plain unlock keeps the current screen.
          if (landOn) navigate(landOn)
        }}
      />
    )
  }
  if (!workspace) {
    return (
      <div className="gate-shell">
        <p className="hint">{t('app.loadingWorkspace')}</p>
      </div>
    )
  }

  function navButton(item: NavItem): JSX.Element {
    const label = t(item.labelKey)
    const active = screen === item.id
    return (
      <li key={item.id}>
        <button
          className={`nav-item ${active ? 'active' : ''}`}
          // Icon + short label make a quiet rail; the label can wrap/clip on narrow
          // widths, so the title carries the full destination name for a tooltip too.
          title={label}
          aria-current={active ? 'page' : undefined}
          onClick={() => navigate(item.id)}
        >
          <Icon name={item.icon} className="nav-icon" />
          <span className="nav-label">{label}</span>
        </button>
      </li>
    )
  }

  return (
    // The single toast host: screens fire "Saved"-style confirmations via
    // useToast(); the polite live region lives once, here.
    <ToastProvider>
    <div className="app-shell">
      <nav className="sidebar" aria-label={t('nav.aria')}>
        <div className="brand" title="HilbertRaum">
          <BrandMark size={24} />
          <span className="brand-name">HilbertRaum</span>
        </div>
        <ul className="nav-list">{NAV_TOP.map(navButton)}</ul>
        <ul className="nav-list nav-bottom">{NAV_BOTTOM.map(navButton)}</ul>
        {workspace.mode === 'encrypted' && (
          <button
            type="button"
            className="lock-btn"
            title={t('app.lockNowTitle')}
            aria-label={t('app.lockNow')}
            onClick={() => void lockNow()}
          >
            <Icon name="lock" className="nav-icon" />
            <span className="nav-label">{t('app.lockNow')}</span>
          </button>
        )}
        {/* The single app-wide privacy signal (§1.2/§7/§12.1 #2): one quiet, honest
            indicator at the foot of the rail, on EVERY screen. `offline` is the effective
            policy state owned by App, so a drive policy that forces downloads off reads
            "Offline" even with the toggle on. */}
        <LocalIndicator variant="sidebar" offline={offline} onNavigate={navigate} t={t} />
      </nav>

      <main className="content">
        {notice && (
          <Banner
            tone="info"
            t={t}
            onDismiss={() => setNotice(null)}
            action={
              <Button size="sm" onClick={() => navigate('settings:diagnostics')}>
                {t('app.noticeDetails')}
              </Button>
            }
          >
            {notice}
          </Banner>
        )}
        {/* Per-screen error boundary (audit FE-1). KEYED by `screen`, so navigating to any
            other destination re-mounts the subtree and clears a captured error — the nav rail
            above lives OUTSIDE the boundary, so a render throw never traps the user. The
            fallback also offers an in-place retry. Logging is local-only (ErrorBoundary). */}
        <ErrorBoundary
          key={screen}
          fallback={(reset) => (
            // onHome resets the boundary AND navigates: if HOME itself threw, navigate('home') is
            // a same-value setScreen no-op (no key change → no re-mount), so reset() is what
            // actually clears the error; on any other screen the navigate changes the key and
            // reset() is harmless. Without the reset, "Go to Home" would be a dead no-op when the
            // throwing screen is Home (the default screen).
            <ScreenErrorFallback
              t={t}
              onRetry={reset}
              onHome={() => {
                reset()
                navigate('home')
              }}
            />
          )}
        >
          {screen === 'home' && <HomeScreen onNavigate={navigate} />}
          {screen === 'chat' && (
            <ChatScreen
              onNavigate={navigate}
              initialMode={chatMode}
              initialScopeDocumentIds={chatScope}
            />
          )}
          {screen === 'documents' && (
            <DocumentsScreen onAskSelected={askSelectedDocuments} onNavigate={navigate} />
          )}
          {screen === 'translate' && <TranslateScreen onNavigate={navigate} />}
          {screen === 'images' && <ImagesScreen onNavigate={navigate} />}
          {screen === 'models' && <ModelsScreen />}
          {screen === 'skills' && <SkillsScreen />}
          {screen === 'settings' && (
            <SettingsScreen tab={settingsTab} onTabChange={setSettingsTab} />
          )}
        </ErrorBoundary>
      </main>
    </div>
    </ToastProvider>
  )
}

// The localized per-screen fallback (audit FE-1). role="alert" so the contained failure is
// announced; the calm copy (spec §11.4) reassures that nothing was lost, with an in-place
// retry and an escape to Home.
function ScreenErrorFallback({
  t,
  onRetry,
  onHome
}: {
  t: I18n['t']
  onRetry: () => void
  onHome: () => void
}): JSX.Element {
  return (
    <div className="screen" role="alert">
      <div className="card">
        <h2>{t('errorBoundary.title')}</h2>
        <p className="hint">{t('errorBoundary.body')}</p>
        <div className="actions">
          <Button variant="primary" onClick={onRetry}>
            {t('errorBoundary.retry')}
          </Button>
          <Button onClick={onHome}>{t('errorBoundary.home')}</Button>
        </div>
      </div>
    </div>
  )
}
