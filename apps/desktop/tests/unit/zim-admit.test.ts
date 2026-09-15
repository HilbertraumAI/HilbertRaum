import { describe, it, expect } from 'vitest'
import { admitArticle } from '../../src/main/services/zim/admit'

// Phase 4 PR-A — route F's topic-conflict admission gate (`prototype.mjs` `admitArticle`),
// ported as a pure function (`docs/rag-design.md` §17 "Discovery port (Phase 4 PR-A)"). It
// never claims relevance — only that nothing here rules the article out.
//
// TWO WINDOWS (F3, review 2026-09-14): `admitArticle` takes a narrow LEAD (route F's own first
// two prose segments — feeds title/fiction/the topic-conflict pairs) and a WIDE body text
// (route F's whole article — feeds `explicitBiology` only). Most fixtures below use the same
// short text for both windows (the distinction does not matter to them); the two cases that
// specifically exercise the two-window split are under "the two windows (F3)".

describe('admitArticle — the ordinary case', () => {
  it('admits with no explicit topic conflict', () => {
    const result = admitArticle(
      'Wie entsteht Treibhausgas in der Landwirtschaft?',
      'Treibhausgas',
      'Treibhausgas entsteht durch Methan.',
      'Treibhausgas entsteht durch Methan.',
      'fts'
    )
    expect(result).toEqual({
      admitted: true,
      reason: 'no-explicit-topic-conflict; not-a-semantic-certificate',
      route: 'fts'
    })
  })

  it('carries the caller\'s route through unchanged, admitted or not', () => {
    expect(
      admitArticle('Was ist Photosynthese?', 'Photosynthese', 'lorem ipsum', 'lorem ipsum', 'head-noun').route
    ).toBe('head-noun')
    expect(admitArticle('Was ist Photosynthese?', 'Photosynthese', 'lorem ipsum', 'lorem ipsum', 'title').route).toBe(
      'title'
    )
  })
})

describe('admitArticle — equipment-sense-for-biological-question', () => {
  it('refuses a diving-regulator article for a vertebrate-gill question', () => {
    const result = admitArticle(
      'Wie funktionieren die Kiemen bei Wirbeltieren?',
      'Atemregler',
      'Ein Atemregler ist Teil der Tauchausrüstung.',
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
      'A diving regulator is scuba equipment.',
      'fts'
    )
    expect(result.admitted).toBe(false)
    expect(result.reason).toBe('equipment-sense-for-biological-question')
  })

  it('does NOT fire without the biology signal in the QUESTION', () => {
    const result = admitArticle(
      'Was ist ein Atemregler?',
      'Atemregler',
      'Ein Atemregler ist Tauchausrüstung.',
      'Ein Atemregler ist Tauchausrüstung.',
      'fts'
    )
    expect(result.admitted).toBe(true)
  })
})

