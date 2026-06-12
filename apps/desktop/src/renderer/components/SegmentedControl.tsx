import { useRef } from 'react'

// Segmented control (guidelines §6): pill track, the selected segment gets --surface +
// --shadow-1 (plus weight — never color-only). Radio-group semantics with a roving
// tabindex: only the selected segment is tabbable; arrow keys move focus AND selection
// (Home/End jump). Hand-rolled — only dialogs warrant a library (Radix).

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  /** Accessible name for the group (e.g. "Theme"). */
  ariaLabel: string
  disabled?: boolean
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled
}: SegmentedControlProps<T>): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  // Fall back to the first segment as the tab stop if value matches no option.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )

  function move(from: number, delta: number): void {
    // Skip disabled segments, wrapping around.
    for (let step = 1; step <= options.length; step++) {
      const i = (from + delta * step + options.length * step) % options.length
      if (!options[i].disabled) {
        refs.current[i]?.focus()
        onChange(options[i].value)
        return
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      move(index, 1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(index, -1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      move(options.length - 1, 1)
    } else if (e.key === 'End') {
      e.preventDefault()
      move(0, -1)
    }
  }

  return (
    <div role="radiogroup" aria-label={ariaLabel} className="seg">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          tabIndex={i === selectedIndex ? 0 : -1}
          className={`seg-btn ${opt.value === value ? 'selected' : ''}`}
          disabled={disabled || opt.disabled}
          onClick={() => onChange(opt.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
