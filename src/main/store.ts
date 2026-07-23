// Main-process state: the full analysis (including symbol-level data that
// never crosses IPC wholesale) plus JSON-file settings persistence.
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { FileId, ModuleGraph, RepoSnapshot } from '../shared/model'
import type { AtlasSettings } from '../shared/ipc-contract'
import type { FileExtraction } from './analyzer/symbol-graph'
import { buildModuleGraph } from './analyzer/symbol-graph'

export class AnalysisStore {
  rootPath: string | null = null
  snapshot: RepoSnapshot | null = null
  extractions = new Map<FileId, FileExtraction>()
  importNeighbors = new Map<FileId, Set<FileId>>()

  reset(rootPath: string): void {
    this.rootPath = rootPath
    this.snapshot = null
    this.extractions.clear()
    this.importNeighbors.clear()
  }

  absPathOf(fileId: FileId): string | null {
    if (!this.snapshot || !this.rootPath) return null
    const file = this.snapshot.files[fileId]
    return file ? join(this.rootPath, file.path) : null
  }

  moduleGraph(fileIds: FileId[]): ModuleGraph {
    if (!this.snapshot) return { symbols: [], edges: [] }
    const names = this.snapshot.files.map((f) => f.name)
    return buildModuleGraph(fileIds, names, this.extractions, this.importNeighbors)
  }
}

export const analysisStore = new AnalysisStore()

// ---- settings ----

const DEFAULTS: AtlasSettings = { maxCommits: 5000, maxFiles: 30000 }

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<AtlasSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveSettings(patch: Partial<AtlasSettings>): Promise<AtlasSettings> {
  const merged = { ...(await loadSettings()), ...patch }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify(merged, null, 2))
  return merged
}
