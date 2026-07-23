import { useAtlas } from '../store'

const PHASE_LABEL: Record<string, string> = {
  scan: 'Scanning files',
  parse: 'Parsing code',
  git: 'Reading git history',
  link: 'Resolving imports',
  done: 'Done',
  error: 'Analysis failed'
}

export function ProgressOverlay(): React.JSX.Element | null {
  const progress = useAtlas((s) => s.progress)
  const snapshot = useAtlas((s) => s.snapshot)

  if (!progress || progress.phase === 'done') return null
  if (progress.phase === 'error') {
    return (
      <div className="progress-overlay">
        <div className="progress-card error">
          <div className="progress-phase">⚠ {progress.error}</div>
        </div>
      </div>
    )
  }
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <div className={`progress-overlay ${snapshot ? 'corner' : ''}`}>
      <div className="progress-card">
        <div className="progress-phase">{PHASE_LABEL[progress.phase] ?? progress.phase}</div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-detail">
          {progress.done}/{progress.total} {progress.currentPath ? `· ${progress.currentPath}` : ''}
        </div>
      </div>
    </div>
  )
}
