// Folds git timeline events into per-file size factors for the time scrub.
// Keyframes every KEYFRAME_STRIDE commits bound replay cost on slider yanks.
import type { RepoSnapshot } from '../../../shared/model'

const KEYFRAME_STRIDE = 200

export class TimeMachine {
  private keyframes: Float32Array[] = [] // cumulative locDelta per file
  private headCum: Float32Array
  private hasEvents: Uint8Array
  readonly commitCount: number

  constructor(private snapshot: RepoSnapshot) {
    const n = snapshot.files.length
    this.commitCount = snapshot.timeline.commits.length
    this.headCum = new Float32Array(n)
    this.hasEvents = new Uint8Array(n)

    const cum = new Float32Array(n)
    let nextKeyframe = 0
    let eventIdx = 0
    const events = snapshot.timeline.events
    for (let c = 0; c < this.commitCount; c++) {
      if (c === nextKeyframe) {
        this.keyframes.push(cum.slice())
        nextKeyframe += KEYFRAME_STRIDE
      }
      while (eventIdx < events.length && events[eventIdx].commit === c) {
        const e = events[eventIdx++]
        cum[e.file] += e.locDelta
        this.hasEvents[e.file] = 1
      }
    }
    this.headCum = cum
  }

  /** cumulative locDelta per file at commit index (inclusive) */
  cumAt(index: number): Float32Array {
    const clamped = Math.max(0, Math.min(index, this.commitCount - 1))
    const kf = Math.min(Math.floor(clamped / KEYFRAME_STRIDE), this.keyframes.length - 1)
    const cum = this.keyframes[kf].slice()
    const events = this.snapshot.timeline.events
    // replay events in (kf*STRIDE-1, index]
    let lo = 0
    let hi = events.length
    const startCommit = kf * KEYFRAME_STRIDE
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (events[mid].commit < startCommit) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < events.length && events[i].commit <= clamped; i++) {
      cum[events[i].file] += events[i].locDelta
    }
    return cum
  }

  /** per-file size factor at commit index (inclusive); null for HEAD/live */
  factorsAt(index: number): Float32Array | null {
    if (index < 0 || index >= this.commitCount - 1) return null
    const n = this.snapshot.files.length
    const cum = this.cumAt(index)
    const factors = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      if (!this.hasEvents[i]) {
        factors[i] = 1 // untracked by history — always shown
      } else if (cum[i] <= 0) {
        factors[i] = 0
      } else {
        factors[i] = Math.min(1.4, cum[i] / Math.max(1, this.headCum[i]))
      }
    }
    return factors
  }

  /** classify each file across a commit range for diff mode */
  diff(
    a: number,
    b: number
  ): {
    colors: Float32Array
    emissive: Float32Array
    factors: Float32Array | null
    changedKeep: Float32Array
    counts: { added: number; modified: number; deleted: number }
  } {
    const n = this.snapshot.files.length
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const cumA = this.cumAt(lo)
    const cumB = this.cumAt(hi)
    const colors = new Float32Array(n * 3)
    const emissive = new Float32Array(n)
    const changedKeep = new Float32Array(n)
    const counts = { added: 0, modified: 0, deleted: 0 }
    for (let i = 0; i < n; i++) {
      const wasThere = this.hasEvents[i] ? cumA[i] > 0 : true
      const isThere = this.hasEvents[i] ? cumB[i] > 0 : true
      const delta = Math.abs(cumB[i] - cumA[i])
      let r = 0.16
      let g = 0.19
      let bl = 0.24 // unchanged: dim slate
      let glow = 0
      if (this.hasEvents[i] && !wasThere && isThere) {
        counts.added++
        changedKeep[i] = 1
        r = 0.16
        g = 0.85
        bl = 0.44 // green
        glow = 0.7
      } else if (this.hasEvents[i] && wasThere && !isThere) {
        counts.deleted++
        changedKeep[i] = 1
        r = 0.94
        g = 0.25
        bl = 0.29 // red (sinks via factors)
        glow = 0.5
      } else if (this.hasEvents[i] && delta > 0) {
        counts.modified++
        changedKeep[i] = 1
        const t = Math.min(1, delta / Math.max(20, this.headCum[i]))
        r = 0.92
        g = 0.55 + 0.25 * (1 - t)
        bl = 0.18 // amber, hotter with bigger change
        glow = 0.2 + 0.6 * t
      }
      colors[i * 3] = r
      colors[i * 3 + 1] = g
      colors[i * 3 + 2] = bl
      emissive[i] = glow
    }
    return { colors, emissive, factors: this.factorsAt(hi), changedKeep, counts }
  }
}
