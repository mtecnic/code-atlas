// Owns the renderer, postprocessing, atmosphere, layers, picking, minimap and
// the frame loop. Reacts to zustand store changes; emits hover/select back.
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { RepoSnapshot } from '../../../shared/model'
import { useAtlas, type Theme, type ViewMode } from '../store'
import { enterMoleculeFor } from '../molecule'
import { computeLens } from '../lenses'
import { WorldLayer } from './WorldLayer'
import { MoleculeLayer } from './MoleculeLayer'
import { CameraRig } from './CameraRig'
import { TimeMachine } from './TimeMachine'

interface ThemePreset {
  bg: THREE.Color
  fogDensity: number
  hemi: number
  sun: number
  bloom: number
  particles: number
  night: number // 1 = night (drives windows), 0 = day
  gridOpacity: number
  ground: THREE.Color
  skyZenith: THREE.Color
  skyHorizon: THREE.Color
  skyGround: THREE.Color
}

const THEMES: Record<Theme, ThemePreset> = {
  night: {
    bg: new THREE.Color(0x0a0e17),
    fogDensity: 0.00075,
    hemi: 0.4,
    sun: 0.85,
    bloom: 0.85,
    particles: 0.4,
    night: 1,
    gridOpacity: 0.28,
    ground: new THREE.Color(0x0b111d),
    skyZenith: new THREE.Color(0x05070d),
    skyHorizon: new THREE.Color(0x14213b),
    skyGround: new THREE.Color(0x07090f)
  },
  day: {
    bg: new THREE.Color(0xa8c8de),
    fogDensity: 0.00045,
    hemi: 1.05,
    sun: 1.5,
    bloom: 0.22,
    particles: 0.06,
    night: 0,
    gridOpacity: 0.14,
    ground: new THREE.Color(0x93b3c9),
    skyZenith: new THREE.Color(0x77a8d6),
    skyHorizon: new THREE.Color(0xdbe7f2),
    skyGround: new THREE.Color(0x9db8c9)
  }
}

const CITY_DIR = new THREE.Vector3(0, 0.62, 1).normalize()
const GALAXY_DIR = new THREE.Vector3(0.15, 0.35, 1).normalize()

export class SceneManager {
  private renderer: THREE.WebGLRenderer
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private scene = new THREE.Scene()
  private rig: CameraRig
  private world = new WorldLayer()
  private molecule = new MoleculeLayer()
  private hemi: THREE.HemisphereLight
  private sun: THREE.DirectionalLight
  private particles: THREE.Points
  private particleMat: THREE.PointsMaterial
  private minimapCam: THREE.OrthographicCamera
  private camMarker: THREE.Mesh
  private sky: THREE.Mesh
  private skyUniforms: {
    uZenith: { value: THREE.Color }
    uHorizon: { value: THREE.Color }
    uGround: { value: THREE.Color }
  }
  private ground: THREE.Mesh
  private groundMat: THREE.MeshStandardMaterial
  private grid: THREE.Mesh
  private gridUniforms: {
    uColor: { value: THREE.Color }
    uOpacity: { value: number }
    uFadeDensity: { value: number }
    uCamXZ: { value: THREE.Vector2 }
  }
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private pointerPx = { x: 0, y: 0 }
  private pointerDirty = false
  private timeMachine: TimeMachine | null = null
  private unsub: () => void
  private disposed = false
  private lastTime = performance.now()
  private fogState: { color: THREE.Color; density: number }
  private themeState: ThemePreset
  private nightMix = 1
  private worldRadius = 700
  private framedOnce = false
  private moleculeReframed = false
  // camera-idle tracking for proximity labels
  private lastCamPos = new THREE.Vector3()
  private camStillFor = 0
  private nearLabelsFresh = false

  private lowFx = false
  private frameParity = 0

