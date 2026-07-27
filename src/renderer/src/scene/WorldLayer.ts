// Files + directories in 3D. One InstancedMesh of unit boxes for files, one
// for directory platforms. City ⇄ galaxy morphs by swapping per-instance
// target arrays; positions/scales exponentially smooth toward targets every
// frame, which doubles as the transition animation and the galaxy settle.
import * as THREE from 'three'
import { Text, type TextMesh } from '../troika'
import type { FileId, RepoSnapshot } from '../../../shared/model'
import { languageColor } from '../../../shared/languages'
import { layoutCity, type CityLayout } from './layout/treemap'
import type { ViewMode } from '../store'
import ForceWorker from './layout/force-worker?worker'

const MAX_BASE_EDGES = 4000
const GALAXY_RADIUS = 420
// centered galaxy floats above the ground plane
const GALAXY_Y = GALAXY_RADIUS * 0.75
const NEAR_LABEL_POOL = 40

interface WorldUniforms {
  uHeatGain: { value: number }
  uGlowAll: { value: number }
  uWindows: { value: number }
  uHeatColor: { value: THREE.Color }
}

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

export class WorldLayer {
  readonly group = new THREE.Group()
  private snapshot: RepoSnapshot | null = null
  private buildings: THREE.InstancedMesh | null = null
  private platforms: THREE.InstancedMesh | null = null
  private baseEdges: THREE.LineSegments | null = null
  private arcLines: THREE.LineSegments | null = null
  private districtEdges: THREE.LineSegments | null = null
  private labels: TextMesh[] = []
  private clusterLabels: TextMesh[] = []
  private nearLabels: TextMesh[] = []
  private worker: Worker | null = null

  private cityLayout: CityLayout | null = null
  private galaxyPos: Float32Array | null = null

  // per-file dynamic state
  private curPos!: Float32Array
  private curScale!: Float32Array
  private tgtPos!: Float32Array
  private tgtScale!: Float32Array
  private heightFactor!: Float32Array // timeline multiplier, 1 = HEAD
  private glow!: Float32Array
  private glowTarget!: Float32Array
  /** top-level dir id per file (galaxy cluster) */
  private clusterOf!: Int32Array
  // per-dir dynamic state
  private dCurScale!: Float32Array
  private dTgtScale!: Float32Array

  private mode: ViewMode = 'city'
  private settled = false
  /** 0 = city look, 1 = galaxy look; smoothed */
  private galaxyBlend = 0
  private galaxyBlendTarget = 0
  /** night-ness from the theme lerp (0 day … 1 night) */
  private windowStrength = 1
  private neighborsOf = new Map<FileId, Set<FileId>>()
  private heatAttr: THREE.InstancedBufferAttribute | null = null
  private glowAttr: THREE.InstancedBufferAttribute | null = null
  private shaderUniforms: WorldUniforms | null = null
  private tmpMatrix = new THREE.Matrix4()

  /** true while instances are still moving (used by SceneManager for labels) */
  get isAnimating(): boolean {
    return !this.settled
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    for (const label of [...this.labels, ...this.clusterLabels, ...this.nearLabels]) {
      label.dispose()
    }
    this.labels = []
    this.clusterLabels = []
    this.nearLabels = []
    this.group.clear()
    for (const mesh of [this.buildings, this.platforms]) {
      mesh?.geometry.dispose()
      ;(mesh?.material as THREE.Material | undefined)?.dispose()
    }
    this.baseEdges?.geometry.dispose()
    this.arcLines?.geometry.dispose()
    this.districtEdges?.geometry.dispose()
    ;(this.districtEdges?.material as THREE.Material | undefined)?.dispose()
    this.buildings = this.platforms = null
    this.baseEdges = this.arcLines = this.districtEdges = null
  }

