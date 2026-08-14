// Renderer-side helper multiplexing streamed LLM responses by requestId, and
// dispatching the agent's scene-tool calls back through the registry.
import type { LlmChatMessage } from '../../shared/model'
import { dispatchTool, toolSchemas } from './ai-tools'

interface Stream {
  onDelta: (delta: string) => void
  onDone: () => void
  onError: (err: string) => void
  onTool?: (name: string, args: Record<string, unknown>) => void
  onToolDone?: (name: string, isError: boolean) => void
  onRetry?: (attempt: number, max: number) => void
}

const streams = new Map<string, Stream>()
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  window.atlas.onLlmChunk(({ requestId, delta }) => streams.get(requestId)?.onDelta(delta))
  window.atlas.onLlmDone((requestId) => {
    streams.get(requestId)?.onDone()
    streams.delete(requestId)
  })
  window.atlas.onLlmError((requestId, error) => {
    streams.get(requestId)?.onError(error)
    streams.delete(requestId)
  })
  window.atlas.onLlmToolCall(({ requestId, callId, name, args }) => {
    streams.get(requestId)?.onTool?.(name, args)
    void dispatchTool(name, args).then((result) =>
      window.atlas.llmToolResult(requestId, callId, result.content, result.isError)
    )
  })
  window.atlas.onLlmToolDone(({ requestId, name, isError }) => {
    streams.get(requestId)?.onToolDone?.(name, isError)
  })
  window.atlas.onLlmRetry(({ requestId, attempt, max }) => {
    streams.get(requestId)?.onRetry?.(attempt, max)
  })
}

export interface ChatHandle {
  requestId: string
  abort: () => void
}

export async function streamChat(
  messages: LlmChatMessage[],
  handlers: Stream,
  opts?: { agent?: boolean }
): Promise<ChatHandle> {
  wire()
  const requestId = await window.atlas.llmChat(messages, opts?.agent ? toolSchemas() : undefined)
  streams.set(requestId, handlers)
  return { requestId, abort: () => void window.atlas.llmAbort(requestId) }
}