  constructor(private container: HTMLElement) {
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance'
      })
    } catch (err) {
      // dead context: leave a notice; main's GL ladder will relaunch us
      const notice = document.createElement('div')
      notice.className = 'gl-notice'
      notice.textContent = '3D unavailable — restarting with a compatible renderer…'
      container.appendChild(notice)
      throw err
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(this.renderer.domElement)

    this.rig = new CameraRig(this.renderer.domElement)

    this.themeState = { ...THEMES.night }
    this.themeState.bg = THEMES.night.bg.clone()
    this.themeState.ground = THEMES.night.ground.clone()
    this.fogState = { color: THEMES.night.bg.clone(), density: THEMES.night.fogDensity }
    this.scene.background = this.themeState.bg
    this.scene.fog = new THREE.FogExp2(this.fogState.color, this.fogState.density)

    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2416, THEMES.night.hemi)
    this.sun = new THREE.DirectionalLight(0xfff2dd, THEMES.night.sun)
    this.sun.position.set(400, 700, 250)
    this.scene.add(this.hemi, this.sun, this.world.group, this.molecule.group)

    // ---- gradient sky dome ----
    this.skyUniforms = {
      uZenith: { value: THEMES.night.skyZenith.clone() },
      uHorizon: { value: THEMES.night.skyHorizon.clone() },
      uGround: { value: THEMES.night.skyGround.clone() }
    }
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.skyUniforms,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGround;
        varying vec3 vDir;
        void main() {
          float h = normalize(vDir).y;
          vec3 col = h > 0.0
            ? mix(uHorizon, uZenith, pow(h, 0.55))
            : mix(uHorizon, uGround, pow(-h, 0.7));
          gl_FragColor = vec4(col, 1.0);
        }`
    })
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 15), skyMat)
    this.sky.scale.setScalar(7000)
    this.sky.renderOrder = -1
    this.sky.frustumCulled = false
    this.scene.add(this.sky)

    // ---- ground disc + fading world grid ----
    this.groundMat = new THREE.MeshStandardMaterial({
      color: THEMES.night.ground.clone(),
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 1
    })
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64), this.groundMat)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.15
    this.ground.scale.setScalar(2700)
    this.scene.add(this.ground)

    this.gridUniforms = {
      uColor: { value: new THREE.Color(0x3f6fa8) },
      uOpacity: { value: THEMES.night.gridOpacity },
      uFadeDensity: { value: THEMES.night.fogDensity * 2.5 },
      uCamXZ: { value: new THREE.Vector2() }
    }
    const gridMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: this.gridUniforms,
      vertexShader: `
        varying vec2 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uFadeDensity;
        uniform vec2 uCamXZ;
        varying vec2 vWorld;
        void main() {
          vec2 w1 = vWorld / 25.0;
          vec2 w2 = vWorld / 125.0;
          vec2 g1 = abs(fract(w1 - 0.5) - 0.5) / fwidth(w1);
          vec2 g2 = abs(fract(w2 - 0.5) - 0.5) / fwidth(w2);
          float minor = 1.0 - min(min(g1.x, g1.y), 1.0);
          float major = (1.0 - min(min(g2.x, g2.y), 1.0)) * 1.6;
          float line = max(minor * 0.55, major);
          float fade = exp(-length(vWorld - uCamXZ) * uFadeDensity);
          gl_FragColor = vec4(uColor, line * fade * uOpacity);
        }`
    })
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gridMat)
    this.grid.rotation.x = -Math.PI / 2
    this.grid.position.y = -0.05
    this.grid.scale.setScalar(5400)
    this.grid.frustumCulled = false
    this.scene.add(this.grid)

    // ambient drifting particles
    const pCount = 1600
    const pGeo = new THREE.BufferGeometry()
    const pPos = new Float32Array(pCount * 3)
    for (let i = 0; i < pCount; i++) {
      pPos[i * 3] = (Math.random() - 0.5) * 1600
      pPos[i * 3 + 1] = Math.random() * 500
      pPos[i * 3 + 2] = (Math.random() - 0.5) * 1600
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
    this.particleMat = new THREE.PointsMaterial({
      color: 0x88bbff,
      size: 1.6,
      transparent: true,
      opacity: THEMES.night.particles,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true
    })
    this.particles = new THREE.Points(pGeo, this.particleMat)
    this.scene.add(this.particles)

    // minimap
    this.minimapCam = new THREE.OrthographicCamera(-520, 520, 520, -520, 1, 12000)
    this.minimapCam.position.set(0, 1200, 0)
    this.minimapCam.lookAt(0, 0, 0)
    this.minimapCam.layers.enable(1)
    this.camMarker = new THREE.Mesh(
      new THREE.ConeGeometry(18, 40, 4),
      new THREE.MeshBasicMaterial({ color: 0xffdd44 })
    )
    this.camMarker.layers.set(1)
    this.scene.add(this.camMarker)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), THEMES.night.bloom, 0.5, 0.85)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    const resize = (): void => {
      const w = container.clientWidth || 1
      const h = container.clientHeight || 1
      this.renderer.setSize(w, h)
      this.composer.setSize(w, h)
      this.rig.camera.aspect = w / h
      this.rig.camera.updateProjectionMatrix()
    }
    resize()
    new ResizeObserver(resize).observe(container)

    this.renderer.domElement.addEventListener('pointermove', (e) => {
      const rect = this.renderer.domElement.getBoundingClientRect()
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      this.pointerPx = { x: e.clientX, y: e.clientY }
      this.pointerDirty = true
    })
    this.renderer.domElement.addEventListener('click', () => {
      if (this.rig.mode === 'fly') return
      const state = useAtlas.getState()
      if (state.mode === 'molecule') return
      state.setSelected(state.hover ? state.hover.fileId : null)
    })
    this.renderer.domElement.addEventListener('dblclick', () => {
      if (this.rig.mode === 'fly') return
      const state = useAtlas.getState()
      if (state.mode === 'molecule' || !state.hover) return
      void enterMoleculeFor(state.hover.fileId)
    })
    this.renderer.domElement.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.rig.mode === 'fly') return
      const state = useAtlas.getState()
      if (state.mode === 'molecule' || !state.snapshot) return
      this.raycaster.setFromCamera(this.pointer, this.rig.camera)
      const hit = this.world.raycast(this.raycaster)
      if (hit !== null) state.setContextMenu({ fileId: hit, x: e.clientX, y: e.clientY })
    })

    // react to store changes. `prev` is swapped BEFORE handling: some handlers
    // set store fields themselves (e.g. setLensLegend), which re-enters this
    // subscription synchronously — with a stale `prev` that recursed forever.
    let last = useAtlas.getState()
    this.unsub = useAtlas.subscribe((state) => {
      const prev = last
      last = state
      if (state.snapshot !== prev.snapshot && state.snapshot) {
        this.loadSnapshot(state.snapshot)
      }
      if (state.mode !== prev.mode) this.applyMode(state.mode)
      if (state.moleculeGraph !== prev.moleculeGraph) {
        if (state.moleculeGraph) {
          this.molecule.show(state.moleculeGraph)
          this.moleculeReframed = false
          const b = this.molecule.getBounds()
          this.rig.setWorldScale(b.radius * 3)
          this.rig.frameSphere(b.center, b.radius, { direction: GALAXY_DIR })
        } else {
          this.molecule.hide()
        }
      }
      if (state.hover !== prev.hover || state.selected !== prev.selected) {
        this.world.setHighlight(state.hover?.fileId ?? null, state.selected)
      }
      if (state.timeIndex !== prev.timeIndex && this.timeMachine && !state.diffRange) {
        this.world.setTimeFactors(this.timeMachine.factorsAt(state.timeIndex))
      }
      if (state.diffRange !== prev.diffRange && this.timeMachine && state.snapshot) {
        if (state.diffRange) {
          const d = this.timeMachine.diff(state.diffRange[0], state.diffRange[1])
          this.world.applyLens(d.colors, d.emissive, '#ffd23d')
          this.world.setTimeFactors(d.factors)
          state.setDiffCounts(d.counts)
        } else {
          // leave diff mode: restore lens + current scrub position
          const result = computeLens(state.lens, state.snapshot, state.coverage)
          this.world.applyLens(result.colors, result.emissive, result.emissiveColor)
          this.world.setTimeFactors(this.timeMachine.factorsAt(state.timeIndex))
          state.setDiffCounts(null)
        }
      }
      if (state.flyToRequest !== null && state.flyToRequest !== prev.flyToRequest) {
        const target = this.world.currentTop(state.flyToRequest)
        this.rig.flyTo(target, this.world.focusDistance(state.flyToRequest))
        state.setSelected(state.flyToRequest)
        state.requestFlyTo(null)
      }
      if (state.reframeRequest !== prev.reframeRequest) {
        this.reframe()
      }
      if (
        state.snapshot &&
        (state.lens !== prev.lens ||
          state.coverage !== prev.coverage ||
          state.snapshot !== prev.snapshot)
      ) {
        const result = computeLens(state.lens, state.snapshot, state.coverage)
        this.world.applyLens(result.colors, result.emissive, result.emissiveColor)
        state.setLensLegend(result.legend)
      }
      if (state.health !== prev.health) {
        this.world.setCycles(state.health ? state.health.cycles.flatMap((c) => c.edges) : null)
      }
      if (state.healthOpen !== prev.healthOpen) {
        this.world.setCyclesVisible(state.healthOpen)
      }
      if (state.glInfo !== prev.glInfo && state.glInfo) {
        this.applyGlProfile(state.glInfo.software)
      }
      if (state.fileFilter !== prev.fileFilter) {
        this.world.setFilter(state.fileFilter ? state.fileFilter.keep : null)
      }
      if (state.fileVersion !== prev.fileVersion && state.fileVersion && state.snapshot) {
        this.world.fileEdited(
          state.fileVersion.fileId,
          state.snapshot.files[state.fileVersion.fileId].loc
        )
      }
      if (
        state.tour &&
        state.tour.current >= 0 &&
        (state.tour.current !== prev.tour?.current || (prev.tour?.stops.length ?? 0) === 0)
      ) {
        const stop = state.tour.stops[state.tour.current]
        if (stop) {
          if (stop.fileId >= 0) {
            state.setSelected(stop.fileId)
            this.rig.flyTo(this.world.currentTop(stop.fileId), this.world.focusDistance(stop.fileId))
          } else if (stop.dirId >= 0) {
            const b = this.world.dirBounds(stop.dirId)
            if (b) this.rig.frameSphere(b.center, b.radius, { duration: 1.4 })
          }
        }
      }
    })

    // dev/test hook for scripted verification
    ;(window as unknown as Record<string, unknown>).__atlasScene = this

    this.frame = this.frame.bind(this)
    requestAnimationFrame(this.frame)
  }

  setCameraMode(mode: 'orbit' | 'fly'): void {
    this.rig.setMode(mode)
    if (mode === 'fly') this.world.hideNearLabels()
  }

  /** software-GL profile: lower fill-rate cost; HiDPI line boost otherwise */
  private applyGlProfile(software: boolean): void {
    this.lowFx = software
    if (software) {
      this.renderer.setPixelRatio(1)
      this.bloom.resolution.set(
        Math.max(1, (this.container.clientWidth || 2) / 2),
        Math.max(1, (this.container.clientHeight || 2) / 2)
      )
      // thin the ambient particles
      const geo = this.particles.geometry
      geo.setDrawRange(0, 500)
    } else {
      // real GPU: additive 1px lines lose apparent brightness at high DPR —
      // compensate by boosting line opacities
      const boost = Math.min(2, window.devicePixelRatio || 1)
      this.world.setLineBoost(boost)
    }
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
  }

  /** frame the current view's bounds, preserving the viewing direction */
  reframe(): void {
    const state = useAtlas.getState()
    if (state.mode === 'molecule') {
      const b = this.molecule.getBounds()
      this.rig.frameSphere(b.center, b.radius)
    } else {
      const b = this.world.getBounds()
      this.rig.frameSphere(b.center, b.radius)
    }
  }

  private lastRootPath: string | null = null

  private loadSnapshot(snapshot: RepoSnapshot): void {
    const sameRepo = this.lastRootPath === snapshot.rootPath
    this.lastRootPath = snapshot.rootPath
    this.world.setSnapshot(snapshot)
    this.molecule.hide()
    this.timeMachine = new TimeMachine(snapshot)
    this.applyWorldScale()
    // watch-lite refreshes of the same repo keep the camera where it is
    if (!sameRepo) {
      const b = this.world.getBounds()
      this.rig.frameSphere(b.center, b.radius, {
        direction: CITY_DIR,
        immediate: !this.framedOnce
      })
    }
    this.framedOnce = true
  }

  /** render one frame at high pixel density and return it as a PNG data URL */
  captureHiRes(scale = 3): string {
    const prevRatio = this.renderer.getPixelRatio()
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setPixelRatio(scale)
    this.composer.setSize(w, h)
    this.composer.render()
    const url = this.renderer.domElement.toDataURL('image/png')
    this.renderer.setPixelRatio(prevRatio)
    this.composer.setSize(w, h)
    return url
  }

  saveBookmark(): { pos: number[]; target: number[] } {
    return this.rig.getPose()
  }

  gotoBookmark(pos: number[], target: number[]): void {
    this.rig.goTo(pos, target)
  }

  private applyWorldScale(): void {
    const b = this.world.getBounds()
    this.worldRadius = b.radius
    this.rig.setWorldScale(b.radius)
    // scale scenery to the world
    const extent = b.radius / Math.SQRT2
    this.sun.position.set(extent * 0.6, extent * 1.1, extent * 0.4)
    this.sky.scale.setScalar(b.radius * 10)
    this.ground.scale.setScalar(extent * 6)
    this.grid.scale.setScalar(extent * 12)
    this.particles.scale.setScalar(Math.max(0.5, b.radius / 700))
    const m = extent * 1.15
    this.minimapCam.left = -m
    this.minimapCam.right = m
    this.minimapCam.top = m
    this.minimapCam.bottom = -m
    this.minimapCam.far = b.radius * 8
    this.minimapCam.position.set(0, b.radius * 2.2, 0)
    this.minimapCam.lookAt(0, 0, 0)
    this.minimapCam.updateProjectionMatrix()
  }

  private applyMode(mode: ViewMode): void {
    this.world.setMode(mode)
    if (mode !== 'molecule') {
      this.molecule.hide()
      this.applyWorldScale()
      const b = this.world.getBounds()
      this.rig.frameSphere(b.center, b.radius, {
        direction: mode === 'galaxy' ? GALAXY_DIR : CITY_DIR
      })
    }
  }

  private pick(): void {
    if (!this.pointerDirty) return
    this.pointerDirty = false
    const state = useAtlas.getState()
    if (!state.snapshot) return
    this.raycaster.setFromCamera(this.pointer, this.rig.camera)
    if (state.mode === 'molecule') return
    const hit = this.world.raycast(this.raycaster)
    const current = state.hover?.fileId ?? null
    if (hit !== current) {
      state.setHover(
        hit === null ? null : { fileId: hit, x: this.pointerPx.x, y: this.pointerPx.y }
      )
    } else if (hit !== null && state.hover) {
      // keep tooltip following the pointer
      state.setHover({ fileId: hit, x: this.pointerPx.x, y: this.pointerPx.y })
    }
  }

  private frame(): void {
    if (this.disposed) return
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastTime) / 1000)
    this.lastTime = now

    const state = useAtlas.getState()
    // theme easing
    const target = THEMES[state.theme]
    const k = 1 - Math.pow(0.01, dt)
    this.themeState.bg.lerp(target.bg, k)
    this.fogState.color.lerp(target.bg, k)
    this.fogState.density += (target.fogDensity - this.fogState.density) * k
    ;(this.scene.fog as THREE.FogExp2).color.copy(this.fogState.color)
    ;(this.scene.fog as THREE.FogExp2).density = this.fogState.density
    this.scene.background = this.themeState.bg
    this.hemi.intensity += (target.hemi - this.hemi.intensity) * k
    this.sun.intensity += (target.sun - this.sun.intensity) * k
    this.bloom.strength += (target.bloom - this.bloom.strength) * k
    this.particleMat.opacity += (target.particles - this.particleMat.opacity) * k
    this.nightMix += (target.night - this.nightMix) * k
    this.world.setWindowStrength(this.nightMix)
    this.skyUniforms.uZenith.value.lerp(target.skyZenith, k)
    this.skyUniforms.uHorizon.value.lerp(target.skyHorizon, k)
    this.skyUniforms.uGround.value.lerp(target.skyGround, k)
    this.groundMat.color.lerp(target.ground, k)
    const galaxyish = state.mode === 'galaxy' ? 1 : 0
    this.gridUniforms.uOpacity.value +=
      (target.gridOpacity * (1 - galaxyish) - this.gridUniforms.uOpacity.value) * k
    // the ground disc reads oddly floating under the galaxy — fade it away there
    this.groundMat.opacity += ((1 - galaxyish) - this.groundMat.opacity) * k
    this.ground.visible = this.groundMat.opacity > 0.02
    this.gridUniforms.uFadeDensity.value = this.fogState.density * 2.5
    this.gridUniforms.uCamXZ.value.set(this.rig.camera.position.x, this.rig.camera.position.z)

    this.particles.rotation.y += dt * 0.004

    // idle auto-orbit: cinematic drift in galaxy view only
    this.rig.setAutoRotate(
      state.mode === 'galaxy' && this.rig.mode === 'orbit' && this.rig.idleSeconds() > 8
    )

    this.rig.update(dt)
    this.world.update(dt, this.rig.camera)
    this.molecule.update(dt, this.rig.camera)
    this.pick()

    // one gentle re-frame when the molecule layout has fully settled
    if (
      state.mode === 'molecule' &&
      !this.moleculeReframed &&
      this.molecule.isSettledLayout
    ) {
      this.moleculeReframed = true
      const b = this.molecule.getBounds()
      this.rig.frameSphere(b.center, b.radius, { duration: 0.8 })
    }

    // proximity labels: refresh when the camera has been still for a beat
    const camMoved = this.lastCamPos.distanceToSquared(this.rig.camera.position)
    this.lastCamPos.copy(this.rig.camera.position)
    if (camMoved > 0.02 || this.world.isAnimating) {
      this.camStillFor = 0
      if (this.nearLabelsFresh && camMoved > this.worldRadius * 0.001) {
        this.world.hideNearLabels()
        this.nearLabelsFresh = false
      }
    } else {
      this.camStillFor += dt
      if (this.camStillFor > 0.45 && !this.nearLabelsFresh && state.mode !== 'molecule') {
        this.world.refreshNearLabels(this.rig.camera, this.worldRadius)
        this.nearLabelsFresh = true
      }
    }

    this.camMarker.position.copy(this.rig.camera.position)
    this.camMarker.position.y = 60

    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setViewport(0, 0, w, h)
    this.renderer.setScissorTest(false)
    this.composer.render()

    // minimap overlay (skip in molecule view; half-rate under software GL)
    this.frameParity ^= 1
    if (state.snapshot && state.mode !== 'molecule' && !(this.lowFx && this.frameParity)) {
      const mw = Math.min(230, w * 0.22)
      const mh = mw
      const mx = w - mw - 14
      const my = 14
      this.renderer.setScissorTest(true)
      this.renderer.setScissor(mx, my, mw, mh)
      this.renderer.setViewport(mx, my, mw, mh)
      this.renderer.autoClear = false
      this.renderer.clearDepth()
      this.renderer.render(this.scene, this.minimapCam)
      this.renderer.autoClear = true
      this.renderer.setScissorTest(false)
      this.renderer.setViewport(0, 0, w, h)
    }

    requestAnimationFrame(this.frame)
  }

  dispose(): void {
    this.disposed = true
    this.unsub()
    this.world.dispose()
    this.molecule.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
