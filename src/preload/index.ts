import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { CHANNELS } from '../shared/ipc-contract'
import type { AtlasApi, AtlasSettings, LlmChunkPayload } from '../shared/ipc-contract'
import type { AnalysisProgress, FileId, LlmChatMessage, RepoSnapshot } from '../shared/model'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: AtlasApi = {
  openFolderDialog: () => ipcRenderer.invoke(CHANNELS.openFolderDialog),
  analyze: (rootPath: string) => ipcRenderer.invoke(CHANNELS.analyze, rootPath),
  cancelAnalysis: () => ipcRenderer.invoke(CHANNELS.cancelAnalysis),
  readFile: (fileId: FileId) => ipcRenderer.invoke(CHANNELS.readFile, fileId),
  getModuleGraph: (fileIds: FileId[]) => ipcRenderer.invoke(CHANNELS.getModuleGraph, fileIds),
  llmProbe: (host: string, port?: number) => ipcRenderer.invoke(CHANNELS.llmProbe, host, port),
  llmChat: (messages: LlmChatMessage[]) => ipcRenderer.invoke(CHANNELS.llmChat, messages),
  llmAbort: (requestId: string) => ipcRenderer.invoke(CHANNELS.llmAbort, requestId),
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings),
  saveSettings: (patch: Partial<AtlasSettings>) => ipcRenderer.invoke(CHANNELS.saveSettings, patch),
  loadLcov: () => ipcRenderer.invoke(CHANNELS.loadLcov),
  onProgress: (cb) => subscribe<AnalysisProgress>(CHANNELS.analysisProgress, cb),
  onSnapshot: (cb) => subscribe<RepoSnapshot>(CHANNELS.analysisSnapshot, cb),
  onLlmChunk: (cb) => subscribe<LlmChunkPayload>(CHANNELS.llmChunk, cb),
  onLlmDone: (cb) => {
    const listener = (_e: IpcRendererEvent, requestId: string): void => cb(requestId)
    ipcRenderer.on(CHANNELS.llmDone, listener)
    return () => ipcRenderer.removeListener(CHANNELS.llmDone, listener)
  },
  onLlmError: (cb) => {
    const listener = (_e: IpcRendererEvent, requestId: string, error: string): void =>
      cb(requestId, error)
    ipcRenderer.on(CHANNELS.llmError, listener)
    return () => ipcRenderer.removeListener(CHANNELS.llmError, listener)
  }
}

contextBridge.exposeInMainWorld('atlas', api)
