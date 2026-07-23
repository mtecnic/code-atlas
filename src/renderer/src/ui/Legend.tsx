import { useState } from 'react'
import { useAtlas } from '../store'
import { languageColor } from '../../../shared/languages'

export function Legend(): React.JSX.Element | null {
  const snapshot = useAtlas((s) => s.snapshot)
  const mode = useAtlas((s) => s.mode)
  const [open, setOpen] = useState(true)

  if (!snapshot || mode === 'molecule') return null
  const entries = Object.entries(snapshot.stats.languages)
    .filter(([lang]) => lang !== 'other')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  if (!entries.length) return null

  return (
    <div className="legend">
      <button className="legend-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Languages
      </button>
      {open &&
        entries.map(([lang, count]) => (
          <div key={lang} className="legend-row">
            <span className="legend-swatch" style={{ background: languageColor(lang) }} />
            <span className="legend-lang">{lang}</span>
            <span className="legend-count">{count}</span>
          </div>
        ))}
    </div>
  )
}
