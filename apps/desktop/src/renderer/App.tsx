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
  // Which composer mode the Chat screen opens with. Home's "Ask My Documents" jumps
  // straight into a document-Q&A chat; plain "Chat" navigation resets to chat mode.
  const [chatMode, setChatMode] = useState<'chat' | 'documents'>('chat')
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
    return () => {
      active = false
    }
  }, [screen, unlocked])

  // Central navigation: 'ask-documents' is a virtual target meaning "Chat screen in
  // documents mode" (Home's Ask My Documents used to land on the import screen).
  function navigate(target: string): void {
    if (target === 'ask-documents') {
      setChatMode('documents')
      setScreen('chat')
      return
    }
    if (target === 'chat') setChatMode('chat')
    setScreen(target as ScreenId)
  }

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
                onClick={() => navigate(item.id)}
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
        {notice && (
          <div className="card" role="status" style={{ marginBottom: 12 }}>
            <p className="hint" style={{ margin: 0 }}>
              {notice}{' '}
              <button className="btn sm" onClick={() => setNotice(null)}>
                OK
              </button>
            </p>
          </div>
        )}
        {screen === 'home' && <HomeScreen onNavigate={navigate} />}
        {screen === 'chat' && <ChatScreen onNavigate={navigate} initialMode={chatMode} />}
        {screen === 'documents' && <DocumentsScreen />}
        {screen === 'models' && <ModelsScreen />}
        {screen === 'privacy' && <PrivacyScreen />}
        {screen === 'diagnostics' && <DiagnosticsScreen />}
        {screen === 'settings' && <SettingsScreen />}
      </main>
    </div>
  )
}
