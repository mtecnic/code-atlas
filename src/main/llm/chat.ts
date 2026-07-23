// Streams chat completions from the configured endpoint and forwards deltas
// to the renderer over IPC, multiplexed by requestId.
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { LlmChatMessage, LlmEndpoint } from '../../shared/model'
import { CHANNELS } from '../../shared/ipc-contract'

const active = new Map<string, AbortController>()

export function abortChat(requestId: string): void {
  active.get(requestId)?.abort()
  active.delete(requestId)
}

export function startChat(
  wc: WebContents,
  endpoint: LlmEndpoint,
  messages: LlmChatMessage[]
): string {
  const requestId = randomUUID()
  const ac = new AbortController()
  active.set(requestId, ac)
  void run(wc, endpoint, messages, requestId, ac).finally(() => active.delete(requestId))
  return requestId
}

async function run(
  wc: WebContents,
  endpoint: LlmEndpoint,
  messages: LlmChatMessage[],
  requestId: string,
  ac: AbortController
): Promise<void> {
  const send = (channel: string, ...args: unknown[]): void => {
    if (!wc.isDestroyed()) wc.send(channel, ...args)
  }
  try {
    const isOpenAi = endpoint.style === 'openai'
    const url = isOpenAi
      ? `${endpoint.baseUrl}/v1/chat/completions`
      : `${endpoint.baseUrl}/api/chat`
    // disable reasoning/thinking where the stack supports it: vLLM forwards
    // chat_template_kwargs to the model's template (Qwen etc.); Ollama uses
    // `think`. Servers that don't know these fields ignore them.
    const body = isOpenAi
      ? {
          model: endpoint.model,
          messages,
          stream: true,
          chat_template_kwargs: { enable_thinking: false }
        }
      : { model: endpoint.model, messages, stream: true, think: false }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    })
    if (!res.ok || !res.body) {
      send(CHANNELS.llmError, requestId, `HTTP ${res.status} from ${url}`)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        let delta = ''
        if (isOpenAi) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload)
            delta = json.choices?.[0]?.delta?.content ?? ''
          } catch {
            continue
          }
        } else {
          try {
            const json = JSON.parse(line)
            delta = json.message?.content ?? ''
          } catch {
            continue
          }
        }
        if (delta) send(CHANNELS.llmChunk, { requestId, delta })
      }
    }
    send(CHANNELS.llmDone, requestId)
  } catch (e) {
    if (ac.signal.aborted) send(CHANNELS.llmDone, requestId)
    else send(CHANNELS.llmError, requestId, String(e))
  }
}
