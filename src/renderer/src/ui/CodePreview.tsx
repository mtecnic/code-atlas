import { useEffect, useRef, useState } from 'react'
import { useAtlas } from '../store'
import { streamChat, type ChatHandle } from '../llm'
import { enterMoleculeFor } from '../molecule'

const SHIKI_LANG: Record<string, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  tsx: 'tsx',
  python: 'python',
  go: 'go',
  rust: 'rust',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  ruby: 'ruby',
  php: 'php',
  csharp: 'csharp',
  swift: 'swift',
  kotlin: 'kotlin',
  shell: 'shellscript',
  html: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
  markdown: 'markdown',
  sql: 'sql',
  lua: 'lua',
  zig: 'zig'
}

export function CodePreview(): React.JSX.Element | null {
  const selected = useAtlas((s) => s.selected)
  const snapshot = useAtlas((s) => s.snapshot)
  const llm = useAtlas((s) => s.llm)
  const { setSelected } = useAtlas()
  const [html, setHtml] = useState<string>('')
  const [explanation, setExplanation] = useState<string>('')
  const [explaining, setExplaining] = useState(false)
  const handleRef = useRef<ChatHandle | null>(null)
  const sourceRef = useRef<string>('')

  const file = selected !== null && snapshot ? snapshot.files[selected] : null

  useEffect(() => {
    setExplanation('')
    setExplaining(false)
    handleRef.current?.abort()
    if (selected === null || !file) {
      setHtml('')
      return
    }
    let cancelled = false
    void (async () => {
      const source = await window.atlas.readFile(selected)
      if (cancelled) return
      if (source === null) {
        setHtml('<pre>could not read file</pre>')
        return
      }
      sourceRef.current = source
      const clipped = source.length > 60_000 ? source.slice(0, 60_000) + '\n… (clipped)' : source
      try {
        const { codeToHtml } = await import('shiki')
        const out = await codeToHtml(clipped, {
          lang: (file.language && SHIKI_LANG[file.language]) || 'text',
          theme: 'one-dark-pro'
        })
        if (!cancelled) setHtml(out)
      } catch {
        if (!cancelled) setHtml(`<pre>${clipped.replace(/</g, '&lt;')}</pre>`)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  if (!file || selected === null) return null

  const explain = async (): Promise<void> => {
    if (!llm) return
    setExplaining(true)
    setExplanation('')
    const src = sourceRef.current.slice(0, 12_000)
    handleRef.current = await streamChat(
      [
        {
          role: 'system',
          content:
            'You are a senior engineer explaining code inside a 3D codebase visualizer. Be concise and concrete.'
        },
        {
          role: 'user',
          content: `Explain this file: what it does, its key exports, and how it likely fits into the project.\n\nPath: ${file.path}\nLanguage: ${file.language ?? 'unknown'}\n\n\`\`\`\n${src}\n\`\`\``
        }
      ],
      {
        onDelta: (d) => setExplanation((prev) => prev + d),
        onDone: () => setExplaining(false),
        onError: (err) => {
          setExplanation((prev) => prev + `\n\n[error: ${err}]`)
          setExplaining(false)
        }
      }
    )
  }

  return (
    <div className="preview-panel">
      <div className="preview-header">
        <div>
          <div className="preview-title">{file.name}</div>
          <div className="preview-sub">
            {file.path} · {file.loc} loc · {file.churn.commits} commits
          </div>
        </div>
        <div className="preview-actions">
          <button
            className="btn"
            title="Explode this file into its functions, classes and variables"
            onClick={() => void enterMoleculeFor(selected)}
          >
            🧬 Molecule
          </button>
          <button className="btn" disabled={!llm || explaining} onClick={() => void explain()}>
            {explaining ? '…' : '✨ Explain'}
          </button>
          <button className="btn" onClick={() => setSelected(null)}>
            ✕
          </button>
        </div>
      </div>
      {explanation && <div className="preview-explanation">{explanation}</div>}
      <div className="preview-code" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
