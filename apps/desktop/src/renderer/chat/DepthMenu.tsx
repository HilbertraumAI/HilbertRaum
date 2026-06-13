import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useT } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import type { ChatDepthMode } from '@shared/types'

// "Answer detail" dropdown (guidelines §3): a quiet composer-footer affordance, not a
// prominent 3-way toggle. UI labels are Quick · Balanced · Thorough; the ids stay
// `fast|balanced|deep` everywhere in code/IPC/persistence (no data migration).
// Thorough is offered only when the running model's manifest declares thinking support.
// Label/hint maps hold MessageKeys resolved at render (i18n record §5).

export const DEPTH_LABEL_KEYS: Record<ChatDepthMode, MessageKey> = {
  fast: 'chat.depth.fast',
  balanced: 'chat.depth.balanced',
  deep: 'chat.depth.deep'
}

const DEPTH_HINT_KEYS: Record<ChatDepthMode, MessageKey> = {
  fast: 'chat.depth.fastHint',
  balanced: 'chat.depth.balancedHint',
  deep: 'chat.depth.deepHint'
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
  const { t } = useT()
  const options = DEPTH_ORDER.filter((d) => d !== 'deep' || supportsThinking)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="footer-menu-btn" disabled={disabled}>
          {t('chat.depth.trigger', { label: t(DEPTH_LABEL_KEYS[value]) })}{' '}
          <span aria-hidden="true">▾</span>
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
                  {t(DEPTH_LABEL_KEYS[d])}
                  <span className="menu-item-hint">{t(DEPTH_HINT_KEYS[d])}</span>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
