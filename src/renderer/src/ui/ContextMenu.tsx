import { useAtlas } from '../store'
import { filterDependencies, filterDependents, isolateNeighborhood, applyFilter } from '../graphops'
import { enterMoleculeFor } from '../molecule'

export function ContextMenu(): React.JSX.Element | null {
  const menu = useAtlas((s) => s.contextMenu)
  const snapshot = useAtlas((s) => s.snapshot)
  const { setContextMenu, setSelected, setChatOpen, requestFlyTo } = useAtlas()

  if (!menu || !snapshot) return null
  const f = snapshot.files[menu.fileId]
  const close = (): void => setContextMenu(null)
  const act = (fn: () => void) => (): void => {
    fn()
    close()
  }

  return (
    <div className="ctx-overlay" onClick={close} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="ctx-menu"
        style={{
          left: Math.min(menu.x, window.innerWidth - 240),
          top: Math.min(menu.y, window.innerHeight - 290)
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ctx-title">{f.name}</div>
        <button className="ctx-item" onClick={act(() => { setSelected(menu.fileId); requestFlyTo(menu.fileId) })}>
          ✈ Fly to & open
        </button>
        <button className="ctx-item" onClick={act(() => isolateNeighborhood(snapshot, menu.fileId))}>
          🎯 Isolate neighborhood
        </button>
        <button className="ctx-item" onClick={act(() => filterDependencies(snapshot, menu.fileId))}>
          ⬇ Show what it imports
        </button>
        <button className="ctx-item" onClick={act(() => filterDependents(snapshot, menu.fileId))}>
          ⬆ Show what depends on it
        </button>
        <button className="ctx-item" onClick={act(() => void enterMoleculeFor(menu.fileId))}>
          🧬 Explode into molecule
        </button>
        <button className="ctx-item" onClick={act(() => { setSelected(menu.fileId); setChatOpen(true) })}>
          💬 Ask AI about this file
        </button>
        <button className="ctx-item dim" onClick={act(() => applyFilter(null))}>
          ✕ Clear filters
        </button>
      </div>
    </div>
  )
}
