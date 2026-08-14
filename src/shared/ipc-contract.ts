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
  writeFile: 'atlas:write-file',
  getModuleGraph: 'atlas:get-module-graph',
  llmProbe: 'atlas:llm-probe',
  llmChat: 'atlas:llm-chat',
  llmAbort: 'atlas:llm-abort',
  llmToolResult: 'atlas:llm-tool-result',
  getSettings: 'atlas:get-settings',
  saveSettings: 'atlas:save-settings',
  loadLcov: 'atlas:load-lcov',
  buildSummaries: 'atlas:build-summaries',
  cancelSummaries: 'atlas:cancel-summaries',
  getSummaries: 'atlas:get-summaries',
  saveScreenshot: 'atlas:save-screenshot',
  setGlMode: 'atlas:set-gl-mode',
  // main → renderer (send)
  analysisProgress: 'atlas:analysis-progress',
  analysisSnapshot: 'atlas:analysis-snapshot',
  llmChunk: 'atlas:llm-chunk',
  llmDone: 'atlas:llm-done',
  llmError: 'atlas:llm-error',
  llmToolCall: 'atlas:llm-tool-call',
  llmToolDone: 'atlas:llm-tool-done',
  llmRetry: 'atlas:llm-retry',
  summariesProgress: 'atlas:summaries-progress',
  glInfo: 'atlas:gl-info'
} as const

export interface AtlasSettings {
  llm?: LlmEndpoint
  /** every endpoint that ever probed successfully — the switcher list */
  llmEndpoints?: LlmEndpoint[]
  maxCommits?: number
  maxFiles?: number
  recentRepos?: string[]
  watch?: boolean
  glMode?: 'default' | 'egl' | 'swiftshader'
  /** prompt-token threshold for chat receipt-compaction (0 = off) */
  contextBudget?: number
  /** encrypted API key blob (main-process only; stripped from getSettings) */
  llmKeyEnc?: string
  /** computed for the renderer: whether a key is stored */
  hasLlmKey?: boolean
  bookmarks?: Record<string, { name: string; pos: number[]; target: number[] }[]>
}

export interface LlmChunkPayload {
  requestId: string
  delta: string
}

export interface LlmToolCallPayload {
  requestId: string
  callId: string
  name: string
  args: Record<string, unknown>
}

export interface AtlasApi {
  openFolderDialog(): Promise<string | null>
  /** kicks off analysis; snapshot arrives via onSnapshot, progress via onProgress */
  analyze(rootPath: string): Promise<void>
  cancelAnalysis(): Promise<void>
  readFile(fileId: FileId): Promise<string | null>
  /** save edited content; re-parses the file and returns refreshed metrics */
  writeFile(
    fileId: FileId,
    content: string
  ): Promise<
    | { ok: true; loc: number; complexity: number; todoCount: number; symbolCount: number }
    | { ok: false; error: string }
  >
  getModuleGraph(fileIds: FileId[]): Promise<ModuleGraph>
  /** hostOrUrl: bare IP/host (port-scanned over http) or a full http(s) URL */
  llmProbe(hostOrUrl: string, port?: number, apiKey?: string): Promise<LlmProbeResult>
  /** start a chat; optional OpenAI tool schemas enable the scene-agent loop */
  llmChat(messages: LlmChatMessage[], tools?: Record<string, unknown>[]): Promise<string>
  llmAbort(requestId: string): Promise<void>
  llmToolResult(requestId: string, callId: string, result: string, isError?: boolean): Promise<void>
  getSettings(): Promise<AtlasSettings>
  saveSettings(patch: Partial<AtlasSettings>): Promise<AtlasSettings>
  /** open an lcov file; returns per-FileId coverage 0..1 (-1 = no data), or null if canceled */
  loadLcov(): Promise<{ coverage: number[]; coveredFiles: number } | null>
  /** build the AI search index (one-line file summaries, cached by content hash) */
  buildSummaries(): Promise<{ built: number; cached: number; total: number } | { error: string }>
  cancelSummaries(): Promise<void>
  getSummaries(): Promise<Record<string, string>>
  /** save a data-URL PNG via the native save dialog */
  saveScreenshot(dataUrl: string): Promise<boolean>
  /** persist a renderer mode and relaunch the app into it */
  setGlMode(mode: 'default' | 'egl' | 'swiftshader'): Promise<void>
  onSummariesProgress(cb: (p: { done: number; total: number }) => void): () => void
  onGlInfo(cb: (info: { mode: string; renderer: string; software: boolean }) => void): () => void
  onProgress(cb: (p: AnalysisProgress) => void): () => void
  onSnapshot(cb: (s: RepoSnapshot) => void): () => void
  onLlmChunk(cb: (c: LlmChunkPayload) => void): () => void
  onLlmDone(cb: (requestId: string) => void): () => void
  onLlmError(cb: (requestId: string, error: string) => void): () => void
  onLlmToolCall(cb: (c: LlmToolCallPayload) => void): () => void
  onLlmToolDone(
    cb: (c: { requestId: string; callId: string; name: string; isError: boolean }) => void
  ): () => void
  onLlmRetry(
    cb: (c: { requestId: string; attempt: number; max: number; reason: string }) => void
  ): () => void
}
