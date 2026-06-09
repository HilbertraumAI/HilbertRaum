import { contextBridge, ipcRenderer } from 'electron'
import { IPC, STREAM } from '../shared/ipc'
import type {
  AppSettings,
  AppStatus,
  BenchmarkResult,
  ChatOptions,
  Conversation,
  DocumentInfo,
  DriveStatus,
  ImportJob,
  ImportJobStatus,
  Message,
  ModelInfo,
  RuntimeStatus
} from '../shared/types'

// The single, typed bridge between renderer and main. The renderer has no
// direct Node or network access — it can only call what is exposed here.
const api = {
  getAppStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.getAppStatus),
  getDriveStatus: (): Promise<DriveStatus> => ipcRenderer.invoke(IPC.getDriveStatus),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.updateSettings, patch),

  // ---- Models + runtime (Phase 2) ----
  listModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke(IPC.listModels),
  selectModel: (
    modelId: string
  ): Promise<{ activeModelId: string | null; activeEmbeddingModelId: string | null }> =>
    ipcRenderer.invoke(IPC.selectModel, modelId),
  startRuntime: (modelId: string): Promise<RuntimeStatus> =>
    ipcRenderer.invoke(IPC.startRuntime, modelId),
  stopRuntime: (): Promise<void> => ipcRenderer.invoke(IPC.stopRuntime),

  // ---- Hardware benchmark (Phase 7) ----
  /** Detect hardware + measure drive speed, persist + return the result. Strictly local. */
  runBenchmark: (): Promise<BenchmarkResult> => ipcRenderer.invoke(IPC.runBenchmark),

  // ---- Chat (Phase 3) ----
  createConversation: (opts?: { title?: string; mode?: 'chat' | 'documents' }): Promise<Conversation> =>
    ipcRenderer.invoke(IPC.createConversation, opts),
  listConversations: (): Promise<Conversation[]> => ipcRenderer.invoke(IPC.listConversations),
  listMessages: (conversationId: string): Promise<Message[]> =>
    ipcRenderer.invoke(IPC.listMessages, conversationId),
  /** Stream a reply; resolves with the final assistant message. Tokens arrive via onToken. */
  sendChatMessage: (
    conversationId: string,
    content: string,
    options?: ChatOptions
  ): Promise<Message> => ipcRenderer.invoke(IPC.sendChatMessage, conversationId, content, options),
  stopGeneration: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.stopGeneration, conversationId),

  // ---- RAG / document Q&A (Phase 6) ----
  /** Stream a document-grounded answer; resolves with the final assistant message
   *  (which carries `citations`). Tokens arrive via onToken, like sendChatMessage. */
  askDocuments: (conversationId: string, question: string): Promise<Message> =>
    ipcRenderer.invoke(IPC.askDocuments, conversationId, question),

  // ---- Documents (Phase 4) ----
  /** Open the OS picker for files (default) or a folder; returns selected paths. */
  pickDocuments: (mode?: 'files' | 'folder'): Promise<string[]> =>
    ipcRenderer.invoke(IPC.pickDocuments, mode),
  importDocuments: (paths: string[]): Promise<ImportJob> =>
    ipcRenderer.invoke(IPC.importDocuments, paths),
  getImportJob: (jobId: string): Promise<ImportJobStatus> =>
    ipcRenderer.invoke(IPC.getImportJob, jobId),
  listDocuments: (): Promise<DocumentInfo[]> => ipcRenderer.invoke(IPC.listDocuments),
  deleteDocument: (documentId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteDocument, documentId),
  reindexDocument: (documentId: string): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.reindexDocument, documentId),

  /** Subscribe to streamed tokens for a request (= conversation id); returns an unsubscribe fn. */
  onToken: (requestId: string, cb: (token: string) => void): (() => void) => {
    const ch = STREAM.token(requestId)
    const handler = (_e: unknown, token: string) => cb(token)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to stream completion; the final assistant Message is delivered. */
  onDone: (requestId: string, cb: (message: Message) => void): (() => void) => {
    const ch = STREAM.done(requestId)
    const handler = (_e: unknown, message: Message) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to stream errors. */
  onError: (requestId: string, cb: (message: string) => void): (() => void) => {
    const ch = STREAM.error(requestId)
    const handler = (_e: unknown, message: string) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  }
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
