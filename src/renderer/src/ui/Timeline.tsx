import { useAtlas } from '../store'

export function Timeline(): React.JSX.Element | null {
  const snapshot = useAtlas((s) => s.snapshot)
  const timeIndex = useAtlas((s) => s.timeIndex)
  const mode = useAtlas((s) => s.mode)
  const { setTimeIndex } = useAtlas()

  if (!snapshot || snapshot.timeline.commits.length < 2 || mode === 'molecule') return null
  const commits = snapshot.timeline.commits
  const max = commits.length - 1
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
