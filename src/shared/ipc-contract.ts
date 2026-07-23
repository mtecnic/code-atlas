// Typed IPC surface. Channel names live here; the preload script exposes the
// renderer-facing AtlasApi built from these, and main registers handlers for them.
import type {
  AnalysisProgress,
  FileId,
  LlmChatMessage,
  LlmEndpoint,
  LlmProbeResult,
  ModuleGraph,
  RepoSnapshot
} from './model'

export const CHANNELS = {
  // renderer → main (invoke)
  openFolderDialog: 'atlas:open-folder-dialog',
  analyze: 'atlas:analyze',
  cancelAnalysis: 'atlas:cancel-analysis',
  readFile: 'atlas:read-file',
  getModuleGraph: 'atlas:get-module-graph',
  llmProbe: 'atlas:llm-probe',
  llmChat: 'atlas:llm-chat',
  llmAbort: 'atlas:llm-abort',
  getSettings: 'atlas:get-settings',
  saveSettings: 'atlas:save-settings',
  // main → renderer (send)
  analysisProgress: 'atlas:analysis-progress',
  analysisSnapshot: 'atlas:analysis-snapshot',
  llmChunk: 'atlas:llm-chunk',
  llmDone: 'atlas:llm-done',
  llmError: 'atlas:llm-error'
} as const

export interface AtlasSettings {
  llm?: LlmEndpoint
  maxCommits?: number
  maxFiles?: number
}

export interface LlmChunkPayload {
  requestId: string
  delta: string
}

export interface AtlasApi {
  openFolderDialog(): Promise<string | null>
  /** kicks off analysis; snapshot arrives via onSnapshot, progress via onProgress */
  analyze(rootPath: string): Promise<void>
  cancelAnalysis(): Promise<void>
  readFile(fileId: FileId): Promise<string | null>
  getModuleGraph(fileIds: FileId[]): Promise<ModuleGraph>
  llmProbe(host: string, port?: number): Promise<LlmProbeResult>
  llmChat(messages: LlmChatMessage[]): Promise<string> // returns requestId
  llmAbort(requestId: string): Promise<void>
  getSettings(): Promise<AtlasSettings>
  saveSettings(patch: Partial<AtlasSettings>): Promise<AtlasSettings>
  onProgress(cb: (p: AnalysisProgress) => void): () => void
  onSnapshot(cb: (s: RepoSnapshot) => void): () => void
  onLlmChunk(cb: (c: LlmChunkPayload) => void): () => void
  onLlmDone(cb: (requestId: string) => void): () => void
  onLlmError(cb: (requestId: string, error: string) => void): () => void
}
