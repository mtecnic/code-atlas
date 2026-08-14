// The LLM agent loop, decoupled from Electron: output flows through an
// AgentSink, tool execution through an injected executeTool, and the HTTP
// layer through an injectable fetch — so the whole loop is testable against a
// fake OpenAI-compatible server. Hardening: transient retries (only before any
// output has been produced), bounded empty-completion recovery, prompt-token
// tracking with deterministic receipt compaction, and structured tool errors.
import type { LlmChatMessage, LlmEndpoint } from '../../shared/model'

export interface AgentToolCall {
  callId: string
  name: string
  args: Record<string, unknown>
}

export interface AgentSink {
  delta(text: string): void
  toolCall(call: AgentToolCall): void
  toolDone(call: { callId: string; name: string; isError: boolean }): void
  retry(info: { attempt: number; max: number; reason: string }): void
  done(): void
  error(message: string): void
}

export interface ToolExecution {
  content: string
  isError: boolean
}

export interface AgentOptions {
  endpoint: LlmEndpoint
  /** bearer credential for hosted endpoints; omitted for open local servers */
  apiKey?: string
  messages: LlmChatMessage[]
  tools?: Record<string, unknown>[]
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecution>
  signal: AbortSignal
  maxRounds?: number
  /** prompt-token threshold that triggers receipt compaction (0 = off) */
  contextBudget?: number
  /** consecutive tool failures before the loop gives up */
  maxConsecutiveToolFailures?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  rng?: () => number
}

interface WireMessage {
  role: string
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

interface ToolCallAccum {
  id: string
  name: string
  args: string
}

type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_calls'; calls: ToolCallAccum[] }
  | { type: 'usage'; promptTokens: number }

/** endpoints whose server rejects the OpenAI tools param → prompt-based tools */
export const promptToolsEndpoints = new Set<string>()

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
const RETRY_MAX_ATTEMPTS = 3
const BACKOFF_CAP_MS = 2000

export class HttpStatusError extends Error {
  constructor(
    public status: number,
    public retryAfterMs: number | null,
    url: string
  ) {
    super(`HTTP ${status} from ${url}`)
  }
}

/** transient = worth retrying: rate limits, 5xx, and network-layer failures */
export function classifyTransient(e: unknown): { transient: boolean; delayHint: number | null } {
  if (e instanceof HttpStatusError) {
    if (e.status === 429) return { transient: true, delayHint: e.retryAfterMs }
    if ([500, 502, 503, 504].includes(e.status)) return { transient: true, delayHint: null }
    return { transient: false, delayHint: null }
  }
  const code = (e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code
  if (
    typeof code === 'string' &&
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)
  ) {
    return { transient: true, delayHint: null }
  }
  return { transient: false, delayHint: null }
}

/** exponential backoff, capped, equal-jitter; rng injectable for tests */
export function backoffDelayMs(attempt: number, hint: number | null, rng: () => number): number {
  if (hint !== null) return Math.min(hint, BACKOFF_CAP_MS)
  const base = Math.min(BACKOFF_CAP_MS, 250 * 2 ** attempt)
  return base / 2 + rng() * (base / 2)
}

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

/** one streaming attempt; yields typed events, throws on transport failure */
async function* streamOnce(
  opts: AgentOptions,
  history: WireMessage[],
  useNativeTools: boolean,
  isOpenAi: boolean
): AsyncGenerator<StreamEvent> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = isOpenAi
    ? `${opts.endpoint.baseUrl}/v1/chat/completions`
    : `${opts.endpoint.baseUrl}/api/chat`
  const body: Record<string, unknown> = isOpenAi
    ? {
        model: opts.endpoint.model,
        messages: history,
        stream: true,
        stream_options: { include_usage: true },
        chat_template_kwargs: { enable_thinking: false }
      }
    : { model: opts.endpoint.model, messages: history, stream: true, think: false }
  if (useNativeTools) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal
  })
  if (!res.ok || !res.body) {
    const retryAfter = Number(res.headers.get('retry-after'))
    throw new HttpStatusError(res.status, Number.isFinite(retryAfter) ? retryAfter * 1000 : null, url)
  }

  const toolCalls = new Map<number, ToolCallAccum>()
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
      if (isOpenAi) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let json: {
          choices?: {
            delta?: {
              content?: string
              tool_calls?: {
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }[]
            }
          }[]
          usage?: { prompt_tokens?: number }
        }
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        if (json.usage?.prompt_tokens !== undefined) {
          yield { type: 'usage', promptTokens: json.usage.prompt_tokens }
        }
        const d = json.choices?.[0]?.delta
        if (d?.content) yield { type: 'text', delta: d.content }
        if (Array.isArray(d?.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0
            let acc = toolCalls.get(idx)
            if (!acc) toolCalls.set(idx, (acc = { id: '', name: '', args: '' }))
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
          }
        }
      } else {
        try {
          const json = JSON.parse(line) as { message?: { content?: string } }
          if (json.message?.content) yield { type: 'text', delta: json.message.content }
        } catch {
          continue
        }
      }
    }
  }
  if (toolCalls.size > 0) {
    yield {
      type: 'tool_calls',
      calls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
    }
  }
}

