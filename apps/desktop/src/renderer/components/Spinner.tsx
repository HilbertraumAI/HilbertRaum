// Small inline loading spinner (guidelines §6). Always `aria-hidden` (audit L11): it is
// purely decorative — every call site pairs it with adjacent status text that carries the
// meaning, so an assistive technology must not announce this empty animated element.

export function Spinner(): JSX.Element {
  return <span className="spinner" aria-hidden="true" />
}
