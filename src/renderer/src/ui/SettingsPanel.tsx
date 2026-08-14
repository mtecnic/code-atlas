import { useEffect, useState } from 'react'
import { useAtlas } from '../store'
import type { LlmEndpoint } from '../../../shared/model'

export function SettingsPanel(): React.JSX.Element | null {
  const open = useAtlas((s) => s.settingsOpen)
  const llm = useAtlas((s) => s.llm)
  const glInfo = useAtlas((s) => s.glInfo)
  const { setSettingsOpen, setLlm } = useAtlas()
  const [host, setHost] = useState('')
  const [status, setStatus] = useState<string>('')
  const [probing, setProbing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [savedEndpoints, setSavedEndpoints] = useState<LlmEndpoint[]>([])

  useEffect(() => {
    if (!open) return
    void window.atlas.getSettings().then((s) => {
      setHasKey(!!s.hasLlmKey)
      setSavedEndpoints(s.llmEndpoints ?? [])
    })
  }, [open, llm])

  const useEndpoint = async (ep: LlmEndpoint): Promise<void> => {
    setLlm(ep)
    await window.atlas.saveSettings({ llm: ep })
    setStatus(`✓ Switched to ${ep.baseUrl} · ${ep.model}`)
  }

  const forgetEndpoint = async (ep: LlmEndpoint): Promise<void> => {
    const next = savedEndpoints.filter((e2) => e2.baseUrl !== ep.baseUrl)
    setSavedEndpoints(next)
    await window.atlas.saveSettings({ llmEndpoints: next })
  }
  const [indexBusy, setIndexBusy] = useState(false)
  const [indexProgress, setIndexProgress] = useState('')
  const [indexStatus, setIndexStatus] = useState('')
  const [watchOn, setWatchOn] = useState(false)

  useEffect(() => {
    if (open) void window.atlas.getSettings().then((s) => setWatchOn(!!s.watch))
  }, [open])

  useEffect(() => {
    const off = window.atlas.onSummariesProgress(({ done, total }) =>
      setIndexProgress(`${done}/${total}`)
    )
    return off
  }, [])

  const buildIndex = async (): Promise<void> => {
    setIndexBusy(true)
    setIndexStatus('')
    const result = await window.atlas.buildSummaries()
    setIndexBusy(false)
    if ('error' in result) setIndexStatus(`✗ ${result.error}`)
    else
      setIndexStatus(
        `✓ ${result.built} summarized, ${result.cached} already cached, of ${result.total} candidates`
      )
  }

  useEffect(() => {
    if (open && llm) setHost(llm.baseUrl.replace(/^https?:\/\//, ''))
  }, [open, llm])

  if (!open) return null

  const probe = async (): Promise<void> => {
    if (!host.trim()) return
    setProbing(true)
    setStatus('Probing…')
    const result = await window.atlas.llmProbe(host.trim(), undefined, apiKey || undefined)
    setProbing(false)
    if (result.ok && result.endpoint) {
      setLlm(result.endpoint)
      setApiKey('')
      void window.atlas.getSettings().then((s2) => {
        setHasKey(!!s2.hasLlmKey)
        setSavedEndpoints(s2.llmEndpoints ?? [])
      })
      const pf = result.preflight
      const pfNote = pf
        ? pf.ok
          ? ' · chat verified ✓'
          : ` · ⚠ ${pf.message}`
        : ''
      setStatus(
        `✓ Found ${result.endpoint.style === 'openai' ? 'OpenAI-compatible' : 'Ollama'} server at ${result.endpoint.baseUrl} — ${result.endpoint.models.length} model(s)${pfNote}`
      )
    } else {
      setStatus(`✗ ${result.error ?? 'Nothing found'}`)
    }
  }

  const pickModel = async (model: string): Promise<void> => {
    if (!llm) return
    const next = { ...llm, model }
    setLlm(next)
    const list = savedEndpoints.map((e2) => (e2.baseUrl === next.baseUrl ? next : e2))
    setSavedEndpoints(list)
    await window.atlas.saveSettings({ llm: next, llmEndpoints: list })
  }

  return (
    <div className="overlay" onClick={() => setSettingsOpen(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <h3>LLM endpoint</h3>
        <p className="hint">
          An IP or host scans common local ports (vLLM, llama.cpp, LM Studio, Ollama); a full
          http(s) address is used directly. Optional key for secured endpoints.
        </p>
        <div className="row">
          <input
            value={host}
            placeholder="192.168.86.23 · localhost:8000 · http://box:8080"
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void probe()}
          />
          <button className="btn accent" disabled={probing} onClick={() => void probe()}>
            {probing ? '…' : 'Detect'}
          </button>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <input
            type="password"
            value={apiKey}
            placeholder={hasKey ? 'API key (saved — leave blank to keep)' : 'API key (optional)'}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        {status && <p className="status">{status}</p>}
        {savedEndpoints.length > 0 && (
          <>
            <h3>Saved endpoints</h3>
            {savedEndpoints.map((ep) => (
              <div key={ep.baseUrl} className={`endpoint-row${llm?.baseUrl === ep.baseUrl ? ' active' : ''}`}>
                <div className="endpoint-info">
                  <span className="endpoint-url">{ep.baseUrl.replace(/^https?:\/\//, '')}</span>
                  <span className="endpoint-model">
                    {ep.style} · {ep.model}
                  </span>
                </div>
                {llm?.baseUrl === ep.baseUrl ? (
                  <span className="endpoint-active">● active</span>
                ) : (
                  <button className="btn" onClick={() => void useEndpoint(ep)}>
                    Use
                  </button>
                )}
                <button className="btn" title="Forget" onClick={() => void forgetEndpoint(ep)}>
                  ✕
                </button>
              </div>
            ))}
          </>
        )}
        {llm && (
          <>
            <h3>Model</h3>
            <select value={llm.model} onChange={(e) => void pickModel(e.target.value)}>
              {llm.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <h3>AI search index</h3>
            <p className="hint">
              One-line summaries per file power meaning-based search (Ctrl+K). Cached by content
              hash — rebuilding only summarizes changed files.
            </p>
            <div className="row">
              <button
                className="btn accent"
                disabled={indexBusy}
                onClick={() => void buildIndex()}
              >
                {indexBusy ? `Indexing… ${indexProgress}` : '🧠 Build index'}
              </button>
              {indexBusy && (
                <button className="btn" onClick={() => void window.atlas.cancelSummaries()}>
                  Stop
                </button>
              )}
            </div>
            {indexStatus && <p className="status">{indexStatus}</p>}
          </>
        )}
        <h3>Renderer</h3>
        <p className="hint">
          {glInfo
            ? `Active: ${glInfo.mode} — ${glInfo.renderer.slice(0, 60)}${glInfo.software ? ' (software)' : ''}`
            : 'Detecting…'}{' '}
          If the 3D view looks wrong (common over RDP/VNC), switch to Software. Relaunches the
          app.
        </p>
        <div className="row">
          <button className="btn" onClick={() => void window.atlas.setGlMode('default')}>
            Auto
          </button>
          <button className="btn" onClick={() => void window.atlas.setGlMode('egl')}>
            GPU (EGL)
          </button>
          <button className="btn" onClick={() => void window.atlas.setGlMode('swiftshader')}>
            Software
          </button>
        </div>
        <h3>Live watch</h3>
        <label className="diff-check">
          <input
            type="checkbox"
            checked={watchOn}
            onChange={(e) => {
              setWatchOn(e.target.checked)
              void window.atlas.saveSettings({ watch: e.target.checked })
            }}
          />
          Re-analyze automatically when files change (applies on next open)
        </label>
        <div className="dialog-footer">
          <button className="btn" onClick={() => setSettingsOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
