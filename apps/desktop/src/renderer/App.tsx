import { useState } from 'react'
import { HomeScreen } from './screens/HomeScreen'
import { PlaceholderScreen } from './screens/PlaceholderScreen'
import { DiagnosticsScreen } from './screens/DiagnosticsScreen'
import { SettingsScreen } from './screens/SettingsScreen'

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
        <div className="offline-badge" title="No prompts or files leave this device">
          ● Offline Mode
        </div>
      </nav>

      <main className="content">
        {screen === 'home' && <HomeScreen onNavigate={(s) => setScreen(s as ScreenId)} />}
        {screen === 'chat' && (
          <PlaceholderScreen title="Chat" phase="Phase 3" />
        )}
        {screen === 'documents' && (
          <PlaceholderScreen title="Documents" phase="Phase 4" />
        )}
        {screen === 'models' && (
          <PlaceholderScreen title="Models" phase="Phase 2" />
        )}
        {screen === 'privacy' && (
          <PlaceholderScreen title="Privacy & Offline Mode" phase="Phase 8" />
        )}
        {screen === 'diagnostics' && <DiagnosticsScreen />}
        {screen === 'settings' && <SettingsScreen />}
      </main>
    </div>
  )
}
