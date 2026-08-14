import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeProvider } from './fake-provider'
import {
  runAgentLoop,
  promptToolsEndpoints,
  type AgentSink,
  type AgentOptions,
  type ToolExecution
} from '../src/main/llm/agent-loop'
import type { LlmEndpoint } from '../src/shared/model'

class RecordingSink implements AgentSink {
  text = ''
  toolCalls: { name: string; args: Record<string, unknown> }[] = []
  toolDones: { name: string; isError: boolean }[] = []
  retries: { attempt: number; reason: string }[] = []
  doneCount = 0
  errors: string[] = []
  delta(t: string): void {
    this.text += t
  }
  toolCall(c: { callId: string; name: string; args: Record<string, unknown> }): void {
    this.toolCalls.push({ name: c.name, args: c.args })
  }
  toolDone(c: { callId: string; name: string; isError: boolean }): void {
    this.toolDones.push({ name: c.name, isError: c.isError })
  }
  retry(i: { attempt: number; max: number; reason: string }): void {
    this.retries.push({ attempt: i.attempt, reason: i.reason })
  }
  done(): void {
    this.doneCount++
  }
  error(m: string): void {
    this.errors.push(m)
  }
}

const TOOLS = [
  {
    type: 'function',
    function: { name: 'fly_to', description: 'fly', parameters: { type: 'object', properties: {} } }
  }
]

