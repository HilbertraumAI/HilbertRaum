import { Icon } from './Icon'

// A generic folder browser: folders rendered as a responsive grid of cards (a folder glyph in a
// box + a name label underneath), the file-manager idiom. Presentational and reuse-shaped — the
// chat sidebar's folder view and the Documents screen both drive it; `onOpen` decides what
// "opening" a folder means in each place (drill into its chats, or filter the file list).

export interface FolderCard {
  id: string
  name: string
  /** Optional small count shown on the card (e.g. chats or files in the folder). */
  count?: number
}

export interface FolderGridProps {
  folders: FolderCard[]
  onOpen: (id: string) => void
  /** Accessible name for the grid group. */
  ariaLabel: string
  /** Marks one card as current (e.g. the open folder). */
  activeId?: string | null
  /** When set, a trailing "+ New folder" card is rendered. */
  onNew?: () => void
  newLabel?: string
}

export function FolderGrid({
  folders,
  onOpen,
  ariaLabel,
  activeId,
  onNew,
  newLabel
}: FolderGridProps): JSX.Element {
  return (
    <div className="folder-grid" role="group" aria-label={ariaLabel}>
      {folders.map((f) => (
        <button
          key={f.id}
          type="button"
          className={`folder-card ${f.id === activeId ? 'active' : ''}`}
          aria-current={f.id === activeId ? 'true' : undefined}
          title={f.name}
          onClick={() => onOpen(f.id)}
        >
          <span className="folder-card-box">
            <Icon name="folder" className="folder-card-icon" />
            {f.count != null && <span className="folder-card-count">{f.count}</span>}
          </span>
          <span className="folder-card-label">{f.name}</span>
        </button>
      ))}
      {onNew && (
        <button type="button" className="folder-card folder-card-new" onClick={onNew} title={newLabel}>
          <span className="folder-card-box" aria-hidden="true">
            +
          </span>
          <span className="folder-card-label">{newLabel}</span>
        </button>
      )}
    </div>
  )
}
