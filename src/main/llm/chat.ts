// Streams chat completions and runs the tool-calling agent loop. Tool calls
// stream in as deltas, get dispatched to the renderer's scene-tool registry
// over IPC, and their results feed the next model turn. Multiplexed by
// requestId.
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { LlmChatMessage, LlmEndpoint } from '../../shared/model'
import { CHANNELS } from '../../shared/ipc-contract'

interface ToolCallAccum {
  id: string
  name: string
  args: string
}

interface WireMessage {
  role: string
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

const active = new Map<string, AbortController>()
const pendingToolResults = new Map<string, (result: string) => void>()
/** endpoints whose server rejects the OpenAI tools param → prompt-based tools */
const promptToolsEndpoints = new Set<string>()

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g

function promptToolsSystemSuffix(tools: Record<string, unknown>[]): string {
  return (
    '\n\n# Tools\nYou may call these tools. To call one, emit EXACTLY this on its own line ' +
    '(one per call, at the END of your reply):\n' +
    '<tool_call>{"name": "<tool-name>", "arguments": {…}}</tool_call>\n' +
    'Tool results arrive in the next message inside <tool_response> tags. ' +
    'After using tools, answer the user in plain prose without further tool calls when done.\n' +
    'Available tools (JSON schemas):\n' +
    JSON.stringify(
      tools.map((t) => (t as { function: unknown }).function),
      null,
      1
    )
  )
}

export function abortChat(requestId: string): void {
  active.get(requestId)?.abort()
  active.delete(requestId)
}

export function resolveToolResult(requestId: string, callId: string, result: string): void {
  const key = `${requestId}:${callId}`
  pendingToolResults.get(key)?.(result)
  pendingToolResults.delete(key)
}

export function startChat(
  wc: WebContents,
  endpoint: LlmEndpoint,
  messages: LlmChatMessage[],
  tools?: Record<string, unknown>[]
): string {
  const requestId = randomUUID()
  const ac = new AbortController()
  active.set(requestId, ac)
  void run(wc, endpoint, messages, tools, requestId, ac).finally(() => active.delete(requestId))
  return requestId
}

async function run(
  wc: WebContents,
  endpoint: LlmEndpoint,
  messages: LlmChatMessage[],
  tools: Record<string, unknown>[] | undefined,
  requestId: string,
  ac: AbortController
): Promise<void> {
  const send = (channel: string, ...args: unknown[]): void => {
    if (!wc.isDestroyed()) wc.send(channel, ...args)
  }
  const isOpenAi = endpoint.style === 'openai'
  const useTools = isOpenAi && tools && tools.length > 0
  const history: WireMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))

  try {
    for (let round = 0; round < 6; round++) {
      const promptTools = useTools && promptToolsEndpoints.has(endpoint.baseUrl)
      if (promptTools && round === 0 && history[0]?.role === 'system') {
        history[0] = {
          ...history[0],
          content: (history[0].content ?? '') + promptToolsSystemSuffix(tools!)
        }
      }
      const url = isOpenAi
        ? `${endpoint.baseUrl}/v1/chat/completions`
        : `${endpoint.baseUrl}/api/chat`
      const body: Record<string, unknown> = isOpenAi
        ? {
            model: endpoint.model,
            messages: history,
            stream: true,
            chat_template_kwargs: { enable_thinking: false }
          }
        : { model: endpoint.model, messages: history, stream: true, think: false }
      if (useTools && !promptTools) {
        body.tools = tools
        body.tool_choice = 'auto'
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      if (!res.ok || !res.body) {
        // server without native tool support (e.g. vLLM missing
        // --enable-auto-tool-choice): fall back to prompt-based tools
        if (useTools && !promptTools && res.status === 400) {
          promptToolsEndpoints.add(endpoint.baseUrl)
          round--
          continue
        }
        send(CHANNELS.llmError, requestId, `HTTP ${res.status} from ${url}`)
        return
      }

      let content = ''
      let sentUpTo = 0
      const toolCalls = new Map<number, ToolCallAccum>()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const flushSafe = (final: boolean): void => {
        // prompt-tools mode: never stream tool_call markup to the UI, and hold
        // back a short tail in case a tag is split across chunks
        let safe: number
        if (!promptTools) safe = content.length
        else {
          const tagAt = content.indexOf('<tool_call>')
          safe = tagAt >= 0 ? tagAt : final ? content.length : Math.max(0, content.length - 14)
        }
        if (safe > sentUpTo) {
          send(CHANNELS.llmChunk, { requestId, delta: content.slice(sentUpTo, safe) })
          sentUpTo = safe
        }
      }
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
              const d = json.choices?.[0]?.delta
              delta = d?.content ?? ''
              const tcs = d?.tool_calls
              if (Array.isArray(tcs)) {
                for (const tc of tcs) {
                  const idx = tc.index ?? 0
                  let acc = toolCalls.get(idx)
                  if (!acc) toolCalls.set(idx, (acc = { id: '', name: '', args: '' }))
                  if (tc.id) acc.id = tc.id
                  if (tc.function?.name) acc.name += tc.function.name
                  if (tc.function?.arguments) acc.args += tc.function.arguments
                }
              }
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
          if (delta) {
            content += delta
            flushSafe(false)
          }
        }
      }

      // prompt-tools mode: extract <tool_call> blocks from the content
      if (promptTools) {
        let m: RegExpExecArray | null
        let idx = 0
        TOOL_CALL_RE.lastIndex = 0
        while ((m = TOOL_CALL_RE.exec(content))) {
          try {
            const parsed = JSON.parse(m[1])
            if (parsed && typeof parsed.name === 'string') {
              toolCalls.set(idx++, {
                id: `pcall_${round}_${idx}`,
                name: parsed.name,
                args: JSON.stringify(parsed.arguments ?? {})
              })
            }
          } catch {
            /* malformed call — ignore */
          }
        }
      }

      if (toolCalls.size === 0) {
        flushSafe(true)
        send(CHANNELS.llmDone, requestId)
        return
      }

      // agent round: record the assistant turn, execute tools in the renderer
      const calls = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c], i) => ({ ...c, id: c.id || `call_${round}_${i}` }))
      if (promptTools) {
        history.push({ role: 'assistant', content })
      } else {
        history.push({
          role: 'assistant',
          content: content || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.args || '{}' }
          }))
        })
      }
      const promptResults: string[] = []
      for (const call of calls) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(call.args || '{}')
        } catch {
          /* leave empty */
        }
        send(CHANNELS.llmToolCall, {
          requestId,
          callId: call.id,
          name: call.name,
          args: parsedArgs
        })
        const result = await new Promise<string>((resolve) => {
          const key = `${requestId}:${call.id}`
          pendingToolResults.set(key, resolve)
          setTimeout(() => {
            if (pendingToolResults.has(key)) {
              pendingToolResults.delete(key)
              resolve(JSON.stringify({ error: 'tool timed out' }))
            }
          }, 30_000)
        })
        if (ac.signal.aborted) return
        if (promptTools) {
          promptResults.push(`<tool_response name="${call.name}">\n${result}\n</tool_response>`)
        } else {
          history.push({ role: 'tool', content: result, tool_call_id: call.id })
        }
      }
      if (promptTools && promptResults.length) {
        history.push({ role: 'user', content: promptResults.join('\n') })
      }
    }
    send(CHANNELS.llmError, requestId, 'Agent exceeded maximum tool rounds')
  } catch (e) {
    if (ac.signal.aborted) send(CHANNELS.llmDone, requestId)
    else send(CHANNELS.llmError, requestId, String(e))
  }
}
