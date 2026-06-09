import { useEffect, useState } from 'react'
import { HomeScreen } from './screens/HomeScreen'
import { PrivacyScreen } from './screens/PrivacyScreen'
import { DiagnosticsScreen } from './screens/DiagnosticsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ModelsScreen } from './screens/ModelsScreen'
import { ChatScreen } from './screens/ChatScreen'
import { DocumentsScreen } from './screens/DocumentsScreen'
import { WorkspaceGate } from './screens/WorkspaceGate'
import type { WorkspaceStateInfo } from '@shared/types'

type ScreenId =
  | 'home'
  | 'chat'
  | 'documents'
  | 'models'
  | 'settings'
  | 'privacy'
  | 'diagnostics'

interface NavItem {
  id: ScreenId
  label: string
  icon: string
}

const NAV: NavItem[] = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'documents', label: 'Documents', icon: '📄' },
  { id: 'models', label: 'Models', icon: '🧠' },
  { id: 'privacy', label: 'Privacy & Offline', icon: '🔒' },
  { id: 'diagnostics', label: 'Diagnostics', icon: '🩺' },
  { id: 'settings', label: 'Settings', icon: '⚙️' }
]

export function App(): JSX.Element {
  const [screen, setScreen] = useState<ScreenId>('home')
  // Phase 9: the workspace lifecycle gate. Null = still loading; not 'unlocked' = show
  // the create-password / unlock gate before the normal app shell.
  const [workspace, setWorkspace] = useState<WorkspaceStateInfo | null>(null)
  // Live offline state for the sidebar badge (spec §3.6). Re-checked when the
  // Privacy/Settings screens are visited (network toggle may have changed).
  const [offline, setOffline] = useState(true)
  const [disabledByPolicy, setDisabledByPolicy] = useState(false)
  // Set when the backend never came up (getWorkspaceState rejected). Faking 'unlocked'
  // here used to render the full shell with every screen surfacing raw IPC errors (L5).
  const [fatalError, setFatalError] = useState<string | null>(null)

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
    return () => {
      active = false
    }
  }, [screen, unlocked])

  async function lockNow(): Promise<void> {
    const next = await window.api.lockWorkspace()
    setWorkspace(next)
    setScreen('home')
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

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <div>
            <div className="brand-name">Private AI Drive</div>
            <div className="brand-edition">Lite</div>
          </div>
        </div>
        <ul className="nav-list">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                className={`nav-item ${screen === item.id ? 'active' : ''}`}
                onClick={() => setScreen(item.id)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        {workspace.mode === 'encrypted' && (
          <button className="btn sm lock-btn" title="Re-encrypt and lock the workspace" onClick={() => void lockNow()}>
            🔒 Lock now
          </button>
        )}
        <button
          className={`offline-badge ${offline ? '' : 'network-on'}`}
          title="No prompts or files leave this device"
          onClick={() => setScreen('privacy')}
        >
          {badgeText}
        </button>
      </nav>

      <main className="content">
        {screen === 'home' && <HomeScreen onNavigate={(s) => setScreen(s as ScreenId)} />}
        {screen === 'chat' && <ChatScreen onNavigate={(s) => setScreen(s as ScreenId)} />}
        {screen === 'documents' && <DocumentsScreen />}
        {screen === 'models' && <ModelsScreen />}
        {screen === 'privacy' && <PrivacyScreen />}
        {screen === 'diagnostics' && <DiagnosticsScreen />}
        {screen === 'settings' && <SettingsScreen />}
      </main>
    </div>
  )
}
