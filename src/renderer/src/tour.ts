// AI-guided tour: the model plans a flight through the architecture as NDJSON
// stops (one per line) which stream in and start playing immediately.
import { useAtlas } from './store'
import { streamChat, type ChatHandle } from './llm'
import type { RepoSnapshot } from '../../shared/model'

export interface TourStop {
  /** resolved target: file id, or -1 with dirId set */
  fileId: number
  dirId: number
  title: string
  narration: string
}

let activeChat: ChatHandle | null = null

function digest(snapshot: RepoSnapshot): string {
  const st = useAtlas.getState()
  const topDirs = snapshot.dirs
    .filter((d, id) => id !== 0 && d.parent === 0)
    .map((d) => {
      const files = countFiles(snapshot, snapshot.dirs.indexOf(d))
      return `${d.path}/ (${files.count} files, ${files.loc} loc)`
    })
    .slice(0, 18)
  const central = st.health
    ? st.health.loadBearing
        .slice(0, 10)
        .map((l) => `${snapshot.files[l.file].path} (${l.transitiveDependents} dependents)`)
    : []
  const langs = Object.entries(snapshot.stats.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([l, n]) => `${l}:${n}`)
    .join(' ')
  return [
    `Top-level directories:`,
    ...topDirs.map((d) => `- ${d}`),
    central.length ? `Most load-bearing files:` : '',
    ...central.map((c) => `- ${c}`),
    `Languages: ${langs}`,
    st.health ? `${st.health.cycles.length} import cycles detected.` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function countFiles(snapshot: RepoSnapshot, dirId: number): { count: number; loc: number } {
  let count = 0
  let loc = 0
  const walk = (id: number): void => {
    for (const f of snapshot.dirs[id].fileIds) {
      count++
      loc += snapshot.files[f].loc
    }
    for (const c of snapshot.dirs[id].children) walk(c)
  }
  walk(dirId)
  return { count, loc }
}

function resolveStop(
  snapshot: RepoSnapshot,
  target: string,
  kind: string
): { fileId: number; dirId: number } | null {
  const clean = String(target).replace(/^\.?\//, '').replace(/\/$/, '')
  if (kind === 'dir') {
    const dirId = snapshot.dirs.findIndex((d) => d.path === clean)
    if (dirId >= 0) return { fileId: -1, dirId }
    const prefix = snapshot.dirs.findIndex((d) => d.path.endsWith(clean))
    if (prefix >= 0) return { fileId: -1, dirId: prefix }
  }
  const fileId = snapshot.files.findIndex((f) => f.path === clean || f.path.endsWith('/' + clean))
  if (fileId >= 0) return { fileId, dirId: -1 }
  // maybe the model gave a dir without kind
  const dirId = snapshot.dirs.findIndex((d) => d.path === clean)
  if (dirId >= 0) return { fileId: -1, dirId }
  return null
}

export async function startTour(): Promise<void> {
  const st = useAtlas.getState()
  const snapshot = st.snapshot
  if (!snapshot || !st.llm) return
  stopTour()
  st.setTour({ stops: [], current: -1, playing: true, done: false })

  let buffer = ''
  const feed = (delta: string): void => {
    buffer += delta
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim().replace(/^```(json)?|```$/g, '')
      if (!line.startsWith('{')) continue
      try {
        const parsed = JSON.parse(line)
        const resolved = resolveStop(snapshot, parsed.target ?? '', parsed.kind ?? 'file')
        if (!resolved || !parsed.narration) continue
        const state = useAtlas.getState()
        const tour = state.tour
        if (!tour) return
        const stops = [
          ...tour.stops,
          {
            ...resolved,
            title: String(parsed.title ?? parsed.target),
            narration: String(parsed.narration)
          }
        ]
        // auto-start on the first stop
        const current = tour.current === -1 ? 0 : tour.current
        state.setTour({ ...tour, stops, current })
      } catch {
        /* incomplete or malformed line — skip */
      }
    }
  }

  activeChat = await streamChat(
    [
      {
        role: 'system',
        content:
          'You are planning a guided 3D tour of a codebase for a developer new to it. Reply with ONLY NDJSON: one JSON object per line, no prose, no code fences. Each line: {"target": "<repo-relative dir or file path>", "kind": "dir"|"file", "title": "<4-word stop name>", "narration": "<2-3 sentences: what lives here, why it matters, how it connects>"}. 6 to 9 stops. Order: overview → core subsystems → the most load-bearing file → anything surprising. Use ONLY paths from the digest below.\n\n' +
          digest(snapshot)
      },
      { role: 'user', content: 'Plan the tour.' }
    ],
    {
      onDelta: feed,
      onDone: () => {
        feed('\n')
        const state = useAtlas.getState()
        if (state.tour) state.setTour({ ...state.tour, done: true })
      },
      onError: () => {
        const state = useAtlas.getState()
        if (state.tour && state.tour.stops.length === 0) state.setTour(null)
        else if (state.tour) state.setTour({ ...state.tour, done: true })
      }
    }
  )
}

export function stopTour(): void {
  activeChat?.abort()
  activeChat = null
  const st = useAtlas.getState()
  if (st.tour) {
    st.setTour(null)
    st.requestReframe()
  }
}
