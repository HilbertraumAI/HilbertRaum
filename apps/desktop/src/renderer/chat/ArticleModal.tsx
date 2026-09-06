import { useEffect, useId, useState } from 'react'
import { Modal, Spinner } from '../components'
import { useT } from '../i18n'

// Offline article viewer (knowledge packs, ZIM wave): the read-only view a citation's
// "Open article" affordance opens. All resolution is MAIN-SIDE (`packs:getArticle` — pack
// id + article path only) and the payload is plain sectioned TEXT extracted by the same
// converter retrieval uses — never raw archive HTML, never innerHTML, no loopback fetch
// from the renderer (the CSP forbids it; window-security.ts). SourceContextModal is the
// pattern (main-resolved read-only source view with honest states).

export interface ArticleTarget {
  packId: string
  articlePath: string
  /** The pack title for the header attribution line. */
  archiveTitle?: string | null
}

interface PackArticleView {
  title: string
  sections: Array<{ label: string | null; text: string }>
  /** True when the converter stopped short of the whole article (PR #294 review H1: the
   *  input cap, the scan-work budget or unterminated markup). The viewer says so rather
   *  than presenting a partial extraction as the complete article. */
  partial: boolean
}

export function ArticleModal({
  target,
  onClose
}: {
  /** Null = closed. */
  target: ArticleTarget | null
  onClose: () => void
}): JSX.Element {
  const { t } = useT()
  const sourceLineId = useId()
  const [article, setArticle] = useState<PackArticleView | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    if (!target) return
    let cancelled = false
    setPhase('loading')
    setArticle(null)
    void (async () => {
      try {
        const result = await window.api.getPackArticle(target.packId, target.articlePath)
        if (cancelled) return
        setArticle(result)
        setPhase(result ? 'ready' : 'failed')
      } catch {
        if (!cancelled) setPhase('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target])

  return (
    <Modal
      open={target != null}
      onClose={onClose}
      title={article?.title ?? t('chat.article.title')}
      // #301 P6 (plan §9.23 (b)1): the dialog's accessible NAME stays the article title; the
      // attribution line ("From <archive> – offline copy") becomes its DESCRIPTION, so a screen
      // reader announcing the dialog says which offline archive the text comes from instead of
      // only naming the article. Absent attribution ⇒ undefined, the prior behaviour.
      describedBy={target?.archiveTitle ? sourceLineId : undefined}
      width="wide"
      t={t}
    >
      <div className="pack-article">
        {target?.archiveTitle && (
          <p className="hint pack-article-source" id={sourceLineId}>
            {t('chat.article.from', { archive: target.archiveTitle })}
          </p>
        )}
        {phase === 'loading' && (
          <p className="hint" role="status">
            <Spinner /> {t('chat.article.loading')}
          </p>
        )}
        {phase === 'failed' && (
          <p className="hint">
            <span aria-hidden="true">⚠</span> {t('chat.article.unavailable')}
          </p>
        )}
        {phase === 'ready' && article?.partial && (
          <p className="hint pack-article-source">{t('chat.article.partial')}</p>
        )}
        {phase === 'ready' && article && (
          <div className="pack-article-body">
            {article.sections.map((s, i) => (
              <section key={`${s.label ?? 'intro'}-${i}`}>
                {s.label && <h3 className="pack-article-heading">{s.label}</h3>}
                {s.text
                  .split(/\n{2,}/)
                  .filter((p) => p.trim().length > 0)
                  .map((p, j) => (
                    <p key={j} className="pack-article-para">
                      {p}
                    </p>
                  ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
