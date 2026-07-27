import { useEffect, useRef, useState } from 'react'
import { useAtlas } from './store'
import { SceneManager } from './scene/SceneManager'
import { Toolbar } from './ui/Toolbar'
import { SearchPalette } from './ui/SearchPalette'
import { EditorPanel } from './ui/EditorPanel'
import { ChatPanel } from './ui/ChatPanel'
import { SettingsPanel } from './ui/SettingsPanel'
import { Timeline } from './ui/Timeline'
import { ProgressOverlay } from './ui/ProgressOverlay'
import { HudStats } from './ui/HudStats'
import { Legend } from './ui/Legend'
import { FindingsPanel } from './ui/FindingsPanel'
import { Inspector } from './ui/Inspector'
import { ContextMenu } from './ui/ContextMenu'
import { TourCard } from './ui/TourCard'
import { stopTour } from './tour'
import { analyzeHealth } from './analysis/graph-health'
import * as graphops from './graphops'
import { streamChat } from './llm'

function HoverTooltip(): React.JSX.Element | null {
  const hover = useAtlas((s) => s.hover)
  const snapshot = useAtlas((s) => s.snapshot)
  if (!hover || !snapshot) return null
  const f = snapshot.files[hover.fileId]
  return (
    <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 10 }}>
      <div className="tooltip-name">{f.name}</div>
      <div className="tooltip-detail">
        {f.path}
        <br />
        {f.language ?? 'unknown'} · {f.loc} loc · {f.churn.commits} commits
        {f.churn.authors > 0 ? ` · ${f.churn.authors} authors` : ''}
      </div>
    </div>
  )
}

function Welcome({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const snapshot = useAtlas((s) => s.snapshot)
  const progress = useAtlas((s) => s.progress)
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    void window.atlas.getSettings().then((s) => setRecents(s.recentRepos ?? []))
  }, [])

  if (snapshot || (progress && progress.phase !== 'error')) return null
  return (
    <div className="welcome">
      <h1>⛩ Code Atlas</h1>
      <p>Open a folder to render its codebase as a navigable 3D world.</p>
      <button className="btn accent big" onClick={onOpen}>
        📂 Open a codebase
      </button>
      {recents.length > 0 && (
        <div className="recents">
          {recents.slice(0, 6).map((r) => (
            <button key={r} className="recent-row" onClick={() => void window.atlas.analyze(r)}>
              <span className="recent-name">{r.split('/').filter(Boolean).pop()}</span>
              <span className="recent-path">{r}</span>
            </button>
          ))}
        </div>
      )}
      <p className="hint">
        City · Galaxy · Molecule views — WASD fly-through, git time-scrub, dependency arcs, AI
        copilot & tours.
      </p>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneManager | null>(null)
  const [cameraMode, setCameraMode] = useState<'orbit' | 'fly'>('orbit')

  useEffect(() => {
    if (!mountRef.current || sceneRef.current) return
    sceneRef.current = new SceneManager(mountRef.current)

    // dev/test hook used by the ATLAS_* env helpers in the main process
    ;(window as unknown as Record<string, unknown>).__atlasDebug = {
      store: useAtlas,
      graphops,
      llm: { streamChat },
      tourModule: import("./tour")
    }
    const offGl = window.atlas.onGlInfo((info) => useAtlas.getState().setGlInfo(info))
    const offProgress = window.atlas.onProgress((p) => useAtlas.getState().setProgress(p))
    const offSnapshot = window.atlas.onSnapshot((s) => {
      const state = useAtlas.getState()
      state.setSnapshot(s)
      state.setHealth(analyzeHealth(s))
    })
    void window.atlas.getSettings().then((s) => {
      if (s.llm) useAtlas.getState().setLlm(s.llm)
    })
    return () => {
      offGl()
      offProgress()
      offSnapshot()
      sceneRef.current?.dispose()
      sceneRef.current = null
    }
  }, [])

  const toggleCamera = (): void => {
    setCameraMode((prev) => {
      const next = prev === 'orbit' ? 'fly' : 'orbit'
      sceneRef.current?.setCameraMode(next)
      return next
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const state = useAtlas.getState()
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT'
      if (e.key === 'Escape') {
        if (state.contextMenu) state.setContextMenu(null)
        else if (state.tour) stopTour()
        else if (state.searchOpen) state.setSearchOpen(false)
        else if (state.settingsOpen) state.setSettingsOpen(false)
        else if (state.fileFilter) state.setFileFilter(null)
        else if (state.mode === 'molecule') {
          state.setMolecule(null, null)
          state.setMode('city')
        } else if (state.selected !== null) state.setSelected(null)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        state.setSearchOpen(!state.searchOpen)
      } else if (e.code === 'KeyH' && !typing && !e.ctrlKey && !e.metaKey) {
        state.requestReframe()
      } else if (/^Digit[1-5]$/.test(e.code) && !typing && !e.ctrlKey && !e.metaKey) {
        // camera bookmarks: Shift+N saves, N recalls
        const slot = Number(e.code.slice(5)) - 1
        const repo = state.snapshot?.rootPath
        const scene = sceneRef.current
        if (!repo || !scene) return
        void window.atlas.getSettings().then(async (settings) => {
          const all = settings.bookmarks ?? {}
          const list = all[repo] ?? []
          if (e.shiftKey) {
            const pose = scene.saveBookmark()
            list[slot] = { name: `slot ${slot + 1}`, ...pose }
            await window.atlas.saveSettings({ bookmarks: { ...all, [repo]: list } })
          } else if (list[slot]) {
            scene.gotoBookmark(list[slot].pos, list[slot].target)
          }
        })
      } else if (e.key === 'Tab' && !typing) {
        e.preventDefault()
        toggleCamera()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openFolder = async (): Promise<void> => {
    const path = await window.atlas.openFolderDialog()
    if (path) await window.atlas.analyze(path)
  }

  return (
    <div className="app">
      <div className="scene-mount" ref={mountRef} />
      <Toolbar
        onOpenFolder={() => void openFolder()}
        onCameraToggle={toggleCamera}
        onScreenshot={() => {
          const url = sceneRef.current?.captureHiRes(3)
          if (url) void window.atlas.saveScreenshot(url)
        }}
        cameraMode={cameraMode}
      />
      <Welcome onOpen={() => void openFolder()} />
      <HoverTooltip />
      <ProgressOverlay />
      <HudStats />
      <Legend />
      <Timeline />
      <EditorPanel />
      <Inspector />
      <FindingsPanel />
      <ChatPanel />
      <SearchPalette />
      <SettingsPanel />
      <ContextMenu />
      <TourCard />
      {cameraMode === 'fly' && (
        <div className="fly-hint">WASD move · QE up/down · Shift boost · Esc exit fly mode</div>
      )}
    </div>
  )
}
