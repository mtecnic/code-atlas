// Squarified-treemap city layout: directories become nested platforms, files
// become buildings. Returns flat position/scale arrays indexed by FileId/DirId.
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { RepoSnapshot } from '../../../../shared/model'

export interface CityLayout {
  /** per file: x, y (base), z */
  filePos: Float32Array
  /** per file: sx, sy (height), sz */
  fileScale: Float32Array
  /** per dir: x, y, z */
  dirPos: Float32Array
  /** per dir: sx, sy, sz */
  dirScale: Float32Array
  /** world-units half-extent of the whole map */
  extent: number
}

interface TreeDatum {
  kind: 'dir' | 'file'
  id: number
  loc: number
  children?: TreeDatum[]
}

const WORLD_SIZE = 900
const PLATFORM_H = 1.6
const FILE_MARGIN = 0.14 // fraction of cell kept as street
const MAX_BUILDING_H = 120

export function layoutCity(snapshot: RepoSnapshot): CityLayout {
  const { dirs, files } = snapshot

  const build = (dirId: number): TreeDatum => ({
    kind: 'dir',
    id: dirId,
    loc: 0,
    children: [
      ...dirs[dirId].children.map(build),
      ...dirs[dirId].fileIds.map((f) => ({
        kind: 'file' as const,
        id: f,
        loc: Math.max(1, files[f].loc)
      }))
    ]
  })

  const root = hierarchy<TreeDatum>(build(0), (d) => d.children)
    .sum((d) => (d.kind === 'file' ? Math.sqrt(d.loc) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

  treemap<TreeDatum>()
    .tile(treemapSquarify)
    .size([WORLD_SIZE, WORLD_SIZE])
    .paddingOuter(3.5)
    .paddingInner(1.6)
    .paddingTop(3.5)(root)

  const filePos = new Float32Array(files.length * 3)
  const fileScale = new Float32Array(files.length * 3)
  const dirPos = new Float32Array(dirs.length * 3)
  const dirScale = new Float32Array(dirs.length * 3)

  const half = WORLD_SIZE / 2
  const maxLoc = files.reduce((m, f) => Math.max(m, f.loc), 1)

  root.each((node) => {
    const { x0, x1, y0, y1 } = node as unknown as {
      x0: number
      x1: number
      y0: number
      y1: number
    }
    const w = Math.max(0.1, x1 - x0)
    const d = Math.max(0.1, y1 - y0)
    const cx = (x0 + x1) / 2 - half
    const cz = (y0 + y1) / 2 - half
    if (node.data.kind === 'dir') {
      const i = node.data.id * 3
      const y = node.depth * PLATFORM_H
      dirPos[i] = cx
      dirPos[i + 1] = y
      dirPos[i + 2] = cz
      dirScale[i] = w
      dirScale[i + 1] = PLATFORM_H
      dirScale[i + 2] = d
    } else {
      const i = node.data.id * 3
      const file = snapshot.files[node.data.id]
      const y = node.depth * PLATFORM_H
      const height = 2 + (Math.sqrt(file.loc) / Math.sqrt(maxLoc)) * MAX_BUILDING_H
      const m = 1 - FILE_MARGIN
      filePos[i] = cx
      filePos[i + 1] = y
      filePos[i + 2] = cz
      fileScale[i] = w * m
      fileScale[i + 1] = height
      fileScale[i + 2] = d * m
    }
  })

  return { filePos, fileScale, dirPos, dirScale, extent: half }
}
