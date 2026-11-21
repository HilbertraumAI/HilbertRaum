/** An https URL as an anchor: the normalised href plus the host (with any port) to show beside it. */
export interface HttpsLink {
  href: string
  host: string
}

/**
 * The link as rendered, or null when `url` must not become a clickable anchor (#236, #894): only an
 * `https:` URL does. The manifest validator already refuses a non-https `license_url`, but a stale
 * cached manifest or a hostile one that slipped past an older build must not become a clickable
 * `javascript:` or `http:` anchor behind a fixed "read the license" label. Stricter than the
 * chat-link gate, which also allows `http:`. Returning both from one parse keeps the anchor and the
 * host shown beside it from ever diverging.
 *
 * UI hygiene and defence in depth, NOT a security boundary: the real one is the opener in
 * `main/external-open.ts` (http and https only, behind a consent dialog).
 */
export function httpsLink(url: string | null | undefined): HttpsLink | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? { href: parsed.href, host: parsed.host } : null
  } catch {
    return null
  }
}
