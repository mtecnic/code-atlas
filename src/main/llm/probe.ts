// Auto-detects a local LLM serving stack from a bare IP/host: tries Ollama's
// native API and OpenAI-compatible /v1/models across common ports.
import type { LlmEndpoint, LlmProbeResult, PreflightResult } from '../../shared/model'

const OPENAI_PORTS = [8000, 8080, 1234, 5000, 80]
const OLLAMA_PORT = 11434
const TIMEOUT_MS = 1500

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

async function fetchJson(url: string, apiKey?: string, timeoutMs = TIMEOUT_MS): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: authHeaders(apiKey)
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function probeOpenAi(base: string, apiKey?: string, timeoutMs?: number): Promise<LlmEndpoint | null> {
  const data = (await fetchJson(`${base}/v1/models`, apiKey, timeoutMs)) as { data?: { id: string }[] } | null
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

export async function probeEndpoint(
  host: string,
  port?: number,
  apiKey?: string
): Promise<LlmProbeResult> {
  // full URL → talk to it directly (hosted endpoints: OpenAI, OpenRouter,
  // Groq, a remote vLLM behind TLS, …); no port scanning, keep the scheme
  if (/^https?:\/\//i.test(host.trim())) {
    const base = host.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
    const tried = [base]
    const hit = await probeOpenAi(base, apiKey, 8000)
    if (hit) {
      const preflight = await preflightEndpoint(hit, apiKey)
      return { ok: true, endpoint: hit, tried, preflight }
    }
    // distinguish auth failures from dead endpoints for a useful message
    try {
      const res = await fetch(`${base}/v1/models`, {
        signal: AbortSignal.timeout(8000),
        headers: authHeaders(apiKey)
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, tried, error: 'Endpoint reachable but credentials rejected — check the API key' }
      }
      return { ok: false, tried, error: `No model list at ${base}/v1/models (HTTP ${res.status})` }
    } catch (e) {
      return { ok: false, tried, error: `Could not reach ${base}: ${String(e instanceof Error ? e.message : e).slice(0, 100)}` }
    }
  }

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
  if (hit) {
    const preflight = await preflightEndpoint(hit, apiKey)
    return { ok: true, endpoint: hit, tried, preflight }
  }
  return { ok: false, tried, error: `No LLM endpoint found at ${hostOnly} (tried ${tried.length} URLs)` }
}

/**
 * A model listing proves the server is up — not that chat works. Send a real
 * 1-token completion and classify failures into actionable categories.
 */
export async function preflightEndpoint(
  endpoint: LlmEndpoint,
  apiKey?: string
): Promise<PreflightResult> {
  const isOpenAi = endpoint.style === 'openai'
  const url = isOpenAi
    ? `${endpoint.baseUrl}/v1/chat/completions`
    : `${endpoint.baseUrl}/api/chat`
  const body = isOpenAi
    ? { model: endpoint.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }
    : { model: endpoint.model, messages: [{ role: 'user', content: 'ping' }], stream: false, options: { num_predict: 1 } }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    })
    if (res.ok) return { ok: true, category: 'ok', message: 'Chat completion verified' }
    const text = (await res.text().catch(() => '')).slice(0, 300)
    if (res.status === 401 || res.status === 403) {
      return { ok: false, category: 'auth_rejected', message: 'Credentials rejected — check API key' }
    }
    if (res.status === 404 || /model.*(not|no).*(found|exist|loaded)|does not exist/i.test(text)) {
      return {
        ok: false,
        category: 'unsupported_model',
        message: `Model "${endpoint.model}" not available at this endpoint`
      }
    }
    if (res.status === 429 && /quota|billing|exceeded your/i.test(text)) {
      return { ok: false, category: 'quota_exhausted', message: 'Provider quota exhausted' }
    }
    return {
      ok: false,
      category: 'unknown_error',
      message: `Chat ping failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 120)}` : ''}`
    }
  } catch (e) {
    return {
      ok: false,
      category: 'network_failure',
      message: `Could not reach chat endpoint: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`
    }
  }
}
