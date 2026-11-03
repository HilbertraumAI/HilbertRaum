import { useEffect, useState } from 'react'
import type { EngineOptionalFamily } from '@shared/types'
import type { UiLanguage } from '@shared/i18n'
import { fmtPackSize } from '@shared/format'
import { ConfirmDialog } from './Dialog'
import { englishTranslator, type Translator } from './translator'

// Knowledge-pack tools install consent (#339 P8-2, the owner's 2026-09-06 ruling): the SAME
// shape as the model-download confirm (`ModelsScreen.tsx` confirmDialog, ~842-897) — a
// `<dl class="kv">` of Size / License / From, a hint line, and a REQUIRED acknowledgement
// checkbox (confirm disabled until ticked). Shared by BOTH entry points — the Knowledge-packs
// panel's notice and the Models screen's quiet row — so the two surfaces can never present
// different facts or a different bar for consent. Every fact comes from `family` (an
// `EngineOptionalFamily`, sourced from the pinned yaml / the code-side family spec, never from
// copy — see `docs/data-contracts.md` "#339 P8-2 additions").

export interface KnowledgePackToolsDialogProps {
  open: boolean
  family: EngineOptionalFamily
  downloadsEnabled: boolean
  /** Why downloads are blocked (the SAME gate/copy as ModelsScreen's engine banners — reused via
   *  `lib/downloadGate.ts` so the two can't diverge), or null when they are allowed. */
  blockedReason: string | null
  onConfirm: () => void
  onCancel: () => void
  /** Bound translate fn (i18n record §5 ⑤); English default, like every other shared component. */
  t?: Translator
  /** The UI language, for the size's decimal separator (like `OcrInstall`'s). */
  lang: UiLanguage
}

/** The one licence this dialog is scoped to links to the canonical GNU text. */
const GPL_3_0_URL = 'https://www.gnu.org/licenses/gpl-3.0.html'

/**
 * The licence link's href + host, or null when it must not render as a link (#236, mirroring
 * `ModelsScreen.tsx`'s `licenseLink`): only for the `GPL-3.0-or-later` licence this dialog knows
 * about, and only when the fixed URL parses as https.
 */
function licenseLink(license: string): { href: string; host: string } | null {
  if (license !== 'GPL-3.0-or-later') return null
  try {
    const parsed = new URL(GPL_3_0_URL)
    return parsed.protocol === 'https:' ? { href: parsed.href, host: parsed.host } : null
  } catch {
    return null
  }
}

export function KnowledgePackToolsDialog({
  open,
  family,
  downloadsEnabled,
  blockedReason,
  onConfirm,
  onCancel,
  t = englishTranslator,
  lang
}: KnowledgePackToolsDialogProps): JSX.Element {
  const [ack, setAck] = useState(false)
  // Reset the tick every time the dialog opens — a stale acknowledgement must never survive a
  // close + re-open (a new family, or the same one after a failed attempt).
  useEffect(() => {
    if (open) setAck(false)
  }, [open])
  const license = licenseLink(family.license)
  return (
    <ConfirmDialog
      open={open}
      title={t('packs.tools.confirm.title')}
      confirmLabel={t('packs.tools.confirm.start')}
      t={t}
      confirmDisabled={!ack || !downloadsEnabled}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>{t('packs.tools.confirm.explain', { version: family.version })}</p>
      <dl className="kv">
        <dt>{t('models.confirm.size')}</dt>
        <dd>
          {family.sizeBytes != null ? fmtPackSize(family.sizeBytes, lang) : t('packs.tools.sizeUnknown')}
        </dd>
        <dt>{t('models.confirm.license')}</dt>
        <dd>
          {family.license}
          {license && (
            <>
              {' — '}
              <a href={license.href} target="_blank" rel="noreferrer">
                {t('models.confirm.readLicense')}
              </a>
              {/* Mirrors ModelsScreen's confirm dialog (#236): the destination host is shown. */}
              {' ('}
              <code>{license.host}</code>
              {')'}
            </>
          )}
        </dd>
        <dt>{t('models.confirm.from')}</dt>
        <dd>
          <code>{family.url}</code>
        </dd>
      </dl>
      <p className="hint">{t('packs.tools.confirm.hint')}</p>
      <label className="toggle">
        <input
          type="checkbox"
          checked={ack}
          disabled={!downloadsEnabled}
          onChange={(e) => setAck(e.target.checked)}
        />
        <span>{t('packs.tools.confirm.ack', { license: family.license })}</span>
      </label>
      {blockedReason && <p className="hint">{blockedReason}</p>}
    </ConfirmDialog>
  )
}