  setSnapshot(snapshot: RepoSnapshot): void {
    this.dispose()
    this.snapshot = snapshot
    const n = snapshot.files.length
    this.cityLayout = layoutCity(snapshot)
    this.galaxyPos = null
    this.mode = 'city'
    this.galaxyBlend = 0
    this.galaxyBlendTarget = 0

    this.curPos = new Float32Array(n * 3)
    this.curScale = new Float32Array(n * 3)
    this.tgtPos = this.cityLayout.filePos.slice()
    this.tgtScale = this.cityLayout.fileScale.slice()
    this.curPos.set(this.tgtPos)
    // buildings grow from the ground on load
    for (let i = 0; i < n; i++) {
      this.curScale[i * 3] = this.tgtScale[i * 3]
      this.curScale[i * 3 + 1] = 0.01
      this.curScale[i * 3 + 2] = this.tgtScale[i * 3 + 2]
    }
    this.heightFactor = new Float32Array(n).fill(1)
    this.glow = new Float32Array(n)
    this.glowTarget = new Float32Array(n)
    this.clusterOf = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      let d = snapshot.files[i].dir
      while (snapshot.dirs[d].parent > 0) d = snapshot.dirs[d].parent
      this.clusterOf[i] = d
    }

    // ---- buildings ----
    const boxGeo = new THREE.BoxGeometry(1, 1, 1)
    boxGeo.translate(0, 0.5, 0)
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.55,
      metalness: 0.15
    })
    const heat = new Float32Array(n)
    const rand = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      heat[i] = snapshot.files[i].churn.heat
      rand[i] = hash01(snapshot.files[i].path)
    }
    this.heatAttr = new THREE.InstancedBufferAttribute(heat, 1)
    this.glowAttr = new THREE.InstancedBufferAttribute(this.glow, 1)
    this.patchMaterial(mat, boxGeo, new THREE.InstancedBufferAttribute(rand, 1))
    this.buildings = new THREE.InstancedMesh(boxGeo, mat, n)
    this.buildings.frustumCulled = false
    const color = new THREE.Color()
    for (let i = 0; i < n; i++) {
      color.set(languageColor(snapshot.files[i].language))
      this.buildings.setColorAt(i, color)
    }
    this.buildings.instanceColor!.needsUpdate = true
    this.group.add(this.buildings)

    // ---- platforms ----
    const dn = snapshot.dirs.length
    this.dCurScale = this.cityLayout.dirScale.slice()
    this.dTgtScale = this.cityLayout.dirScale.slice()
    const platGeo = new THREE.BoxGeometry(1, 1, 1)
    platGeo.translate(0, -0.5, 0)
    const platMat = new THREE.MeshStandardMaterial({
      color: 0x1d2736,
      roughness: 0.9,
      metalness: 0.05
    })
    this.platforms = new THREE.InstancedMesh(platGeo, platMat, dn)
    this.platforms.frustumCulled = false
    this.group.add(this.platforms)

    // ---- baseline edges ----
    const edgeCount = Math.min(snapshot.importEdges.length / 2, MAX_BASE_EDGES)
    if (edgeCount > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeCount * 6), 3))
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x3b82f6,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      this.baseEdges = new THREE.LineSegments(geo, edgeMat)
      this.baseEdges.frustumCulled = false
      this.group.add(this.baseEdges)
    }

    // ---- neighbor map for hover arcs ----
    this.neighborsOf.clear()
    const edges = snapshot.importEdges
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const a = edges[i]
      const b = edges[i + 1]
      if (!this.neighborsOf.has(a)) this.neighborsOf.set(a, new Set())
      if (!this.neighborsOf.has(b)) this.neighborsOf.set(b, new Set())
      this.neighborsOf.get(a)!.add(b)
      this.neighborsOf.get(b)!.add(a)
    }

    // ---- district labels + neon top-edge accents + galaxy cluster labels ----
    const topDirs = snapshot.dirs
      .map((_d, id) => ({
        id,
        area: this.cityLayout!.dirScale[id * 3] * this.cityLayout!.dirScale[id * 3 + 2]
      }))
      .filter((d) => d.id !== 0 && snapshot.dirs[d.id].parent === 0)
      .sort((a, b) => b.area - a.area)
      .slice(0, 24)
    const accentVerts: number[] = []
    for (const { id } of topDirs) {
      const label = new Text()
      label.text = snapshot.dirs[id].name
      label.fontSize = 11
      label.color = 0x9db4d0
      label.outlineWidth = 0.6
      label.outlineColor = 0x000000
      label.anchorX = 'center'
      label.position.set(
        this.cityLayout.dirPos[id * 3],
        this.cityLayout.dirPos[id * 3 + 1] + 2.5,
        this.cityLayout.dirPos[id * 3 + 2] - this.cityLayout.dirScale[id * 3 + 2] / 2 + 4
      )
      label.rotation.x = -Math.PI / 2
      label.sync()
      this.labels.push(label)
      this.group.add(label)

      // rectangle of the district's top face, slightly raised
      const cx = this.cityLayout.dirPos[id * 3]
      const y = this.cityLayout.dirPos[id * 3 + 1] + 0.08
      const cz = this.cityLayout.dirPos[id * 3 + 2]
      const hw = this.cityLayout.dirScale[id * 3] / 2
      const hd = this.cityLayout.dirScale[id * 3 + 2] / 2
      const corners = [
        [cx - hw, y, cz - hd],
        [cx + hw, y, cz - hd],
        [cx + hw, y, cz + hd],
        [cx - hw, y, cz + hd]
      ]
      for (let c = 0; c < 4; c++) {
        accentVerts.push(...corners[c], ...corners[(c + 1) % 4])
      }

      const cluster = new Text()
      cluster.text = snapshot.dirs[id].name
      cluster.fontSize = 30
      cluster.color = 0xd6e6fa
      cluster.outlineWidth = 1.6
      cluster.outlineColor = 0x000000
      cluster.anchorX = 'center'
      cluster.visible = false
      cluster.userData.dirId = id
      cluster.renderOrder = 10
      cluster.sync(() => {
        // overlay text: ignore fog and depth so names read through the cloud
        const m = cluster.material as THREE.Material & { fog?: boolean }
        if (m) {
          m.depthTest = false
          m.fog = false
        }
      })
      this.clusterLabels.push(cluster)
      this.group.add(cluster)
    }
    if (accentVerts.length) {
      const accGeo = new THREE.BufferGeometry()
      accGeo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(accentVerts), 3))
      this.districtEdges = new THREE.LineSegments(
        accGeo,
        new THREE.LineBasicMaterial({
          color: 0x4f8fe8,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      )
      this.districtEdges.frustumCulled = false
      this.group.add(this.districtEdges)
    }

    // ---- proximity file-name label pool ----
    for (let i = 0; i < NEAR_LABEL_POOL; i++) {
      const label = new Text()
      label.fontSize = 3.4
      label.color = 0xe2ecf8
      label.outlineWidth = 0.3
      label.outlineColor = 0x000000
      label.anchorX = 'center'
      label.visible = false
      this.nearLabels.push(label)
      this.group.add(label)
    }

    this.settled = false
    this.startGalaxyLayout()
  }

  private patchMaterial(
    mat: THREE.MeshStandardMaterial,
    geo: THREE.BufferGeometry,
    randAttr: THREE.InstancedBufferAttribute
  ): void {
    geo.setAttribute('aHeat', this.heatAttr!)
    geo.setAttribute('aGlow', this.glowAttr!)
    geo.setAttribute('aRand', randAttr)
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHeatGain = { value: 0.55 }
      shader.uniforms.uGlowAll = { value: 0.0 } // >0 in galaxy: everything glows
      shader.uniforms.uWindows = { value: 0.0 } // night-city lit windows
      shader.uniforms.uHeatColor = { value: new THREE.Color(1.0, 0.42, 0.12) }
      this.shaderUniforms = shader.uniforms as unknown as WorldUniforms
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aHeat;
          attribute float aGlow;
          attribute float aRand;
          varying float vHeat;
          varying float vGlow;
          varying float vRand;
          varying vec2 vFacePos;
          varying float vSide;
          varying float vWinFade;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vHeat = aHeat;
          vGlow = aGlow;
          vRand = aRand;
          #ifdef USE_INSTANCING
            vec3 iScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          #else
            vec3 iScale = vec3(1.0);
          #endif
          vec3 an = abs(normal);
          vSide = 1.0 - step(0.5, an.y);
          vFacePos = an.x > 0.5
            ? vec2(position.z * iScale.z, position.y * iScale.y)
            : vec2(position.x * iScale.x, position.y * iScale.y);
          vWinFade = smoothstep(4.0, 9.0, iScale.y) * smoothstep(1.2, 2.5, min(iScale.x, iScale.z));`
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uHeatGain;
          uniform float uGlowAll;
          uniform float uWindows;
          uniform vec3 uHeatColor;
          varying float vHeat;
          varying float vGlow;
          varying float vRand;
          varying vec2 vFacePos;
          varying float vSide;
          varying float vWinFade;`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += uHeatColor * vHeat * vHeat * uHeatGain;
          #ifdef USE_INSTANCING_COLOR
          totalEmissiveRadiance += vColor * (uGlowAll + vGlow * 1.6);
          #else
          totalEmissiveRadiance += vec3(1.0) * vGlow * 1.2;
          #endif
          // procedural lit windows (world-unit grid, night city only)
          if (uWindows > 0.003 && vSide > 0.5 && vWinFade > 0.01) {
            vec2 wc = vFacePos / vec2(1.7, 2.4);
            vec2 cell = floor(wc);
            vec2 f = fract(wc);
            float pane = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.72);
            float h = fract(sin(dot(cell + vRand * 71.3, vec2(12.9898, 78.233))) * 43758.5453);
            float lit = step(0.62 - vHeat * 0.35, h);
            vec3 winCol = mix(vec3(1.0, 0.82, 0.55), vec3(0.72, 0.84, 1.0), step(0.5, fract(h * 5.0)));
            float aa = 1.0 - smoothstep(0.35, 1.0, fwidth(wc.y));
            totalEmissiveRadiance += winCol * pane * lit * (0.55 + 0.9 * fract(h * 3.0)) * uWindows * vWinFade * aa;
          }`
        )
    }
  }

  private startGalaxyLayout(): void {
    if (!this.snapshot) return
    const snapshot = this.snapshot
    const n = snapshot.files.length
    const weights = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      weights[i] = Math.sqrt(Math.max(1, snapshot.files[i].loc))
    }
    this.worker?.terminate()
    this.worker = new ForceWorker()
    this.worker.onmessage = (e: MessageEvent<{ positions: Float32Array; done: boolean }>) => {
      this.galaxyPos = e.data.positions
      if (this.mode === 'galaxy') this.applyModeTargets()
      if (e.data.done) {
        this.worker?.terminate()
        this.worker = null
      }
    }
    this.worker.postMessage({
      n,
      edges: Array.from(snapshot.importEdges),
      weights,
      clusters: this.clusterOf,
      radius: GALAXY_RADIUS,
      ticks: 280
    })
  }

  setMode(mode: ViewMode): void {
    if (mode === 'molecule') {
      this.group.visible = false
      return
    }
    this.group.visible = true
    this.mode = mode
    this.applyModeTargets()
  }

  /** night-ness (0 day … 1 night), from SceneManager's theme lerp */
  setWindowStrength(v: number): void {
    this.windowStrength = v
  }

  /** recolor + re-glow every building from a computed lens result */
  applyLens(colors: Float32Array, emissive: Float32Array, emissiveColor: string): void {
    if (!this.buildings || !this.snapshot) return
    const instColor = this.buildings.instanceColor
    if (instColor) {
      ;(instColor.array as Float32Array).set(colors)
      instColor.needsUpdate = true
    }
    if (this.heatAttr) {
      ;(this.heatAttr.array as Float32Array).set(emissive)
      this.heatAttr.needsUpdate = true
    }
    this.shaderUniforms?.uHeatColor.value.set(emissiveColor)
  }

  private applyModeTargets(): void {
    if (!this.snapshot || !this.cityLayout) return
    const n = this.snapshot.files.length
    const galaxy = this.mode === 'galaxy'
    this.galaxyBlendTarget = galaxy ? 1 : 0
    if (galaxy && this.galaxyPos) {
      for (let i = 0; i < n; i++) {
        this.tgtPos[i * 3] = this.galaxyPos[i * 3]
        this.tgtPos[i * 3 + 1] = this.galaxyPos[i * 3 + 1] + GALAXY_Y
        this.tgtPos[i * 3 + 2] = this.galaxyPos[i * 3 + 2]
        const s = 1.2 + Math.sqrt(Math.max(1, this.snapshot.files[i].loc)) * 0.28
        this.tgtScale[i * 3] = s
        this.tgtScale[i * 3 + 1] = s
        this.tgtScale[i * 3 + 2] = s
      }
    } else if (!galaxy) {
      this.tgtPos.set(this.cityLayout.filePos)
      this.tgtScale.set(this.cityLayout.fileScale)
    }
    // platforms flatten away in galaxy
    this.dTgtScale.set(this.cityLayout.dirScale)
    if (galaxy) {
      for (let i = 0; i < this.snapshot.dirs.length; i++) this.dTgtScale[i * 3 + 1] = 0.001
    }
    for (const label of this.labels) label.visible = !galaxy
    for (const label of this.clusterLabels) label.visible = galaxy
    if (this.baseEdges) {
      const m = this.baseEdges.material as THREE.LineBasicMaterial
      m.opacity = galaxy ? 0.14 : 0.0
    }
    this.hideNearLabels()
    this.settled = false
  }

  /** outlier-robust bounding sphere of the current mode's TARGET layout */
  getBounds(): { center: THREE.Vector3; radius: number } {
    if (!this.snapshot) return { center: new THREE.Vector3(), radius: 500 }
    const n = this.snapshot.files.length
    // mean center
    let mx = 0
    let my = 0
    let mz = 0
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      mx += this.tgtPos[i3]
      my += this.tgtPos[i3 + 1] + this.tgtScale[i3 + 1] / 2
      mz += this.tgtPos[i3 + 2]
    }
    mx /= n
    my /= n
    mz /= n
    // 94th-percentile distance (sampled) so a few flung outliers don't
    // balloon the frame; padding covers the tail
    const stride = Math.max(1, Math.floor(n / 1500))
    const dists: number[] = []
    for (let i = 0; i < n; i += stride) {
      const i3 = i * 3
      const dx = this.tgtPos[i3] - mx
      const dy = this.tgtPos[i3 + 1] + this.tgtScale[i3 + 1] / 2 - my
      const dz = this.tgtPos[i3 + 2] - mz
      dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz))
    }
    dists.sort((a, b) => a - b)
    const p94 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.94))] ?? 500
    const radius = Math.max(50, p94 * 1.25)
    return { center: new THREE.Vector3(mx, my, mz), radius }
  }

  /** pleasant fly-to distance for one file, from its target footprint */
  focusDistance(fileId: FileId): number {
    const i3 = fileId * 3
    const diag = Math.sqrt(
      this.tgtScale[i3] ** 2 + this.tgtScale[i3 + 1] ** 2 + this.tgtScale[i3 + 2] ** 2
    )
    return THREE.MathUtils.clamp(diag * 6, 40, 250)
  }

  setTimeFactors(factors: Float32Array | null): void {
    if (!this.snapshot) return
    if (factors) this.heightFactor.set(factors)
    else this.heightFactor.fill(1)
    this.settled = false
  }

  setHighlight(fileId: FileId | null, selectedId: FileId | null): void {
    this.glowTarget.fill(0)
    const light = (id: FileId | null, amount: number): void => {
      if (id === null || !this.snapshot) return
      this.glowTarget[id] = Math.max(this.glowTarget[id], amount)
      for (const nb of this.neighborsOf.get(id) ?? []) {
        this.glowTarget[nb] = Math.max(this.glowTarget[nb], amount * 0.45)
      }
    }
    light(selectedId, 0.9)
    light(fileId, 0.7)
    this.rebuildArcs(fileId ?? selectedId)
    this.settled = false
  }

  private rebuildArcs(fileId: FileId | null): void {
    if (this.arcLines) {
      this.group.remove(this.arcLines)
      this.arcLines.geometry.dispose()
      ;(this.arcLines.material as THREE.Material).dispose()
      this.arcLines = null
    }
    if (fileId === null || !this.snapshot) return
    const neighbors = [...(this.neighborsOf.get(fileId) ?? [])]
    if (!neighbors.length) return
    const SEGMENTS = 24
    const positions = new Float32Array(neighbors.length * SEGMENTS * 6)
    let o = 0
    const from = this.currentTop(fileId)
    for (const nb of neighbors) {
      const to = this.currentTop(nb)
      const mid = from.clone().add(to).multiplyScalar(0.5)
      mid.y += from.distanceTo(to) * 0.35 + 14
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to)
      const pts = curve.getPoints(SEGMENTS)
      for (let i = 0; i < SEGMENTS; i++) {
        positions[o++] = pts[i].x
        positions[o++] = pts[i].y
        positions[o++] = pts[i].z
        positions[o++] = pts[i + 1].x
        positions[o++] = pts[i + 1].y
        positions[o++] = pts[i + 1].z
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    this.arcLines = new THREE.LineSegments(geo, mat)
    this.arcLines.frustumCulled = false
    this.group.add(this.arcLines)
  }

  /** current world position of a file's visual center-top (for arcs/flyTo) */
  currentTop(fileId: FileId): THREE.Vector3 {
    const i = fileId * 3
    return new THREE.Vector3(
      this.curPos[i],
      this.curPos[i + 1] + this.curScale[i + 1] * (this.mode === 'city' ? 1 : 0.5),
      this.curPos[i + 2]
    )
  }

  raycast(raycaster: THREE.Raycaster): FileId | null {
    if (!this.buildings || !this.group.visible) return null
    const hits = raycaster.intersectObject(this.buildings, false)
    return hits.length ? (hits[0].instanceId ?? null) : null
  }

  /** show file-name labels for the nearest buildings; call on camera idle */
  refreshNearLabels(camera: THREE.Camera, worldRadius: number): void {
    if (!this.snapshot || !this.group.visible) {
      this.hideNearLabels()
      return
    }
    const n = this.snapshot.files.length
    const cx = camera.position.x
    const cy = camera.position.y
    const cz = camera.position.z
    const maxDist = worldRadius * 0.35
    const maxDistSq = maxDist * maxDist
    const candidates: { id: number; d: number }[] = []
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      if (this.curScale[i3 + 1] < 2) continue
      const dx = this.curPos[i3] - cx
      const dy = this.curPos[i3 + 1] - cy
      const dz = this.curPos[i3 + 2] - cz
      const d = dx * dx + dy * dy + dz * dz
      if (d < maxDistSq) candidates.push({ id: i, d })
    }
    candidates.sort((a, b) => a.d - b.d)
    const galaxy = this.galaxyBlend > 0.5
    for (let li = 0; li < this.nearLabels.length; li++) {
      const label = this.nearLabels[li]
      const pick = candidates[li]
      if (!pick) {
        label.visible = false
        continue
      }
      const i3 = pick.id * 3
      const dist = Math.sqrt(pick.d)
      label.text = this.snapshot.files[pick.id].name
      label.fontSize = THREE.MathUtils.clamp(dist * 0.028, 1.6, 8)
      label.position.set(
        this.curPos[i3],
        this.curPos[i3 + 1] + this.curScale[i3 + 1] + (galaxy ? 4 : 2.2),
        this.curPos[i3 + 2]
      )
      label.quaternion.copy(camera.quaternion)
      label.visible = true
      label.sync()
    }
  }

  hideNearLabels(): void {
    for (const label of this.nearLabels) label.visible = false
  }

  update(dt: number, camera: THREE.Camera): void {
    if (!this.snapshot || !this.buildings || !this.platforms) return
    const k = 1 - Math.pow(0.002, dt) // smoothing toward targets

    // cheap scalar lerps run every frame, even when instances are settled
    const blendDelta = this.galaxyBlendTarget - this.galaxyBlend
    this.galaxyBlend += blendDelta * k
    if (Math.abs(blendDelta) > 0.001) this.settled = false
    if (this.shaderUniforms) {
      this.shaderUniforms.uGlowAll.value = 0.55 * this.galaxyBlend
      this.shaderUniforms.uWindows.value = this.windowStrength * (1 - this.galaxyBlend)
    }
    if (this.districtEdges) {
      const m = this.districtEdges.material as THREE.LineBasicMaterial
      m.opacity = (0.25 + 0.3 * this.windowStrength) * (1 - this.galaxyBlend)
    }

    // galaxy cluster labels track their cluster centroids (billboarded)
    if (this.galaxyBlend > 0.4 && this.clusterLabels.length) {
      const sums = new Map<number, { x: number; y: number; z: number; c: number }>()
      for (let i = 0; i < this.snapshot.files.length; i++) {
        const cId = this.clusterOf[i]
        let s = sums.get(cId)
        if (!s) sums.set(cId, (s = { x: 0, y: 0, z: 0, c: 0 }))
        const i3 = i * 3
        s.x += this.curPos[i3]
        s.y += this.curPos[i3 + 1]
        s.z += this.curPos[i3 + 2]
        s.c++
      }
      for (const label of this.clusterLabels) {
        const s = sums.get(label.userData.dirId as number)
        if (!s || !s.c) continue
        label.position.set(s.x / s.c, s.y / s.c + 46, s.z / s.c)
        label.quaternion.copy(camera.quaternion)
      }
    }

    if (this.settled) return
    const n = this.snapshot.files.length
    let maxDelta = 0

    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      const hf = this.heightFactor[i]
      for (let a = 0; a < 3; a++) {
        const dp = this.tgtPos[i3 + a] - this.curPos[i3 + a]
        this.curPos[i3 + a] += dp * k
        let target = this.tgtScale[i3 + a]
        if (hf !== 1) {
          // timeline shrink: city shrinks height, galaxy shrinks all axes
          if (this.mode === 'galaxy' || a === 1) target *= Math.max(0.002, hf)
        }
        const ds = target - this.curScale[i3 + a]
        this.curScale[i3 + a] += ds * k
        maxDelta = Math.max(maxDelta, Math.abs(dp), Math.abs(ds))
      }
      const dg = this.glowTarget[i] - this.glow[i]
      this.glow[i] += dg * k
      maxDelta = Math.max(maxDelta, Math.abs(dg))
      this.tmpMatrix.makeScale(
        Math.max(0.001, this.curScale[i3]),
        Math.max(0.001, this.curScale[i3 + 1]),
        Math.max(0.001, this.curScale[i3 + 2])
      )
      this.tmpMatrix.setPosition(this.curPos[i3], this.curPos[i3 + 1], this.curPos[i3 + 2])
      this.buildings.setMatrixAt(i, this.tmpMatrix)
    }
    this.buildings.instanceMatrix.needsUpdate = true
    if (this.glowAttr) this.glowAttr.needsUpdate = true

    const dn = this.snapshot.dirs.length
    for (let i = 0; i < dn; i++) {
      const i3 = i * 3
      for (let a = 0; a < 3; a++) {
        const ds = this.dTgtScale[i3 + a] - this.dCurScale[i3 + a]
        this.dCurScale[i3 + a] += ds * k
        maxDelta = Math.max(maxDelta, Math.abs(ds))
      }
      this.tmpMatrix.makeScale(
        Math.max(0.001, this.dCurScale[i3]),
        Math.max(0.001, this.dCurScale[i3 + 1]),
        Math.max(0.001, this.dCurScale[i3 + 2])
      )
      this.tmpMatrix.setPosition(
        this.cityLayout!.dirPos[i3],
        this.cityLayout!.dirPos[i3 + 1],
        this.cityLayout!.dirPos[i3 + 2]
      )
      this.platforms.setMatrixAt(i, this.tmpMatrix)
    }
    this.platforms.instanceMatrix.needsUpdate = true

    // baseline edges follow current positions
    if (this.baseEdges) {
      const pos = this.baseEdges.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      const edges = this.snapshot.importEdges
      const count = Math.min(edges.length / 2, MAX_BASE_EDGES)
      for (let e = 0; e < count; e++) {
        const a3 = edges[e * 2] * 3
        const b3 = edges[e * 2 + 1] * 3
        const o = e * 6
        arr[o] = this.curPos[a3]
        arr[o + 1] = this.curPos[a3 + 1] + this.curScale[a3 + 1] * 0.5
        arr[o + 2] = this.curPos[a3 + 2]
        arr[o + 3] = this.curPos[b3]
        arr[o + 4] = this.curPos[b3 + 1] + this.curScale[b3 + 1] * 0.5
        arr[o + 5] = this.curPos[b3 + 2]
      }
      pos.needsUpdate = true
    }

    if (maxDelta < 0.003 && Math.abs(blendDelta) < 0.002) this.settled = true
  }
}
