import { useEffect, useId, useRef, useState } from 'react'
import type { PackArticleSaveResult } from '@shared/types'
import { Button, Modal, Spinner } from '../components'
import { friendlyIpcError } from '../lib/errors'
import { useT } from '../i18n'

// Offline article viewer (knowledge packs, ZIM wave): the read-only view a citation's
// "Open article" affordance opens. All resolution is MAIN-SIDE (`packs:getArticle` — pack
// id + article path only) and the payload is plain sectioned TEXT extracted by the same
// converter retrieval uses — never raw archive HTML, never innerHTML, no loopback fetch
// from the renderer (the CSP forbids it; window-security.ts). SourceContextModal is the
// pattern (main-resolved read-only source view with honest states).
//
// #340 Tier-2 (D-Z21, the owner's ruling C3 (a)): the viewer is ALSO where an article becomes
// a document — "Save to my documents" sends the same two ids over `packs:saveArticle`; the main
// side re-reads the text and runs it through the normal import path. The button carries the
// article title in its accessible name (design-guidelines §11.15 item 3) and reports its own
// state inline: saving, saved (with the filed title), already saved, or the friendly failure.

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

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; result: PackArticleSaveResult }
  | { phase: 'failed'; message: string }

export function ArticleModal({
  target,
  onClose,
  canSave = true
}: {
  /** Null = closed. */
  target: ArticleTarget | null
  onClose: () => void
  /** False on read-only surfaces (an evidence review): the viewer shows no save action. */
  canSave?: boolean
}): JSX.Element {
  const { t } = useT()
  const sourceLineId = useId()
  const [article, setArticle] = useState<PackArticleView | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [save, setSave] = useState<SaveState>({ phase: 'idle' })
  // Bumped whenever the viewer moves to another article (or closes): a save that resolves for a
  // PREVIOUS article must not announce itself on the current one.
  const saveGeneration = useRef(0)

  useEffect(() => {
    saveGeneration.current += 1
    if (!target) return
    let cancelled = false
    setPhase('loading')
    setArticle(null)
    setSave({ phase: 'idle' })
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

  async function onSave(): Promise<void> {
    if (!target || save.phase === 'saving') return
    const generation = saveGeneration.current
    setSave({ phase: 'saving' })
    try {
      const result = await window.api.savePackArticle(target.packId, target.articlePath)
      if (generation === saveGeneration.current) setSave({ phase: 'saved', result })
    } catch (e) {
      if (generation === saveGeneration.current) setSave({ phase: 'failed', message: friendlyIpcError(e) })
    }
  }

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
        {phase === 'ready' && article && canSave && (
          <div className="pack-article-save">
            {save.phase === 'saved' ? (
              <p className="hint" role="status">
                {save.result.alreadySaved
                  ? t('chat.article.alreadySaved', { title: save.result.title })
                  : t('chat.article.saved', { title: save.result.title })}
              </p>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={save.phase === 'saving'}
                  aria-label={t('chat.article.saveAria', { title: article.title })}
                  onClick={() => void onSave()}
                >
                  {save.phase === 'saving' ? t('chat.article.saving') : t('chat.article.save')}
                </Button>
                {save.phase === 'saving' && (
                  <span className="hint" role="status">
                    <Spinner />
                  </span>
                )}
                {save.phase === 'failed' && (
                  <p className="hint">
                    <span aria-hidden="true">⚠</span> {save.message}
                  </p>
                )}
              </>
            )}
          </div>
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
