// In-app AI editor: CodeMirror 6 with save→re-parse (building updates live),
// streamed AI explain, and AI-improve-selection with diff accept/reject.
import { useEffect, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { markdown } from '@codemirror/lang-markdown'
import { MergeView } from '@codemirror/merge'
import { useAtlas } from '../store'
import { streamChat, type ChatHandle } from '../llm'
import { enterMoleculeFor } from '../molecule'

function langExtension(language: string | null): Extension[] {
  switch (language) {
    case 'javascript':
      return [javascript()]
    case 'typescript':
      return [javascript({ typescript: true })]
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })]
    case 'python':
      return [python()]
    case 'rust':
      return [rust()]
    case 'c':
    case 'cpp':
      return [cpp()]
    case 'java':
      return [java()]
    case 'go':
      return [go()]
    case 'json':
      return [json()]
    case 'yaml':
      return [yaml()]
    case 'markdown':
      return [markdown()]
    default:
      return []
  }
}

export function EditorPanel(): React.JSX.Element | null {
  const selected = useAtlas((s) => s.selected)
  const snapshot = useAtlas((s) => s.snapshot)
  const llm = useAtlas((s) => s.llm)
  const { setSelected, bumpFileVersion } = useAtlas()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const mergeHostRef = useRef<HTMLDivElement>(null)
  const mergeRef = useRef<MergeView | null>(null)
  const chatRef = useRef<ChatHandle | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [proposal, setProposal] = useState<{ from: number; to: number; code: string } | null>(null)
  const [loadError, setLoadError] = useState(false)

  const file = selected !== null && snapshot ? snapshot.files[selected] : null

  // (re)create the editor when the selected file changes
  useEffect(() => {
    chatRef.current?.abort()
    setAiText('')
    setAiBusy(false)
    setProposal(null)
    setDirty(false)
    setLoadError(false)
    mergeRef.current?.destroy()
    mergeRef.current = null
    viewRef.current?.destroy()
    viewRef.current = null
    if (selected === null || !file || !hostRef.current) return
    let cancelled = false
    void window.atlas.readFile(selected).then((source) => {
      if (cancelled || !hostRef.current) return
      if (source === null) {
        setLoadError(true)
        return
      }
      viewRef.current = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: source,
          extensions: [
            lineNumbers(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            oneDark,
            ...langExtension(file.language),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) setDirty(true)
            }),
            EditorView.theme({ '&': { fontSize: '12.5px', height: '100%' } })
          ]
        })
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  // Ctrl+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, dirty])

  // build the merge view when a proposal lands (must stay above the early
  // return — hooks order)
  useEffect(() => {
    mergeRef.current?.destroy()
    mergeRef.current = null
    if (!proposal || !mergeHostRef.current || !viewRef.current) return
    const doc = viewRef.current.state.doc.toString()
    const proposed = doc.slice(0, proposal.from) + proposal.code + doc.slice(proposal.to)
    mergeRef.current = new MergeView({
      parent: mergeHostRef.current,
      a: { doc, extensions: [oneDark, EditorView.editable.of(false)] },
      b: { doc: proposed, extensions: [oneDark, EditorView.editable.of(false)] }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal])

  if (selected === null || !file) return null

  const save = async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !dirty || saving || selected === null) return
    setSaving(true)
    const result = await window.atlas.writeFile(selected, view.state.doc.toString())
    setSaving(false)
    if (result.ok) {
      setDirty(false)
      bumpFileVersion(selected, {
        loc: result.loc,
        complexity: result.complexity,
        todoCount: result.todoCount,
        symbolCount: result.symbolCount
      })
    } else {
      setAiText(`Save failed: ${result.error}`)
    }
  }

  const explain = async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !llm || aiBusy) return
    const sel = view.state.selection.main
    const hasSel = !sel.empty
    const code = hasSel
      ? view.state.sliceDoc(sel.from, sel.to)
      : view.state.doc.toString().slice(0, 12000)
    setAiBusy(true)
    setAiText('')
    chatRef.current = await streamChat(
      [
        {
          role: 'system',
          content: 'You are a senior engineer. Concise, concrete explanations.'
        },
        {
          role: 'user',
          content: `Explain this ${hasSel ? 'selection' : 'file'} from ${file.path}:\n\`\`\`${file.language ?? ''}\n${code}\n\`\`\``
        }
      ],
      {
        onDelta: (d) => setAiText((t) => t + d),
        onDone: () => setAiBusy(false),
        onError: (e) => {
          setAiText((t) => t + `\n[error: ${e}]`)
          setAiBusy(false)
        }
      }
    )
  }

  const improve = async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !llm || aiBusy) return
    const sel = view.state.selection.main
    if (sel.empty) {
      setAiText('Select some code first — Improve rewrites the selection.')
      return
    }
    const code = view.state.sliceDoc(sel.from, sel.to)
    setAiBusy(true)
    setAiText('')
    let out = ''
    chatRef.current = await streamChat(
      [
        {
          role: 'system',
          content:
            'You improve code. Reply with ONLY the improved replacement code — no fences, no prose, no explanations. Preserve indentation style and behavior unless clearly buggy.'
        },
        {
          role: 'user',
          content: `File: ${file.path} (${file.language})\nImprove this code:\n${code}`
        }
      ],
      {
        onDelta: (d) => {
          out += d
          setAiText('✍ drafting replacement… ' + out.length + ' chars')
        },
        onDone: () => {
          setAiBusy(false)
          const cleaned = out.replace(/^```[a-z]*\n?/, '').replace(/\n?```\s*$/, '')
          setProposal({ from: sel.from, to: sel.to, code: cleaned })
          setAiText('')
        },
        onError: (e) => {
          setAiText(`[error: ${e}]`)
          setAiBusy(false)
        }
      }
    )
  }

  const acceptProposal = (): void => {
    const view = viewRef.current
    if (!view || !proposal) return
    view.dispatch({
      changes: { from: proposal.from, to: proposal.to, insert: proposal.code }
    })
    setProposal(null)
    setDirty(true)
  }

  return (
    <div className="preview-panel editor-panel">
      <div className="preview-header">
        <div>
          <div className="preview-title">
            {file.name}
            {dirty ? ' •' : ''}
          </div>
          <div className="preview-sub">
            {file.path} · {file.loc} loc · cx {file.complexity}
          </div>
        </div>
        <div className="preview-actions">
          <button className="btn" disabled={!dirty || saving} onClick={() => void save()} title="Ctrl+S">
            {saving ? '…' : '💾 Save'}
          </button>
          <button className="btn" disabled={!llm || aiBusy} onClick={() => void explain()} title="Explain file or selection">
            ✨ Explain
          </button>
          <button className="btn" disabled={!llm || aiBusy} onClick={() => void improve()} title="AI-rewrite the selected code (with diff review)">
            🪄 Improve
          </button>
          <button className="btn" onClick={() => void enterMoleculeFor(selected)}>
            🧬
          </button>
          <button className="btn" onClick={() => setSelected(null)}>
            ✕
          </button>
        </div>
      </div>
      {loadError && <div className="editor-error">Could not read file.</div>}
      {proposal ? (
        <>
          <div className="merge-host" ref={mergeHostRef} />
          <div className="merge-actions">
            <button className="btn accent" onClick={acceptProposal}>
              ✓ Accept
            </button>
            <button className="btn" onClick={() => setProposal(null)}>
              ✗ Reject
            </button>
          </div>
        </>
      ) : (
        <div className="editor-host" ref={hostRef} />
      )}
      {aiText && <div className="preview-explanation">{aiText}</div>}
    </div>
  )
}
