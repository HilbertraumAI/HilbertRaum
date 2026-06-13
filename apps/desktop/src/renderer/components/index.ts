// Shared component layer (guidelines §6). Screens import from here; styling
// is tokens-only (tokens.css role tokens) so both themes work without theme checks.

export { englishTranslator, type Translator } from './translator'
export { Button, type ButtonProps, type ButtonVariant } from './Button'
export { Badge, type BadgeProps, type BadgeTone } from './Badge'
export { Banner, type BannerProps, type BannerTone } from './Banner'
export { ToastProvider, useToast, TOAST_DURATION_MS } from './Toast'
export { Modal, ConfirmDialog, type ModalProps, type ConfirmDialogProps } from './Dialog'
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption } from './SegmentedControl'
export { Switch, type SwitchProps } from './Switch'
export { Chip, type ChipProps } from './Chip'
export { EmptyState, type EmptyStateProps } from './EmptyState'
export { Progress, type ProgressProps } from './Progress'
export {
  LocalIndicator,
  localIndicatorLabel,
  localIndicatorDetail,
  type LocalIndicatorProps
} from './LocalIndicator'
export {
  PasswordField,
  PasswordStrengthMeter,
  passwordStrength,
  type PasswordFieldProps,
  type PasswordStrength,
  type PasswordStrengthMeterProps
} from './PasswordField'
