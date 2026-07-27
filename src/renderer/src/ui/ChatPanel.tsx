import { useRef, useState } from 'react'
import { useAtlas } from '../store'
import { streamChat, type ChatHandle } from '../llm'
import type { LlmChatMessage } from '../../../shared/model'

interface Turn {
  role: 'user' | 'assistant'
  content: string
  /** tool activity chips shown above this assistant turn */
  tools?: { name: string; detail: string }[]
}

function toolChipText(name: string, args: Record<string, unknown>): string {
  const a = args ?? {}
  switch (name) {
    case 'fly_to':
      return `✈ flew to ${a.path}`
    case 'set_lens':
      return `🔬 lens: ${a.lens}`
    case 'set_view':
      return `🌐 view: ${a.mode}`
    case 'filter_files':
      return `🎯 filter: ${a.glob ?? a.language}`
    case 'filter_related':
      return `🕸 ${a.direction} of ${a.path}`
    case 'clear_view':
      return '✕ cleared view'
    case 'get_file_info':
      return `📄 inspected ${a.path}`
    case 'search_files':
      return `🔍 searched "${a.query}"`
    case 'get_health_report':
      return '⚕ read health report'
    default:
      return `⚙ ${name}`
  }
}

function buildContext(): string {
  const { snapshot, selected, lens, mode, fileFilter, health } = useAtlas.getState()
  if (!snapshot) return ''
  const lines: string[] = [
    `Repo: ${snapshot.rootPath} — ${snapshot.stats.totalFiles} files, ${snapshot.stats.totalLoc} LOC, ${snapshot.importEdges.length / 2} internal imports.`,
    `Languages: ${Object.entries(snapshot.stats.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([l, n]) => `${l}(${n})`)
      .join(', ')}`,
    `Current view: ${mode}, lens: ${lens}${fileFilter ? `, active filter: ${fileFilter.label}` : ''}.`
  ]
  if (health) {
    lines.push(
      `Health: ${health.cycles.length} import cycles, ${health.dead.length} possibly-dead files.`
    )
  }
  if (selected !== null) {
    const f = snapshot.files[selected]
    lines.push(`User has selected: ${f.path} (${f.loc} loc, complexity ${f.complexity}).`)
  }
  return lines.join('\n')
}

/** renders assistant text with repo file paths as clickable fly-to chips */
function RichText({ text }: { text: string }): React.JSX.Element {
  const snapshot = useAtlas((s) => s.snapshot)
  const { requestFlyTo, setSelected } = useAtlas()
  if (!snapshot) return <>{text}</>
  const parts = text.split(/(`[^`\n]+`|\S+\.\w{1,5}(?=[\s,.):;]|$))/g)
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null
        const candidate = part.replace(/^`|`$/g, '')
        const id = snapshot.files.findIndex(
          (f) => f.path === candidate || (candidate.includes('/') && f.path.endsWith(candidate))
        )
        if (id >= 0) {
          return (
            <button
              key={i}
              className="path-chip"
              onClick={() => {
                setSelected(id)
                requestFlyTo(id)
              }}
            >
              {candidate.split('/').pop()}
            </button>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

export function ChatPanel(): React.JSX.Element | null {
  const open = useAtlas((s) => s.chatOpen)
  const llm = useAtlas((s) => s.llm)
  const selected = useAtlas((s) => s.selected)
  const { setChatOpen, setSettingsOpen } = useAtlas()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const handleRef = useRef<ChatHandle | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  if (!open) return null

  const send = async (): Promise<void> => {
    const question = input.trim()
    if (!question || busy || !llm) return
    setInput('')
    setBusy(true)
    const history = [...turns, { role: 'user' as const, content: question }]
    setTurns([...history, { role: 'assistant', content: '', tools: [] }])

    let sourceBlock = ''
    const { snapshot } = useAtlas.getState()
    if (selected !== null && snapshot) {
      const source = await window.atlas.readFile(selected)
      if (source) {
        const clipped =
          source.length > 8000 ? source.slice(0, 4000) + '\n…\n' + source.slice(-4000) : source
        sourceBlock = `\n\nSelected file source:\n\`\`\`\n${clipped}\n\`\`\``
      }
    }
    const messages: LlmChatMessage[] = [
      {
        role: 'system',
        content: `You are the architecture copilot inside "Code Atlas", a 3D codebase visualizer. You can OPERATE the visualization with your tools — fly to files, switch lenses, filter the city, read health reports. Prefer showing over telling: when you name a file, fly to it; when discussing hotspots, switch to the hotspot lens; when asked about a subsystem, filter to it. Be concise in prose.\n\n${buildContext()}${sourceBlock}`
      },
      ...history.map((t) => ({ role: t.role, content: t.content }))
    ]
    const append = (fn: (last: Turn) => Turn): void =>
      setTurns((prev) => {
        const next = [...prev]
        next[next.length - 1] = fn(next[next.length - 1])
        return next
      })
    handleRef.current = await streamChat(
      messages,
      {
        onDelta: (d) => append((t) => ({ ...t, content: t.content + d })),
        onTool: (name, args) =>
          append((t) => ({
            ...t,
            tools: [...(t.tools ?? []), { name, detail: toolChipText(name, args) }]
          })),
        onDone: () => setBusy(false),
        onError: (err) => {
          append((t) => ({ ...t, content: t.content + `\n[error: ${err}]` }))
          setBusy(false)
        }
      },
      { agent: true }
    )
    setTimeout(() => scrollRef.current?.scrollTo(0, 1e6), 50)
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>💬 Copilot {llm ? `· ${llm.model}` : ''}</span>
        <button className="btn" onClick={() => setChatOpen(false)}>
          ✕
        </button>
      </div>
      {!llm && (
        <div className="chat-empty">
          No LLM endpoint configured.{' '}
          <button className="btn accent" onClick={() => setSettingsOpen(true)}>
            Configure
          </button>
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef}>
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn ${t.role}`}>
            {t.tools && t.tools.length > 0 && (
              <div className="chat-tools">
                {t.tools.map((tool, j) => (
                  <span key={j} className="tool-chip">
                    {tool.detail}
                  </span>
                ))}
              </div>
            )}
            {t.role === 'assistant' ? (
              <RichText text={t.content || (busy && i === turns.length - 1 ? '…' : '')} />
            ) : (
              t.content
            )}
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          value={input}
          disabled={!llm}
          placeholder={
            selected !== null ? 'Ask about the selected file…' : 'Ask me to show you things…'
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
        />
        <button className="btn accent" disabled={!llm || busy} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  )
}
