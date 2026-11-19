import { describe, expect, it } from 'vitest'
import { workspaceStandIn } from '../helpers/workspace-stand-in'

// #897: the stand-in's own state machine, which no suite exercises in both shapes: a fixed flag follows the moves, a
// function-valued one stays the caller's.
describe('workspaceStandIn', () => {
  it('moves fixed flags like the controller: latch first, DB closed last, a new session on unlock', () => {
    const ws = workspaceStandIn()
    ws.beginLock()
    expect([ws.isUnlocked(), ws.isLocking()]).toEqual([true, true]) // mid-teardown: the DB still open
    ws.completeLock()
    expect([ws.isUnlocked(), ws.isLocking()]).toEqual([false, true])
    ws.completeUnlock()
    expect([ws.isUnlocked(), ws.isLocking(), ws.unlockEpoch()]).toEqual([true, false, 2])
  })

  it('leaves a function-valued option to the caller: a move never replaces it with a constant', () => {
    let rowLocking = false
    let rowEpoch = 7
    const ws = workspaceStandIn({ locking: () => rowLocking, epoch: () => rowEpoch })
    ws.cancelLock()
    ws.completeUnlock()
    rowLocking = true
    rowEpoch = 9
    expect([ws.isLocking(), ws.unlockEpoch()]).toEqual([true, 9])
  })
})
