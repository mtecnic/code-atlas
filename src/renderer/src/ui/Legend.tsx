import { useState } from 'react'
import { useAtlas } from '../store'
import { languageColor } from '../../../shared/languages'
import { filterByLanguage } from '../graphops'

export function Legend(): React.JSX.Element | null {
  const snapshot = useAtlas((s) => s.snapshot)
  const mode = useAtlas((s) => s.mode)
  const lensLegend = useAtlas((s) => s.lensLegend)
  const [open, setOpen] = useState(true)

  if (!snapshot || mode === 'molecule') return null

  let title = 'Legend'
  let body: React.JSX.Element | null = null

  if (!lensLegend || lensLegend.kind === 'language') {
    title = 'Languages'
    const entries = Object.entries(snapshot.stats.languages)
      .filter(([lang]) => lang !== 'other')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
    if (!entries.length) return null
    body = (
      <>
        {entries.map(([lang, count]) => (
          <div
            key={lang}
            className="legend-row clickable"
            title={`Filter city to ${lang} files`}
            onClick={() => filterByLanguage(snapshot, lang)}
          >
            <span className="legend-swatch" style={{ background: languageColor(lang) }} />
            <span className="legend-lang">{lang}</span>
            <span className="legend-count">{count}</span>
          </div>
        ))}
      </>
    )
  } else if (lensLegend.kind === 'ramp') {
    title = lensLegend.label
    body = (
      <div className="legend-ramp">
        <div
          className="legend-ramp-bar"
          style={{ background: `linear-gradient(90deg, ${lensLegend.stops.join(', ')})` }}
        />
        <div className="legend-ramp-labels">
          <span>{lensLegend.low}</span>
          <span>{lensLegend.high}</span>
        </div>
      </div>
    )
  } else {
    title = 'Top authors'
    body = (
      <>
        {lensLegend.authors.map((a) => (
          <div key={a.name} className="legend-row">
            <span className="legend-swatch" style={{ background: a.color }} />
            <span className="legend-lang" title={a.name}>
              {a.name.length > 16 ? a.name.slice(0, 15) + '…' : a.name}
            </span>
            <span className="legend-count">{a.files}</span>
          </div>
        ))}
        <div className="legend-note">bright glow = bus factor 1</div>
      </>
    )
  }

  return (
    <div className="legend">
      <button className="legend-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {title}
      </button>
      {open && body}
    </div>
  )
}
