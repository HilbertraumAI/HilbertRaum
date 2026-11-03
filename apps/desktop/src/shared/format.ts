import type { UiLanguage } from './i18n'

/** Locale-aware one-decimal number (file sizes / RAM / GB) — grouping off so EN output
 *  stays byte-identical to the previous toFixed(1). One definition, shared by the
 *  Diagnostics card, the Chat starting panel and the main process's download copy so the
 *  same kind of value can never drift in locale/precision between screens. */
export function fmt1(n: number, lang: UiLanguage): string {
  return n.toLocaleString(lang, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false
  })
}

/** Bytes on a drive → "14.4 GB" (#768). Disk sizes in this app are DECIMAL GB (bytes / 1e9)
 *  with one decimal, like the manifests' `size_on_disk_gb` and the Diagnostics free space —
 *  so the download dialog and the main process's not-enough-space refusal print the same
 *  figure for the same file. Memory and VRAM figures are binary and do not use this. */
export function fmtDiskGb(bytes: number, lang: UiLanguage): string {
  return `${fmt1(bytes / 1e9, lang)} GB`
}

/** Bytes on a drive at the unit that fits: "512 B", "2.0 KB", "4.3 MB", "2.5 GB", decimal like
 *  `fmtDiskGb` (#768). One definition for the sizes of documents, saved images and the OCR
 *  language download, which each used to divide by 1024 under the same decimal-looking labels. */
export function fmtDiskSize(bytes: number, lang: UiLanguage): string {
  if (bytes < 1e3) return `${bytes} B`
  if (bytes < 1e6) return `${fmt1(bytes / 1e3, lang)} KB`
  if (bytes < 1e9) return `${fmt1(bytes / 1e6, lang)} MB`
  return fmtDiskGb(bytes, lang)
}