describe('runAgentLoop', () => {
  let provider: FakeProvider
  let sink: RecordingSink
  let endpoint: LlmEndpoint

  const opts = (over: Partial<AgentOptions> = {}): AgentOptions => ({
    endpoint,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question' }
    ],
    tools: TOOLS,
    executeTool: async () => ({ content: '{"ok":true}', isError: false }),
    signal: new AbortController().signal,
    sleep: async () => {},
    rng: () => 0.5,
    ...over
  })

  beforeEach(async () => {
    provider = new FakeProvider()
    await provider.start()
    endpoint = { style: 'openai', baseUrl: provider.baseUrl, models: ['m'], model: 'm' }
    sink = new RecordingSink()
    promptToolsEndpoints.clear()
  })

  afterEach(async () => {
    await provider.stop()
  })

  it('streams a plain text answer', async () => {
    provider.setResponses([{ type: 'text', text: 'hello world, this is the answer' }])
    await runAgentLoop(opts(), sink)
    expect(sink.text).toBe('hello world, this is the answer')
    expect(sink.doneCount).toBe(1)
    expect(sink.errors).toEqual([])
  })

  it('executes a tool round-trip with chunked argument deltas', async () => {
    const executed: Record<string, unknown>[] = []
    provider.setResponses([
      {
        type: 'tool_calls',
        calls: [{ name: 'fly_to', args: { path: 'src/very/long/path/to/exercise/chunking.ts' } }]
      },
      { type: 'text', text: 'flew there' }
    ])
    await runAgentLoop(
      opts({
        executeTool: async (_name, args): Promise<ToolExecution> => {
          executed.push(args)
          return { content: '{"flewTo":"ok"}', isError: false }
        }
      }),
      sink
    )
    expect(executed).toEqual([{ path: 'src/very/long/path/to/exercise/chunking.ts' }])
    expect(sink.toolCalls[0].name).toBe('fly_to')
    expect(sink.text).toBe('flew there')
    expect(sink.doneCount).toBe(1)
    // tool result flowed back into the next request
    const second = provider.requests[1].body as { messages: { role: string }[] }
    expect(second.messages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('falls back to prompt-based tools on HTTP 400 and parses <tool_call>', async () => {
    provider.setResponses([
      { type: 'fail', status: 400 },
      {
        type: 'text',
        text: 'Let me look.\n<tool_call>{"name": "fly_to", "arguments": {"path": "a.ts"}}</tool_call>'
      },
      { type: 'text', text: 'done looking' }
    ])
    const executed: string[] = []
    await runAgentLoop(
      opts({
        executeTool: async (name): Promise<ToolExecution> => {
          executed.push(name)
          return { content: '{}', isError: false }
        }
      }),
      sink
    )
    expect(promptToolsEndpoints.has(endpoint.baseUrl)).toBe(true)
    expect(executed).toEqual(['fly_to'])
    // tool_call markup never reached the visible stream
    expect(sink.text).not.toContain('<tool_call>')
    expect(sink.text).toContain('done looking')
    // results were delivered as a user-role tool_response message
    const third = provider.requests[2].body as { messages: { role: string; content: string }[] }
    expect(third.messages.at(-1)?.content).toContain('<tool_response')
  })

  it('retries transient failures before output, then succeeds', async () => {
    provider.setResponses([
      { type: 'fail', status: 503 },
      { type: 'fail', status: 429, retryAfter: 1 },
      { type: 'text', text: 'recovered' }
    ])
    await runAgentLoop(opts(), sink)
    expect(sink.retries.length).toBe(2)
    expect(sink.text).toBe('recovered')
    expect(sink.errors).toEqual([])
  })

  it('does NOT retry after output has been produced (mid-stream break)', async () => {
    provider.setResponses([
      { type: 'break_mid_text', text: 'partial answ' },
      { type: 'text', text: 'should never be requested' }
    ])
    await runAgentLoop(opts(), sink)
    expect(sink.text).toBe('partial answ')
    expect(sink.retries.length).toBe(0)
    expect(sink.errors.length).toBe(1)
    expect(provider.requests.length).toBe(1)
  })

  it('recovers from empty completions', async () => {
    provider.setResponses([{ type: 'empty' }, { type: 'text', text: 'second try worked' }])
    await runAgentLoop(opts(), sink)
    expect(sink.retries.length).toBe(1)
    expect(sink.retries[0].reason).toContain('empty')
    expect(sink.text).toBe('second try worked')
    expect(sink.doneCount).toBe(1)
  })

  it('stops after consecutive tool failures', async () => {
    provider.setResponses([
      { type: 'tool_calls', calls: [{ name: 'fly_to', args: { path: 'x' } }] },
      { type: 'tool_calls', calls: [{ name: 'fly_to', args: { path: 'y' } }] },
      { type: 'tool_calls', calls: [{ name: 'fly_to', args: { path: 'z' } }] },
      { type: 'text', text: 'unreachable' }
    ])
    await runAgentLoop(
      opts({
        executeTool: async (): Promise<ToolExecution> => ({
          content: '{"error":"nope"}',
          isError: true
        })
      }),
      sink
    )
    expect(sink.toolDones.filter((t) => t.isError).length).toBe(3)
    expect(sink.errors[0]).toContain('consecutive tool failures')
  })

  it('compacts history into receipts when past the context budget', async () => {
    provider.setResponses([
      {
        type: 'tool_calls',
        calls: [{ name: 'get_health_report', args: {} }],
        promptTokens: 50_000 // over budget → compaction before next round
      },
      { type: 'text', text: 'summary answer' }
    ])
    await runAgentLoop(
      opts({
        contextBudget: 10_000,
        executeTool: async (): Promise<ToolExecution> => ({
          content: JSON.stringify({ huge: 'x'.repeat(5000) }),
          isError: false
        })
      }),
      sink
    )
    expect(sink.text).toBe('summary answer')
    const second = provider.requests[1].body as {
      messages: { role: string; content: string | null }[]
    }
    const joined = JSON.stringify(second.messages)
    expect(joined).toContain('ALREADY COMPLETED')
    expect(joined).toContain('get_health_report')
    // the huge tool payload was compacted away
    expect(joined).not.toContain('x'.repeat(5000))
    // no orphan tool messages survive compaction
    expect(second.messages.every((m) => m.role !== 'tool')).toBe(true)
  })
})
