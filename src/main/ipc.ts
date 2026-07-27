import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { grammarFor } from '../shared/languages'
import { analyze, cancelAnalysis, grammarDir } from './analyzer/analyzer'
import parseSingle from './analyzer/parse-worker'
import { watch, type FSWatcher } from 'node:fs'

const backedUp = new Set<string>()
let watcher: FSWatcher | null = null
let watchTimer: ReturnType<typeof setTimeout> | null = null
import { CHANNELS } from '../shared/ipc-contract'
import type { AtlasSettings } from '../shared/ipc-contract'
import type { FileId, LlmChatMessage } from '../shared/model'
import { analysisStore, loadSettings, saveSettings } from './store'
import { probeEndpoint } from './llm/probe'
import { buildSummaries, cancelSummaries, loadSummaryCache } from './llm/summaries'
import { abortChat, resolveToolResult, startChat } from './llm/chat'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.openFolderDialog, async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Open a codebase',
      properties: ['openDirectory']
    })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  const runAnalyze = async (rootPath: string): Promise<void> => {
    const win = getWindow()
    if (!win) return
    const settings = await loadSettings()
    // remember recents (most recent first, deduped)
    const recents = [rootPath, ...(settings.recentRepos ?? []).filter((r) => r !== rootPath)]
    await saveSettings({ recentRepos: recents.slice(0, 8) })
    // (re)arm the watch-lite watcher
    watcher?.close()
    watcher = null
    if (settings.watch) {
      try {
        watcher = watch(rootPath, { recursive: true }, (_ev, name) => {
          const file = String(name ?? '')
          if (/(^|\/)(\.git|node_modules|dist|out|__pycache__)(\/|$)/.test(file)) return
          if (watchTimer) clearTimeout(watchTimer)
          watchTimer = setTimeout(() => void runAnalyze(rootPath), 2500)
        })
      } catch (err) {
        console.warn('[atlas] watch failed:', err)
      }
    }
    console.log('[atlas] analyze start:', rootPath)
    void analyze(
      rootPath,
      { maxFiles: settings.maxFiles ?? 30000, maxCommits: settings.maxCommits ?? 5000 },
      {
        onProgress: (p) => {
          if (p.phase === 'error' || p.done === p.total || p.done % 1000 === 0) {
            console.log('[atlas] progress:', p.phase, p.done, '/', p.total, p.error ?? '')
          }
          if (!win.isDestroyed()) win.webContents.send(CHANNELS.analysisProgress, p)
        },
        onSnapshot: (s) => !win.isDestroyed() && win.webContents.send(CHANNELS.analysisSnapshot, s)
      }
    )
  }

  ipcMain.handle(CHANNELS.analyze, (_e, rootPath: string) => runAnalyze(rootPath))

  ipcMain.handle(CHANNELS.saveScreenshot, async (_e, dataUrl: string) => {
    const win = getWindow()
    if (!win || !dataUrl.startsWith('data:image/png;base64,')) return false
    const picked = await dialog.showSaveDialog(win, {
      title: 'Save screenshot',
      defaultPath: 'code-atlas.png',
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
    if (picked.canceled || !picked.filePath) return false
    await fs.writeFile(picked.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'))
    return true
  })

  ipcMain.handle(CHANNELS.cancelAnalysis, () => cancelAnalysis())

  ipcMain.handle(CHANNELS.readFile, async (_e, fileId: FileId) => {
    const abs = analysisStore.absPathOf(fileId)
    if (!abs) return null
    try {
      const buf = await fs.readFile(abs, 'utf8')
      return buf.length > 512 * 1024 ? buf.slice(0, 512 * 1024) + '\n… (truncated)' : buf
    } catch {
      return null
    }
  })

  ipcMain.handle(CHANNELS.writeFile, async (_e, fileId: FileId, content: string) => {
    const abs = analysisStore.absPathOf(fileId)
    const snapshot = analysisStore.snapshot
    const root = analysisStore.rootPath
    if (!abs || !snapshot || !root) return { ok: false, error: 'no file' }
    const resolvedRoot = path.resolve(root) + path.sep
    if (!path.resolve(abs).startsWith(resolvedRoot)) {
      return { ok: false, error: 'path escapes repository root' }
    }
    try {
      // one backup per file per session, stashed under userData
      if (!backedUp.has(abs)) {
        const backupDir = path.join(app.getPath('userData'), 'backups')
        await fs.mkdir(backupDir, { recursive: true })
        const safe = snapshot.files[fileId].path.split('/').join('__')
        await fs.copyFile(abs, path.join(backupDir, `${Date.now()}-${safe}`)).catch(() => {})
        backedUp.add(abs)
      }
      await fs.writeFile(abs, content, 'utf8')
      // single-file re-parse to refresh metrics + symbols
      const file = snapshot.files[fileId]
      const result = await parseSingle({
        absPath: abs,
        language: file.language,
        grammar: grammarFor(file.language),
        grammarDir: grammarDir()
      })
      file.loc = result.loc
      file.complexity = result.cx
      file.todoCount = result.todoCount
      file.analyzed = result.analyzed
      file.symbolCount = result.defs.length
      if (result.analyzed) {
        analysisStore.extractions.set(fileId, { defs: result.defs, refs: result.refs })
      }
      return {
        ok: true,
        loc: result.loc,
        complexity: result.cx,
        todoCount: result.todoCount,
        symbolCount: result.defs.length
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(CHANNELS.getModuleGraph, (_e, fileIds: FileId[]) =>
    analysisStore.moduleGraph(fileIds)
  )

  ipcMain.handle(CHANNELS.llmProbe, async (_e, host: string, port?: number) => {
    const result = await probeEndpoint(host, port)
    if (result.ok && result.endpoint) await saveSettings({ llm: result.endpoint })
    return result
  })

  ipcMain.handle(
    CHANNELS.llmChat,
    async (e, messages: LlmChatMessage[], tools?: Record<string, unknown>[]) => {
      const settings = await loadSettings()
      if (!settings.llm) throw new Error('No LLM endpoint configured')
      return startChat(e.sender, settings.llm, messages, tools)
    }
  )

  ipcMain.handle(CHANNELS.llmAbort, (_e, requestId: string) => abortChat(requestId))
  ipcMain.handle(CHANNELS.llmToolResult, (_e, requestId: string, callId: string, result: string) =>
    resolveToolResult(requestId, callId, result)
  )

  ipcMain.handle(CHANNELS.loadLcov, async () => {
    const win = getWindow()
    const snapshot = analysisStore.snapshot
    if (!win || !snapshot || !analysisStore.rootPath) return null
    const picked = await dialog.showOpenDialog(win, {
      title: 'Load coverage (lcov)',
      filters: [{ name: 'lcov', extensions: ['info', 'lcov', 'dat'] }],
      properties: ['openFile']
    })
    if (picked.canceled || !picked.filePaths.length) return null
    let raw: string
    try {
      raw = await fs.readFile(picked.filePaths[0], 'utf8')
    } catch {
      return null
    }
    const byPath = new Map(snapshot.files.map((f, id) => [f.path, id]))
    const root = analysisStore.rootPath.replace(/\/+$/, '') + '/'
    const coverage = new Array(snapshot.files.length).fill(-1)
    let coveredFiles = 0
    let currentId = -1
    let lf = 0
    let lh = 0
    for (const line of raw.split('\n')) {
      if (line.startsWith('SF:')) {
        let p = line.slice(3).trim().split('\\').join('/')
        if (p.startsWith(root)) p = p.slice(root.length)
        currentId = byPath.get(p) ?? -1
        lf = 0
        lh = 0
      } else if (line.startsWith('LF:')) lf = Number(line.slice(3))
      else if (line.startsWith('LH:')) lh = Number(line.slice(3))
      else if (line.startsWith('end_of_record')) {
        if (currentId >= 0 && lf > 0) {
          coverage[currentId] = lh / lf
          coveredFiles++
        }
        currentId = -1
      }
    }
    return { coverage, coveredFiles }
  })

  ipcMain.handle(CHANNELS.buildSummaries, async (e) => {
    const settings = await loadSettings()
    if (!settings.llm) return { error: 'No LLM endpoint configured' }
    return buildSummaries(e.sender, settings.llm)
  })
  ipcMain.handle(CHANNELS.cancelSummaries, () => cancelSummaries())
  ipcMain.handle(CHANNELS.getSummaries, async () => {
    if (!analysisStore.rootPath) return {}
    const cache = await loadSummaryCache(analysisStore.rootPath)
    const out: Record<string, string> = {}
    for (const [p2, entry] of Object.entries(cache)) out[p2] = entry.summary
    return out
  })

  ipcMain.handle(CHANNELS.setGlMode, async (_e, mode: 'default' | 'egl' | 'swiftshader') => {
    await saveSettings({ glMode: mode })
    const args = process.argv.slice(1).filter((a) => !a.startsWith('--atlas-gl='))
    app.relaunch({ args: [...args, `--atlas-gl=${mode}`] })
    app.exit(0)
  })

  ipcMain.handle(CHANNELS.getSettings, () => loadSettings())
  ipcMain.handle(CHANNELS.saveSettings, (_e, patch: Partial<AtlasSettings>) =>
    saveSettings(patch)
  )
}
