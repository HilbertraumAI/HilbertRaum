import type { RuntimeStatus, TranslationDeviceStatus } from './types'

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

/**
 * #671: did a translation start run on the processor? Its posture forced it (`'cpu'`), or its own
 * load log put no buffer on a graphics device (`gpuBuffers === false`). Never the offload line: a
 * start with no usable device, and one under `--device none`, both print `offloaded 49/49 layers to
 * GPU`. Without evidence (`gpuBuffers` absent) the posture stands. The one definition the Translate
 * screen's hint, the Performance row and the sidecar's own card occupancy share.
 */
export function translationRanOnProcessor(start: Pick<TranslationDeviceStatus, 'device' | 'gpuBuffers'>): boolean {
  return start.device === 'cpu' || start.gpuBuffers === false
}
