// File dossier: metrics, churn, symbols, graph relations, health context.
// Docks to the right of the code preview when a file is selected.
import { useEffect, useState } from 'react'
import { useAtlas } from '../store'
import type { ModuleGraph } from '../../../shared/model'
import { enterMoleculeFor } from '../molecule'

function Bar({ label, value, max, format }: { label: string; value: number; max: number; format?: (v: number) => string }): React.JSX.Element {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="insp-bar-row">
      <span className="insp-bar-label">{label}</span>
      <div className="insp-bar-track">
        <div className="insp-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="insp-bar-value">{format ? format(value) : value}</span>
    </div>
  )
}

const KIND_ICON: Record<string, string> = {
  module: '📦',
  class: '🏛',
  function: 'ƒ',
  method: '·ƒ',
  type: '𝕋',
  variable: '𝑥'
}

export function Inspector(): React.JSX.Element | null {
  const selected = useAtlas((s) => s.selected)
  const snapshot = useAtlas((s) => s.snapshot)
  const health = useAtlas((s) => s.health)
  const coverage = useAtlas((s) => s.coverage)
  const { requestFlyTo, setChatOpen } = useAtlas()
  const [symbols, setSymbols] = useState<ModuleGraph | null>(null)

  useEffect(() => {
    setSymbols(null)
    if (selected === null) return
    let cancelled = false
    void window.atlas.getModuleGraph([selected]).then((g) => {
      if (!cancelled) setSymbols(g)
    })
    return () => {
      cancelled = true
    }
  }, [selected])

  if (selected === null || !snapshot) return null
  const f = snapshot.files[selected]

  // percentile context for the bars
  const maxCx = Math.max(1, ...snapshot.files.map((x) => x.complexity))
  const maxLoc = Math.max(1, ...snapshot.files.map((x) => x.loc))
  const imports: number[] = []
  const importedBy: number[] = []
  const e = snapshot.importEdges
  for (let i = 0; i + 1 < e.length; i += 2) {
    if (e[i] === selected) imports.push(e[i + 1])
    if (e[i + 1] === selected) importedBy.push(e[i])
  }
  const cycleIdx = health ? health.cycleOf[selected] : -1
  const transDeps = health ? health.transitiveDependents[selected] : 0
  const cov = coverage?.[selected] ?? -1
  const topSymbols = (symbols?.symbols ?? [])
    .filter((s) => s.kind !== 'module')
    .sort((a, b) => b.range[1] - b.range[0] - (a.range[1] - a.range[0]))
    .sort((a, b) => (a.kind === 'class' ? -1 : 1) - (b.kind === 'class' ? -1 : 1))
    .slice(0, 12)

  return (
    <div className="inspector">
      <div className="insp-metrics">
        <Bar label="loc" value={f.loc} max={maxLoc} />
        <Bar label="complexity" value={f.complexity} max={maxCx} />
        <Bar label="commits" value={f.churn.commits} max={Math.max(20, f.churn.commits)} />
        {f.todoCount > 0 && <Bar label="TODOs" value={f.todoCount} max={Math.max(5, f.todoCount)} />}
        {cov >= 0 && <Bar label="coverage" value={cov} max={1} format={(v) => `${Math.round(v * 100)}%`} />}
      </div>
      <div className="insp-facts">
        {f.churn.topAuthor && (
          <span title={`${Math.round(f.churn.topShare * 100)}% of commits`}>
            👤 {f.churn.topAuthor}
            {f.churn.topShare > 0.9 && f.churn.commits > 3 ? ' ⚠ bus factor 1' : ''}
          </span>
        )}
        {f.churn.lastTouched > 0 && (
          <span>🕐 {new Date(f.churn.lastTouched * 1000).toLocaleDateString()}</span>
        )}
        {cycleIdx >= 0 && <span className="insp-warn">🔄 in cycle #{cycleIdx + 1}</span>}
        {transDeps > 50 && <span className="insp-warn">🏛 {transDeps} transitive dependents</span>}
      </div>
      {topSymbols.length > 0 && (
        <div className="insp-section">
          <div className="insp-title">Symbols ({f.symbolCount})</div>
          <div className="insp-symbols">
            {topSymbols.map((s, i) => (
              <span key={i} className="insp-symbol" title={`lines ${s.range[0] + 1}–${s.range[1] + 1}`}>
                {KIND_ICON[s.kind] ?? ''} {s.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {(imports.length > 0 || importedBy.length > 0) && (
        <div className="insp-section">
          <div className="insp-title">
            Imports {imports.length} · Imported by {importedBy.length}
          </div>
          <div className="insp-links">
            {imports.slice(0, 6).map((id) => (
              <button key={`i${id}`} className="insp-link" onClick={() => requestFlyTo(id)}>
                → {snapshot.files[id].name}
              </button>
            ))}
            {importedBy.slice(0, 6).map((id) => (
              <button key={`b${id}`} className="insp-link" onClick={() => requestFlyTo(id)}>
                ← {snapshot.files[id].name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="insp-actions">
        <button className="btn" onClick={() => requestFlyTo(selected)}>
          ✈ Fly
        </button>
        <button className="btn" onClick={() => void enterMoleculeFor(selected)}>
          🧬 Molecule
        </button>
        <button className="btn" onClick={() => setChatOpen(true)}>
          💬 Ask AI
        </button>
      </div>
    </div>
  )
}
