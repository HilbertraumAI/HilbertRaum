import { Button } from '../components'
import { useT } from '../i18n'
import { fmtDiskSize } from '@shared/format'
import type { ImageMime } from './decode'

// Preview pane (§5.3): the image via a `data:` URL (CSP-safe — never `blob:`, SEC-1),
// the filename (ellipsized), a muted human meta line "PNG · 1.2 MB · 1280×720", and a
// Remove / Replace control. Dimensions/size are human, so no "Technical details" disclosure.

const MIME_LABEL: Record<ImageMime, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG'
}

export function ImagePreview({
  dataUrl,
  name,
  mimeType,
  width,
  height,
  sizeBytes,
  onRemove,
  onReplace,
  busy
}: {
  dataUrl: string
  name: string
  mimeType: ImageMime
  width: number
  height: number
  sizeBytes: number
  onRemove: () => void
  onReplace: () => void
  busy?: boolean
}): JSX.Element {
  const { t, lang } = useT()
  const meta = `${MIME_LABEL[mimeType]} · ${fmtDiskSize(sizeBytes, lang)} · ${width}×${height}`
  return (
    <div className="image-preview">
      <div className="image-preview-frame">
        {/* `data:` only — the prod CSP `img-src 'self' data:` lists no `blob:` (SEC-1). */}
        <img className="image-preview-img" src={dataUrl} alt={t('images.preview.alt')} />
      </div>
      <div className="image-preview-name" title={name}>
        {name}
      </div>
      <div className="image-preview-meta">{meta}</div>
      <div className="image-preview-actions">
        <Button size="sm" disabled={busy} onClick={onReplace}>
          {t('images.preview.replace')}
        </Button>
        <Button size="sm" disabled={busy} onClick={onRemove}>
          {t('images.preview.remove')}
        </Button>
      </div>
    </div>
  )
}
