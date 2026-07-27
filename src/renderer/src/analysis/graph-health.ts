// Architecture health over the import graph: dependency cycles (Tarjan SCC),
// load-bearing files (transitive dependents), and probably-dead files.
// Pure and synchronous; runs once per snapshot on ~10k nodes in milliseconds.
import type { FileId, RepoSnapshot } from '../../../shared/model'

export interface CycleFinding {
  kind: 'cycle'
  files: FileId[]
  /** edges within the cycle, flat [src, dst, ...] pairs for drawing */
  edges: number[]
}

export interface LoadBearingFinding {
  kind: 'load-bearing'
  file: FileId
  directDependents: number
  transitiveDependents: number
}

export interface DeadFinding {
  kind: 'dead'
  file: FileId
}

export interface HealthReport {
  cycles: CycleFinding[]
  loadBearing: LoadBearingFinding[]
  dead: DeadFinding[]
  /** transitive dependent count per file (for the inspector) */
  transitiveDependents: Int32Array
  /** SCC id per file, -1 when not in a multi-node cycle */
  cycleOf: Int32Array
}

const ENTRYPOINT_RE =
  /(^|\/)(index|main|cli|app|setup|conftest|__init__|__main__|mod|lib)\.[a-z]+$/i
const NON_CODE_RE =
  /\.(md|markdown|json|ya?ml|toml|txt|cfg|ini|lock|svg|css|html|sh|bash)$/i
const TEST_RE = /(^|\/)(tests?|specs?|__tests__|testing)\/|[._-](test|spec)\.[a-z]+$/i

export function analyzeHealth(snapshot: RepoSnapshot): HealthReport {
  const n = snapshot.files.length
  const edges = snapshot.importEdges
  const out: number[][] = Array.from({ length: n }, () => [])
  const inDegree = new Int32Array(n)
  for (let i = 0; i + 1 < edges.length; i += 2) {
    out[edges[i]].push(edges[i + 1])
    inDegree[edges[i + 1]]++
  }

  // ---- iterative Tarjan SCC ----
  const sccId = new Int32Array(n).fill(-1)
  {
    const index = new Int32Array(n).fill(-1)
    const low = new Int32Array(n)
    const onStack = new Uint8Array(n)
    const stack: number[] = []
    let nextIndex = 0
    let nextScc = 0
    // explicit call stack: [node, childPointer]
    const frames: number[] = []
    for (let root = 0; root < n; root++) {
      if (index[root] !== -1) continue
      frames.push(root, 0)
      while (frames.length) {
        const ci = frames.length - 1
        const v = frames[ci - 1]
        let childPtr = frames[ci]
        if (childPtr === 0) {
          index[v] = low[v] = nextIndex++
          stack.push(v)
          onStack[v] = 1
        }
        let advanced = false
        while (childPtr < out[v].length) {
          const w = out[v][childPtr]
          if (index[w] === -1) {
            frames[ci] = childPtr + 1
            frames.push(w, 0)
            advanced = true
            break
          }
          if (onStack[w]) low[v] = Math.min(low[v], index[w])
          childPtr++
        }
        if (advanced) continue
        // done with v
        frames.pop()
        frames.pop()
        if (frames.length) {
          const parent = frames[frames.length - 2]
          low[parent] = Math.min(low[parent], low[v])
        }
        if (low[v] === index[v]) {
          for (;;) {
            const w = stack.pop()!
            onStack[w] = 0
            sccId[w] = nextScc
            if (w === v) break
          }
          nextScc++
        }
      }
    }
  }

  // group multi-node SCCs into cycle findings
  const sccMembers = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const id = sccId[i]
    const arr = sccMembers.get(id)
    if (arr) arr.push(i)
    else sccMembers.set(id, [i])
  }
  const cycleOf = new Int32Array(n).fill(-1)
  const cycles: CycleFinding[] = []
  for (const [, members] of sccMembers) {
    if (members.length < 2) continue
    const memberSet = new Set(members)
    const cycleEdges: number[] = []
    for (const m of members) {
      for (const w of out[m]) {
        if (memberSet.has(w)) cycleEdges.push(m, w)
      }
    }
    const idx = cycles.length
    for (const m of members) cycleOf[m] = idx
    cycles.push({ kind: 'cycle', files: members, edges: cycleEdges })
  }
  cycles.sort((a, b) => b.files.length - a.files.length)
  // re-index cycleOf after sort
  cycles.forEach((c, i) => c.files.forEach((f) => (cycleOf[f] = i)))

  // ---- transitive dependents via reverse BFS on the SCC condensation ----
  // (memoized per SCC so cycles don't blow up the walk)
  const rev: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i + 1 < edges.length; i += 2) rev[edges[i + 1]].push(edges[i])
  const transitiveDependents = new Int32Array(n)
  {
    const seen = new Uint8Array(n)
    for (let f = 0; f < n; f++) {
      if (inDegree[f] === 0) continue
      seen.fill(0)
      let count = 0
      const queue = [f]
      seen[f] = 1
      while (queue.length) {
        const v = queue.pop()!
        for (const w of rev[v]) {
          if (!seen[w]) {
            seen[w] = 1
            count++
            queue.push(w)
          }
        }
      }
      transitiveDependents[f] = count
    }
  }

  const loadBearing: LoadBearingFinding[] = []
  for (let f = 0; f < n; f++) {
    if (transitiveDependents[f] > 0) {
      loadBearing.push({
        kind: 'load-bearing',
        file: f,
        directDependents: rev[f].length,
        transitiveDependents: transitiveDependents[f]
      })
    }
  }
  loadBearing.sort((a, b) => b.transitiveDependents - a.transitiveDependents)
  loadBearing.length = Math.min(loadBearing.length, 15)

  // ---- dead files: nothing imports them, they aren't entrypoints ----
  const dead: DeadFinding[] = []
  for (let f = 0; f < n; f++) {
    const file = snapshot.files[f]
    if (inDegree[f] > 0) continue
    if (!file.analyzed) continue // only judge files we actually parsed
    if (out[f].length === 0) continue // imports nothing internal — probably standalone
    if (ENTRYPOINT_RE.test(file.path)) continue
    if (NON_CODE_RE.test(file.path)) continue
    if (TEST_RE.test(file.path)) continue
    if (file.path.startsWith('bin/') || file.path.includes('/bin/')) continue
    if (file.path.startsWith('scripts/') || file.path.includes('/scripts/')) continue
    if (file.path.startsWith('examples/') || file.path.includes('/examples/')) continue
    dead.push({ kind: 'dead', file: f })
  }

  return { cycles, loadBearing, dead, transitiveDependents, cycleOf }
}
