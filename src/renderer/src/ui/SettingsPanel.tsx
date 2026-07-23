import { useEffect, useState } from 'react'
import { useAtlas } from '../store'

export function SettingsPanel(): React.JSX.Element | null {
  const open = useAtlas((s) => s.settingsOpen)
  const llm = useAtlas((s) => s.llm)
  const { setSettingsOpen, setLlm } = useAtlas()
  const [host, setHost] = useState('')
  const [status, setStatus] = useState<string>('')
  const [probing, setProbing] = useState(false)

  useEffect(() => {
    if (open && llm) setHost(llm.baseUrl.replace(/^https?:\/\//, ''))
  }, [open, llm])

  if (!open) return null

  const probe = async (): Promise<void> => {
    if (!host.trim()) return
    setProbing(true)
    setStatus('Probing…')
    const result = await window.atlas.llmProbe(host.trim())
    setProbing(false)
    if (result.ok && result.endpoint) {
      setLlm(result.endpoint)
      setStatus(
        `✓ Found ${result.endpoint.style === 'openai' ? 'OpenAI-compatible' : 'Ollama'} server at ${result.endpoint.baseUrl} — ${result.endpoint.models.length} model(s)`
      )
    } else {
      setStatus(`✗ ${result.error ?? 'Nothing found'}`)
    }
  }

  const pickModel = async (model: string): Promise<void> => {
    if (!llm) return
    const next = { ...llm, model }
    setLlm(next)
    await window.atlas.saveSettings({ llm: next })
  }

  return (
    <div className="overlay" onClick={() => setSettingsOpen(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <h3>LLM endpoint</h3>
        <p className="hint">
          Enter an IP or host (port optional). Auto-detects vLLM, llama.cpp, LM Studio
          (OpenAI-compatible) and Ollama.
        </p>
        <div className="row">
          <input
            value={host}
            placeholder="192.168.86.23  or  localhost:8000"
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void probe()}
          />
          <button className="btn accent" disabled={probing} onClick={() => void probe()}>
            {probing ? '…' : 'Detect'}
          </button>
        </div>
        {status && <p className="status">{status}</p>}
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
          </>
        )}
        <div className="dialog-footer">
          <button className="btn" onClick={() => setSettingsOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
