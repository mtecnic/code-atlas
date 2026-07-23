import { useRef, useState } from 'react'
import { useAtlas } from '../store'
import { streamChat, type ChatHandle } from '../llm'
import type { LlmChatMessage } from '../../../shared/model'

interface Turn {
  role: 'user' | 'assistant'
  content: string
}

function buildContext(): string {
  const { snapshot, selected } = useAtlas.getState()
  if (!snapshot) return ''
  const lines: string[] = [
    `Repo: ${snapshot.rootPath} — ${snapshot.stats.totalFiles} files, ${snapshot.stats.totalLoc} LOC.`,
    `Languages: ${Object.entries(snapshot.stats.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([l, n]) => `${l}(${n})`)
      .join(', ')}`
  ]
  if (selected !== null) {
    const f = snapshot.files[selected]
    const imports: string[] = []
    const importedBy: string[] = []
    const e = snapshot.importEdges
    for (let i = 0; i + 1 < e.length; i += 2) {
      if (e[i] === selected) imports.push(snapshot.files[e[i + 1]].path)
      if (e[i + 1] === selected) importedBy.push(snapshot.files[e[i]].path)
    }
    lines.push(
      `Selected file: ${f.path} (${f.loc} loc, ${f.churn.commits} commits)`,
      imports.length ? `It imports: ${imports.slice(0, 15).join(', ')}` : 'It imports nothing internal.',
      importedBy.length
        ? `Imported by: ${importedBy.slice(0, 15).join(', ')}`
        : 'Nothing internal imports it.'
    )
  }
  return lines.join('\n')
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
    setTurns([...history, { role: 'assistant', content: '' }])

    let sourceBlock = ''
    const { snapshot } = useAtlas.getState()
    if (selected !== null && snapshot) {
      const source = await window.atlas.readFile(selected)
      if (source) {
        const clipped = source.length > 8000 ? source.slice(0, 4000) + '\n…\n' + source.slice(-4000) : source
        sourceBlock = `\n\nSelected file source:\n\`\`\`\n${clipped}\n\`\`\``
      }
    }
    const messages: LlmChatMessage[] = [
      {
        role: 'system',
        content: `You are an architecture guide inside "Code Atlas", a 3D codebase visualizer. Answer questions about the codebase below. Be concise.\n\n${buildContext()}${sourceBlock}`
      },
      ...history.map((t) => ({ role: t.role, content: t.content }))
    ]
    handleRef.current = await streamChat(messages, {
      onDelta: (d) =>
        setTurns((prev) => {
          const next = [...prev]
          next[next.length - 1] = {
            role: 'assistant',
            content: next[next.length - 1].content + d
          }
          return next
        }),
      onDone: () => setBusy(false),
      onError: (err) => {
        setTurns((prev) => {
          const next = [...prev]
          next[next.length - 1] = {
            role: 'assistant',
            content: next[next.length - 1].content + `\n[error: ${err}]`
          }
          return next
        })
        setBusy(false)
      }
    })
    setTimeout(() => scrollRef.current?.scrollTo(0, 1e6), 50)
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>💬 Architecture Q&A {llm ? `· ${llm.model}` : ''}</span>
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
            {t.content || (busy && i === turns.length - 1 ? '…' : '')}
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          value={input}
          disabled={!llm}
          placeholder={selected !== null ? 'Ask about the selected file…' : 'Ask about this codebase…'}
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
