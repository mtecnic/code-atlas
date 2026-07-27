import { useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { useAtlas } from '../store'

export function SearchPalette(): React.JSX.Element | null {
  const open = useAtlas((s) => s.searchOpen)
  const snapshot = useAtlas((s) => s.snapshot)
  const { setSearchOpen, requestFlyTo, setMode, setMolecule } = useAtlas()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  // semantic layer: AI summaries (if built) join the search index
  useEffect(() => {
    if (!open || !snapshot) return
    void window.atlas.getSummaries().then(setSummaries)
  }, [open, snapshot])

  const fuse = useMemo(() => {
    if (!snapshot) return null
    return new Fuse(
      snapshot.files.map((f, id) => ({
        id,
        path: f.path,
        name: f.name,
        summary: summaries[f.path] ?? ''
      })),
      {
        keys: [
          { name: 'name', weight: 2 },
          { name: 'path', weight: 1 },
          { name: 'summary', weight: 1.6 }
        ],
        threshold: 0.42,
        ignoreLocation: true
      }
    )
  }, [snapshot, summaries])

  const results = useMemo(() => {
    if (!fuse || !query.trim()) return []
    return fuse.search(query, { limit: 12 })
  }, [fuse, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  if (!open || !snapshot) return null

  const go = (fileId: number): void => {
    setSearchOpen(false)
    const state = useAtlas.getState()
    if (state.mode === 'molecule') {
      setMolecule(null, null)
      setMode('city')
    }
    requestFlyTo(fileId)
  }

  const indexed = Object.keys(summaries).length

  return (
    <div className="overlay" onClick={() => setSearchOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={
            indexed > 0 ? `Search files or meaning… (${indexed} AI-indexed)` : 'Fly to a file…'
          }
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSearchOpen(false)
            else if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, results.length - 1))
            else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0))
            else if (e.key === 'Enter' && results[cursor]) go(results[cursor].item.id)
          }}
        />
        <div className="palette-results">
          {results.map((r, i) => (
            <div
              key={r.item.id}
              className={`palette-row ${i === cursor ? 'active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(r.item.id)}
            >
              <div className="palette-main">
                <span className="palette-name">{r.item.name}</span>
                <span className="palette-path">{r.item.path}</span>
              </div>
              {r.item.summary && <div className="palette-summary">{r.item.summary}</div>}
            </div>
          ))}
          {query && !results.length && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  )
}
