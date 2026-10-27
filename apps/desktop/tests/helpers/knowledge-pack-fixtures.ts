import type { KnowledgePack, KnowledgePacksChangedEvent } from '../../src/shared/types'

// Renderer fixtures for knowledge packs (#301): one typed `KnowledgePack` row and a controllable
// `packs:changed` broadcast, shared by the pack, chat and home suites. Override per test.

/** An available, enabled pack; defaults to the German climate pack. */
export function knowledgePack(over: Partial<KnowledgePack> = {}): KnowledgePack {
  return {
    id: 'uuid-climate',
    title: 'Klimawandel von Wikipedia',
    description: null,
    language: 'deu',
    zimDate: '2026-07-01',
    articleCount: 4102,
    sizeBytes: 27 * 1024 * 1024,
    leaf: 'wikipedia_de_climate.zim',
    enabled: true,
    available: true,
    // Non-optional: null whenever the pack is available; 'missing' / 'identity-mismatch' say why not.
    unavailableReason: null,
    addedAt: '2026-09-01T00:00:00Z',
    ...over
  }
}

/** The English Wikipedia pack the home and chat-navigation suites list: spread into `knowledgePack`. */
export const WIKIPEDIA_EN_PACK = {
  id: 'p1',
  title: 'Wikipedia (English)',
  language: 'eng',
  articleCount: 100,
  sizeBytes: 1024,
  leaf: 'wikipedia_en.zim'
} as const satisfies Partial<KnowledgePack>

/** A controllable `onKnowledgePacksChanged` stand-in (#301 P3b): the test holds `emit` and calls it
 *  whenever the main process would broadcast the event. */
export function packsEventEmitter(): {
  onKnowledgePacksChanged: (cb: (event: KnowledgePacksChangedEvent) => void) => () => void
  emit: (event: KnowledgePacksChangedEvent) => void
} {
  let cb: ((event: KnowledgePacksChangedEvent) => void) | null = null
  return {
    onKnowledgePacksChanged: (fn) => {
      cb = fn
      return () => {
        cb = null
      }
    },
    emit: (event) => cb?.(event)
  }
}
