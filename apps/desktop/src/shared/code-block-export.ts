// #286 — saving one fenced code block from an assistant reply as a file. This module is the
// PURE, shared part: the fence info string → file extension map. It runs in MAIN (the save
// dialog's default name + filter) and is unit-tested on its own; the renderer never derives a
// filename from it (it only forwards the raw info string over IPC).
//
// SECURITY (D2/D6, owner decisions): the fence info string is MODEL OUTPUT — i.e. content. It
// is never used as-is for a filename, a dialog filter or an audit row. Only the first
// whitespace-separated token, lower-cased and stripped to [a-z0-9+#.-], is looked up in the FIXED
// allowlist below; anything unknown (including an empty string) falls back to `txt`. The result
// is therefore a closed set of extensions, which is why the audit event may carry it.

/** The fixed fence-language → extension allowlist (D6). Keys are the normalized info tokens. */
const EXTENSION_BY_LANGUAGE: Readonly<Record<string, string>> = {
  html: 'html',
  js: 'js',
  javascript: 'js',
  ts: 'ts',
  typescript: 'ts',
  py: 'py',
  python: 'py',
  csv: 'csv',
  json: 'json',
  md: 'md',
  markdown: 'md',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  css: 'css',
  xml: 'xml',
  yaml: 'yml',
  yml: 'yml',
  sql: 'sql',
  ps1: 'ps1',
  powershell: 'ps1',
  bat: 'bat',
  cmd: 'bat',
  svg: 'svg',
  toml: 'toml',
  txt: 'txt',
  text: 'txt'
}

/** The fallback for an unknown or empty language. */
export const DEFAULT_CODE_BLOCK_EXTENSION = 'txt'

/**
 * Normalize a fence info string to its language token: the first whitespace-separated token
 * (CommonMark's "info string" may carry attributes such as `html title="x"`), lower-cased, with
 * everything outside `[a-z0-9+#.-]` removed. Returns '' for an empty/blank info string.
 */
export function codeBlockLanguageToken(info: string): string {
  const first = info.trim().split(/\s+/, 1)[0] ?? ''
  return first.toLowerCase().replace(/[^a-z0-9+#.-]/g, '')
}

/**
 * The file extension (without the dot) for a fence info string — one of the allowlist values,
 * or `txt` for anything else. Pure; safe to call with arbitrary model output.
 */
export function codeBlockExtension(info: string): string {
  const token = codeBlockLanguageToken(info)
  return (Object.hasOwn(EXTENSION_BY_LANGUAGE, token) && EXTENSION_BY_LANGUAGE[token]) || DEFAULT_CODE_BLOCK_EXTENSION
}

/** The fixed default file name offered in the save dialog — never derived from content. */
export function codeBlockDefaultFileName(info: string): string {
  return `code.${codeBlockExtension(info)}`
}
