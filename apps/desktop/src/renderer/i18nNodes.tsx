import { Fragment, type ReactNode } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { I18n } from './i18n'

/**
 * A catalog pattern rendered with React nodes in its `{placeholders}` (#804): the join comes
 * from the language's own pattern while a placeholder still carries markup, as the bold role
 * name of a Performance row or the glyph before a review decision does (`t` returns a string,
 * so `t('common.labelValue', { label: <strong>…</strong> })` cannot). Each placeholder is
 * passed to `t` as itself, so `t` hands back the language's pattern unfilled, with the usual
 * fallback to English; the pattern is then split at its placeholders and each one replaced by
 * its node. A placeholder with no node stays literal, as `t` leaves a missing param.
 */
export function tNodes(
  t: I18n['t'],
  key: MessageKey,
  nodes: Readonly<Record<string, ReactNode>>
): JSX.Element {
  const unfilled = Object.fromEntries(Object.keys(nodes).map((name) => [name, `{${name}}`]))
  // With a capture group, `split` puts each placeholder's name at the odd indexes.
  const parts = t(key, unfilled).split(/\{(\w+)\}/)
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i % 2 === 0 ? part : Object.hasOwn(nodes, part) ? nodes[part] : `{${part}}`}
        </Fragment>
      ))}
    </>
  )
}
