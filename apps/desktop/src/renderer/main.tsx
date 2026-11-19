import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components'
import { resolvePreUnlockLanguage } from './i18n'
import { t } from '@shared/i18n'
import { initTheme } from './theme'
import { installBeforeCloseBridge } from './lib/beforeClose'
import './tokens.css'
import './styles.css'

// Apply a theme before first paint. Settings live in the (possibly encrypted, so
// unreadable pre-unlock) DB — until they load, follow the OS.
initTheme()

// #888: answer main's "save before the window closes" before anything renders, so a render error
// or the workspace gate never leaves the close waiting out main's bound (lib/beforeClose.ts).
installBeforeCloseBridge(window.api)

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

// Outer, last-resort error boundary (audit FE-1). The per-screen boundary inside AppShell
// keeps the nav rail alive on a screen throw; THIS one catches anything above it (the gate,
// the provider, AppShell itself) so even a top-level render throw shows a localized reload
// prompt instead of a blank window. It sits OUTSIDE I18nProvider, so the fallback resolves
// the pre-unlock language itself. Logging is local-only (ErrorBoundary).
function RootErrorFallback(): JSX.Element {
  const lang = resolvePreUnlockLanguage()
  return (
    <div className="gate-shell">
      <div className="card" role="alert">
        <h2>{t(lang, 'errorBoundary.app.title')}</h2>
        <p className="hint">{t(lang, 'errorBoundary.app.body')}</p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          {t(lang, 'errorBoundary.app.reload')}
        </button>
      </div>
    </div>
  )
}

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary fallback={() => <RootErrorFallback />}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
