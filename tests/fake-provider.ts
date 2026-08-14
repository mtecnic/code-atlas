// A real HTTP server speaking just enough OpenAI chat-completions SSE to test
// the agent loop: scripted response queue, tool-call arguments split into
// small delta chunks (exercises index-keyed accumulation), injectable
// failures, and mid-stream disconnects. Records request bodies for assertions.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ScriptedResponse =
  | { type: 'text'; text: string; promptTokens?: number }
  | { type: 'tool_calls'; calls: { name: string; args: Record<string, unknown> }[]; promptTokens?: number }
  | { type: 'fail'; status: number; retryAfter?: number; body?: string }
  | { type: 'empty'; promptTokens?: number }
  | { type: 'break_mid_text'; text: string }

export class FakeProvider {
  private server: Server
  private queue: ScriptedResponse[] = []
  readonly requests: { url: string; body: Record<string, unknown> }[] = []
  baseUrl = ''

  constructor() {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(raw)
        } catch {
          /* ignore */
        }
        this.requests.push({ url: req.url ?? '', body })
        const scripted = this.queue.shift()
        if (!scripted) {
          res.writeHead(500).end('fake-provider: queue empty')
          return
        }
        if (scripted.type === 'fail') {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (scripted.retryAfter !== undefined) headers['Retry-After'] = String(scripted.retryAfter)
          res.writeHead(scripted.status, headers)
          res.end(scripted.body ?? JSON.stringify({ error: { message: `scripted ${scripted.status}` } }))
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        })
        const send = (obj: unknown): void => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`)
        }
        const chunkOf = (delta: Record<string, unknown>): Record<string, unknown> => ({
          choices: [{ index: 0, delta }]
        })
        if (scripted.type === 'break_mid_text') {
          send(chunkOf({ content: scripted.text }))
          // let the chunk flush to the client, then hard-disconnect (no [DONE])
          setTimeout(() => res.destroy(), 30)
          return
        }
        if (scripted.type === 'text') {
          // stream in small chunks
          for (let i = 0; i < scripted.text.length; i += 8) {
            send(chunkOf({ content: scripted.text.slice(i, i + 8) }))
          }
        } else if (scripted.type === 'tool_calls') {
          scripted.calls.forEach((call, index) => {
            send(chunkOf({ tool_calls: [{ index, id: `call_${index}`, function: { name: call.name, arguments: '' } }] }))
            const args = JSON.stringify(call.args)
            for (let i = 0; i < args.length; i += 20) {
              send(
                chunkOf({
                  tool_calls: [{ index, function: { arguments: args.slice(i, i + 20) } }]
                })
              )
            }
          })
        }
        const wantsUsage = (body.stream_options as { include_usage?: boolean } | undefined)
          ?.include_usage
        if (wantsUsage && scripted.type !== 'break_mid_text') {
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: scripted.promptTokens ?? 100, completion_tokens: 5 } })}\n\n`
          )
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${addr.port}`
  }

  setResponses(responses: ScriptedResponse[]): void {
    this.queue = [...responses]
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
