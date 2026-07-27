// Insight lenses: pure functions mapping snapshot metrics to per-file colors
// and emissive intensity, plus legend metadata for the UI.
import type { RepoSnapshot } from '../../shared/model'
import { languageColor } from '../../shared/languages'

export type LensId =
  | 'language'
  | 'complexity'
  | 'hotspot'
  | 'age'
  | 'todo'
  | 'ownership'
  | 'coverage'

export interface LensResult {
  /** n*3 rgb 0..1 */
  colors: Float32Array
  /** n emissive intensities 0..1 (written into the aHeat attribute) */
  emissive: Float32Array
  emissiveColor: string
  legend:
    | { kind: 'ramp'; label: string; low: string; high: string; stops: string[] }
    | { kind: 'language' }
    | { kind: 'ownership'; authors: { name: string; color: string; files: number }[] }
}

export const LENSES: { id: LensId; label: string; hint?: string }[] = [
  { id: 'language', label: 'Language' },
  { id: 'complexity', label: 'Complexity' },
  { id: 'hotspot', label: 'Hotspots', hint: 'churn × complexity' },
  { id: 'age', label: 'Freshness' },
  { id: 'todo', label: 'TODO debt' },
  { id: 'ownership', label: 'Ownership' },
  { id: 'coverage', label: 'Coverage', hint: 'load an lcov file first' }
]

function hex(c: string): [number, number, number] {
  const v = parseInt(c.slice(1), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** multi-stop ramp sample, t 0..1 */
function ramp(stops: string[], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t))
  const seg = clamped * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(seg))
  return lerp3(hex(stops[i]), hex(stops[i + 1]), seg - i)
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 1
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 1
}

const RAMP_HEAT = ['#1a2436', '#3b4d7a', '#b0653a', '#f2a03d', '#ffe98a']
const RAMP_COLD = ['#151c2b', '#28527a', '#3f8fb5', '#7dd3fc', '#e0f7ff']
const RAMP_GOOD_BAD = ['#e05252', '#e0a052', '#e0d452', '#9fd452', '#4ade80']

export function computeLens(
  lens: LensId,
  snapshot: RepoSnapshot,
  coverage: number[] | null
): LensResult {
  const n = snapshot.files.length
  const colors = new Float32Array(n * 3)
  const emissive = new Float32Array(n)
  const put = (i: number, rgb: [number, number, number]): void => {
    colors[i * 3] = rgb[0]
    colors[i * 3 + 1] = rgb[1]
    colors[i * 3 + 2] = rgb[2]
  }

  switch (lens) {
    case 'language': {
      for (let i = 0; i < n; i++) {
        put(i, hex(languageColor(snapshot.files[i].language)))
        emissive[i] = snapshot.files[i].churn.heat
      }
      return { colors, emissive, emissiveColor: '#ff6b1f', legend: { kind: 'language' } }
    }
    case 'complexity': {
      const density = snapshot.files.map((f) =>
        f.analyzed ? f.complexity / Math.max(f.loc, 20) : 0
      )
      const p95 = percentile(density.filter((d) => d > 0), 0.95) || 0.5
      for (let i = 0; i < n; i++) {
        const t = Math.min(1, density[i] / p95)
        put(i, ramp(RAMP_HEAT, t))
        emissive[i] = t * t
      }
      return {
        colors,
        emissive,
        emissiveColor: '#ffb03d',
        legend: { kind: 'ramp', label: 'Decision density', low: 'simple', high: 'gnarly', stops: RAMP_HEAT }
      }
    }
    case 'hotspot': {
      const cxs = snapshot.files.filter((f) => f.complexity > 0).map((f) => f.complexity)
      const p95 = percentile(cxs, 0.95) || 1
      for (let i = 0; i < n; i++) {
        const f = snapshot.files[i]
        const t = f.churn.heat * Math.min(1, f.complexity / p95)
        put(i, ramp(RAMP_HEAT, t))
        emissive[i] = t
      }
      return {
        colors,
        emissive,
        emissiveColor: '#ff5a1f',
        legend: { kind: 'ramp', label: 'Churn × complexity', low: 'calm', high: 'volcano', stops: RAMP_HEAT }
      }
    }
    case 'age': {
      const now = Date.now() / 1000
      const HALF_LIFE = 180 * 24 * 3600
      for (let i = 0; i < n; i++) {
        const touched = snapshot.files[i].churn.lastTouched
        const t = touched > 0 ? Math.pow(0.5, Math.max(0, now - touched) / HALF_LIFE) : 0
        put(i, ramp(RAMP_COLD, t))
        emissive[i] = t * 0.8
      }
      return {
        colors,
        emissive,
        emissiveColor: '#7dd3fc',
        legend: { kind: 'ramp', label: 'Last touched', low: 'ancient', high: 'this week', stops: RAMP_COLD }
      }
    }
    case 'todo': {
      const density = snapshot.files.map((f) => f.todoCount / Math.max(f.loc / 100, 1))
      const p95 = percentile(density.filter((d) => d > 0), 0.95) || 1
      for (let i = 0; i < n; i++) {
        const t = Math.min(1, density[i] / p95)
        put(i, ramp(RAMP_HEAT, t))
        emissive[i] = snapshot.files[i].todoCount > 0 ? Math.max(0.15, t) : 0
      }
      return {
        colors,
        emissive,
        emissiveColor: '#ffd23d',
        legend: { kind: 'ramp', label: 'TODO/FIXME per 100 loc', low: 'clean', high: 'debt', stops: RAMP_HEAT }
      }
    }
    case 'ownership': {
      const files = new Map<string, number>()
      for (let i = 0; i < n; i++) {
        const f = snapshot.files[i]
        const author = f.churn.topAuthor
        if (!author) {
          put(i, [0.16, 0.19, 0.24])
          continue
        }
        files.set(author, (files.get(author) ?? 0) + 1)
        let h = 2166136261
        for (let c = 0; c < author.length; c++) {
          h ^= author.charCodeAt(c)
          h = Math.imul(h, 16777619)
        }
        const hue = ((h >>> 0) % 360) / 360
        put(i, hslToRgb(hue, 0.25 + f.churn.topShare * 0.65, 0.5))
        emissive[i] = f.churn.topShare > 0.9 && f.churn.commits > 3 ? 0.35 : 0 // bus-factor glow
      }
      const authorColor = (name: string): string => {
        let h = 2166136261
        for (let c = 0; c < name.length; c++) {
          h ^= name.charCodeAt(c)
          h = Math.imul(h, 16777619)
        }
        const [r, g, b] = hslToRgb(((h >>> 0) % 360) / 360, 0.7, 0.55)
        const to = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0')
        return `#${to(r)}${to(g)}${to(b)}`
      }
      const authors = [...files.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, color: authorColor(name), files: count }))
      return { colors, emissive, emissiveColor: '#ffffff', legend: { kind: 'ownership', authors } }
    }
    case 'coverage': {
      for (let i = 0; i < n; i++) {
        const c = coverage?.[i] ?? -1
        if (c < 0) {
          put(i, [0.14, 0.17, 0.22])
          emissive[i] = 0
        } else {
          put(i, ramp(RAMP_GOOD_BAD, c))
          emissive[i] = c < 0.4 ? 0.35 : 0
        }
      }
      return {
        colors,
        emissive,
        emissiveColor: '#ff5252',
        legend: { kind: 'ramp', label: 'Line coverage', low: '0%', high: '100%', stops: RAMP_GOOD_BAD }
      }
    }
  }
}
