import { useEffect, useState } from 'react'
import { HomeScreen } from './screens/HomeScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ModelsScreen } from './screens/ModelsScreen'
import { ChatScreen } from './screens/ChatScreen'
import { DocumentsScreen } from './screens/DocumentsScreen'
import { WorkspaceGate } from './screens/WorkspaceGate'
import { Banner, Button, ToastProvider } from './components'
import { setThemeSetting } from './theme'
import { resolveNavTarget, type ScreenId, type SettingsTab } from './navigation'
import type { WorkspaceStateInfo } from '@shared/types'

interface NavItem {
  id: ScreenId
  label: string
  icon: string
}

// Information architecture (Phase 26, guidelines §2): 4 everyday destinations on top,
// Settings as the single bottom utility. Privacy and Diagnostics live INSIDE Settings
// as tabs — they are no longer nav destinations.
const NAV_TOP: NavItem[] = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'documents', label: 'Documents', icon: '📄' },
  { id: 'models', label: 'AI Model', icon: '🧠' }
]

const NAV_BOTTOM: NavItem[] = [{ id: 'settings', label: 'Settings', icon: '⚙️' }]

export function App(): JSX.Element {
  const [screen, setScreen] = useState<ScreenId>('home')
  // Which Settings tab is open (Phase 26): driven by navigate() so virtual targets
  // like 'settings:privacy' (and the legacy 'privacy' alias) land on the right tab.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  // Which composer mode the Chat screen opens with. Home's "Ask my documents" jumps
  // straight into a document-Q&A chat; plain "Chat" navigation resets to chat mode.
  const [chatMode, setChatMode] = useState<'chat' | 'documents'>('chat')
  // "Ask selected documents" handoff (Phase 17): the Documents screen's selection,
  // applied to the next documents conversation the Chat screen creates.
  const [chatScope, setChatScope] = useState<string[] | null>(null)
  // Phase 9: the workspace lifecycle gate. Null = still loading; not 'unlocked' = show
  // the create-password / unlock gate before the normal app shell.
  const [workspace, setWorkspace] = useState<WorkspaceStateInfo | null>(null)
  // Live offline state for the sidebar badge (spec §3.6). Re-checked when the
  // Settings screen is visited (network toggle may have changed).
  const [offline, setOffline] = useState(true)
  const [disabledByPolicy, setDisabledByPolicy] = useState(false)
  // Set when the backend never came up (getWorkspaceState rejected). Faking 'unlocked'
  // here used to render the full shell with every screen surfacing raw IPC errors (L5).
  const [fatalError, setFatalError] = useState<string | null>(null)
  // One-line, dismissible runtime notice (Phase 16): currently the GPU crash
  // auto-fallback's friendly "switched to compatibility mode" message (§11.4 tone).
  const [notice, setNotice] = useState<string | null>(null)

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
      .then((p) => {
        if (!active) return
        setOffline(p.offlineMode)
        setDisabledByPolicy(!p.networkAllowedByPolicy)
      })
      .catch(() => active && setOffline(true))
    // Apply the persisted Appearance setting (Phase 23). Settings are only readable
    // post-unlock; re-checked alongside the policy so a Settings-screen change made
    // this session is also picked up after navigation.
    window.api
      ?.getSettings()
      .then((s) => active && setThemeSetting(s.theme))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [screen, unlocked])

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

  // Documents screen → "Ask these documents" (Phase 17, spec §10.4): open Chat in
  // documents mode with the selection as the next conversation's retrieval scope.
  function askSelectedDocuments(documentIds: string[]): void {
    setChatMode('documents')
    setChatScope(documentIds.length > 0 ? documentIds : null)
    setScreen('chat')
  }

  async function lockNow(): Promise<void> {
    const next = await window.api.lockWorkspace()
    setWorkspace(next)
    setScreen('home')
    // The locked gate cannot read settings — back to following the OS theme.
    setThemeSetting('system')
  }

  if (fatalError) {
    return (
      <div className="gate-shell">
        <div className="card">
          <h2>The app could not start</h2>
          <p className="hint">
            The local backend did not come up, so nothing can be loaded. Restart the app; if
            this keeps happening, check <code>logs/app.log</code> on your drive and see
            docs/troubleshooting.md.
          </p>
          <p className="hint">
            <code>{fatalError}</code>
          </p>
        </div>
      </div>
    )
  }
  if (workspace && !unlocked) {
    return <WorkspaceGate state={workspace} onUnlocked={setWorkspace} />
  }
  if (!workspace) {
    return (
      <div className="gate-shell">
        <p className="hint">Loading workspace…</p>
      </div>
    )
  }

  const badgeText = disabledByPolicy
    ? '● Disabled by policy'
    : offline
      ? '● Offline Mode'
      : '○ Network allowed'

  function navButton(item: NavItem): JSX.Element {
    return (
      <li key={item.id}>
        <button
          className={`nav-item ${screen === item.id ? 'active' : ''}`}
          onClick={() => navigate(item.id)}
        >
          <span className="nav-icon">{item.icon}</span>
          {item.label}
        </button>
      </li>
    )
  }

  return (
    // The single toast host (Phase 24): screens fire "Saved"-style confirmations via
    // useToast(); the polite live region lives once, here.
    <ToastProvider>
    <div className="app-shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <div>
            <div className="brand-name">Private AI Drive</div>
            <div className="brand-edition">Lite</div>
          </div>
        </div>
        <ul className="nav-list">{NAV_TOP.map(navButton)}</ul>
        <ul className="nav-list nav-bottom">{NAV_BOTTOM.map(navButton)}</ul>
        {workspace.mode === 'encrypted' && (
          <Button size="sm" className="lock-btn" title="Re-encrypt and lock the workspace" onClick={() => void lockNow()}>
            🔒 Lock now
          </Button>
        )}
        <button
          className={`offline-badge ${offline ? '' : 'network-on'}`}
          title="No prompts or files leave this device"
          onClick={() => navigate('settings:privacy')}
        >
          {badgeText}
        </button>
      </nav>

      <main className="content">
        {notice && (
          <Banner
            tone="info"
            onDismiss={() => setNotice(null)}
            action={
              <Button size="sm" onClick={() => navigate('settings:diagnostics')}>
                Details
              </Button>
            }
          >
            {notice}
          </Banner>
        )}
        {screen === 'home' && <HomeScreen onNavigate={navigate} />}
        {screen === 'chat' && (
          <ChatScreen onNavigate={navigate} initialMode={chatMode} initialScopeDocumentIds={chatScope} />
        )}
        {screen === 'documents' && <DocumentsScreen onAskSelected={askSelectedDocuments} />}
        {screen === 'models' && <ModelsScreen />}
        {screen === 'settings' && <SettingsScreen tab={settingsTab} onTabChange={setSettingsTab} />}
      </main>
    </div>
    </ToastProvider>
  )
}
