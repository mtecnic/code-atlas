// Web Worker: 3D force-directed layout via d3-force-3d. Posts Float32Array
// position frames (transferable) every few ticks so the scene settles visibly.
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceX,
  forceY,
  forceZ
} from 'd3-force-3d'

export interface ForceRequest {
  /** node count */
  n: number
  /** flat pairs [src, dst, ...] */
  edges: ArrayLike<number>
  /** node weight (e.g. sqrt loc) for charge/size */
  weights: Float32Array
  /** cluster id per node (e.g. top-level dir); -1 = none */
  clusters: Int32Array
  /** spread radius */
  radius: number
  ticks: number
}

interface SimNode {
  index?: number
  x?: number
  y?: number
  z?: number
}

self.onmessage = (e: MessageEvent<ForceRequest>) => {
  const { n, edges, weights, clusters, radius, ticks } = e.data

  // deterministic-ish golden-spiral seeding, jittered per cluster
  const clusterCenters = new Map<number, [number, number, number]>()
  const uniqueClusters = [...new Set(Array.from(clusters))].filter((c) => c >= 0)
  uniqueClusters.forEach((c, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / Math.max(1, uniqueClusters.length))
    const theta = Math.PI * (1 + Math.sqrt(5)) * i
    clusterCenters.set(c, [
      radius * 0.6 * Math.sin(phi) * Math.cos(theta),
      radius * 0.6 * Math.cos(phi),
      radius * 0.6 * Math.sin(phi) * Math.sin(theta)
    ])
  })

  const nodes: SimNode[] = []
  for (let i = 0; i < n; i++) {
    const c = clusterCenters.get(clusters[i]) ?? [0, 0, 0]
    const a = (i * 2.399963) % (Math.PI * 2)
    const r = radius * 0.25 * Math.sqrt((i % 97) / 97)
    nodes.push({ x: c[0] + r * Math.cos(a), y: c[1] + (i % 13) - 6, z: c[2] + r * Math.sin(a) })
  }
  const links: { source: number; target: number }[] = []
  for (let i = 0; i + 1 < edges.length; i += 2) {
    links.push({ source: edges[i], target: edges[i + 1] })
  }

  const sim = forceSimulation(nodes, 3)
    .force(
      'charge',
      forceManyBody()
        .strength((_d: SimNode, i: number) => -4 - weights[i] * 2)
        .distanceMax(radius * 0.9) // stop unconnected nodes being flung to infinity
    )
    .force(
      'link',
      forceLink(links)
        .distance(radius * 0.08)
        .strength(0.4)
    )
    .force('center', forceCenter(0, 0, 0))
    .force('cx', forceX((d: SimNode) => clusterCenters.get(clusters[d.index!])?.[0] ?? 0).strength(0.08))
    .force('cy', forceY((d: SimNode) => clusterCenters.get(clusters[d.index!])?.[1] ?? 0).strength(0.08))
    .force('cz', forceZ((d: SimNode) => clusterCenters.get(clusters[d.index!])?.[2] ?? 0).strength(0.08))
    .stop()

  const send = (done: boolean): void => {
    // recenter on the weight-weighted centroid so the visual mass sits at the
    // origin (presentation-only; simulation coordinates untouched)
    let cx = 0
    let cy = 0
    let cz = 0
    let wsum = 0
    for (let i = 0; i < n; i++) {
      const w = weights[i] || 1
      cx += (nodes[i].x ?? 0) * w
      cy += (nodes[i].y ?? 0) * w
      cz += (nodes[i].z ?? 0) * w
      wsum += w
    }
    cx /= wsum
    cy /= wsum
    cz /= wsum
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      out[i * 3] = (nodes[i].x ?? 0) - cx
      out[i * 3 + 1] = (nodes[i].y ?? 0) - cy
      out[i * 3 + 2] = (nodes[i].z ?? 0) - cz
    }
    ;(self as unknown as Worker).postMessage({ positions: out, done }, [out.buffer])
  }

  for (let t = 0; t < ticks; t++) {
    sim.tick()
    if (t % 4 === 3) send(false)
  }
  send(true)
}
