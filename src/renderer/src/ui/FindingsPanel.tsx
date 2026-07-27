import { useState } from 'react'
import { useAtlas } from '../store'

export function FindingsPanel(): React.JSX.Element | null {
  const open = useAtlas((s) => s.healthOpen)
  const health = useAtlas((s) => s.health)
  const snapshot = useAtlas((s) => s.snapshot)
  const { setHealthOpen, requestFlyTo } = useAtlas()
  const [expandedCycle, setExpandedCycle] = useState<number | null>(0)
  const [showAllDead, setShowAllDead] = useState(false)

  if (!open || !health || !snapshot) return null
  const name = (id: number): string => snapshot.files[id].path

  const fly = (id: number): void => requestFlyTo(id)
  const deadShown = showAllDead ? health.dead : health.dead.slice(0, 30)

  return (
    <div className="findings-panel">
      <div className="findings-header">
        <span>
          ⚕ Architecture Health — {health.cycles.length} cycles ·{' '}
          {health.loadBearing.length ? 'load-bearing files' : 'no hubs'} · {health.dead.length}{' '}
          possibly dead
        </span>
        <button className="btn" onClick={() => setHealthOpen(false)}>
          ✕
        </button>
      </div>
      <div className="findings-scroll">
        {health.cycles.length > 0 && (
          <>
            <div className="findings-section">🔄 Dependency cycles</div>
            {health.cycles.map((c, i) => (
              <div key={i} className="finding">
                <button
                  className="finding-title"
                  onClick={() => setExpandedCycle(expandedCycle === i ? null : i)}
                >
                  {expandedCycle === i ? '▾' : '▸'} {c.files.length} files,{' '}
                  {c.edges.length / 2} edges — <em>{name(c.files[0]).split('/').pop()} …</em>
                </button>
                {expandedCycle === i &&
                  c.files.slice(0, 40).map((f) => (
                    <button key={f} className="finding-file" onClick={() => fly(f)}>
                      {name(f)}
                    </button>
                  ))}
              </div>
            ))}
          </>
        )}
        {health.loadBearing.length > 0 && (
          <>
            <div className="findings-section">🏛 Load-bearing files</div>
            {health.loadBearing.map((l) => (
              <button key={l.file} className="finding-file wide" onClick={() => fly(l.file)}>
                <span className="finding-path">{name(l.file)}</span>
                <span className="finding-meta">
                  {l.transitiveDependents} dependents ({l.directDependents} direct)
                </span>
              </button>
            ))}
          </>
        )}
        {health.dead.length > 0 && (
          <>
            <div className="findings-section">🪦 Possibly dead (nothing imports them)</div>
            {deadShown.map((d) => (
              <button key={d.file} className="finding-file" onClick={() => fly(d.file)}>
                {name(d.file)}
              </button>
            ))}
            {!showAllDead && health.dead.length > 30 && (
              <button className="finding-title" onClick={() => setShowAllDead(true)}>
                … show all {health.dead.length}
              </button>
            )}
          </>
        )}
        {!health.cycles.length && !health.dead.length && (
          <div className="findings-empty">No cycles, no dead files. Clean graph. 🏆</div>
        )}
      </div>
    </div>
  )
}
