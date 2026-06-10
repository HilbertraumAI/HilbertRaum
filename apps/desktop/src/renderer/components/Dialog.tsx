import * as RadixDialog from '@radix-ui/react-dialog'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'

// Modal dialogs (guidelines §6) on Radix Dialog (decision D-UI1: focus trap, Esc-close,
// and focus-return are easy to get wrong by hand). --shadow-3 + --radius-lg via CSS;
// max ~480px for confirms, 640px for content, `wide` (760px) for reading surfaces.
// Both components are CONTROLLED (open + close callback).

/**
 * Focus return for CONTROLLED dialogs: Radix's default close-focus targets its
 * Dialog.Trigger, which controlled dialogs don't render — without this, focus would
 * fall to <body> on close. Captures the focused element when `open` flips true and
 * restores it via onCloseAutoFocus.
 */
function useReturnFocus(open: boolean): (event: Event) => void {
  const returnTo = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) {
      returnTo.current = document.activeElement
    }
  }, [open])
  return useCallback((event: Event) => {
    event.preventDefault()
    returnTo.current?.focus()
    returnTo.current = null
  }, [])
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  /** Shown in the modal header next to the Close button. */
  title: ReactNode
  /** Accessible name when the visible title alone isn't descriptive enough. */
  ariaLabel?: string
  width?: 'content' | 'wide'
  children: ReactNode
}

/** General content dialog with a header Close button (preview, forms). */
export function Modal({ open, onClose, title, ariaLabel, width = 'content', children }: ModalProps): JSX.Element {
  const onCloseAutoFocus = useReturnFocus(open)
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content
          className={`dialog ${width === 'wide' ? 'dialog-wide' : ''}`}
          aria-label={ariaLabel}
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div className="modal-head">
            <RadixDialog.Title className="modal-title">{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button size="sm">Close</Button>
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  /** Body content — a sentence describing what will happen. */
  children?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Disables the confirm button (e.g. a required acknowledgement not yet given). */
  confirmDisabled?: boolean
  onConfirm: () => void
  /** Called on Cancel, Esc, and clicking the overlay. */
  onCancel: () => void
}

/**
 * Confirmation dialog: primary button on the RIGHT (guidelines §1.6/§6), Esc cancels,
 * focus is trapped while open and returns to the trigger on close.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmDisabled,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element {
  const onCloseAutoFocus = useReturnFocus(open)
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content
          className="dialog dialog-confirm"
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <RadixDialog.Title className="modal-title">{title}</RadixDialog.Title>
          {children != null && <div className="modal-body">{children}</div>}
          <div className="modal-actions">
            <Button onClick={onCancel}>{cancelLabel}</Button>
            <Button variant="primary" disabled={confirmDisabled} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
