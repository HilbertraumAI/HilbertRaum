import type { EngineDownloadPreview, EngineDownloadPreviewItem } from '@shared/types'
import type { MessageKey, UiLanguage } from '@shared/i18n'
import { fmtDiskSize } from '@shared/format'
import { ConfirmDialog } from './Dialog'
import { englishTranslator, type Translator } from './translator'

// The AI engine's install / update / reinstall confirmation (#843). PRIVACY.md item 3 promises a
// dialog with the size, licence and source address of "that specific download"; the engine actions
// used to start the job on the click. Every fact here comes from main's preview (`engine:plan` →
// `planEngineSteps`, the SAME function `EngineDownloadManager.start()` runs), so the dialog lists the
// archives the job plans to fetch at the moment it opens: the `cpu/` safety net an update or a repair
// adds, a repair's refused builds. Confirm sends the request unchanged and `start()` plans again (and
// checks main's gates again), so what changed on the drive in between decides. The licences are pre-reviewed and code-side (`SIDECAR_FAMILY_SPECS`), so
// there is no acknowledgement checkbox (the OCR pattern, not the knowledge-pack tools' GPL consent).
// The same `ConfirmDialog` + `<dl class="kv">` shape as the model dialog: Version / Size / From /
// License per archive, the full URL in <code>, the licence link's host beside it (#236).

export interface EngineConfirmDialogProps {
  open: boolean
  preview: EngineDownloadPreview
  /** The title of the surface the user clicked (its banner or notice), so the dialog continues it. */
  title: string
  /** The action's own label (Install AI engine, Update, Install the AI engine again). */
  confirmLabel: string
  downloadsEnabled: boolean
  /** Why downloads are blocked (the shared `computeDownloadGate` copy), or null. */
  blockedReason: string | null
  onConfirm: () => void
  onCancel: () => void
  lang: UiLanguage
  t?: Translator
}

const FAMILY_NAMES: Record<string, MessageKey> = {
  llama_cpp: 'models.engineConfirm.chatEngine',
  whisper_cpp: 'models.engineConfirm.voiceEngine'
}

/** The licence link's href + host, or null unless it parses as https (#236, `licenseLink` in ModelsScreen). */
function licenseLink(url: string | null): { href: string; host: string } | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? { href: parsed.href, host: parsed.host } : null
  } catch {
    return null
  }
}

function itemTitle(item: EngineDownloadPreviewItem, t: Translator): string {
  const key = FAMILY_NAMES[item.family]
  const name = key ? t(key) : item.family
  return item.safetyNet ? `${name} · ${t('models.engineConfirm.safetyNet')}` : name
}

export function EngineConfirmDialog({
  open,
  preview,
  title,
  confirmLabel,
  downloadsEnabled,
  blockedReason,
  onConfirm,
  onCancel,
  lang,
  t = englishTranslator
}: EngineConfirmDialogProps): JSX.Element {
  const size = (bytes: number | null): string => (bytes != null ? fmtDiskSize(bytes, lang) : t('packs.tools.sizeUnknown'))
  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={confirmLabel}
      t={t}
      confirmDisabled={!downloadsEnabled || preview.items.length === 0}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {preview.items.map((item) => {
        const link = licenseLink(item.licenseUrl)
        const from = preview.kind === 'update' && item.installed && item.installed !== item.version ? `${item.installed} → ` : ''
        return (
          <div key={item.url}>
            <p>
              <strong>{itemTitle(item, t)}</strong>
            </p>
            <dl className="kv">
              <dt>{t('models.engineConfirm.version')}</dt>
              <dd>{`${from}${item.version} (${item.backend})`}</dd>
              <dt>{t('models.confirm.size')}</dt>
              <dd>{size(item.sizeBytes)}</dd>
              <dt>{t('models.confirm.license')}</dt>
              <dd>
                {item.bundledLicense
                  ? t('models.engineConfirm.licenseIncludes', { license: item.license, bundled: item.bundledLicense })
                  : item.license}
                {link && (
                  <div>
                    <a href={link.href} target="_blank" rel="noreferrer">
                      {t('models.confirm.readLicense')}
                    </a>
                    {' ('}
                    <code>{link.host}</code>
                    {')'}
                  </div>
                )}
              </dd>
              <dt>{t('models.confirm.from')}</dt>
              <dd>
                <code>{item.url}</code>
              </dd>
            </dl>
          </div>
        )
      })}
      {preview.items.length > 1 && (
        <dl className="kv">
          <dt>{t('models.engineConfirm.total')}</dt>
          <dd>{size(preview.totalBytes)}</dd>
        </dl>
      )}
      <p className="hint">{t('models.engineConfirm.hint')}</p>
      {/* Only the AI engine's update stops the chat model for the swap; a voice-engine-only update
          pauses the transcriber alone (registerEngineIpc `pauseEngineUsers`). */}
      {preview.kind === 'update' && preview.items.some((i) => i.family === 'llama_cpp') && (
        <p className="hint">{t('models.engineConfirm.updateNote')}</p>
      )}
      {blockedReason && <p className="hint">{blockedReason}</p>}
    </ConfirmDialog>
  )
}
