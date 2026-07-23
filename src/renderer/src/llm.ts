// Renderer-side helper multiplexing streamed LLM responses by requestId.
import type { LlmChatMessage } from '../../shared/model'

interface Stream {
  onDelta: (delta: string) => void
  onDone: () => void
  onError: (err: string) => void
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
}

export interface ChatHandle {
  requestId: string
  abort: () => void
}

export async function streamChat(
  messages: LlmChatMessage[],
  handlers: Stream
): Promise<ChatHandle> {
  wire()
  const requestId = await window.atlas.llmChat(messages)
  streams.set(requestId, handlers)
  return { requestId, abort: () => void window.atlas.llmAbort(requestId) }
}
