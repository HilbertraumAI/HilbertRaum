import { fireEvent } from '@testing-library/react'

// File drag-and-drop for renderer suites (chat-ui campaign). Replaces the local copies: the drop-zone
// suites' `dataTransfer()` (ImageDropZone, TranslateDropZone), ImagesScreen's `fireDrop`, TranslateScreen's
// `dropOnZone`, and — through chat-screen.tsx's `chatDropBridge` — the chat suites' drops (ChatAttach,
// ChatBackToConversation, ChatUnmount, ChatScopeToolsRefresh).
//
// Rules:
//  - jsdom has no DataTransfer, so RTL's fireEvent hands the handler THIS plain object as `event.dataTransfer`.
//    It is mutable: a test reads back the `dropEffect` the handler wrote. It starts as 'copy', which the drop
//    zones never write, so a busy zone's 'none' is the handler's write and not the seed.
//  - A dropped File carries no `.path` (Electron 37 removed it, FE-A). A screen that needs the on-disk path asks
//    `window.api.getDroppedFilePath`; stub it with `chatDropBridge` rather than giving the File a `.path`.

/** The DataTransfer stand-in a drag event carries. */
export interface FileDataTransfer {
  types: string[]
  files: File[]
  dropEffect: string
}

/** A file drag's transfer: `files`, the `types` a real OS file drag reports ('Files'), `dropEffect` 'copy'. */
export function fileDataTransfer(files: File[] = [], types: string[] = ['Files']): FileDataTransfer {
  return { types, files, dropEffect: 'copy' }
}

/** Drag `files` over `target` and drop them: `dragover` then `drop`, both with the SAME transfer, as a
 *  browser delivers them. Pass `types` without 'Files' for a non-file drag (text, a link). */
export function dropFiles(target: Element, files: File[], types: string[] = ['Files']): void {
  const dataTransfer = fileDataTransfer(files, types)
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })
}
