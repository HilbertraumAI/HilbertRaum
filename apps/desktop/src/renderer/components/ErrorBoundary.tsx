import { Component, type ErrorInfo, type ReactNode } from 'react'

// Top-level render-error containment (audit FE-1). React unmounts the WHOLE tree when a
// render throws (e.g. react-markdown on malformed model output, a Radix portal edge) — in
// an offline desktop app that means a blank white window with no recovery. This boundary
// catches the throw, renders a localized fallback instead, and keeps the rest of the shell
// (the nav rail) alive so the user is never trapped.
//
// LOGGING IS LOCAL-ONLY (CLAUDE.md hard rule: no cloud, no telemetry, no remote crash
// reporting). There is no renderer→main log IPC channel today (the preload exposes only the
// READ-only getLogTail/exportLog), so we log to the renderer console — never a network call.
// `onError` is an optional ADDITIONAL local sink; it must never reach the network either.
//
// Reset model: the App wraps each screen in a boundary KEYED by the active screen, so simply
// navigating away re-mounts the subtree and clears the error (the nav rail lives OUTSIDE the
// boundary). The `reset` handed to the fallback additionally lets the user retry the SAME
// screen in place. An outer last-resort boundary wraps <App/> in main.tsx.

export interface ErrorBoundaryProps {
  children: ReactNode
  /**
   * Renders the fallback UI when a child throws. `reset` clears the captured error so the
   * subtree re-mounts and re-renders (the "try again" affordance).
   */
  fallback: (reset: () => void) => ReactNode
  /** Optional LOCAL-only error sink, called in addition to console.error. Never network. */
  onError?: (error: Error) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local console only — NEVER a remote/telemetry report (CLAUDE.md hard rule).
    console.error('[renderer] uncaught render error', error, info.componentStack)
    this.props.onError?.(error)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.reset)
    return this.props.children
  }
}
