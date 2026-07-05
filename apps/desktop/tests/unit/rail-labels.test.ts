import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t, type MessageKey } from '../../src/shared/i18n'

// Task A (design-guidelines §12.1 #1): the compact app rail must never hyphenate a label
// mid-word ("Docu-ments" / "Doku-mente" / "Einstel-lungen"). The fix is two-part: (1) the
// i18n nav labels carry NO soft/auto hyphen, and (2) `.nav-label` forbids every break
// (`hyphens: none`) while the `.app-shell` grid column is widened so the longest single-word
// label in either locale fits on one line at the 12px text floor.

const NAV_KEYS: MessageKey[] = ['nav.home', 'nav.chat', 'nav.documents', 'nav.translate', 'nav.images', 'nav.models', 'nav.skills', 'nav.settings']
const STYLES = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8')

describe('rail nav labels — no mid-word hyphenation (Task A)', () => {
  it('carry no soft hyphen (U+00AD) or other invisible break in EITHER locale', () => {
    for (const lang of ['en', 'de'] as const) {
      for (const key of NAV_KEYS) {
        const label = t(lang, key)
        expect(label, `${lang}/${key} has a soft hyphen`).not.toMatch(/­/)
        expect(label, `${lang}/${key} has a zero-width break`).not.toMatch(/[​­]/)
      }
    }
  })

  it('the longest single-word label is German "Einstellungen" (what the rail width is sized to)', () => {
    // It has no space/hyphen to wrap at, so it must fit on one line — the grid width is set for it.
    expect(t('de', 'nav.settings')).toBe('Einstellungen')
    // Labels that DO contain a space / hyphen may wrap cleanly to two lines (never a concern).
    expect(t('en', 'nav.models')).toBe('AI Model')
    expect(t('de', 'nav.models')).toBe('KI-Modell')
  })

  it('the new Images rail label is a short single word that fits within the sized width', () => {
    // image-understanding §6: "Images"/"Bilder" are short, so the 6th destination fits the
    // existing rail (sized for the longer "Einstellungen") with no reflow.
    expect(t('en', 'nav.images')).toBe('Images')
    expect(t('de', 'nav.images')).toBe('Bilder')
    expect(t('en', 'nav.images').length).toBeLessThan('Einstellungen'.length)
    expect(t('de', 'nav.images').length).toBeLessThan('Einstellungen'.length)
  })

  it('the new Translate rail label is a single word that fits within the sized width', () => {
    // TranslateGemma plan §2 D6: "Translate"/"Übersetzen" are single words shorter than
    // "Einstellungen" (what the rail width is sized for), so the 7th primary fits with no reflow.
    expect(t('en', 'nav.translate')).toBe('Translate')
    expect(t('de', 'nav.translate')).toBe('Übersetzen')
    expect(t('en', 'nav.translate').length).toBeLessThan('Einstellungen'.length)
    expect(t('de', 'nav.translate').length).toBeLessThan('Einstellungen'.length)
  })
})

describe('rail CSS — widened, non-breaking (Task A)', () => {
  it('.nav-label forbids hyphenation and mid-word breaks', () => {
    const block = STYLES.match(/\.nav-label\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block).toMatch(/hyphens:\s*none/)
    expect(block).toMatch(/overflow-wrap:\s*normal/)
    expect(block).toMatch(/word-break:\s*normal/)
    // The stale soft-hyphen approach (`hyphens: manual`) is gone.
    expect(block).not.toMatch(/hyphens:\s*manual/)
  })

  it('the .app-shell rail column was widened past 80px to fit the 12px label (but stays compact)', () => {
    const block = STYLES.match(/\.app-shell\s*\{[^}]*\}/)?.[0] ?? ''
    const px = Number(block.match(/grid-template-columns:\s*(\d+)px/)?.[1] ?? '0')
    expect(px).toBeGreaterThan(80) // widened
    expect(px).toBeLessThanOrEqual(110) // still a slim rail, nowhere near the old ~220px panel
  })

  it('the rail label sits on the 12px floor, not below it (§4.4)', () => {
    const block = STYLES.match(/\.nav-item,\s*\.lock-btn\s*\{[^}]*\}/)?.[0] ?? ''
    const px = Number(block.match(/font-size:\s*(\d+)px/)?.[1] ?? '0')
    expect(px).toBeGreaterThanOrEqual(12)
  })
})
