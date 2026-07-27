import { create } from 'zustand'
import type {
  AnalysisProgress,
  FileId,
  LlmEndpoint,
  ModuleGraph,
  RepoSnapshot
} from '../../shared/model'
import type { LensId, LensResult } from './lenses'

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
  setLensLegend: (lensLegend) => set({ lensLegend })
}))
