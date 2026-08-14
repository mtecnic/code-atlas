// Electron adapter around the pure agent loop: wires an AgentSink to
// WebContents channels and tool execution to the renderer IPC round-trip.
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { LlmChatMessage, LlmEndpoint } from '../../shared/model'
import { CHANNELS } from '../../shared/ipc-contract'
import { runAgentLoop, type AgentSink, type ToolExecution } from './agent-loop'

const active = new Map<string, AbortController>()
const pendingToolResults = new Map<string, (result: ToolExecution) => void>()

export function abortChat(requestId: string): void {
  active.get(requestId)?.abort()
  active.delete(requestId)
}

export function resolveToolResult(
  requestId: string,
  callId: string,
  result: string,
  isError = false
): void {
  const key = `${requestId}:${callId}`
  pendingToolResults.get(key)?.({ content: result, isError })
  pendingToolResults.delete(key)
}

export function startChat(
  wc: WebContents,
  endpoint: LlmEndpoint,
  messages: LlmChatMessage[],
  tools?: Record<string, unknown>[],
  contextBudget?: number
): string {
  const requestId = randomUUID()
  const ac = new AbortController()
  active.set(requestId, ac)

  const send = (channel: string, ...args: unknown[]): void => {
    if (!wc.isDestroyed()) wc.send(channel, ...args)
  }
  // the loop emits sink.toolCall synchronously before invoking executeTool,
  // so capturing the callId here correlates the IPC round-trip
  let currentCallId = ''
  const sink: AgentSink = {
    delta: (text) => send(CHANNELS.llmChunk, { requestId, delta: text }),
    toolCall: (call) => {
      currentCallId = call.callId
      send(CHANNELS.llmToolCall, {
        requestId,
        callId: call.callId,
        name: call.name,
        args: call.args
      })
    },
    toolDone: (call) =>
      send(CHANNELS.llmToolDone, {
        requestId,
        callId: call.callId,
        name: call.name,
        isError: call.isError
      }),
    retry: (info) => send(CHANNELS.llmRetry, { requestId, ...info }),
    done: () => send(CHANNELS.llmDone, requestId),
    error: (message) => send(CHANNELS.llmError, requestId, message)
  }
  const executeTool = (): Promise<ToolExecution> => {
    const key = `${requestId}:${currentCallId}`
    return new Promise<ToolExecution>((resolve) => {
      pendingToolResults.set(key, resolve)
      setTimeout(() => {
        if (pendingToolResults.has(key)) {
          pendingToolResults.delete(key)
          resolve({ content: JSON.stringify({ error: 'tool timed out' }), isError: true })
        }
      }, 30_000)
    })
  }

  void runAgentLoop(
    { endpoint, messages, tools, executeTool, signal: ac.signal, contextBudget },
    sink
  ).finally(() => active.delete(requestId))
  return requestId
}
