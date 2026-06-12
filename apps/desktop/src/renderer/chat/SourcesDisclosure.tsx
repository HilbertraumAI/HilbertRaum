import { useState } from 'react'
import type { Citation } from '@shared/types'

// "▸ Sources (N)" (guidelines §3): citations stay attached to the answer as an
// inline disclosure, collapsed by default. Expanding lists one card per cited
// source — name + page/section + the cited snippet.

export function SourcesDisclosure({ citations }: { citations: Citation[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="sources">
      <button
        type="button"
        className="sources-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Sources ({citations.length})
      </button>
      {open && (
        <div className="sources-cards">
          {citations.map((c) => (
            <div key={c.label} className="source-card">
              <div className="source-card-head">
                <span className="cite-label">[{c.label}]</span>
                <span className="source-card-title">{c.sourceTitle}</span>
                {c.pageNumber != null ? (
                  <span className="source-card-where">Page {c.pageNumber}</span>
                ) : c.section ? (
                  <span className="source-card-where">{c.section}</span>
                ) : null}
              </div>
              {c.snippet && <div className="source-card-snippet">{c.snippet}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
