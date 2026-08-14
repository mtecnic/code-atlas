// The single source of truth for data crossing the main → renderer boundary.
// All node references are integer indices into flat arrays so they map directly
// onto instanced-attribute buffers and structured-clone quickly.

export type FileId = number
export type DirId = number
export type SymbolId = number

export interface DirNode {
  path: string // repo-relative, '' for root
  name: string
  parent: DirId | -1
  children: DirId[]
  fileIds: FileId[]
}

export interface ChurnInfo {
  commits: number
  /** unix seconds of last commit touching this file, 0 if unknown */
  lastTouched: number
  authors: number
  /** 0..1 recency-decayed heat used for emissive intensity */
  heat: number
  /** author with the most commits to this file ('' if unknown) */
  topAuthor: string
  /** that author's share of the file's commits, 0..1 */
  topShare: number
}

export interface FileNode {
  path: string // repo-relative
  name: string
  dir: DirId
  /** null = stats-only fallback (unsupported language or binary-ish) */
  language: string | null
  loc: number
  sizeBytes: number
  /** decision-point count (cyclomatic-style), 0 if not parsed */
  complexity: number
  /** TODO/FIXME/HACK/XXX marker count */
  todoCount: number
  churn: ChurnInfo
  /** tree-sitter parse succeeded */
  analyzed: boolean
  /** hint for molecule view availability; symbols fetched lazily */
  symbolCount: number
}

export type GitEventKind = 'A' | 'M' | 'D' | 'R'

export interface GitCommitMeta {
  hash: string
  time: number // unix seconds
  author: string
  subject: string
}

export interface GitTimelineEvent {
  commit: number // index into commits[]
  file: FileId
  kind: GitEventKind
  locDelta: number
}

export interface GitTimeline {
  /** oldest → newest */
  commits: GitCommitMeta[]
  /** sorted by commit index; fold to reconstruct any point in time */
  events: GitTimelineEvent[]
}

export interface RepoStats {
  totalLoc: number
  totalFiles: number
  /** language → file count */
  languages: Record<string, number>
  skipped: number
}

export interface RepoSnapshot {
  rootPath: string
  dirs: DirNode[] // index = DirId; dirs[0] = root
  files: FileNode[] // index = FileId
  /** flat pairs [srcFileId, dstFileId, ...] */
  importEdges: Uint32Array
  timeline: GitTimeline
  stats: RepoStats
}

// ---- Symbol level (lazy, fetched per module for molecule view) ----

export type SymbolKind = 'function' | 'class' | 'method' | 'variable' | 'type' | 'module'
export type SymbolEdgeKind = 'call' | 'reference' | 'contains'

export interface SymbolNode {
  name: string
  kind: SymbolKind
  file: FileId
  /** [startLine, endLine], 0-based inclusive */
  range: [number, number]
  parent: SymbolId | -1
}

export interface ModuleGraph {
  symbols: SymbolNode[] // index = local SymbolId
  edges: { src: SymbolId; dst: SymbolId; kind: SymbolEdgeKind }[]
}

// ---- Analysis progress ----

export type AnalysisPhase = 'scan' | 'parse' | 'git' | 'link' | 'done' | 'error'

export interface AnalysisProgress {
  phase: AnalysisPhase
  done: number
  total: number
  currentPath?: string
  error?: string
}

// ---- LLM ----

export type LlmStyle = 'openai' | 'ollama'

export interface LlmEndpoint {
  style: LlmStyle
  baseUrl: string // e.g. http://192.168.86.23:8000
  models: string[]
  model: string // selected
}

export type PreflightCategory =
  | 'ok'
  | 'auth_rejected'
  | 'unsupported_model'
  | 'quota_exhausted'
  | 'network_failure'
  | 'unknown_error'

export interface PreflightResult {
  ok: boolean
  category: PreflightCategory
  message: string
}

export interface LlmProbeResult {
  ok: boolean
  endpoint?: LlmEndpoint
  tried: string[]
  error?: string
  /** result of a real 1-token chat completion against the chosen endpoint */
  preflight?: PreflightResult
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