describe('admitArticle — explicit-literary-topic-without-requested-biological-evidence', () => {
  it('refuses a novel/bestseller article for a biology question, absent explicit biological evidence', () => {
    const result = admitArticle(
      'Wie funktioniert das Herz eines Kraken?',
      'Der Krake (Roman)',
      'Ein Bestseller-Roman über einen Kraken.',
      'Ein Bestseller-Roman über einen Kraken.',
      'title'
    )
    expect(result).toEqual({
      admitted: false,
      reason: 'explicit-literary-topic-without-requested-biological-evidence',
      route: 'title'
    })
  })

  it('admits the SAME fiction-flavoured title when the LEAD carries explicit biological evidence', () => {
    const text = 'Ein Bestseller-Roman; der Kopffüsser hat ein Kiemenherz und ein Systemherz im Blutkreislauf.'
    const result = admitArticle('Wie funktioniert das Herz eines Kraken?', 'Der Krake (Roman)', text, text, 'title')
    expect(result.admitted).toBe(true)
  })

  it('does NOT fire without the biology signal in the QUESTION', () => {
    const result = admitArticle(
      'Was ist ein guter Roman?',
      'Bestseller-Liste',
      'Eine Liste von Bestseller-Romanen.',
      'Eine Liste von Bestseller-Romanen.',
      'fts'
    )
    expect(result.admitted).toBe(true)
  })

  describe('the two windows (F3) — the trap sees only the LEAD, the biology escape hatch sees the WIDE text', () => {
    // Both cases below reproduce the FIRST Opus review's demonstration (2026-09-14): a real
    // cephalopod article with a "Populärkultur"/culture section — the exact shape
    // `explicitBiology` exists to rescue. An earlier port fed both predicates from one bounded
    // window (the arm's first ~20 segments / ~4,000 chars): wider than route F's two-prose-block
    // lead for the trap, and narrower than route F's whole-article scan for the escape hatch —
    // so both cases below demonstrably lost the gold article on that one-window port.
    //
    // NEITHER case below is the first review's own "CASE A" (biological evidence absent
    // EVERYWHERE, so the article is rescued only if the trap itself never fires) — both hand
    // `admitArticle` biological evidence somewhere in `wide` and so exercise the ESCAPE HATCH
    // mechanism (unit-level, hand-fed windows), never the trap's own window in isolation. The
    // SECOND Opus review (N1) found that the true "no evidence anywhere" shape still disagrees
    // with route F on the real, arm-built windows (`arm.ts`'s `leadText` is `segments.slice(0,
    // 2)`, section- not paragraph-granular — see `admit.ts`'s own header) — pending the owner's
    // ruling; neither this file's unit fixtures nor the arm-level end-to-end test below exercise
    // that exact shape.
    const QUESTION = 'Wie funktioniert das Herz eines Oktopus?'
    const TITLE = 'Kraken'

    it('escape-hatch window 1 — explicit biological evidence sits OUTSIDE the two-prose-block lead but well inside a ~20-segment/4,000-char window: admitted (route F reads the WHOLE article for this predicate; NOT the first review\'s "no evidence anywhere" CASE A — see the describe-block header)', () => {
      const lead =
        'Die Kraken sind eine Ordnung der Kopffuesser. Sie besitzen acht Arme und leben in allen Weltmeeren.'
      const wide =
        lead +
        ' Kraken in der Kultur. Der Spielfilm um einen Riesenkraken praegte das Bild des Tieres. ' +
        'Ein Roman von Jules Verne machte ihn beruehmt. Der Blutkreislauf wird von einem Systemherz ' +
        'und zwei Kiemenherzen angetrieben.'
      const result = admitArticle(QUESTION, TITLE, lead, wide, 'fts')
      expect(result.admitted).toBe(true)
    })

    it('escape-hatch window 2 — explicit biological evidence sits FAR past any bounded window (block 27+): still admitted, because the escape hatch is fed the WIDE (whole-article) text with no cap', () => {
      const lead =
        'Die Kraken sind eine Ordnung der Kopffuesser. Sie besitzen acht Arme und leben in allen Weltmeeren.'
      const farAway =
        'Kraken in der Kultur. Der Spielfilm um einen Riesenkraken praegte das Bild des Tieres. ' +
        'Ein Roman von Jules Verne machte ihn beruehmt. '
      // Push the biological evidence far past a ~4,000-char bound with filler prose, then place it.
      const filler = 'Ein neutraler Fuellsatz ohne Bezug zum Thema. '.repeat(120)
      const wide = lead + ' ' + farAway + filler + 'Der Blutkreislauf wird von einem Systemherz und zwei Kiemenherzen angetrieben.'
      expect(wide.length).toBeGreaterThan(4_000)
      const result = admitArticle(QUESTION, TITLE, lead, wide, 'fts')
      expect(result.admitted).toBe(true)
    })

    it('the trap itself still uses only the LEAD: a fiction marker that appears ONLY past the lead never trips it — admitted, even with no biological evidence anywhere', () => {
      // If `fiction` were (incorrectly) computed from the WIDE text too, "Spielfilm" here would
      // trip the trap with no `explicitBiology` anywhere to rescue it, and the article would be
      // refused. Scoped correctly (lead-only, exactly like route F), `fiction` is false — the
      // trap never fires — so the article is admitted regardless.
      const lead =
        'Die Kraken sind eine Ordnung der Kopffuesser. Sie besitzen acht Arme und leben in allen Weltmeeren.'
      const wide = lead + ' Kraken in der Kultur. Der Spielfilm um einen Riesenkraken praegte das Bild des Tieres.'
      const result = admitArticle(QUESTION, TITLE, lead, wide, 'fts')
      expect(result).toEqual({
        admitted: true,
        reason: 'no-explicit-topic-conflict; not-a-semantic-certificate',
        route: 'fts'
      })
    })
  })

  describe('the true CASE A (N1, second review, resolved by step 4-3) — no biological evidence anywhere: a SHORTER lead rescues what a LONGER one traps', () => {
    // The first review's CASE A verbatim: `segments[0]` (the intro) and `segments[1]` (the
    // "Kraken in der Kultur" section) as the real arm-level converter emits them (see
    // `zim-arm.test.ts`'s end-to-end fixture for the same texts driven through real HTML).
    // Unlike the escape-hatch fixtures above, `wide` never carries `explicitBiology` evidence
    // — there is none anywhere in this article, so the trap's own window is what decides.
    const QUESTION = 'Wie funktioniert das Herz eines Oktopus?'
    const TITLE = 'Kraken'
    const segment0 = 'Die Kraken sind eine Ordnung der Kopffuesser. Sie besitzen acht Arme und leben in allen Weltmeeren.'
    const segment1 =
      'Kraken in der Kultur. Der Spielfilm um einen Riesenkraken praegte das Bild des Tieres. ' +
      'Ein Roman von Jules Verne machte ihn beruehmt.'
    const wide = `${segment0} ${segment1}` // unchanged by N1 — only the LEAD narrows

    it('lead = segments[0] only (the narrowed, post-N1 window): admitted — the fiction marker sits outside the lead', () => {
      const result = admitArticle(QUESTION, TITLE, segment0, wide, 'fts')
      expect(result).toEqual({
        admitted: true,
        reason: 'no-explicit-topic-conflict; not-a-semantic-certificate',
        route: 'fts'
      })
    })

    it('lead = segments[0] + segments[1] (the pre-N1 window, `dd85f361`): refused — the trap sees the fiction marker and nothing rescues it', () => {
      const result = admitArticle(QUESTION, TITLE, `${segment0} ${segment1}`, wide, 'fts')
      expect(result).toEqual({
        admitted: false,
        reason: 'explicit-literary-topic-without-requested-biological-evidence',
        route: 'fts'
      })
    })
  })
})

