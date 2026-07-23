import { useAtlas } from '../store'

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'k'
  if (n >= 1_000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

export function HudStats(): React.JSX.Element | null {
  const snapshot = useAtlas((s) => s.snapshot)
  const mode = useAtlas((s) => s.mode)
  const moleculeFile = useAtlas((s) => s.moleculeFile)
  const moleculeGraph = useAtlas((s) => s.moleculeGraph)

  if (!snapshot) return null

  if (mode === 'molecule' && moleculeGraph) {
    const file = moleculeFile !== null ? snapshot.files[moleculeFile] : null
    return (
      <div className="hud-chip">
        <span className="hud-name">🧬 {file?.name ?? 'module'}</span>
        <span>{moleculeGraph.symbols.length} symbols</span>
        <span>{moleculeGraph.edges.length} bonds</span>
        <span className="hud-dim">Esc to exit</span>
      </div>
    )
  }

  const repoName = snapshot.rootPath.split('/').filter(Boolean).pop() ?? snapshot.rootPath
  return (
    <div className="hud-chip">
      <span className="hud-name">📦 {repoName}</span>
      <span>{fmt(snapshot.stats.totalFiles)} files</span>
      <span>{fmt(snapshot.stats.totalLoc)} loc</span>
      <span>{fmt(snapshot.importEdges.length / 2)} imports</span>
      {snapshot.timeline.commits.length > 0 && (
        <span>{fmt(snapshot.timeline.commits.length)} commits</span>
      )}
    </div>
  )
}
