// Shared entry point for the molecule view: fetches the symbol graph for a
// file plus its import neighborhood and switches the store into molecule mode.
import { useAtlas } from './store'
import type { FileId } from '../../shared/model'

export async function enterMoleculeFor(fileId: FileId): Promise<void> {
  const state = useAtlas.getState()
  const snapshot = state.snapshot
  if (!snapshot) return
  const neighbors = new Set<FileId>([fileId])
  const edges = snapshot.importEdges
  for (let i = 0; i + 1 < edges.length; i += 2) {
    if (edges[i] === fileId) neighbors.add(edges[i + 1])
    if (edges[i + 1] === fileId) neighbors.add(edges[i])
  }
  const graph = await window.atlas.getModuleGraph([...neighbors].slice(0, 12))
  state.setSelected(fileId)
  state.setMolecule(fileId, graph)
}
