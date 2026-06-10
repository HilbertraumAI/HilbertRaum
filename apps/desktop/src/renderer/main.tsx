import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initTheme } from './theme'
import './tokens.css'
import './styles.css'

// Apply a theme before first paint. Settings live in the (possibly encrypted, so
// unreadable pre-unlock) DB — until they load, follow the OS (Phase 23, D-UI2).
initTheme()

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
