// Auto-detects a local LLM serving stack from a bare IP/host: tries Ollama's
// native API and OpenAI-compatible /v1/models across common ports.
import type { LlmEndpoint, LlmProbeResult } from '../../shared/model'

const OPENAI_PORTS = [8000, 8080, 1234, 5000, 80]
const OLLAMA_PORT = 11434
const TIMEOUT_MS = 1500

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function probeOpenAi(base: string): Promise<LlmEndpoint | null> {
  const data = (await fetchJson(`${base}/v1/models`)) as { data?: { id: string }[] } | null
  if (!data?.data || !Array.isArray(data.data)) return null
  const models = data.data.map((m) => m.id).filter(Boolean)
  if (!models.length) return null
  return { style: 'openai', baseUrl: base, models, model: models[0] }
}

async function probeOllama(base: string): Promise<LlmEndpoint | null> {
  const data = (await fetchJson(`${base}/api/tags`)) as { models?: { name: string }[] } | null
  if (!data?.models || !Array.isArray(data.models)) return null
  const models = data.models.map((m) => m.name).filter(Boolean)
  if (!models.length) return null
  // modern Ollama also speaks /v1 — prefer the OpenAI dialect when present
  const openai = await probeOpenAi(base)
  return openai ?? { style: 'ollama', baseUrl: base, models, model: models[0] }
}

export async function probeEndpoint(host: string, port?: number): Promise<LlmProbeResult> {
  const clean = host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const hostOnly = clean.includes(':') ? clean.split(':')[0] : clean
  const portFromHost = clean.includes(':') ? Number(clean.split(':')[1]) : undefined
  const targetPort = port ?? portFromHost

  const tried: string[] = []
  const attempts: Promise<LlmEndpoint | null>[] = []
  if (targetPort) {
    const base = `http://${hostOnly}:${targetPort}`
    tried.push(base)
    attempts.push(
      targetPort === OLLAMA_PORT ? probeOllama(base) : probeOpenAi(base).then(async (r) => r ?? probeOllama(base))
    )
  } else {
    for (const p of OPENAI_PORTS) {
      const base = `http://${hostOnly}:${p}`
      tried.push(base)
      attempts.push(probeOpenAi(base))
    }
    const ollamaBase = `http://${hostOnly}:${OLLAMA_PORT}`
    tried.push(ollamaBase)
    attempts.push(probeOllama(ollamaBase))
  }

  const results = await Promise.all(attempts)
  const openaiHit = results.find((r) => r?.style === 'openai')
  const hit = openaiHit ?? results.find((r) => r !== null)
  if (hit) return { ok: true, endpoint: hit, tried }
  return { ok: false, tried, error: `No LLM endpoint found at ${hostOnly} (tried ${tried.length} URLs)` }
}
