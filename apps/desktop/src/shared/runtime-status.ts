import type { RuntimeStatus } from './types'

/**
 * #599: a model start is under way — requested (its weight check included, minutes on a freshly
 * copied drive) or loading. The one definition every reader of a `RuntimeStatus` shares: Chat's
 * waiting screen, the local API's `model_starting`, the engine-update and benchmark guards. The
 * manager's own `isStarting()` folds the same two signals.
 */
export function isModelStarting(status: Pick<RuntimeStatus, 'startingModelId' | 'startRequested'>): boolean {
  return status.startingModelId != null || status.startRequested === true
}

/** #599: the no-model refusal — "is starting" while a start is under way, never "start one first". */
export function noModelMessageKey(starting: boolean): 'main.modelStarting' | 'main.noModelRunning' {
  return starting ? 'main.modelStarting' : 'main.noModelRunning'
}
