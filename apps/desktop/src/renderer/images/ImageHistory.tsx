import { useState } from 'react'
import { Button, ConfirmDialog, Spinner } from '../components'
import { useT } from '../i18n'
import type { ImageSessionSummary } from '@shared/types'

// Image-analysis history (image-understanding history). A light text-row list (mirrors the
// chat ConversationList shape, no thumbnails): each saved analysis shows its file name + the
// number of questions asked. Opening one decrypts + reloads the image and its answers; delete
// confirms through ConfirmDialog (never browser confirm()) and shreds the stored image.
//
// `running` (when present) is the in-flight analysis, shown as a distinct top row with a spinner
// — it has no DB entry yet (the session persists on completion), so clicking it re-opens the live
// view from the renderer store rather than decrypting a saved image.

export function ImageHistory({
  sessions,
  running,
  onOpen,
  onDelete
}: {
  sessions: ImageSessionSummary[]
  /** The live in-flight analysis (the loaded image's name + a re-open handler), or null. */
  running?: { title: string; onOpen: () => void } | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}): JSX.Element {
  const { t, tCount } = useT()
  const [pendingDelete, setPendingDelete] = useState<ImageSessionSummary | null>(null)

  return (
    <section className="image-history" aria-label={t('images.history.title')}>
      <h2 className="image-history-title">{t('images.history.title')}</h2>
      {sessions.length === 0 && !running ? (
        <p className="hint image-history-empty">{t('images.history.empty')}</p>
      ) : (
        <ul className="image-history-list">
          {running && (
            <li className="image-history-row image-history-row-running">
              <button
                type="button"
                className="image-history-open"
                onClick={running.onOpen}
                title={t('images.history.runningOpen')}
              >
                <span className="image-history-name">{running.title}</span>
                <span className="image-history-meta">
                  <Spinner /> {t('images.history.running')}
                </span>
              </button>
            </li>
          )}
          {sessions.map((s) => (
            <li key={s.id} className="image-history-row">
              <button
                type="button"
                className="image-history-open"
                onClick={() => onOpen(s.id)}
                title={s.title}
              >
                <span className="image-history-name">{s.title}</span>
                <span className="image-history-meta">
                  {tCount('images.history.turns', s.turnCount)}
                </span>
              </button>
              <Button
                size="sm"
                onClick={() => setPendingDelete(s)}
                aria-label={t('images.history.delete')}
              >
                {t('images.history.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pendingDelete != null}
        title={t('images.history.delete.title')}
        confirmLabel={t('images.history.delete.confirm')}
        t={t}
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      >
        <p>{t('images.history.delete.body', { title: pendingDelete?.title ?? '' })}</p>
      </ConfirmDialog>
    </section>
  )
}
