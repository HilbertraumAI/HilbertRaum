// Central registry of IPC channel names so main + preload never drift.
export const IPC = {
  getAppStatus: 'app:getAppStatus',
  getDriveStatus: 'app:getDriveStatus',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  // Phase 2+
  listModels: 'models:list',
  selectModel: 'models:select',
  startRuntime: 'runtime:start',
  stopRuntime: 'runtime:stop',
  // Phase 3+
  createConversation: 'chat:createConversation',
  listConversations: 'chat:listConversations',
  listMessages: 'chat:listMessages',
  sendChatMessage: 'chat:send',
  stopGeneration: 'chat:stop',
  // Phase 4+
  importDocuments: 'docs:import',
  getImportJob: 'docs:getImportJob',
  listDocuments: 'docs:list',
  deleteDocument: 'docs:delete',
  askDocuments: 'rag:ask',
  // Phase 7
  runBenchmark: 'benchmark:run'
} as const

// Renderer-bound streaming event channels (main -> renderer).
export const STREAM = {
  token: (requestId: string) => `chat:token:${requestId}`,
  done: (requestId: string) => `chat:done:${requestId}`,
  error: (requestId: string) => `chat:error:${requestId}`
} as const
