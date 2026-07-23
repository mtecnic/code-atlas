// Builds ModuleGraph slices for the molecule view from the per-file raw
// extractions kept in the AnalysisStore. Nesting is inferred by range
// containment; call edges by name-matching refs against defs (scope-naive v1),
// cross-file only along resolved import edges.
import type { FileId, ModuleGraph, SymbolNode } from '../../shared/model'
import type { RawDef, RawRef } from './parse-worker'

export interface FileExtraction {
  defs: RawDef[]
  refs: RawRef[]
}

export function buildModuleGraph(
  fileIds: FileId[],
  fileNames: string[], // index = FileId
  extractions: Map<FileId, FileExtraction>,
  importNeighbors: Map<FileId, Set<FileId>>
): ModuleGraph {
  const symbols: SymbolNode[] = []
  const edges: ModuleGraph['edges'] = []
  const moduleSymbol = new Map<FileId, number>()
  const defsByFile = new Map<FileId, { idx: number; def: RawDef }[]>()
  const included = new Set(fileIds)

  for (const fileId of fileIds) {
    const ex = extractions.get(fileId)
    const modIdx = symbols.length
    moduleSymbol.set(fileId, modIdx)
    symbols.push({
      name: fileNames[fileId],
      kind: 'module',
      file: fileId,
      range: [0, 0],
      parent: -1
    })
    if (!ex) continue

    // sort defs by span size ascending so the innermost container is found
    // first; cap per-file symbols so pathological files stay renderable
    const local: { idx: number; def: RawDef }[] = []
    const ordered = ex.defs
      .map((def) => ({ def, span: def.endLine - def.startLine }))
      .sort((a, b) => a.span - b.span)
      .slice(0, 300)

    for (const { def } of ordered) {
      const idx = symbols.length
      symbols.push({
        name: def.name,
        kind: def.kind,
        file: fileId,
        range: [def.startLine, def.endLine],
        parent: modIdx
      })
      local.push({ idx, def })
    }
    defsByFile.set(fileId, local)

    // containment: parent = smallest strictly-enclosing def, else the module
    for (const a of local) {
      let best: { idx: number; def: RawDef } | null = null
      for (const b of local) {
        if (a === b) continue
        if (
          b.def.startLine <= a.def.startLine &&
          b.def.endLine >= a.def.endLine &&
          (b.def.endLine - b.def.startLine > a.def.endLine - a.def.startLine ||
            (b.def.endLine - b.def.startLine === a.def.endLine - a.def.startLine && b.idx < a.idx))
        ) {
          if (!best || b.def.endLine - b.def.startLine < best.def.endLine - best.def.startLine) {
            best = b
          }
        }
      }
      if (best) symbols[a.idx].parent = best.idx
      edges.push({ src: symbols[a.idx].parent, dst: a.idx, kind: 'contains' })
    }
  }

  // name → def indices lookup per file for call matching
  const byName = new Map<FileId, Map<string, number[]>>()
  for (const [fileId, local] of defsByFile) {
    const m = new Map<string, number[]>()
    for (const { idx, def } of local) {
      const arr = m.get(def.name) ?? []
      arr.push(idx)
      m.set(def.name, arr)
    }
    byName.set(fileId, m)
  }

  const seen = new Set<number>()
  const addCall = (src: number, dst: number): void => {
    if (src === dst) return
    const key = src * 1_000_000 + dst
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ src, dst, kind: 'call' })
  }

  for (const fileId of fileIds) {
    const ex = extractions.get(fileId)
    if (!ex) continue
    const local = defsByFile.get(fileId) ?? []
    const containerOf = (line: number): number => {
      let best = moduleSymbol.get(fileId)!
      let bestSpan = Infinity
      for (const { idx, def } of local) {
        if (def.startLine <= line && def.endLine >= line) {
          const span = def.endLine - def.startLine
          if (span < bestSpan) {
            bestSpan = span
            best = idx
          }
        }
      }
      return best
    }
    const neighborFiles = [...(importNeighbors.get(fileId) ?? [])].filter((f) => included.has(f))
    for (const ref of ex.refs) {
      const src = containerOf(ref.line)
      const sameFile = byName.get(fileId)?.get(ref.name)
      if (sameFile?.length) {
        addCall(src, sameFile[0])
        continue
      }
      for (const nf of neighborFiles) {
        const hit = byName.get(nf)?.get(ref.name)
        if (hit?.length) {
          addCall(src, hit[0])
          break
        }
      }
    }
  }

  return { symbols, edges }
}
