import * as Popover from '@radix-ui/react-popover'
import type { DocumentInfo } from '@shared/types'
import { Button, Chip } from '../components'

// "📄 Using N documents ▾" (Phase 25, guidelines §3): the single composer-footer
// affordance for the documents-mode retrieval scope, replacing the permanent
// scope-chip row on the canvas. The popover removes scoped documents (Chip ✕),
// adds more from the indexed corpus, or resets to all documents. Scope semantics
// are unchanged underneath: null = whole corpus (spec §10.4).

interface ScopePopoverProps {
  /** All imported documents; only indexed ones are offered. */
  docs: DocumentInfo[]
  /** Current scope; null = answers use the whole corpus. */
  scopeIds: string[] | null
  disabled?: boolean
  /** Receives the next scope (null to reset to all documents). */
  onChangeScope: (next: string[] | null) => void
}

export function ScopePopover({ docs, scopeIds, disabled, onChangeScope }: ScopePopoverProps): JSX.Element {
  const indexed = docs.filter((d) => d.status === 'indexed')
  const scoped = scopeIds ?? []
  const addable = indexed.filter((d) => !scoped.includes(d.id))

  function title(id: string): string {
    return docs.find((d) => d.id === id)?.title ?? 'Removed document'
  }

  const label =
    scopeIds == null
      ? indexed.length === 1
        ? 'Using your 1 document'
        : `Using all ${indexed.length} documents`
      : `Using ${scoped.length} ${scoped.length === 1 ? 'document' : 'documents'}`

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="footer-menu-btn" disabled={disabled}>
          <span aria-hidden="true">📄</span> {label} <span aria-hidden="true">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="start" sideOffset={6} aria-label="Documents to ask">
          {scopeIds == null ? (
            <p className="popover-line">
              Answers come from all your documents. Pick documents to ask only those:
            </p>
          ) : (
            <>
              <p className="popover-line">Answers come from these documents only:</p>
              <div className="popover-chips">
                {scoped.map((id) => (
                  <Chip
                    key={id}
                    title={title(id)}
                    onRemove={() => {
                      const next = scoped.filter((x) => x !== id)
                      onChangeScope(next.length > 0 ? next : null)
                    }}
                    removeLabel={`Stop asking ${title(id)}`}
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
              {scopeIds != null && <p className="popover-line popover-line-add">Add a document:</p>}
              <div className="popover-chips">
                {addable.map((d) => (
                  <Chip
                    key={d.id}
                    title={`Ask ${d.title} too`}
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
              Use all documents
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
