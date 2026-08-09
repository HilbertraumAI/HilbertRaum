import { ConfirmDialog } from '../components'
import { useT } from '../i18n'

// Beta-feedback Phase 4 (#26/D71): attaching a file to an EXISTING whole-library documents chat
// offers a one-time narrow choice — "Just this file" narrows retrieval to the chat's attachments,
// "Whole library" keeps the corpus-wide default. Sticky per conversation once answered (ChatScreen
// records the choice so it never re-prompts). A single-document conversation created fresh from an
// attachment / "Ask selected" is already docs-scoped at creation and never reaches this dialog.
export interface ScopeNarrowDialogProps {
  open: boolean
  /** Base name of the file just attached — named in the prompt so the choice is concrete. */
  fileName: string
  /** "Just this file" — narrow retrieval to the chat's attachments. */
  onNarrow: () => void
  /** "Whole library" — keep the corpus-wide default (and stop asking for this conversation). */
  onWhole: () => void
  /**
   * CH-13 (#148): Esc / overlay click — close WITHOUT deciding. Only the explicit buttons
   * record the sticky per-conversation choice; a dismissal leaves the next attach free to
   * re-ask. (Previously dismissal was mapped to "Whole library" AND made sticky.)
   */
  onDismiss: () => void
}

export function ScopeNarrowDialog({ open, fileName, onNarrow, onWhole, onDismiss }: ScopeNarrowDialogProps): JSX.Element {
  const { t } = useT()
  return (
    <ConfirmDialog
      open={open}
      title={t('chat.scope.narrowTitle')}
      confirmLabel={t('chat.scope.narrowJust')}
      cancelLabel={t('chat.scope.narrowWhole')}
      onConfirm={onNarrow}
      onCancel={onWhole}
      onDismiss={onDismiss}
      t={t}
    >
      {t('chat.scope.narrowBody', { name: fileName })}
    </ConfirmDialog>
  )
}
