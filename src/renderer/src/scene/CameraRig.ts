// Fly (pointer-lock + WASD) ⇄ orbit camera modes, eased flyTo/frameSphere used
// by search, click-focus and view framing. Tab toggles mode (via the UI layer).
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'

export type CameraMode = 'orbit' | 'fly'

export interface FrameOptions {
  direction?: THREE.Vector3
  duration?: number
  immediate?: boolean
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  mode: CameraMode = 'orbit'
  /** seconds since the user last interacted (drag, key, flyTo) */
  lastInteraction = performance.now()
  private worldRadius = 700
  private orbit: OrbitControls
  private fly: PointerLockControls
  private keys = new Set<string>()
  private velocity = new THREE.Vector3()
  private autoRotateTarget = 0
  private flyTween: {
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromTarget: THREE.Vector3
    toTarget: THREE.Vector3
    t: number
    duration: number
  } | null = null

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 8000)
    this.camera.position.set(0, 420, 620)
    this.orbit = new OrbitControls(this.camera, dom)
    this.orbit.target.set(0, 0, 0)
    this.orbit.enableDamping = true
    this.orbit.dampingFactor = 0.08
    this.orbit.maxPolarAngle = Math.PI * 0.495
    this.orbit.minDistance = 10
    this.orbit.maxDistance = 3000
    this.orbit.zoomToCursor = true
    this.orbit.autoRotate = false
    this.orbit.autoRotateSpeed = 0
    this.orbit.addEventListener('start', () => {
      this.lastInteraction = performance.now()
    })
    this.fly = new PointerLockControls(this.camera, dom)

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code)
      this.lastInteraction = performance.now()
    })
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    this.fly.addEventListener('unlock', () => {
      if (this.mode === 'fly') this.setMode('orbit')
    })
  }

  /** scale zoom limits / clip planes / fly speed to the scene size */
  setWorldScale(radius: number): void {
    this.worldRadius = radius
    this.orbit.minDistance = Math.max(3, radius * 0.015)
    this.orbit.maxDistance = radius * 4.5
    this.camera.near = Math.max(0.1, radius * 0.0008)
    this.camera.far = radius * 18
    this.camera.updateProjectionMatrix()
  }

  /** enable cinematic idle auto-orbit (ramped in/out smoothly) */
  setAutoRotate(enabled: boolean): void {
    this.autoRotateTarget = enabled ? 0.4 : 0
  }

  idleSeconds(): number {
    return (performance.now() - this.lastInteraction) / 1000
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.lastInteraction = performance.now()
    if (mode === 'fly') {
      this.orbit.enabled = false
      this.fly.lock()
    } else {
      if (this.fly.isLocked) this.fly.unlock()
      // keep looking where we were looking
      const dir = new THREE.Vector3()
      this.camera.getWorldDirection(dir)
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, 120)
      this.orbit.enabled = true
    }
  }

  flyTo(point: THREE.Vector3, distance = 60): void {
    this.lastInteraction = performance.now()
    const toTarget = point.clone()
    const dir = this.camera.position.clone().sub(toTarget)
    if (dir.lengthSq() < 1) dir.set(0, 1, 1)
    dir.normalize()
    const toPos = toTarget
      .clone()
      .addScaledVector(dir, distance)
      .add(new THREE.Vector3(0, distance * 0.45, 0))
    this.startTween(toPos, toTarget, 1.1)
  }

  /** place the camera so a bounding sphere comfortably fills the frame */
  frameSphere(center: THREE.Vector3, radius: number, opts: FrameOptions = {}): void {
    this.lastInteraction = performance.now()
    const vHalf = ((this.camera.fov / 2) * Math.PI) / 180
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect)
    const fitHalf = Math.min(vHalf, hHalf)
    // 0.92: sphere-fit is conservative for flat/squat layouts, so tuck in a bit
    const dist = (radius / Math.sin(fitHalf)) * 0.92
    let dir: THREE.Vector3
    if (opts.direction) {
      dir = opts.direction.clone().normalize()
    } else {
      // reframe: keep the current viewing direction, just fix the distance
      dir = this.camera.position.clone().sub(this.orbit.target)
      if (dir.lengthSq() < 1) dir.set(0, 0.62, 1)
      dir.normalize()
    }
    const toPos = center.clone().addScaledVector(dir, dist)
    if (opts.immediate) {
      this.camera.position.copy(toPos)
      this.orbit.target.copy(center)
      this.flyTween = null
      return
    }
    this.startTween(toPos, center.clone(), opts.duration ?? 1.1)
  }

  private startTween(toPos: THREE.Vector3, toTarget: THREE.Vector3, duration: number): void {
    this.flyTween = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.orbit.target.clone(),
      toTarget,
      t: 0,
      duration
    }
  }

  update(dt: number): void {
    if (this.flyTween) {
      const tw = this.flyTween
      tw.t = Math.min(1, tw.t + dt / tw.duration)
      const e = 1 - Math.pow(1 - tw.t, 3) // ease-out cubic
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e)
      this.orbit.target.lerpVectors(tw.fromTarget, tw.toTarget, e)
      if (tw.t >= 1) this.flyTween = null
    }
    // ramp auto-rotate in/out for a cinematic ease
    const ar = this.autoRotateTarget - this.orbit.autoRotateSpeed
    this.orbit.autoRotateSpeed += ar * Math.min(1, dt * 1.5)
    this.orbit.autoRotate = this.orbit.autoRotateSpeed > 0.02

    if (this.mode === 'fly' && this.fly.isLocked) {
      // altitude-scaled speed: crawl at street level, sprint at overview height
      const altitude = Math.max(8, this.camera.position.y)
      const base = THREE.MathUtils.clamp(altitude * 1.6, 30, this.worldRadius * 1.2)
      const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1
      const speed = base * boost
      const accel = new THREE.Vector3(
        (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
        (this.keys.has('KeyE') || this.keys.has('Space') ? 1 : 0) -
          (this.keys.has('KeyQ') || this.keys.has('ControlLeft') ? 1 : 0),
        (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0)
      )
      accel.normalize().multiplyScalar(speed)
      // damped velocity in camera space
      this.velocity.lerp(accel, 1 - Math.pow(0.0001, dt))
      const move = this.velocity.clone().multiplyScalar(dt)
      this.fly.moveRight(move.x)
      this.camera.position.y += move.y
      this.fly.moveForward(-move.z)
    } else {
      this.orbit.update()
    }
  }
}