/** deterministic compaction: system + first user question + tool receipts */
export function compactHistory(history: WireMessage[], receipts: string[]): WireMessage[] {
  const system = history.find((m) => m.role === 'system')
  const firstUser = history.find((m) => m.role === 'user')
  const compacted: WireMessage[] = []
  if (system) compacted.push(system)
  if (firstUser) compacted.push(firstUser)
  compacted.push({
    role: 'user',
    content:
      'Progress so far — these tool calls are ALREADY COMPLETED, do NOT repeat them:\n' +
      receipts.map((r) => `- ${r}`).join('\n') +
      '\nContinue from here and answer the user.'
  })
  return compacted
}

export async function runAgentLoop(opts: AgentOptions, sink: AgentSink): Promise<void> {
  const isOpenAi = opts.endpoint.style === 'openai'
  const useTools = isOpenAi && !!opts.tools && opts.tools.length > 0
  const maxRounds = opts.maxRounds ?? 6
  const contextBudget = opts.contextBudget ?? 24000
  const maxToolFailures = opts.maxConsecutiveToolFailures ?? 3
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const rng = opts.rng ?? Math.random
  const history: WireMessage[] = opts.messages.map((m) => ({ role: m.role, content: m.content }))
  const receipts: string[] = []
  let lastPromptTokens = 0
  let consecutiveToolFailures = 0
  let emptyRetries = 0

  try {
    for (let round = 0; round < maxRounds; round++) {
      const promptTools = useTools && promptToolsEndpoints.has(opts.endpoint.baseUrl)
      if (promptTools && !history.some((m) => m.role === 'system' && m.content?.includes('# Tools'))) {
        const sys = history.findIndex((m) => m.role === 'system')
        if (sys >= 0) {
          history[sys] = {
            ...history[sys],
            content: (history[sys].content ?? '') + promptToolsSystemSuffix(opts.tools!)
          }
        }
      }
      // receipt compaction at round boundaries only — no in-flight tool ids
      if (contextBudget > 0 && lastPromptTokens > contextBudget && receipts.length > 0) {
        const compacted = compactHistory(history, receipts)
        history.length = 0
        history.push(...compacted)
        if (promptTools) {
          const sys = history.findIndex((m) => m.role === 'system')
          if (sys >= 0 && !history[sys].content?.includes('# Tools')) {
            history[sys] = {
              ...history[sys],
              content: (history[sys].content ?? '') + promptToolsSystemSuffix(opts.tools!)
            }
          }
        }
      }

      // ---- one round, with transient retry (only before any output) ----
      let content = ''
      let sentUpTo = 0
      let calls: ToolCallAccum[] = []
      let producedOutput = false
      const flushSafe = (final: boolean): void => {
        let safe: number
        if (!promptTools) safe = content.length
        else {
          const tagAt = content.indexOf('<tool_call>')
          safe = tagAt >= 0 ? tagAt : final ? content.length : Math.max(0, content.length - 14)
        }
        if (safe > sentUpTo) {
          sink.delta(content.slice(sentUpTo, safe))
          sentUpTo = safe
        }
      }

      let attempt = 0
      for (;;) {
        try {
          for await (const ev of streamOnce(opts, history, useTools && !promptTools, isOpenAi)) {
            if (ev.type === 'text') {
              content += ev.delta
              producedOutput = true
              flushSafe(false)
            } else if (ev.type === 'tool_calls') {
              calls = ev.calls
              producedOutput = true
            } else {
              lastPromptTokens = ev.promptTokens
            }
          }
          break
        } catch (e) {
          if (opts.signal.aborted) {
            sink.done()
            return
          }
          // native-tools rejection → flip this endpoint to prompt-based tools
          if (
            useTools &&
            !promptTools &&
            e instanceof HttpStatusError &&
            e.status === 400 &&
            !producedOutput
          ) {
            promptToolsEndpoints.add(opts.endpoint.baseUrl)
            round--
            calls = []
            content = ''
            break
          }
          const { transient, delayHint } = classifyTransient(e)
          if (!transient || producedOutput || attempt >= RETRY_MAX_ATTEMPTS - 1) {
            sink.error(String(e instanceof Error ? e.message : e))
            return
          }
          attempt++
          sink.retry({ attempt, max: RETRY_MAX_ATTEMPTS, reason: String((e as Error).message ?? e) })
          await sleep(backoffDelayMs(attempt, delayHint, rng))
        }
      }
      if (useTools && !promptTools && promptToolsEndpoints.has(opts.endpoint.baseUrl) && content === '') {
        continue // fallback flip — redo the round in prompt-tools mode
      }

      // prompt-tools mode: extract <tool_call> blocks from content
      if (promptTools && calls.length === 0) {
        let m: RegExpExecArray | null
        let idx = 0
        TOOL_CALL_RE.lastIndex = 0
        while ((m = TOOL_CALL_RE.exec(content))) {
          try {
            const parsed = JSON.parse(m[1]) as { name?: string; arguments?: unknown }
            if (parsed && typeof parsed.name === 'string') {
              calls.push({
                id: `pcall_${round}_${idx++}`,
                name: parsed.name,
                args: JSON.stringify(parsed.arguments ?? {})
              })
            }
          } catch {
            /* malformed call — ignore */
          }
        }
      }

      if (calls.length === 0) {
        // empty completion (no text, no calls) is an anomaly, not an answer
        if (content.trim() === '' && emptyRetries < RETRY_MAX_ATTEMPTS) {
          emptyRetries++
          sink.retry({ attempt: emptyRetries, max: RETRY_MAX_ATTEMPTS, reason: 'empty completion' })
          await sleep(backoffDelayMs(emptyRetries, null, rng))
          round--
          continue
        }
        flushSafe(true)
        sink.done()
        return
      }

      // ---- execute the round's tool calls ----
      const finalized = calls.map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }))
      if (promptTools) {
        history.push({ role: 'assistant', content })
      } else {
        history.push({
          role: 'assistant',
          content: content || null,
          tool_calls: finalized.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.args || '{}' }
          }))
        })
      }
      const promptResults: string[] = []
      for (const call of finalized) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(call.args || '{}') as Record<string, unknown>
        } catch {
          /* leave empty */
        }
        sink.toolCall({ callId: call.id, name: call.name, args: parsedArgs })
        const result = await opts.executeTool(call.name, parsedArgs)
        if (opts.signal.aborted) {
          sink.done()
          return
        }
        sink.toolDone({ callId: call.id, name: call.name, isError: result.isError })
        consecutiveToolFailures = result.isError ? consecutiveToolFailures + 1 : 0
        const argsShort = JSON.stringify(parsedArgs)
        receipts.push(
          `${call.name}(${argsShort.length > 80 ? argsShort.slice(0, 77) + '…' : argsShort}) → ${result.isError ? 'ERROR' : 'ok'}`
        )
        if (promptTools) {
          promptResults.push(
            `<tool_response name="${call.name}">\n${result.content}\n</tool_response>`
          )
        } else {
          history.push({ role: 'tool', content: result.content, tool_call_id: call.id })
        }
      }
      if (promptTools && promptResults.length) {
        history.push({ role: 'user', content: promptResults.join('\n') })
      }
      if (consecutiveToolFailures >= maxToolFailures) {
        sink.error(`Stopping: ${consecutiveToolFailures} consecutive tool failures`)
        return
      }
    }
    sink.error('Agent exceeded maximum tool rounds')
  } catch (e) {
    if (opts.signal.aborted) sink.done()
    else sink.error(String(e instanceof Error ? e.message : e))
  }
}
