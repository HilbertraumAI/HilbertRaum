import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode
} from 'react'

// Toast (guidelines §6): transient confirmation ("Copied" / "Saved") that auto-dismisses
// after 4 s, announced over a polite ARIA live region. NEVER for actionable errors —
// those get a Banner in context. The single host lives in App.tsx (ToastProvider);
// screens call `useToast()`. The default context is a no-op so a screen rendered
// without the provider (unit tests) never crashes.

export const TOAST_DURATION_MS = 4000

interface ToastItem {
  id: number
  message: string
}

const ToastContext = createContext<(message: string) => void>(() => {})

/** Returns `showToast(message)`. A no-op when no ToastProvider is mounted. */
export function useToast(): (message: string) => void {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)

  const show = useCallback((message: string): void => {
    const id = nextId.current++
    setToasts((prev) => [...prev, { id, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, TOAST_DURATION_MS)
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* The live region is always mounted so screen readers announce additions. */}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
