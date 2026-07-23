// Symbol-level molecule: atoms = functions/classes/variables, bonds =
// contains/call edges. Laid out by the same force worker, small scale.
import * as THREE from 'three'
import { Text, type TextMesh } from '../troika'
import type { ModuleGraph, SymbolKind } from '../../../shared/model'
import ForceWorker from './layout/force-worker?worker'

const KIND_COLOR: Record<SymbolKind, number> = {
  module: 0xf59e0b,
  function: 0x38bdf8,
  method: 0x818cf8,
  class: 0xf472b6,
  type: 0x2dd4bf,
  variable: 0x9ca3af
}

const KIND_SIZE: Record<SymbolKind, number> = {
  module: 10,
  class: 7,
  function: 5,
  method: 4.2,
  type: 4.5,
  variable: 3
}

export class MoleculeLayer {
  readonly group = new THREE.Group()
  private atoms: THREE.InstancedMesh | null = null
  private bonds: THREE.LineSegments | null = null
  private labels: TextMesh[] = []
  private worker: Worker | null = null
  private graph: ModuleGraph | null = null
  private positions: Float32Array | null = null
  private current: Float32Array | null = null
  private settled = true
  private tmpMatrix = new THREE.Matrix4()

  constructor() {
    this.group.visible = false
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    for (const l of this.labels) l.dispose()
    this.labels = []
    this.group.clear()
    this.atoms?.geometry.dispose()
    ;(this.atoms?.material as THREE.Material | undefined)?.dispose()
    this.bonds?.geometry.dispose()
    ;(this.bonds?.material as THREE.Material | undefined)?.dispose()
    this.atoms = this.bonds = null
    this.graph = null
    this.positions = this.current = null
  }

  show(graph: ModuleGraph): void {
    this.dispose()
    this.graph = graph
    this.group.visible = true
    const n = graph.symbols.length
    if (!n) return

    const geo = new THREE.IcosahedronGeometry(1, 2)
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.35,
      metalness: 0.1,
      emissiveIntensity: 1
    })
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef USE_INSTANCING_COLOR
        totalEmissiveRadiance += vColor * 0.55;
        #endif`
      )
    }
    this.atoms = new THREE.InstancedMesh(geo, mat, n)
    this.atoms.frustumCulled = false
    const color = new THREE.Color()
    for (let i = 0; i < n; i++) {
      color.set(KIND_COLOR[graph.symbols[i].kind])
      this.atoms.setColorAt(i, color)
    }
    this.atoms.instanceColor!.needsUpdate = true
    this.group.add(this.atoms)

    const bondPairs: number[] = []
    for (const e of graph.edges) bondPairs.push(e.src, e.dst)
    const bondGeo = new THREE.BufferGeometry()
    bondGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(graph.edges.length * 6), 3)
    )
    this.bonds = new THREE.LineSegments(
      bondGeo,
      new THREE.LineBasicMaterial({
        color: 0x93c5fd,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    )
    this.bonds.frustumCulled = false
    this.group.add(this.bonds)

    // labels for the biggest symbols
    const labeled = graph.symbols
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.kind !== 'variable')
      .slice(0, 60)
    for (const { s, i } of labeled) {
      const label = new Text()
      label.text = s.name
      label.fontSize = 3.2
      label.color = 0xd8e6f5
      label.outlineWidth = 0.25
      label.outlineColor = 0x000000
      label.anchorX = 'center'
      label.userData.symbolIndex = i
      label.sync()
      this.labels.push(label)
      this.group.add(label)
    }

    this.current = new Float32Array(n * 3)
    this.worker = new ForceWorker()
    this.worker.onmessage = (e: MessageEvent<{ positions: Float32Array; done: boolean }>) => {
      this.positions = e.data.positions
      this.settled = false
      if (e.data.done) {
        this.worker?.terminate()
        this.worker = null
      }
    }
    const weights = new Float32Array(n)
    const clusters = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      weights[i] = KIND_SIZE[graph.symbols[i].kind]
      let p = i
      while (graph.symbols[p].parent !== -1) p = graph.symbols[p].parent
      clusters[i] = p
    }
    this.worker.postMessage({
      n,
      edges: bondPairs,
      weights,
      clusters,
      radius: 160,
      ticks: 240
    })
  }

  hide(): void {
    this.group.visible = false
    this.dispose()
  }

  /** bounding sphere of the molecule (worker positions + y offset) */
  getBounds(): { center: THREE.Vector3; radius: number } {
    const fallback = { center: new THREE.Vector3(0, 100, 0), radius: 170 }
    if (!this.graph || !this.positions) return fallback
    const n = this.graph.symbols.length
    if (!n) return fallback
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      minX = Math.min(minX, this.positions[i3])
      maxX = Math.max(maxX, this.positions[i3])
      minY = Math.min(minY, this.positions[i3 + 1])
      maxY = Math.max(maxY, this.positions[i3 + 1])
      minZ = Math.min(minZ, this.positions[i3 + 2])
      maxZ = Math.max(maxZ, this.positions[i3 + 2])
    }
    const center = new THREE.Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2 + 100,
      (minZ + maxZ) / 2
    )
    const radius = Math.max(
      60,
      Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) / 2 + 12
    )
    return { center, radius }
  }

  /** true once the force worker has delivered its final frame */
  get isSettledLayout(): boolean {
    return this.worker === null && this.positions !== null
  }

  raycastSymbol(raycaster: THREE.Raycaster): number | null {
    if (!this.atoms || !this.group.visible) return null
    const hits = raycaster.intersectObject(this.atoms, false)
    return hits.length ? (hits[0].instanceId ?? null) : null
  }

  update(dt: number, camera: THREE.Camera): void {
    if (!this.group.visible || !this.graph || !this.atoms || !this.positions || !this.current)
      return
    if (this.settled) return
    const n = this.graph.symbols.length
    const k = 1 - Math.pow(0.001, dt)
    let maxDelta = 0
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      for (let a = 0; a < 3; a++) {
        const d = this.positions[i3 + a] - this.current[i3 + a]
        this.current[i3 + a] += d * k
        maxDelta = Math.max(maxDelta, Math.abs(d))
      }
      const size = KIND_SIZE[this.graph.symbols[i].kind]
      this.tmpMatrix.makeScale(size, size, size)
      this.tmpMatrix.setPosition(
        this.current[i3],
        this.current[i3 + 1] + 100,
        this.current[i3 + 2]
      )
      this.atoms.setMatrixAt(i, this.tmpMatrix)
    }
    this.atoms.instanceMatrix.needsUpdate = true

    if (this.bonds) {
      const attr = this.bonds.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      this.graph.edges.forEach((e, idx) => {
        const a3 = e.src * 3
        const b3 = e.dst * 3
        const o = idx * 6
        arr[o] = this.current![a3]
        arr[o + 1] = this.current![a3 + 1] + 100
        arr[o + 2] = this.current![a3 + 2]
        arr[o + 3] = this.current![b3]
        arr[o + 4] = this.current![b3 + 1] + 100
        arr[o + 5] = this.current![b3 + 2]
      })
      attr.needsUpdate = true
    }

    for (const label of this.labels) {
      const i3 = (label.userData.symbolIndex as number) * 3
      const size = KIND_SIZE[this.graph.symbols[label.userData.symbolIndex as number].kind]
      label.position.set(
        this.current[i3],
        this.current[i3 + 1] + 100 + size + 2.5,
        this.current[i3 + 2]
      )
      label.quaternion.copy(camera.quaternion)
    }
    if (maxDelta < 0.01 && !this.worker) this.settled = true
  }
}
