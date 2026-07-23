import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { CHANNELS } from '../shared/ipc-contract'
import type { AtlasSettings } from '../shared/ipc-contract'
import type { FileId, LlmChatMessage } from '../shared/model'
import { analyze, cancelAnalysis } from './analyzer/analyzer'
import { analysisStore, loadSettings, saveSettings } from './store'
import { probeEndpoint } from './llm/probe'
import { abortChat, startChat } from './llm/chat'

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
    void analyze(
      rootPath,
      { maxFiles: settings.maxFiles ?? 30000, maxCommits: settings.maxCommits ?? 5000 },
      {
        onProgress: (p) => !win.isDestroyed() && win.webContents.send(CHANNELS.analysisProgress, p),
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

  ipcMain.handle(CHANNELS.llmChat, async (e, messages: LlmChatMessage[]) => {
    const settings = await loadSettings()
    if (!settings.llm) throw new Error('No LLM endpoint configured')
    return startChat(e.sender, settings.llm, messages)
  })

  ipcMain.handle(CHANNELS.llmAbort, (_e, requestId: string) => abortChat(requestId))

  ipcMain.handle(CHANNELS.getSettings, () => loadSettings())
  ipcMain.handle(CHANNELS.saveSettings, (_e, patch: Partial<AtlasSettings>) =>
    saveSettings(patch)
  )
}
