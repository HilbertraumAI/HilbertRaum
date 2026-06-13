/**
 * Runtime-status poll cadence shared by HomeScreen and ChatScreen. Both screens poll
 * while no runtime is up (a large GGUF can take a while to auto-start) and must flip
 * to ready on their own — one constant keeps their cadences in lockstep.
 */
export const RUNTIME_POLL_MS = 2500

/**
 * Poll cadence for recovering an in-flight chat generation after the Chat screen was
 * unmounted (the user navigated away and back). Snappier than the runtime poll so the
 * recovered reply updates smoothly; only runs while a generation is actually in flight.
 */
export const STREAM_RECOVER_POLL_MS = 300
