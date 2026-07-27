import { create } from 'zustand'
import type {
  AnalysisProgress,
  FileId,
  LlmEndpoint,
  ModuleGraph,
  RepoSnapshot
} from '../../shared/model'
import type { LensId, LensResult } from './lenses'
import type { HealthReport } from './analysis/graph-health'

export type ViewMode = 'city' | 'galaxy' | 'molecule'
export type Theme = 'night' | 'day'

export interface HoverInfo {
  fileId: FileId
  x: number
  y: number
}

interface AtlasState {
  snapshot: RepoSnapshot | null
  progress: AnalysisProgress | null
  mode: ViewMode
  theme: Theme
  hover: HoverInfo | null
  selected: FileId | null
  /** file the molecule view is drilled into */
  moleculeFile: FileId | null
  moleculeGraph: ModuleGraph | null
  searchOpen: boolean
  settingsOpen: boolean
  chatOpen: boolean
  llm: LlmEndpoint | null
  /** commit index for time scrub; -1 = live/HEAD */
  timeIndex: number
  flyToRequest: FileId | null
  /** increment to ask the scene to reframe the current view (Home) */
  reframeRequest: number
  lens: LensId
  /** per-FileId line coverage 0..1 (-1 = no data), from lcov */
  coverage: number[] | null
  /** legend metadata for the active lens, set by the scene */
  lensLegend: LensResult['legend'] | null
  health: HealthReport | null
  healthOpen: boolean
  contextMenu: { fileId: FileId; x: number; y: number } | null
  /** active graph-ops filter (keep array consumed by the scene) */
  fileFilter: { keep: Float32Array; label: string } | null
  tour: {
    stops: { fileId: number; dirId: number; title: string; narration: string }[]
    current: number
    playing: boolean
    done: boolean
  } | null
  /** bumped after an in-place edit of snapshot.files[...] (save → re-parse) */
  fileVersion: { fileId: FileId; version: number } | null
  /** diff mode: [commitA, commitB], null = off */
  diffRange: [number, number] | null
  diffCounts: { added: number; modified: number; deleted: number } | null
  glInfo: { mode: string; renderer: string; software: boolean } | null

  setSnapshot(s: RepoSnapshot): void
  setProgress(p: AnalysisProgress): void
  setMode(m: ViewMode): void
  setTheme(t: Theme): void
  setHover(h: HoverInfo | null): void
  setSelected(f: FileId | null): void
  setMolecule(file: FileId | null, graph: ModuleGraph | null): void
  setSearchOpen(v: boolean): void
  setSettingsOpen(v: boolean): void
  setChatOpen(v: boolean): void
  setLlm(e: LlmEndpoint | null): void
  setTimeIndex(i: number): void
  requestFlyTo(f: FileId | null): void
  requestReframe(): void
  setLens(l: LensId): void
  setCoverage(c: number[] | null): void
  setLensLegend(l: LensResult['legend'] | null): void
  setHealth(h: HealthReport | null): void
  setHealthOpen(v: boolean): void
  setContextMenu(m: { fileId: FileId; x: number; y: number } | null): void
  setFileFilter(f: { keep: Float32Array; label: string } | null): void
  setTour(t: AtlasState['tour']): void
  setDiffRange(r: [number, number] | null): void
  setDiffCounts(c: AtlasState['diffCounts']): void
  setGlInfo(g: AtlasState['glInfo']): void
  /** patch a file's metrics in place and notify the scene */
  bumpFileVersion(
    fileId: FileId,
    patch: { loc: number; complexity: number; todoCount: number; symbolCount: number }
  ): void
}

export const useAtlas = create<AtlasState>((set) => ({
  snapshot: null,
  progress: null,
  mode: 'city',
  theme: 'night',
  hover: null,
  selected: null,
  moleculeFile: null,
  moleculeGraph: null,
  searchOpen: false,
  settingsOpen: false,
  chatOpen: false,
  llm: null,
  timeIndex: -1,
  flyToRequest: null,
  reframeRequest: 0,
  lens: 'language',
  coverage: null,
  lensLegend: null,
  health: null,
  healthOpen: false,
  contextMenu: null,
  fileFilter: null,
  tour: null,
  fileVersion: null,
  diffRange: null,
  diffCounts: null,
  glInfo: null,

  setSnapshot: (snapshot) =>
    set({ snapshot, selected: null, hover: null, timeIndex: -1, moleculeFile: null, moleculeGraph: null, mode: 'city' }),
  setProgress: (progress) => set({ progress }),
  setMode: (mode) => set({ mode }),
  setTheme: (theme) => set({ theme }),
  setHover: (hover) => set({ hover }),
  setSelected: (selected) => set({ selected }),
  setMolecule: (moleculeFile, moleculeGraph) =>
    set({ moleculeFile, moleculeGraph, mode: moleculeFile !== null ? 'molecule' : 'city' }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setLlm: (llm) => set({ llm }),
  setTimeIndex: (timeIndex) => set({ timeIndex }),
  requestFlyTo: (flyToRequest) => set({ flyToRequest }),
  requestReframe: () => set((s) => ({ reframeRequest: s.reframeRequest + 1 })),
  setLens: (lens) => set({ lens }),
  setCoverage: (coverage) => set({ coverage }),
  setLensLegend: (lensLegend) => set({ lensLegend }),
  setHealth: (health) => set({ health }),
  setHealthOpen: (healthOpen) => set({ healthOpen }),
  setContextMenu: (contextMenu) => set({ contextMenu }),
  setFileFilter: (fileFilter) => set({ fileFilter }),
  setTour: (tour) => set({ tour }),
  setDiffRange: (diffRange) => set({ diffRange }),
  setDiffCounts: (diffCounts) => set({ diffCounts }),
  setGlInfo: (glInfo) => set({ glInfo }),
  bumpFileVersion: (fileId, patch) =>
    set((s) => {
      if (s.snapshot) Object.assign(s.snapshot.files[fileId], patch)
      return { fileVersion: { fileId, version: (s.fileVersion?.version ?? 0) + 1 } }
    })
}))
