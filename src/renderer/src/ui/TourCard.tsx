import { useEffect, useRef, useState } from 'react'
import { useAtlas } from '../store'
import { stopTour } from '../tour'

export function TourCard(): React.JSX.Element | null {
  const tour = useAtlas((s) => s.tour)
  const { setTour } = useAtlas()
  const [shown, setShown] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = tour && tour.current >= 0 ? tour.stops[tour.current] : null

  // typewriter reveal + auto-advance
  useEffect(() => {
    if (!stop) return
    setShown(0)
    const reveal = setInterval(() => setShown((v) => v + 3), 30)
    timerRef.current = reveal
    const holdMs = Math.max(5000, stop.narration.length * 55)
    const advance = setTimeout(() => {
      const t = useAtlas.getState().tour
      if (!t || !t.playing) return
      if (t.current < t.stops.length - 1) {
        useAtlas.getState().setTour({ ...t, current: t.current + 1 })
      } else if (t.done) {
        stopTour()
      }
    }, holdMs)
    return () => {
      clearInterval(reveal)
      clearTimeout(advance)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour?.current, stop?.narration])

  if (!tour) return null
  if (!stop) {
    return (
      <div className="tour-card">
        <div className="tour-title">🎓 Planning your tour…</div>
      </div>
    )
  }

  const go = (delta: number): void => {
    const next = tour.current + delta
    if (next >= 0 && next < tour.stops.length) setTour({ ...tour, current: next })
  }

  return (
    <div className="tour-card">
      <div className="tour-head">
        <span className="tour-title">
          🎓 {tour.current + 1}
          {tour.done ? `/${tour.stops.length}` : ''} · {stop.title}
        </span>
        <span className="tour-controls">
          <button className="btn" disabled={tour.current === 0} onClick={() => go(-1)}>
            ‹
          </button>
          <button
            className="btn"
            disabled={tour.current >= tour.stops.length - 1}
            onClick={() => go(1)}
          >
            ›
          </button>
          <button className="btn" onClick={() => stopTour()}>
            ✕
          </button>
        </span>
      </div>
      <div className="tour-narration">{stop.narration.slice(0, shown)}</div>
    </div>
  )
}
