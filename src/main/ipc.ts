import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { CHANNELS } from '../shared/ipc-contract'
import type { AtlasSettings } from '../shared/ipc-contract'
import type { FileId, LlmChatMessage } from '../shared/model'
import { analyze, cancelAnalysis } from './analyzer/analyzer'
import { analysisStore, loadSettings, saveSettings } from './store'
import { probeEndpoint } from './llm/probe'
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

  ipcMain.handle(CHANNELS.analyze, async (_e, rootPath: string) => {
    const win = getWindow()
    if (!win) return
    const settings = await loadSettings()
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

  ipcMain.handle(CHANNELS.getSettings, () => loadSettings())
  ipcMain.handle(CHANNELS.saveSettings, (_e, patch: Partial<AtlasSettings>) =>
    saveSettings(patch)
  )
}