describe('admitArticle — explicit-different-sense (topic-conflict pairs)', () => {
  it('planet/rotation vs mythology/goddess', () => {
    const result = admitArticle(
      'Wie ist die Rotation des Planeten?',
      'Eine Göttin der Mythologie',
      'Kurzer Text ohne Überschneidung.',
      'Kurzer Text ohne Überschneidung.',
      'fts'
    )
    expect(result).toEqual({ admitted: false, reason: 'explicit-different-sense', route: 'fts' })
  })

  it('vertebrate/animal-species vs diving equipment is refused — "wirbeltier"/"tierart" both also trip the earlier, broader equipment-sense gate, so that reason wins first', () => {
    // Both the pair's "wanted" side and the biology-signal regex share "wirbeltier"/"tierart"
    // verbatim, so a title matching the pair's "wrong" side (equipment) is caught by the
    // EARLIER, broader `equipment-sense-for-biological-question` gate before the pairs loop
    // ever runs — this pair combination can never surface as its OWN distinct reason against
    // an equipment-flavoured title. Faithfully ported from `prototype.mjs`, unchanged.
    const result = admitArticle(
      'Welche Wirbeltierart ist das?',
      'Tauchausrüstung',
      'Kurzer Text ohne Überschneidung.',
      'Kurzer Text ohne Überschneidung.',
      'alias'
    )
    expect(result.admitted).toBe(false)
    expect(result.reason).toBe('equipment-sense-for-biological-question')
  })

  it('human heart/body vs heraldry', () => {
    const result = admitArticle(
      'Wie funktioniert der menschlichen Körper?',
      'Heraldik',
      'Kurzer Text ohne Überschneidung.',
      'Kurzer Text ohne Überschneidung.',
      'fts'
    )
    expect(result).toEqual({ admitted: false, reason: 'explicit-different-sense', route: 'fts' })
  })

  it('a pair does NOT fire when the lead shares 2+ question terms with the lead text (lexical overlap escape)', () => {
    const text = 'Die Rotation des Planeten wird in der Mythologie ebenfalls thematisiert.'
    const result = admitArticle('Wie ist die Rotation des Planeten?', 'Eine Göttin der Mythologie', text, text, 'fts')
    expect(result.admitted).toBe(true)
  })

  it('a pair does NOT fire when the question itself does not match the "wanted" side', () => {
    const result = admitArticle(
      'Was ist eine Göttin?',
      'Mythologie',
      'Text über Mythologie.',
      'Text über Mythologie.',
      'fts'
    )
    expect(result.admitted).toBe(true)
  })

  // N1 amendment (i), step 4-3: the second review's monotonicity assumption about a shorter
  // lead is wrong in general. The `explicit-different-sense` pairs read `lex(lead,
  // tokens(q)) < 2` (the lexical-overlap escape): a SHORTER lead can leave FEWER question
  // tokens in view, so it can turn an admitted article into a refused one — the reverse of
  // the CASE A direction above. Invented text throughout (never a gold title).
  it('a shorter lead can also REFUSE: pair 1 (planet/rotation vs mythology) — the two-segment lead shares 2+ question tokens (admitted), the intro alone shares fewer than 2 (refused)', () => {
    const question = 'Wie ist die Rotation des Planeten?' // tokens(q) = {rotation, planeten}
    const title = 'Mythologie der Antike' // "wanted" side never tested here; "wrong" side: mytholog
    const introOnly = 'Die Mythologie beschreibt Goetter und Sagen verschiedener Kulturen.'
    const section = 'Mythologische Rotation und Planeten in alten Erzaehlungen.'
    const twoSegmentLead = `${introOnly} ${section}`

    const withTwoSegmentLead = admitArticle(question, title, twoSegmentLead, twoSegmentLead, 'fts')
    expect(withTwoSegmentLead.admitted).toBe(true) // lex(lead, tokens(q)) = 2 ("rotation","planeten") -> escape fires

    const withIntroOnly = admitArticle(question, title, introOnly, introOnly, 'fts')
    expect(withIntroOnly).toEqual({ admitted: false, reason: 'explicit-different-sense', route: 'fts' }) // lex = 0
  })
})

describe('admitArticle — case/whitespace/diacritic insensitivity (via the shared norm())', () => {
  it('matches the biology/equipment conflict regardless of case', () => {
    const result = admitArticle(
      'WIE FUNKTIONIEREN DIE KIEMEN BEI WIRBELTIEREN?',
      'ATEMREGLER',
      'TAUCHAUSRÜSTUNG',
      'TAUCHAUSRÜSTUNG',
      'fts'
    )
    expect(result.admitted).toBe(false)
  })
})
