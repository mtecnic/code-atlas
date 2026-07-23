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

  /** per-file size factor at commit index (inclusive); null for HEAD/live */
  factorsAt(index: number): Float32Array | null {
    if (index < 0 || index >= this.commitCount - 1) return null
    const n = this.snapshot.files.length
    const kf = Math.min(Math.floor(index / KEYFRAME_STRIDE), this.keyframes.length - 1)
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
    for (let i = lo; i < events.length && events[i].commit <= index; i++) {
      cum[events[i].file] += events[i].locDelta
    }
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
}
