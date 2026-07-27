import { useAtlas } from '../store'
import type { ViewMode } from '../store'
import { enterMoleculeFor } from '../molecule'
import { LENSES, type LensId } from '../lenses'

const MODES: { id: ViewMode; label: string; icon: string }[] = [
  { id: 'city', label: 'City', icon: '🏙' },
  { id: 'galaxy', label: 'Galaxy', icon: '🌌' },
  { id: 'molecule', label: 'Molecule', icon: '🧬' }
]

export function Toolbar({
  onOpenFolder,
  onCameraToggle,
  cameraMode
}: {
  onOpenFolder: () => void
  onCameraToggle: () => void
  cameraMode: 'orbit' | 'fly'
}): React.JSX.Element {
  const mode = useAtlas((s) => s.mode)
  const snapshot = useAtlas((s) => s.snapshot)
  const theme = useAtlas((s) => s.theme)
  const selected = useAtlas((s) => s.selected)
  const lens = useAtlas((s) => s.lens)
  const coverage = useAtlas((s) => s.coverage)
  const health = useAtlas((s) => s.health)
  const healthOpen = useAtlas((s) => s.healthOpen)
  const {
    setMode,
    setTheme,
    setSearchOpen,
    setSettingsOpen,
    setChatOpen,
    setMolecule,
    requestReframe,
    setLens,
    setCoverage,
    setHealthOpen
  } = useAtlas()

  const findingCount = health ? health.cycles.length + health.dead.length : 0

  const pickLens = async (id: LensId): Promise<void> => {
    if (id === 'coverage' && !coverage) {
      const loaded = await window.atlas.loadLcov()
      if (!loaded) return // canceled — keep previous lens
      setCoverage(loaded.coverage)
    }
    setLens(id)
  }

  const enterMolecule = async (): Promise<void> => {
    if (selected === null || !snapshot) return
    await enterMoleculeFor(selected)
  }

  return (
    <div className="toolbar">
      <button className="btn accent" onClick={onOpenFolder}>
        📂 Open
      </button>
      <div className="mode-group">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`btn ${mode === m.id ? 'active' : ''}`}
            disabled={!snapshot || (m.id === 'molecule' && selected === null && mode !== 'molecule')}
            title={
              m.id === 'molecule' && selected === null
                ? 'Click a building first (or just double-click one)'
                : m.label
            }
            onClick={() => {
              if (m.id === 'molecule') void enterMolecule()
              else {
                setMolecule(null, null)
                setMode(m.id)
              }
            }}
          >
            {m.icon} {m.label}
          </button>
        ))}
      </div>
      <select
        className="btn lens-select"
        disabled={!snapshot}
        value={lens}
        title="Insight lens — how the city is colored"
        onChange={(e) => void pickLens(e.target.value as LensId)}
      >
        {LENSES.map((l) => (
          <option key={l.id} value={l.id}>
            🔬 {l.label}
          </option>
        ))}
      </select>
      <button
        className={`btn ${healthOpen ? 'active' : ''}`}
        disabled={!snapshot || !health}
        onClick={() => setHealthOpen(!healthOpen)}
        title="Architecture health: cycles, load-bearing files, dead code"
      >
        ⚕ Health{findingCount > 0 ? ` (${findingCount})` : ''}
      </button>
      <div className="spacer" />
      <button
        className="btn"
        disabled={!snapshot}
        onClick={() => requestReframe()}
        title="Reframe view (H)"
      >
        ⌂
      </button>
      <button className="btn" disabled={!snapshot} onClick={() => setSearchOpen(true)} title="Ctrl+K">
        🔍 Search
      </button>
      <button className="btn" onClick={onCameraToggle} title="Tab">
        {cameraMode === 'orbit' ? '🛸 Fly' : '🌐 Orbit'}
      </button>
      <button className="btn" onClick={() => setTheme(theme === 'night' ? 'day' : 'night')}>
        {theme === 'night' ? '☀️' : '🌙'}
      </button>
      <button className="btn" disabled={!snapshot} onClick={() => setChatOpen(true)}>
        💬 Ask AI
      </button>
      <button className="btn" onClick={() => setSettingsOpen(true)}>
        ⚙️
      </button>
    </div>
  )
}
