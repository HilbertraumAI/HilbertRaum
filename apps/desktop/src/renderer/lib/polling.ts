/**
 * Runtime-status poll cadence shared by HomeScreen and ChatScreen. Both screens poll
 * while no runtime is up (a large GGUF can take a while to auto-start) and must flip
 * to ready on their own — one constant keeps their cadences in lockstep.
 */
export const RUNTIME_POLL_MS = 2500
