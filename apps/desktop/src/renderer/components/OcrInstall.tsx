import type { OcrInstallJob, OcrInstallStatus, OcrRefreshOutcome } from '@shared/types'
import type { UiLanguage } from '@shared/i18n'
import { Button } from './Button'
import { ConfirmDialog } from './Dialog'
import { Progress } from './Progress'
import { englishTranslator, type Translator } from './translator'

// The in-app OCR language-file install (#410): the facts-only confirmation dialog and the inline
// control (action → progress/cancel → failure/retry → outcome). Shared by the Documents rows and
// the AI Model screen's quiet row so both present the same facts and the same job. Every fact
// comes from main (`ocr:status`: code-side pins, the source host computed from the pinned URL);
// the licence is approved (Apache-2.0), so there is no acknowledgement checkbox — unlike the
// knowledge-pack tools' GPL consent.

/** What the two surfaces need from `useOcrInstall` (structurally its return value). */
export interface OcrInstallView {
  status: OcrInstallStatus | null
  downloadsEnabled: boolean
  blockedReason: string | null
  job: OcrInstallJob | null
  live: boolean
  error: string | null
  cancel: () => Promise<void>
}

/** Decimal separator follows the UI language (the Documents `formatSize` rule). */
function formatMb(bytes: number, lang: UiLanguage): string {
  const mb = bytes / (1024 * 1024)
  return `${mb.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })} MB`
}

const LANGUAGE_KEYS = {
  deu: 'ocr.install.lang.deu',
  eng: 'ocr.install.lang.eng'
} as const

/** A pinned language's display name; an unknown code shows as-is. */
function languageName(lang: string, t: Translator): string {
  const key = (LANGUAGE_KEYS as Record<string, (typeof LANGUAGE_KEYS)[keyof typeof LANGUAGE_KEYS]>)[lang]
  return key ? t(key) : lang
}

const OUTCOME_KEYS: Record<OcrRefreshOutcome, Parameters<Translator>[0]> = {
  activated: 'ocr.install.outcome.activated',
  restartRequired: 'ocr.install.outcome.restartRequired',
  unchanged: 'ocr.install.outcome.unchanged',
  // "Could not start in this build" — the #232 wording the Documents banner already uses.
  startFailed: 'docs.ocr.unavailableBanner'
}

/** The copy for a finished job's activation outcome (also the Documents toast). */
export function ocrInstallOutcomeText(outcome: OcrRefreshOutcome, t: Translator): string {
  return t(OUTCOME_KEYS[outcome])
}

export interface OcrInstallDialogProps {
  open: boolean
  status: OcrInstallStatus
  downloadsEnabled: boolean
  blockedReason: string | null
  onConfirm: () => void
  onCancel: () => void
  lang: UiLanguage
  t?: Translator
}

/** The facts-only confirmation (D4): languages, size, licence, source host, "checked before use". */
export function OcrInstallDialog({
  open,
  status,
  downloadsEnabled,
  blockedReason,
  onConfirm,
  onCancel,
  lang,
  t = englishTranslator
}: OcrInstallDialogProps): JSX.Element {
  const missing = status.languages.filter((l) => !l.installed)
  return (
    <ConfirmDialog
      open={open}
      title={t('ocr.install.confirm.title')}
      confirmLabel={t('ocr.install.confirm.start')}
      t={t}
      confirmDisabled={!downloadsEnabled || missing.length === 0}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>{t('ocr.install.confirm.explain')}</p>
      <dl className="kv">
        <dt>{t('ocr.install.confirm.languages')}</dt>
        <dd>{missing.map((l) => languageName(l.lang, t)).join(', ')}</dd>
        <dt>{t('models.confirm.size')}</dt>
        <dd>{formatMb(status.totalBytes, lang)}</dd>
        <dt>{t('models.confirm.license')}</dt>
        <dd>{status.license}</dd>
        <dt>{t('models.confirm.from')}</dt>
        <dd>
          <code>{status.sourceHost ?? '—'}</code>
        </dd>
      </dl>
      <p className="hint">{t('ocr.install.confirm.hint')}</p>
      {blockedReason && <p className="hint">{blockedReason}</p>}
    </ConfirmDialog>
  )
}

export interface OcrInstallControlProps {
  install: OcrInstallView
  /** Opens the confirmation dialog (the first download and every retry go through it). */
  onRequestInstall: () => void
  t?: Translator
}

/** Every pinned language is on the drive and matches its pin (nothing left to download). */
export function ocrFilesPresent(status: OcrInstallStatus | null | undefined): boolean {
  return status != null && status.languages.length > 0 && status.languages.every((l) => l.installed)
}

/**
 * The inline affordance: "Download OCR files" (disabled with the downloads-blocked reason while a
 * gate is closed) → progress + Cancel while the job downloads → the friendly failure + a retry →
 * the activation outcome once done. When every file is already on the drive but no job of this
 * visit put it there (copied by hand while the app ran), it says so and names the restart —
 * never a dialog with nothing to download.
 */
export function OcrInstallControl({
  install,
  onRequestInstall,
  t = englishTranslator
}: OcrInstallControlProps): JSX.Element | null {
  const { job, live, status } = install
  if (live && job) {
    const pct =
      job.status === 'downloading' && job.totalBytes > 0
        ? Math.min(100, Math.round((job.receivedBytes / job.totalBytes) * 100))
        : null
    const label =
      job.status === 'activating'
        ? t('ocr.install.activating')
        : job.status === 'verifying'
          ? t('ocr.install.verifying')
          : pct != null
            ? t('ocr.install.progress', { pct })
            : t('ocr.install.starting')
    return (
      <div className="ocr-install">
        <Progress
          label={label}
          value={pct != null ? job.receivedBytes : undefined}
          max={pct != null ? job.totalBytes : undefined}
        />
        {/* No Cancel once the files are in place: the activation is bounded and runs to its end. */}
        {job.status !== 'activating' && (
          <Button size="sm" onClick={() => void install.cancel()}>
            {t('ocr.install.cancel')}
          </Button>
        )}
      </div>
    )
  }
  if (job?.status === 'done' && job.outcome) {
    return (
      <div className="ocr-install">
        <p className="hint">{ocrInstallOutcomeText(job.outcome, t)}</p>
      </div>
    )
  }
  // Already on the drive (e.g. copied by hand mid-session): nothing to download — say so.
  if (ocrFilesPresent(status)) {
    return (
      <div className="ocr-install">
        <p className="hint">{t('ocr.install.alreadyPresent')}</p>
      </div>
    )
  }
  // No usable source list on this drive: the row's own copy names the offline path instead.
  if (status && !status.available) return null
  const failed = job?.status === 'failed'
  return (
    <div className="ocr-install">
      {failed && <p className="hint">{t('ocr.install.failed')}</p>}
      {failed && job?.error && <p className="hint">{job.error}</p>}
      {install.error && <p className="hint">{install.error}</p>}
      <Button
        size="sm"
        variant={failed ? 'secondary' : 'primary'}
        disabled={!install.downloadsEnabled || status == null}
        title={install.blockedReason ?? t('ocr.install.actionTitle')}
        onClick={onRequestInstall}
      >
        {failed ? t('ocr.install.retry') : t('ocr.install.action')}
      </Button>
      {install.blockedReason && <p className="hint">{install.blockedReason}</p>}
    </div>
  )
}
