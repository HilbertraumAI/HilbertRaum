// A skill-tool audit sink that records what was audited. Pure: no electron import.
import type { AuditEventType, SkillToolAudit } from '../../src/shared/types'

export interface CapturedAuditEvent {
  type: AuditEventType
  meta?: Record<string, unknown>
}

/** A skill-tool audit sink that records `{ type, meta }` per call. */
export function capturingAudit(): { audit: SkillToolAudit; events: CapturedAuditEvent[] } {
  const events: CapturedAuditEvent[] = []
  return {
    audit: (type, meta) => {
      events.push({ type, meta })
    },
    events
  }
}
