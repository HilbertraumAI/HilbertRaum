import type { ReactNode } from 'react'

// Switch (guidelines §6): for BINARY settings (checkbox stays for multi-select /
// acknowledgements). A real <input type="checkbox" role="switch"> under a styled track —
// native keyboard toggling (Space), native label association (the whole row is the
// ≥24px hit target), :focus-visible ring on the track via CSS. Track is --brand-teal-dark
// when on in both themes (the white thumb needs ≥3:1 — bright teal would fail). Hand-rolled
// — only dialogs warrant a library (Radix).

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Visible, clickable label. */
  label: ReactNode
  disabled?: boolean
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps): JSX.Element {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        className="switch-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </label>
  )
}
