import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ChatDepthMode } from '@shared/types'

// "Answer detail" dropdown (Phase 25, guidelines §3 + decision D-UI4): a quiet
// composer-footer affordance, not a prominent 3-way toggle. UI labels are
// Quick · Balanced · Thorough; the ids stay `fast|balanced|deep` everywhere in
// code/IPC/persistence (D-UI4 — no data migration). Thorough is offered only when the
// running model's manifest declares thinking support (current behavior preserved).

export const DEPTH_LABELS: Record<ChatDepthMode, string> = {
  fast: 'Quick',
  balanced: 'Balanced',
  deep: 'Thorough'
}

const DEPTH_HINTS: Record<ChatDepthMode, string> = {
  fast: 'Short, to-the-point answers',
  balanced: 'The everyday default',
  deep: 'Thinks the problem through before answering — takes longer'
}

const DEPTH_ORDER: ChatDepthMode[] = ['fast', 'balanced', 'deep']

interface DepthMenuProps {
  value: ChatDepthMode
  onChange: (depth: ChatDepthMode) => void
  /** Hides Thorough when the model cannot think. */
  supportsThinking: boolean
  disabled?: boolean
}

export function DepthMenu({ value, onChange, supportsThinking, disabled }: DepthMenuProps): JSX.Element {
  const options = DEPTH_ORDER.filter((d) => d !== 'deep' || supportsThinking)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="footer-menu-btn" disabled={disabled}>
          Answer detail: {DEPTH_LABELS[value]} <span aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="start" sideOffset={6}>
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(next as ChatDepthMode)}
          >
            {options.map((d) => (
              <DropdownMenu.RadioItem key={d} value={d} className="menu-item menu-radio">
                <span className="menu-radio-mark" aria-hidden="true">
                  <DropdownMenu.ItemIndicator>●</DropdownMenu.ItemIndicator>
                </span>
                <span>
                  {DEPTH_LABELS[d]}
                  <span className="menu-item-hint">{DEPTH_HINTS[d]}</span>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
