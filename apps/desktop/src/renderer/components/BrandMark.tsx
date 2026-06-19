// Brand mark + lockup (docs/brand-refresh-plan §4.2): the sealed rounded square holding the
// centre teal dot. The theme-correct artwork is chosen by a CSS pair toggle — BOTH images
// render and `[data-theme]` shows the right one — NOT by reading the theme in JS, so it works
// pre-unlock in the WorkspaceGate (which can't read settings; it follows the OS theme via the
// data-theme attribute set at startup). The dot is always teal; the square ink flips with the
// background. Assets are vendored same-origin under public/brand/ (offline CSP). The src is
// RELATIVE ("brand/…", not "/brand/…") so it resolves under both the dev http://localhost
// origin AND the production file:// load (loadFile); the renderer is a single index.html with
// no router, so a relative path always resolves next to it.

const MIN_SIZE = 16 // brand minimum; below this the kit says use raster favicons.

export interface BrandMarkProps {
  /** Rendered glyph size in px. Clamped to ≥16 (with a dev warning). */
  size?: number
  /** Accessible name when not decorative. */
  title?: string
  /** Decorative (default): hidden from the a11y tree. Set false to expose `title` as a label. */
  decorative?: boolean
  className?: string
}

/** The square-and-dot mark, theme-aware via CSS. Clear space (≥ the dot diameter) is baked
 *  into the wrapper padding. */
export function BrandMark({ size = 24, title, decorative = true, className }: BrandMarkProps) {
  if (size < MIN_SIZE && import.meta.env.DEV) {
    console.warn(`BrandMark: size ${size}px is below the ${MIN_SIZE}px minimum — clamped. Use a raster favicon below ${MIN_SIZE}px.`)
  }
  const px = Math.max(MIN_SIZE, Math.round(size))
  const pad = Math.max(2, Math.round(px * 0.16)) // clear space ≥ the inner-dot diameter
  const label = decorative ? undefined : (title ?? 'HilbertRaum')
  return (
    <span
      className={`brand-img${className ? ` ${className}` : ''}`}
      style={{ padding: pad }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <img className="brand-img-light" src="brand/mark-on-light.svg" alt="" aria-hidden width={px} height={px} draggable={false} />
      <img className="brand-img-dark" src="brand/mark-on-dark.svg" alt="" aria-hidden width={px} height={px} draggable={false} />
    </span>
  )
}

export interface BrandLockupProps {
  /** Rendered height in px (width scales with the artwork). Clamped to ≥16. */
  height?: number
  title?: string
  /** Labelled by default (it carries the wordmark). Set true to hide from the a11y tree. */
  decorative?: boolean
  className?: string
}

/** The horizontal lockup (mark + "HilbertRaum" wordmark), theme-aware via CSS. Use only where
 *  there is horizontal room (gate, about) — never the 100px rail. */
export function BrandLockup({ height = 28, title = 'HilbertRaum', decorative = false, className }: BrandLockupProps) {
  const h = Math.max(MIN_SIZE, Math.round(height))
  const label = decorative ? undefined : title
  return (
    <span
      className={`brand-lockup${className ? ` ${className}` : ''}`}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <img className="brand-img-light" src="brand/lockup-on-light.svg" alt="" aria-hidden height={h} draggable={false} />
      <img className="brand-img-dark" src="brand/lockup-on-dark.svg" alt="" aria-hidden height={h} draggable={false} />
    </span>
  )
}
