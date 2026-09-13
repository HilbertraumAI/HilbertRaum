import { describe, it, expect } from 'vitest'
import { admitArticle } from '../../src/main/services/zim/admit'

// Phase 4 PR-A — route F's topic-conflict admission gate (`prototype.mjs` `admitArticle`),
// ported as a pure function (`docs/rag-design.md` §17 "Discovery port (Phase 4 PR-A)"). It
// never claims relevance — only that nothing here rules the article out.

describe('admitArticle — the ordinary case', () => {
  it('admits with no explicit topic conflict', () => {
    const result = admitArticle('Wie entsteht Treibhausgas in der Landwirtschaft?', 'Treibhausgas', 'Treibhausgas entsteht durch Methan.', 'fts')
    expect(result).toEqual({
      admitted: true,
      reason: 'no-explicit-topic-conflict; not-a-semantic-certificate',
      route: 'fts'
    })
  })

  it('carries the caller\'s route through unchanged, admitted or not', () => {
    expect(admitArticle('Was ist Photosynthese?', 'Photosynthese', 'lorem ipsum', 'head-noun').route).toBe('head-noun')
    expect(admitArticle('Was ist Photosynthese?', 'Photosynthese', 'lorem ipsum', 'title').route).toBe('title')
  })
})

describe('admitArticle — equipment-sense-for-biological-question', () => {
  it('refuses a diving-regulator article for a vertebrate-gill question', () => {
    const result = admitArticle(
      'Wie funktionieren die Kiemen bei Wirbeltieren?',
      'Atemregler',
      'Ein Atemregler ist Teil der Tauchausrüstung.',
      'fts'
    )
    expect(result).toEqual({ admitted: false, reason: 'equipment-sense-for-biological-question', route: 'fts' })
  })

  it('the English wording of the same conflict is caught too', () => {
    const result = admitArticle(
      'How do gills work in vertebrate animal species?',
      'Diving regulator',
      'A diving regulator is scuba equipment.',
      'fts'
    )
    expect(result.admitted).toBe(false)
    expect(result.reason).toBe('equipment-sense-for-biological-question')
  })

  it('does NOT fire without the biology signal in the QUESTION', () => {
    const result = admitArticle('Was ist ein Atemregler?', 'Atemregler', 'Ein Atemregler ist Tauchausrüstung.', 'fts')
    expect(result.admitted).toBe(true)
  })
})

describe('admitArticle — explicit-literary-topic-without-requested-biological-evidence', () => {
  it('refuses a novel/bestseller article for a biology question, absent explicit biological evidence', () => {
    const result = admitArticle(
      'Wie funktioniert das Herz eines Kraken?',
      'Der Krake (Roman)',
      'Ein Bestseller-Roman über einen Kraken.',
      'title'
    )
    expect(result).toEqual({
      admitted: false,
      reason: 'explicit-literary-topic-without-requested-biological-evidence',
      route: 'title'
    })
  })

  it('admits the SAME fiction-flavoured title when the lead carries explicit biological evidence', () => {
    const result = admitArticle(
      'Wie funktioniert das Herz eines Kraken?',
      'Der Krake (Roman)',
      'Ein Bestseller-Roman; der Kopffüsser hat ein Kiemenherz und ein Systemherz im Blutkreislauf.',
      'title'
    )
    expect(result.admitted).toBe(true)
  })

  it('does NOT fire without the biology signal in the QUESTION', () => {
    const result = admitArticle('Was ist ein guter Roman?', 'Bestseller-Liste', 'Eine Liste von Bestseller-Romanen.', 'fts')
    expect(result.admitted).toBe(true)
  })
})

describe('admitArticle — explicit-different-sense (topic-conflict pairs)', () => {
  it('planet/rotation vs mythology/goddess', () => {
    const result = admitArticle('Wie ist die Rotation des Planeten?', 'Eine Göttin der Mythologie', 'Kurzer Text ohne Überschneidung.', 'fts')
    expect(result).toEqual({ admitted: false, reason: 'explicit-different-sense', route: 'fts' })
  })

  it('vertebrate/animal-species vs diving equipment is refused — "wirbeltier"/"tierart" both also trip the earlier, broader equipment-sense gate, so that reason wins first', () => {
    // Both the pair's "wanted" side and the biology-signal regex share "wirbeltier"/"tierart"
    // verbatim, so a title matching the pair's "wrong" side (equipment) is caught by the
    // EARLIER, broader `equipment-sense-for-biological-question` gate before the pairs loop
    // ever runs — this pair combination can never surface as its OWN distinct reason against
    // an equipment-flavoured title. Faithfully ported from `prototype.mjs`, unchanged.
    const result = admitArticle('Welche Wirbeltierart ist das?', 'Tauchausrüstung', 'Kurzer Text ohne Überschneidung.', 'alias')
    expect(result.admitted).toBe(false)
    expect(result.reason).toBe('equipment-sense-for-biological-question')
  })

  it('human heart/body vs heraldry', () => {
    const result = admitArticle('Wie funktioniert der menschlichen Körper?', 'Heraldik', 'Kurzer Text ohne Überschneidung.', 'fts')
    expect(result).toEqual({ admitted: false, reason: 'explicit-different-sense', route: 'fts' })
  })

  it('a pair does NOT fire when the lead shares 2+ question terms with the lead text (lexical overlap escape)', () => {
    const result = admitArticle(
      'Wie ist die Rotation des Planeten?',
      'Eine Göttin der Mythologie',
      'Die Rotation des Planeten wird in der Mythologie ebenfalls thematisiert.',
      'fts'
    )
    expect(result.admitted).toBe(true)
  })

  it('a pair does NOT fire when the question itself does not match the "wanted" side', () => {
    const result = admitArticle('Was ist eine Göttin?', 'Mythologie', 'Text über Mythologie.', 'fts')
    expect(result.admitted).toBe(true)
  })
})

describe('admitArticle — case/whitespace/diacritic insensitivity (via the shared norm())', () => {
  it('matches the biology/equipment conflict regardless of case', () => {
    const result = admitArticle('WIE FUNKTIONIEREN DIE KIEMEN BEI WIRBELTIEREN?', 'ATEMREGLER', 'TAUCHAUSRÜSTUNG', 'fts')
    expect(result.admitted).toBe(false)
  })
})
