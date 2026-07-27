// Graph operations shared by the context menu, filters, and AI tools:
// transitive walks over the import graph and keep-array construction.
import type { FileId, RepoSnapshot } from '../../shared/model'
import { useAtlas } from './store'

export function adjacency(
  snapshot: RepoSnapshot,
  direction: 'deps' | 'dependents'
): number[][] {
  const n = snapshot.files.length
  const adj: number[][] = Array.from({ length: n }, () => [])
  const e = snapshot.importEdges
  for (let i = 0; i + 1 < e.length; i += 2) {
    if (direction === 'deps') adj[e[i]].push(e[i + 1])
    else adj[e[i + 1]].push(e[i])
  }
  return adj
}

/** BFS with depth cap; returns id → depth (root = 0) */
export function transitive(
  snapshot: RepoSnapshot,
  root: FileId,
  direction: 'deps' | 'dependents',
  maxDepth: number
): Map<FileId, number> {
  const adj = adjacency(snapshot, direction)
  const depth = new Map<FileId, number>([[root, 0]])
  let frontier = [root]
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: number[] = []
    for (const v of frontier) {
      for (const w of adj[v]) {
        if (!depth.has(w)) {
          depth.set(w, d)
          next.push(w)
        }
      }
    }
    frontier = next
  }
  return depth
}

function keepFrom(snapshot: RepoSnapshot, kept: Iterable<FileId>): Float32Array {
  const keep = new Float32Array(snapshot.files.length) // default 0 = hidden
  for (const id of kept) keep[id] = 1
  return keep
}

export interface ActiveFilter {
  keep: Float32Array
  label: string
}

/** apply a filter through the store (SceneManager forwards to WorldLayer) */
export function applyFilter(filter: ActiveFilter | null): void {
  useAtlas.getState().setFileFilter(filter)
}

export function filterDependencies(snapshot: RepoSnapshot, root: FileId, depth = 3): void {
  const set = transitive(snapshot, root, 'deps', depth)
  applyFilter({
    keep: keepFrom(snapshot, set.keys()),
    label: `deps of ${snapshot.files[root].name} (${set.size})`
  })
}

export function filterDependents(snapshot: RepoSnapshot, root: FileId, depth = 3): void {
  const set = transitive(snapshot, root, 'dependents', depth)
  applyFilter({
    keep: keepFrom(snapshot, set.keys()),
    label: `dependents of ${snapshot.files[root].name} (${set.size})`
  })
}

export function isolateNeighborhood(snapshot: RepoSnapshot, root: FileId, depth = 2): void {
  const deps = transitive(snapshot, root, 'deps', depth)
  const dependents = transitive(snapshot, root, 'dependents', depth)
  const union = new Set([...deps.keys(), ...dependents.keys()])
  applyFilter({
    keep: keepFrom(snapshot, union),
    label: `${snapshot.files[root].name} ±${depth} (${union.size})`
  })
}

export function filterByLanguage(snapshot: RepoSnapshot, language: string): void {
  const kept: number[] = []
  snapshot.files.forEach((f, id) => {
    if (f.language === language) kept.push(id)
  })
  applyFilter({ keep: keepFrom(snapshot, kept), label: `${language} (${kept.length})` })
}

/** minimal glob: * = within-segment, ** = across segments */
export function filterByGlob(snapshot: RepoSnapshot, glob: string): number {
  const rx = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0001/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  )
  const kept: number[] = []
  snapshot.files.forEach((f, id) => {
    if (rx.test(f.path)) kept.push(id)
  })
  applyFilter({ keep: keepFrom(snapshot, kept), label: `${glob} (${kept.length})` })
  return kept.length
}
