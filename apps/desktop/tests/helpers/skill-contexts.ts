// Skill-analysis / skill-tool context factories with a capturing audit (pure: no electron import).
import type { Db } from '../../src/main/services/db'
import type { SkillAnalysisContext } from '../../src/main/services/skills/analysis/types'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { DocumentChunkRead, RetrievalScope, SkillToolContext } from '../../src/shared/types'
import { capturingAudit, type CapturedAuditEvent } from './audit-capture'

/** A skill-analysis handler context over `db`, with a capturing audit and the EN (default) or DE `tr`. */
export function makeAnalysisCtx(
  db: Db,
  scope: RetrievalScope,
  question: string,
  o: { skillInstallId: string; conversationId?: string | null; locale?: 'en' | 'de' }
): SkillAnalysisContext & { events: CapturedAuditEvent[] } {
  const { audit, events } = capturingAudit()
  const locale = o.locale ?? 'en'
  return {
    db,
    scope,
    question,
    skillInstallId: o.skillInstallId,
    conversationId: o.conversationId ?? null,
    audit,
    tr: (key: MessageKey, params?: MessageParams): string => t(locale, key, params),
    events
  }
}

/** A tool-seam ctx over one document `d1` serving `chunks`, with a capturing audit (override any field via `over`). */
export function makeToolCtx(
  chunks: DocumentChunkRead[],
  over: Partial<SkillToolContext> = {}
): { ctx: SkillToolContext; events: CapturedAuditEvent[] } {
  const events: CapturedAuditEvent[] = []
  const ctx: SkillToolContext = {
    documentIds: ['d1'],
    readDocumentChunks: (id) => (id === 'd1' ? chunks : []),
    signal: new AbortController().signal,
    audit: (type, meta) => events.push({ type, meta }),
    ...over
  }
  return { ctx, events }
}

export function chunk(text: string, page: number | null = 1, index = 0): DocumentChunkRead {
  return { text, page, index }
}
