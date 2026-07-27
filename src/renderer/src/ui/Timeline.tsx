import { useState } from 'react'
import { useAtlas } from '../store'
import { applyFilter } from '../graphops'

export function Timeline(): React.JSX.Element | null {
  const snapshot = useAtlas((s) => s.snapshot)
  const timeIndex = useAtlas((s) => s.timeIndex)
  const diffRange = useAtlas((s) => s.diffRange)
  const diffCounts = useAtlas((s) => s.diffCounts)
  const mode = useAtlas((s) => s.mode)
  const { setTimeIndex, setDiffRange, setFileFilter } = useAtlas()
  const [changedOnly, setChangedOnly] = useState(false)

  if (!snapshot || snapshot.timeline.commits.length < 2 || mode === 'molecule') return null
  const commits = snapshot.timeline.commits
  const max = commits.length - 1

  const exitDiff = (): void => {
    setDiffRange(null)
    setFileFilter(null)
    setChangedOnly(false)
  }

  const applyChangedOnly = (on: boolean, range: [number, number]): void => {
    setChangedOnly(on)
    if (!on) {
      setFileFilter(null)
      return
    }
    // rebuild via TimeMachine indirectly: keep = changed classification from the store pass
    const state = useAtlas.getState()
    if (!state.snapshot) return
    // trigger recompute by re-setting the range; SceneManager stored counts,
    // but the keep array we build here from events between the range
    const [a, b] = range
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const changed = new Float32Array(state.snapshot.files.length)
    for (const e of state.snapshot.timeline.events) {
      if (e.commit > lo && e.commit <= hi) changed[e.file] = 1
    }
    applyFilter({ keep: changed, label: `changed in range` })
  }

  if (diffRange) {
    const [a, b] = diffRange
    const dateOf = (i: number): string =>
      new Date(commits[Math.min(i, max)].time * 1000).toLocaleDateString()
    return (
      <div className="timeline diff-mode">
        <span className="timeline-label">
          ⇆ Comparing <em>#{Math.min(a, b) + 1}</em> ({dateOf(Math.min(a, b))}) →{' '}
          <em>#{Math.max(a, b) + 1}</em> ({dateOf(Math.max(a, b))})
          {diffCounts && (
            <>
              {' · '}
              <span className="diff-added">+{diffCounts.added}</span>{' '}
              <span className="diff-modified">~{diffCounts.modified}</span>{' '}
              <span className="diff-deleted">−{diffCounts.deleted}</span>
            </>
          )}
        </span>
        <input
          type="range"
          min={0}
          max={max}
          value={a}
          onChange={(e) => setDiffRange([Number(e.target.value), b])}
        />
        <input
          type="range"
          min={0}
          max={max}
          value={b}
          onChange={(e) => setDiffRange([a, Number(e.target.value)])}
        />
        <div className="timeline-diff-actions">
          <label className="diff-check">
            <input
              type="checkbox"
              checked={changedOnly}
              onChange={(e) => applyChangedOnly(e.target.checked, diffRange)}
            />
            changed only
          </label>
          <button className="btn" onClick={exitDiff}>
            ✕ exit diff
          </button>
        </div>
      </div>
    )
  }

  const idx = timeIndex < 0 ? max : timeIndex
  const commit = commits[Math.min(idx, max)]
  const date = new Date(commit.time * 1000).toLocaleDateString()

  return (
    <div className="timeline">
      <span className="timeline-label">
        {idx === max ? 'HEAD' : `#${idx + 1}/${commits.length}`} · {date}
        {idx !== max && (
          <em>
            {' '}
            — {commit.subject.slice(0, 60)} ({commit.author})
          </em>
        )}
        <button
          className="btn timeline-diff-btn"
          title="Compare two points in history (diff mode)"
          onClick={() => setDiffRange([Math.max(0, max - Math.min(100, max)), max])}
        >
          ⇆
        </button>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        value={idx}
        onChange={(e) => {
          const v = Number(e.target.value)
          setTimeIndex(v >= max ? -1 : v)
        }}
      />
      {idx !== max && (
        <button className="btn" onClick={() => setTimeIndex(-1)}>
          ⏭ HEAD
        </button>
      )}
    </div>
  )
}
