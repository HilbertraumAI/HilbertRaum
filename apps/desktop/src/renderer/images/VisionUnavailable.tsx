import { Button, EmptyState } from '../components'
import { useT } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import type { VisionUnavailableReason } from '@shared/types'

// The §5.1 availability card: reason-adaptive note + a CTA that routes to AI Model (which
// owns the triple-gated downloader — no invented downloads here) + a quiet OCR pointer.
// Calm, human copy only; the technical reason stays in the local log (never surfaced).

const REASON_NOTE: Record<VisionUnavailableReason, MessageKey> = {
  'no-model': 'images.avail.noModel',
  'no-runtime': 'images.avail.noRuntime',
  incompatible: 'images.avail.incompatible'
}

export function VisionUnavailable({
  reason,
  onNavigate
}: {
  reason: VisionUnavailableReason
  onNavigate: (target: string) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <EmptyState
      title={t(REASON_NOTE[reason])}
      line={t('images.avail.ocrPointer')}
      action={
        <Button variant="primary" onClick={() => onNavigate('models')}>
          {t('images.avail.cta')}
        </Button>
      }
    />
  )
}
