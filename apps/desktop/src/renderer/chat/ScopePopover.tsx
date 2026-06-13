import * as Popover from '@radix-ui/react-popover'
import type { DocumentInfo } from '@shared/types'
import { Button, Chip } from '../components'
import { useT } from '../i18n'

// "📄 Using N documents ▾" (guidelines §3): the single composer-footer affordance for
// the documents-mode retrieval scope — no permanent scope-chip row on the canvas.
// The popover removes scoped documents (Chip ✕), adds more from the indexed corpus,
// or resets to all documents. Underneath, null = whole corpus (spec §10.4).

interface ScopePopoverProps {
  /** All imported documents; only indexed ones are offered. */
  docs: DocumentInfo[]
  /** Current scope; null = answers use the whole corpus. */
  scopeIds: string[] | null
  disabled?: boolean
  /** Receives the next scope (null to reset to all documents). */
  onChangeScope: (next: string[] | null) => void
  /** Jump to the Documents screen — used by the empty-corpus "Add documents" affordance. */
  onAddDocuments?: () => void
}

export function ScopePopover({ docs, scopeIds, disabled, onChangeScope, onAddDocuments }: ScopePopoverProps): JSX.Element {
  const { t, tCount } = useT()
  const indexed = docs.filter((d) => d.status === 'indexed')
  const scoped = scopeIds ?? []
  const addable = indexed.filter((d) => !scoped.includes(d.id))

  function title(id: string): string {
    return docs.find((d) => d.id === id)?.title ?? t('chat.scope.removedDoc')
  }

  // Truthful footer copy (guidelines §7): never "Using all 0 documents". With no indexed
  // documents the affordance becomes a direct "Add documents" jump, not a scope picker.
  const hasDocs = indexed.length > 0
  if (!hasDocs) {
    return (
      <button type="button" className="footer-menu-btn" disabled={disabled} onClick={onAddDocuments}>
        <span aria-hidden="true">📄</span> {t('chat.scope.none')}
      </button>
    )
  }

  const label =
    scopeIds == null ? t('chat.scope.usingAll') : tCount('chat.scope.usingSome', scoped.length)

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="footer-menu-btn" disabled={disabled}>
          <span aria-hidden="true">📄</span> {label} <span aria-hidden="true">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover"
          align="start"
          sideOffset={6}
          aria-label={t('chat.scope.popoverAria')}
        >
          {scopeIds == null ? (
            <p className="popover-line">{t('chat.scope.allLine')}</p>
          ) : (
            <>
              <p className="popover-line">{t('chat.scope.someLine')}</p>
              <div className="popover-chips">
                {scoped.map((id) => (
                  <Chip
                    key={id}
                    title={title(id)}
                    onRemove={() => {
                      const next = scoped.filter((x) => x !== id)
                      onChangeScope(next.length > 0 ? next : null)
                    }}
                    removeLabel={t('chat.scope.stopAsking', { title: title(id) })}
                    disabled={disabled}
                  >
                    {title(id)}
                  </Chip>
                ))}
              </div>
            </>
          )}
          {addable.length > 0 && (
            <>
              {scopeIds != null && (
                <p className="popover-line popover-line-add">{t('chat.scope.addLine')}</p>
              )}
              <div className="popover-chips">
                {addable.map((d) => (
                  <Chip
                    key={d.id}
                    title={t('chat.scope.askToo', { title: d.title })}
                    disabled={disabled}
                    onClick={() => onChangeScope([...scoped, d.id])}
                  >
                    + {d.title}
                  </Chip>
                ))}
              </div>
            </>
          )}
          {scopeIds != null && (
            <Button size="sm" className="popover-reset" disabled={disabled} onClick={() => onChangeScope(null)}>
              {t('chat.scope.useAll')}
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
