// Type declarations for netlog-remote.mjs so apps/desktop/tests/unit/netlog-remote.test.ts can
// import it without a TS build step for scripts/.
export interface NetLog {
  constants?: { logEventTypes?: Record<string, number> }
  events?: Array<{ type: number; params?: Record<string, unknown> }>
}
export declare function bareHost(value: string): string
export declare function remoteRequests(netlog: NetLog): {
  urls: Record<string, number>
  hosts: Record<string, number>
}
export declare function parseNetLog(text: string): NetLog
