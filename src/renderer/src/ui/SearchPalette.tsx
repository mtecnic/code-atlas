import { useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { useAtlas } from '../store'

export function SearchPalette(): React.JSX.Element | null {
  const open = useAtlas((s) => s.searchOpen)
  const snapshot = useAtlas((s) => s.snapshot)
  const { setSearchOpen, requestFlyTo, setMode, setMolecule } = useAtlas()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const fuse = useMemo(() => {
    if (!snapshot) return null
    return new Fuse(
      snapshot.files.map((f, id) => ({ id, path: f.path, name: f.name })),
      { keys: [{ name: 'name', weight: 2 }, 'path'], threshold: 0.38 }
    )
  }, [snapshot])

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

  return (
    <div className="overlay" onClick={() => setSearchOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Fly to a file…"
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
              <span className="palette-name">{r.item.name}</span>
              <span className="palette-path">{r.item.path}</span>
            </div>
          ))}
          {query && !results.length && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  )
}
