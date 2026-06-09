// Central registry of IPC channel names so main + preload never drift.
export const IPC = {
  getAppStatus: 'app:getAppStatus',
  getDriveStatus: 'app:getDriveStatus',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  // Phase 8 — privacy/offline policy
  getPolicy: 'policy:get',
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
  pickDocuments: 'docs:pick',
  importDocuments: 'docs:import',
  getImportJob: 'docs:getImportJob',
  listDocuments: 'docs:list',
  deleteDocument: 'docs:delete',
  reindexDocument: 'docs:reindex',
  askDocuments: 'rag:ask',
  // Phase 7
  runBenchmark: 'benchmark:run',
  // Phase 13 — non-technical first-run launch preflight
  runPreflight: 'preflight:run',
  // Phase 9 — encrypted workspace lifecycle
  getWorkspaceState: 'workspace:getState',
  unlockWorkspace: 'workspace:unlock',
  createWorkspace: 'workspace:create',
  lockWorkspace: 'workspace:lock'
} as const

// Renderer-bound streaming event channels (main -> renderer).
export const STREAM = {
  token: (requestId: string) => `chat:token:${requestId}`,
  done: (requestId: string) => `chat:done:${requestId}`,
  error: (requestId: string) => `chat:error:${requestId}`
} as const
