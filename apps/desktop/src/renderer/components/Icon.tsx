// Monochrome line icons (guidelines §7: calm, low-chroma UI). One consistent stroke
// style replaces the colorful OS emoji that used to sit in the nav rail and the home
// readiness rows — every glyph here inherits `currentColor`, so it tracks the theme and
// the surrounding text/accent color instead of injecting its own palette.
//
// Geometry is a 24-unit viewBox, 2px round stroke, no fill (Feather/Lucide idiom). Add a
// new glyph by extending PATHS; the `name` union keeps call sites honest. The icon is
// decorative (aria-hidden) unless given a `title`/aria-label, in which case it becomes a
// labelled role="img".
import type { ReactNode, SVGProps } from 'react'

export type IconName =
  | 'home'
  | 'chat'
  | 'file'
  | 'brain'
  | 'settings'
  | 'lock'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** Pixel size of the square glyph (defaults to 1em so it scales with font-size). */
  size?: number | string
  /** When set, the glyph carries an accessible name (role="img" + <title>). */
  title?: string
}

// Each entry is the inner SVG markup for its 24×24 viewBox.
const PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3.75 10.25 12 3.8l8.25 6.45" />
      <path d="M6 9.9v9.05c0 .85.7 1.55 1.55 1.55h2.75v-5.85h3.4v5.85h2.75c.85 0 1.55-.7 1.55-1.55V9.9" />
    </>
  ),

  chat: (
    <path d="M20.25 11.55c0 4.1-3.55 7.45-7.95 7.45a8.7 8.7 0 0 1-3.25-.62L4.25 20l1.35-4.35a7.1 7.1 0 0 1-1.25-4.1c0-4.1 3.55-7.45 7.95-7.45s7.95 3.35 7.95 7.45Z" />
  ),

  file: (
    <>
      <path d="M7.25 3.65h7.05L18.75 8.1v11.05c0 .85-.7 1.55-1.55 1.55H7.25c-.85 0-1.55-.7-1.55-1.55V5.2c0-.85.7-1.55 1.55-1.55Z" />
      <path d="M14.15 3.8v4.55h4.45" />
      <path d="M9 12.25h6" />
      <path d="M9 15.75h4.5" />
    </>
  ),

  // Two mirrored lobes read as a brain — the "AI model" mark.
  brain: (
    <>
      <path d="M11.65 5.05c-.8-1.45-2.95-1.45-3.75-.05-.25.45-.32.95-.22 1.42-1.65.25-2.95 1.7-2.95 3.45 0 .8.28 1.55.75 2.12-.75.6-1.2 1.52-1.2 2.55 0 1.8 1.45 3.25 3.25 3.25.35 1.4 1.62 2.45 3.12 2.45.48 0 .95-.1 1.35-.3" />
      <path d="M12.35 5.05c.8-1.45 2.95-1.45 3.75-.05.25.45.32.95.22 1.42 1.65.25 2.95 1.7 2.95 3.45 0 .8-.28 1.55-.75 2.12.75.6 1.2 1.52 1.2 2.55 0 1.8-1.45 3.25-3.25 3.25-.35 1.4-1.62 2.45-3.12 2.45-.48 0-.95-.1-1.35-.3" />
      <path d="M12 5.2v14.55" />
      <path d="M8.25 9.15c.9-.3 1.95.05 2.45.85" />
      <path d="M15.75 9.15c-.9-.3-1.95.05-2.45.85" />
    </>
  ),

  settings: (
    <>
      <circle cx="12" cy="12" r="3.15" />
      <path d="M19.15 13.5c.05-.48.05-.98 0-1.5l1.65-1.25-1.75-3.05-1.95.8a7.2 7.2 0 0 0-1.35-.78L15.45 5.6h-3.5l-.3 2.12c-.48.2-.93.45-1.35.78l-1.95-.8-1.75 3.05L8.25 12a7.4 7.4 0 0 0 0 1.5L6.6 14.75l1.75 3.05 1.95-.8c.42.33.87.58 1.35.78l.3 2.12h3.5l.3-2.12c.48-.2.93-.45 1.35-.78l1.95.8 1.75-3.05-1.65-1.25Z" />
    </>
  ),

  lock: (
    <>
      <rect x="5.1" y="10.35" width="13.8" height="10.15" rx="2.2" />
      <path d="M8.45 10.35V8.1a3.55 3.55 0 0 1 7.1 0v2.25" />
      <path d="M12 14.45v2.45" />
    </>
  )
}

/** Render a line icon by name. Decorative by default (aria-hidden); pass `title` or an
 *  aria-label to give it an accessible name. */
export function Icon({
  name,
  size = '1em',
  className,
  title,
  strokeWidth = 2,
  ...svgProps
}: IconProps): JSX.Element {
  const labelled =
    Boolean(title) ||
    Boolean(svgProps['aria-label']) ||
    Boolean(svgProps['aria-labelledby'])

  return (
    <svg
      {...svgProps}
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : 'true'}
      role={labelled ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  )
}
